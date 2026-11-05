// Painted face detail (face appeal round): one small texture per character, generated from its face
// landmarks and its paint settings, sampled through UVs projected from the bind pose. Because the UVs
// are fixed on the rest mesh, the paint rides along with every speech shape, expression and pose.
//
// The atlas (≤ 1024²) has three regions:
//   • head  (top half):        a cylinder around the head's vertical axis — eyes, lashes, smile lines,
//                              blush, freckles, stubble, wrinkles, fur and feather markings
//   • body  (next 3/8):        a cylinder along the torso — chest blaze, feather scallops, panel seams
//   • iris  (a 128² tile):     a radial iris (limbal ring, streaks, a soft top shadow)
// Parts opt in through their material's `paint` region; everything else stays a flat colour.
// DOM-free and Node-free (fflate for the PNG).
import { zlibSync } from 'fflate';
import { PLANS, moodCurve, type CharSpec, type V3 } from './rig.ts';
import type { FacePaint, Material, SceneObject } from './types.ts';
import type { EvalResult } from './kernel.ts';

export const ATLAS = 1024;
const HEAD_ROWS = 512, BODY_ROW0 = 512, BODY_ROWS = 384, IRIS_ROW0 = 896, IRIS = 128;
export type PaintRegion = 'head' | 'body' | 'iris';

// ── colour helpers (sRGB 0..1) ─────────────────────────────────────────
type C3 = [number, number, number];
export const hexRgb = (h: string): C3 => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) as C3; };
const mix = (a: C3, b: C3, t: number): C3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (a: C3, k: number): C3 => [a[0] * k, a[1] * k, a[2] * k];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
/** Deterministic hash noise. */
const hash = (x: number, y: number) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const vnoise = (x: number, y: number) => {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
/** Distance from p to a polyline, and how far along it (0..1) the closest point lies. */
function polyDist(px: number, py: number, pts: Array<[number, number]>): [number, number] {
  let best = Infinity, at = 0, total = 0;
  const lens: number[] = [];
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2);
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best) { best = d; at = (run + t * lens[i - 1]) / (total || 1); }
    run += lens[i - 1];
  }
  return [best, at];
}

// ── projections ────────────────────────────────────────────────────────
interface HeadFrame { cz: number; R: number; yTop: number; yBot: number }
interface BodyFrame { quad: boolean; cx: number; cy: number; cz: number; a0: number; a1: number; R: number }
export function headFrame(spec: CharSpec): HeadFrame {
  const F = spec.face, cz = F.headBase[2];
  const R = F.eyes.length ? F.eyes.reduce((s, e) => s + Math.hypot(e.c[0], e.c[2] + e.r * 0.6 - cz), 0) / F.eyes.length : F.hw;
  return { cz, R, yTop: F.headBase[1] + 1.3 * F.headH, yBot: F.headBase[1] - 0.35 * F.headH };
}
export function bodyFrame(spec: CharSpec): BodyFrame {
  const bone = (n: string) => spec.bones.find((b) => b.name === n);
  if (spec.quad) {
    const Q = spec.quad;
    return { quad: true, cx: 0, cy: (Q.chestY + Q.hipY) / 2, cz: 0, a0: Q.zRump - 0.4 * Q.wither, a1: Q.zChest + 0.5 * Q.wither, R: Q.bodyR };
  }
  const hips = bone('Hips')?.head ?? [0, 0.9 * spec.s, 0], neck = bone('Neck')?.head ?? [0, 1.45 * spec.s, 0];
  return { quad: false, cx: 0, cy: 0, cz: hips[2], a0: hips[1] - 0.25 * spec.s, a1: neck[1] + 0.05 * spec.s, R: 0.16 * spec.s };
}
const TAU = Math.PI * 2;
/** Head cylinder: metric coordinates (arc length around the head, height). */
const headXY = (hf: HeadFrame, p: V3): [number, number] => [Math.atan2(p[0], p[2] - hf.cz) * hf.R, p[1]];
/** Body cylinder: angle around the torso axis (0 at the belly / chest front), position along it. */
const bodyAng = (bf: BodyFrame, p: V3) => (bf.quad ? Math.atan2(p[0], bf.cy - p[1]) : Math.atan2(p[0], p[2] - bf.cz));
const bodyAlong = (bf: BodyFrame, p: V3) => (bf.quad ? p[2] : p[1]);

