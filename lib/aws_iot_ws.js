"use strict";

/*
 * Bestway V2 (AWS IoT) WebSocket-Client fuer Echtzeit-Shadow-Updates.
 *
 * Portiert aus ha-bestway (custom_components/bestway/aws_iot/websocket.py).
 * Eine Verbindung pro Geraet zu einem regionalen AWS-API-Gateway-Endpoint.
 * Authentifizierung ueber Authorization-Header (kein Login-Frame).
 */

const WebSocket = require("ws");

// Regionale WebSocket-Endpoints (aus ServiceConfig.java der App)
const WS_ENDPOINTS = {
  "eu-central-1": "wss://7lv67j5lbh.execute-api.eu-central-1.amazonaws.com/prod",
  "us-west-1": "wss://9i661wi8f9.execute-api.us-west-1.amazonaws.com/prod",
  "cn-north-1": "wss://fu9gsv4dxh.execute-api.cn-north-1.amazonaws.com.cn/prod",
};

// Reconnect-Backoff (Sekunden)
const RECONNECT_DELAYS = [3, 6, 12, 24, 48, 60];

class BestwayV2WebSocket {
  /**
   * @param {object} opts
   * @param {any} opts.adapter ioBroker Adapter (Logging)
   * @param {string} opts.deviceId
   * @param {string} opts.serviceRegion z.B. "eu-central-1"
   * @param {string} opts.token
   * @param {(deviceId: string, rawState: object) => void} opts.onUpdate Callback mit Roh-Shadow-State
   * @param {() => Promise<string|null>} [opts.onTokenRefresh] liefert frisches Token bei HTTP 400
   */
  constructor(opts) {
    this.adapter = opts.adapter;
    this.deviceId = opts.deviceId;
    this.serviceRegion = opts.serviceRegion || "eu-central-1";
    this.token = opts.token;
    this.onUpdate = opts.onUpdate;
    this.onTokenRefresh = opts.onTokenRefresh;

    this.ws = null;
    this.running = false;
    this.reconnectCount = 0;
    this.seqId = Date.now();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  get wsUrl() {
    return WS_ENDPOINTS[this.serviceRegion] || WS_ENDPOINTS["eu-central-1"];
  }

  connect() {
    if (this.running) return;
    this.running = true;
    this._open();
  }

  _open() {
    if (!this.running) return;
    const url = this.wsUrl;
    try {
      this.ws = new WebSocket(url, {
        headers: { Authorization: this.token },
        handshakeTimeout: 15000,
      });
    } catch (e) {
      this.adapter.log.warn("V2 WS connect error for " + this.deviceId + ": " + e.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.reconnectCount = 0;
      this.adapter.log.debug("V2 WS connected for " + this.deviceId);
      this._startHeartbeat();
    });

    this.ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        this.adapter.log.debug("V2 WS malformed JSON");
        return;
      }
      this._handleMessage(data);
    });

    this.ws.on("close", () => {
      this._stopHeartbeat();
      if (this.running) {
        this.adapter.log.debug("V2 WS closed for " + this.deviceId + ", reconnecting");
        this._scheduleReconnect();
      }
    });

    this.ws.on("unexpected-response", async (_req, res) => {
      // HTTP 400 -> Token abgelaufen: refresh, dann Handshake beenden und
      // per Reconnect mit frischem Token neu verbinden.
      const status = res && res.statusCode;
      if (status === 400 && this.onTokenRefresh) {
        try {
          const newToken = await this.onTokenRefresh();
          if (newToken) {
            this.token = newToken;
            this.adapter.log.debug("V2 WS token refreshed, reconnecting");
          }
        } catch (e) {
          this.adapter.log.warn("V2 WS token refresh failed: " + e.message);
        }
      }
      // Der fehlgeschlagene Handshake liefert kein 'close'; selbst terminieren
      // und den Reconnect anstossen (der neue Socket nutzt this.token).
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
      this._stopHeartbeat();
      if (this.running) {
        this._scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      this.adapter.log.debug("V2 WS error for " + this.deviceId + ": " + err.message);
      // 'close' folgt und triggert den Reconnect.
    });
  }

  _handleMessage(data) {
    let state = null;

    // "documents": vollstaendiger Shadow-Snapshot
    if (data.current && typeof data.current === "object" && data.current.state) {
      const cs = data.current.state;
      const reported = cs.reported || {};
      const desired = cs.desired || {};
      if (Object.keys(reported).length || Object.keys(desired).length) {
        state = Object.assign({}, reported, desired);
      }
    }

    // "update"/"delta": state auf Top-Level
    if (state === null && data.state && typeof data.state === "object") {
      const rs = data.state;
      if ((rs.reported && typeof rs.reported === "object") || (rs.desired && typeof rs.desired === "object")) {
        state = Object.assign({}, rs.reported || {}, rs.desired || {});
      } else {
        state = rs;
      }
    }

    if (!state || Object.keys(state).length === 0) return;

    if (typeof this.onUpdate === "function") {
      try {
        this.onUpdate(this.deviceId, state);
      } catch (e) {
        this.adapter.log.warn("V2 WS callback error: " + e.message);
      }
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.running || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(
          JSON.stringify({
            action: "heartbeat",
            req_event: "heartbeat_req",
            seq_id: this.seqId,
            req_count: 1,
            req: null,
          }),
        );
        this.ws.ping();
        this.seqId += 1;
      } catch (e) {
        this.adapter.log.debug("V2 WS heartbeat failed: " + e.message);
      }
    }, 30 * 1000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectCount, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[idx];
    this.reconnectCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this._open();
    }, delay * 1000);
  }

  disconnect() {
    this.running = false;
    this._stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      try {
        // Remove data listeners but keep a no-op error handler: terminating a
        // socket still in CONNECTING emits an asynchronous error that a
        // synchronous try/catch cannot catch.
        sock.removeAllListeners("open");
        sock.removeAllListeners("message");
        sock.removeAllListeners("close");
        sock.removeAllListeners("unexpected-response");
        sock.removeAllListeners("error");
        sock.on("error", () => {
          // swallow late errors during teardown
        });
        sock.terminate();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { BestwayV2WebSocket, WS_ENDPOINTS };
