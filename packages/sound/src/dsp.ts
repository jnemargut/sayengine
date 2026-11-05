// Small, dependency-free audio maths for the sound module (Decision 33): a seeded random source, WAV in
// and out, filters, envelopes, a plate-ish reverb, and seamless loops (a tail folded back into the start,
// or an equal-power crossfade). Everything works on Float32Array channels at one sample rate.
import fs from 'node:fs';

export const SR = 44100;
export type Channels = Float32Array[];          // [left, right] or [mono]

/** mulberry32: the same seed gives the same sound on every machine. */
export function rng(seed: number) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    int: (lo: number, hi: number) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length) % xs.length],
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;
/** A stable seed from a string (FNV-1a), so "forge-roar" always means the same numbers. */
export function seedOf(s: string | number): number {
  if (typeof s === 'number') return s >>> 0;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── WAV ────────────────────────────────────────────────────────────────────────────────────────

/** 16-bit PCM WAV (mono or stereo). */
export function encodeWav(ch: Channels, sr = SR): Buffer {
  const n = ch[0].length, c = ch.length, data = n * c * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(c, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * c * 2, 28); b.writeUInt16LE(c * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) {
    // TPDF dither keeps quiet tails from turning into zipper noise
    const v = Math.max(-1, Math.min(1, ch[k][i] + (Math.random() - Math.random()) / 65536));
    b.writeInt16LE(Math.round(v * 32767), o); o += 2;
  }
  return b;
}
export function writeWav(file: string, ch: Channels, sr = SR) { fs.writeFileSync(file, encodeWav(ch, sr)); return file; }

/** Read 8/16/24/32-bit PCM or 32-bit float WAV. */
export function decodeWav(buf: Buffer): { sr: number; ch: Channels } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, fmt = 1, c = 1, sr = SR, bits = 16, data: Buffer | null = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), len = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') { fmt = buf.readUInt16LE(o + 8); c = buf.readUInt16LE(o + 10); sr = buf.readUInt32LE(o + 12); bits = buf.readUInt16LE(o + 22); if (fmt === 0xfffe) fmt = buf.readUInt16LE(o + 32); }
    else if (id === 'data') data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + len));
    o += 8 + len + (len & 1);
  }
  if (!data) throw new Error('WAV has no data chunk');
  const bps = bits / 8, n = Math.floor(data.length / (bps * c));
  const ch: Channels = Array.from({ length: c }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let k = 0; k < c; k++) {
    const p = (i * c + k) * bps;
    ch[k][i] = fmt === 3 ? data.readFloatLE(p) : bits === 16 ? data.readInt16LE(p) / 32768 : bits === 24 ? data.readIntLE(p, 3) / 8388608 : bits === 32 ? data.readInt32LE(p) / 2147483648 : (data[p] - 128) / 128;
  }
  return { sr, ch };
}
export function readWav(file: string) { return decodeWav(fs.readFileSync(file)); }

// ── basics ─────────────────────────────────────────────────────────────────────────────────────

export const secs = (s: number, sr = SR) => Math.max(1, Math.round(s * sr));
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export function peak(ch: Channels) { let p = 0; for (const c of ch) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i])); return p; }
export function rms(x: Float32Array) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); }
export function scale(ch: Channels, g: number) { for (const c of ch) for (let i = 0; i < c.length; i++) c[i] *= g; return ch; }
export function normalize(ch: Channels, toPeak = 0.89) { const p = peak(ch); return p > 0 ? scale(ch, toPeak / p) : ch; }
export function toStereo(ch: Channels, pan = 0): Channels {
  if (ch.length === 2) return ch;
  const a = (pan + 1) * Math.PI / 4;
  const l = new Float32Array(ch[0]), r = new Float32Array(ch[0]);
  for (let i = 0; i < l.length; i++) { l[i] *= Math.cos(a) * Math.SQRT2; r[i] *= Math.sin(a) * Math.SQRT2; }
  return [l, r];
}
export function toMono(ch: Channels): Channels {
  if (ch.length === 1) return ch;
  const m = new Float32Array(ch[0].length);
  for (let i = 0; i < m.length; i++) m[i] = (ch[0][i] + ch[1][i]) * 0.5;
  return [m];
}
/** Add `src` into `dst` at sample `at` with gain (channel counts may differ). */
export function mixInto(dst: Channels, src: Channels, at = 0, gain = 1) {
  for (let k = 0; k < dst.length; k++) {
    const s = src[Math.min(k, src.length - 1)], d = dst[k];
    const from = Math.max(0, -at), to = Math.min(s.length, d.length - at);
    for (let i = from; i < to; i++) d[i + at] += s[i] * gain;
  }
  return dst;
}
export const silence = (n: number, c = 2): Channels => Array.from({ length: c }, () => new Float32Array(n));