/** The iris cap's radius on the eye (× eye radius): sin of its angle from the eye's axis (rig.ts). */
const irisRadius = (spec: CharSpec) => { const st = spec.params.eyes ?? PLANS[spec.plan]?.face.eyes; return st === 'dot' ? 0.94 : st === 'big' ? 0.69 : 0.59; };

/** Atlas UVs for corners of one region (positions: bind pose, object space, 3 per corner). */
export function paintUvs(spec: CharSpec, region: PaintRegion, corners: Float32Array, partOfCorner?: (k: number) => string): Float32Array {
  const n = corners.length / 3, uv = new Float32Array(n * 2);
  const P = (k: number): V3 => [corners[k * 3], corners[k * 3 + 1], corners[k * 3 + 2]];
  if (region === 'iris') {
    // a flat projection across each eye (irises face +Z), onto the iris tile
    for (let k = 0; k < n; k++) {
      const p = P(k);
      const side = partOfCorner?.(k)?.startsWith('Right') ? 'Right' : partOfCorner?.(k)?.startsWith('Left') ? 'Left' : p[0] >= 0 ? 'Left' : 'Right';
      const e = spec.face.eyes.find((x) => x.side === side) ?? spec.face.eyes[0];
      const r = e ? e.r * irisRadius(spec) : 0.01;
      const lx = clamp(0.5 + (p[0] - (e?.c[0] ?? 0)) / (2 * r), 0.02, 0.98), ly = clamp(0.5 - (p[1] - (e?.c[1] ?? 0)) / (2 * r), 0.02, 0.98);
      uv[k * 2] = (lx * IRIS) / ATLAS; uv[k * 2 + 1] = (IRIS_ROW0 + ly * IRIS) / ATLAS;
    }
    return uv;
  }
  if (region === 'head') {
    const hf = headFrame(spec);
    for (let k = 0; k < n; k++) {
      const p = P(k);
      uv[k * 2] = 0.5 + Math.atan2(p[0], p[2] - hf.cz) / TAU;
      uv[k * 2 + 1] = (clamp((hf.yTop - p[1]) / (hf.yTop - hf.yBot), 0.002, 0.998) * HEAD_ROWS) / ATLAS;
    }
  } else {
    const bf = bodyFrame(spec);
    for (let k = 0; k < n; k++) {
      const p = P(k);
      uv[k * 2] = 0.5 + bodyAng(bf, p) / TAU;
      const t = clamp((bodyAlong(bf, p) - bf.a0) / (bf.a1 - bf.a0), 0.002, 0.998);
      uv[k * 2 + 1] = (BODY_ROW0 + (bf.quad ? 1 - t : 1 - t) * BODY_ROWS) / ATLAS;
    }
  }
  // the cylinder's seam is at the back: keep each triangle on one side of it (clamped sampling then
  // reads the plain base colour painted along the seam)
  for (let t = 0; t + 2 < n; t += 3) {
    const us = [uv[t * 2], uv[(t + 1) * 2], uv[(t + 2) * 2]];
    if (Math.max(...us) - Math.min(...us) > 0.5) for (let c = 0; c < 3; c++) if (uv[(t + c) * 2] < 0.5) uv[(t + c) * 2] += 1;
  }
  for (let k = 0; k < n; k++) uv[k * 2] = Math.min(0.999, uv[k * 2]);
  return uv;
}

// ── the painter ────────────────────────────────────────────────────────
export interface PaintColours { head: string; body: string; iris: string; lips?: string }

/** Paint the atlas: RGBA bytes, ATLAS × ATLAS. */
export function paintAtlas(spec: CharSpec, paint: FacePaint, col: PaintColours): Uint8Array {
  const img = new Uint8Array(ATLAS * ATLAS * 4);
  const put = (x: number, y: number, c: C3) => { const i = (y * ATLAS + x) * 4; img[i] = Math.round(clamp(c[0]) * 255); img[i + 1] = Math.round(clamp(c[1]) * 255); img[i + 2] = Math.round(clamp(c[2]) * 255); img[i + 3] = 255; };
  paintHead(spec, paint, hexRgb(col.head), col.lips ? hexRgb(col.lips) : null, put);
  paintBody(spec, paint, hexRgb(col.body), put);
  paintIris(spec, paint, hexRgb(col.iris), put);
  return img;
}

