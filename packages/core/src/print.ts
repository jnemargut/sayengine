// 3D printing (Decisions 43–46): a print profile for the Bambu Lab A1 mini (one spool, one colour),
// live print checks next to the other checks, fixes offered as reviewable steps, and the print
// helper ops (text, hole, split, chamfer) plus named fit gaps.
//
// Printing frame: the studio is Y-up metres; a printer is Z-up millimetres. An object prints the
// way it stands in the studio (its lowest point on the bed). `print-fix --fix lay-flat` turns it.
import type { EvalResult } from './kernel.ts';
import type { CheckResult } from './checks.ts';
import type { SceneObject } from './types.ts';
import { textOutline } from './glyphs.ts';

// ── printers ────────────────────────────────────────────────────────────
export interface PrinterSpec {
  label: string;
  bed: [number, number, number];   // mm: x, y (depth), z (height)
  margin: number;                  // mm kept clear at the bed edge
  nozzle: number;                  // mm
  line: number;                    // mm, line width
  walls: number;                   // perimeters
  supportBelow: number;            // degrees from horizontal: flatter downward faces need support
  bambu: { machine: string; process: string; filament: string };
}

export const PRINTERS: Record<'a1-mini', PrinterSpec> = {
  'a1-mini': {
    label: 'Bambu Lab A1 mini, 0.4 nozzle, PLA',
    bed: [180, 180, 180], margin: 2, nozzle: 0.4, line: 0.42, walls: 2, supportBelow: 30,
    bambu: { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M' },
  },
};

/** The thinnest wall that prints as solid perimeters: two lines of the nozzle (≈ 0.84 mm). */
export const minWall = (p: PrinterSpec) => p.walls * p.line;

// ── fit gaps (per side, metres) ────────────────────────────────────────
export interface FitGaps { press: number; slide: number; loose: number }
export const DEFAULT_FIT: FitGaps = { press: 0.0001, slide: 0.0002, loose: 0.00035 };
let fitDefaults: () => FitGaps = () => DEFAULT_FIT;
/** The daemon supplies your measured gaps (from a printed fit-test coupon). */
export function setFitDefaults(fn: (() => FitGaps) | null) { fitDefaults = fn ?? (() => DEFAULT_FIT); }
export const currentFit = () => fitDefaults();
let fitSink: ((f: FitGaps) => void) | null = null;
/** The daemon saves recorded gaps so new objects (and new projects) start from them. */
export function onFitRecorded(fn: ((f: FitGaps) => void) | null) { fitSink = fn; }
export const recordFit = (f: FitGaps) => fitSink?.(f);
export const FIT_PARAMS = { press: 'fitPress', slide: 'fitSlide', loose: 'fitLoose' } as const;

// ── screw holes (diameters in mm) ──────────────────────────────────────
// clearance: the screw passes freely · tap: a self-tapping screw cuts its own thread in PLA ·
// insert: a heat-set brass insert (short M-series inserts) · head: counterbore for a socket head
export const SCREWS: Record<string, { clearance: number; tap: number; insert: number; head: number; headDepth: number }> = {
  M2: { clearance: 2.4, tap: 1.7, insert: 3.2, head: 4.2, headDepth: 2.2 },
  'M2.5': { clearance: 2.9, tap: 2.1, insert: 3.6, head: 5.0, headDepth: 2.7 },
  M3: { clearance: 3.4, tap: 2.5, insert: 4.0, head: 6.0, headDepth: 3.2 },
  M4: { clearance: 4.5, tap: 3.3, insert: 5.6, head: 7.5, headDepth: 4.2 },
  M5: { clearance: 5.5, tap: 4.2, insert: 6.4, head: 9.0, headDepth: 5.2 },
};

// ── mesh analysis in the printing frame ────────────────────────────────
export interface PrintAnalysis {
  size: [number, number, number];  // mm: x, y (depth), z (height) as it would print
  fits: boolean;
  fitsDiagonal: boolean;           // fits when turned on the bed
  over: [number, number, number];  // mm over the usable bed per axis (0 = fits)
  supportArea: number;             // mm² of downward faces flatter than the support angle (not on the bed)
  baseArea: number;                // mm² touching the bed
  thinnest: number | null;         // mm, thinnest sampled wall under the limit (null: none under it)
  thinArea: number;                // mm² of side wall thinner than the limit
  wallMin: number | null;          // mm, thinnest sampled wall overall
  wallArea: number;                // mm², all side wall
  thinParts: string[];
  sealed: boolean;
  pieces: number;
  pieceSizes: Array<[number, number, number]>; // mm per separate piece (x, y depth, z height)
}

type V3 = [number, number, number];

/** Object-local vertex positions (undo the object's position and Y rotation; keep its shape). */
export function localPositions(obj: SceneObject, res: EvalResult): Float32Array {
  const p = res.positions;
  const [ox, oy, oz] = obj.position;
  const a = -((obj.rotation ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - ox, y = p[i + 1] - oy, z = p[i + 2] - oz;
    out[i] = c * x + s * z; out[i + 1] = y; out[i + 2] = -s * x + c * z;
  }
  return out;
}

function triGeom(p: Float32Array, idx: Uint32Array, t: number) {
  const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return {
    a, b, c, area: len / 2, n: (len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0]) as V3,
    centroid: [(p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3] as V3,
  };
}

/** Distance along a ray to the nearest triangle (Möller–Trumbore), ignoring triangle `skip`. */
function rayHit(p: Float32Array, idx: Uint32Array, o: V3, d: V3, skip: number, maxT: number): number {
  let best = maxT;
  const nt = idx.length / 3;
  for (let t = 0; t < nt; t++) {
    if (t === skip) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-14) continue;
    const f = 1 / det;
    const sx = o[0] - p[a], sy = o[1] - p[a + 1], sz = o[2] - p[a + 2];
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (d[0] * qx + d[1] * qy + d[2] * qz);
    if (v < 0 || u + v > 1) continue;
    const tt = f * (e2x * qx + e2y * qy + e2z * qz);
    if (tt > 1e-7 && tt < best) best = tt;
  }
  return best;
}

/** Size (mm, printing frame) of each separate piece of a mesh: vertices joined by shared positions. */
function pieces(p: Float32Array, idx: Uint32Array): Array<[number, number, number]> {
  const n = p.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(p[i * 3] * 1e5)},${Math.round(p[i * 3 + 1] * 1e5)},${Math.round(p[i * 3 + 2] * 1e5)}`;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i); else join(i, j);
  }
  for (let t = 0; t < idx.length; t += 3) { join(idx[t], idx[t + 1]); join(idx[t], idx[t + 2]); }
  const box = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const b = box.get(r) ?? [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p[i * 3 + k]); b[k + 3] = Math.max(b[k + 3], p[i * 3 + k]); }
    box.set(r, b);
  }
  return [...box.values()].filter((b) => Number.isFinite(b[0])).map((b) => [(b[3] - b[0]) * 1000, (b[5] - b[2]) * 1000, (b[4] - b[1]) * 1000]);
}

/** Measure a mesh (object-local metres, Y-up) as it would print on this printer. */
export function analyseForPrint(positions: Float32Array, indices: Uint32Array, printer: PrinterSpec, opts: { parts?: EvalResult['parts']; samples?: number; status?: string; components?: number } = {}): PrintAnalysis {
  const p = positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const mm = 1000;
  const size: V3 = [(maxX - minX) * mm, (maxZ - minZ) * mm, (maxY - minY) * mm];
  const usable = [printer.bed[0] - 2 * printer.margin, printer.bed[1] - 2 * printer.margin, printer.bed[2]];
  // separate pieces (a split model and its pins) go on the plate one by one: each must fit
  const pieceSizes = pieces(p, indices);
  const big = pieceSizes.length > 1 ? pieceSizes.reduce((x, y) => (x[0] * x[1] >= y[0] * y[1] ? x : y)) : size;
  const worst: V3 = pieceSizes.length > 1 ? [Math.max(...pieceSizes.map((q) => q[0])), Math.max(...pieceSizes.map((q) => q[1])), Math.max(...pieceSizes.map((q) => q[2]))] : size;
  const over: V3 = [Math.max(0, worst[0] - usable[0]), Math.max(0, worst[1] - usable[1]), Math.max(0, worst[2] - usable[2])];
  const fitsOne = (q: number[]) => q[0] <= usable[0] + 0.01 && q[1] <= usable[1] + 0.01 && q[2] <= usable[2] + 0.01;
  const fitsTurned = (q: number[]) => q[2] <= usable[2] && (q[0] + q[1]) / Math.SQRT2 <= Math.min(usable[0], usable[1]);
  const all = pieceSizes.length > 1 ? pieceSizes : [size];
  const fits = all.every(fitsOne);
  const fitsDiagonal = !fits && all.every((q) => fitsOne(q) || fitsTurned(q));
  void big;

  const nt = indices.length / 3;
  const cosSupport = Math.cos(((90 - printer.supportBelow) * Math.PI) / 180); // normal within (90-θ)° of straight down
  const bedTol = 0.0001; // 0.1 mm
  let supportArea = 0, baseArea = 0;
  const wallTris: number[] = [], wallArea: number[] = [];
  for (let t = 0; t < nt; t++) {
    const g = triGeom(p, indices, t);
    if (g.area <= 0) continue;
    const onBed = Math.max(p[g.a + 1], p[g.b + 1], p[g.c + 1]) - minY < bedTol;
    if (g.n[1] < -cosSupport) {
      if (onBed && g.n[1] < -0.999) baseArea += g.area;
      else if (!onBed) supportArea += g.area;
    }
    if (Math.abs(g.n[1]) < 0.5) { wallTris.push(t); wallArea.push(g.area); }
  }

  // wall thickness: from sampled side faces, shoot a ray into the material and measure to the far side
  const samples = opts.samples ?? 1200;
  let pick = wallTris;
  if (wallTris.length > samples) {
    // area-weighted, deterministic stride over the cumulative area
    const total = wallArea.reduce((a, b) => a + b, 0);
    const step = total / samples;
    pick = [];
    let acc = 0, next = step / 2;
    for (let i = 0; i < wallTris.length && pick.length < samples; i++) {
      acc += wallArea[i];
      while (acc >= next && pick.length < samples) { pick.push(wallTris[i]); next += step; }
    }
  }
  const limit = minWall(printer) / mm;
  // each sample stands for (total wall area / samples); thin walls count by the area they cover,
  // so the sharp tip of a letter or a fillet's last sliver doesn't fail the whole object
  const totalWall = wallArea.reduce((x, y) => x + y, 0);
  const per = pick.length ? (pick === wallTris ? null : totalWall / pick.length) : 0;
  let thinnest = Infinity, thinArea = 0, minAll = Infinity;
  const thin: V3[] = [];
  for (const t of pick) {
    const g = triGeom(p, indices, t);
    const d: V3 = [-g.n[0], -g.n[1], -g.n[2]];
    const o: V3 = [g.centroid[0] + d[0] * 1e-7, g.centroid[1] + d[1] * 1e-7, g.centroid[2] + d[2] * 1e-7];
    const hit = rayHit(p, indices, o, d, t, 0.05);
    if (hit < minAll) minAll = hit;
    if (hit < limit * 0.98) { thin.push(g.centroid); thinArea += per ?? g.area; if (hit < thinnest) thinnest = hit; }
  }
  const thinParts = new Set<string>();
  for (const c of thin) {
    const part = opts.parts?.find((q) => c[0] >= q.bbox.min[0] - 1e-4 && c[0] <= q.bbox.max[0] + 1e-4 && c[1] >= q.bbox.min[1] - 1e-4 && c[1] <= q.bbox.max[1] + 1e-4 && c[2] >= q.bbox.min[2] - 1e-4 && c[2] <= q.bbox.max[2] + 1e-4);
    if (part) thinParts.add(part.name.startsWith('~') ? `the cut by ${part.name.slice(1)}` : part.name);
  }
  return {
    size, fits, fitsDiagonal, over, supportArea: supportArea * mm * mm, baseArea: baseArea * mm * mm,
    thinnest: Number.isFinite(thinnest) ? thinnest * mm : null, thinArea: thinArea * mm * mm, wallArea: totalWall * mm * mm, wallMin: Number.isFinite(minAll) && minAll < 0.05 ? minAll * mm : null, thinParts: [...thinParts],
    sealed: (opts.status ?? 'NoError') === 'NoError', pieces: opts.components ?? pieceSizes.length, pieceSizes,
  };
}

// ── checks ──────────────────────────────────────────────────────────────
const f1 = (n: number) => n.toFixed(1);
const cm2 = (mm2: number) => `${(mm2 / 100).toFixed(1)} cm²`;

/** Text ops whose strokes are thinner than the printer can lay down. */
function textStrokeIssues(obj: SceneObject, printer: PrinterSpec): string[] {
  const out: string[] = [];
  for (const id of obj.opOrder) {
    const n = obj.ops[id];
    if (n?.op !== 'text') continue;
    const size = typeof n.args.size === 'number' ? n.args.size : Number(obj.params[String(n.args.size).replace(/^\$/, '')]?.value);
    if (!(size > 0)) continue;
    try {
      const o = textOutline(String(n.args.text ?? ''), size);
      if (o.stroke * 1000 < minWall(printer) * 0.98) out.push(`text "${id}" strokes are ${(o.stroke * 1000).toFixed(2)} mm (cap height ${f1(size * 1000)} mm): make size ≥ ${f1((size * 1000 * minWall(printer)) / (o.stroke * 1000))} mm`);
    } catch { /* no font: the op itself reports it */ }
  }
  return out;
}

export function printChecks(obj: SceneObject, res: EvalResult, midBuild: boolean): CheckResult[] {
  if (!obj.print || !res.ok || !res.positions.length) return [];
  const printer = PRINTERS[obj.print.printer];
  const a = analyseForPrint(localPositions(obj, res), res.indices, printer, { parts: res.parts, status: res.status, components: res.components });
  const pend = (c: CheckResult): CheckResult => (!c.pass && midBuild ? { ...c, pending: true, detail: `so far: ${c.detail}` } : c);
  const out: CheckResult[] = [];
  const dims = `${f1(a.size[0])} × ${f1(a.size[1])} × ${f1(a.size[2])} mm`;
  out.push(pend({
    id: 'print-bed', label: `Fits the ${printer.bed[0]} mm bed`, pass: a.fits || a.fitsDiagonal,
    detail: a.pieceSizes.length > 1 && a.fits ? `${a.pieceSizes.length} pieces, each fits: largest ${a.pieceSizes.map((q) => q.map(f1).join(' × ')).sort((x, y) => parseFloat(y) - parseFloat(x))[0]} mm (Bambu Studio arranges them, over more than one plate if needed)`
      : a.fits ? `${dims} (bed ${printer.bed.join(' × ')} mm)`
      : a.fitsDiagonal ? `${dims}: fits when turned on the bed (Bambu Studio's arrange does that)`
      : `${dims}: ${a.over.map((v, i) => (v > 0 ? `${f1(v)} mm too ${['wide', 'deep', 'tall'][i]}` : '')).filter(Boolean).join(', ')} — studio print-fix --fix split (cut into pieces with pins), lay-flat, or scale it`,
  }));
  out.push({
    id: 'print-sealed', label: 'Sealed solid (no holes or loose faces)', pass: a.sealed,
    detail: a.sealed ? `${res.triangles} triangles${a.pieces > 1 ? `, ${a.pieces} separate pieces (each goes on the plate as its own object)` : ''}` : `mesh status ${res.status}: the slicer may fill or drop parts`,
  });
  const strokes = textStrokeIssues(obj, printer);
  const lim = minWall(printer);
  // too-thin wall only counts once it covers more than sharp tips do (letter terminals, small
  // islands inside engraved letters): 4 mm², or 0.5% of all side wall on big objects
  const wallOk = a.thinArea < Math.max(4, 0.005 * a.wallArea);
  const where = a.thinParts.length ? ` in ${a.thinParts.join(', ')}` : '';
  out.push(pend({
    id: 'print-walls', label: `Walls at least ${f1(lim)} mm (${printer.walls} lines of a ${printer.nozzle} nozzle)`, pass: wallOk && !strokes.length,
    detail: [
      a.wallMin === null ? 'no side walls to measure'
        : a.thinArea === 0 ? `thinnest wall ${a.wallMin.toFixed(2)} mm`
        : wallOk ? `walls fine; a few sharp tips go down to ${a.thinnest!.toFixed(2)} mm${where} and may print a little rough`
        : `${a.thinArea.toFixed(1)} mm² of wall is thinner than ${f1(lim)} mm (down to ${a.thinnest!.toFixed(2)} mm)${where} — it would print weak or with gaps; aim for 1.2 mm+`,
      ...strokes,
    ].join('; '),
    parts: wallOk ? undefined : a.thinParts,
  }));
  out.push({
    id: 'print-overhangs', label: 'Overhangs that need support', pass: true,
    detail: a.supportArea < 1 ? `none (nothing flatter than ${printer.supportBelow}° hangs in the air)` : `about ${cm2(a.supportArea)} of downward faces flatter than ${printer.supportBelow}° — Bambu Studio adds supports (short flat spans under ~10 mm bridge without); studio print-fix --fix lay-flat finds a side that needs less`,
  });
  const tall = a.size[2] / Math.max(1, Math.sqrt(a.baseArea));
  out.push({
    id: 'print-base', label: 'Flat base for bed grip', pass: true,
    detail: a.baseArea < 1 ? 'no flat face on the bed: it rests on an edge or point — print-fix --fix lay-flat, or Bambu Studio will need supports under it'
      : `${cm2(a.baseArea)} on the bed${a.baseArea < 50 ? ' — small: a brim helps it stick' : ''}${tall > 8 ? ' — tall for its footprint, it may wobble: a brim helps' : ''}`,
  });
  return out;
}

