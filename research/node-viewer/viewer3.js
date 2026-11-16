#!/usr/bin/env node
/**
 * KVS WebRTC viewer (viewer3) — libdatachannel based, AVD-like offer.
 *
 *   audio mid=0 sendrecv  opus(96)+G722(9)+PCMU(0)+PCMA(8) with SSRC+cname
 *   video mid=1 recvonly  VP8(97)+rtx(98)+H264 42001f(99)+rtx(100)+H264 42e01f(101)+rtx(102)
 *   application mid=2 webrtc-datachannel sctp
 *
 * Callbacks must be registered BEFORE addTrack/createDataChannel because
 * node-datachannel auto-negotiates immediately (disableAutoNegotiation=false by default).
 */
const fs = require('fs');
const path = require('path');
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

const REGION = 'ap-northeast-1';
const APP_ID = 'SP_e4e04fa2-a85a-4d94-878c-e53c90c9e1a7';
const VIEWER_ID = APP_ID;
const credsPath = path.join(__dirname, '..', 'extracted-state', 'kvs_creds.json');

nd.initLogger('Info', (level, msg) => console.log('[nd]', level, msg));

function ndIceServers(ice) {
  const out = [`stun:stun.kinesisvideo.${REGION}.amazonaws.com:443`];
  for (const s of ice.IceServerList) {
    for (const u of s.Uris) {
      out.push(u.replace(/^(turn[s]?):/, `$1:${encodeURIComponent(s.Username)}:${encodeURIComponent(s.Password)}@`));
    }
  }
  return out;
}

