#!/usr/bin/env node
/**
 * doorphone-hap pairing.
 *
 * 1. decode QR (image file or URL)
 * 2. HMAC + GET /reg/<token> → AWS temp creds + channelName + PeerIdPrefix
 * 3. generate EC P-256 keypair + CSR
 * 4. connect to KVS WebRTC as VIEWER with ClientId = "<PeerIdPrefix>-<mobileDeviceId>"
 * 5. exchange Request_Pairing → Response_Pairing → Notify_AnswerPairing
 * 6. save cert.pem, privkey.pem, unit.json to the output directory
 *
 * CLI usage (also exported as a library):
 *   node pair.js <qr.jpg|qr.heic|url>  [--out /etc/doorphone-hap] [--profile-name "Doorphone"]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');

require('reflect-metadata'); // required by @peculiar/x509 via tsyringe
const protobuf = require('protobufjs');
const jsQR = require('jsqr');
const Jimp = require('jimp');

// Node 18+ exposes WebCrypto natively; @peculiar/x509 is ESM-only so we load
// it lazily via import().
const webcrypto = crypto.webcrypto;
const nd = require('node-datachannel');
globalThis.WebSocket = require('ws');
const { SignalingClient, Role } = require('amazon-kinesis-video-streams-webrtc');

// ---------------------------------------------------------------- constants
const REGION = 'ap-northeast-1';
const REG_HOST = 'intercom.iot-webrtc.net';
// HMAC key for /reg/<token>. Not shipped in the repo; the user extracts it
// from the Panasonic APK once (see research/extract-hmac-key.md) and drops it
// here as a single-line base64 file.
const DEFAULT_HMAC_KEY_PATH = '/etc/doorphone-hap/hmac.key';
function loadHmacKey(p) {
  const file = p || process.env.HMAC_KEY_PATH || DEFAULT_HMAC_KEY_PATH;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); }
  catch (e) {
    throw new Error(
      `HMAC key file not found: ${file}\n` +
      `  Extract it from the Panasonic APK and write the base64 value there.\n` +
      `  See research/extract-hmac-key.md for the full procedure.`);
  }
  if (!raw) throw new Error(`HMAC key file is empty: ${file}`);
  return Buffer.from(raw, 'base64');
}
// The APK builds the CSR subject by string-concatenating the fields with no
// separators, so the resulting X.500 Name has a single CN with that whole
// literal. Match it bit-for-bit.
const CSR_SUBJECT = 'CN=IoT ApplicationOU=Organizational UnitO=OrganizationC=Country';

// ---------------------------------------------------------------- proto
function loadProto() {
  const root = new protobuf.Root();
  root.resolvePath = (_origin, target) => path.join(__dirname, '..', 'proto', target);
  root.loadSync('webrtc_if.proto').resolveAll();
  return {
    WebRtcMessage: root.lookupType('webrtc_if.WebRtcMessage'),
    RequestPairing: root.lookupType('webrtc_if.pairing.Request_Pairing'),
    ResponsePairing: root.lookupType('webrtc_if.pairing.Response_Pairing'),
    NotifyAnswerPairing: root.lookupType('webrtc_if.pairing.Notify_AnswerPairing'),
  };
}

// ---------------------------------------------------------------- qr
async function decodeQr(input) {
  // Accept a URL string straight through; otherwise treat as image path.
  const trimmed = String(input).trim();
  if (trimmed.startsWith('http')) return trimmed;
  if (!fs.existsSync(trimmed)) throw new Error(`QR source not found: ${trimmed}`);
  const ext = path.extname(trimmed).toLowerCase();
  let imagePath = trimmed;
  // Jimp doesn't handle HEIC; convert via sips on macOS, or ask the user to
  // convert elsewhere (scripted on the RPi we expect JPG/PNG already).
  if (ext === '.heic' || ext === '.heif') {
    const out = `/tmp/_doorphone_qr_${process.pid}.png`;
    await new Promise((resolve, reject) => {
      const p = spawn('sips', ['-s', 'format', 'png', trimmed, '--out', out]);
      p.on('close', c => c === 0 ? resolve() : reject(new Error('sips failed; install via macOS or convert HEIC to JPG/PNG manually')));
      p.on('error', reject);
    });
    imagePath = out;
  }
  const img = await Jimp.read(imagePath);
  const tries = [1.0, 0.5, 0.3, 2.0];
  for (const scale of tries) {
    const c = img.clone().scale(scale);
    const { bitmap } = c;
    const code = jsQR(new Uint8ClampedArray(bitmap.data), bitmap.width, bitmap.height);
    if (code?.data) return code.data;
  }
  throw new Error('QR code not found in image');
}

// ---------------------------------------------------------------- /reg
function hitRegistration(url, hmacKeyPath) {
  if (!url.startsWith(`https://${REG_HOST}/reg/`)) {
    throw new Error(`Unexpected /reg URL: ${url}`);
  }
  const key = loadHmacKey(hmacKeyPath);
  const token = url.rsplit ? url.rsplit('/', 1)[1] : url.split('/').pop();
  const auth = crypto
    .createHmac('sha256', key)
    .update(token)
    .digest('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      host: REG_HOST,
      port: 443,
      path: `/reg/${token}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Dalvik/2.1.0',
        'x-auth-hash': auth,
        'Connection': 'close',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`/reg HTTP ${res.statusCode}: ${body.slice(0, 400)}`));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------- csr
async function buildCsr() {
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(webcrypto);

  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keyPair = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);

  // Match the Panasonic app's CSR subject byte-for-byte: a single CN whose
  // value is the whole blob 'IoT Application...C=Country'.
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: 'CN=IoT ApplicationOU=Organizational UnitO=OrganizationC=Country',
    keys: keyPair,
    signingAlgorithm: alg,
  });
  const csrDerBytes = Buffer.from(csr.rawData);
  const csrPem = csr.toString('pem');

  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const privPem = derToPem(Buffer.from(pkcs8), 'PRIVATE KEY');
  return { privPem, csrDerBytes, csrPem };
}

// ---------------------------------------------------------------- pairing session
async function runPairingSession({ creds, channelName, peerIdPrefix, mobileDeviceId, csrBytes, profileName, deviceToken, onEvent }) {
  const credentials = {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
  };

  const { KinesisVideoClient, GetSignalingChannelEndpointCommand, DescribeSignalingChannelCommand } = require('@aws-sdk/client-kinesis-video');
  const { KinesisVideoSignalingClient, GetIceServerConfigCommand } = require('@aws-sdk/client-kinesis-video-signaling');

  const kv = new KinesisVideoClient({ region: REGION, credentials });
  const desc = await kv.send(new DescribeSignalingChannelCommand({ ChannelName: channelName }));
  const arn = desc.ChannelInfo.ChannelARN;
  const ep = await kv.send(new GetSignalingChannelEndpointCommand({
    ChannelARN: arn,
    SingleMasterChannelEndpointConfiguration: { Protocols: ['WSS', 'HTTPS'], Role: Role.VIEWER },
  }));
  const endpoints = Object.fromEntries(ep.ResourceEndpointList.map(e => [e.Protocol, e.ResourceEndpoint]));
  const sig = new KinesisVideoSignalingClient({ region: REGION, endpoint: endpoints.HTTPS, credentials });
  const ice = await sig.send(new GetIceServerConfigCommand({ ChannelARN: arn, ClientId: 'VIEWER' }));
  const iceServers = [`stun:stun.kinesisvideo.${REGION}.amazonaws.com:443`];
  for (const s of ice.IceServerList) {
    for (const u of s.Uris) {
      iceServers.push(u.replace(/^(turn[s]?):/, `$1:${encodeURIComponent(s.Username)}:${encodeURIComponent(s.Password)}@`));
    }
  }

  const viewerId = `${peerIdPrefix}-${mobileDeviceId}`;
  onEvent?.('viewer-id', viewerId);
  const pc = new nd.PeerConnection(viewerId, { iceServers, iceTransportPolicy: 'all' });

  const { WebRtcMessage, NotifyAnswerPairing, ResponsePairing } = loadProto();

  let resolveResult;
  let rejectResult;
  const result = new Promise((res, rej) => { resolveResult = res; rejectResult = rej; });

  // Timeout the whole thing.
  const TIMEOUT_MS = 60000;
  const timeoutHandle = setTimeout(() => rejectResult(new Error('pairing timed out after 60s')), TIMEOUT_MS);

  let pairingResponseOk = false;

  pc.onStateChange(s => onEvent?.('pc-state', s));
  pc.onIceStateChange(s => onEvent?.('ice-state', s));

  pc.onDataChannel(ch => {
    onEvent?.('remote-dc', ch.getLabel?.());
    ch.onMessage(m => {
      const buf = Buffer.isBuffer(m) ? m : Buffer.from(m);
      let msg;
      try { msg = WebRtcMessage.decode(buf); }
      catch (e) { onEvent?.('dc-parse-err', e.message); return; }
      const which = WebRtcMessage.oneofs.cmd.fieldsArray.find(f => msg[f.name]);
      onEvent?.('dc-msg', which ? which.name : 'unknown', buf.toString('hex').slice(0, 120));
      if (msg.responsePairing) {
        pairingResponseOk = !!msg.responsePairing.result;
        onEvent?.('response-pairing', { result: msg.responsePairing.result, errorReason: msg.responsePairing.errorReason });
        if (!pairingResponseOk) {
          rejectResult(new Error(`Response_Pairing result=false errorReason=${msg.responsePairing.errorReason}`));
        }
      } else if (msg.notifyAnswerpairing) {
        const n = msg.notifyAnswerpairing;
        onEvent?.('notify-answerpairing', { result: n.result, reason: n.reason, unit: n.unitDeviceId });
        if (!n.result) {
          rejectResult(new Error(`Notify_AnswerPairing result=false reason=${n.reason}`));
        } else if (!n.clientCert || !n.clientCert.length) {
          rejectResult(new Error('Notify_AnswerPairing missing client_cert'));
        } else {
          clearTimeout(timeoutHandle);
          resolveResult({
            clientCertDer: Buffer.from(n.clientCert),
            unitDeviceId: n.unitDeviceId,
            autoUnlockKey: n.autoUnlockKey ? Buffer.from(n.autoUnlockKey) : null,
          });
        }
      }
    });
  });

  // Set up the offer BEFORE adding tracks / DC so onLocalDescription fires.
  let offerSdp = null;
  let onOfferReady;
  const offerReady = new Promise(resolve => { onOfferReady = resolve; });
  pc.onLocalDescription((sdp, type) => {
    if (type !== 'offer') return;
    let out = sdp;
    if (!out.includes('a=ice-options:trickle')) {
      out = out.replace(/(a=msid-semantic:[^\r\n]*\r?\n)/, `$1a=ice-options:trickle\r\n`);
    }
    offerSdp = { type, sdp: out };
    onOfferReady();
  });

  const pendingCandidates = [];
  let signalingOpen = false;
  pc.onLocalCandidate((candidate, mid) => {
    const msg = { candidate, sdpMid: mid || '0' };
    if (signalingOpen && client) {
      try { client.sendIceCandidate(msg); } catch (_) {}
    } else pendingCandidates.push(msg);
  });

  // Audio: pairing only needs the DC, but the base's offer validator rejects
  // us if we don't declare at least one media section. Keep it minimal.
  const audio = new nd.Audio('0', 'SendRecv');
  audio.addOpusCodec(96);
  audio.addAudioCodec(0, 'PCMU');
  audio.addSSRC(4115924314, 'pair-audio', 'pairStream', 'pairAudioTrack');
  pc.addTrack(audio).setMediaHandler(new nd.RtcpReceivingSession());

  const video = new nd.Video('1', 'RecvOnly');
  video.addH264Codec(101, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
  pc.addTrack(video).setMediaHandler(new nd.RtcpReceivingSession());

  // Self DC where we send Request_Pairing.
  const selfDc = pc.createDataChannel('ViewerToMaster');
  selfDc.onOpen(() => {
    onEvent?.('self-dc-open');
    // Build Request_Pairing + wrap in WebRtcMessage.
    const req = WebRtcMessage.encode({
      requestId: 1,
      version: 1,
      requestPairing: {
        csr: csrBytes,
        mobileDeviceId,
        os: 1, // OS_ANDROID
        profileName: profileName || 'Doorphone Bridge',
        profileImage: new Uint8Array(0),
        deviceToken: deviceToken || '',
      },
    }).finish();
    selfDc.sendMessageBinary(Buffer.from(req));
    onEvent?.('request-pairing-sent', Buffer.from(req).toString('hex').slice(0, 120));
  });
  selfDc.onMessage(m => {
    const buf = Buffer.isBuffer(m) ? m : Buffer.from(m);
    let msg;
    try { msg = WebRtcMessage.decode(buf); }
    catch (e) { onEvent?.('self-dc-parse-err', e.message); return; }
    onEvent?.('self-dc-msg', Object.keys(msg).filter(k => msg[k] && typeof msg[k] === 'object')[0]);
  });

  await offerReady;

  const client = new SignalingClient({
    channelARN: arn,
    channelEndpoint: endpoints.WSS,
    clientId: viewerId,
    role: Role.VIEWER,
    region: REGION,
    credentials,
    systemClockOffset: 0,
  });
  client.on('open', () => {
    signalingOpen = true;
    client.sendSdpOffer(offerSdp);
    for (const q of pendingCandidates) try { client.sendIceCandidate(q); } catch (_) {}
    pendingCandidates.length = 0;
  });
  let answered = false;
  client.on('sdpAnswer', ans => {
    if (answered) return;
    answered = true;
    try { pc.setRemoteDescription(ans.sdp, ans.type); } catch (e) { rejectResult(e); }
  });
  client.on('iceCandidate', c => {
    try { pc.addRemoteCandidate(c.candidate, c.sdpMid || '0'); } catch (_) {}
  });
  client.on('error', e => onEvent?.('signaling-err', e.toString?.() || e));

  client.open();

  try {
    return await result;
  } finally {
    try { client.close(); } catch (_) {}
    try { pc.close(); } catch (_) {}
  }
}

// ---------------------------------------------------------------- cert output
function derToPem(der, type = 'CERTIFICATE') {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${type}-----\n${b64}\n-----END ${type}-----\n`;
}

// ---------------------------------------------------------------- orchestrator
async function pair({ input, outDir, profileName, hmacKeyPath, logger = () => {} }) {
  const onEvent = (kind, ...rest) => logger(kind, ...rest);

  onEvent('decode-qr');
  const url = await decodeQr(input);
  onEvent('qr-url', url);

  onEvent('reg');
  const regInfo = await hitRegistration(url, hmacKeyPath);
  const creds = regInfo.credentials;
  onEvent('reg-ok', {
    channelName: creds.channelName,
    peerIdPrefix: creds.PeerIdPrefix,
    modelType: creds.modelType,
    expires: creds.Expiration,
  });

  onEvent('generate-csr');
  const { privPem, csrDerBytes, csrPem } = await buildCsr();

  // mobile_device_id format "SP_<uuid-v4>" per the Android app.
  const mobileDeviceId = `SP_${crypto.randomUUID()}`;
  onEvent('mobile-device-id', mobileDeviceId);

  onEvent('kvs-connect');
  const { clientCertDer, unitDeviceId, autoUnlockKey } = await runPairingSession({
    creds,
    channelName: creds.channelName,
    peerIdPrefix: creds.PeerIdPrefix,
    mobileDeviceId,
    csrBytes: csrDerBytes,
    profileName,
    deviceToken: '',
    onEvent,
  });

  onEvent('save', outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const certPem = derToPem(clientCertDer, 'CERTIFICATE');
  fs.writeFileSync(path.join(outDir, 'cert.pem'), certPem, { mode: 0o640 });
  fs.writeFileSync(path.join(outDir, 'privkey.pem'), privPem, { mode: 0o600 });
  fs.writeFileSync(path.join(outDir, 'csr.pem'), csrPem);
  const unitInfo = {
    unitDeviceId,
    channelName: creds.channelName,
    peerIdPrefix: creds.PeerIdPrefix,
    modelType: creds.modelType,
    mobileDeviceId,
    pairedAt: new Date().toISOString(),
    autoUnlockKey: autoUnlockKey ? autoUnlockKey.toString('base64') : null,
  };
  fs.writeFileSync(path.join(outDir, 'unit.json'), JSON.stringify(unitInfo, null, 2), { mode: 0o640 });
  onEvent('done', unitInfo);
  return unitInfo;
}

// ---------------------------------------------------------------- cli
async function cli(argv) {
  const args = { out: '/etc/doorphone-hap', profileName: 'Doorphone Bridge', hmacKeyPath: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--profile-name') args.profileName = argv[++i];
    else if (a === '--hmac-key') args.hmacKeyPath = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('Usage: pair <qr.jpg|qr.heic|url> [--out /etc/doorphone-hap] [--profile-name "Name"] [--hmac-key /path/to/hmac.key]');
      process.exit(0);
    } else positional.push(a);
  }
  if (!positional[0]) {
    console.error('error: provide a QR image path or /reg URL');
    process.exit(2);
  }
  const start = Date.now();
  const logger = (kind, ...rest) => console.log(`[${((Date.now() - start) / 1000).toFixed(1)}s] ${kind}`, ...rest);
  try {
    await pair({ input: positional[0], outDir: args.out, profileName: args.profileName, hmacKeyPath: args.hmacKeyPath, logger });
    console.log('\nPAIRED.');
    console.log(`  cert:    ${args.out}/cert.pem`);
    console.log(`  key:     ${args.out}/privkey.pem`);
    console.log(`  unit:    ${args.out}/unit.json`);
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED:', e.message || e);
    process.exit(1);
  }
}

if (require.main === module) {
  cli(process.argv.slice(2));
} else {
  module.exports = { pair, decodeQr, hitRegistration, buildCsr };
}
