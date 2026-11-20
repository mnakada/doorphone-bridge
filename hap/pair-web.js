/**
 * Pair-and-admin Web UI (Vue 3 SPA).
 *
 * Serves hap/web/ as a static SPA and exposes a small JSON/stream API:
 *   GET /api/state     -> current pairing / HomeKit registration state
 *   POST /api/pair     -> multipart upload, streams pair logs back as text/plain
 *
 * No auth: intended for a trusted LAN during setup. Bind to 127.0.0.1 or
 * firewall-protect when deployed publicly.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const QRCode = require('qrcode');
const { pair } = require('./pair');

const WEB_DIR = path.join(__dirname, 'web');
let VUE_PATH = '';
let SFC_LOADER_PATH = '';
try { VUE_PATH = require.resolve('vue/dist/vue.runtime.global.prod.js'); } catch (_) {}
try { SFC_LOADER_PATH = require.resolve('vue3-sfc-loader/dist/vue3-sfc-loader.js'); } catch (_) {}
// Served to the browser so QR images are decoded client-side (decoding a
// 12MP phone photo with Jimp on the RPi takes ~50s).
let JSQR_PATH = '';
try { JSQR_PATH = require.resolve('jsqr/dist/jsQR.js'); } catch (_) {}
let PKG_VERSION = '0.0.0';
try { PKG_VERSION = require('./package.json').version; } catch (_) {}

// Shared bus: anything that affects the web-visible state (HAP pair/unpair,
// cert file changes, base-station revocation) calls notifyStateChanged, and
// SSE subscribers push a fresh state to connected browsers immediately.
const stateBus = new EventEmitter();
stateBus.setMaxListeners(100);

function notifyStateChanged(reason) {
  stateBus.emit('change', { reason: reason || 'unspecified', at: new Date().toISOString() });
}

function isHkRegistered(accessory) {
  try {
    const paired = accessory?._accessoryInfo?.pairedClients;
    if (!paired) return false;
    if (paired instanceof Map) return paired.size > 0;
    return Object.keys(paired).length > 0;
  } catch (_) {
    return false;
  }
}

async function getState({ cfg, accessory }) {
  const credsDir = path.dirname(cfg.doorphone.credsPath);
  let unit = null;
  try {
    unit = JSON.parse(fs.readFileSync(path.join(credsDir, 'unit.json'), 'utf8'));
  } catch (_) {}
  const files = {};
  for (const f of ['cert.pem', 'privkey.pem', 'unit.json', 'kvs_creds.json']) {
    files[f] = fs.existsSync(path.join(credsDir, f));
  }
  const paired = !!(files['cert.pem'] && files['privkey.pem']);

  let setupUri = '';
  let setupQrSvg = '';
  if (accessory && accessory._accessoryInfo) {
    try { setupUri = accessory.setupURI(); } catch (_) {}
    if (setupUri) {
      try {
        setupQrSvg = await QRCode.toString(setupUri, {
          type: 'svg', errorCorrectionLevel: 'Q', margin: 1, width: 220,
        });
      } catch (_) {}
    }
  }

  return {
    appName: 'Doorphone Bridge',
    version: PKG_VERSION,
    paired,
    hkConnected: isHkRegistered(accessory),
    accessoryName: cfg.accessory.name,
    pincode: cfg.accessory.pincode,
    setupUri,
    setupQrSvg,
    files,
    unit,
  };
}

const STATIC_MAP = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/App.vue': { file: 'App.vue', type: 'text/plain; charset=utf-8' },
  '/Records.vue': { file: 'Records.vue', type: 'text/plain; charset=utf-8' },
};

// Serve a file honouring HTTP Range (Safari/iOS refuses to play <video>
// without 206 partial responses).
function sendFileRange(req, res, filePath, type, extraHeaders = {}) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const size = st.size;
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
      if (range[1] === '') end = size - 1;
      if (!(start >= 0 && start <= end && end < size)) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return;
      }
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ...extraHeaders,
      });
      fs.createReadStream(filePath, { start, end }).on('error', () => res.destroy()).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, ...extraHeaders });
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function recordsError(res, e) {
  if (e && e.code === 'LIVE_BUSY') return sendJson(res, 409, { error: e.message, code: 'LIVE_BUSY' });
  if (e && e.code === 'NOT_FOUND') return sendJson(res, 404, { error: '録画が見つかりません。一覧を再読み込みしてください。' });
  return sendJson(res, 502, { error: (e && e.message) || String(e) });
}

function sendFile(res, filePath, type) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

// Rudimentary multipart/form-data parser: enough to pull one file + text fields.
function parseMultipart(body, boundary) {
  const parts = {};
  const b = Buffer.from(body);
  const sep = Buffer.from(`--${boundary}`);
  let i = 0;
  while (i < b.length) {
    const start = b.indexOf(sep, i);
    if (start < 0) break;
    const partStart = start + sep.length;
    const nextSep = b.indexOf(sep, partStart);
    if (nextSep < 0) break;
    const part = b.slice(partStart, nextSep);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) { i = nextSep; continue; }
    const headers = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4, part.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]*)"/);
    if (nameMatch) {
      parts[nameMatch[1]] = filenameMatch
        ? { filename: filenameMatch[1], data: content }
        : content.toString('utf8');
    }
    i = nextSep;
  }
  return parts;
}

async function handlePair({ req, res, cfg, logger, onPaired }) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const ctype = req.headers['content-type'] || '';
  const boundary = ctype.match(/boundary=(.+)$/)?.[1];
  if (!boundary) { res.writeHead(400); res.end('expected multipart/form-data'); return; }
  const fields = parseMultipart(body, boundary);

  let input = null;
  const tmpPath = `/tmp/_pair_upload_${crypto.randomBytes(4).toString('hex')}`;
  if (fields.qr?.data && fields.qr.filename) {
    fs.writeFileSync(tmpPath, fields.qr.data);
    input = tmpPath;
  } else if (fields.url && String(fields.url).startsWith('http')) {
    input = String(fields.url);
  } else {
    res.writeHead(400); res.end('QR 画像または URL が必要です'); return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const log = (kind, ...rest) => {
    const line = `[${kind}] ${rest.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')}`;
    res.write(line + '\n');
    logger(line);
  };
  let ok = false;
  try {
    const profileName = String(fields.profile_name || 'Doorphone Bridge');
    const outDir = path.dirname(cfg.doorphone.credsPath);
    const info = await pair({ input, outDir, profileName, logger: log });
    res.write('RESULT_OK ' + JSON.stringify({ unitDeviceId: info.unitDeviceId }) + '\n');
    ok = true;
  } catch (e) {
    res.write('RESULT_FAIL ' + (e.message || String(e)) + '\n');
    logger('[pair-failed] ' + (e.message || String(e)));
  } finally {
    try { if (input === tmpPath) fs.unlinkSync(tmpPath); } catch (_) {}
    res.end();
  }
  // New cert/unit on disk — let the host restart so the refresher and the
  // WebRTC source pick them up. Done after res.end() so the browser gets
  // RESULT_OK before the server goes away.
  if (ok && typeof onPaired === 'function') {
    res.on('finish', () => onPaired());
    if (res.writableFinished) onPaired();
  }
}

function startWebUi(opts) {
  const { cfg, host = '0.0.0.0', port = 8080, logger = console.log } = opts;
  const getAccessory = () => (typeof opts.accessory === 'function' ? opts.accessory() : opts.accessory);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET') {
        const spec = STATIC_MAP[url.pathname];
        if (spec) return sendFile(res, path.join(WEB_DIR, spec.file), spec.type);
        if (url.pathname === '/vue.runtime.global.prod.js') {
          if (!VUE_PATH) { res.writeHead(500); res.end('vue not installed'); return; }
          return sendFile(res, VUE_PATH, 'application/javascript; charset=utf-8');
        }
        if (url.pathname === '/vue3-sfc-loader.js') {
          if (!SFC_LOADER_PATH) { res.writeHead(500); res.end('vue3-sfc-loader not installed'); return; }
          return sendFile(res, SFC_LOADER_PATH, 'application/javascript; charset=utf-8');
        }
        if (url.pathname === '/jsqr.js') {
          if (!JSQR_PATH) { res.writeHead(500); res.end('jsqr not installed'); return; }
          return sendFile(res, JSQR_PATH, 'application/javascript; charset=utf-8');
        }
        // ---- recordings (親機の録画一覧) ----
        const records = typeof opts.records === 'function' ? opts.records() : opts.records;
        if (url.pathname === '/api/records') {
          if (!records) return sendJson(res, 503, { error: 'ペアリング後に利用できます' });
          const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
          const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
          try { return sendJson(res, 200, await records.list(offset, limit)); }
          catch (e) { return recordsError(res, e); }
        }
        let m;
        if ((m = /^\/api\/records\/(thumb|video)\/([A-Za-z0-9_-]+)$/.exec(url.pathname))) {
          if (!records) return sendJson(res, 503, { error: 'ペアリング後に利用できます' });
          try {
            if (m[1] === 'thumb') {
              const f = await records.thumbnail(m[2]);
              return sendFileRange(req, res, f, 'image/jpeg', { 'Cache-Control': 'private, max-age=86400' });
            }
            const f = await records.video(m[2]);
            return sendFileRange(req, res, f, 'video/mp4', { 'Cache-Control': 'private, max-age=86400' });
          } catch (e) { return recordsError(res, e); }
        }

        if (url.pathname === '/api/state') {
          try { opts.onStateQuery?.(); } catch (_) {}
          const s = await getState({ cfg, accessory: getAccessory() });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(JSON.stringify(s));
        }
        if (url.pathname === '/api/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const send = async (reason) => {
            try {
              const s = await getState({ cfg, accessory: getAccessory() });
              res.write(`event: state\ndata: ${JSON.stringify({ ...s, _reason: reason })}\n\n`);
            } catch (_) {}
          };
          const onChange = (info) => send(info.reason);
          stateBus.on('change', onChange);
          // Someone is looking: ask the base whether we're still registered
          // so an unpair shows up within seconds (result arrives via the bus).
          try { opts.onStateQuery?.(); } catch (_) {}
          send('init');
          const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 20_000);
          req.on('close', () => { stateBus.off('change', onChange); clearInterval(hb); });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        return handlePair({ req, res, cfg, logger, onPaired: opts.onPaired });
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      try { res.writeHead(500); res.end(String(e.message || e)); } catch (_) {}
    }
  });

  server.listen(port, host, () => logger(`web UI http://${host}:${port}`));
  return server;
}

module.exports = { startWebUi, notifyStateChanged };
