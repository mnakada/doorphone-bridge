/**
 * DoorphoneSource: holds a persistent WebRTC session to the VL-X70AH base and
 * forwards the received H264 RTP packets to a loopback UDP port so that ffmpeg
 * (or any RTP consumer) can pick them up via an SDP description.
 *
 * Single instance is intended. start() is idempotent-ish: calling it while
 * already connected is a no-op.
 */
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { EventEmitter } = require('events');
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
globalThis.WebSocket = require('ws');
const { H264Depay } = require('./h264-depay');

const REGION = 'ap-northeast-1';

// Request_Connect(DEVICE_DOOR, devno=0, TYPE_MONITOR) with request_id=1 version=VERSION_1
const REQUEST_CONNECT = Buffer.from('08011001a2060408012002', 'hex');
// Request_Disconnect with request_id=2 version=VERSION_1. Sent before closing
// so the base drops its "スマホで使用中" (in use by phone) state immediately.
const REQUEST_DISCONNECT = Buffer.from('08021001c20600', 'hex');

class DoorphoneSource extends EventEmitter {
  constructor({ credsPath, videoHost = '127.0.0.1', videoPort = 5004, audioPort = 5006, viewerId, beforeStart }) {
    super();
    this.credsPath = credsPath;
    this.videoHost = videoHost;
    this.videoPort = videoPort;
    this.audioPort = audioPort;
    this.viewerId = viewerId || ('SP_e4e04fa2-a85a-4d94-878c-e53c90c9e1a7');
    // Optional async hook run before connecting (e.g. make the record
    // browser give the base up — the base serves one session at a time).
    this.beforeStart = beforeStart || null;
    this._preparing = false;
    this.udp = dgram.createSocket({ type: 'udp4', sendBufferSize: 4 * 1024 * 1024 });
    this.udpBound = new Promise((r) => this.udp.bind(0, '127.0.0.1', r));
    this._vLastSeq = -1; this._vLost = 0; this._vReorder = 0;
    this._videoConsumers = new Set(); // Set<WritableStream> for depacketized H264 Annex-B
    this._audioConsumers = new Set(); // Set<WritableStream> for raw PCMU bytes (8 kHz mono, pre-pacing)
    this._lastKeyframe = null; // Buffer: SPS+PPS+IDR concatenated, suitable for ffmpeg decode
    this._lastKeyframeAt = 0;
    this._pendingKeyframeNals = null; // scratch buffer while assembling
    this._depay = new H264Depay({
      onNal: (nal) => {
        this._rememberParameterSets(nal);
        const nalType = nal[4] & 0x1f;
        // Cache a decodable keyframe (SPS+PPS+IDR) for on-demand snapshots.
        if (nalType === 5 && this._sps && this._pps) {
          this._lastKeyframe = Buffer.concat([this._sps, this._pps, nal]);
          this._lastKeyframeAt = Date.now();
        }
        for (const consumer of [...this._videoConsumers]) {
          const t = consumer._target;
          if (!t || t.destroyed || t.writableEnded) {
            this._videoConsumers.delete(consumer);
            continue;
          }
          try {
            if (!consumer._dphStreaming) {
              // Hold off until we see an IDR, then prepend cached SPS/PPS so
              // ffmpeg's decoder initialises cleanly.
              if (nalType === 5) {
                if (this._sps) t.write(this._sps);
                if (this._pps) t.write(this._pps);
                t.write(nal);
                consumer._dphStreaming = true;
              }
            } else {
              t.write(nal);
            }
          } catch (_) {
            this._videoConsumers.delete(consumer);
          }
        }
      },
    });
    this._sps = null; this._pps = null; // cache SPS/PPS to warm new consumers

    this.pc = null;
    this.client = null;
    this.audioTrack = null;
    this.videoTrack = null;
    this.remoteDc = null;
    this.selfDc = null;
    this.state = 'idle';
    this.firstVideoReceivedAt = 0;
    this.videoPkts = 0;
    this.audioPkts = 0;

    // On-demand session management. While connected, the base shows "in use
    // by phone" and its own monitor can't be opened, so we only hold the
    // session while someone (a HomeKit stream) needs it.
    this._users = new Set();
    this.idleTimeoutMs = 15000; // grace after the last user, HomeKit restarts streams often
    this._idleTimer = null;
    this._reconnectTimer = null;
    this._stopping = false;
  }

