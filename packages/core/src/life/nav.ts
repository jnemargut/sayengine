// One walk mesh and one lane graph per town (Decision 30), baked from the town plan: the sidewalks,
// pedestrian streets, plazas, crosswalks and piers people may stand on, a graph of walking lanes over
// them, and the car lanes (right-hand traffic) split at junctions with stop lines and signals. Both
// engines get the same polygons and the same lanes (life.json); nothing is baked twice.
import type { TownPlan, Street } from '../world/plan.ts';
import { groundAt } from '../world/plan.ts';
import { pointInPoly, distToSegment, centroid, type P2 } from '../world/geo.ts';

export const CAR_KINDS = ['primary', 'secondary', 'tertiary', 'residential'];
export const isCar = (s: Street) => CAR_KINDS.includes(s.kind);
export const isPed = (s: Street) => s.kind === 'pedestrian' || s.kind === 'footway';
const LIFT: Record<string, number> = { primary: 5, secondary: 4, tertiary: 3, residential: 2, pedestrian: 1.5, service: 1, footway: 0.5 };
export const roadLift = (s: Street) => 0.05 + (LIFT[s.kind] ?? 0) * 0.004;

/** Nearest point on a polyline: distance, segment index, fraction, arc length. */
export function nearestOn(line: P2[], p: P2): { d: number; i: number; u: number; s: number } {
  let best = { d: Infinity, i: 0, u: 0, s: 0 }, acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz, l = Math.sqrt(l2);
    const u = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
    const d = Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dz));
    if (d < best.d) best = { d, i, u, s: acc + u * l };
    acc += l;
  }
  return best;
}
/** Point and unit direction at arc length d along a polyline. */
export function alongLine(line: P2[], d: number): { p: P2; dir: P2 } {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= l || i + 2 === line.length) { const t = l ? Math.max(0, Math.min(d / l, 1)) : 0; return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: l ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0] }; }
    d -= l;
  }
  return { p: line[0], dir: [1, 0] };
}
export const lineLength = (line: P2[]) => line.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0), 0);

export interface Rect { c: P2; dir: P2; len: number; wid: number }    // centre, unit axis, length along dir, width across
export function rectPoly(r: Rect): P2[] {
  const n: P2 = [-r.dir[1], r.dir[0]], a = r.len / 2, b = r.wid / 2;
  return [[r.c[0] - r.dir[0] * a - n[0] * b, r.c[1] - r.dir[1] * a - n[1] * b], [r.c[0] + r.dir[0] * a - n[0] * b, r.c[1] + r.dir[1] * a - n[1] * b], [r.c[0] + r.dir[0] * a + n[0] * b, r.c[1] + r.dir[1] * a + n[1] * b], [r.c[0] - r.dir[0] * a + n[0] * b, r.c[1] - r.dir[1] * a + n[1] * b]];
}
export function inRect(p: P2, r: Rect, pad = 0): boolean {
  const dx = p[0] - r.c[0], dz = p[1] - r.c[1];
  const u = dx * r.dir[0] + dz * r.dir[1], v = -dx * r.dir[1] + dz * r.dir[0];
  return Math.abs(u) <= r.len / 2 + pad && Math.abs(v) <= r.wid / 2 + pad;
}

interface BBoxed { poly: P2[]; min: P2; max: P2 }
const boxed = (poly: P2[]): BBoxed => ({ poly, min: [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1]))], max: [Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))] });