function paintHead(spec: CharSpec, P: FacePaint, skin: C3, lips: C3 | null, put: (x: number, y: number, c: C3) => void) {
  const F = spec.face, hf = headFrame(spec), H = F.headH;
  const kind = F.kind ?? 'human';
  const lipsKind = kind === 'human' || kind === 'cartoon';
  const eyes = F.eyes.map((e) => { const [x, y] = headXY(hf, [e.c[0], e.c[1], e.c[2] + e.r]); return { x, y, r: e.r, out: e.side === 'Left' ? 1 : -1 }; });
  const [mx, my] = headXY(hf, F.mouth);
  // the mouth's half width on the cylinder (its corners projected)
  const mw = Math.abs(headXY(hf, [F.mouth[0] + F.mouthW, F.mouth[1], F.mouth[2] - 0.15 * F.mouthW])[0] - mx);
  const [nx, ny] = headXY(hf, F.nose);
  const cheeks = F.cheeks.map((c) => headXY(hf, c));
  const lineC = shade(skin, 0.6), soft = shade(skin, 0.86);
  const lash: C3 | null = P.lashes ? hexRgb(P.lashes) : null;
  const blush: C3 | null = P.blush ? hexRgb(P.blush) : null;
  const freck: C3 | null = P.freckles ? hexRgb(P.freckles) : null;
  const stub: C3 | null = P.stubble ? hexRgb(P.stubble) : null;
  const mark: C3 = P.mark ? hexRgb(P.mark) : shade(skin, 1.25), mark2: C3 = P.mark2 ? hexRgb(P.mark2) : shade(skin, 0.55);
  const smileK = P.smile ?? 0, wr = P.wrinkles ?? 0;
  // the mood curves the mouth at rest (rig.ts curveMouth): the corners sit this much higher
  const cornerLift = moodCurve(spec.params.mood) * H * (kind === 'cartoon' ? 1 : 0.6);
  // stroke helper: a tapered line along a polyline (width w at the middle)
  const stroke = (X: number, Y: number, pts: Array<[number, number]>, w: number, taper = true) => {
    const [d, at] = polyDist(X, Y, pts);
    const ww = w * (taper ? 0.35 + 0.65 * Math.sin(Math.PI * clamp(at)) : 1);
    return smooth(ww, ww * 0.45, d);
  };
  for (let row = 0; row < HEAD_ROWS; row++) {
    const Y = hf.yTop - ((row + 0.5) / HEAD_ROWS) * (hf.yTop - hf.yBot);
    for (let x = 0; x < ATLAS; x++) {
      const X = ((x + 0.5) / ATLAS - 0.5) * TAU * hf.R;
      const back = Math.abs(X) > 0.62 * Math.PI * hf.R;   // keep the seam at the back plain
      let c: C3 = skin;
      if (!back) {
        // soft modelling: a little warmth on the cheeks and nose, shadow under the brow ridge and the nose
        c = mix(c, shade(skin, 0.9), 0.5 * Math.exp(-(((X - nx) / (0.25 * F.hw)) ** 2 + ((Y - (ny - 0.035 * H)) / (0.02 * H)) ** 2)));
        // markings under everything else
        if (P.markings === 'dog') {
          // a cream muzzle and chin, a blaze up between the eyes, a dark patch round the left eye
          const eyeY = eyes.length ? eyes[0].y : F.headBase[1] + 0.56 * H;
          const muzzle = smooth(0.5 * F.hw, 0.32 * F.hw, Math.abs(X - mx)) * smooth(eyeY - 0.02 * H, eyeY - 0.12 * H, Y);
          const blaze = smooth(0.11 * F.hw, 0.06 * F.hw, Math.abs(X - mx)) * smooth(F.headBase[1] + 1.05 * H, F.headBase[1] + 0.85 * H, Y);
          c = mix(c, mark, Math.max(muzzle, blaze) * 0.92);
          const pe = eyes.find((e) => e.out > 0);
          if (pe) { const dd = Math.hypot((X - pe.x) / (2.6 * pe.r), (Y - pe.y - 0.3 * pe.r) / (2.2 * pe.r)) + 0.12 * vnoise(X * 60 / H, Y * 60 / H); c = mix(c, mark2, smooth(1.0, 0.82, dd) * 0.9); }
        } else if (P.markings === 'feathers' || P.markings === 'heron') {
          // overlapping scallops: rows of rounded feather tips, each a touch darker at its edge
          const sc = 0.07 * H, rowI = Math.floor(Y / sc), off = (rowI % 2) * 0.5;
          const fx = X / sc + off, fy = Y / sc - rowI, cx = Math.floor(fx) + 0.5;
          const d = Math.hypot(fx - cx, (fy - 0.15) * 1.4);
          const edge = smooth(0.42, 0.5, d) * (1 - smooth(0.5, 0.58, d));
          c = mix(c, shade(c, 0.8), 0.75 * edge * smooth(F.headBase[1] + 0.25 * H, F.headBase[1] + 0.45 * H, Y));
          for (const e of eyes) {
            if (P.markings === 'heron') {
              // a heron's dark stripe from the eye back to the nape, and a dark cap
              const t = (X - e.x) * e.out, band = Math.abs(Y - e.y - 0.1 * e.r - Math.max(0, t) * 0.18);
              if (t > -0.5 * e.r) c = mix(c, mark2, smooth(0.6 * e.r, 0.35 * e.r, band) * smooth(-0.5 * e.r, 0.4 * e.r, t) * 0.95);
            } else {
              // a soft cheek patch below and behind the eye
              const d2 = Math.hypot((X - e.x - e.out * 1.2 * e.r) / (2.2 * e.r), (Y - e.y + 1.6 * e.r) / (1.5 * e.r));
              c = mix(c, mark, smooth(1, 0.7, d2) * 0.6);
            }
          }
          if (P.markings === 'heron') c = mix(c, mark2, smooth(F.headBase[1] + 1.0 * H, F.headBase[1] + 1.1 * H, Y) * 0.9);
        } else if (P.markings === 'robot') {
          // panel seams (a band round the brow, a seam down the middle of the crown) and rivets
          const browY = eyes.length ? eyes[0].y + 2.2 * eyes[0].r : F.headBase[1] + 0.75 * H;
          const seam = Math.max(smooth(0.006 * H, 0.002 * H, Math.abs(Y - browY)), smooth(0.005 * H, 0.0015 * H, Math.abs(X)) * smooth(browY, browY + 0.04 * H, Y));
          c = mix(c, shade(skin, 0.55), seam * 0.85);
          for (const rx of [-0.45, -0.15, 0.15, 0.45]) {
            const d = Math.hypot(X - rx * F.hw * 1.6, Y - browY - 0.035 * H);
            c = mix(c, shade(skin, 1.25), smooth(0.012 * H, 0.008 * H, d));
            c = mix(c, shade(skin, 0.6), smooth(0.012 * H, 0.009 * H, d) * smooth(0, 0.012 * H, (Y - browY - 0.035 * H) * -1));
          }
        }
        // stubble: a speckled shadow over the jaw, chin and upper lip (not the lips themselves)
        if (stub && lipsKind) {
          const jaw = smooth(ny - 0.01 * H, ny - 0.04 * H, Y) * smooth(F.headBase[1] - 0.05 * H, F.headBase[1] + 0.06 * H, Y) * smooth(1.25 * F.hw, 0.85 * F.hw, Math.abs(X - mx));
          const lipHole = smooth(1.0, 0.75, Math.hypot((X - mx) / (1.15 * mw), (Y - my) / (0.045 * H)));
          const speck = 0.55 + 0.45 * hash(Math.floor(X * 900 / H), Math.floor(Y * 900 / H));
          c = mix(c, stub, jaw * (1 - lipHole) * 0.42 * speck);
        }
        // blush: soft round cheeks
        if (blush) for (const [cx2, cy2] of cheeks) {
          const d = Math.hypot((X - cx2) / (0.26 * F.hw), (Y - cy2 + 0.01 * H) / (0.085 * H));
          c = mix(c, blush, (P.blushAmt ?? 0.4) * Math.exp(-d * d * 1.6));
        }
        // freckles: a scatter across the nose bridge and upper cheeks
        if (freck) {
          const band = Math.exp(-(((X - nx) / (0.85 * F.hw)) ** 2 + ((Y - ny - 0.04 * H) / (0.07 * H)) ** 2) * 1.2);
          const g = 0.028 * H, gx = Math.floor(X / g), gy = Math.floor(Y / g);
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const hx = gx + ox, hy = gy + oy;
            if (hash(hx, hy) > (P.frecklesAmt ?? 0.5) * 0.9) continue;
            const fx = (hx + 0.2 + 0.6 * hash(hy, hx)) * g, fy = (hy + 0.2 + 0.6 * hash(hx + 7, hy)) * g;
            const d = Math.hypot(X - fx, Y - fy), rr = g * (0.16 + 0.12 * hash(hx + 3, hy + 5));
            c = mix(c, freck, band * smooth(rr, rr * 0.5, d) * 0.75);
          }
        }
        // wrinkles: forehead lines, crow's feet, smile folds, a soft line under each eye
        if (wr > 0) {
          const browY = F.brows.length ? F.brows[0][1] : F.headBase[1] + 0.75 * H;
          for (const k of [0.06, 0.1, 0.14]) {
            const yy = browY + k * H + 0.008 * H * Math.cos(X / (0.25 * F.hw));
            c = mix(c, lineC, wr * 0.45 * smooth(0.0035 * H, 0.0012 * H, Math.abs(Y - yy)) * smooth(0.5 * F.hw, 0.25 * F.hw, Math.abs(X)));
          }
          for (const e of eyes) {
            for (const a of [-25, 0, 25]) {
              const ang = (a * Math.PI) / 180, ox = e.x + e.out * 1.35 * e.r, oy = e.y;
              const pts: Array<[number, number]> = [[ox, oy], [ox + e.out * Math.cos(ang) * 0.9 * e.r, oy + Math.sin(ang) * 0.9 * e.r]];
              c = mix(c, lineC, wr * 0.5 * stroke(X, Y, pts, 0.004 * H));
            }
            c = mix(c, lineC, wr * 0.35 * stroke(X, Y, [[e.x - 0.8 * e.r, e.y - 1.25 * e.r], [e.x, e.y - 1.45 * e.r], [e.x + 0.8 * e.r, e.y - 1.25 * e.r]], 0.003 * H));
          }
          if (lipsKind) for (const sx of [1, -1]) c = mix(c, lineC, wr * 0.5 * stroke(X, Y, [[nx + sx * 0.32 * F.hw, ny - 0.01 * H], [mx + sx * 1.3 * mw, my + 0.01 * H], [mx + sx * 1.35 * mw, my - 0.05 * H]], 0.004 * H));
        }
        // mouth: a soft shadow under the lower lip, and lines at the corners (smile or frown)
        if (lipsKind) {
          c = mix(c, shade(skin, 0.84), 0.55 * Math.exp(-(((X - mx) / (0.7 * mw)) ** 2 + ((Y - my + 0.06 * H) / (0.018 * H)) ** 2)));
          if (smileK !== 0) for (const sx of [1, -1]) {
            const up = smileK > 0 ? 1 : -1, k = Math.abs(smileK);
            // a crease that curls up (or down) out of the corner: the cartoon cue that reads as a smile
            const cx0 = mx + sx * 1.12 * mw, cy0 = my + up * 0.006 * H + cornerLift;
            // (a cartoon mouth gets a short, soft dimple: a long crease beside a wide mouth reads as a scar)
            const cart = kind === 'cartoon' ? 0.55 : 1;
            const pts: Array<[number, number]> = [[cx0, cy0 - up * 0.006 * H], [cx0 + sx * 0.08 * mw * cart, cy0 + up * 0.012 * H * cart], [cx0 + sx * 0.07 * mw * cart, cy0 + up * 0.03 * H * cart]];
            c = mix(c, mix(lineC, skin, kind === 'cartoon' ? 0.55 : 0.3), Math.min(0.6, k * 0.6) * stroke(X, Y, pts, 0.005 * H));
            // and the cheek it pushes up: a soft highlight just above and outside the crease
            if (up > 0) c = mix(c, mix(skin, [1, 1, 1], 0.25), k * 0.35 * Math.exp(-(((X - cx0 - sx * 0.35 * mw) / (0.3 * mw)) ** 2 + ((Y - cy0 - 0.06 * H) / (0.035 * H)) ** 2)));
          }
        }
        // lashes and the upper-lid line: along the lid's lower edge (it sits at sin(edge)·√(r²−dx²) above
        // the eye centre), thicker towards the outer corner, with a small flick
        if (lash) for (const e of eyes) {
          const dx = X - e.x, rr = e.r * 1.1;
          if (Math.abs(dx) < rr * 1.25) {
            const edgeY = e.y + 0.56 * Math.sqrt(Math.max(0, rr * rr - dx * dx));
            const outer = clamp(0.5 + 0.5 * (dx * e.out) / rr);
            const w = (0.16 + 0.22 * outer) * e.r;
            const d = Y - edgeY;
            if (Math.abs(dx) < rr) c = mix(c, lash, smooth(w, w * 0.4, Math.abs(d - w * 0.4)) * 0.95);
            // upper-lid crease shadow
            c = mix(c, shade(skin, 0.8), 0.3 * Math.exp(-(((d - 0.55 * e.r) / (0.18 * e.r)) ** 2)) * smooth(rr, 0.7 * rr, Math.abs(dx)));
          }
          // the flick at the outer corner
          const fx0 = e.x + e.out * 0.98 * rr, fy0 = e.y + 0.12 * e.r;
          c = mix(c, lash, 0.9 * stroke(X, Y, [[fx0 - e.out * 0.15 * e.r, fy0 - 0.02 * e.r], [fx0 + e.out * 0.2 * e.r, fy0 + 0.16 * e.r], [fx0 + e.out * 0.32 * e.r, fy0 + 0.32 * e.r]], 0.09 * e.r));
        }
      }
      put(x, row, c);
    }
  }
}

