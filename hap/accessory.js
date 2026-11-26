#!/usr/bin/env node
/**
 * Doorphone -> HomeKit bridge (Doorbell + Camera accessory).
 * Keeps a persistent WebRTC session to the VL-X70AH base and re-packages its
 * H264 RTP into the HomeKit SRTP stream on demand.
 */
const path = require('path');
const fs = require('fs');
const hap = require('hap-nodejs');
const { DoorphoneSource, writeSdpFile, DEVICE_DOOR, DEVICE_CAMERA } = require('./doorphone-source');
const { StreamingDelegate } = require('./streaming');
const { load: loadConfig, ensureDir } = require('./config');
const { startWebUi, notifyStateChanged } = require('./pair-web');
const { CredsRefresher } = require('./creds-refresher');
const { RecordService } = require('./records');
const { NasSync } = require('./nas-sync');

const { cfg, configPath } = loadConfig();
console.log('[config] loaded from', configPath);

ensureDir(cfg.storage.persistPath);
ensureDir(path.dirname(cfg.storage.sdpPath));

// Reference held so the Web UI can call accessory.setupURI() once published.
const webUiState = { accessory: null, accessories: [], records: null, nas: null };

// Set by bootAccessory() once the creds refresher exists; the Web UI calls it
// so a base-side unpair is detected as soon as someone opens the page.
let checkRegistration = null;

// Cleanup steps registered by bootAccessory(); run before any exit.
const shutdownHooks = [];
function runShutdownHooks() {
  for (const fn of shutdownHooks.splice(0)) { try { fn(); } catch (_) {} }
}

// Exit code that the systemd unit maps to a forced restart
// (RestartForceExitStatus=75, EX_TEMPFAIL) — used after a successful re-pair
// so the refresher and the WebRTC source boot with the new cert.
const EXIT_RESTART = 75;
let restarting = false;
function restartAfterPairing() {
  if (restarting) return;
  restarting = true;
  console.log(`[boot] pairing succeeded — restarting to load new credentials (exit ${EXIT_RESTART})`);
  setTimeout(() => {
    runShutdownHooks();
    setTimeout(() => process.exit(EXIT_RESTART), 500);
  }, 1000);
}

if (cfg.web.enabled) {
  startWebUi({
    cfg,
    get accessory() { return webUiState.accessory; },
    accessories: () => webUiState.accessories,
    records: () => webUiState.records,
    nas: () => webUiState.nas,
    host: cfg.web.host,
    port: cfg.web.port,
    logger: (...a) => console.log('[web]', ...a),
    onPaired: restartAfterPairing,
    onStateQuery: () => checkRegistration?.(),
  });
}

// Without credentials we can't bring the source up; keep the Web UI alive so
// the user can pair, and bail out of the camera-side setup.
const certPath = path.join(path.dirname(cfg.doorphone.credsPath), 'cert.pem');
const hasCredsOrCert = fs.existsSync(cfg.doorphone.credsPath) || fs.existsSync(certPath);
if (!hasCredsOrCert) {
  console.log('[boot] no credentials yet — serving web UI only.');
  console.log(`[boot]   open http://<host>:${cfg.web.port}/ to pair.`);
} else {
  bootAccessory();
}