/** What a town lets people stand on, as a test and as polygons. */
export class WalkSpace {
  plan: TownPlan;
  cars: Street[]; peds: Street[]; walkers: Street[];
  buildings: BBoxed[];
  parks: BBoxed[]; water: BBoxed[];
  crossings: Rect[] = []; crossInfo: Array<{ sig: number; group: number }> = []; piers: Rect[] = []; blocked: Rect[] = [];
  constructor(plan: TownPlan) {
    this.plan = plan;
    this.cars = plan.streets.filter(isCar);
    this.peds = plan.streets.filter(isPed);
    this.walkers = plan.streets.filter((s) => (isCar(s) && s.sidewalk >= 1.2) || isPed(s));
    this.buildings = plan.buildings.filter((b) => !b.hidden).map((b) => boxed(b.footprint));
    this.parks = plan.areas.filter((a) => a.kind === 'park' || a.kind === 'plaza').map((a) => boxed(a.polygon));
    this.water = plan.areas.filter((a) => a.kind === 'water' || a.kind === 'river').map((a) => boxed(a.polygon));
    for (const st of plan.streets) this.sbox.set(st, boxed(st.points));
  }
  private sbox = new Map<Street, BBoxed>();
  /** Distance from p to a street's centreline, or Infinity when p is clearly further than `within`. */
  dist(st: Street, p: P2, within: number): number {
    const b = this.sbox.get(st)!;
    if (p[0] < b.min[0] - within || p[0] > b.max[0] + within || p[1] < b.min[1] - within || p[1] > b.max[1] + within) return Infinity;
    return nearestOn(st.points, p).d;
  }
  inBuilding(p: P2, pad = 0.3): boolean {
    for (const b of this.buildings) {
      if (p[0] < b.min[0] - pad || p[0] > b.max[0] + pad || p[1] < b.min[1] - pad || p[1] > b.max[1] + pad) continue;
      if (pointInPoly(p, b.poly)) return true;
      if (pad > 0) for (let i = 0; i < b.poly.length; i++) if (distToSegment(p, b.poly[i], b.poly[(i + 1) % b.poly.length]) < pad) return true;
    }
    return false;
  }
  inPoly(p: P2, list: BBoxed[]): boolean { return list.some((b) => p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && pointInPoly(p, b.poly)); }
  /** On some car street's carriageway (pad widens it). */
  onRoad(p: P2, pad = 0): Street | null {
    for (const s of this.cars) if (this.dist(s, p, s.width / 2 + pad) < s.width / 2 + pad) return s;
    return null;
  }
  inCrossing(p: P2): boolean { return this.crossings.some((r) => inRect(p, r)); }
  onPier(p: P2): boolean { return this.piers.some((r) => inRect(p, r)); }
  private memo: Map<number, boolean> | null = null;
  /** Freeze the space (no more crossings, piers or blockers): walkable() is then memoised on a 5 cm grid. */
  freeze() { this.memo = new Map(); }
  /** May a person stand here? */
  walkable(p: P2): boolean {
    if (!this.memo) return this.walkableRaw(p);
    const key = Math.round(p[0] * 20) * 1000003 + Math.round(p[1] * 20);
    let v = this.memo.get(key);
    if (v === undefined) { v = this.walkableRaw(p); this.memo.set(key, v); }
    return v;
  }
  walkableRaw(p: P2): boolean {
    if (this.blocked.some((r) => inRect(p, r, 0.25))) return false;
    if (this.onPier(p)) return true;
    if (this.inBuilding(p)) return false;
    if (this.inCrossing(p)) return true;
    if (this.onRoad(p, 0.25)) return false;
    if (this.inPoly(p, this.water)) return false;
    for (const s of this.walkers) {
      const d = this.dist(s, p, s.width / 2 + s.sidewalk + 0.5);
      if (isPed(s) ? d < s.width / 2 : d > s.width / 2 + 0.2 && d < s.width / 2 + s.sidewalk) return true;
    }
    if (this.inPoly(p, this.parks)) return true;
    // the verge around a plaza or a green (paving between it and the sidewalk) is walkable too
    for (const b of this.parks) {
      if (p[0] < b.min[0] - 6 || p[0] > b.max[0] + 6 || p[1] < b.min[1] - 6 || p[1] > b.max[1] + 6) continue;
      for (let i = 0; i < b.poly.length; i++) if (distToSegment(p, b.poly[i], b.poly[(i + 1) % b.poly.length]) < 6) return true;
    }
    return false;
  }
  segWalkable(a: P2, b: P2, step = 0.4): boolean {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(l / step));
    for (let i = 0; i <= n; i++) { const t = i / n; if (!this.walkable([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])) return false; }
    return true;
  }
  /** Ground height a person stands at (y): sidewalk tops, road surface, plaza paving, piers. */
  heightAt(p: P2): number {
    if (this.onPier(p)) return this.pierY;
    let best: { d: number; y: number } | null = null;
    for (const s of this.plan.streets) {
      if (this.dist(s, p, s.width / 2 + s.sidewalk + 0.5) === Infinity) continue;
      const n = nearestOn(s.points, p);
      const w = s.width / 2;
      const hs = s.heights ?? s.points.map((q) => groundAt(this.plan.ground, q[0], q[1]));
      const base = hs[n.i] + (hs[Math.min(n.i + 1, hs.length - 1)] - hs[n.i]) * n.u;
      let y: number | null = null, d = 0;
      if (isPed(s)) { if (n.d < w + 0.3) { y = base + roadLift(s) + 0.02; d = n.d - w; } }
      else if (n.d < w) { y = base + roadLift(s); d = n.d - w - 10; }
      else if (s.sidewalk > 0 && n.d < w + s.sidewalk + 0.3) { y = base + 0.17; d = n.d - w - s.sidewalk; }
      if (y !== null && (!best || d < best.d)) best = { d, y };
    }
    return best ? best.y : groundAt(this.plan.ground, p[0], p[1]);
  }
  pierY = 0;
  /** Half-width of free space around a point across direction dir (capped). */
  freeHalf(p: P2, dir: P2, cap = 2.4): number {
    const n: P2 = [-dir[1], dir[0]];
    let h = 0;
    for (let r = 0.2; r <= cap; r += 0.2) {
      if (!this.walkable([p[0] + n[0] * r, p[1] + n[1] * r]) || !this.walkable([p[0] - n[0] * r, p[1] - n[1] * r])) break;
      h = r;
    }
    return h;
  }
  /** Walk polygons for the engines (debug view and checks): sidewalk strips, pedestrian streets, crossings, piers, plazas. */
  polygons(): Array<{ kind: string; poly: P2[] }> {
    const out: Array<{ kind: string; poly: P2[] }> = [];
    for (const s of this.walkers) {
      const w = s.width / 2;
      for (let i = 0; i + 1 < s.points.length; i++) {
        const a = s.points[i], b = s.points[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const n: P2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
        const strips: Array<[number, number]> = isPed(s) ? [[-w, w]] : [[-w - s.sidewalk, -w - 0.2], [w + 0.2, w + s.sidewalk]];
        for (const [o0, o1] of strips) {
          const mid: P2 = [(a[0] + b[0]) / 2 + n[0] * (o0 + o1) / 2, (a[1] + b[1]) / 2 + n[1] * (o0 + o1) / 2];
          if (!isPed(s) && this.onRoad(mid, 0.25)) continue;
          out.push({ kind: isPed(s) ? 'pedestrian' : 'sidewalk', poly: [[a[0] + n[0] * o0, a[1] + n[1] * o0], [b[0] + n[0] * o0, b[1] + n[1] * o0], [b[0] + n[0] * o1, b[1] + n[1] * o1], [a[0] + n[0] * o1, a[1] + n[1] * o1]] });
        }
      }
    }
    for (const r of this.crossings) out.push({ kind: 'crossing', poly: rectPoly(r) });
    for (const r of this.piers) out.push({ kind: 'pier', poly: rectPoly(r) });
    for (const p of this.parks) out.push({ kind: 'plaza', poly: p.poly });
    return out;
  }
}