function paintBody(spec: CharSpec, P: FacePaint, base: C3, put: (x: number, y: number, c: C3) => void) {
  const bf = bodyFrame(spec);
  const mark: C3 = P.mark ? hexRgb(P.mark) : shade(base, 1.25), mark2: C3 = P.mark2 ? hexRgb(P.mark2) : shade(base, 0.6);
  for (let r = 0; r < BODY_ROWS; r++) {
    const t = 1 - (r + 0.5) / BODY_ROWS;                  // 0 at a0 (rump / hips) … 1 at a1 (chest / neck)
    const along = bf.a0 + t * (bf.a1 - bf.a0);
    for (let x = 0; x < ATLAS; x++) {
      const ang = ((x + 0.5) / ATLAS - 0.5) * TAU;          // 0 = belly (four legs) or chest front (upright)
      let c: C3 = base;
      if (Math.abs(ang) < 0.8 * Math.PI) {
        if (P.markings === 'dog') {
          // a cream blaze on the chest, running back along the belly; a slightly darker saddle on the back
          const front = smooth(-0.25, 0.1, (along - (bf.a1 - 0.45 * (bf.a1 - bf.a0))) / (bf.a1 - bf.a0));
          const blaze = smooth(0.85, 0.5, Math.abs(ang)) * (0.35 + 0.65 * front) + 0.15 * vnoise(x / 30, r / 30) - 0.08;
          c = mix(c, mark, clamp(blaze * 1.4) * 0.9);
          c = mix(c, shade(base, 0.82), smooth(2.2, 2.6, Math.abs(ang)) * 0.6);
        } else if (P.markings === 'feathers' || P.markings === 'heron') {
          const sc = 0.055 * spec.s, arc = ang * bf.R, rowI = Math.floor(along / sc), off = (rowI % 2) * 0.5;
          const fx = arc / sc + off, fy = along / sc - rowI, cx = Math.floor(fx) + 0.5;
          const d = Math.hypot(fx - cx, (fy - 0.15) * 1.4);
          c = mix(c, shade(c, 0.84), 0.6 * smooth(0.42, 0.5, d) * (1 - smooth(0.5, 0.58, d)));
          // a paler breast
          c = mix(c, mark, 0.35 * smooth(0.9, 0.3, Math.abs(ang)));
        } else if (P.markings === 'robot') {
          const arc = ang * bf.R;
          const seam = smooth(0.004 * spec.s, 0.0015 * spec.s, Math.abs(arc)) + smooth(0.004 * spec.s, 0.0015 * spec.s, Math.abs(((along / (0.18 * spec.s)) % 1) * 0.18 * spec.s - 0.09 * spec.s));
          c = mix(c, mark2, clamp(seam) * 0.7);
        }
      }
      put(x, BODY_ROW0 + r, c);
    }
  }
}

