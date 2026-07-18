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
const { BestwayV2Api, normalizeAwsState } = require("./lib/aws_iot");
const { BestwayV2WebSocket } = require("./lib/aws_iot_ws");

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

    if (this.config.generation === "v2") {
      await this.onReadyV2();
      return;
    }

    // V1 requires email + password. Abort early instead of firing a login
    // request that the API rejects with "field username error".
    if (!this.config.username || !this.config.password) {
      this.log.warn("V1 (Smart Hub) selected but email and/or password are not configured. Please open the adapter settings.");
      return;
    }

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

  /**
   * V2 setup (Bestway Connect / Smart Spa, AWS IoT backend).
   */
  async onReadyV2() {
    const region = this.config.region || "EU";
    const useAndroidId = this.config.v2Method === "androidId";

    let visitorId;
    if (useAndroidId) {
      // Android users: the app's Android ID IS the visitor_id, reusing the
      // existing account (and its already paired devices) directly.
      visitorId = (this.config.androidId || "").trim();
      if (!visitorId) {
        this.log.error("V2 Android ID method selected but no Android ID configured");
        return;
      }
    } else {
      // QR method: reuse stored visitor_id or generate a fresh one.
      visitorId = (this.config.visitorId || "").trim();
      if (!visitorId) {
        visitorId = BestwayV2Api.generateVisitorId();
        const persisted = await this.saveVisitorId(visitorId);
        if (!persisted) {
          // Without durable storage a one-time QR would bind to a visitor ID
          // that is lost on restart. Abort before consuming the QR.
          this.log.error("Could not persist generated visitor ID - aborting to avoid wasting the one-time QR code");
          return;
        }
        this.log.info("Generated new visitor ID for V2 account");
      }
    }
    this.v2 = new BestwayV2Api(this, { region, visitorId });

    try {
      await this.v2.authenticate();
      this.setState("info.connection", true, true);
    } catch (error) {
      this.setState("info.connection", false, true);
      this.log.error("V2 login failed: " + error.message);
      return;
    }

    // Optional one-time pairing via QR share code (QR method only).
    if (!useAndroidId && this.config.qrCode) {
      try {
        await this.v2.bindQrCode(this.config.qrCode.trim());
        this.log.info("V2 device paired via QR code");
        // Consume the code only after a confirmed binding (codes are
        // single-use / expire).
        await this.clearQrCode();
      } catch (error) {
        this.log.warn("V2 QR pairing failed (code may be expired or already used): " + error.message);
      }
    }

    try {
      await this.getDeviceListV2();
      await this.updateDevicesV2();
      this.startV2WebSockets();
    } catch (error) {
      this.log.error("V2 device discovery failed: " + error.message);
    }

    this.updateInterval = setInterval(async () => {
      await this.updateDevicesV2();
      // Ensure sockets exist for any devices discovered later.
      this.startV2WebSockets();
    }, this.config.interval * 60 * 1000);
    // Re-authenticate periodically (token refresh).
    this.refreshTokenInterval = setInterval(async () => {
      try {
        await this.v2.authenticate();
      } catch (error) {
        this.log.warn("V2 token refresh failed: " + error.message);
      }
    }, 24 * 60 * 60 * 1000); // daily
  }

  /**
   * Open a real-time WebSocket per device for push shadow updates.
   * Polling continues as a fallback.
   */
  startV2WebSockets() {
    if (!this.v2) return;
    if (!this.v2Sockets) this.v2Sockets = {};
    for (const did of Object.keys(this.v2.devices)) {
      if (this.v2Sockets[did]) continue;
      const device = this.v2.devices[did];
      const ws = new BestwayV2WebSocket({
        adapter: this,
        deviceId: did,
        serviceRegion: device.service_region || "eu-central-1",
        token: this.v2.token,
        onUpdate: (deviceId, rawState) => {
          try {
            const mapped = normalizeAwsState(rawState);
            this.json2iob.parse(deviceId + ".status", mapped, { descriptions: descriptions });
          } catch (e) {
            this.log.warn("V2 WS update parse failed: " + e.message);
          }
        },
        onTokenRefresh: async () => {
          try {
            return await this.v2.authenticate();
          } catch {
            return null;
          }
        },
      });
      this.v2Sockets[did] = ws;
      ws.connect();
    }
  }

  /**
   * Persist the generated visitor ID into the adapter config so the same
   * account is reused on next start.
   * @param {string} visitorId
   * @returns {Promise<boolean>} true if durably stored
   */
  async saveVisitorId(visitorId) {
    this.config.visitorId = visitorId;
    try {
      const obj = await this.getForeignObjectAsync("system.adapter." + this.namespace);
      if (obj && obj.native) {
        obj.native.visitorId = visitorId;
        await this.setForeignObjectAsync("system.adapter." + this.namespace, obj);
        return true;
      }
      return false;
    } catch (error) {
      this.log.warn("Could not persist visitor ID: " + error.message);
      return false;
    }
  }

  /**
   * Remove the QR code from the config after successful pairing so it is not
   * retried on every restart.
   */
  async clearQrCode() {
    this.config.qrCode = "";
    try {
      const obj = await this.getForeignObjectAsync("system.adapter." + this.namespace);
      if (obj && obj.native && obj.native.qrCode) {
        obj.native.qrCode = "";
        await this.setForeignObjectAsync("system.adapter." + this.namespace, obj);
      }
    } catch (error) {
      this.log.warn("Could not clear QR code: " + error.message);
    }
  }

  /**
   * V2: discover devices and create objects (remotev3 control channel).
   */
  async getDeviceListV2() {
    const devices = await this.v2.refreshBindings();
    const ids = Object.keys(devices);
    this.log.info("V2 discovered " + ids.length + " device(s)");
    for (const did of ids) {
      const device = devices[did];
      await this.setObjectNotExistsAsync(did, {
        type: "device",
        common: { name: device.alias },
        native: {},
      });
      await this.setObjectNotExistsAsync(did + ".remotev3", {
        type: "channel",
        common: { name: "V2 Remote Controls" },
        native: {},
      });
      await this.setObjectNotExistsAsync(did + ".general", {
        type: "channel",
        common: { name: "General Information" },
        native: {},
      });
      await this.setObjectNotExistsAsync(did + ".status", {
        type: "channel",
        common: { name: "Status of the device" },
        native: {},
      });
      const remoteArray = [
        { command: "power", name: "Power On/Off", type: "boolean", role: "switch" },
        { command: "heat", name: "Heater On/Off", type: "boolean", role: "switch" },
        { command: "filter", name: "Filter On/Off", type: "boolean", role: "switch" },
        { command: "jet", name: "Hydrojet On/Off", type: "boolean", role: "switch" },
        { command: "wave", name: "Bubbles 0 / 40 / 100", type: "number", role: "level" },
        { command: "temp_set", name: "Target temperature", type: "number", role: "level.temperature" },
        { command: "locked", name: "Keypad lock On/Off", type: "boolean", role: "switch" },
      ];
      for (const remote of remoteArray) {
        await this.setObjectNotExistsAsync(did + ".remotev3." + remote.command, {
          type: "state",
          common: {
            name: remote.name,
            type: remote.type,
            role: remote.role,
            write: true,
            read: true,
          },
          native: {},
        });
      }
      this.json2iob.parse(did + ".general", device.raw || device);
    }
  }

  /**
   * V2: fetch and store latest state for all devices.
   * Retries discovery while the registry is empty, guards against overlapping
   * runs, and maintains info.connection based on success/failure.
   */
  async updateDevicesV2() {
    if (!this.v2) return;
    if (this.v2Updating) return; // single-flight guard
    this.v2Updating = true;
    try {
      // Re-run discovery if we have no devices yet (e.g. startup failed or the
      // device was paired after the first attempt).
      if (Object.keys(this.v2.devices).length === 0) {
        try {
          await this.getDeviceListV2();
        } catch (error) {
          this.log.warn("V2 rediscovery failed: " + error.message);
        }
      }

      const ids = Object.keys(this.v2.devices);
      let anyOk = false;
      let authError = false;
      for (const did of ids) {
        try {
          const state = await this.v2.fetchDeviceState(did);
          const mapped = normalizeAwsState(state);
          await this.json2iob.parse(did + ".status", mapped, { descriptions: descriptions });
          anyOk = true;
        } catch (error) {
          const status = error.response && error.response.status;
          if (status === 400 || status === 401) authError = true;
          this.log.warn("V2 state update failed for " + did + ": " + error.message);
        }
      }

      if (authError) {
        // Token likely expired - re-authenticate for the next cycle.
        try {
          await this.v2.authenticate();
        } catch (e) {
          this.log.warn("V2 re-authentication failed: " + e.message);
        }
      }

      if (ids.length > 0) {
        this.setState("info.connection", anyOk, true);
      }
    } finally {
      this.v2Updating = false;
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
    if (!this.session || !this.session.token) {
      // Login did not return a token - skip the follow-up call that would
      // otherwise fail with "token invalid".
      return;
    }
    await this.requestClient({
      method: "get",
      url: "https://" + this.api + ".gizwits.com/app/users",
      headers: {
        "Content-Type": "application/json",
        "X-Gizwits-Application-Id": "98754e684ec045528b073876c34c7348",
        "X-Gizwits-User-token": this.session.token,
      },
    })
      .then(async (res) => {
        this.uid = res.data.uid;
        this.log.debug(JSON.stringify(res.data));
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
          await this.setObjectNotExistsAsync(device.did + ".remotev2", {
            type: "channel",
            common: {
              name: "New Remote Controls",
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
            { command: "Tset", name: "v2 Enter Temp", type: "number", role: "value" },
            { command: "jet", name: "v2 1 = Start, 0 = Stop", type: "number", role: "value" },
            { command: "filter", name: "v2 1 = Start, 0 = Stop", type: "number", role: "value" },
            { command: "wave", name: "v2 0, 50, 100", type: "number", role: "value" },
            { command: "heat", name: "v2 1 = Start, 0 = Stop", type: "number", role: "value" },
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

  /**
   * Map a V2 control state (remotev3.*) to AWS IoT shadow field(s).
   * @param {string} command state name (power, heat, filter, jet, wave, temp_set, locked)
   * @param {*} val new value
   * @returns {object|null} AWS field updates or null if unsupported
   */
  mapV2Command(command, val) {
    switch (command) {
      case "power":
        return { power_state: val ? 1 : 0 };
      case "heat":
        return { heater_state: val ? 1 : 0 };
      case "filter":
        return { filter_state: val ? 1 : 0 };
      case "jet":
        return { hydrojet_state: val ? 1 : 0 };
      case "wave": {
        // 0 = OFF, 40 = MEDIUM, 100 = HIGH
        let level = parseInt(val, 10);
        if (isNaN(level)) level = 0;
        if (level !== 0 && level !== 40 && level !== 100) {
          level = level >= 70 ? 100 : level > 0 ? 40 : 0;
        }
        return { wave_state: level };
      }
      case "temp_set": {
        const temp = parseInt(val, 10);
        if (isNaN(temp)) {
          this.log.warn("V2 temp_set: invalid value " + JSON.stringify(val));
          return null;
        }
        return { temperature_setting: temp };
      }
      case "locked":
        return { locked: val ? 1 : 0 };
      default:
        return null;
    }
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
      if (this.v2Sockets) {
        for (const did of Object.keys(this.v2Sockets)) {
          try {
            this.v2Sockets[did].disconnect();
          } catch {
            // ignore
          }
        }
      }
      callback();
    } catch {
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
        const remote = id.split(".")[3];
        let data = {
          attrs: {},
        };

        if (remote === "remotev3") {
          // V2 (AWS IoT) control path.
          if (!this.v2 || !this.v2.devices[deviceId]) {
            this.log.warn("V2 control: unknown device " + deviceId);
            return;
          }
          const awsUpdates = this.mapV2Command(command, state.val);
          if (!awsUpdates) {
            this.log.warn("V2 control: unsupported command " + command);
            return;
          }
          try {
            await this.v2.setDeviceState(deviceId, awsUpdates);
            // Acknowledge the successful command.
            await this.setStateAsync(id, { val: state.val, ack: true });
          } catch (error) {
            this.log.error("V2 command failed: " + error.message);
          }
          clearTimeout(this.refreshTimeout);
          this.refreshTimeout = setTimeout(async () => {
            await this.updateDevicesV2();
          }, 5 * 1000);
          return;
        }

        // In V2 mode ignore any leftover V1 control objects (remote/remotev2)
        // that may exist from a previous generation setting.
        if (this.config.generation === "v2") {
          return;
        }

        if (remote === "remotev2") {
          const device = this.deviceDict[deviceId];
          data = {
            appKey: "43424551921d4ee18dd279140e11e198",
            data: {
              command: {},
              did: device.did,
              mac: device.mac,
              productKey: device.product_key,
              uid: this.uid,
            },
            type: "appId",
            version: "1.0",
          };
          data.data.command[command] = state.val;
          this.log.debug(deviceId);
          this.log.debug(JSON.stringify(data));
          await this.requestClient({
            method: "post",
            url: "https://euaepapp.gizwits.com/app/user/control_log",
            headers: {
              Accept: "*/*",
              Version: "1.0",
              Authorization: this.session.token,
              "Accept-Language": "de-de",
              "Content-Type": "application/json",
              Origin: "http://localhost:9909",
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
              Connection: "keep-alive",
              Referer: "http://localhost:9909/",
            },
            data: JSON.stringify(data),
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
        } else {
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
        }
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
