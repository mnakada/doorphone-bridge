/**
 * Config loader.
 *
 * Reads a JSON config file whose path is given by the CONFIG_PATH env var
 * (defaults to ./config.json alongside the entry point). Environment variables
 * override individual fields for quick overrides without editing the file.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  accessory: {
    name: 'Doorphone',
    username: 'DC:D0:0F:00:00:01',
    pincode: '031-45-154',
    port: 47129,
  },
  doorphone: {
    credsPath: '/etc/doorphone-hap/kvs_creds.json',
    certPath: '/etc/doorphone-hap/cert.pem',
    keyPath: '/etc/doorphone-hap/privkey.pem',
    unitInfoPath: '/etc/doorphone-hap/unit.json',
    videoPort: 5004,
    audioPort: 5006,
  },
  ffmpeg: {
    path: 'ffmpeg',
  },
  storage: {
    persistPath: '/var/lib/doorphone-hap/persist',
    sdpPath: '/run/doorphone-hap/doorphone.sdp',
  },
  web: {
    enabled: true,
    host: '0.0.0.0',
    port: 8080,
  },
};

function deepMerge(a, b) {
  if (!b || typeof b !== 'object') return a;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
      out[k] = deepMerge(a?.[k] ?? {}, b[k]);
    } else {
      out[k] = b[k];
    }
  }
  return out;
}

function load() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
  let fileCfg = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8').trim();
      if (raw.length > 0) fileCfg = JSON.parse(raw);
    } catch (e) {
      console.error(`[config] failed to parse ${configPath}: ${e.message}`);
      process.exit(1);
    }
  }
  const cfg = deepMerge(DEFAULTS, fileCfg);
  // Env overrides for common tweaks.
  if (process.env.ACC_NAME) cfg.accessory.name = process.env.ACC_NAME;
  if (process.env.ACC_MAC) cfg.accessory.username = process.env.ACC_MAC;
  if (process.env.ACC_PIN) cfg.accessory.pincode = process.env.ACC_PIN;
  if (process.env.ACC_PORT) cfg.accessory.port = parseInt(process.env.ACC_PORT, 10);
  if (process.env.CREDS_PATH) cfg.doorphone.credsPath = process.env.CREDS_PATH;
  if (process.env.DP_VIDEO_PORT) cfg.doorphone.videoPort = parseInt(process.env.DP_VIDEO_PORT, 10);
  if (process.env.DP_AUDIO_PORT) cfg.doorphone.audioPort = parseInt(process.env.DP_AUDIO_PORT, 10);
  if (process.env.FFMPEG) cfg.ffmpeg.path = process.env.FFMPEG;
  if (process.env.PERSIST_PATH) cfg.storage.persistPath = process.env.PERSIST_PATH;
  if (process.env.SDP_PATH) cfg.storage.sdpPath = process.env.SDP_PATH;
  if (process.env.WEB_HOST) cfg.web.host = process.env.WEB_HOST;
  if (process.env.WEB_PORT) cfg.web.port = parseInt(process.env.WEB_PORT, 10);
  if (process.env.WEB_DISABLED === '1') cfg.web.enabled = false;
  return { cfg, configPath };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

module.exports = { load, ensureDir };