function bootAccessory() {

hap.HAPStorage.setCustomStoragePath(cfg.storage.persistPath);

// --- Credentials refresher (MQTT over mTLS) ---
let credsReady;
if (fs.existsSync(cfg.doorphone.unitInfoPath) &&
    fs.existsSync(cfg.doorphone.certPath) &&
    fs.existsSync(cfg.doorphone.keyPath)) {
  const refresher = new CredsRefresher({
    unitInfoPath: cfg.doorphone.unitInfoPath,
    certPath: cfg.doorphone.certPath,
    keyPath: cfg.doorphone.keyPath,
    credsPath: cfg.doorphone.credsPath,
  });
  refresher.on('log', msg => console.log('[creds]', msg));
  refresher.on('error', e => console.error('[creds] error:', e.message || e));
  refresher.on('revoked', () => {
    // Base station no longer answers — move the paired cert aside so the Web
    // UI drops back to "unpaired" and the user can re-pair without hand-
    // editing /etc/doorphone-hap. kvs_creds.json goes too: it's useless once
    // the cert is dead, and leaving it makes the next boot try (and fail)
    // to start the source with expired tokens.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    for (const p of [cfg.doorphone.certPath, cfg.doorphone.keyPath, cfg.doorphone.credsPath]) {
      try {
        if (fs.existsSync(p)) {
          const dst = `${p}.revoked.${ts}`;
          fs.renameSync(p, dst);
          console.log('[creds] revoked:', p, '→', dst);
        }
      } catch (e) { console.error('[creds] revoke cleanup:', e.message || e); }
    }
    notifyStateChanged('base-revoked');
  });
  credsReady = new Promise(resolve => refresher.once('creds', resolve));
  refresher.start().catch(e => console.error('[creds] start failed:', e.message || e));
  shutdownHooks.push(() => refresher.stop());
  checkRegistration = () => refresher.checkNow();
} else {
  console.log('[creds] cert/key/unit.json missing — relying on pre-existing kvs_creds.json');
  credsReady = Promise.resolve();
}

// --- Doorphone live sources: one per camera on the base ---
writeSdpFile(cfg.storage.sdpPath, {
  videoPort: cfg.doorphone.videoPort,
  audioPort: cfg.doorphone.audioPort,
});
// The base only serves the viewer whose KVS clientId matches the
// mobile_device_id registered at pairing (unit.json). Without it we'd fall
// back to DoorphoneSource's legacy default (the original AVD app's id),
// which a fresh pairing does not recognise — connected, but zero video.
let viewerId;
try {
  viewerId = JSON.parse(fs.readFileSync(cfg.doorphone.unitInfoPath, 'utf8')).mobileDeviceId || undefined;
} catch (_) {}
console.log('[source] viewer id:', viewerId || '(legacy default)');

// key -> { dev, source, accessory }
const cameras = new Map();
const allSources = () => [...cameras.values()].map(c => c.source);

function makeSource(dev) {
  const tag = `[source ${dev.key}]`;
  const source = new DoorphoneSource({
    credsPath: cfg.doorphone.credsPath,
    videoPort: cfg.doorphone.videoPort,
    audioPort: cfg.doorphone.audioPort,
    viewerId,
    device: dev.device,
    devno: dev.devno,
    // The base serves one session per viewer id at a time: the record
    // browser and any other camera's live view give way to this one.
    beforeStart: async () => {
      await records.suspend();
      await Promise.all(allSources().filter(s => s !== source).map(s => s.preempt()));
    },
  });
  source.on('state', s => console.log(tag, 'pc state:', s));
  source.on('video-ready', () => console.log(tag, 'first video RTP received'));
  source.on('error', e => console.error(tag, 'error:', e.message || e));
  source.on('log', m => console.log(tag, m));
  return source;
}

// --- Recordings browser (Web UI 録画一覧) ---
const records = new RecordService({
  credsPath: cfg.doorphone.credsPath,
  unitInfoPath: cfg.doorphone.unitInfoPath,
  cacheDir: path.join(path.dirname(cfg.storage.persistPath), 'records'),
  isLiveActive: () => allSources().some(s => s.hasLiveUsers()),
  beforeConnect: () => Promise.all(allSources().map(s => s.yieldIfUnused())),
  ffmpegPath: cfg.ffmpeg.path,
});
records.on('log', m => console.log('[records]', m));
webUiState.records = records;
shutdownHooks.push(() => records.suspend());

// --- NAS sync (copy base recordings to a CIFS share) ---
const nas = new NasSync({
  records,
  configPath: cfg.storage.nasConfigPath,
  stateDir: path.join(path.dirname(cfg.storage.persistPath), 'records'),
  logger: m => console.log('[nas]', m),
});
webUiState.nas = nas;
nas.start();
shutdownHooks.push(() => nas.stop());