function paintIris(spec: CharSpec, P: FacePaint, iris: C3, put: (x: number, y: number, c: C3) => void) {
  void spec;
  const dark = shade(iris, 0.45), light = mix(iris, [1, 1, 1], 0.28);
  for (let y = 0; y < IRIS; y++) for (let x = 0; x < IRIS; x++) {
    const dx = (x + 0.5) / IRIS - 0.5, dy = (y + 0.5) / IRIS - 0.5;
    const r = Math.hypot(dx, dy) * 2;                           // 0 centre … 1 the iris edge
    const a = Math.atan2(dy, dx);
    let c = mix(light, iris, smooth(0.15, 0.6, r));
    // fine radial streaks, a dark limbal ring, a soft shadow from the upper lid
    c = mix(c, shade(c, 0.78 + 0.35 * hash(Math.floor(((a + Math.PI) / TAU) * 64), 3)), 0.5 * smooth(0.25, 0.5, r));
    c = mix(c, dark, smooth(0.72, 0.95, r));
    c = mix(c, shade(c, 0.7), 0.6 * smooth(-0.05, -0.38, dy) * (P.lashes ? 1 : 0.5));
    put(x, IRIS_ROW0 + y, c);
  }
}

// ── PNG (RGBA, 8-bit) ──────────────────────────────────────────────────
let CRC: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const idat = zlibSync(raw, { level: 6 });
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * For a character's export: which material groups are painted, their UVs, and the texture.
 * groups: material + triangle list (positions are the bind pose: res.positions is rig.rest there).
 */
