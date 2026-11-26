/**
 * NAS sync: periodically copy the base-station recordings to a CIFS/SMB share.
 *
 * Mirrors the atomcam_tools "NAS録画" behaviour: a save-path template in
 * strftime format (extension appended automatically), optional auto-deletion
 * after N days. Uploads go through `smbclient` (no mount, no root) so the
 * service user can run them; the password is passed in a 0600 auth file, never
 * on the command line.
 *
 * Settings live in their own JSON file (cfg.storage.nasConfigPath, default
 * /etc/doorphone-bridge/nas.json) so the Web UI can edit them and the password
 * stays out of the main config. The file is re-read every run, so changes
 * apply without a restart.
 *
 * A record is only ever uploaded once: the set of uploaded recordings (and
 * where they went) is kept in <stateDir>/nas-state.json, which also drives
 * auto-deletion of our own old uploads.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const DEFAULTS = {
  enabled: false,
  server: '',          // //host/share/optional/sub  (first path element = share)
  user: '',
  password: '',
  vers: '3.0',         // SMB protocol version for smbclient -m
  pathTemplate: '%Y%m%d/%H%M%S', // strftime; extension appended
  thumbnails: false,   // also upload the .JPG thumbnail
  intervalMinutes: 60,
  backfillDays: 7,     // first-ever run: how far back to copy
  remove: false,       // auto-delete our old uploads from the NAS
  removeDays: 30,
  smbclient: 'smbclient',
};

const MAX_FILE_FAILS = 3;        // give up on a single recording after this many attempts
const MAX_CONSECUTIVE_FAILS = 5; // abort the run if this many fail back-to-back
// Wait this long before re-attempting a recording that failed (indexed by
// attempt number). Keeps a re-sync fast by not re-trying known-bad files that
// time out ~20s each; they are eventually given up after MAX_FILE_FAILS.
const RETRY_BACKOFF_MS = [6 * 3600_000, 24 * 3600_000]; // attempt 1 → 6h, attempt 2 → 24h

// Minimal strftime for the fields atomcam exposes (date/time).
function strftime(tmpl, d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return tmpl.replace(/%[YmdHMSy%]/g, (t) => {
    switch (t) {
      case '%Y': return String(d.getFullYear());
      case '%y': return p2(d.getFullYear() % 100);
      case '%m': return p2(d.getMonth() + 1);
      case '%d': return p2(d.getDate());
      case '%H': return p2(d.getHours());
      case '%M': return p2(d.getMinutes());
      case '%S': return p2(d.getSeconds());
      case '%%': return '%';
      default: return t;
    }
  });
}

// Split "//host/share/a/b" -> { service: "//host/share", baseDir: "a/b" }.
function parseServer(server) {
  const s = String(server || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(s);
  if (!m) return null;
  return { service: `//${m[1]}/${m[2]}`, baseDir: (m[3] || '').replace(/\/+$/, '') };
}

class NasSync extends EventEmitter {
  constructor({ records, configPath, stateDir, logger }) {
    super();
    this.records = records;
    this.configPath = configPath;
    this.statePath = path.join(stateDir, 'nas-state.json');
    this.logger = logger || (() => {});
    this.timer = null;
    this.running = false;
    this.progress = null;   // { total, copied, failed } while a run is in flight
    this.lastResult = null; // { at, ok, copied, skipped, error }
    this._state = this._loadState();
    this._normalizeFailed();
  }

  // Older state stored failed[id] as a plain attempt count. Give those a
  // backoff deadline so the next sync does not immediately re-try them.
  _normalizeFailed() {
    const f = this._state.failed;
    if (!f) return;
    let changed = false;
    for (const [id, v] of Object.entries(f)) {
      if (typeof v === 'number') {
        const wait = RETRY_BACKOFF_MS[Math.min(v - 1, RETRY_BACKOFF_MS.length - 1)];
        f[id] = { n: v, nextAt: Date.now() + wait };
        changed = true;
      }
    }
    if (changed) this._saveState();
  }

  loadConfig() {
    let file = {};
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8').trim();
      if (raw) file = JSON.parse(raw);
    } catch (_) {}
    return { ...DEFAULTS, ...file };
  }

  // Password is never returned to the browser.
  publicConfig() {
    const c = this.loadConfig();
    const { password, ...rest } = c;
    return { ...rest, hasPassword: !!password };
  }

  saveConfig(patch) {
    const cur = this.loadConfig();
    const next = { ...cur, ...patch };
    // Empty password in a patch means "keep the existing one".
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'password') && patch.password === '') {
      next.password = cur.password;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2));
    try { fs.chmodSync(this.configPath, 0o600); } catch (_) {}
    this._reschedule(next);
    return this.publicConfig();
  }

  _loadState() {
    let s;
    try { s = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); }
    catch (_) { s = {}; }
    s.uploaded = s.uploaded || {}; // id -> { remote, recTime, at } | { skipped, ... }
    s.failed = s.failed || {};     // id -> { n, nextAt }
    return s;
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this._state, null, 2));
    } catch (e) { this.logger(`state save failed: ${e.message}`); }
  }

  start() {
    const cfg = this.loadConfig();
    this._reschedule(cfg);
    // Kick off a run shortly after boot so a freshly-configured NAS fills in
    // without waiting a whole interval (but after creds/base settle).
    setTimeout(() => this.syncNow('startup').catch(() => {}), 30_000).unref?.();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  _reschedule(cfg) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const mins = Math.max(5, Number(cfg.intervalMinutes) || 60);
    this.timer = setInterval(() => this.syncNow('interval').catch(() => {}), mins * 60_000);
    this.timer.unref?.();
  }

  async syncNow(reason = 'manual') {
    if (this.running) return { skipped: 'already-running' };
    const cfg = this.loadConfig();
    if (!cfg.enabled) return { skipped: 'disabled' };
    const srv = parseServer(cfg.server);
    if (!srv) { this.logger('NAS server path is invalid (expected //host/share/...)'); return { skipped: 'bad-server' }; }

    this.running = true;
    this.progress = null;
    const t0 = Date.now();
    let copied = 0, failed = 0, error = null;
    try {
      const todo = await this._collectPending(cfg);
      this.progress = { total: todo.length, copied: 0, failed: 0 };
      this.logger(`sync (${reason}): ${todo.length} new recording(s)`);
      this._state.failed = this._state.failed || {};
      let consecutive = 0;
      for (const rec of todo) {
        try {
          const file = await this.records.video(rec.id); // sanitized mp4 path
          const when = rec.time ? new Date(rec.time) : new Date();
          const rel = strftime(cfg.pathTemplate, when);
          const remoteBase = (srv.baseDir ? srv.baseDir + '/' : '') + rel;
          await this._put(cfg, srv, file, remoteBase + '.mp4');
          if (cfg.thumbnails) {
            try {
              const thumb = await this.records.thumbnail(rec.thumbId);
              await this._put(cfg, srv, thumb, remoteBase + '.jpg');
            } catch (e) { this.logger(`thumbnail upload skipped: ${e.message}`); }
          }
          this._state.uploaded[rec.id] = { remote: remoteBase + '.mp4', recTime: rec.time, at: new Date().toISOString() };
          delete this._state.failed[rec.id];
          this._saveState();
          copied++;
          this.progress.copied = copied;
          consecutive = 0;
          this.logger(`uploaded ${path.basename(rec.id)} -> ${remoteBase}.mp4`);
        } catch (e) {
          if (e && e.code === 'LIVE_BUSY') { this.logger('live view active — pausing sync, will retry next run'); break; }
          // One recording that won't download must not stall the rest: count
          // the failure, skip to the next, and give up on it after MAX_FILE_FAILS
          // attempts (across runs) so we stop wasting a timeout on it each run.
          // A single skipped file is not a run-level error.
          const msg = e.message || String(e);
          const prev = this._state.failed[rec.id];
          const n = (typeof prev === 'number' ? prev : prev?.n || 0) + 1;
          if (n >= MAX_FILE_FAILS) {
            this._state.uploaded[rec.id] = { skipped: true, error: msg, recTime: rec.time, at: new Date().toISOString() };
            delete this._state.failed[rec.id];
            this.logger(`giving up on ${path.basename(rec.id)} after ${n} attempts: ${msg}`);
          } else {
            // Back off before retrying this recording: a file the base cannot
            // read fails the same way every run, so retrying it each sync just
            // burns a 20s timeout. Wait hours between attempts instead.
            const wait = RETRY_BACKOFF_MS[Math.min(n - 1, RETRY_BACKOFF_MS.length - 1)];
            this._state.failed[rec.id] = { n, nextAt: Date.now() + wait, recTime: rec.time };
            this.logger(`download failed (attempt ${n}) ${path.basename(rec.id)}: ${msg} — retry after ${Math.round(wait / 3600_000)}h`);
          }
          this._saveState();
          failed++;
          this.progress.failed = failed;
          // A GetFile timeout is localized to one (likely unreadable)
          // recording — skip it and keep going so a cluster of bad files does
          // not stall progress. A global problem (NAS down, base unreachable)
          // surfaces as a different error (smbclient / base-connect failure);
          // those we count, and abort the run after a few in a row.
          const localized = /timed out/i.test(msg);
          consecutive = localized ? 0 : consecutive + 1;
          if (consecutive >= MAX_CONSECUTIVE_FAILS) {
            error = `連続 ${consecutive} 件失敗のため中断: ${msg}`;
            this.logger('too many consecutive failures — aborting run');
            break;
          }
        }
      }
      if (cfg.remove) await this._prune(cfg, srv).catch(e => this.logger(`prune failed: ${e.message}`));
    } catch (e) {
      if (e && e.code === 'LIVE_BUSY') { this.lastResult = { at: new Date().toISOString(), ok: copied > 0 || failed === 0, copied, failed, note: 'live-busy' }; return this.lastResult; }
      error = e.message || String(e);
      this.logger(`sync error: ${error}`);
    } finally {
      this.running = false;
      this.progress = null;
    }
    this.lastResult = { at: new Date().toISOString(), ok: !error, copied, failed, error, ms: Date.now() - t0 };
    return this.lastResult;
  }

  // Walk the record list (newest first) and return records we have not yet
  // uploaded, oldest first. Recordings older than the backfill cutoff are
  // never uploaded: the cutoff is fixed once (on the first run) and persisted,
  // so an old recording skipped at install time is not picked up later.
  async _collectPending(cfg) {
    if (this._state.since == null) {
      this._state.since = Date.now() - Math.max(0, Number(cfg.backfillDays) || 0) * 86400_000;
      this._saveState();
    }
    const cutoff = this._state.since;
    const pending = [];
    const PAGE = 20;
    for (let offset = 0; offset < 500; offset += PAGE) {
      const { records, hasNext } = await this.records.list(offset, PAGE);
      if (!records.length) break;
      let reachedOld = false;
      for (const r of records) {
        const ts = r.time ? Date.parse(r.time) : Date.now();
        if (ts < cutoff) { reachedOld = true; continue; }
        if (this._state.uploaded[r.id]) continue;
        // Honour the retry backoff for recordings that failed before.
        const f = this._state.failed[r.id];
        if (f && typeof f === 'object' && f.nextAt && f.nextAt > Date.now()) continue;
        pending.push(r);
      }
      if (reachedOld || !hasNext) break;
    }
    pending.sort((a, b) => Date.parse(a.time || 0) - Date.parse(b.time || 0));
    return pending;
  }

  _authFile(cfg) {
    const f = path.join(os.tmpdir(), `nas-auth-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(f, `username=${cfg.user}\npassword=${cfg.password}\n`, { mode: 0o600 });
    return f;
  }

  _smb(cfg, srv, command) {
    const auth = this._authFile(cfg);
    const args = [srv.service, '-A', auth];
    const proto = { '3.0': 'SMB3', '3': 'SMB3', '2.1': 'SMB2', '2.0': 'SMB2', '2': 'SMB2', '1.0': 'NT1' }[String(cfg.vers || '')];
    if (proto) args.push('-m', proto);
    args.push('-c', command);
    return new Promise((resolve, reject) => {
      execFile(cfg.smbclient, args, { timeout: 300_000 }, (err, stdout, stderr) => {
        try { fs.unlinkSync(auth); } catch (_) {}
        if (err) return reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
        resolve((stdout || '') + (stderr || ''));
      });
    });
  }

  // Upload one local file to remotePath (relative to the share), creating
  // intermediate directories. smbclient has no mkdir -p, so make each level
  // and ignore "already exists".
  async _put(cfg, srv, localFile, remotePath) {
    const dirs = remotePath.split('/').slice(0, -1);
    let acc = '';
    const cmds = [];
    for (const d of dirs) { acc = acc ? acc + '/' + d : d; cmds.push(`mkdir "${acc}"`); }
    cmds.push(`put "${localFile}" "${remotePath}"`);
    // Each mkdir may fail harmlessly; run them tolerantly, then the put strictly.
    for (const c of cmds.slice(0, -1)) { try { await this._smb(cfg, srv, c); } catch (_) {} }
    await this._smb(cfg, srv, cmds[cmds.length - 1]);
  }

  // Delete our own uploads older than removeDays, then try to remove the
  // now-empty directories. Only touches files we recorded in state.
  async _prune(cfg, srv) {
    const keepMs = Math.max(1, Number(cfg.removeDays) || 30) * 86400_000;
    const now = Date.now();
    const dirs = new Set();
    for (const [id, info] of Object.entries(this._state.uploaded)) {
      if (!info.remote) continue; // skipped (never-uploaded) entry: nothing on the NAS
      const ts = info.recTime ? Date.parse(info.recTime) : Date.parse(info.at);
      if (!(now - ts > keepMs)) continue;
      try {
        await this._smb(cfg, srv, `del "${info.remote}"`);
        if (cfg.thumbnails) { try { await this._smb(cfg, srv, `del "${info.remote.replace(/\.mp4$/, '.jpg')}"`); } catch (_) {} }
        const dir = info.remote.split('/').slice(0, -1).join('/');
        if (dir) dirs.add(dir);
        delete this._state.uploaded[id];
        this.logger(`removed old upload ${info.remote}`);
      } catch (e) {
        // Missing file (already gone) is fine: drop it from state.
        if (/NT_STATUS_OBJECT_NAME_NOT_FOUND|NT_STATUS_NO_SUCH_FILE/.test(e.message)) delete this._state.uploaded[id];
        else this.logger(`delete failed ${info.remote}: ${e.message}`);
      }
    }
    this._saveState();
    // Best-effort: remove emptied directories (deepest first).
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      try { await this._smb(cfg, srv, `rmdir "${d}"`); } catch (_) {}
    }
  }
}

module.exports = { NasSync, parseServer, strftime, DEFAULTS };