// ── junctions and car lanes ──────────────────────────────────────────────────
export interface Junction { id: number; at: P2; arms: Array<{ street: number; s: number; dir: P2; out: boolean }>; groups: number[]; sig: number }
export interface CarEdge {
  id: number; pts: Array<[number, number, number]>; street: number; from: number; to: number;   // junction ids (-1 = map edge)
  kind: 'lane' | 'turn'; speed: number; next: number[]; turnOf?: [number, number]; group?: number; endDir: P2; startDir: P2;
}

function segIntersect(a: P2, b: P2, c: P2, d: P2): P2 | null {
  const r: P2 = [b[0] - a[0], b[1] - a[1]], s: P2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= -0.02 && t <= 1.02 && u >= -0.02 && u <= 1.02 ? [a[0] + r[0] * t, a[1] + r[1] * t] : null;
}

/** Junctions between car streets (crossings and shared ends), clustered within 7 m. */
export function findJunctions(cars: Street[]): Junction[] {
  const pts: P2[] = [];
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const A = cars[i].points, B = cars[j].points;
    for (let a = 0; a + 1 < A.length; a++) for (let b = 0; b + 1 < B.length; b++) { const x = segIntersect(A[a], A[a + 1], B[b], B[b + 1]); if (x) pts.push(x); }
    for (const e of [A[0], A[A.length - 1]]) if (nearestOn(B, e).d < 2) pts.push(e);
    for (const e of [B[0], B[B.length - 1]]) if (nearestOn(A, e).d < 2) pts.push(e);
  }
  const clusters: P2[][] = [];
  for (const p of pts) {
    const c = clusters.find((cl) => Math.hypot(cl[0][0] - p[0], cl[0][1] - p[1]) < 7);
    if (c) c.push(p); else clusters.push([p]);
  }
  const out: Junction[] = [];
  for (const cl of clusters) {
    const at: P2 = [cl.reduce((s, p) => s + p[0], 0) / cl.length, cl.reduce((s, p) => s + p[1], 0) / cl.length];
    const arms: Junction['arms'] = [];
    cars.forEach((s, si) => {
      const n = nearestOn(s.points, at);
      if (n.d > 4) return;
      const L = lineLength(s.points);
      if (n.s > 3) arms.push({ street: si, s: n.s, dir: neg(alongLine(s.points, Math.max(0, n.s - 3)).dir), out: false });
      if (n.s < L - 3) arms.push({ street: si, s: n.s, dir: alongLine(s.points, n.s + 1).dir, out: true });
    });
    if (arms.length >= 3) out.push({ id: out.length, at, arms, groups: [], sig: -1 });
  }
  // signal groups: arms along the first arm's axis (either way) are group 0, the rest group 1
  for (const J of out) {
    const ax = J.arms[0].dir;
    J.groups = J.arms.map((a) => (Math.abs(a.dir[0] * ax[0] + a.dir[1] * ax[1]) > Math.SQRT1_2 ? 0 : 1));
  }
  return out;
}
const neg = (v: P2): P2 => [-v[0], -v[1]];

