/**
 * RecordService: browse the base's recordings (same data as the app's
 * 録画一覧) for the Web UI.
 *
 *  - list(offset, limit)      Request_GetRecordList (paged by the base)
 *  - thumbnail(id)            JPEG via Request_GetFile, cached on disk
 *  - video(id)                MP4 via Request_GetFile, cached on disk (LRU)
 *
 * The base session is opened on demand (BaseRpc, no monitor) and released
 * idleMs after the last operation: while it is open the base shows
 * "スマホで使用中". HomeKit live has priority — suspend() is called before a
 * live session starts and fails/aborts whatever we're doing.
 *
 * Record ids handed to the browser are opaque (base64url of the path) and
 * only paths seen in a list response are accepted: Request_GetFile reads
 * arbitrary paths on the base.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { BaseRpc } = require('./base-rpc');

const TRIGGER_LABEL = {
  TRIGGER_DELIVERY: '宅配',
  TRIGGER_INTRUSION: '侵入検知',
  TRIGGER_CAMERAMOTION: '動体検知',
  TRIGGER_INCOMINGCALL: '呼出',
  TRIGGER_LOITERING: 'うろつき',
  TRIGGER_MANUAL: '手動',
  TRIGGER_DELIVERY_INCOMINGCALL: '宅配呼出',
  TRIGGER_AUTO_UNLOCK: '自動解錠',
};

const FACE_LABEL = {
  TAG_TYPE_UNREGISTERED: '未登録の顔',
  TAG_TYPE_FAMILY: '家族',
  TAG_TYPE_FRIEND: '知人',
  TAG_TYPE_OTHER1: 'その他1',
  TAG_TYPE_OTHER2: 'その他2',
};

const toId = (p) => Buffer.from(p, 'utf8').toString('base64url');
const fromId = (id) => Buffer.from(String(id), 'base64url').toString('utf8');
// Cache file name: "<date dir>_<file>" e.g. "26-11-20_1M121624.MP4"
const cacheName = (p) => path.basename(path.dirname(p)) + '_' + path.basename(p);

class LiveBusyError extends Error {
  constructor() { super('ライブ映像の表示中は録画にアクセスできません'); this.code = 'LIVE_BUSY'; }
}

class RecordService extends EventEmitter {
  constructor({ credsPath, unitInfoPath, cacheDir, isLiveActive, beforeConnect, idleMs = 20000, maxVideoCacheBytes = 500 * 1024 * 1024 }) {
    super();
    this.credsPath = credsPath;
    this.unitInfoPath = unitInfoPath;
    this.cacheDir = cacheDir;
    this.isLiveActive = isLiveActive || (() => false);
    this.beforeConnect = beforeConnect || null; // e.g. drop a lingering live session
    this.idleMs = idleMs;
    this.maxVideoCacheBytes = maxVideoCacheBytes;
    this.rpc = null;
    this._hasControl = false;
    this._queue = Promise.resolve();
    this._idleTimer = null;
    this._known = new Map(); // path -> record (from list responses)
    this._inflight = new Map(); // cache file -> Promise (dedupe concurrent downloads)
    fs.mkdirSync(path.join(cacheDir, 'thumbs'), { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'videos'), { recursive: true });
  }

  // ---- session handling -------------------------------------------------

  // Run fn(rpc) with an open session holding record control; serialised.
  _withSession(fn) {
    const run = async () => {
      if (this.isLiveActive()) throw new LiveBusyError();
      if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
      if (!this.rpc || this.rpc.state !== 'ready') {
        const unit = JSON.parse(fs.readFileSync(this.unitInfoPath, 'utf8'));
        this.rpc = new BaseRpc({ credsPath: this.credsPath, viewerId: unit.mobileDeviceId });
        this.rpc.on('closed', (why) => { this._hasControl = false; this.emit('log', `session closed (${why})`); });
        this.rpc.on('error', (e) => this.emit('log', `session error: ${e.message || e}`));
        await this.beforeConnect?.();
        if (this.isLiveActive()) throw new LiveBusyError();
        this.emit('log', 'connecting to base');
        await this.rpc.connect();
      }
      if (!this._hasControl) {
        const r = await this.rpc.request('requestGetrecordcontrol', {});
        if (!r.body || !r.body.result) throw new Error('録画の操作権を取得できませんでした (' + (r.body && r.body.error) + ')');
        this._hasControl = true;
      }
      try {
        return await fn(this.rpc);
      } finally {
        this._armIdle();
      }
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  _armIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this._queue = this._queue.then(() => this._release('idle'));
    }, this.idleMs);
    this._idleTimer.unref?.();
  }

  async _release(why) {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    const rpc = this.rpc;
    if (!rpc) return;
    this.rpc = null;
    if (this._hasControl && rpc.state === 'ready') {
      try { await rpc.request('requestReleaserecordcontrol', {}, { timeoutMs: 3000 }); } catch (_) {}
    }
    this._hasControl = false;
    rpc.close();
    this.emit('log', `released (${why})`);
  }

  // Called before a HomeKit live session starts: get off the base now.
  async suspend() {
    if (!this.rpc) return;
    this.emit('log', 'yielding base to live view');
    await this._release('live view');
  }

  // ---- API --------------------------------------------------------------

  async list(offset = 0, limit = 20) {
    const body = await this._withSession(async (rpc) => {
      const r = await rpc.request('requestGetrecordlist', { offset, limit });
      if (!r.body || !r.body.result) throw new Error('録画一覧を取得できませんでした');
      return r.body;
    });
    const records = (body.record || []).map((rec) => {
      this._known.set(rec.recordFile, rec);
      this._known.set(rec.thumbnailFile, rec);
      const seconds = rec.timestamp ? Number(rec.timestamp.seconds) : null;
      return {
        id: toId(rec.recordFile),
        thumbId: toId(rec.thumbnailFile),
        time: seconds ? new Date(seconds * 1000).toISOString() : null,
        device: rec.deviceName || '',
        trigger: rec.trigger || 'TRIGGER_UNSPECIFIED',
        triggerLabel: TRIGGER_LABEL[rec.trigger] || '',
        unread: rec.readState === 'READSTATE_UNREAD' || rec.readState === 'READSTATE_NEW',
        protected: !!rec.protected,
        faceTag: rec.faceTag ? (rec.faceTag.name || FACE_LABEL[rec.faceTag.type] || '') : '',
        videoCached: fs.existsSync(path.join(this.cacheDir, 'videos', cacheName(rec.recordFile))),
      };
    });
    return { offset, limit, hasNext: !!body.hasNext, records };
  }

  _resolve(id, kind) {
    const p = fromId(id);
    const rec = this._known.get(p);
    if (!rec) return null; // never listed → refuse (GetFile reads anything)
    if (kind === 'thumb' && p !== rec.thumbnailFile) return null;
    if (kind === 'video' && p !== rec.recordFile) return null;
    return p;
  }

  // Returns a local file path for the thumbnail JPEG.
  async thumbnail(id) {
    const p = this._resolve(id, 'thumb');
    if (!p) { const e = new Error('unknown record'); e.code = 'NOT_FOUND'; throw e; }
    const out = path.join(this.cacheDir, 'thumbs', cacheName(p));
    if (fs.existsSync(out)) return out;
    return this._download(p, out, 16384);
  }

  // Returns a local file path for the MP4 (downloads on first access).
  async video(id) {
    const p = this._resolve(id, 'video');
    if (!p) { const e = new Error('unknown record'); e.code = 'NOT_FOUND'; throw e; }
    const out = path.join(this.cacheDir, 'videos', cacheName(p));
    if (fs.existsSync(out)) {
      const now = new Date();
      try { fs.utimesSync(out, now, now); } catch (_) {} // LRU touch
      return out;
    }
    const file = await this._download(p, out, 65536);
    this._pruneVideos(out);
    return file;
  }

  _download(remote, out, chunk) {
    if (this._inflight.has(out)) return this._inflight.get(out);
    const job = this._withSession(async (rpc) => {
      const t = Date.now();
      const buf = await rpc.getFile(remote, { chunk });
      const tmp = out + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, out);
      this.emit('log', `downloaded ${path.basename(remote)} ${buf.length}B in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      return out;
    }).finally(() => this._inflight.delete(out));
    this._inflight.set(out, job);
    return job;
  }

  _pruneVideos(keep) {
    const dir = path.join(this.cacheDir, 'videos');
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.MP4') || f.endsWith('.mp4'))
        .map(f => { const st = fs.statSync(path.join(dir, f)); return { f: path.join(dir, f), size: st.size, at: st.mtimeMs }; })
        .sort((a, b) => b.at - a.at);
    } catch (_) { return; }
    let total = 0;
    for (const x of files) {
      total += x.size;
      if (total > this.maxVideoCacheBytes && x.f !== keep) {
        try { fs.unlinkSync(x.f); } catch (_) {}
      }
    }
  }
}

module.exports = { RecordService, LiveBusyError };
