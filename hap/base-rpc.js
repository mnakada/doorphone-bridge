/**
 * BaseRpc: a control-only WebRTC session to the VL-X70AH base for
 * request/response commands over the DataChannel (record list, file
 * download, record playback control, ...).
 *
 * Unlike DoorphoneSource it does NOT send Request_Connect (monitor), so the
 * base doesn't start streaming live video just because we connected.
 *
 * Messages are webrtc_if.WebRtcMessage (proto/gen, extracted from the app).
 * Replies carry the request_id of the request they answer.
 *
 * Base quirks this relies on (see memory: node-pairing-verified):
 *  - the base never ACKs our DCEP OPEN, so our own DC never reports "open";
 *    data on it is delivered anyway once SCTP is up (= when the base opens
 *    its "MasterToViewer" channel).
 *  - the KVS clientId must be the mobile_device_id registered at pairing.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const protobuf = require('protobufjs');
const {
  KinesisVideoClient,
  GetSignalingChannelEndpointCommand,
  DescribeSignalingChannelCommand,
} = require('@aws-sdk/client-kinesis-video');
const {
  KinesisVideoSignalingClient,
  GetIceServerConfigCommand,
} = require('@aws-sdk/client-kinesis-video-signaling');
const { SignalingClient, Role } = require('amazon-kinesis-video-streams-webrtc');
const nd = require('node-datachannel');
globalThis.WebSocket = globalThis.WebSocket || require('ws');

const REGION = 'ap-northeast-1';

function defaultProtoDir() {
  // Installed: /opt/doorphone-bridge/base-rpc.js + /opt/proto/gen
  // Repo:      hap/base-rpc.js + proto/gen
  return path.join(__dirname, '..', 'proto', 'gen');
}

let _types = null;
function loadTypes(protoDir = defaultProtoDir()) {
  if (_types) return _types;
  const root = new protobuf.Root();
  // google/protobuf/* (timestamp, wrappers) come from protobufjs' bundled
  // common definitions; everything else from protoDir.
  root.resolvePath = (_origin, target) => (target.startsWith('google/') ? target : path.join(protoDir, target));
  root.loadSync('webrtc_if.proto').resolveAll();
  _types = { root, WebRtcMessage: root.lookupType('webrtc_if.WebRtcMessage') };
  return _types;
}

class BaseRpc extends EventEmitter {
  constructor({ credsPath, viewerId, protoDir, connectTimeoutMs = 20000 }) {
    super();
    this.credsPath = credsPath;
    this.viewerId = viewerId;
    this.connectTimeoutMs = connectTimeoutMs;
    this.types = loadTypes(protoDir);
    this.pc = null;
    this.client = null;
    this.selfDc = null;
    this.remoteDc = null;
    this.state = 'idle'; // idle | connecting | ready | closed
    this._nextId = 100;
    this._pending = new Map(); // request_id -> { resolve, reject, timer, expect }
  }

  // Connect and resolve once SCTP is up (base opened MasterToViewer).
  async connect() {
    if (this.state === 'ready') return;
    if (this._connecting) return this._connecting;
    this._connecting = this._connect().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect() {
    this.state = 'connecting';
    const creds = JSON.parse(fs.readFileSync(this.credsPath, 'utf8'));
    const credentials = {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
    const kv = new KinesisVideoClient({ region: REGION, credentials });
    const desc = await kv.send(new DescribeSignalingChannelCommand({ ChannelName: creds.channelName }));
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

    const pc = new nd.PeerConnection(this.viewerId, { iceServers, iceTransportPolicy: 'all' });
    this.pc = pc;

    let readyResolve, readyReject;
    const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    const timer = setTimeout(() => readyReject(new Error('base connect timeout')), this.connectTimeoutMs);

    pc.onStateChange(s => {
      if (pc !== this.pc) return;
      this.emit('state', s);
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        readyReject(new Error('pc ' + s));
        this._teardown('pc ' + s);
      }
    });
    pc.onDataChannel(ch => {
      if (pc !== this.pc) return;
      this.remoteDc = ch;
      ch.onMessage(m => this._onMessage(m));
      // SCTP is up — our own DC can carry data now even though it never
      // reports open (no DCEP ACK from the base).
      this.state = 'ready';
      clearTimeout(timer);
      readyResolve();
    });

    let offerSdp = null, onOffer;
    const offerReady = new Promise(r => { onOffer = r; });
    pc.onLocalDescription((sdp, type) => {
      if (type !== 'offer') return;
      let out = sdp;
      if (!out.includes('a=ice-options:trickle')) {
        out = out.replace(/(a=msid-semantic:[^\r\n]*\r?\n)/, `$1a=ice-options:trickle\r\n`);
      }
      offerSdp = { type, sdp: out };
      onOffer();
    });
    const pendingCandidates = [];
    let signalingOpen = false;
    pc.onLocalCandidate((candidate, mid) => {
      const msg = { candidate, sdpMid: mid || '0' };
      if (signalingOpen && this.client) { try { this.client.sendIceCandidate(msg); } catch (_) {} }
      else pendingCandidates.push(msg);
    });

    // The base rejects offers without the media sections the app offers.
    // Same shape as DoorphoneSource; tracks are attached so record playback
    // (Request_StartRecordStreaming) can deliver RTP to them.
    const audio = new nd.Audio('0', 'SendRecv');
    audio.addOpusCodec(96);
    audio.addAudioCodec(9, 'G722');
    audio.addAudioCodec(0, 'PCMU');
    audio.addAudioCodec(8, 'PCMA');
    audio.addSSRC(4115924315, 'rpc-audio', 'rpcStream', 'rpcAudioTrack');
    this.audioTrack = pc.addTrack(audio);
    const video = new nd.Video('1', 'RecvOnly');
    video.addVP8Codec(97);
    video.addRTXCodec(98, 97, 90000);
    video.addH264Codec(99, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f');
    video.addRTXCodec(100, 99, 90000);
    video.addH264Codec(101, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
    video.addRTXCodec(102, 101, 90000);
    this.videoTrack = pc.addTrack(video);
    this.audioTrack.setMediaHandler(new nd.RtcpReceivingSession());
    this.videoTrack.setMediaHandler(new nd.RtcpReceivingSession());
    this.audioTrack.onMessage(b => this.emit('audio-rtp', b));
    this.videoTrack.onMessage(b => this.emit('video-rtp', b));

    this.selfDc = pc.createDataChannel(`data-channel-of-${this.viewerId}`);
    this.selfDc.onMessage(m => this._onMessage(m));

    await offerReady;
    const client = new SignalingClient({
      channelARN: arn,
      channelEndpoint: endpoints.WSS,
      clientId: this.viewerId,
      role: Role.VIEWER,
      region: REGION,
      credentials,
      systemClockOffset: 0,
    });
    this.client = client;
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
      try { pc.setRemoteDescription(ans.sdp, ans.type); } catch (e) { readyReject(e); }
    });
    client.on('iceCandidate', c => { try { pc.addRemoteCandidate(c.candidate, c.sdpMid || '0'); } catch (_) {} });
    client.on('error', e => this.emit('error', e));
    client.open();

    try {
      await ready;
    } catch (e) {
      clearTimeout(timer);
      this._teardown(e.message);
      throw e;
    }
  }

  _onMessage(m) {
    const buf = Buffer.isBuffer(m) ? m : Buffer.from(m);
    let msg;
    try { msg = this.types.WebRtcMessage.decode(buf); }
    catch (e) { this.emit('parse-error', e, buf); return; }
    // Plain object with enum names (e.g. "TRIGGER_MANUAL") and 64-bit ints as
    // strings; bytes stay Buffers (Request_GetFile payload).
    const obj = this.types.WebRtcMessage.toObject(msg, { enums: String, longs: String, oneofs: true });
    const cmd = obj.cmd; // oneof field name, e.g. "responseGetrecordlist"
    const body = cmd ? obj[cmd] : null;
    this.emit('message', { requestId: msg.requestId, cmd, body, raw: buf });
    const p = this._pending.get(msg.requestId);
    if (p && cmd && cmd.startsWith('response')) {
      this._pending.delete(msg.requestId);
      clearTimeout(p.timer);
      p.resolve({ cmd, body });
      return;
    }
    if (cmd) this.emit('notify', { cmd, body, requestId: msg.requestId });
  }

  // Send a request. `cmd` is the oneof field name (e.g. "requestGetrecordlist").
  //
  // nudgeMs: re-send the same message (same requestId) every nudgeMs until
  // the response arrives. The base's SCTP side sometimes holds a finished
  // response until we transmit something (seen on large Request_GetFile
  // replies: the reply only arrived once we sent the next request). A
  // duplicate reply has no pending entry and is just emitted as 'notify'.
  request(cmd, body = {}, { timeoutMs = 10000, nudgeMs = 0 } = {}) {
    if (this.state !== 'ready') return Promise.reject(new Error('not connected'));
    const requestId = this._nextId++;
    const buf = Buffer.from(this.types.WebRtcMessage.encode({ requestId, version: 1, [cmd]: body }).finish());
    return new Promise((resolve, reject) => {
      let nudge = null;
      const done = () => { clearTimeout(timer); if (nudge) clearInterval(nudge); this._pending.delete(requestId); };
      const timer = setTimeout(() => { done(); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
      this._pending.set(requestId, {
        resolve: (v) => { done(); resolve(v); },
        reject: (e) => { done(); reject(e); },
        timer,
      });
      try { this.selfDc.sendMessageBinary(buf); }
      catch (e) { done(); reject(e); return; }
      if (nudgeMs > 0) {
        nudge = setInterval(() => {
          if (this.state !== 'ready' || !this.selfDc) return;
          this.nudges = (this.nudges || 0) + 1;
          try { this.selfDc.sendMessageBinary(buf); } catch (_) {}
        }, nudgeMs);
      }
    });
  }

  // Download a file from the base in chunks via Request_GetFile.
  async getFile(file, { chunk = 16384, onProgress } = {}) {
    const parts = [];
    let offset = 0;
    for (;;) {
      const { body } = await this.request('requestGetfile', { file, offset, maxPayloadSize: chunk }, { timeoutMs: 20000, nudgeMs: 1500 });
      if (!body || !body.result) throw new Error(`GetFile failed for ${file} at ${offset}`);
      const payload = Buffer.from(body.payload || []);
      parts.push(payload);
      offset += payload.length;
      onProgress?.(offset);
      if (!body.hasNext || payload.length === 0) break;
    }
    return Buffer.concat(parts);
  }

  _teardown(reason) {
    if (this.state === 'closed' || this.state === 'idle') return;
    this.state = 'idle';
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error('session closed: ' + reason)); }
    this._pending.clear();
    const pc = this.pc;
    this.pc = null;
    try { this.client?.close(); } catch (_) {}
    try { pc?.close(); } catch (_) {}
    this.client = null;
    this.selfDc = null;
    this.remoteDc = null;
    this.emit('closed', reason);
  }

  close() { this._teardown('closed by us'); }
}

module.exports = { BaseRpc, loadTypes };