/** Car lanes between junctions (both directions, keep right), trimmed back to the stop lines, joined by turn curves (straight on and right turns). */
export function carLanes(ws: WalkSpace, junctions: Junction[], opts: { speed: number }): CarEdge[] {
  const cars = ws.cars;
  const edges: CarEdge[] = [];
  const stationsOf = (si: number) => {
    const L = lineLength(cars[si].points);
    const st: Array<{ s: number; j: number }> = [{ s: 0, j: -1 }, { s: L, j: -1 }];
    for (const J of junctions) for (const a of J.arms) if (a.street === si && !st.some((x) => x.j === J.id)) st.push({ s: a.s, j: J.id });
    st.sort((a, b) => a.s - b.s);
    // a junction at the very end replaces the bare end
    return st.filter((x, i) => !(x.j === -1 && st.some((y) => y.j >= 0 && Math.abs(y.s - x.s) < 4)) || (i === 0 && false));
  };
  const trimAt = (J: Junction | null, si: number) => {
    if (!J) return 0;
    let w = 0;
    for (const a of J.arms) if (a.street !== si) w = Math.max(w, cars[a.street].width / 2);
    return w + 4.2;
  };
  for (let si = 0; si < cars.length; si++) {
    const s = cars[si];
    const st = stationsOf(si);
    const hs = s.heights ?? s.points.map((q) => groundAt(ws.plan.ground, q[0], q[1]));
    for (let k = 0; k + 1 < st.length; k++) {
      const A = st[k], B = st[k + 1];
      const JA = A.j >= 0 ? junctions[A.j] : null, JB = B.j >= 0 ? junctions[B.j] : null;
      const a0 = A.s + trimAt(JA, si), a1 = B.s - trimAt(JB, si);
      if (a1 - a0 < 4) continue;
      for (const dir of [1, -1]) {
        const pts: Array<[number, number, number]> = [];
        const n = Math.max(2, Math.ceil((a1 - a0) / 4) + 1);
        for (let q = 0; q < n; q++) {
          const d = dir > 0 ? a0 + (a1 - a0) * q / (n - 1) : a1 - (a1 - a0) * q / (n - 1);
          const { p, dir: t } = alongLine(s.points, d);
          const td: P2 = dir > 0 ? t : neg(t);
          const off = s.width / 4;
          const x = p[0] - td[1] * off, z = p[1] + td[0] * off;
          const ni = nearestOn(s.points, p);
          const y = hs[ni.i] + (hs[Math.min(ni.i + 1, hs.length - 1)] - hs[ni.i]) * ni.u + roadLift(s);
          pts.push([x, y, z]);
        }
        const from = dir > 0 ? A.j : B.j, to = dir > 0 ? B.j : A.j;
        const sd = norm2([pts[1][0] - pts[0][0], pts[1][2] - pts[0][2]]), ed = norm2([pts[n - 1][0] - pts[n - 2][0], pts[n - 1][2] - pts[n - 2][2]]);
        edges.push({ id: edges.length, pts, street: si, from, to, kind: 'lane', speed: opts.speed * (s.kind === 'residential' ? 0.8 : 1), next: [], startDir: sd, endDir: ed });
      }
    }
  }
  // turn curves at junctions: straight on and right turns only (no left turns: no head-on conflicts)
  const lanes = edges.slice();
  for (const J of junctions) {
    const ins = lanes.filter((e) => e.to === J.id), outs = lanes.filter((e) => e.from === J.id);
    for (const a of ins) {
      for (const b of outs) {
        if (b.street === a.street && dot2(a.endDir, b.startDir) < -0.5) continue;      // U-turn
        const cross = a.endDir[0] * b.startDir[1] - a.endDir[1] * b.startDir[0];
        const d = dot2(a.endDir, b.startDir);
        const straight = d > 0.85, right = cross > 0.5;
        if (!straight && !right) continue;
        const P0 = a.pts[a.pts.length - 1], P1 = b.pts[0];
        // control point: where the two lane lines meet (or the midpoint for straight on)
        let C: [number, number] = [(P0[0] + P1[0]) / 2, (P0[2] + P1[2]) / 2];
        if (!straight) {
          const x = lineMeet([P0[0], P0[2]], a.endDir, [P1[0], P1[2]], b.startDir);
          if (x) C = x;
        }
        const pts: Array<[number, number, number]> = [];
        const N = straight ? 4 : 8;
        for (let q = 0; q <= N; q++) {
          const t = q / N, u = 1 - t;
          pts.push([u * u * P0[0] + 2 * u * t * C[0] + t * t * P1[0], P0[1] + (P1[1] - P0[1]) * t, u * u * P0[2] + 2 * u * t * C[1] + t * t * P1[2]]);
        }
        const e: CarEdge = { id: edges.length, pts, street: a.street, from: J.id, to: J.id, kind: 'turn', speed: opts.speed * (straight ? 0.9 : 0.45), next: [b.id], turnOf: [a.id, b.id], startDir: a.endDir, endDir: b.startDir };
        edges.push(e);
        a.next.push(e.id);
      }
    }
  }
  return edges;
}
const dot2 = (a: P2, b: P2) => a[0] * b[0] + a[1] * b[1];
const norm2 = (v: P2): P2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
function lineMeet(p: P2, d: P2, q: P2, e: P2): P2 | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den;
  if (t < 0 || t > 30) return null;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