/** A model that is split on purpose prints as separate pieces: "one connected piece" doesn't apply. */
export function adjustForPrint(obj: SceneObject, checks: CheckResult[]): CheckResult[] {
  if (!obj.print || !Object.values(obj.ops).some((n) => n.op === 'split')) return checks;
  return checks.map((c) => (c.id.startsWith('connected') && !c.pass ? { ...c, pass: true, detail: `${c.detail.split(' —')[0]}: split for printing (each prints on its own, then joins with the pins)` } : c));
}

// ── lay-flat: the orientation that needs the least support ─────────────
export interface Orientation { deg: [number, number, number]; supportArea: number; baseArea: number; size: [number, number, number]; fits: boolean; label: string }

/** Rotation matrix taking unit vector d onto -Y (straight down). */
function rotToDown(d: V3): number[][] {
  const t: V3 = [0, -1, 0];
  const c = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
  if (c > 0.999999) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (c < -0.999999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]]; // 180° about X
  const v: V3 = [d[1] * t[2] - d[2] * t[1], d[2] * t[0] - d[0] * t[2], d[0] * t[1] - d[1] * t[0]];
  const k = 1 / (1 + c);
  return [
    [1 - k * (v[1] * v[1] + v[2] * v[2]), k * v[0] * v[1] - v[2], k * v[0] * v[2] + v[1]],
    [k * v[0] * v[1] + v[2], 1 - k * (v[0] * v[0] + v[2] * v[2]), k * v[1] * v[2] - v[0]],
    [k * v[0] * v[2] - v[1], k * v[1] * v[2] + v[0], 1 - k * (v[0] * v[0] + v[1] * v[1])],
  ];
}