(async () => {
  const c = JSON.parse(fs.readFileSync(credsPath));
  const credentials = {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
  };

  const kv = new KinesisVideoClient({ region: REGION, credentials });
  const desc = await kv.send(new DescribeSignalingChannelCommand({ ChannelName: c.channelName }));
  const arn = desc.ChannelInfo.ChannelARN;
  const ep = await kv.send(new GetSignalingChannelEndpointCommand({
    ChannelARN: arn,
    SingleMasterChannelEndpointConfiguration: { Protocols: ['WSS', 'HTTPS'], Role: Role.VIEWER },
  }));
  const endpoints = Object.fromEntries(ep.ResourceEndpointList.map(e => [e.Protocol, e.ResourceEndpoint]));
  const sig = new KinesisVideoSignalingClient({ region: REGION, endpoint: endpoints.HTTPS, credentials });
  const ice = await sig.send(new GetIceServerConfigCommand({ ChannelARN: arn, ClientId: 'VIEWER' }));
  const iceServers = ndIceServers(ice);
  console.log('iceServers:', iceServers.length);

  const pc = new nd.PeerConnection(VIEWER_ID, {
    iceServers,
    iceTransportPolicy: 'all',
  });

  // ---- Register all PC callbacks FIRST, before adding tracks (auto-nego trigger) ----
  const candidateQueue = [];
  let signalingOpen = false;
  let offerSdp = null;
  let onOfferReady = null;
  let audioBytes = 0, videoBytes = 0, videoFrames = 0;
  const videoLog = fs.createWriteStream(path.join(__dirname, '..', 'extracted-state', 'video_rtp.bin'));

  pc.onStateChange(s => console.log('pc state:', s));
  pc.onIceStateChange(s => console.log('ice state:', s));
  pc.onGatheringStateChange(s => console.log('gathering:', s));
  pc.onSignalingStateChange(s => console.log('signaling state:', s));

  pc.onLocalCandidate((candidate, mid) => {
    console.log('local cand:', candidate, 'mid=', mid);
    if (signalingOpen) {
      try { client.sendIceCandidate({ candidate, sdpMid: mid || '0' }); }
      catch (e) { console.log('sendIceCandidate err:', e.message); }
    } else {
      candidateQueue.push({ candidate, sdpMid: mid || '0' });
    }
  });

  pc.onLocalDescription((sdp, type) => {
    console.log('local description:', type, 'len=', sdp.length);
    if (type === 'offer') {
      let out = sdp;
      if (!out.includes('a=ice-options:trickle')) {
        out = out.replace(/(a=msid-semantic:[^\r\n]*\r?\n)/, `$1a=ice-options:trickle\r\n`);
      }
      // Force setup:active so WE become DTLS client (and SCTP client → open DC with stream 0)
      if (process.env.SETUP_ACTIVE) {
        out = out.replace(/a=setup:actpass/g, 'a=setup:active');
      }
      offerSdp = { type, sdp: out };
      fs.writeFileSync(path.join(__dirname, '..', 'extracted-state', 'sdp_offer_v3.txt'), out);
      if (onOfferReady) onOfferReady();
    }
  });

  let remoteDc = null;
  pc.onDataChannel(ch => {
    remoteDc = ch;
    console.log('REMOTE DataChannel: label=', ch.getLabel?.(), 'id=', ch.getId?.(), 'protocol=', ch.getProtocol?.());
    ch.onMessage(m => {
      const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
      console.log('  remote DC msg hex=', b.toString('hex'));
    });
    ch.onError(e => console.log('  remote DC err:', e));
    ch.onClosed(() => console.log('  remote DC closed'));
    // Send Request_Connect on the remote channel (parent-initiated one)
    const req = Buffer.from('08011001a2060408012002', 'hex');
    const ok = ch.sendMessageBinary(req);
    console.log('  sent Request_Connect on remote DC ->', ok);
  });

  pc.onTrack(track => {
    const mid = track.mid();
    console.log('TRACK received: mid=', mid, 'type=', track.type(), 'dir=', track.direction());
    track.onMessage(data => {
      if (!Buffer.isBuffer(data)) data = Buffer.from(data);
      const pt = data[1] & 0x7f;
      if (pt === 101 || pt === 99 || pt === 97) {
        videoBytes += data.length;
        videoFrames++;
        if (videoFrames <= 5 || videoFrames % 100 === 0) {
          console.log(`  video RTP pt=${pt} len=${data.length} total=${videoBytes}b/${videoFrames}pkts`);
        }
        videoLog.write(data);
      } else {
        audioBytes += data.length;
        if (audioBytes < 2000) console.log(`  audio RTP pt=${pt} len=${data.length}`);
      }
    });
    track.onOpen(() => console.log('  track open mid=', mid));
    track.onClosed(() => console.log('  track closed mid=', mid));
  });

  // ---- Now add media ----
  const audio = new nd.Audio('0', 'SendRecv');
  audio.addOpusCodec(96);
  audio.addAudioCodec(9, 'G722');
  audio.addAudioCodec(0, 'PCMU');
  audio.addAudioCodec(8, 'PCMA');
  const audioSsrc = 4115924314;
  audio.addSSRC(audioSsrc, 'kvs-audio-send', 'kvsStream', 'kvsAudioTrack');
  const audioTrack = pc.addTrack(audio);

  const video = new nd.Video('1', 'RecvOnly');
  video.addVP8Codec(97);
  video.addRTXCodec(98, 97, 90000);
  video.addH264Codec(99, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f');
  video.addRTXCodec(100, 99, 90000);
  video.addH264Codec(101, 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f');
  video.addRTXCodec(102, 101, 90000);
  const videoTrack = pc.addTrack(video);

  // Attach RTCP receiving sessions so the library handles SR/RR and PLI properly.
  audioTrack.setMediaHandler(new nd.RtcpReceivingSession());
  videoTrack.setMediaHandler(new nd.RtcpReceivingSession());

  // Wire RTP receive on OUR own tracks (pc.onTrack only fires for remote-added tracks).
  for (const [name, t] of [['audio', audioTrack], ['video', videoTrack]]) {
    t.onOpen(() => console.log(name, 'track open'));
    t.onClosed(() => console.log(name, 'track closed'));
    t.onError(e => console.log(name, 'track err:', e));
    t.onMessage(data => {
      if (!Buffer.isBuffer(data)) data = Buffer.from(data);
      const pt = data[1] & 0x7f;
      if (name === 'video') {
        videoBytes += data.length;
        videoFrames++;
        if (videoFrames <= 5 || videoFrames % 100 === 0) {
          console.log(`  video RTP pt=${pt} len=${data.length} total=${videoBytes}b/${videoFrames}pkts`);
        }
        videoLog.write(data);
      } else {
        audioBytes += data.length;
        if (audioBytes < 2000) console.log(`  audio RTP pt=${pt} len=${data.length}`);
      }
    });
  }

  const dcLabel = process.env.DC_LABEL || 'ViewerToMaster';
  const dcOpts = process.env.DC_NEGOTIATED
    ? { negotiated: true, id: parseInt(process.env.DC_ID || '1', 10) }
    : (process.env.DC_ID ? { id: parseInt(process.env.DC_ID, 10) } : undefined);
  console.log('DC label:', dcLabel, 'opts:', JSON.stringify(dcOpts));
  const dc = dcOpts ? pc.createDataChannel(dcLabel, dcOpts) : pc.createDataChannel(dcLabel);
  dc.onOpen(() => {
    console.log('DataChannel OPEN');
    const bytes = Buffer.from('08011001a2060408012002', 'hex');
    dc.sendMessageBinary(bytes);
    console.log('sent Request_Connect:', bytes.toString('hex'));
  });
  dc.onMessage(m => {
    const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
    console.log('DC msg:', b.toString('hex').slice(0, 160));
  });
  dc.onClosed(() => console.log('DC closed'));

  // ---- Signaling ----
  const client = new SignalingClient({
    channelARN: arn,
    channelEndpoint: endpoints.WSS,
    clientId: VIEWER_ID,
    role: Role.VIEWER,
    region: REGION,
    credentials,
    systemClockOffset: 0,
  });

  client.on('open', () => {
    console.log('WSS OPEN');
    if (!offerSdp) { console.log('  no offer ready yet!'); return; }
    signalingOpen = true;
    client.sendSdpOffer(offerSdp);
    console.log('SDP_OFFER sent, len=', offerSdp.sdp.length);
    for (const q of candidateQueue) {
      try { client.sendIceCandidate(q); } catch (e) { console.log(e.message); }
    }
    candidateQueue.length = 0;
  });
  let answerApplied = false;
  client.on('sdpAnswer', async (ans) => {
    if (answerApplied) { console.log('SDP_ANSWER duplicate, ignoring'); return; }
    answerApplied = true;
    console.log('SDP_ANSWER received, len=', ans.sdp.length);
    fs.writeFileSync(path.join(__dirname, '..', 'extracted-state', 'sdp_answer_v3.txt'), ans.sdp);
    const videoM = ans.sdp.match(/m=video [^\r\n]+/)?.[0];
    const videoDir = ans.sdp.match(/m=video[\s\S]*?a=(sendonly|recvonly|sendrecv|inactive)/)?.[1];
    console.log('  answer video m-line:', videoM, 'dir=', videoDir);
    try { pc.setRemoteDescription(ans.sdp, ans.type); }
    catch (e) { console.log('setRemoteDescription err:', e.message); }
  });
  client.on('iceCandidate', (cand) => {
    try { pc.addRemoteCandidate(cand.candidate, cand.sdpMid || '0'); }
    catch (e) { console.log('addRemoteCandidate err:', e.message); }
  });
  client.on('close', () => console.log('WSS CLOSE'));
  client.on('error', (e) => console.log('WSS err:', e.toString?.() || e));

  // Wait for offer to be auto-generated after addTrack calls
  await new Promise(resolve => {
    if (offerSdp) return resolve();
    onOfferReady = resolve;
    setTimeout(() => resolve(), 5000);
  });
  if (!offerSdp) { console.log('offer not generated'); process.exit(1); }
  console.log('offer ready');

  // Silent PCMU RTP burst (makes sendrecv credible)
  let audioSeq = Math.floor(Math.random() * 0xffff);
  let audioTs = Math.floor(Math.random() * 0xffffffff);
  const silentPCMU = Buffer.alloc(160, 0xff);
  const audioInterval = setInterval(() => {
    const rtp = Buffer.alloc(12 + silentPCMU.length);
    rtp[0] = 0x80;
    rtp[1] = 0 & 0x7f;
    rtp.writeUInt16BE(audioSeq & 0xffff, 2);
    rtp.writeUInt32BE(audioTs >>> 0, 4);
    rtp.writeUInt32BE(audioSsrc >>> 0, 8);
    silentPCMU.copy(rtp, 12);
    audioSeq = (audioSeq + 1) & 0xffff;
    audioTs = (audioTs + 160) >>> 0;
    try { audioTrack.sendMessageBinary(rtp); } catch (e) { /* ignore */ }
  }, 20);

  client.open();

  // Periodically request keyframe + probe DC state + attempt manual send
  // WebRtcMessage { request_id=1, version=VERSION_1, request_connect{ device=CAMERA, devno=1, type=MONITOR } }
  const reqBytes = Buffer.from('08011001a2060408012002', 'hex');
  let sentReq = false;
  const kfInterval = setInterval(() => {
    try {
      const ok = videoTrack.requestKeyframe();
      const dcOpen = dc.isOpen?.();
      const dcId = dc.getId?.();
      const dcBuffered = dc.bufferedAmount?.();
      console.log('tick | kf=', ok, '| dc.isOpen=', dcOpen, 'id=', dcId, 'buf=', dcBuffered, '| pc=', pc.state(), 'videoRTP=', videoBytes, 'audioRTP=', audioBytes);
      if (!sentReq) {
        try {
          const r = dc.sendMessageBinary(reqBytes);
          console.log('  manual send Request_Connect ->', r, 'bytes=', reqBytes.toString('hex'));
          if (r !== false) sentReq = true;
        } catch (e) { console.log('  dc.send err:', e.message); }
      }
    } catch (e) { console.log('kf err:', e.message); }
  }, 2000);

  await new Promise(r => setTimeout(r, 45000));
  clearInterval(audioInterval);
  clearInterval(kfInterval);
  console.log('---');
  console.log('audio RTP total:', audioBytes, 'B');
  console.log('video RTP total:', videoBytes, 'B over', videoFrames, 'pkts');
  console.log('pc state:', pc.state(), 'ice:', pc.iceState());
  const sel = pc.getSelectedCandidatePair();
  if (sel) console.log('selected pair local=', sel.local.address + ':' + sel.local.port, 'remote=', sel.remote.address + ':' + sel.remote.port);
  videoLog.end();
  client.close();
  pc.close();
  nd.cleanup();
  process.exit(0);
})().catch(e => { console.error('error:', e); process.exit(1); });
