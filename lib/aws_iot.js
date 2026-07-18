"use strict";

/*
 * Bestway V2 (AWS IoT / Bestway Connect Smart Spa) API-Client.
 *
 * Portiert aus der Home-Assistant-Integration cdpuk/ha-bestway
 * (custom_components/bestway/aws_iot/) und aus der dekompilierten
 * App "Bestway Connect" 1.0.8 (com.rongwei.library).
 *
 * Auth-Modell:
 *   - visitor_id: zufaellig erzeugt (kein Passwort), persistent gespeichert
 *   - Gast-Login  POST /api/enduser/visitor           -> token
 *   - QR koppeln  POST /api/enduser/grant_device       (einmalig)
 *   - Signatur pro Request: sign = MD5(appId+appSecret+nonce+ts).toUpperCase()
 *   - Steuerung  POST /api/v2/device/command  (AES-256-CBC verschluesselt)
 *     Fallback   POST /api/device/command/    (unverschluesselt)
 */

const crypto = require("crypto");

const APP_ID = "AhFLL54HnChhrxcl9ZUJL6QNfolTIB";
const APP_SECRET = "4ECvVs13enL5AiYSmscNjvlaisklQDz7vWPCCWXcEFjhWfTmLT";
const TIMEOUT_MS = 15000;

const API_ENDPOINTS = {
  EU: "https://smarthub-eu.bestwaycorp.com",
  US: "https://smarthub-us.bestwaycorp.com",
  CN: "https://smarthub.bestwaycorp.cn",
};

// Fester IV aus der dekompilierten App (AESEncrypt.java)
const FIXED_IV = Buffer.from([56, 110, 58, 168, 76, 255, 94, 159, 237, 215, 171, 181, 150, 40, 74, 166]);

function generateVisitorId() {
  return crypto.randomBytes(8).toString("hex"); // 16 hex chars
}

function randomNonce() {
  // lowercase + digits, Laenge 32 (wie Referenz)
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.randomBytes(32);
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[buf[i] % chars.length];
  return out;
}

function buildSign(nonce, ts) {
  return crypto
    .createHash("md5")
    .update(APP_ID + APP_SECRET + nonce + ts)
    .digest("hex")
    .toUpperCase();
}

// AES-256-CBC Command-Verschluesselung.
// Key = SHA-256("<sign>,<appSecret>") hex, erste 32 Zeichen als UTF-8-Bytes.
function encryptCommandPayload(sign, plaintext) {
  const keyHex = crypto
    .createHash("sha256")
    .update(sign + "," + APP_SECRET, "utf8")
    .digest("hex")
    .slice(0, 32);
  const key = Buffer.from(keyHex, "utf8"); // 32 Bytes
  const cipher = crypto.createCipheriv("aes-256-cbc", key, FIXED_IV);
  cipher.setAutoPadding(true); // PKCS7
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([FIXED_IV, ct]).toString("base64");
}

class BestwayV2Api {
  /**
   * @param {any} adapter ioBroker Adapter (fuer Logging + requestClient)
   * @param {{region?: string, visitorId?: string}} options
   */
  constructor(adapter, options) {
    this.adapter = adapter;
    this.requestClient = adapter.requestClient;
    this.region = options.region || "EU";
    this.apiBase = API_ENDPOINTS[this.region] || API_ENDPOINTS.EU;
    this.visitorId = options.visitorId;
    this.token = null;
    this.devices = {};
  }

  static generateVisitorId() {
    return generateVisitorId();
  }

  /**
   * @param {string} [pushType] header/nonce style: "fcm" (default) or "android"
   */
  _headers(pushType) {
    const pt = pushType || "fcm";
    // QR/grant requests use hex(16) nonce like the reference; others use a
    // 32-char lowercase+digit nonce. Both feed the same MD5 sign formula.
    const nonce = pt === "android" ? crypto.randomBytes(16).toString("hex") : randomNonce();
    const ts = String(Math.floor(Date.now() / 1000));
    const sign = buildSign(nonce, ts);
    return {
      pushtype: pt,
      appid: APP_ID,
      nonce: nonce,
      ts: ts,
      "accept-language": "en",
      sign: sign,
      Authorization: this.token ? "token " + this.token : "token",
      "User-Agent": "okhttp/4.9.0",
      "Content-Type": "application/json; charset=UTF-8",
    };
  }