/** A soft limiter (tanh above the knee): mixes never clip, and loud peaks round off. */
export function softClip(ch: Channels, ceiling = 0.97) {
  for (const c of ch) for (let i = 0; i < c.length; i++) { const v = c[i] / ceiling; c[i] = ceiling * (Math.abs(v) < 0.6 ? v : Math.sign(v) * (0.6 + 0.4 * Math.tanh((Math.abs(v) - 0.6) / 0.4))); }
  return ch;
}

// ── filters ────────────────────────────────────────────────────────────────────────────────────

/** RBJ biquad, processed in place. `freq` may be a function of the sample index (sweeps). */
export function biquad(x: Float32Array, type: 'lowpass' | 'highpass' | 'bandpass' | 'peak' | 'lowshelf' | 'highshelf', freq: number | ((i: number) => number), q = 0.707, gainDb = 0, sr = SR) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, lastF = -1;
  const coeffs = (f: number) => {
    f = Math.max(10, Math.min(sr * 0.45, f));
    const w = 2 * Math.PI * f / sr, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let B0, B1, B2, A0, A1, A2;
    if (type === 'lowpass') { B0 = (1 - cw) / 2; B1 = 1 - cw; B2 = (1 - cw) / 2; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; }
    else if (type === 'highpass') { B0 = (1 + cw) / 2; B1 = -(1 + cw); B2 = (1 + cw) / 2; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; }
    else if (type === 'bandpass') { B0 = al; B1 = 0; B2 = -al; A0 = 1 + al; A1 = -2 * cw; A2 = 1 - al; }
    else if (type === 'peak') { B0 = 1 + al * A; B1 = -2 * cw; B2 = 1 - al * A; A0 = 1 + al / A; A1 = -2 * cw; A2 = 1 - al / A; }
    else { const s = 2 * Math.sqrt(A) * al, lo = type === 'lowshelf';
      if (lo) { B0 = A * ((A + 1) - (A - 1) * cw + s); B1 = 2 * A * ((A - 1) - (A + 1) * cw); B2 = A * ((A + 1) - (A - 1) * cw - s); A0 = (A + 1) + (A - 1) * cw + s; A1 = -2 * ((A - 1) + (A + 1) * cw); A2 = (A + 1) + (A - 1) * cw - s; }
      else { B0 = A * ((A + 1) + (A - 1) * cw + s); B1 = -2 * A * ((A - 1) + (A + 1) * cw); B2 = A * ((A + 1) + (A - 1) * cw - s); A0 = (A + 1) - (A - 1) * cw + s; A1 = 2 * ((A - 1) - (A + 1) * cw); A2 = (A + 1) - (A - 1) * cw - s; } }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
  };
  const fixed = typeof freq === 'number';
  if (fixed) coeffs(freq as number);
  for (let i = 0; i < x.length; i++) {
    if (!fixed && (i & 31) === 0) { const f = (freq as (i: number) => number)(i); if (Math.abs(f - lastF) > 0.5) { coeffs(f); lastF = f; } }
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
export function onePoleLP(x: Float32Array, freq: number, sr = SR) { const a = Math.exp(-2 * Math.PI * freq / sr); let y = 0; for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y; } return x; }

// ── noise ──────────────────────────────────────────────────────────────────────────────────────

export function whiteNoise(n: number, r: Rng) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = r.next() * 2 - 1; return x; }
/** Pink-ish noise (Paul Kellet's filter). */
export function pinkNoise(n: number, r: Rng) {
  const x = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) { const w = r.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    x[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; }
  return x;
}
export function brownNoise(n: number, r: Rng) { const x = new Float32Array(n); let y = 0; for (let i = 0; i < n; i++) { y = (y + (r.next() * 2 - 1) * 0.02) * 0.998; x[i] = y * 3.5; } return x; }