/** Euler degrees [x, y, z] for Manifold's rotate (x first, then y, then z: R = Rz·Ry·Rx). */
function eulerOf(R: number[][]): [number, number, number] {
  const sy = -R[2][0];
  const y = Math.asin(Math.max(-1, Math.min(1, sy)));
  let x: number, z: number;
  if (Math.abs(sy) < 0.99999) { x = Math.atan2(R[2][1], R[2][2]); z = Math.atan2(R[1][0], R[0][0]); }
  else { x = Math.atan2(-R[1][2], R[1][1]); z = 0; }
  const d = (r: number) => +((r * 180) / Math.PI).toFixed(4);
  return [d(x), d(y), d(z)];
}

function eulerMatrix(deg: [number, number, number]): number[][] {
  const [x, y, z] = deg.map((v) => (v * Math.PI) / 180);
  const Rx = [[1, 0, 0], [0, Math.cos(x), -Math.sin(x)], [0, Math.sin(x), Math.cos(x)]];
  const Ry = [[Math.cos(y), 0, Math.sin(y)], [0, 1, 0], [-Math.sin(y), 0, Math.cos(y)]];
  const Rz = [[Math.cos(z), -Math.sin(z), 0], [Math.sin(z), Math.cos(z), 0], [0, 0, 1]];
  const mul = (A: number[][], B: number[][]) => A.map((r) => B[0].map((_, j) => r.reduce((s, v, k) => s + v * B[k][j], 0)));
  return mul(Rz, mul(Ry, Rx));
}