// No connection at boot: holding a session makes the base show "スマホで使用中"
// and locks its own monitor. StreamingDelegate acquires a source while a
// HomeKit stream runs and releases it afterwards (see DoorphoneSource.acquire).
credsReady.then(() => console.log('[source] ready (connects on demand)'));

setInterval(() => {
  for (const [key, { source }] of cameras) {
    const s = source.getStats();
    if (s.state === 'idle') continue;
    console.log(`[source ${key}] state=${s.state} videoPkts=${s.videoPkts} audioPkts=${s.audioPkts}`);
  }
}, 15000);

// --- Accessories: one HomeKit camera per door station / extra camera ---
const streamingOptions = {
  supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
  video: {
    codec: {
      profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
      levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
    },
    resolutions: [
      [1280, 720, 30],
      [1024, 768, 30],
      [640, 480, 30],
      [640, 360, 30],
      [480, 360, 30],
      [480, 270, 30],
      [320, 240, 30],
      [320, 180, 30],
    ],
  },
  audio: {
    codecs: [
      { type: hap.AudioStreamingCodecType.OPUS, samplerate: hap.AudioStreamingSamplerate.KHZ_16 },
    ],
  },
};

// The first door station keeps the configured name / MAC / port so the
// accessory already added to Apple Home stays as it is. Other devices get
// their own HAP identity derived from it: MAC and port + offset
// (door n → n, camera n → 0x10 + n).
function hapIdentity(dev) {
  if (dev.key === 'door0') {
    return { name: cfg.accessory.name, username: cfg.accessory.username, port: cfg.accessory.port };
  }
  const offset = dev.device === DEVICE_DOOR ? dev.devno : 0x10 + dev.devno;
  const mac = parseInt(cfg.accessory.username.replace(/:/g, ''), 16) + offset;
  const username = mac.toString(16).toUpperCase().padStart(12, '0').match(/../g).join(':');
  return { name: hapName(dev.name) || dev.key, username, port: cfg.accessory.port + offset };
}