  async _get(path) {
    const res = await this.requestClient({
      method: "get",
      url: this.apiBase + path,
      headers: this._headers(),
      timeout: TIMEOUT_MS,
    });
    return res.data;
  }

  async _post(path, data, headers) {
    const res = await this.requestClient({
      method: "post",
      url: this.apiBase + path,
      headers: headers || this._headers(),
      data: data,
      timeout: TIMEOUT_MS,
    });
    return res.data;
  }

  /** Gast-Login: erzeugt/aktualisiert Token fuer die visitor_id. */
  async authenticate() {
    if (!this.visitorId) {
      this.visitorId = generateVisitorId();
    }
    const payload = {
      app_id: APP_ID,
      brand: "",
      lan_code: "en",
      location: this.region === "US" ? "US" : this.region === "CN" ? "CN" : "GB",
      marketing_notification: 0,
      push_type: "fcm",
      timezone: "GMT",
      visitor_id: this.visitorId,
      registration_id: "",
      client_id: crypto.randomBytes(8).toString("hex").slice(0, 15),
    };
    const data = await this._post("/api/enduser/visitor", payload);
    const token = data && data.data && data.data.token;
    if (!token) {
      throw new Error("V2 authenticate: no token in response " + JSON.stringify(data));
    }
    this.token = String(token);
    return this.token;
  }

  /**
   * Koppelt ein geteiltes Geraet ueber den QR-Share-Code.
   * @param {string} qrCode String, der mit "RW_Share_" beginnt
   */
  async bindQrCode(qrCode) {
    if (!qrCode || !qrCode.startsWith("RW_Share_")) {
      throw new Error("Invalid QR code format (must start with RW_Share_)");
    }
    if (!this.token) {
      await this.authenticate();
    }
    // grant_device uses the android push-type header/nonce style (reference).
    const data = await this._post(
      "/api/enduser/grant_device",
      { vercode: qrCode, push_type: "android" },
      this._headers("android"),
    );
    if (data && data.code !== 0 && data.code !== undefined) {
      throw new Error("QR binding failed: " + (data.message || JSON.stringify(data)));
    }
    const result = (data && data.data) || null;
    if (!result || (typeof result === "object" && Object.keys(result).length === 0)) {
      // Empty success body means the grant did not actually happen.
      throw new Error("QR binding returned no device (code expired or already used)");
    }
    return result;
  }

  /** Ermittelt alle Geraete: homes -> rooms -> devices. */
  async refreshBindings() {
    const discovered = [];
    const homesResp = await this._get("/api/enduser/homes");
    if (!homesResp || homesResp.code !== 0) {
      throw new Error("V2 homes failed: " + JSON.stringify(homesResp));
    }
    const homes = (homesResp.data && homesResp.data.list) || [];
    for (const home of homes) {
      const roomsResp = await this._get("/api/enduser/home/rooms?home_id=" + home.id);
      if (!roomsResp || roomsResp.code !== 0) {
        continue;
      }
      const rooms = (roomsResp.data && roomsResp.data.list) || [];
      for (const room of rooms) {
        const devResp = await this._get("/api/enduser/home/room/devices?room_id=" + room.id);
        if (!devResp || devResp.code !== 0) {
          continue;
        }
        const devs = (devResp.data && devResp.data.list) || [];
        for (const d of devs) {
          discovered.push(d);
        }
      }
    }

    this.devices = {};
    for (const dev of discovered) {
      const deviceId = dev.device_id;
      if (!deviceId) continue;
      this.devices[deviceId] = {
        device_id: deviceId,
        product_id: (dev.product_id || "").trim(),
        product_series: (dev.product_series || "AIRJET").trim(),
        alias: dev.device_alias || dev.device_name || String(deviceId).slice(0, 12),
        is_online: dev.is_online !== undefined ? dev.is_online : true,
        service_region: dev.service_region || "eu-central-1",
        raw: dev,
      };
    }
    return this.devices;
  }

  /** Liest das Device Shadow (reported + desired zusammengefuehrt). */
  async fetchDeviceState(deviceId) {
    const device = this.devices[deviceId];
    if (!device) throw new Error("Unknown device " + deviceId);
    const resp = await this._post("/api/device/thing_shadow/", {
      device_id: deviceId,
      product_id: device.product_id || device.product_series,
    });
    const rawData = (resp && resp.data) || {};
    let state;
    if (rawData.state && typeof rawData.state === "object") {
      const reported = rawData.state.reported || {};
      const desired = rawData.state.desired || {};
      state = Object.assign({}, reported, desired);
    } else {
      state = rawData;
    }
    return state;
  }