  // Take a reference on the live session; connects if not already.
  acquire(tag) {
    this._users.add(tag);
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this.state === 'idle' && !this._preparing) {
      this.emit('log', `connect (user=${tag})`);
      this._preparing = true;
      Promise.resolve()
        .then(() => this.beforeStart?.())
        .catch(e => this.emit('log', `beforeStart failed: ${e.message || e}`))
        .finally(() => {
          this._preparing = false;
          if (this._users.size && this.state === 'idle') this._startOrRetry();
        });
    }
  }

  // True while someone (a HomeKit stream) actually wants the live session.
  hasLiveUsers() {
    return this._users.size > 0 || this._preparing;
  }

  // If the session is only lingering in its idle grace period, drop it now
  // so another client (record browser) can use the base. Resolves when done.
  async yieldIfUnused() {
    if (this.hasLiveUsers() || this.state === 'idle') return;
    this.emit('log', 'yielding idle live session');
    this.disconnect();
    await new Promise(r => setTimeout(r, 800));
  }

  // start() can fail transiently — e.g. right after a re-pair the creds file
  // isn't written yet. Reset to idle and retry while someone still wants us.
  _startOrRetry() {
    this.start().catch(e => {
      this.emit('error', e);
      if (this.pc) { try { this.pc.close(); } catch (_) {} this.pc = null; }
      try { this.client?.close(); } catch (_) {}
      this.client = null;
      this.state = 'idle';
      if (this._users.size && !this._reconnectTimer && !this._stopping) {
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (this._users.size && this.state === 'idle') {
            this.emit('log', 'retrying connect');
            this._startOrRetry();
          }
        }, 3000);
      }
    });
  }

  // Drop a reference; disconnects after idleTimeoutMs once nobody is left.
  release(tag) {
    this._users.delete(tag);
    if (this._users.size || this._idleTimer) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this._users.size) return;
      this.emit('log', `idle ${this.idleTimeoutMs / 1000}s — disconnecting`);
      this.disconnect();
    }, this.idleTimeoutMs);
    this._idleTimer.unref?.();
  }

  // Polite teardown: tell the base we're done, then close the PC.
  disconnect() {
    try { this.selfDc?.sendMessageBinary(REQUEST_DISCONNECT); } catch (_) {}
    // Give SCTP a moment to flush the message before closing.
    setTimeout(() => {
      if (this._users.size) {
        // A stream started during the flush window — keep the session and
        // re-arm the base instead of closing.
        try { this.selfDc?.sendMessageBinary(REQUEST_CONNECT); } catch (_) {}
        return;
      }
      this.stop();
    }, 300);
  }

  async start() {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.state = 'connecting';
    this._stopping = false;
    this.firstVideoReceivedAt = 0;
    this._vLastSeq = -1;
    await this.udpBound;

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

    // Register ALL callbacks BEFORE any addTrack / createDataChannel because
    // node-datachannel auto-negotiates immediately and would otherwise emit
    // the offer before we're listening.
    pc.onStateChange(s => {
      // Ignore late events from a PC we've already replaced/closed.
      if (pc !== this.pc) return;
      this.emit('state', s);
      if (s === 'connected') this.state = 'connected';
      if (s === 'closed' || s === 'failed' || s === 'disconnected') {
        this.state = 'idle';
        this.emit('disconnected');
        if (!this._stopping && this._users.size && !this._reconnectTimer) {
          // Dropped by the base / network while a stream is running.
          this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._users.size && this.state === 'idle') {
              this.emit('log', 'reconnecting');
              this._startOrRetry();
            }
          }, 2000);
        }
      }
    });

    pc.onDataChannel(ch => {
      // The parent opens "MasterToViewer" as its downstream channel; it SENDS
      // on this channel but does NOT read from it. All viewer-to-base requests
      // must go on OUR self DC (ViewerToMaster), handled below.
      this.remoteDc = ch;
      this.emit('remote-dc', ch.getLabel?.(), ch.getId?.());
      ch.onMessage(m => {
        const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
        this.emit('dc-message', b);
      });
    });

    let offerSdp = null;
    let onOfferReady;
    const offerPromise = new Promise((resolve) => { onOfferReady = resolve; });
    pc.onLocalDescription((sdp, type) => {
      if (type === 'offer') {
        let out = sdp;
        if (!out.includes('a=ice-options:trickle')) {
          out = out.replace(/(a=msid-semantic:[^\r\n]*\r?\n)/, `$1a=ice-options:trickle\r\n`);
        }
        offerSdp = { type, sdp: out };
        try { fs.writeFileSync(path.join(__dirname, '..', 'extracted-state', 'sdp_offer_hap.txt'), out); } catch (_) {}
        onOfferReady();
      }
    });

    const pendingCandidates = [];
    let signalingOpen = false;
    pc.onLocalCandidate((candidate, mid) => {
      const msg = { candidate, sdpMid: mid || '0' };
      if (signalingOpen) {
        try { this.client.sendIceCandidate(msg); } catch (_) {}
      } else pendingCandidates.push(msg);
    });

    // Audio m=0 SendRecv (mirror AVD; parent accepts actpass otherwise rejects).
    const audio = new nd.Audio('0', 'SendRecv');
    audio.addOpusCodec(96);
    audio.addAudioCodec(9, 'G722');
    audio.addAudioCodec(0, 'PCMU');
    audio.addAudioCodec(8, 'PCMA');
    const audioSsrc = 4115924314;
    audio.addSSRC(audioSsrc, 'kvs-audio-send', 'kvsStream', 'kvsAudioTrack');
    this.audioTrack = pc.addTrack(audio);

    // Video m=1 RecvOnly (H264 + VP8, same shape AVD offers).
    const video = new nd.Video('1', 'RecvOnly');
    video.addVP8Codec(97);
    video.addRTXCodec(98, 97, 90000);
    video.addH264Codec(99, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f');
    video.addRTXCodec(100, 99, 90000);
    video.addH264Codec(101, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
    video.addRTXCodec(102, 101, 90000);
    this.videoTrack = pc.addTrack(video);

    // Attach RTCP sessions so the library emits RR/PLI correctly.
    this.audioTrack.setMediaHandler(new nd.RtcpReceivingSession());
    this.videoTrack.setMediaHandler(new nd.RtcpReceivingSession());

    this.audioTrack.onMessage(buf => this._onAudioRtp(buf));
    this.videoTrack.onMessage(buf => this._onVideoRtp(buf));

    // Our upstream DC. Parent reads Request_Connect / Request_Disconnect from
    // this channel. Note: libdatachannel's isOpen() may stay false even after
    // the SCTP association is up, but sendMessageBinary buffers and delivers.
    const selfDc = pc.createDataChannel('ViewerToMaster');
    this.selfDc = selfDc;
    selfDc.onOpen(() => {
      try {
        selfDc.sendMessageBinary(REQUEST_CONNECT);
        this.emit('request-connect-sent');
      } catch (_) {}
    });
    selfDc.onMessage(m => {
      const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
      this.emit('self-dc-message', b);
    });

    // Signaling.
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

    let answered = false;
    client.on('open', () => {
      if (!offerSdp) return;
      signalingOpen = true;
      client.sendSdpOffer(offerSdp);
      for (const q of pendingCandidates) try { client.sendIceCandidate(q); } catch (_) {}
      pendingCandidates.length = 0;
    });
    client.on('sdpAnswer', (ans) => {
      if (answered) return;
      answered = true;
      try { fs.writeFileSync(path.join(__dirname, '..', 'extracted-state', 'sdp_answer_hap.txt'), ans.sdp); } catch (_) {}
      try { pc.setRemoteDescription(ans.sdp, ans.type); } catch (e) { this.emit('error', e); }
    });
    client.on('iceCandidate', (c) => {
      try { pc.addRemoteCandidate(c.candidate, c.sdpMid || '0'); } catch (_) {}
    });
    client.on('error', e => this.emit('error', e));

    await offerPromise;

    // Start intervals BEFORE opening the signaling socket so silence is already
    // queued when SRTP comes up. viewer3 does it in this order and it matters.
    const silence = Buffer.alloc(160, 0xff);
    const audioSsrcLocal = audioSsrc;
    let seq = Math.floor(Math.random() * 0xffff);
    let ts = Math.floor(Math.random() * 0xffffffff);
    this._audioInterval = setInterval(() => {
      if (!this.audioTrack) return;
      const rtp = Buffer.alloc(12 + silence.length);
      rtp[0] = 0x80; rtp[1] = 0;
      rtp.writeUInt16BE(seq & 0xffff, 2);
      rtp.writeUInt32BE(ts >>> 0, 4);
      rtp.writeUInt32BE(audioSsrcLocal >>> 0, 8);
      silence.copy(rtp, 12);
      seq = (seq + 1) & 0xffff;
      ts = (ts + 160) >>> 0;
      try { this.audioTrack.sendMessageBinary(rtp); } catch (_) {}
    }, 20);

    client.open();
    this.emit('connecting');

    this._kfInterval = setInterval(() => {
      if (!this.videoTrack) return;
      // Keep asking the base for keyframes so iPhone's decoder always has a
      // recent IDR to resync against.
      try { this.videoTrack.requestKeyframe(); } catch (_) {}
      if (!this.firstVideoReceivedAt && this.selfDc) {
        try { this.selfDc.sendMessageBinary(REQUEST_CONNECT); } catch (_) {}
      }
    }, 2000);
  }

  _onVideoRtp(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf[1] >= 200 && buf[1] <= 212) return;
    this.videoPkts++;
    if (!this.firstVideoReceivedAt) {
      this.firstVideoReceivedAt = Date.now();
      this.emit('video-ready');
    }
    const seq = buf.readUInt16BE(2);
    if (this._vLastSeq >= 0) {
      const diff = (seq - this._vLastSeq) & 0xffff;
      if (diff > 32768) this._vReorder++;
      else if (diff > 1) {
        this._vLost += diff - 1;
        // Request an immediate keyframe so the decoder can resync after loss.
        try { this.videoTrack?.requestKeyframe(); } catch (_) {}
      }
    }
    this._vLastSeq = seq;
    // Depacketize → emit H264 Annex-B NAL units to consumers.
    this._depay.push(buf);
  }

  // Sniff NAL types to cache SPS (7) and PPS (8) so late consumers can be
  // primed before the next keyframe arrives.
  _rememberParameterSets(nalWithStart) {
    const t = nalWithStart[4] & 0x1f;
    if (t === 7) this._sps = Buffer.from(nalWithStart);
    else if (t === 8) this._pps = Buffer.from(nalWithStart);
  }

  addVideoConsumer(target) {
    // Wrap so each consumer can carry per-session state (keyframe sync).
    const consumer = { _target: target, _dphStreaming: false };
    target._dphConsumer = consumer;
    this._videoConsumers.add(consumer);
    // Ask the base for an IDR within ~1s so new consumers can start.
    try { this.videoTrack?.requestKeyframe(); } catch (_) {}
    // Re-arm the base: Request_Connect prompts it to resume sending RTP after
    // a prior session ended. selfDc.isOpen() often returns false even when the
    // channel works, so just attempt the send and let libdatachannel queue.
    try { this.selfDc?.sendMessageBinary(REQUEST_CONNECT); } catch (_) {}
  }

  removeVideoConsumer(target) {
    const c = target?._dphConsumer;
    if (c) {
      this._videoConsumers.delete(c);
      target._dphConsumer = null;
    } else {
      // Backward compat for direct-stream callers.
      for (const c of this._videoConsumers) {
        if (c._target === target) { this._videoConsumers.delete(c); break; }
      }
    }
  }

  _onAudioRtp(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf[1] >= 200 && buf[1] <= 212) return;
    this.audioPkts++;
    if (!this._audioConsumers.size) return;
    const cc = buf[0] & 0x0f;
    const x = (buf[0] & 0x10) !== 0;
    let off = 12 + cc * 4;
    if (x) {
      if (off + 4 > buf.length) return;
      const extLen = buf.readUInt16BE(off + 2);
      off += 4 + extLen * 4;
    }
    if (off >= buf.length) return;
    const payload = buf.slice(off);
    for (const c of [...this._audioConsumers]) {
      const t = c._target;
      if (!t || t.destroyed || t.writableEnded) { this._audioConsumers.delete(c); continue; }
      try { t.write(payload); } catch (_) { this._audioConsumers.delete(c); }
    }
  }

  addAudioConsumer(target) {
    const consumer = { _target: target };
    target._dphAudioConsumer = consumer;
    this._audioConsumers.add(consumer);
  }

  removeAudioConsumer(target) {
    const c = target?._dphAudioConsumer;
    if (c) {
      this._audioConsumers.delete(c);
      target._dphAudioConsumer = null;
    } else {
      for (const c of this._audioConsumers) {
        if (c._target === target) { this._audioConsumers.delete(c); break; }
      }
    }
  }

  getStats() {
    return {
      state: this.state,
      videoPkts: this.videoPkts,
      audioPkts: this.audioPkts,
      vLost: this._vLost,
      vReorder: this._vReorder,
    };
  }

  // Last decodable keyframe (SPS+PPS+IDR Annex-B) for snapshots.
  getLastKeyframe() {
    return this._lastKeyframe;
  }

  stop() {
    this._stopping = true;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.state = 'idle';
    clearInterval(this._audioInterval); this._audioInterval = null;
    clearInterval(this._kfInterval); this._kfInterval = null;
    try { this.client?.close(); } catch (_) {}
    try { this.pc?.close(); } catch (_) {}
    this.pc = null;
    this.client = null;
  }
}

function writeSdpFile(dest, { videoPort, audioPort, host = '127.0.0.1' }) {
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=doorphone',
    `c=IN IP4 ${host}`,
    't=0 0',
    `m=video ${videoPort} RTP/AVP 101`,
    'a=rtpmap:101 H264/90000',
    'a=fmtp:101 profile-level-id=42e01f;packetization-mode=1',
    `m=audio ${audioPort} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    '',
  ].join('\n');
  fs.writeFileSync(dest, sdp);
}

module.exports = { DoorphoneSource, writeSdpFile };
