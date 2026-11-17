/**
 * Minimal SRTP sender (AES_CM_128_HMAC_SHA1_80, RFC 3711).
 *
 * Why we need this: ffmpeg's Opus RTP output follows RFC 7587 and stamps
 * packets with a 48 kHz clock. HomeKit instead expects RTP timestamps based
 * on the *negotiated* sample rate (16 kHz by us). Without rewriting the
 * timestamp, iPhone decodes each 20 ms packet as 60 ms of audio and inserts
 * 40 ms of silence between packets — exactly the chop we hear.
 *
 * So we take plain RTP from ffmpeg, rewrite the timestamp, encrypt+auth it
 * ourselves, and send to iPhone.
 */
const crypto = require('crypto');

// RFC 3711 §4.3 AES-CM key derivation.
function deriveKey(masterKey, masterSalt, label, keyLen) {
  const x = Buffer.alloc(16);
  masterSalt.copy(x, 0);
  x[7] ^= label;
  const out = Buffer.alloc(keyLen);
  let generated = 0;
  let counter = 0;
  const cipher = crypto.createCipheriv('aes-128-ecb', masterKey, null);
  cipher.setAutoPadding(false);
  while (generated < keyLen) {
    x.writeUInt16BE(counter, 14);
    const block = cipher.update(x);
    const copyLen = Math.min(16, keyLen - generated);
    block.copy(out, generated, 0, copyLen);
    generated += copyLen;
    counter++;
  }
  return out;
}

/**
 * Build an SRTP context from the 16-byte master key and 14-byte master salt.
 * Returns an encrypt(rtp, rocHint) function.
 */
function createSrtpContext(masterKey, masterSalt) {
  const sessionKey = deriveKey(masterKey, masterSalt, 0x00, 16);
  const sessionAuthKey = deriveKey(masterKey, masterSalt, 0x01, 20);
  const sessionSalt = deriveKey(masterKey, masterSalt, 0x02, 14);

  let roc = 0;
  let lastSeq = -1;

  function encrypt(rtp) {
    if (rtp.length < 12) throw new Error('short RTP');
    const seq = rtp.readUInt16BE(2);
    const ssrc = rtp.readUInt32BE(8);

    // Track ROC rollover. The first packet establishes lastSeq.
    if (lastSeq >= 0 && seq < lastSeq && lastSeq - seq > 32768) roc++;
    lastSeq = seq;

    // IV = (sessionSalt || 0x0000) XOR (SSRC << 64) XOR ((ROC||seq) << 16)
    const iv = Buffer.alloc(16);
    sessionSalt.copy(iv, 0);
    for (let i = 0; i < 4; i++) iv[4 + i] ^= (ssrc >>> (24 - i * 8)) & 0xff;
    iv[8] ^= (roc >>> 24) & 0xff;
    iv[9] ^= (roc >>> 16) & 0xff;
    iv[10] ^= (roc >>> 8) & 0xff;
    iv[11] ^= roc & 0xff;
    iv[12] ^= (seq >>> 8) & 0xff;
    iv[13] ^= seq & 0xff;

    const header = rtp.slice(0, 12);
    const payload = rtp.slice(12);

    const cipher = crypto.createCipheriv('aes-128-ctr', sessionKey, iv);
    const encPayload = Buffer.concat([cipher.update(payload), cipher.final()]);

    // Auth: HMAC-SHA1(authKey, header || encPayload || ROC) truncated to 80 bits.
    const rocBuf = Buffer.alloc(4);
    rocBuf.writeUInt32BE(roc, 0);
    const mac = crypto.createHmac('sha1', sessionAuthKey)
      .update(header).update(encPayload).update(rocBuf).digest();

    return Buffer.concat([header, encPayload, mac.slice(0, 10)]);
  }

  return { encrypt };
}

module.exports = { createSrtpContext };
