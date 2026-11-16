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
const { startWebUi } = require('./pair-web');
const { CredsRefresher } = require('./creds-refresher');

const { cfg, configPath } = loadConfig();
console.log('[config] loaded from', configPath);

ensureDir(cfg.storage.persistPath);
ensureDir(path.dirname(cfg.storage.sdpPath));

// Reference held so the Web UI can call accessory.setupURI() once published.
const webUiState = { accessory: null };
if (cfg.web.enabled) {
  startWebUi({
    cfg,
    get accessory() { return webUiState.accessory; },
    host: cfg.web.host,
    port: cfg.web.port,
    logger: (...a) => console.log('[web]', ...a),
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
  credsReady = new Promise(resolve => refresher.once('creds', resolve));
  refresher.start().catch(e => console.error('[creds] start failed:', e.message || e));
  process.on('SIGINT', () => refresher.stop());
  process.on('SIGTERM', () => refresher.stop());
} else {
  console.log('[creds] cert/key/unit.json missing — relying on pre-existing kvs_creds.json');
  credsReady = Promise.resolve();
}

// --- Doorphone live source ---
writeSdpFile(cfg.storage.sdpPath, {
  videoPort: cfg.doorphone.videoPort,
  audioPort: cfg.doorphone.audioPort,
});
const source = new DoorphoneSource({
  credsPath: cfg.doorphone.credsPath,
  videoPort: cfg.doorphone.videoPort,
  audioPort: cfg.doorphone.audioPort,
});
source.on('state', s => console.log('[source] pc state:', s));
source.on('video-ready', () => console.log('[source] first video RTP received'));
source.on('error', e => console.error('[source] error:', e.message || e));
source.on('remote-dc', (label, id) => console.log('[source] remote DC opened label=', label, 'id=', id));
source.on('request-connect-sent', () => console.log('[source] Request_Connect sent on remote DC'));
source.on('dc-message', (b) => console.log('[source] dc msg hex=', b.toString('hex').slice(0, 80)));

credsReady
  .then(() => source.start())
  .catch(e => {
    console.error('[source] start failed:', e.message || e);
    console.error('Hint: ensure', cfg.doorphone.credsPath, 'exists and the creds are not expired.');
  });

setInterval(() => {
  const s = source.getStats();
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
      { type: hap.AudioStreamingCodecType.OPUS, samplerate: hap.AudioStreamingSamplerate.KHZ_24 },
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

console.log('================================================');
console.log('Doorphone bridge running.');
console.log(`Setup pincode: ${cfg.accessory.pincode}`);
console.log(`Name         : ${cfg.accessory.name}`);
console.log(`HAP port     : ${cfg.accessory.port}`);
console.log('================================================');

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function shutdown() {
  console.log('\nShutting down...');
  try { source.stop(); } catch (_) {}
  try { accessory.unpublish(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}

} // bootAccessory