// ── the walking graph ─────────────────────────────────────────────────────────
export interface WalkNode { id: number; p: P2; y: number; chain: number; park?: boolean }
export interface WalkEdge { a: number; b: number; len: number; hw: number; cross?: { sig: number; group: number } }
export interface WalkGraph { nodes: WalkNode[]; edges: WalkEdge[]; adj: number[][] }

export function walkGraph(ws: WalkSpace, junctions: Junction[], extra: Array<{ p: P2; chain: number }> = []): WalkGraph {
  const nodes: WalkNode[] = [];
  const edges: WalkEdge[] = [];
  const add = (p: P2, chain: number, park = false) => { nodes.push({ id: nodes.length, p, y: ws.heightAt(p), chain, ...(park ? { park } : {}) }); return nodes.length - 1; };
  const link = (a: number, b: number, cross?: WalkEdge['cross']): boolean => {
    if (a === b || edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))) return false;
    const A = nodes[a].p, B = nodes[b].p, len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    if (!cross) {
      // a link over a carriageway is a crossing (it can only be on a crosswalk): carry its signal
      const n = Math.max(1, Math.ceil(len / 0.4));
      for (let i = 0; i <= n && !cross; i++) {
        const q: P2 = [A[0] + (B[0] - A[0]) * i / n, A[1] + (B[1] - A[1]) * i / n];
        if (!ws.onRoad(q, 0)) continue;
        const k = ws.crossings.findIndex((r) => inRect(q, r));
        if (k < 0) return false;
        cross = ws.crossInfo[k];
      }
    }
    const dir: P2 = [(B[0] - A[0]) / (len || 1), (B[1] - A[1]) / (len || 1)];
    const hw = cross ? 1.3 : Math.min(...[0, 0.17, 0.33, 0.5, 0.67, 0.83, 1].map((t) => ws.freeHalf([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], dir)));
    if (hw < 0.55) return false;
    edges.push({ a, b, len, hw, ...(cross ? { cross } : {}) });
    return true;
  };
  let chain = 0;
  // sidewalk chains (both sides) and pedestrian streets
  for (const s of ws.walkers) {
    const L = lineLength(s.points);
    const sides = isPed(s) ? [0] : [-1, 1];
    for (const side of sides) {
      let prev = -1;
      const n = Math.max(2, Math.ceil(L / 5) + 1);
      for (let q = 0; q < n; q++) {
        const { p, dir } = alongLine(s.points, (L * q) / (n - 1));
        // the middle of the walkable run across the sidewalk (buildings can stand on its outer half)
        let at: P2 | null = null;
        if (side === 0) { at = p; if (!ws.walkable(at)) at = null; }
        else {
          let r0 = -1, r1 = -1;
          for (let o = s.width / 2 + 0.4; o <= s.width / 2 + s.sidewalk + 0.6; o += 0.25) {
            const c: P2 = [p[0] - dir[1] * o * side, p[1] + dir[0] * o * side];
            if (ws.walkable(c)) { if (r0 < 0) r0 = o; r1 = o; } else if (r0 >= 0) break;
          }
          if (r0 >= 0 && r1 - r0 >= 0.9) { const o = (r0 + r1) / 2; at = [p[0] - dir[1] * o * side, p[1] + dir[0] * o * side]; }
        }
        if (!at) { prev = -1; continue; }
        const id = add(at, chain);
        if (prev >= 0 && ws.segWalkable(nodes[prev].p, at)) link(prev, id);
        prev = id;
      }
      chain++;
    }
  }
  // crossings at junctions: across each arm's carriageway, just outside the other street
  for (const J of junctions) {
    J.arms.forEach((arm, ai) => {
      if (!arm.out) { /* both directions of an arm share one crossing: use the outward one */ }
      const s = ws.cars[arm.street];
      if (s.sidewalk < 1.2) return;
      let other = 0;
      for (const a of J.arms) if (a.street !== arm.street) other = Math.max(other, ws.cars[a.street].width / 2);
      const d = other + 1.9;
      const dir = arm.dir;
      const c: P2 = [J.at[0] + dir[0] * d, J.at[1] + dir[1] * d];
      // skip a second crossing on the same arm (an arm can be listed in and out on a through street)
      const rect: Rect = { c, dir: [-dir[1], dir[0]], len: s.width + 0.6, wid: 2.8 };
      if (ws.crossings.some((r) => Math.hypot(r.c[0] - c[0], r.c[1] - c[1]) < 3)) return;
      const e1: P2 = [c[0] - dir[1] * (s.width / 2 + Math.min(1.4, s.sidewalk / 2)), c[1] + dir[0] * (s.width / 2 + Math.min(1.4, s.sidewalk / 2))];
      const e2: P2 = [c[0] + dir[1] * (s.width / 2 + Math.min(1.4, s.sidewalk / 2)), c[1] - dir[0] * (s.width / 2 + Math.min(1.4, s.sidewalk / 2))];
      ws.crossings.push(rect);
      ws.crossInfo.push(J.sig >= 0 ? { sig: J.sig, group: J.groups[ai] } : { sig: -1, group: 0 });
      if (!ws.walkable(e1) || !ws.walkable(e2)) { ws.crossings.pop(); ws.crossInfo.pop(); return; }
      const a = add(e1, chain), b = add(e2, chain);
      chain++;
      link(a, b, J.sig >= 0 ? { sig: J.sig, group: J.groups[ai] } : { sig: -1, group: 0 });
    });
  }
  // plazas and parks: a loose grid
  for (const pk of ws.parks) {
    const ids = new Map<string, number>();
    for (let x = Math.ceil(pk.min[0] / 6) * 6; x <= pk.max[0]; x += 6) for (let z = Math.ceil(pk.min[1] / 6) * 6; z <= pk.max[1]; z += 6) {
      const p: P2 = [x, z];
      if (!pointInPoly(p, pk.poly) || !ws.walkable(p)) continue;
      ids.set(`${x},${z}`, add(p, chain, true));
    }
    for (const [k, id] of ids) {
      const [x, z] = k.split(',').map(Number);
      for (const [dx, dz] of [[6, 0], [0, 6], [6, 6], [6, -6]]) { const o = ids.get(`${x + dx},${z + dz}`); if (o !== undefined && ws.segWalkable(nodes[id].p, nodes[o].p)) link(id, o); }
    }
    chain++;
  }
  for (const e of extra) add(e.p, e.chain >= 0 ? e.chain : chain++);
  // stitch: join nearby nodes of different chains where the straight line stays walkable (corners, plazas, crossings, piers)
  const cell = 8, grid = new Map<string, number[]>();
  for (const n of nodes) { const k = `${Math.floor(n.p[0] / cell)},${Math.floor(n.p[1] / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(n.id); }
  for (const n of nodes) {
    const gx = Math.floor(n.p[0] / cell), gz = Math.floor(n.p[1] / cell);
    const near: Array<{ id: number; d: number }> = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const id of grid.get(`${gx + i},${gz + j}`) ?? []) {
      const o = nodes[id];
      if (o.id <= n.id || o.chain === n.chain) continue;
      const d = Math.hypot(o.p[0] - n.p[0], o.p[1] - n.p[1]);
      if (d < 7.5) near.push({ id, d });
    }
    near.sort((a, b) => a.d - b.d);
    let made = 0;
    for (const c of near) {
      if (made >= 3) break;
      if (ws.segWalkable(n.p, nodes[c.id].p, 0.3) && link(n.id, c.id)) made++;
    }
  }
  // bridge islands: join every small component to the main one where a short straight walk exists
  for (let pass = 0; pass < 3; pass++) {
    const comp = components(nodes.length, edges);
    const sizes = new Map<number, number>();
    for (const c of comp) sizes.set(c, (sizes.get(c) ?? 0) + 1);
    const main = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const done = new Set<number>();
    for (const n of nodes) {
      const c = comp[n.id];
      if (c === main || done.has(c)) continue;
      const members = nodes.filter((m) => comp[m.id] === c);
      const cand: Array<{ a: number; b: number; d: number }> = [];
      for (const m of members) for (const o of nodes) {
        if (comp[o.id] !== main) continue;
        const d = Math.hypot(o.p[0] - m.p[0], o.p[1] - m.p[1]);
        if (d < 18) cand.push({ a: m.id, b: o.id, d });
      }
      cand.sort((x, y) => x.d - y.d);
      let made = 0;
      for (const c2 of cand.slice(0, 400)) {
        if (made >= 2) break;
        if (ws.segWalkable(nodes[c2.a].p, nodes[c2.b].p, 0.3) && link(c2.a, c2.b)) made++;
      }
      if (process.env.LIFE_DEBUG && members.length > 30) console.log('bridge', members.length, made, cand.length);
      done.add(c);
    }
  }
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  return { nodes, edges, adj };
}

/** Shortest walk between two nodes (Dijkstra; crossings cost a little extra so folk don't zig-zag). */
export function shortestWalk(g: WalkGraph, from: number, to: number): number[] | null {
  const dist = new Float64Array(g.nodes.length).fill(Infinity), prev = new Int32Array(g.nodes.length).fill(-1);
  // binary heap of [cost, node]
  const hc: number[] = [0], hn: number[] = [from];
  const push = (c: number, n: number) => { hc.push(c); hn.push(n); let i = hc.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hc[p] <= hc[i]) break; [hc[p], hc[i]] = [hc[i], hc[p]]; [hn[p], hn[i]] = [hn[i], hn[p]]; i = p; } };
  const pop = (): [number, number] => {
    const top: [number, number] = [hc[0], hn[0]];
    const lc = hc.pop()!, ln = hn.pop()!;
    if (hc.length) { hc[0] = lc; hn[0] = ln; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hc.length && hc[l] < hc[m]) m = l; if (r < hc.length && hc[r] < hc[m]) m = r; if (m === i) break; [hc[m], hc[i]] = [hc[i], hc[m]]; [hn[m], hn[i]] = [hn[i], hn[m]]; i = m; } }
    return top;
  };
  dist[from] = 0;
  while (hc.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    if (u === to) break;
    for (const ei of g.adj[u]) {
      const e = g.edges[ei], v = e.a === u ? e.b : e.a;
      const nd = d + e.len + (e.cross ? 12 : 0);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(nd, v); }
    }
  }
  if (!isFinite(dist[to])) return null;
  const out = [to];
  while (out[out.length - 1] !== from) out.push(prev[out[out.length - 1]]);
  return out.reverse();
}

export function edgeBetween(g: WalkGraph, a: number, b: number): WalkEdge | undefined {
  for (const ei of g.adj[a]) { const e = g.edges[ei]; if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e; }
  return undefined;
}

export { centroid };

export function components(n: number, edges: WalkEdge[]): Int32Array {
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const e of edges) { const a = find(e.a), b = find(e.b); if (a !== b) parent[a] = b; }
  return parent.map((_, i) => find(i));
}
