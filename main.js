"use strict";

/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const Json2iob = require("./lib/json2iob");
const descriptions = require("./lib/descriptions");

class Bestway extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "bestway",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        this.requestClient = axios.create();
        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.json2iob = new Json2iob(this);
        this.deviceDict = {};
        this.session = {};
        this.subscribeStates("*");
        this.api = this.config.api || "euapi";

        await this.login();

        if (this.session.token) {
            await this.getDeviceList();
            await this.updateDevices();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.login();
            }, 7 * 24 * 60 * 60 * 1000); //7days
        }
    }
    async login() {
        await this.requestClient({
            method: "post",
            url: "https://" + this.api + ".gizwits.com/app/login",
            headers: {
                "Content-Type": "application/json",
                "X-Gizwits-Application-Id": "98754e684ec045528b073876c34c7348",
            },
            data: {
                username: this.config.username,
                password: this.config.password,
                lang: "en",
            },
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.setState("info.connection", true, true);
                this.session = res.data;
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getDeviceList() {
        await this.requestClient({
            method: "get",
            url: "https://" + this.api + ".gizwits.com/app/bindings?show_disabled=0&limit=20&skip=0",
            headers: {
                "Content-Type": "application/json",
                "X-Gizwits-Application-Id": "98754e684ec045528b073876c34c7348",
                "X-Gizwits-User-token": this.session.token,
            },
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                for (const device of res.data.devices) {
                    this.deviceDict[device.did] = { did: device.did, product_key: device.product_key, mac: device.mac };
                    await this.setObjectNotExistsAsync(device.did, {
                        type: "device",
                        common: {
                            name: device.dev_alias,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(device.did + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(device.did + ".general", {
                        type: "channel",
                        common: {
                            name: "General Information",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(device.did + ".status", {
                        type: "channel",
                        common: {
                            name: "Status of the device",
                        },
                        native: {},
                    });
                    const remoteArray = [
                        { command: "power", name: "True = Start, False = Stop" },
                        { command: "heat_power", name: "True = Start, False = Stop" },
                        { command: "filter_power", name: "True = Start, False = Stop" },
                        { command: "wave_power", name: "True = Start, False = Stop" },
                        { command: "temp_set", name: "Enter Temp", type: "number", role: "value" },
                    ];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(device.did + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.json2iob.parse(device.did + ".general", device);
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async updateDevices() {
        Object.keys(this.deviceDict).forEach(async (device) => {
            await this.requestClient({
                method: "get",
                url: "https://" + this.api + ".gizwits.com/app/devdata/" + device + "/latest",
                headers: {
                    "Content-Type": "application/json",
                    "X-Gizwits-Application-Id": "98754e684ec045528b073876c34c7348",
                    "X-Gizwits-User-token": this.session.token,
                },
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    res.data.attr["updated_at"] = res.data.updated_at;
                    this.json2iob.parse(device + ".status", res.data.attr, { descriptions: descriptions });
                })
                .catch((error) => {
                    if (error.response && error.response.status >= 500) {
                        this.log.warn("Service not reachable");
                        error.response && this.log.debug(JSON.stringify(error.response.data));
                        return;
                    }
                    this.log.error(error);
                    if (error.response) {
                        this.log.error(JSON.stringify(error.response.data));
                    }
                });
        });
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            clearTimeout(this.refreshTimeout);
            clearTimeout(this.reLoginTimeout);
            clearTimeout(this.refreshTokenTimeout);
            clearInterval(this.updateInterval);
            clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                const command = id.split(".")[4];
                const data = {
                    attrs: {},
                };

                data.attrs[command] = state.val;
                this.log.debug(deviceId);
                this.log.debug(JSON.stringify(data));
                await this.requestClient({
                    method: "post",
                    url: "https://" + this.api + ".gizwits.com/app/control/" + deviceId,
                    headers: {
                        "Content-Type": "application/json",
                        "X-Gizwits-Application-Id": "98754e684ec045528b073876c34c7348",
                        "X-Gizwits-User-token": this.session.token,
                    },
                    data: data,
                })
                    .then((res) => {
                        this.log.info(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                    });
                clearTimeout(this.refreshTimeout);
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateDevices();
                }, 5 * 1000);
            }
        }
    }
}
if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Bestway(options);
} else {
    // otherwise start the instance directly
    new Bestway();
}