const rotatePositions = (p: Float32Array, R: number[][]) => {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    out[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z;
    out[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z;
    out[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z;
  }
  return out;
};

/** Try the six sides and the biggest flat faces as the bottom; the least support (then most base) wins. */
export function bestOrientation(positions: Float32Array, indices: Uint32Array, printer: PrinterSpec): { best: Orientation; tried: Orientation[] } {
  const cands: Array<{ d: V3; label: string }> = [
    { d: [0, -1, 0], label: 'as it stands' }, { d: [0, 1, 0], label: 'upside down' },
    { d: [1, 0, 0], label: 'on its right side' }, { d: [-1, 0, 0], label: 'on its left side' },
    { d: [0, 0, 1], label: 'on its front' }, { d: [0, 0, -1], label: 'on its back' },
  ];
  // biggest flat faces (by normal, rounded)
  const byNormal = new Map<string, { n: V3; area: number }>();
  for (let t = 0; t < indices.length / 3; t++) {
    const g = triGeom(positions, indices, t);
    if (g.area <= 0) continue;
    const key = g.n.map((v) => Math.round(v * 50)).join(',');
    const e = byNormal.get(key) ?? { n: g.n, area: 0 };
    e.area += g.area;
    byNormal.set(key, e);
  }
  for (const e of [...byNormal.values()].sort((a, b) => b.area - a.area).slice(0, 8)) {
    if (cands.some((c) => c.d[0] * e.n[0] + c.d[1] * e.n[1] + c.d[2] * e.n[2] > 0.999)) continue;
    cands.push({ d: e.n, label: 'on a large flat face' });
  }
  const tried: Orientation[] = cands.map(({ d, label }) => {
    const R = rotToDown(d);
    const deg = eulerOf(R);
    const a = analyseForPrint(rotatePositions(positions, eulerMatrix(deg)), indices, printer, { samples: 0 });
    return { deg, supportArea: a.supportArea, baseArea: a.baseArea, size: a.size, fits: a.fits || a.fitsDiagonal, label };
  });
  const score = (o: Orientation) => (o.fits ? 0 : 1e9) + o.supportArea - 0.25 * o.baseArea + 0.01 * o.size[2];
  const best = [...tried].sort((a, b) => score(a) - score(b))[0];
  return { best, tried };
}

/** Lowest y of positions after rotating by deg (for sitting the result on the floor). */
export function minYAfter(positions: Float32Array, deg: [number, number, number]): number {
  const r = rotatePositions(positions, eulerMatrix(deg));
  let m = Infinity;
  for (let i = 1; i < r.length; i += 3) m = Math.min(m, r[i]);
  return m;
}

// ── ops (called by the kernel) ──────────────────────────────────────────
// The kernel passes Manifold's module and small helpers so this file stays free of kernel state.
export interface OpEnv {
  wasm: any;                                  // manifold-3d module (Manifold, CrossSection)
  keep<T>(m: T): T;
  P(k: string, d?: number): number;           // numeric arg (expressions allowed)
  V(k: string, d?: V3): V3;                   // vec3 arg
  A: Record<string, unknown>;
  id: string;
}

// Our extrudes run along Manifold's +Z; these map Manifold (u, v, w) onto the world.
const AXIS_MAT: Record<string, number[]> = {
  y: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],   // u→+X, v→−Z (letters' tops point to the back), w→+Y (up)
  z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],    // u→+X, v→+Y, w→+Z (faces the front)
  x: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],   // u→−Z, v→+Y, w→+X (faces the right)
  '-z': [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1], // faces the back
  '-x': [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1],  // faces the left
};

