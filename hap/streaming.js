/**
 * StreamingDelegate — reads the doorphone RTP stream from a local SDP file and
 * re-packages it into HomeKit SRTP via ffmpeg.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const pickPort = require('./pickport');

// 1x1 gray JPEG (62 bytes) — returned as a placeholder until we have a proper
// snapshot source. The Home tile shows a gray thumbnail but live preview works.
const PLACEHOLDER_JPEG = Buffer.from(
  'ffd8ffe000104a46494600010101006000600000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c180d0d1832211c213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232ffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101010000000000000102030405060708090a0bffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda000c03010002110311003f00fbf8a28a2800a28a2800affd9',
  'hex');

class StreamingDelegate {
  constructor({ name, ffmpegPath, source, snapshotPath }) {
    this.name = name;
    this.ffmpegPath = ffmpegPath;
    this.source = source;
    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();
    this.snapshotPath = snapshotPath || '/tmp/doorphone-snapshot.jpg';
    // Snapshot cache: { "WxH": { buf, at } }. Home polls every few seconds.
    this._snapshotCache = new Map();
    this._snapshotCacheTtlMs = 5000;
  }

  handleSnapshotRequest(request, callback) {
    const key = `${request.width}x${request.height}`;
    const now = Date.now();
    const cached = this._snapshotCache.get(key);
    if (cached && now - cached.at < this._snapshotCacheTtlMs) {
      return callback(undefined, cached.buf);
    }
    console.log('[HK] snapshot', key, '(cache miss)');
    const keyframe = this.source.getLastKeyframe?.();
    if (!keyframe) return callback(undefined, PLACEHOLDER_JPEG);

    const args = [
      '-y', '-loglevel', 'error',
      '-f', 'h264', '-i', 'pipe:0',
      '-vf', `scale=${request.width}:${request.height}`,
      '-frames:v', '1',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '5', '-',
    ];
    const ff = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    ff.stdin.on('error', () => {});
    ff.stderr.on('data', () => {});
    const chunks = [];
    ff.stdout.on('data', c => chunks.push(c));
    let finished = false;
    const done = (err) => {
      if (finished) return;
      finished = true;
      try { ff.kill('SIGKILL'); } catch (_) {}
      const buf = (err || chunks.length === 0) ? PLACEHOLDER_JPEG : Buffer.concat(chunks);
      if (!err && chunks.length > 0) this._snapshotCache.set(key, { buf, at: Date.now() });
      callback(undefined, buf);
    };
    ff.on('close', () => done());
    ff.on('error', e => done(e));
    const t = setTimeout(() => done(new Error('snapshot timeout')), 3000);
    ff.on('close', () => clearTimeout(t));
    try { ff.stdin.end(keyframe); } catch (_) {}
  }

  async prepareStream(request, callback) {
    console.log('[HK] prepareStream from', request.targetAddress, 'session=', request.sessionID);
    const videoSsrc = crypto.randomBytes(4).readUInt32BE(0);
    const audioSsrc = crypto.randomBytes(4).readUInt32BE(0);
    const videoSrtpKey = crypto.randomBytes(16);
    const videoSrtpSalt = crypto.randomBytes(14);
    const audioSrtpKey = crypto.randomBytes(16);
    const audioSrtpSalt = crypto.randomBytes(14);
    const videoReturnPort = await pickPort();
    const audioReturnPort = await pickPort();

    this.pendingSessions.set(request.sessionID, {
      address: request.targetAddress,
      videoPort: request.video.port,
      videoReturnPort,
      videoLocalSrtpKey: videoSrtpKey,
      videoLocalSrtpSalt: videoSrtpSalt,
      videoSsrc,
      audioPort: request.audio.port,
      audioReturnPort,
      audioLocalSrtpKey: audioSrtpKey,
      audioLocalSrtpSalt: audioSrtpSalt,
      audioSsrc,
    });

    callback(undefined, {
      video: { port: videoReturnPort, ssrc: videoSsrc, srtp_key: videoSrtpKey, srtp_salt: videoSrtpSalt },
      audio: { port: audioReturnPort, ssrc: audioSsrc, srtp_key: audioSrtpKey, srtp_salt: audioSrtpSalt },
    });
  }

  handleStreamRequest(request, callback) {
    console.log('[HK] handleStreamRequest type=', request.type, 'session=', request.sessionID);
    if (request.type === 'start') return this.startStream(request, callback);
    if (request.type === 'reconfigure') {
      // HomeKit asks us to adapt bitrate / resolution. Our ffmpeg is doing a
      // pass-through copy, so we have nothing meaningful to change — keep the
      // existing ffmpeg alive instead of tearing it down, which broke the
      // stream after ~27 seconds every time.
      return callback();
    }
    if (request.type === 'stop') { this.stopStream(request.sessionID); return callback(); }
    callback(new Error('unknown stream request type: ' + request.type));
  }

  startStream(request, callback) {
    const session = this.pendingSessions.get(request.sessionID);
    if (!session) return callback(new Error('no pending session'));
    this.pendingSessions.delete(request.sessionID);

    const v = request.video;
    const a = request.audio;
    console.log('[HK] startStream v=', { w: v.width, h: v.height, fps: v.fps, pt: v.pt, maxBr: v.max_bit_rate, profile: v.profile, level: v.level },
                'a=', { codec: a.codec, pt: a.pt, sr: a.sample_rate, br: a.max_bit_rate, ch: a.channel });
    const vBitrate = Math.max(v.max_bit_rate | 0, 2000); // enforce a sane minimum
    // Translate HAP enum → x264 profile/level names.
    const PROFILES = { 0: 'baseline', 1: 'main', 2: 'high' };
    const LEVELS = { 0: '3.1', 1: '3.2', 2: '4.0' };
    const x264Profile = PROFILES[v.profile] || 'baseline';
    const x264Level = LEVELS[v.level] || '3.1';
    const videoSrtpParams = Buffer.concat([session.videoLocalSrtpKey, session.videoLocalSrtpSalt]).toString('base64');
    const audioSrtpParams = Buffer.concat([session.audioLocalSrtpKey, session.audioLocalSrtpSalt]).toString('base64');

    const args = [
      '-y', '-loglevel', 'info',
      '-f', 'h264',
      '-analyzeduration', '0', '-probesize', '32768',
      '-use_wallclock_as_timestamps', '1',
      '-fflags', '+genpts',
      '-i', 'pipe:0',
      '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${a.sample_rate * 1000}`,
      // Video — pass-through to HomeKit SRTP. No re-encode = stable on iOS.
      '-an', '-sn', '-dn',
      '-map', '0:v',
      '-c:v', 'copy',
      '-payload_type', String(v.pt),
      '-ssrc', String(session.videoSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', videoSrtpParams,
      `srtp://${session.address}:${session.videoPort}?rtcpport=${session.videoPort}&pkt_size=1316`,
      // Audio out (silence)
      '-vn', '-sn', '-dn',
      '-map', '1:a',
      '-c:a', 'libopus', '-application', 'lowdelay',
      '-ar', String(a.sample_rate * 1000),
      '-b:a', String(a.max_bit_rate) + 'k',
      '-ac', String(a.channel),
      '-payload_type', String(a.pt),
      '-ssrc', String(session.audioSsrc),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', audioSrtpParams,
      `srtp://${session.address}:${session.audioPort}?rtcpport=${session.audioPort}&pkt_size=188`,
    ];

    console.log('[ffmpeg start] session=', request.sessionID);

    const ff = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    ff.stderr.on('data', d => process.stderr.write('[ff] ' + d));
    ff.stdin.on('error', e => { if (e.code !== 'EPIPE') console.log('[ff stdin err]', e.message); });
    ff.on('close', (code, sig) => {
      console.log(`[ffmpeg exit] code=${code} sig=${sig} session=${request.sessionID}`);
    });

    this.source.addVideoConsumer(ff.stdin);
    this.ongoingSessions.set(request.sessionID, { ff });
    callback();
  }

  stopStream(sessionID) {
    const s = this.ongoingSessions.get(sessionID);
    if (!s) return;
    this.source.removeVideoConsumer(s.ff.stdin);
    try { s.ff.kill('SIGKILL'); } catch (_) {}
    this.ongoingSessions.delete(sessionID);
  }
}

module.exports = { StreamingDelegate };
