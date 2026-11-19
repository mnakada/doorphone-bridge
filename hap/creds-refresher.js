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
    // Base-station revocation detection: if we publish GET_SIGNALING_CHANNEL
    // and the base doesn't reply within pendingTimeoutMs, that's a "stale"
    // request. staleThreshold consecutive stales → emit 'revoked' (the base
    // has forgotten us; our cert is effectively dead).
    this.pendingTimeoutMs = 120_000;
    this.staleThreshold = 3;
    this.staleCount = 0;
    this.pendingTimer = null;
    this.stopped = false;
    this.revoked = false;
    // Unpairing on the base is never pushed to us; we only learn about it
    // when a GET_SIGNALING_CHANNEL comes back NOT_REGISTERED. Ask every
    // checkIntervalMs (also keeps creds fresh), plus on demand via checkNow().
    this.checkIntervalMs = 60_000;
    this.checkTimer = null;
    this.minCheckGapMs = 10_000;
    this._lastRequestAt = 0;
    this._quietPending = false;
    this._ctx = null; // { unit, clientId, topic } once connected
  }

  // Ask the base right now whether we're still registered (rate-limited).
  // Used when someone opens the Web UI so an unpair shows up within seconds.
  checkNow() {
    if (this.stopped || this.revoked || !this._ctx || !this.client?.connected) return;
    if (this.pendingTimer) return; // a request is already in flight
    if (Date.now() - this._lastRequestAt < this.minCheckGapMs) return;
    this._requestCreds(this._ctx.unit, this._ctx.clientId, this._ctx.topic, { quiet: true });
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
        this._ctx = { unit, clientId, topic };
        this._requestCreds(unit, clientId, topic);
      });
    });
    if (!this.checkTimer) {
      this.checkTimer = setInterval(() => this.checkNow(), this.checkIntervalMs);
      this.checkTimer.unref?.();
    }

    this.client.on('message', (_topic, payload) => {
      this._onMessage(payload.toString('utf8'), clientId);
    });

    this.client.on('error', (e) => this.emit('error', e));
    this.client.on('reconnect', () => this.emit('log', 'MQTT reconnecting'));
    this.client.on('close', () => this.emit('log', 'MQTT closed'));
  }

  _requestCreds(unit, clientId, topic, { quiet = false } = {}) {
    this._lastRequestAt = Date.now();
    this._quietPending = quiet;
    this._armPendingTimer(unit, clientId, topic);
    const msg = JSON.stringify({
      to: unit.unitDeviceId,
      from: clientId,
      data: { command: 'GET_SIGNALING_CHANNEL', payload: null },
    });
    this.client.publish(topic, msg, { qos: 0 }, (err) => {
      if (err) this.emit('error', err);
      else if (!quiet) this.emit('log', 'GET_SIGNALING_CHANNEL sent');
    });
  }

  _armPendingTimer(unit, clientId, topic) {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this._onStale(unit, clientId, topic), this.pendingTimeoutMs);
    this.pendingTimer.unref?.();
  }

  _clearPendingTimer() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  _onStale(unit, clientId, topic) {
    this.pendingTimer = null;
    this.staleCount++;
    this.emit('log', `GET_SIGNALING_CHANNEL unanswered after ${this.pendingTimeoutMs / 1000}s (${this.staleCount}/${this.staleThreshold})`);
    if (this.staleCount >= this.staleThreshold) {
      this._revoke('base station no longer answers — likely revoked');
      return;
    }
    if (this.stopped || !this.client?.connected) return;
    this._requestCreds(unit, clientId, topic);
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
    if (payload?.error === 'NOT_REGISTERED') {
      // The base explicitly says we were unregistered (unpaired from the
      // doorphone side) — no need to wait for the stale-timeout path.
      this._revoke('base station replied NOT_REGISTERED — unpaired');
      return;
    }
    if (!payload?.channelName) {
      this.emit('log', 'NOTIFY_KVS_CREDENTIAL missing channelName: ' + JSON.stringify(payload).slice(0, 200));
      return;
    }
    this._clearPendingTimer();
    this.staleCount = 0;
    try {
      fs.writeFileSync(this.credsPath, JSON.stringify(payload, null, 2), { mode: 0o640 });
      this.emit('creds', payload);
      // Periodic registration checks also refresh creds; don't log each one.
      if (!this._quietPending) this.emit('log', `creds refreshed, expires ${payload.Expiration}`);
      this._quietPending = false;
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

  _revoke(reason) {
    if (this.revoked) return;
    this.revoked = true;
    this.emit('log', reason);
    // The cert is dead; stop MQTT so we don't keep reconnecting with it.
    this.stop();
    this.emit('revoked');
  }

  stop() {
    this.stopped = true;
    if (this.checkTimer) { clearInterval(this.checkTimer); this.checkTimer = null; }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this._clearPendingTimer();
    try { this.client?.end(true); } catch (_) {}
    this.client = null;
  }
}

module.exports = { CredsRefresher };