/** text { text, size: cap height m, depth: m, at?, axis?: y|z|x|-z|-x, align? } — solid letters. */
export function textOp(env: OpEnv) {
  const { wasm, keep, P, V, A } = env;
  const text = String(A.text ?? '');
  if (!text.trim()) throw new Error('text needs args.text (the letters)');
  const size = P('size'), depth = P('depth');
  if (!(size > 0) || !(depth > 0)) throw new Error('text needs size (cap height, m) > 0 and depth (m) > 0');
  const axis = String(A.axis ?? 'y');
  if (!AXIS_MAT[axis]) throw new Error(`text axis must be one of ${Object.keys(AXIS_MAT).join(', ')} (the direction the letters face)`);
  const o = textOutline(text, size, { align: A.align === 'left' ? 'left' : 'center', spacing: A.spacing === undefined ? 0 : Number(A.spacing) });
  const cs = keep(new wasm.CrossSection(o.polygons, 'NonZero'));
  // centre vertically on the cap height
  const cs2 = keep(cs.translate([0, -size / 2]));
  const m0 = keep(cs2.extrude(depth));
  return keep(keep(m0.transform(AXIS_MAT[axis])).translate(V('at', [0, 0, 0])));
}

/** hole { size: M2|M2.5|M3|M4|M5, kind?: clearance|tap|insert, depth: m, at, axis?: y, head?: bool, fit? } — a cutter. */
export function holeOp(env: OpEnv) {
  const { wasm, keep, P, V, A } = env;
  const size = String(A.size ?? 'M3');
  const spec = SCREWS[size];
  if (!spec) throw new Error(`hole size must be one of ${Object.keys(SCREWS).join(', ')}`);
  const kind = String(A.kind ?? 'clearance') as 'clearance' | 'tap' | 'insert';
  if (!['clearance', 'tap', 'insert'].includes(kind)) throw new Error('hole kind must be clearance, tap or insert');
  const depth = P('depth');
  if (!(depth > 0)) throw new Error('hole needs depth (m) > 0');
  const extra = A.fit === undefined ? 0 : P('fit');
  const r = (spec[kind] / 2) / 1000 + extra;
  const { Manifold } = wasm;
  // cylinders along +Z in Manifold, rotated so the hole goes DOWN (−axis) from "at" by depth,
  // poking 0.5 mm above so a difference leaves a clean opening
  const lip = 0.0005;
  let m = keep(keep(Manifold.cylinder(depth + lip, r, r, 40)).translate([0, 0, -depth]));
  if (A.head === true) {
    const hr = spec.head / 2000 + extra, hd = spec.headDepth / 1000;
    m = keep(Manifold.union([m, keep(keep(Manifold.cylinder(hd + lip, hr, hr, 40)).translate([0, 0, -hd]))]));
  }
  const axis = String(A.axis ?? 'y');
  const M: Record<string, number[]> = {
    y: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],  // goes down −Y
    z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],   // goes into −Z (from the front face inward)
    x: [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],  // goes into −X
  };
  if (!M[axis]) throw new Error('hole axis must be y (from the top, down), z (from the front, in) or x (from the right, in)');
  return keep(keep(m.transform(M[axis])).translate(V('at', [0, 0, 0])));
}

