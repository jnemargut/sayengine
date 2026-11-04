// Characters that don't look alike (Decision 47 A): the cast check compares outlines, and a reference
// picture can steer a new character's proportions and colours.
import { unzlibSync } from 'fflate';
import { BODY_PLANS, PLANS, characterSpec, charParams, type BodyPlan } from './rig.ts';

// ── outlines ─────────────────────────────────────────────────────────────
/** A character's outline in its rest pose: front width and side depth at 40 heights from feet to crown,
 *  as fractions of its height (so a scaled-up copy has the same outline), plus its face parts. */
export interface Silhouette { height: number; width: number[]; depth: number[]; head: number; legs: number; features: string[] }
const NB = 40;

export function silhouette(pos: Float32Array, headY?: number, hipY?: number, features: string[] = []): Silhouette {
  let top = 0;
  for (let i = 1; i < pos.length; i += 3) if (pos[i] > top) top = pos[i];
  const lo = new Array(NB).fill(Infinity), hi = new Array(NB).fill(-Infinity), dlo = new Array(NB).fill(Infinity), dhi = new Array(NB).fill(-Infinity);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const b = Math.min(NB - 1, Math.max(0, Math.floor((y / top) * NB)));
    if (x < lo[b]) lo[b] = x; if (x > hi[b]) hi[b] = x;
    if (z < dlo[b]) dlo[b] = z; if (z > dhi[b]) dhi[b] = z;
  }
  const width = lo.map((l, i) => (Number.isFinite(l) ? (hi[i] - l) / top : 0));
  const depth = dlo.map((l, i) => (Number.isFinite(l) ? (dhi[i] - l) / top : 0));
  return { height: top, width, depth, head: headY !== undefined && top > 0 ? (top - headY) / top : 0, legs: hipY !== undefined && top > 0 ? hipY / top : 0, features };
}

/** How alike two characters read, 0 (nothing alike) … 1 (the same): the overlap of their outlines at the
 *  same fraction of their height (proportions, not size), damped when head or leg proportions differ,
 *  then nudged by size and by how many face parts they share (same mouth, nose, eyes, hair…). */
export function outlineSimilarity(a: Silhouette, b: Silhouette): number {
  let mn = 0, mx = 0;
  for (let i = 0; i < NB; i++) {
    mn += Math.min(a.width[i], b.width[i]) + Math.min(a.depth[i], b.depth[i]);
    mx += Math.max(a.width[i], b.width[i]) + Math.max(a.depth[i], b.depth[i]);
  }
  const overlap = mx > 0 ? mn / mx : 1;
  const prop = Math.max(0, 1 - 2.5 * Math.abs(a.head - b.head) - 2 * Math.abs(a.legs - b.legs));
  const size = Math.min(a.height, b.height) / Math.max(a.height, b.height);
  const n = Math.max(a.features.length, b.features.length);
  const shared = n ? a.features.filter((f, i) => f === b.features[i]).length / n : 0.5;
  const shape = overlap * (0.5 + 0.5 * prop);
  return +(shape * 0.72 + size * 0.1 + shared * 0.18).toFixed(3);
}
/** Above this, two characters read as cousins. */
export const CAST_SIMILAR = 0.8;

// ── reference pictures ───────────────────────────────────────────────────
export interface Rgba { width: number; height: number; data: Uint8Array }

/** A minimal PNG reader (8-bit greyscale, RGB, RGBA, grey+alpha and palette images). */
export function decodePng(bytes: Uint8Array): Rgba {
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) throw new Error('a reference picture must be a PNG (export the JPEG as PNG first)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8, w = 0, h = 0, depth = 8, ctype = 6, plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8)), body = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = bytes[p + 16]; ctype = bytes[p + 17]; if (bytes[p + 20]) throw new Error('interlaced PNGs are not supported as references'); }
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8) throw new Error(`reference PNGs must be 8 bits per channel (this one is ${depth})`);
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!ch) throw new Error(`unsupported PNG colour type ${ctype}`);
  const all = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of idat) { all.set(c, o); o += c.length; }
  const raw = unzlibSync(all);
  const stride = w * ch, out = new Uint8Array(w * h * 4), prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4, s = x * ch;
      if (ctype === 6) { out[q] = cur[s]; out[q + 1] = cur[s + 1]; out[q + 2] = cur[s + 2]; out[q + 3] = cur[s + 3]; }
      else if (ctype === 2) { out[q] = cur[s]; out[q + 1] = cur[s + 1]; out[q + 2] = cur[s + 2]; out[q + 3] = 255; }
      else if (ctype === 0) { out[q] = out[q + 1] = out[q + 2] = cur[s]; out[q + 3] = 255; }
      else if (ctype === 4) { out[q] = out[q + 1] = out[q + 2] = cur[s]; out[q + 3] = cur[s + 1]; }
      else { const k = cur[s]; out[q] = plte![k * 3]; out[q + 1] = plte![k * 3 + 1]; out[q + 2] = plte![k * 3 + 2]; out[q + 3] = trns && k < trns.length ? trns[k] : 255; }
    }
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}

const hex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');