export function paintGroups(obj: SceneObject, res: EvalResult, groups: Array<{ mat: Material; tris: number[] }>, materialFor: (part: string) => Material): { png: Uint8Array; uvOf: (g: { mat: Material; tris: number[] }, corners: Float32Array) => Float32Array } | null {
  const spec = res.rig?.rig.spec;
  if (!spec || !groups.some((g) => g.mat.paint)) return null;
  const triPart = new Array<string>(res.indices.length / 3);
  for (const p of res.parts) for (const [s, c] of p.ranges) for (let t = s; t < s + c; t++) triPart[t] = p.name;
  const colourOf = (region: string) => groups.find((g) => g.mat.paint === region)?.mat.color;
  const head = colourOf('head') ?? obj.material?.color ?? '#d9a77a';
  const png = characterPaintPng(spec, obj.character?.paint, { head, body: colourOf('body') ?? head, iris: colourOf('iris') ?? '#5b4632', lips: materialFor('lipUpper')?.color });
  return {
    png,
    uvOf: (g, corners) => paintUvs(spec, g.mat.paint!, corners, (k) => triPart[g.tris[Math.floor(k / 3)]] ?? ''),
  };
}

/** The PNG for a character (cached per spec + paint + colours). */
const cache = new Map<string, Uint8Array>();
export function characterPaintPng(spec: CharSpec, paint: FacePaint | undefined, col: PaintColours): Uint8Array {
  const key = JSON.stringify([spec.params, paint ?? {}, col]);
  let png = cache.get(key);
  if (!png) { png = encodePng(paintAtlas(spec, paint ?? {}, col), ATLAS, ATLAS); if (cache.size > 32) cache.clear(); cache.set(key, png); }
  return png;
}