/** chamfer inputs:[a] { size?: m (0.4 mm) } — bevels the bottom edge so the first layer doesn't flare. */
export function chamferOp(env: OpEnv, input: any) {
  const { keep, P } = env;
  const c = P('size', 0.0004);
  if (!(c > 0 && c < 0.005)) throw new Error('chamfer size must be between 0 and 5 mm (e.g. 0.0004)');
  const b = input.boundingBox();
  const minY = b.min[1];
  // Manifold slices along its Z: work in a frame where world Y is Z
  const SWAP = [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const z = keep(input.transform(SWAP));
  const above = keep(z.trimByPlane([0, 0, 1], minY + c));
  const steps = 4;
  const rings: any[] = [above];
  for (let i = 0; i < steps; i++) {
    const z0 = minY + (c * i) / steps;
    const sec = keep(z.slice(z0 + c / steps / 2));
    const inset = keep(sec.offset(-(c * (steps - i)) / steps + c / steps / 2, 'Miter'));
    const slab = keep(keep(inset.extrude(c / steps + 1e-6)).translate([0, 0, z0]));
    rings.push(slab);
  }
  const { Manifold } = env.wasm;
  return keep(keep(Manifold.union(rings)).transform(SWAP));
}

/**
 * split inputs:[a] { axis?: x|y|z (default: the longest), at?: m (default: middle), pins?: n (2),
 * pinR?: m (2.5 mm), pinLen?: m (10 mm), fit?: m (default $fitPress), gap?: m (10 mm) } — cuts the
 * shape in two with matching holes, and adds the pins that join them, laid out apart for printing.
 */
export function splitOp(env: OpEnv, input: any): { parts: Array<{ m: any; name: string }> } {
  const { wasm, keep, P, A } = env;
  const { Manifold } = wasm;
  const b = input.boundingBox();
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const axisName = String(A.axis ?? ['x', 'y', 'z'][ext.indexOf(Math.max(...ext))]);
  const ax = ['x', 'y', 'z'].indexOf(axisName);
  if (ax < 0) throw new Error('split axis must be x, y or z');
  const at = A.at === undefined ? (b.min[ax] + b.max[ax]) / 2 : P('at');
  if (!(at > b.min[ax] && at < b.max[ax])) throw new Error(`split at ${at} is outside the shape along ${axisName} (${b.min[ax].toFixed(3)}…${b.max[ax].toFixed(3)})`);
  const pinR = P('pinR', 0.0025), pinLen = P('pinLen', 0.01), fit = A.fit === undefined ? currentFit().press : P('fit'), gap = P('gap', 0.01);
  const nPins = Math.max(0, Math.min(6, Math.round(P('pins', 2))));
  const normal: V3 = [0, 0, 0]; normal[ax] = 1;
  const [hi, lo] = keep(input.splitByPlane(normal, at)) as [any, any];
  if (hi.isEmpty() || lo.isEmpty()) throw new Error('split left one side empty');

  // pin positions: inside the cut face, at least pinR + 1.5 mm from its edge, spread apart
  const pins: V3[] = [];
  if (nPins > 0) {
    // cut face in Manifold's z-slice frame: rotate the split axis onto Z
    const toZ: Record<string, number[]> = {
      x: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],   // swap x,z
      y: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],   // swap y,z
      z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    };
    const sec = keep(keep(input.transform(toZ[axisName])).slice(at));
    const safe = keep(sec.offset(-(pinR + fit + 0.0015), 'Round'));
    const polys: number[][][] = safe.toPolygons();
    const inside = (u: number, v: number) => {
      let w = 0;
      for (const poly of polys) for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) w ^= 1;
      }
      return w === 1;
    };
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const poly of polys) for (const [u, v] of poly) { uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMin = Math.min(vMin, v); vMax = Math.max(vMax, v); }
    const grid: Array<[number, number]> = [];
    if (Number.isFinite(uMin)) for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
      const u = uMin + ((uMax - uMin) * i) / 24, v = vMin + ((vMax - vMin) * j) / 24;
      if (inside(u, v)) grid.push([u, v]);
    }
    // farthest-point picks
    const chosen: Array<[number, number]> = [];
    if (grid.length) {
      const cu = (uMin + uMax) / 2, cv = (vMin + vMax) / 2;
      chosen.push(nPins === 1 ? grid.reduce((a, g) => (Math.hypot(g[0] - cu, g[1] - cv) < Math.hypot(a[0] - cu, a[1] - cv) ? g : a)) : grid.reduce((a, g) => (Math.hypot(g[0] - cu, g[1] - cv) > Math.hypot(a[0] - cu, a[1] - cv) ? g : a)));
      while (chosen.length < nPins) {
        const nextPt = grid.reduce((a, g) => {
          const dg = Math.min(...chosen.map((c) => Math.hypot(g[0] - c[0], g[1] - c[1])));
          const da = Math.min(...chosen.map((c) => Math.hypot(a[0] - c[0], a[1] - c[1])));
          return dg > da ? g : a;
        });
        if (Math.min(...chosen.map((c) => Math.hypot(nextPt[0] - c[0], nextPt[1] - c[1]))) < 2 * pinR + 0.003) break;
        chosen.push(nextPt);
      }
    }
    // back to world: in the toZ frame (u, v) are the two axes other than the split axis
    for (const [u, v] of chosen) {
      const w: V3 = [0, 0, 0];
      if (axisName === 'x') { w[0] = at; w[1] = v; w[2] = u; }
      else if (axisName === 'y') { w[0] = u; w[1] = at; w[2] = v; }
      else { w[0] = u; w[1] = v; w[2] = at; }
      pins.push(w);
    }
  }
  // holes: pinLen/2 + 0.5 mm deep into each half, radius pinR + fit
  const toAxis: Record<string, number[]> = {
    x: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    y: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  const depth = pinLen / 2 + 0.0005;
  const hole = (c: V3) => keep(keep(keep(Manifold.cylinder(2 * depth, pinR + fit, pinR + fit, 32, true)).transform(toAxis[axisName])).translate(c));
  const cutters = pins.map(hole);
  let A1 = hi, B1 = lo;
  if (cutters.length) {
    const cut = keep(Manifold.union(cutters));
    A1 = keep(hi.subtract(cut));
    B1 = keep(lo.subtract(cut));
  }
  // lay the halves apart along the split axis
  const away: V3 = [0, 0, 0]; away[ax] = gap / 2;
  const back: V3 = [0, 0, 0]; back[ax] = -gap / 2;
  const parts: Array<{ m: any; name: string }> = [
    { m: keep(A1.translate(away)), name: 'half-a' },
    { m: keep(B1.translate(back)), name: 'half-b' },
  ];
  // pins stand upright in a row behind both halves, on the floor (0.4 mm shorter than the holes are deep)
  pins.forEach((_, i) => {
    const pin = keep(keep(Manifold.cylinder(pinLen - 0.0004, pinR, pinR, 32)).transform([1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]));
    parts.push({ m: keep(pin.translate([b.min[0] + pinR + i * (2 * pinR + 0.004), b.min[1], b.max[2] + gap + pinR])), name: 'pin' });
  });
  return { parts };
}

/** The fit-test coupon: one plate with five holes (gaps 0.1…0.4 mm per side) and a 6 mm pin. */
export const FIT_TEST_GAPS_MM = [0.1, 0.15, 0.2, 0.3, 0.4];