// HomeKit names: letters / digits / space / apostrophe, starting and ending
// with a letter or digit ("電気錠1(玄関)" → "電気錠1 玄関").
function hapName(s) {
  return String(s || '')
    .replace(/[^\p{L}\p{N}’ '.,-]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}’]+$/gu, '')
    .replace(/\s+/g, ' ');
}

function publishCamera(dev) {
  if (cameras.has(dev.key)) return;
  const id = hapIdentity(dev);
  const source = makeSource(dev);

  const uuid = hap.uuid.generate('doorphone.vl-x70ah.' + id.username);
  const accessory = new hap.Accessory(id.name, uuid);
  accessory
    .getService(hap.Service.AccessoryInformation)
    .setCharacteristic(hap.Characteristic.Manufacturer, 'Panasonic (RE)')
    .setCharacteristic(hap.Characteristic.Model, dev.device === DEVICE_DOOR ? 'VL-X70AH-bridge' : 'VL-X70AH-bridge camera')
    .setCharacteristic(hap.Characteristic.SerialNumber, id.username)
    .setCharacteristic(hap.Characteristic.FirmwareRevision, '0.0.1');

  // Doorbell service intentionally omitted — exposed as a plain IP camera.

  const delegate = new StreamingDelegate({
    name: id.name,
    ffmpegPath: cfg.ffmpeg.path,
    source,
    snapshotPath: path.join(path.dirname(cfg.storage.sdpPath), `snapshot-${dev.key}.jpg`),
  });
  const cameraController = new hap.CameraController({
    cameraStreamCount: 1,
    delegate,
    streamingOptions,
  });
  delegate.controller = cameraController;
  accessory.configureController(cameraController);

  accessory.publish({
    username: id.username,
    pincode: cfg.accessory.pincode,
    port: id.port,
    category: hap.Categories.IP_CAMERA,
  });

  // Push live state changes into the Web UI (no polling needed on the browser).
  accessory.on('paired', () => { console.log(`[hap ${dev.key}] client paired`); notifyStateChanged('hap-paired'); });
  accessory.on('unpaired', () => { console.log(`[hap ${dev.key}] client unpaired`); notifyStateChanged('hap-unpaired'); });

  cameras.set(dev.key, { dev, source, accessory });
  webUiState.accessories = [...cameras.values()].map(c => ({ key: c.dev.key, accessory: c.accessory }));
  if (dev.key === 'door0') webUiState.accessory = accessory;
  shutdownHooks.push(() => source.stop());
  shutdownHooks.push(() => accessory.unpublish());
  console.log(`[hap ${dev.key}] published "${id.name}" (${dev.device === DEVICE_DOOR ? 'door' : 'camera'} ${dev.devno}) ` +
    `username=${id.username} port=${id.port}`);
  notifyStateChanged('hap-published');
}

// Cameras registered on the base come from GetState (door.doors /
// camera.cameras, index = devno). The list is cached so the accessories
// come up at boot even while the base can't be reached.
const DOOR0 = { key: 'door0', device: DEVICE_DOOR, devno: 0, name: '玄関子機1' };
const devicesPath = path.join(path.dirname(cfg.storage.persistPath), 'devices.json');
function loadDevices() {
  try {
    const list = JSON.parse(fs.readFileSync(devicesPath, 'utf8'));
    if (Array.isArray(list)) return list;
  } catch (_) {}
  return null;
}

function devicesFromState(state) {
  const out = [];
  (state.door?.doors || []).forEach((d, i) => {
    if (d.enable) out.push({ key: `door${i}`, device: DEVICE_DOOR, devno: i, name: d.name || `玄関子機${i + 1}` });
  });
  (state.camera?.cameras || []).forEach((c, i) => {
    if (c.enable) out.push({ key: `camera${i}`, device: DEVICE_CAMERA, devno: i, name: c.name || `カメラ${i + 1}` });
  });
  // The first door station is the original accessory: always keep it.
  if (!out.some(d => d.key === 'door0')) out.unshift(DOOR0);
  return out;
}

async function discoverDevices() {
  const state = await records.unitState();
  const list = devicesFromState(state);
  console.log('[devices] on base:', list.map(d => `${d.key}=${d.name}`).join(', '));
  try { fs.writeFileSync(devicesPath, JSON.stringify(list, null, 2)); } catch (e) {
    console.error('[devices] cache write failed:', e.message || e);
  }
  for (const dev of list) publishCamera(dev);
  for (const key of cameras.keys()) {
    if (!list.some(d => d.key === key)) console.log(`[devices] ${key} is no longer on the base (dropped at next restart)`);
  }
}

for (const dev of loadDevices() || [DOOR0]) publishCamera(dev);
credsReady.then(function tryDiscover() {
  discoverDevices().catch(e => {
    console.error('[devices] discovery failed, retrying in 5 min:', e.message || e);
    setTimeout(tryDiscover, 5 * 60 * 1000).unref?.();
  });
});

try {
  const credsDir = path.dirname(cfg.doorphone.credsPath);
  const watched = new Set(['cert.pem', 'privkey.pem', 'unit.json', 'kvs_creds.json']);
  fs.watch(credsDir, { persistent: false }, (_ev, name) => {
    if (watched.has(name)) notifyStateChanged('file:' + name);
  });
} catch (e) { console.error('[hap] fs.watch creds dir failed:', e.message || e); }

console.log('================================================');
console.log('Doorphone bridge running.');
console.log(`Setup pincode: ${cfg.accessory.pincode}`);
console.log(`Name         : ${cfg.accessory.name}`);
console.log(`HAP port     : ${cfg.accessory.port}`);
console.log('================================================');

} // bootAccessory

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('\nShutting down...');
  runShutdownHooks();
  setTimeout(() => process.exit(0), 500);
}
