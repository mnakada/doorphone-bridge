/**
 * Minimal H264 RTP depacketizer (RFC 6184).
 * Accepts RTP packets via write(buf) and yields H264 NAL units with Annex-B
 * start-code prefixes via callback(nalWithStartCode).
 *
 * Supports: Single NAL (types 1-23), STAP-A (24), FU-A (28).
 * Ignores: MTAP-16/24 (25-26), FU-B (29), STAP-B (27).
 */
class H264Depay {
  constructor({ onNal }) {
    this.onNal = onNal;
    this._fuBuf = null;
    this._fuNalHdr = 0;
    this._lastSeq = -1;
  }

  _emit(nal) {
    // nal includes the NAL header byte as first byte.
    const out = Buffer.alloc(4 + nal.length);
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 1;
    nal.copy(out, 4);
    this.onNal(out);
  }

  push(rtp) {
    if (rtp.length < 12) return;
    const cc = rtp[0] & 0x0f;
    const x = (rtp[0] & 0x10) !== 0;
    let payloadOffset = 12 + cc * 4;
    if (x) {
      if (payloadOffset + 4 > rtp.length) return;
      const extLen = rtp.readUInt16BE(payloadOffset + 2);
      payloadOffset += 4 + extLen * 4;
    }
    if (payloadOffset >= rtp.length) return;
    const payload = rtp.slice(payloadOffset);
    const nalHdr = payload[0];
    const nalType = nalHdr & 0x1f;

    if (nalType >= 1 && nalType <= 23) {
      this._fuBuf = null;
      this._emit(payload);
    } else if (nalType === 24) {
      // STAP-A: aggregated NAL units, each prefixed by 2-byte size.
      this._fuBuf = null;
      let off = 1;
      while (off + 2 <= payload.length) {
        const sz = payload.readUInt16BE(off);
        off += 2;
        if (off + sz > payload.length) break;
        this._emit(payload.slice(off, off + sz));
        off += sz;
      }
    } else if (nalType === 28) {
      // FU-A
      if (payload.length < 2) return;
      const fuHdr = payload[1];
      const start = (fuHdr & 0x80) !== 0;
      const end = (fuHdr & 0x40) !== 0;
      const origType = fuHdr & 0x1f;
      const fragment = payload.slice(2);
      if (start) {
        const reconstructedNalHdr = (nalHdr & 0xe0) | origType;
        this._fuBuf = Buffer.concat([Buffer.from([reconstructedNalHdr]), fragment]);
      } else if (this._fuBuf) {
        this._fuBuf = Buffer.concat([this._fuBuf, fragment]);
      }
      if (end && this._fuBuf) {
        this._emit(this._fuBuf);
        this._fuBuf = null;
      }
    } else {
      // Unsupported (MTAP, FU-B, STAP-B). Reset FU state.
      this._fuBuf = null;
    }
  }
}

module.exports = { H264Depay };
