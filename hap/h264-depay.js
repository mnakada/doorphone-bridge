/**
 * Minimal H264 RTP depacketizer (RFC 6184).
 * Accepts RTP packets via write(buf) and yields H264 NAL units with Annex-B
 * start-code prefixes via callback(nalWithStartCode).
 *
 * Supports: Single NAL (types 1-23), STAP-A (24), FU-A (28).
 * Ignores: MTAP-16/24 (25-26), FU-B (29), STAP-B (27).
 */
const START_CODE = Buffer.from([0, 0, 0, 1]);

class H264Depay {
  constructor({ onNal }) {
    this.onNal = onNal;
    // FU-A reassembly: collect fragment slices (no per-fragment memcpy) and
    // Buffer.concat them once on completion.
    this._fuParts = null;
    this._fuSize = 0;
    this._fuDamaged = false; // a fragment went missing mid-NAL
    this._lastSeq = -1;
  }

  // onNal(nal, { damaged }): damaged = an FU-A fragment in the middle was
  // lost, so the NAL is truncated inside (decodes as a smeared picture).
  _emitParts(parts, size, damaged) {
    // parts is an array of Buffer slices; prepend the Annex-B start code.
    const out = Buffer.allocUnsafe(START_CODE.length + size);
    START_CODE.copy(out, 0);
    let off = START_CODE.length;
    for (const p of parts) { p.copy(out, off); off += p.length; }
    this.onNal(out, { damaged: !!damaged });
  }

  _emitSingle(nal) {
    const out = Buffer.allocUnsafe(START_CODE.length + nal.length);
    START_CODE.copy(out, 0);
    nal.copy(out, START_CODE.length);
    this.onNal(out, { damaged: false });
  }

  push(rtp) {
    if (rtp.length < 12) return;
    const seq = rtp.readUInt16BE(2);
    const contiguous = this._lastSeq < 0 || seq === ((this._lastSeq + 1) & 0xffff);
    this._lastSeq = seq;
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
      this._fuParts = null; this._fuSize = 0;
      this._emitSingle(payload);
    } else if (nalType === 24) {
      // STAP-A: aggregated NAL units, each prefixed by 2-byte size.
      this._fuParts = null; this._fuSize = 0;
      let off = 1;
      while (off + 2 <= payload.length) {
        const sz = payload.readUInt16BE(off);
        off += 2;
        if (off + sz > payload.length) break;
        this._emitSingle(payload.slice(off, off + sz));
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
        const reconstructedNalHdr = Buffer.from([(nalHdr & 0xe0) | origType]);
        this._fuParts = [reconstructedNalHdr, fragment];
        this._fuSize = reconstructedNalHdr.length + fragment.length;
        this._fuDamaged = false;
      } else if (this._fuParts) {
        if (!contiguous) this._fuDamaged = true;
        this._fuParts.push(fragment);
        this._fuSize += fragment.length;
      }
      if (end && this._fuParts) {
        this._emitParts(this._fuParts, this._fuSize, this._fuDamaged);
        this._fuParts = null; this._fuSize = 0; this._fuDamaged = false;
      }
    } else {
      // Unsupported (MTAP, FU-B, STAP-B). Reset FU state.
      this._fuParts = null; this._fuSize = 0;
    }
  }
}

module.exports = { H264Depay };