// ── envelopes ──────────────────────────────────────────────────────────────────────────────────

/** Attack–decay–sustain–release gain for a note of `len` samples (release after len). */
export function adsr(i: number, len: number, a: number, d: number, s: number, r: number) {
  if (i < a) return i / Math.max(1, a);
  if (i < a + d) return 1 - (1 - s) * ((i - a) / Math.max(1, d));
  if (i < len) return s;
  const k = (i - len) / Math.max(1, r);
  return k >= 1 ? 0 : s * (1 - k) * (1 - k);
}

// ── reverb ─────────────────────────────────────────────────────────────────────────────────────

/** A small Freeverb (8 combs + 4 allpasses per side). Returns the wet signal only, length + tail. */
export function reverb(ch: Channels, opts: { room?: number; damp?: number; tail?: number; sr?: number } = {}): Channels {
  const sr = opts.sr ?? SR, room = opts.room ?? 0.82, damp = opts.damp ?? 0.35, tail = secs(opts.tail ?? 2.5, sr);
  const scaleT = sr / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], alls = [556, 441, 341, 225];
  const n = ch[0].length + tail, out: Channels = [new Float32Array(n), new Float32Array(n)];
  for (let side = 0; side < 2; side++) {
    const src = ch[Math.min(side, ch.length - 1)], o = out[side], spread = side ? 23 : 0;
    const cb = combs.map((l) => ({ buf: new Float32Array(Math.round((l + spread) * scaleT)), i: 0, f: 0 }));
    const ab = alls.map((l) => ({ buf: new Float32Array(Math.round((l + spread) * scaleT)), i: 0 }));
    for (let i = 0; i < n; i++) {
      const x = (i < src.length ? src[i] : 0) * 0.015;
      let y = 0;
      for (const c of cb) { const v = c.buf[c.i]; c.f = v * (1 - damp) + c.f * damp; c.buf[c.i] = x + c.f * room; c.i = (c.i + 1) % c.buf.length; y += v; }
      for (const a of ab) { const v = a.buf[a.i]; const z = -y + v; a.buf[a.i] = y + v * 0.5; a.i = (a.i + 1) % a.buf.length; y = z; }
      o[i] = y;
    }
  }
  return out;
}

// ── loops ──────────────────────────────────────────────────────────────────────────────────────

/** A loop exactly `len` samples long from a render that rings past it: the tail (reverb, releases)
 *  is folded back onto the start, so the loop's end flows into its start with no click or gap. */
export function foldLoop(ch: Channels, len: number): Channels {
  return ch.map((c) => {
    const o = new Float32Array(len);
    for (let i = 0; i < c.length; i++) o[i % len] += c[i];
    return o;
  });
}
/** A loop from a recording with no musical grid (a fire, wind): the last `fade` seconds crossfade
 *  (equal power) into the first, and the loop is shortened by that much. */
export function crossfadeLoop(ch: Channels, fade = 0.5, sr = SR): Channels {
  const f = Math.min(secs(fade, sr), Math.floor(ch[0].length / 3)), len = ch[0].length - f;
  return ch.map((c) => {
    const o = c.slice(0, len);
    for (let i = 0; i < f; i++) { const t = i / f; o[i] = c[i] * Math.sin(t * Math.PI / 2) + c[len + i] * Math.cos(t * Math.PI / 2); }
    return o;
  });
}
/** The jump at the loop seam compared with typical sample-to-sample steps (≈1 means seamless). */
export function seamJump(ch: Channels): number {
  let worst = 0;
  for (const c of ch) {
    const n = c.length; if (n < 4) continue;
    let s = 0; for (let i = 1; i < n; i++) s += Math.abs(c[i] - c[i - 1]);
    const typical = s / (n - 1) || 1e-9;
    worst = Math.max(worst, Math.abs(c[0] - c[n - 1]) / typical);
  }
  return worst;
}
export function fade(ch: Channels, inS = 0.005, outS = 0.01, sr = SR) {
  for (const c of ch) { const a = Math.min(c.length, secs(inS, sr)), b = Math.min(c.length, secs(outS, sr));
    for (let i = 0; i < a; i++) c[i] *= i / a; for (let i = 0; i < b; i++) c[c.length - 1 - i] *= i / b; }
  return ch;
}