/** What a reference picture says: a body plan, proportions and colours by height band. */
export function readReference(img: Rgba): { plan: BodyPlan; params: Record<string, number | string>; look: Record<string, string>; note: string } {
  const { width: W, height: Hp, data } = img;
  const px = (x: number, y: number) => { const q = (y * W + x) * 4; return [data[q], data[q + 1], data[q + 2], data[q + 3]]; };
  // the background: transparent pixels, or the corners' colour
  const corners = [px(0, 0), px(W - 1, 0), px(0, Hp - 1), px(W - 1, Hp - 1)];
  const bg = [0, 1, 2].map((k) => corners.map((c) => c[k]).sort((a, b) => a - b)[1]);
  const usesAlpha = corners.every((c) => c[3] < 128);
  const fg = (x: number, y: number) => { const c = px(x, y); if (usesAlpha) return c[3] >= 128; return c[3] >= 128 && Math.hypot(c[0] - bg[0], c[1] - bg[1], c[2] - bg[2]) > 48; };
  // rows: extent and runs
  const rows: Array<{ l: number; r: number; runs: number; n: number }> = [];
  let top = -1, bottom = -1;
  for (let y = 0; y < Hp; y++) {
    let l = -1, r = -1, runs = 0, n = 0, inRun = false;
    for (let x = 0; x < W; x++) { const f = fg(x, y); if (f) { if (l < 0) l = x; r = x; n++; if (!inRun) runs++; } inRun = f; }
    rows.push({ l, r, runs, n });
    if (n > 0) { if (top < 0) top = y; bottom = y; }
  }
  if (top < 0 || bottom - top < 20) throw new Error('could not find a figure in the reference picture (use a plain or transparent background)');
  const Hf = bottom - top + 1;
  const wAt = (y: number) => (rows[y].n ? rows[y].r - rows[y].l + 1 : 0);
  // neck: the narrowest row between 8% and 55% of the way down; the head is above it
  let neck = top + Math.round(Hf * 0.15), best = Infinity;
  for (let y = top + Math.round(Hf * 0.08); y < top + Math.round(Hf * 0.55); y++) { const w = wAt(y); if (w > 0 && w < best * 0.995) { best = w; neck = y; } else if (w > best * 1.6 && neck > top) break; }
  const head = (neck - top) / Hf;
  // legs: going up from the feet, the highest row that is still split in two
  let crotch = bottom;
  for (let y = bottom; y > top + Hf * 0.3; y--) { if (rows[y].runs >= 2) crotch = y; else if (bottom - y > Hf * 0.06 && rows[y].runs < 2) break; }
  const legs = (bottom - crotch) / Hf;
  let shoulder = 0; for (let y = neck; y < neck + Math.round(Hf * 0.25) && y <= bottom; y++) shoulder = Math.max(shoulder, wAt(y));
  const girth = shoulder / Hf;
  // the nearest body plan by head size, leg length and girth (each plan's own outline)
  let plan: BodyPlan = 'human', bestD = Infinity;
  for (const k of BODY_PLANS) {
    const sp = characterSpec(charParams({ plan: k, height: PLANS[k].height, build: PLANS[k].build }));
    const H = PLANS[k].height, hip = sp.bones.find((b) => b.name === 'Hips')!.head[1];
    const shW = Math.abs(sp.bones.find((b) => b.name === 'LeftShoulder')!.tail[0]) * 2;
    const d = Math.abs(head - PLANS[k].head) / 0.05 + Math.abs(legs - hip / H) / 0.07 + Math.abs(girth - shW / H) / 0.08;
    if (d < bestD) { bestD = d; plan = k; }
  }
  const PD = PLANS[plan];
  const clamp = (v: number, a: number, b: number) => +Math.min(b, Math.max(a, v)).toFixed(2);
  const params: Record<string, number | string> = { plan, headSize: clamp(head / PD.head, 0.7, 1.6), legLength: clamp(legs / PD.leg, 0.7, 1.4) };
  // colours: the median of each height band, sampled from the middle of the figure
  const band = (a: number, b: number, half = 0.18) => {
    const cs: number[][] = [];
    for (let y = top + Math.round(Hf * a); y <= top + Math.round(Hf * b); y++) {
      const row = rows[y]; if (!row.n) continue;
      const mid = (row.l + row.r) / 2, hw = Math.max(1, (row.r - row.l) * half);
      for (let x = Math.round(mid - hw); x <= Math.round(mid + hw); x++) if (fg(x, y)) cs.push(px(x, y));
    }
    if (!cs.length) return undefined;
    return hex([0, 1, 2].map((k) => cs.map((c) => c[k]).sort((p, q) => p - q)[cs.length >> 1]));
  };
  const look: Record<string, string> = {};
  const set = (k: string, v: string | undefined) => { if (v) look[k] = v; };
  set('hair', band(0, head * 0.18, 0.3));
  set('skin', band(head * 0.45, head * 0.75, 0.12));
  set('shirt', band(head + (1 - head - legs) * 0.25, head + (1 - head - legs) * 0.7));
  set('trousers', band(1 - legs * 0.75, 1 - legs * 0.35, 0.4));
  set('boots', band(0.97, 1, 0.45));
  const note = `reference read as a ${plan} body (head ${(head * 100).toFixed(0)}% of height, legs ${(legs * 100).toFixed(0)}%), colours sampled: ${Object.keys(look).join(', ')}`;
  return { plan, params, look, note };
}
