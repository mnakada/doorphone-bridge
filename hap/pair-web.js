/**
 * Pair-and-admin Web UI.
 *
 * Mounted at http://<host>:8080/ when the accessory is running. The main use
 * case is initial pairing: the user uploads a QR image, the server runs the
 * pair flow and drops cert/key into the credentials directory.
 *
 * No auth: this is intended for use on a trusted LAN during setup. Bind to
 * 127.0.0.1 or protect by firewall when deploying publicly.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { pair } = require('./pair');

function html(body) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>doorphone-hap</title>
<style>
  body { font: 14px/1.5 -apple-system, system-ui, Helvetica, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; margin-bottom: .5rem; }
  .card { border: 1px solid #ddd; border-radius: 6px; padding: 1rem; margin: 1rem 0; }
  .ok { color: #090; } .fail { color: #c00; } .muted { color: #777; }
  code { background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  pre { background: #111; color: #0f0; padding: .5rem; overflow: auto; max-height: 20rem; font-size: 12px; }
  input[type=file], input[type=text], button { font: inherit; padding: .4rem; }
  button { background: #047; color: #fff; border: none; border-radius: 4px; padding: .5rem 1rem; cursor: pointer; }
  button:hover { background: #069; }
  label { display: block; margin: .5rem 0 .25rem; }
</style>
</head><body>${body}</body></html>`;
}

async function homekitBlock({ accessory, cfg }) {
  if (!accessory || !accessory._accessoryInfo) {
    return `<div class="card"><h2>HomeKit</h2><p class="muted">Not advertised yet — service is still booting or missing credentials.</p></div>`;
  }
  let uri;
  try { uri = accessory.setupURI(); } catch (_) { return ''; }
  let svg = '';
  try {
    svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'Q', margin: 1, width: 220 });
  } catch (_) {}
  return `
    <div class="card">
      <h2>Add to Apple Home</h2>
      <p>Open the Home app → "Add Accessory" → "More options" → pick <code>${cfg.accessory.name}</code>,
         or scan this code with the Home app's camera:</p>
      <div style="display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap">
        <div>${svg}</div>
        <div>
          <p>Setup code</p>
          <p style="font-size:1.5rem;font-family:ui-monospace,monospace;letter-spacing:2px">${cfg.accessory.pincode}</p>
          <p class="muted" style="font-size:12px">URI: <code>${uri}</code></p>
        </div>
      </div>
    </div>`;
}

function statusBlock({ paired, credsDir, unit }) {
  const chips = ['cert.pem', 'privkey.pem', 'unit.json', 'kvs_creds.json'].map(f => {
    const present = fs.existsSync(path.join(credsDir, f));
    return `<span class="${present ? 'ok' : 'muted'}">${present ? 'OK' : '––'}</span> <code>${f}</code>`;
  }).join(' &nbsp; ');
  return `
    <div class="card">
      <h2>Pairing status</h2>
      <p>${paired ? '<span class="ok">Paired.</span>' : '<span class="fail">Not paired.</span>'}</p>
      <p class="muted">${chips}</p>
      ${unit ? `<p class="muted">Unit <code>${unit.unitDeviceId}</code> — paired <code>${unit.pairedAt}</code></p>` : ''}
    </div>`;
}

function pairForm() {
  return `
    <div class="card">
      <h2>Pair with the base</h2>
      <p>Press the "スマホ追加" (add device) button on the doorphone. Photograph the
      QR code and upload the JPG/PNG below — <em>or</em> paste the decoded
      <code>https://intercom.iot-webrtc.net/reg/...</code> URL directly.</p>
      <form action="/pair" method="POST" enctype="multipart/form-data">
        <label>QR image file</label>
        <input type="file" name="qr" accept="image/*">
        <label>— or — QR URL</label>
        <input type="text" name="url" placeholder="https://intercom.iot-webrtc.net/reg/..." style="width:100%">
        <label>Profile name (shown on the doorphone)</label>
        <input type="text" name="profile_name" value="Doorphone Bridge" style="width:100%">
        <p><button type="submit">Pair</button></p>
      </form>
    </div>`;
}

async function indexPage({ cfg, accessory }) {
  const credsDir = path.dirname(cfg.doorphone.credsPath);
  let unit = null;
  try { unit = JSON.parse(fs.readFileSync(path.join(credsDir, 'unit.json'), 'utf8')); }
  catch (_) {}
  const paired =
    fs.existsSync(path.join(credsDir, 'cert.pem')) &&
    fs.existsSync(path.join(credsDir, 'privkey.pem'));
  const hk = paired ? await homekitBlock({ accessory, cfg }) : '';
  return html(`
    <h1>doorphone-hap</h1>
    ${statusBlock({ paired, credsDir, unit })}
    ${hk}
    ${pairForm()}
    <p class="muted">After pairing with the doorphone, restart the service:
      <code>sudo systemctl restart doorphone-hap</code></p>
  `);
}

// Rudimentary multipart/form-data parser: just enough to pull one file + text fields.
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
    // Strip leading CRLF after boundary.
    let headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) { i = nextSep; continue; }
    const headers = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n
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

function startWebUi(opts) {
  const { cfg, host = '0.0.0.0', port = 8080, logger = console.log } = opts;
  const getAccessory = () => (typeof opts.accessory === 'function' ? opts.accessory() : opts.accessory);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(await indexPage({ cfg, accessory: getAccessory() }));
        return;
      }
      if (req.url === '/pair' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        const ctype = req.headers['content-type'] || '';
        const boundary = ctype.match(/boundary=(.+)$/)?.[1];
        if (!boundary) {
          res.writeHead(400); res.end('expected multipart/form-data'); return;
        }
        const fields = parseMultipart(body, boundary);
        let input = null;
        const tmpPath = `/tmp/_pair_upload_${crypto.randomBytes(4).toString('hex')}`;
        if (fields.qr?.data && fields.qr.filename) {
          fs.writeFileSync(tmpPath, fields.qr.data);
          input = tmpPath;
        } else if (fields.url && fields.url.startsWith('http')) {
          input = fields.url;
        } else {
          res.writeHead(400); res.end('either an image or a URL is required'); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.write(html('<h1>Pairing…</h1><pre id="log">starting…\n</pre><script>const l=document.getElementById("log");new EventSource("/pair-stream?rid=' + encodeURIComponent(res._pairRid = crypto.randomUUID()) + '").onmessage=e=>{l.textContent+=e.data+"\\n";l.scrollTop=l.scrollHeight;};</script>').replace('</body>', ''));
        // Simpler: run inline and stream logs via chunked response.
        const log = (kind, ...rest) => {
          const line = `[${kind}] ${rest.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')}`;
          res.write(`<script>document.getElementById('log').textContent+=${JSON.stringify(line + '\n')}</script>`);
          logger(line);
        };
        try {
          const profileName = fields.profile_name || 'Doorphone Bridge';
          const outDir = path.dirname(cfg.doorphone.credsPath);
          const info = await pair({ input, outDir, profileName, logger: log });
          res.write(`<h2 class="ok">Paired ✓</h2><p>Unit: <code>${info.unitDeviceId}</code></p><p><a href="/">back</a></p>`);
          res.write('<p>Restart the service: <code>sudo systemctl restart doorphone-hap</code></p>');
        } catch (e) {
          res.write(`<h2 class="fail">Failed: ${e.message || e}</h2><p><a href="/">back</a></p>`);
        } finally {
          try { if (input === tmpPath) fs.unlinkSync(tmpPath); } catch (_) {}
          res.end('</body></html>');
        }
        return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      try { res.writeHead(500); res.end(String(e.message || e)); } catch (_) {}
    }
  });
  server.listen(port, host, () => logger(`web UI http://${host}:${port}`));
  return server;
}

module.exports = { startWebUi };
