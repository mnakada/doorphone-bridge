#!/usr/bin/env node
/**
 * Doorphone -> HomeKit bridge (Doorbell + Camera accessory).
 * Keeps a persistent WebRTC session to the VL-X70AH base and re-packages its
 * H264 RTP into the HomeKit SRTP stream on demand.
 */
const path = require('path');
const fs = require('fs');
const hap = require('hap-nodejs');
const { DoorphoneSource, writeSdpFile } = require('./doorphone-source');
const { StreamingDelegate } = require('./streaming');
const { load: loadConfig, ensureDir } = require('./config');
const { startWebUi, notifyStateChanged } = require('./pair-web');
const { CredsRefresher } = require('./creds-refresher');
const { RecordService } = require('./records');

const { cfg, configPath } = loadConfig();
console.log('[config] loaded from', configPath);

ensureDir(cfg.storage.persistPath);
ensureDir(path.dirname(cfg.storage.sdpPath));

// Reference held so the Web UI can call accessory.setupURI() once published.
const webUiState = { accessory: null, records: null };

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
    records: () => webUiState.records,
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

// --- Doorphone live source ---
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
const source = new DoorphoneSource({
  credsPath: cfg.doorphone.credsPath,
  videoPort: cfg.doorphone.videoPort,
  audioPort: cfg.doorphone.audioPort,
  viewerId,
  // The base serves one session at a time; live view (HomeKit) wins.
  beforeStart: () => records.suspend(),
});
source.on('state', s => console.log('[source] pc state:', s));
source.on('video-ready', () => console.log('[source] first video RTP received'));
source.on('error', e => console.error('[source] error:', e.message || e));
source.on('log', m => console.log('[source]', m));

// --- Recordings browser (Web UI 録画一覧) ---
const records = new RecordService({
  credsPath: cfg.doorphone.credsPath,
  unitInfoPath: cfg.doorphone.unitInfoPath,
  cacheDir: path.join(path.dirname(cfg.storage.persistPath), 'records'),
  isLiveActive: () => source.hasLiveUsers(),
  beforeConnect: () => source.yieldIfUnused(),
  ffmpegPath: cfg.ffmpeg.path,
});
records.on('log', m => console.log('[records]', m));
webUiState.records = records;
shutdownHooks.push(() => records.suspend());

// No connection at boot: holding a session makes the base show "スマホで使用中"
// and locks its own monitor. StreamingDelegate acquires the source while a
// HomeKit stream runs and releases it afterwards (see DoorphoneSource.acquire).
credsReady.then(() => console.log('[source] ready (connects on demand)'));

setInterval(() => {
  const s = source.getStats();
  if (s.state === 'idle') return;
  console.log(`[source] state=${s.state} videoPkts=${s.videoPkts} audioPkts=${s.audioPkts}`);
}, 15000);

// --- Accessory ---
const uuid = hap.uuid.generate('doorphone.vl-x70ah.' + cfg.accessory.username);
const accessory = new hap.Accessory(cfg.accessory.name, uuid);

accessory
  .getService(hap.Service.AccessoryInformation)
  .setCharacteristic(hap.Characteristic.Manufacturer, 'Panasonic (RE)')
  .setCharacteristic(hap.Characteristic.Model, 'VL-X70AH-bridge')
  .setCharacteristic(hap.Characteristic.SerialNumber, cfg.accessory.username)
  .setCharacteristic(hap.Characteristic.FirmwareRevision, '0.0.1');

// Doorbell service intentionally omitted — exposed as a plain IP camera.

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

const delegate = new StreamingDelegate({
  name: cfg.accessory.name,
  ffmpegPath: cfg.ffmpeg.path,
  source,
  snapshotPath: path.join(path.dirname(cfg.storage.sdpPath), 'snapshot.jpg'),
});

const cameraController = new hap.CameraController({
  cameraStreamCount: 1,
  delegate,
  streamingOptions,
});
delegate.controller = cameraController;

accessory.configureController(cameraController);

accessory.publish({
  username: cfg.accessory.username,
  pincode: cfg.accessory.pincode,
  port: cfg.accessory.port,
  category: hap.Categories.IP_CAMERA,
});
webUiState.accessory = accessory;

// Push live state changes into the Web UI (no polling needed on the browser).
accessory.on('paired', () => { console.log('[hap] client paired'); notifyStateChanged('hap-paired'); });
accessory.on('unpaired', () => { console.log('[hap] client unpaired'); notifyStateChanged('hap-unpaired'); });
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

shutdownHooks.push(() => source.stop());
shutdownHooks.push(() => accessory.unpublish());

} // bootAccessory

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('\nShutting down...');
  runShutdownHooks();
  setTimeout(() => process.exit(0), 500);
}