  /**
   * Sendet Steuerbefehle (AWS-Feldnamen). Versucht v2 (verschluesselt),
   * faellt bei Fehler auf v1 (unverschluesselt) zurueck.
   * @param {string} deviceId
   * @param {object} stateUpdates z.B. { power_state: 1, temperature_setting: 40 }
   */
  async setDeviceState(deviceId, stateUpdates) {
    const device = this.devices[deviceId];
    if (!device) throw new Error("Unknown device " + deviceId);

    const awsUpdates = {};
    for (const key of Object.keys(stateUpdates)) {
      let value = stateUpdates[key];
      if (typeof value === "boolean") {
        value = value ? 1 : 0;
      } else if (typeof value !== "number") {
        value = parseInt(value, 10);
      }
      // Reject invalid values instead of sending null/NaN to the device.
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Invalid command value for " + key + ": " + JSON.stringify(stateUpdates[key]));
      }
      awsUpdates[key] = value;
    }
    if (Object.keys(awsUpdates).length === 0) return false;

    // Header EINMAL erzeugen, damit der sign fuer Verschluesselung und Request identisch ist.
    const headers = this._headers();
    const sign = headers.sign;

    const desiredJson = JSON.stringify({ state: { desired: awsUpdates } });
    const commandPayload = {
      device_id: deviceId,
      product_id: device.product_id,
      desired: desiredJson,
    };
    const plaintext = JSON.stringify(commandPayload);
    const encrypted = encryptCommandPayload(sign, plaintext);

    // v2 (verschluesselt) mit denselben Headern (matching sign!)
    try {
      const res = await this.requestClient({
        method: "post",
        url: this.apiBase + "/api/v2/device/command",
        headers: headers,
        data: { encrypted_data: encrypted },
        timeout: TIMEOUT_MS,
      });
      if (res.data && res.data.code === 0) {
        return true;
      }
      this.adapter.log.warn("V2 command returned code " + (res.data && res.data.code) + ", falling back to v1");
    } catch (e) {
      this.adapter.log.warn("V2 command error (" + e.message + "), falling back to v1");
    }

    // v1 Fallback (unverschluesselt)
    const v1Resp = await this._post("/api/device/command/", {
      device_id: deviceId,
      product_id: device.product_id,
      desired: { state: { desired: awsUpdates } },
    });
    if (v1Resp && v1Resp.code === 0) {
      return true;
    }
    throw new Error("V2/v1 command failed: " + JSON.stringify(v1Resp));
  }
}

// Normalisiert AWS-Shadow-Felder auf sprechende, stabile State-Namen.
function normalizeAwsState(deviceState) {
  const out = {};
  const s = deviceState || {};

  if (s.power_state !== undefined && s.power_state !== null) out.power = s.power_state === 1;
  if (s.heater_state !== undefined && s.heater_state !== null) out.heat = s.heater_state;
  if (s.wave_state !== undefined && s.wave_state !== null) out.wave = s.wave_state;
  if (s.filter_state !== undefined && s.filter_state !== null) out.filter = s.filter_state;
  if (s.hydrojet_state !== undefined && s.hydrojet_state !== null) out.jet = s.hydrojet_state === 1;
  if (s.locked !== undefined && s.locked !== null) out.locked = s.locked;

  if (s.water_temperature !== undefined && s.water_temperature !== null) out.temp_now = s.water_temperature;
  if (s.temperature_setting !== undefined && s.temperature_setting !== null) out.temp_set = s.temperature_setting;
  if (s.temperature_unit !== undefined) out.temp_set_unit = s.temperature_unit;

  if ("warning" in s) out.warning = s.warning === "" ? 0 : s.warning;
  if ("error_code" in s) out.error = s.error_code === "" ? 0 : s.error_code;
  if (s.is_online !== undefined && s.is_online !== null) out.is_online = s.is_online;

  if ("wifivertion" in s) out.wifi_version = s.wifivertion;
  if ("mcuversion" in s) out.mcu_version = s.mcuversion;
  if ("otastatus" in s) out.ota_status = s.otastatus;

  return out;
}

module.exports = {
  BestwayV2Api,
  normalizeAwsState,
  API_ENDPOINTS,
  APP_ID,
  APP_SECRET,
  generateVisitorId,
  encryptCommandPayload,
};
