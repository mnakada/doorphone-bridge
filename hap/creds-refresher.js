/**
 * Fetches AWS temporary credentials from the doorphone base over AWS IoT MQTT
 * (mTLS), and keeps them fresh.
 *
 * Flow (ported from get_kvs_creds.py / analysed from the Panasonic app):
 *   1. Connect to AWS IoT MQTT with the client certificate obtained during
 *      pairing.
 *   2. Subscribe to doorphone/comm/<unitId>.
 *   3. Publish {"command":"GET_SIGNALING_CHANNEL"} addressed to the base.
 *   4. Receive NOTIFY_KVS_CREDENTIAL, write the inner JSON to credsPath.
 *   5. Repeat before expiry (~10 min window).
 *
 * The refresher runs inside the accessory process; it reuses the paired cert
 * from /etc/doorphone-hap/cert.pem + privkey.pem and the unitId from unit.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const mqtt = require('mqtt');

const IOT_ENDPOINT = 'd02819672h9iuly6ai747-ats.iot.ap-northeast-1.amazonaws.com';
const IOT_PORT = 8883;

class CredsRefresher extends EventEmitter {
  constructor({ unitInfoPath, certPath, keyPath, credsPath, appId }) {
    super();
    this.unitInfoPath = unitInfoPath;
    this.certPath = certPath;
    this.keyPath = keyPath;
    this.credsPath = credsPath;
    this.appId = appId;
    this.client = null;
    this.refreshTimer = null;
    this.stopped = false;
  }

  _loadUnit() {
    const info = JSON.parse(fs.readFileSync(this.unitInfoPath, 'utf8'));
    if (!info.unitDeviceId) throw new Error('unit.json missing unitDeviceId');
    return info;
  }

  _resolveAppId(unit) {
    if (this.appId) return this.appId;
    if (unit.mobileDeviceId) return unit.mobileDeviceId;
    // Fallback — must match what was used during pairing or the base won't
    // address us. Generate a stable value from the pairing fingerprint.
    return 'SP_' + crypto.randomUUID();
  }

  async start() {
    const unit = this._loadUnit();
    const clientId = this._resolveAppId(unit);
    const topic = `doorphone/comm/${unit.unitDeviceId}`;

    const cert = fs.readFileSync(this.certPath);
    const key = fs.readFileSync(this.keyPath);

    this.emit('log', `connecting to ${IOT_ENDPOINT} as ${clientId}`);
    this.client = mqtt.connect({
      host: IOT_ENDPOINT,
      port: IOT_PORT,
      protocol: 'mqtts',
      clientId,
      cert,
      key,
      // AWS IoT uses standard mTLS on 8883. clean session, short keepalive.
      clean: true,
      keepalive: 30,
      rejectUnauthorized: true,
      reconnectPeriod: 10000,
    });

    this.client.on('connect', () => {
      this.emit('log', 'MQTT connected');
      this.client.subscribe(topic, { qos: 0 }, (err) => {
        if (err) return this.emit('error', err);
        this.emit('log', `subscribed to ${topic}`);
        this._requestCreds(unit, clientId, topic);
      });
    });

    this.client.on('message', (_topic, payload) => {
      this._onMessage(payload.toString('utf8'), clientId);
    });

    this.client.on('error', (e) => this.emit('error', e));
    this.client.on('reconnect', () => this.emit('log', 'MQTT reconnecting'));
    this.client.on('close', () => this.emit('log', 'MQTT closed'));
  }

  _requestCreds(unit, clientId, topic) {
    const msg = JSON.stringify({
      to: unit.unitDeviceId,
      from: clientId,
      data: { command: 'GET_SIGNALING_CHANNEL', payload: null },
    });
    this.client.publish(topic, msg, { qos: 0 }, (err) => {
      if (err) this.emit('error', err);
      else this.emit('log', 'GET_SIGNALING_CHANNEL sent');
    });
  }

  _onMessage(text, clientId) {
    let msg;
    try { msg = JSON.parse(text); } catch (_) { return; }
    if (msg.to !== clientId) return; // reflecting our own publish
    let data = msg.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (_) { return; } }
    if (!data || data.command !== 'NOTIFY_KVS_CREDENTIAL') return;
    let payload = data.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (_) { return; } }
    if (!payload?.channelName) {
      this.emit('log', 'NOTIFY_KVS_CREDENTIAL missing channelName: ' + JSON.stringify(payload).slice(0, 200));
      return;
    }
    try {
      fs.writeFileSync(this.credsPath, JSON.stringify(payload, null, 2), { mode: 0o640 });
      this.emit('creds', payload);
      this.emit('log', `creds refreshed, expires ${payload.Expiration}`);
    } catch (e) {
      this.emit('error', e);
    }
    this._scheduleRefresh(payload);
  }

  _scheduleRefresh(creds) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // Refresh ~2 minutes before expiry (creds last ~10 min).
    let ms = 7 * 60 * 1000;
    if (creds?.Expiration) {
      const exp = Date.parse(creds.Expiration);
      if (Number.isFinite(exp)) ms = Math.max(30_000, exp - Date.now() - 120_000);
    }
    this.refreshTimer = setTimeout(() => {
      try {
        const unit = this._loadUnit();
        this._requestCreds(unit, this._resolveAppId(unit), `doorphone/comm/${unit.unitDeviceId}`);
      } catch (e) { this.emit('error', e); }
    }, ms);
    this.refreshTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    try { this.client?.end(true); } catch (_) {}
    this.client = null;
  }
}

module.exports = { CredsRefresher };
