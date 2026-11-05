// The life runtime (Decision 30): folk, dogs, cars and a bus going about a seeded day on one baked set of
// paths and lanes. This TypeScript file is the web runtime AND the reference the headless day runs; the
// GDScript port (packages/game/templates/godot/studio/life.gd) follows it line by line, so the same seed
// gives the same day in both engines (D30's tripwire: within 0.5 m).
//
// Rules for keeping the two in step: a fixed 0.1 s tick; plain arrays in index order (never maps); only
// sqrt, atan2, sin, cos, floor, fmod; no randomness here (the bake made every choice).
// Copied unchanged into games as studio/life.ts (`studio life-bake` writes it next to life.json).

export const LIFE_DT = 0.1;
export const SIT_BLEND = 0.8;                         // s to settle into (or rise from) a seat or a spot
export const LEASH = { max: 2.0, min: 0.55, trail: 1.1 };
export const FRIENDS = 0.42;                          // m between two friends' centres (they walk close)
export const IDM = { T: 1.2, s0: 2.2, a: 1.6, b: 2.6 };

// ── data (life.json, written by the bake) ───────────────────────────────────
export interface LifeSignal { id: string; at: [number, number]; cycle: number; offset: number; green: [number, number]; amber: number; allRed: number }
export interface LifeEdge { id: string; pts: number[]; speed: number; stop?: { sig: number; group: number }; bus?: number[]; turn?: boolean; conf?: number[]; jn?: number }
export interface LifeCross { s0: number; s1: number; sig: number; group: number }
export interface LifeMove { k: 'move'; t: number; p: number; cross?: LifeCross[] }
export interface LifeAct { k: 'act'; t: number; t1: number; at: [number, number, number]; face: number; pose: string; slot: number; place?: string; pal?: [number, number, number] }
export type LifeSeg = LifeMove | LifeAct;
export interface LifeAgent { id: string; town?: number; kind: 'person' | 'dog'; r: number; speed: number; owner?: number; lane?: number; pal?: number; model: string; tint?: string; scale?: number; plan: LifeSeg[] }
export interface LifeTrip { t: number; edges: number[] }
export interface LifeVehicle { id: string; town?: number; kind: 'car' | 'bus'; len: number; wid: number; model: string; tint?: string; loop?: boolean; trips: LifeTrip[] }
export interface LifeData {
  version: 1; dt: number; start: number; slots: number;
  signals: LifeSignal[]; edges: LifeEdge[]; paths: number[][]; agents: LifeAgent[]; vehicles: LifeVehicle[];
  [k: string]: unknown;
}

// ── state ───────────────────────────────────────────────────────────────────
export interface AgentState {
  visible: boolean; seg: number; s: number; lat: number; v: number;
  x: number; y: number; z: number; yaw: number; pose: string;
  actStart: number; actEnd: number; moveStart: number; fromX: number; fromY: number; fromZ: number;
  slot: number; blocked: number; wait: boolean; stay: boolean; onCross: boolean;
  fx: number; fz: number;                 // the walking frame: turns smoothly, so a sharp corner never flips our side
  slip: number;                           // until then, a head-on pair stuck in a pinch may slip past each other
  nearCross: boolean;
  back: number;                           // until then, step back off a crossing                     // on a crossing or within 3 m of stepping onto one
  bl: number;                             // seconds to blend into (or out of) a spot: longer for a longer step, so nobody pops
}
export interface VehicleState { visible: boolean; trip: number; leg: number; s: number; v: number; x: number; y: number; z: number; yaw: number; dwell: number; stopDone: number; brake: boolean; waitUntil: number }

interface PathInfo { pts: number[]; cum: number[]; len: number }

function buildCum(pts: number[], stride: number): number[] {
  const cum = [0];
  const n = Math.floor(pts.length / stride);
  for (let i = 1; i < n; i++) {
    const dx = pts[i * stride] - pts[(i - 1) * stride], dz = pts[i * stride + 2] - pts[(i - 1) * stride + 2];
    cum.push(cum[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  return cum;
}

/** Index of the segment holding arc length s (binary search). */
function segAt(cum: number[], s: number): number {
  let lo = 0, hi = cum.length - 1;
  if (s <= 0) return 0;
  if (s >= cum[hi]) return hi - 1;
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (cum[m] <= s) lo = m; else hi = m; }
  return lo;
}

/** A point on a polyline at arc length s: [x, y, z, hw] (hw only for stride 4). */
function pointAt(p: PathInfo, stride: number, s: number): number[] {
  const n = p.cum.length;
  if (n < 2) return [p.pts[0], p.pts[1], p.pts[2], stride > 3 ? p.pts[3] : 0];
  const i = segAt(p.cum, s);
  const L = p.cum[i + 1] - p.cum[i];
  let u = L > 1e-9 ? (s - p.cum[i]) / L : 0;
  if (u < 0) u = 0;
  if (u > 1) u = 1;
  const a = i * stride, b = (i + 1) * stride;
  return [
    p.pts[a] + (p.pts[b] - p.pts[a]) * u,
    p.pts[a + 1] + (p.pts[b + 1] - p.pts[a + 1]) * u,
    p.pts[a + 2] + (p.pts[b + 2] - p.pts[a + 2]) * u,
    stride > 3 ? p.pts[a + 3] + (p.pts[b + 3] - p.pts[a + 3]) * u : 0,
  ];
}

/** Unit travel direction at s, from a chord around it (smooth through polyline corners). */
function dirAt(p: PathInfo, stride: number, s: number): number[] {
  const a = pointAt(p, stride, s - 0.6), b = pointAt(p, stride, s + 0.6);
  let dx = b[0] - a[0], dz = b[2] - a[2];
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l < 1e-6) {
    const i = segAt(p.cum, s);
    dx = p.pts[(i + 1) * stride] - p.pts[i * stride]; dz = p.pts[(i + 1) * stride + 2] - p.pts[i * stride + 2];
    const l2 = Math.sqrt(dx * dx + dz * dz) || 1;
    return [dx / l2, dz / l2];
  }
  return [dx / l, dz / l];
}

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
/** Distance from a point to a vehicle's footprint (0 inside). */
export function boxDist(px: number, pz: number, x: number, z: number, yaw: number, len: number, wid: number): number {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), dx = px - x, dz = pz - z;
  const u = dx * fx + dz * fz, w = dx * fz - dz * fx;
  const cu = clamp(u, -len / 2, len / 2), cw = clamp(w, -wid / 2, wid / 2);
  return Math.sqrt((u - cu) * (u - cu) + (w - cw) * (w - cw));
}
/** Is a circle (px, pz, r) touching a vehicle's footprint (centre, yaw, length, width)? */
export function inBox(px: number, pz: number, r: number, x: number, z: number, yaw: number, len: number, wid: number): boolean {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), dx = px - x, dz = pz - z;
  const u = dx * fx + dz * fz, w = dx * fz - dz * fx;
  const cu = clamp(u, -len / 2, len / 2), cw = clamp(w, -wid / 2, wid / 2);
  return (u - cu) * (u - cu) + (w - cw) * (w - cw) < r * r;
}
/** Do two vehicle footprints (centre, yaw, length, width) overlap? (separating axes) */
export function boxesTouch(ax: number, az: number, ay: number, al: number, aw: number, bx: number, bz: number, by: number, bl: number, bw: number): boolean {
  const A = [Math.sin(ay), Math.cos(ay)], B = [Math.sin(by), Math.cos(by)];
  const axes = [A[0], A[1], A[1], -A[0], B[0], B[1], B[1], -B[0]];
  const dx = bx - ax, dz = bz - az;
  for (let k = 0; k < 8; k += 2) {
    const ux = axes[k], uz = axes[k + 1];
    const ra = Math.abs(A[0] * ux + A[1] * uz) * al / 2 + Math.abs(A[1] * ux - A[0] * uz) * aw / 2;
    const rb = Math.abs(B[0] * ux + B[1] * uz) * bl / 2 + Math.abs(B[1] * ux - B[0] * uz) * bw / 2;
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}
function angleTo(from: number, to: number, maxStep: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return from + clamp(d, -maxStep, maxStep);
}

export const GREEN = 0, AMBER = 1, RED = 2;

export class LifeRuntime {
  data: LifeData;
  t = 0;
  paths: PathInfo[] = [];
  edges: PathInfo[] = [];
  agents: AgentState[] = [];
  vehicles: VehicleState[] = [];
  slotBusy: number[] = [];
  player = { x: 0, z: 0, r: 0.4, on: false };
  prevX: number[] = [];
  prevZ: number[] = [];

  constructor(data: LifeData) {
    this.data = data;
    for (const p of data.paths) { const cum = buildCum(p, 4); this.paths.push({ pts: p, cum, len: cum[cum.length - 1] }); }
    for (const e of data.edges) { const cum = buildCum(e.pts, 3); this.edges.push({ pts: e.pts, cum, len: cum[cum.length - 1] }); }
  }

  /** Signal colour for a group at time t. */
  signal(sig: number, group: number, t: number): number {
    const S = this.data.signals[sig];
    let u = (t + S.offset) % S.cycle;
    if (u < 0) u += S.cycle;
    const a0 = S.green[0], a1 = a0 + S.amber, a2 = a1 + S.allRed, b0 = a2 + S.green[1], b1 = b0 + S.amber;
    if (group === 0) return u < a0 ? GREEN : u < a1 ? AMBER : RED;
    return u >= a2 && u < b0 ? GREEN : u >= b0 && u < b1 ? AMBER : RED;
  }
  /** Walkers crossing a street of `group` may start while the other group has a green with 5 s left. */
  walkOk(sig: number, group: number, t: number): boolean {
    if (sig < 0) return true;
    const S = this.data.signals[sig];
    let u = (t + S.offset) % S.cycle;
    if (u < 0) u += S.cycle;
    const a2 = S.green[0] + S.amber + S.allRed;
    if (group === 1) return u < S.green[0] - 5;           // crossing a group-1 street: walk with group 0's green
    return u >= a2 && u < a2 + S.green[1] - 5;
  }

  setPlayer(x: number, z: number, r: number, on: boolean) { this.player.x = x; this.player.z = z; this.player.r = r; this.player.on = on; }

  /** Start the day at t0: everyone where their plan has them W s earlier, then W s of real simulation. */
  init(t0: number, warm = 60) {
    const ts = t0 - warm;
    this.t = ts;
    this.agents = []; this.vehicles = []; this.slotBusy = [];
    for (let i = 0; i < this.data.slots; i++) this.slotBusy.push(-1);
    for (let i = 0; i < this.data.agents.length; i++) this.agents.push(this.freshAgent());
    for (let i = 0; i < this.data.agents.length; i++) this.placeByPlan(i, ts);
    for (let i = 0; i < this.data.vehicles.length; i++) this.vehicles.push({ visible: false, trip: this.firstTrip(i, ts), leg: 0, s: 0, v: 0, x: 0, y: 0, z: 0, yaw: 0, dwell: 0, stopDone: -1, brake: false, waitUntil: 0 });
    const n = Math.round(warm / LIFE_DT);
    for (let k = 0; k < n; k++) this.step();
  }

  freshAgent(): AgentState {
    return { visible: false, seg: -1, s: 0, lat: 0, v: 0, x: 0, y: 0, z: 0, yaw: 0, pose: 'idle', actStart: 0, actEnd: 0, moveStart: 0, fromX: 0, fromY: 0, fromZ: 0, slot: -1, blocked: 0, wait: false, stay: false, onCross: false, fx: 0, fz: 1, slip: 0, bl: SIT_BLEND, nearCross: false, back: 0 };
  }

  firstTrip(i: number, t: number): number {
    const V = this.data.vehicles[i];
    if (V.loop) return 0;
    for (let k = 0; k < V.trips.length; k++) if (V.trips[k].t >= t - 5) return k;
    return V.trips.length;
  }

  placeByPlan(i: number, t: number) {
    const A = this.data.agents[i], st = this.agents[i];
    if (A.kind === 'dog') return;                         // dogs follow their walker (placed in step)
    st.seg = -1; st.visible = false;
    let last = -1;
    for (let k = 0; k < A.plan.length; k++) {
      const g = A.plan[k];
      if (g.t > t) break;
      last = k;
      const end = g.k === 'act' ? g.t1 : g.t + this.paths[g.p].len / A.speed;
      if (t < end) {
        st.seg = k; st.visible = true;
        if (g.k === 'move') {
          st.s = (t - g.t) * A.speed; st.moveStart = g.t - 10;
          const P = pointAt(this.paths[g.p], 4, st.s);
          st.lat = Math.min(0.4, P[3] * 0.4);
          this.placeOnPath(i, g.p);
          st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z;
        } else this.placeAct(i, g);
        return;
      }
    }
    if (last < 0) return;                                   // not out yet
    if (last === A.plan.length - 1) { st.seg = A.plan.length; return; }   // the day is over: indoors
    // between two segments (a walk that ended early): stand where the last one left us
    const g = A.plan[last];
    st.seg = last; st.visible = true;
    if (g.k === 'move') {
      st.s = this.paths[g.p].len; st.moveStart = g.t - 10; st.lat = 0;
      this.placeOnPath(i, g.p);
      st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z;
    } else this.placeAct(i, g);
  }

  placeAct(i: number, g: LifeAct) {
    const st = this.agents[i];
    st.actStart = g.t - 10; st.actEnd = g.t1; st.visible = g.pose !== 'inside';
    st.x = g.at[0]; st.y = g.at[1]; st.z = g.at[2]; st.yaw = g.face; st.pose = g.pose;
    st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z;
    if (g.slot >= 0) { if (this.slotBusy[g.slot] < 0) { this.slotBusy[g.slot] = i; st.slot = g.slot; } else { st.pose = 'idle'; } }
  }

  placeOnPath(i: number, p: number) {
    const st = this.agents[i];
    const P = pointAt(this.paths[p], 4, st.s), D = dirAt(this.paths[p], 4, st.s);
    st.fx = D[0]; st.fz = D[1];
    // right of travel (x east, z south, y up): (-dz, dx) — lat > 0 keeps right
    st.x = P[0] - D[1] * st.lat; st.z = P[2] + D[0] * st.lat; st.y = P[1];
  }

  step() {
    const dt = LIFE_DT;
    this.prevX = []; this.prevZ = [];
    for (let i = 0; i < this.agents.length; i++) { this.prevX.push(this.agents[i].x); this.prevZ.push(this.agents[i].z); }
    for (let i = 0; i < this.agents.length; i++) if (this.data.agents[i].kind === 'person' && this.data.agents[i].owner === undefined) this.stepPerson(i, dt);
    for (let i = 0; i < this.agents.length; i++) if (this.data.agents[i].kind === 'person' && this.data.agents[i].owner !== undefined) this.stepBuddy(i, dt);
    for (let i = 0; i < this.agents.length; i++) if (this.data.agents[i].kind === 'dog') this.stepDog(i, dt);
    for (let i = 0; i < this.vehicles.length; i++) this.stepVehicle(i, dt);
    this.t += dt;
  }

  // ── people ────────────────────────────────────────────────────────────────
  nextSeg(i: number) {
    const A = this.data.agents[i], st = this.agents[i];
    if (st.slot >= 0) { this.slotBusy[st.slot] = -1; st.slot = -1; }
    const wasMove = st.seg >= 0 && st.seg < A.plan.length && A.plan[st.seg].k === 'move';
    st.seg += 1;
    if (st.seg >= A.plan.length) { st.visible = false; st.seg = A.plan.length; return; }
    const g = A.plan[st.seg];
    st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z; st.stay = false; st.blocked = 0;
    if (g.k === 'move') {
      st.s = 0; st.blocked = 0; st.wait = false;
      // walking on from one leg into the next: carry on where we are (no blend, keep our side)
      st.bl = SIT_BLEND;
      if (wasMove) {
        st.moveStart = this.t - 10;
        const P0 = pointAt(this.paths[g.p], 4, 0);
        st.lat = clamp((st.x - P0[0]) * -st.fz + (st.z - P0[2]) * st.fx, -P0[3] + A.r, P0[3] - A.r);
        // a narrower walk ahead: ease over to our new side instead of jumping there
        const bx = P0[0] - st.fz * st.lat - st.x, bz = P0[2] + st.fx * st.lat - st.z, bd = Math.sqrt(bx * bx + bz * bz);
        if (bd > 0.15) { st.moveStart = this.t; st.bl = Math.max(0.4, bd / 1.1); }
      } else {
        st.moveStart = this.t; st.lat = 0; const D0 = dirAt(this.paths[g.p], 4, 0); st.fx = D0[0]; st.fz = D0[1];
        const P0 = pointAt(this.paths[g.p], 4, 0), bx = P0[0] - st.x, bz = P0[2] - st.z;
        st.bl = Math.max(SIT_BLEND, Math.sqrt(bx * bx + bz * bz) / 1.1);
      }
    }
    else {
      st.actStart = this.t; st.actEnd = Math.max(g.t1, this.t + 3);
      st.pose = g.pose;
      { const bx = g.at[0] - st.x, bz = g.at[2] - st.z; st.bl = Math.max(SIT_BLEND, Math.sqrt(bx * bx + bz * bz) / 1.1); }
      if (g.pose === 'inside') { st.visible = false; st.actEnd = g.t1; }
      if (g.slot >= 0) {
        if (this.slotBusy[g.slot] < 0) { this.slotBusy[g.slot] = i; st.slot = g.slot; }
        else { st.actEnd = this.t + 2; st.pose = 'idle'; st.slot = -1; st.stay = true; }   // taken: shrug and move on
      }
    }
  }

  stepPerson(i: number, dt: number) {
    const A = this.data.agents[i], st = this.agents[i];
    if (st.seg >= A.plan.length) return;
    if (st.seg < 0) {
      if (A.plan.length && this.t >= A.plan[0].t) { this.nextSeg(i); st.visible = false; }
      return;
    }
    const g = A.plan[st.seg];
    if (g.k === 'move' && !st.visible) {
      // coming out of a door: only when nobody stands in it
      if (this.t < g.t) return;
      const P0 = pointAt(this.paths[g.p], 4, 0);
      for (let j = 0; j < this.agents.length; j++) {
        if (j === i || !this.agents[j].visible) continue;
        const dx = this.agents[j].x - P0[0], dz = this.agents[j].z - P0[2], r = A.r + this.data.agents[j].r + 0.1;
        if (dx * dx + dz * dz < r * r) return;
      }
      st.visible = true; st.s = 0; st.lat = 0; st.v = 0;
      this.placeOnPath(i, g.p);
      st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z; st.moveStart = this.t - 10; st.bl = SIT_BLEND; st.yaw = this.headingOf(g.p, 0);
      return;
    }
    if (g.k === 'act') {
      if (g.pose === 'inside') { st.v = 0; if (this.t >= st.actEnd) this.nextSeg(i); return; }
      let k = st.stay ? 0 : clamp((this.t - st.actStart) / st.bl, 0, 1);
      if (k > 0 && k < 1 + dt / st.bl) {
        // settling into the spot: wait while someone stands in it
        const cx = st.fromX + (g.at[0] - st.fromX) * k, cz = st.fromZ + (g.at[2] - st.fromZ) * k;
        for (let j = 0; j < this.agents.length; j++) {
          if (j === i || !this.agents[j].visible || (this.data.agents[j].owner === i && this.data.agents[j].kind === 'dog')) continue;
          const r = A.r + this.data.agents[j].r;
          const dx = this.agents[j].x - cx, dz = this.agents[j].z - cz, ex = this.agents[j].x - st.x, ez = this.agents[j].z - st.z;
          if (dx * dx + dz * dz < r * r && dx * dx + dz * dz < ex * ex + ez * ez) {
            st.actStart += dt; st.actEnd += dt; st.blocked += dt;
            k = clamp((this.t - st.actStart) / st.bl, 0, 1);
            if (st.blocked > 4) { st.actEnd = this.t; st.stay = true; k = 0; st.fromX = st.x; st.fromY = st.y; st.fromZ = st.z; }   // give up where we stand
            break;
          }
        }
      }
      st.x = st.fromX + (g.at[0] - st.fromX) * k; st.y = st.fromY + (g.at[1] - st.fromY) * k; st.z = st.fromZ + (g.at[2] - st.fromZ) * k;
      st.yaw = angleTo(st.yaw, g.face, 4 * dt);
      st.v = 0;
      if (this.t >= st.actEnd) {
        const nx = st.seg + 1 < A.plan.length ? A.plan[st.seg + 1] : null;
        if (!nx || this.t >= nx.t || nx.k !== 'move') this.nextSeg(i);
      }
      return;
    }
    if (this.t < g.t) { st.v = 0; if (this.t - st.moveStart < st.bl) st.moveStart += dt; return; }   // not time yet (waiting where we are; a blend waits too)
    const P = this.paths[g.p];
    const pt = pointAt(P, 4, st.s), Dp = dirAt(P, 4, st.s);
    // turn the walking frame toward the path at most 2.6 rad/s
    const fx0 = st.fx, fz0 = st.fz;
    {
      const a0 = Math.atan2(st.fx, st.fz), a1 = Math.atan2(Dp[0], Dp[1]);
      // (slower far from the middle line, so a wide offset never swings round faster than a step)
      const a = angleTo(a0, a1, Math.min(2.6, 1.6 / Math.max(0.3, Math.abs(st.lat))) * dt);
      st.fx = Math.sin(a); st.fz = Math.cos(a);
    }
    const D = [st.fx, st.fz];
    const hw = pt[3];
    let want = A.speed, latT = Math.min(A.lane ?? 0.45, hw - A.r);  // keep right (each at their own distance from the middle): the two directions use their own sides
    // crossings: wait at the curb for the walk signal
    st.wait = false; st.onCross = false; st.nearCross = false;
    if (g.cross) for (const c of g.cross) {
      if (st.s > c.s0 - 0.2 && st.s < c.s1 + 0.2) st.onCross = true;
      if (st.s > c.s0 - 3 && st.s < c.s1 + 0.2) st.nearCross = true;
      if (st.s < c.s0 - 0.25 && st.s > c.s0 - 2.5) {
        // the walk signal, or (like everyone does) an empty street; and always look both ways
        const signalOk = this.walkOk(c.sig, c.group, this.t);
        let go = true, anyNear = false;
        const M = pointAt(P, 4, (c.s0 + c.s1) / 2);
        for (let j = 0; j < this.vehicles.length; j++) {
          const vv = this.vehicles[j];
          if (!vv.visible) continue;
          const dx = M[0] - vv.x, dz = M[2] - vv.z, d = Math.sqrt(dx * dx + dz * dz);
          const Vd = this.data.vehicles[j];
          if (d < 30) anyNear = true;
          const coming = vv.v > 0.5 && d < 7 + vv.v * 2.5 && dx * Math.sin(vv.yaw) + dz * Math.cos(vv.yaw) > -2;
          // one in the junction, turning (even if it's stopped for someone): it goes first
          const vt = this.tripOf(j), turning = vt !== null && this.data.edges[vt.edges[vv.leg]].turn === true;
          const C0 = pointAt(P, 4, c.s0), C1 = pointAt(P, 4, c.s1);
          const bd = Math.min(boxDist(M[0], M[2], vv.x, vv.z, vv.yaw, Vd.len, Vd.wid), boxDist(C0[0], C0[2], vv.x, vv.z, vv.yaw, Vd.len, Vd.wid), boxDist(C1[0], C1[2], vv.x, vv.z, vv.yaw, Vd.len, Vd.wid));
          if (coming || ((vv.v > 0.05 || turning) && bd < 2.2) || (turning && bd < 6)) { go = false; break; }
        }
        if (!signalOk && anyNear) go = false;
        if (!go) { want = Math.min(want, Math.max(0, (c.s0 - 0.35 - st.s) * 2)); st.wait = true; }
      }
    }
    // out with a friend: wait for them if they've fallen behind
    if (A.pal !== undefined) {
      const b = this.agents[A.pal];
      if (b.visible && b.blocked < 1.5) { const bx = b.x - st.x, bz = b.z - st.z; if (bx * bx + bz * bz > 1.8 * 1.8) want = 0; }
    }
    // others: keep right of oncoming folk, follow slower ones, give the player room
    const rx = -D[1], rz = D[0];
    for (let j = 0; j < this.agents.length; j++) {
      if (j === i) continue;
      const o = this.agents[j];
      if (!o.visible || this.data.agents[j].owner === i) continue;
      const dx = this.prevX[j] - st.x, dz = this.prevZ[j] - st.z;
      const ahead = dx * D[0] + dz * D[1], side = dx * rx + dz * rz;
      if (ahead < -0.3 || ahead > 4) continue;
      const r = A.r + this.data.agents[j].r;
      if (Math.abs(side) < r + 0.35) {
        // the other is on my left (or dead ahead): step right; on my right: pass on their left only where the
        // walk is wide (on a narrow one we queue behind, so the two directions keep to their own sides)
        if (side <= 0.05) latT = Math.max(latT, st.lat + side + r + 0.35);
        else if (hw > 1.2 || st.blocked > 2) latT = Math.min(latT, st.lat + side - r - 0.35);
        if (ahead < r + 0.45 && this.agents[j].v > 0.05) want = Math.min(want, this.agents[j].v * 0.9);
      }
    }
    if (this.player.on) {
      const dx = this.player.x - st.x, dz = this.player.z - st.z;
      const ahead = dx * D[0] + dz * D[1], side = dx * rx + dz * rz;
      const r = A.r + this.player.r;
      if (ahead > -0.3 && ahead < 3 && Math.abs(side) < r + 0.5) {
        if (side <= 0) latT = Math.max(latT, st.lat + side + r + 0.5); else latT = Math.min(latT, st.lat + side - r - 0.5);
        if (ahead < r + 0.4 && Math.abs(side) < r + 0.1) want = 0;   // right in our way: stop (beside us: walk on by)
      }
    }
    latT = clamp(latT, -hw + A.r, hw - A.r);
    const lat0 = st.lat;
    st.lat += clamp(latT - st.lat, -0.7 * dt, 0.7 * dt);
    st.lat = clamp(st.lat, -hw + A.r, hw - A.r);
    // ease in and out
    st.v += clamp(want - st.v, -2.5 * dt, 1.2 * dt);
    if (st.v < 0) st.v = 0;
    // caught on a crossing by a vehicle that stopped for us across our way: step back and let it go
    if (st.onCross && st.blocked > 1.5) {
      for (let j = 0; j < this.vehicles.length; j++) {
        const vv = this.vehicles[j];
        if (vv.visible && vv.v < 0.05 && boxDist(st.x, st.z, vv.x, vv.z, vv.yaw, this.data.vehicles[j].len, this.data.vehicles[j].wid) < A.r + 0.5) { st.back = this.t + 2.5; break; }
      }
    }
    const ns = st.back > this.t ? Math.max(0, st.s - 0.7 * dt) : st.s + st.v * dt;
    if (st.back > this.t) st.v = 0;
    // where that puts us (rising from a seat or a spot: blended from where the act left us)
    const P2 = pointAt(P, 4, ns);
    let cx = P2[0] - D[1] * st.lat, cz = P2[2] + D[0] * st.lat;
    const k = clamp((this.t - st.moveStart) / st.bl, 0, 1);
    if (k < 1) { cx = st.fromX + (cx - st.fromX) * k; cz = st.fromZ + (cz - st.fromZ) * k; }
    // never step into someone (or the player): stay put this tick instead
    let ok = this.free(i, cx, cz);
    let E = dirAt(P, 4, ok ? ns : st.s);
    if (ok) {
      st.s = ns; st.blocked = 0;
      st.x = cx; st.z = cz; st.y = k < 1 ? st.fromY + (P2[1] - st.fromY) * k : P2[1];
    } else {
      st.v = 0; st.blocked += dt;
      if (k < 1) st.moveStart += dt;           // hold the blend too
      // a sidestep on the spot, if that bumps nobody
      const Q = pointAt(P, 4, st.s);
      const sx = Q[0] - D[1] * st.lat, sz = Q[2] + D[0] * st.lat;
      if (k >= 1 && st.lat !== lat0 && this.free(i, sx, sz)) { st.x = sx; st.z = sz; }
      else { st.lat = lat0; st.fx = fx0; st.fz = fz0; }   // held where we stand: so is our frame (no jump when we go on)
      E = dirAt(P, 4, st.s);
    }
    if (st.v > 0.05) st.yaw = angleTo(st.yaw, Math.atan2(E[0], E[1]), 5 * dt);
    st.pose = st.v > 0.05 ? 'walk' : 'idle';
    if (st.s >= P.len - 1e-6) this.nextSeg(i);
  }

  /** May person i stand at (cx, cz)? Nobody (folk, car, player) is closer there than now and inside reach. */
  free(i: number, cx: number, cz: number): boolean {
    const A = this.data.agents[i], st = this.agents[i];
    // held up a while: squeeze past, shoulders brushing (never closer than 0.46 m between centres)
    const squeeze = st.blocked > 2.5 ? 0.46 : -1;
    for (let j = 0; j < this.agents.length; j++) {
      if (j === i || !this.agents[j].visible || (this.data.agents[j].owner === i && this.data.agents[j].kind === 'dog')) continue;
      const o = this.agents[j];
      // two folk face to face in a pinch for 3 s: they turn their shoulders and slip past (2.5 s)
      // (or anyone held up 8 s in a knot: they edge past whoever is in the way)
      if ((st.blocked > 3 && o.blocked > 3 && st.fx * o.fx + st.fz * o.fz < -0.5 && A.owner === undefined && this.data.agents[j].owner === undefined) || st.blocked > 8) { st.slip = this.t + 2.5; o.slip = this.t + 2.5; }
      // still shoulder in shoulder when the slip runs out: it lasts until they're clear
      if (st.slip > this.t && o.slip > this.t) { const cx0 = o.x - st.x, cz0 = o.z - st.z, rr = A.r + this.data.agents[j].r - 0.1; if (cx0 * cx0 + cz0 * cz0 < rr * rr) { st.slip = Math.max(st.slip, this.t + 0.5); o.slip = Math.max(o.slip, this.t + 0.5); } }
      // slipping past: shoulders turned, but never through each other (0.15 m between centres)
      // friends out together walk close (arms brushing: 0.42 m between centres)
      const friends = j === A.pal || j === A.owner;
      const r = friends ? FRIENDS : st.slip > this.t && o.slip > this.t ? 0.15 : squeeze > 0 ? Math.min(squeeze, A.r + this.data.agents[j].r) : A.r + this.data.agents[j].r;
      // current positions: earlier folk this tick have already moved (no two step into one spot)
      const dx = this.agents[j].x - cx, dz = this.agents[j].z - cz, d2 = dx * dx + dz * dz;
      const ex = this.agents[j].x - st.x, ez = this.agents[j].z - st.z;
      // (two slipping past who are already shoulder in shoulder just carry on through)
      if (d2 < r * r && d2 < ex * ex + ez * ez && !(r < 0.2 && ex * ex + ez * ez < 0.04)) return false;
    }
    for (let j = 0; j < this.vehicles.length; j++) {
      const vv = this.vehicles[j];
      if (!vv.visible) continue;
      const Vd = this.data.vehicles[j];
      const dn = boxDist(cx, cz, vv.x, vv.z, vv.yaw, Vd.len, Vd.wid);
      // a stopped car may be passed close (a car stopped for us at the crosswalk: walk on past its nose)
      if (dn < A.r + (vv.v < 0.05 ? 0.06 : 0.2) && dn < boxDist(st.x, st.z, vv.x, vv.z, vv.yaw, Vd.len, Vd.wid)) return false;
    }
    if (this.player.on) {
      const r = A.r + this.player.r + 0.05;
      const dx = this.player.x - cx, dz = this.player.z - cz;
      const ex = this.player.x - st.x, ez = this.player.z - st.z;
      if (dx * dx + dz * dz < r * r && dx * dx + dz * dz < ex * ex + ez * ez) return false;
    }
    return true;
  }

  // ── companions: walk beside their friend (or just behind where it's narrow), stand by them and chat ──
  stepBuddy(i: number, dt: number) {
    const A = this.data.agents[i], st = this.agents[i];
    const w = this.agents[A.owner!], W = this.data.agents[A.owner!];
    st.wait = w.wait; st.onCross = w.onCross;
    if (!w.visible) { st.visible = false; st.seg = -1; st.v = 0; return; }
    const g = w.seg >= 0 && w.seg < W.plan.length ? W.plan[w.seg] : null;
    let tx = st.x, tz = st.z, ty = st.y, face = st.yaw, pose = 'idle';
    if (g && g.k === 'move') {
      const P = this.paths[g.p];
      let s = w.s, lat = w.lat - 0.68;
      // side by side would take the oncoming side, or they're at (or on) a crossing: fall in behind
      if (lat < 0.05 || w.wait || w.nearCross) { s = Math.max(0, w.s - 0.95); lat = w.lat; }
      const Q = pointAt(P, 4, s), E = dirAt(P, 4, s);
      lat = clamp(lat, -Q[3] + A.r, Q[3] - A.r);
      tx = Q[0] - E[1] * lat; tz = Q[2] + E[0] * lat; ty = Q[1]; face = Math.atan2(E[0], E[1]);
      // just setting off (less than a step along): behind them where they stand
      if (s !== w.s && w.s < 0.95) { tx = w.x - w.fx * 0.95; tz = w.z - w.fz * 0.95; ty = w.y; }
    } else if (g && g.k === 'act' && g.pal) {
      // they've stopped (a seat, a stall, a stop, a window): stand at the friend's spot, turned to them, and chat
      tx = g.pal[0]; ty = g.pal[1]; tz = g.pal[2];
      face = Math.atan2(g.at[0] - tx, g.at[2] - tz);
      pose = g.pose === 'fish' ? 'idle' : g.pose === 'browse' ? 'browse' : 'chat';
    } else if (g && g.k === 'act' && g.pose !== 'inside') {
      // no spot of their own: just behind them (a bus stop faces the road, so behind is away from it)
      tx = g.at[0] - Math.sin(g.face) * 0.85; ty = g.at[1]; tz = g.at[2] - Math.cos(g.face) * 0.85;
      face = g.face;
    }
    if (st.seg < 0) {
      // out of the door with them, once there's room
      for (let j = 0; j < this.agents.length; j++) {
        if (j === i || !this.agents[j].visible) continue;
        const ox = this.agents[j].x - tx, oz = this.agents[j].z - tz, r = A.r + this.data.agents[j].r + 0.05;
        if (ox * ox + oz * oz < r * r) { st.visible = false; return; }
      }
      if (this.player.on) { const ox = this.player.x - tx, oz = this.player.z - tz, r = A.r + this.player.r + 0.05; if (ox * ox + oz * oz < r * r) { st.visible = false; return; } }
      for (let j = 0; j < this.vehicles.length; j++) { const vv = this.vehicles[j]; if (vv.visible && boxDist(tx, tz, vv.x, vv.z, vv.yaw, this.data.vehicles[j].len, this.data.vehicles[j].wid) < A.r + 0.3) { st.visible = false; return; } }
      st.x = tx; st.y = ty; st.z = tz; st.yaw = face; st.seg = 0; st.fromX = tx; st.fromY = ty; st.fromZ = tz;
    }
    st.visible = true;
    // our friend is held up and we're right by them: step back out of their way first
    { const lx = st.x - w.x, lz = st.z - w.z, ld = Math.sqrt(lx * lx + lz * lz);
      if (w.blocked > 1.5 && ld < 1.0 && ld > 1e-6) { tx = w.x + lx / ld * 1.3; tz = w.z + lz / ld * 1.3; } }
    const dx = tx - st.x, dz = tz - st.z, d = Math.sqrt(dx * dx + dz * dz);
    const stp = Math.min(d, A.speed * 1.35 * dt);
    let moved = 0;
    if (d > 1e-6) {
      const nx = st.x + dx / d * stp, nz = st.z + dz / d * stp;
      if (this.free(i, nx, nz)) { st.x = nx; st.z = nz; moved = stp; st.blocked = 0; } else st.blocked += dt;
    }
    // lost them in a crowd: slip away (the view fades us) and catch up with them out of sight
    if (st.blocked > 8 && d > 3) { st.visible = false; st.seg = -1; st.blocked = 0; st.v = 0; return; }
    st.y += clamp(ty - st.y, -1.5 * dt, 1.5 * dt);
    st.v = moved / dt;
    if (st.v > 0.1 && d > 0.05) st.yaw = angleTo(st.yaw, Math.atan2(dx, dz), 5 * dt); else st.yaw = angleTo(st.yaw, face, 3 * dt);
    st.fx = Math.sin(st.yaw); st.fz = Math.cos(st.yaw);
    st.pose = st.v > 0.05 ? 'walk' : d < 0.3 ? pose : 'idle';
  }

  headingOf(p: number, s: number): number { const D = dirAt(this.paths[p], 4, s); return Math.atan2(D[0], D[1]); }

  // ── dogs: on a leash behind their walker, sniffing side to side ─────────────
  stepDog(i: number, dt: number) {
    const A = this.data.agents[i], st = this.agents[i];
    const w = this.agents[A.owner!], W = this.data.agents[A.owner!];
    st.visible = w.visible;
    if (!w.visible) { st.seg = -1; return; }
    let tx: number, tz: number, ty: number, face: number;
    const g = W.plan[w.seg];
    let sitting = false;
    if (g && g.k === 'move' && this.t >= g.t) {
      const P = this.paths[g.p];
      const back = Math.max(0, w.s - LEASH.trail);
      const Q = pointAt(P, 4, back), E = dirAt(P, 4, back);
      const hw = Q[3];
      const wob = Math.sin(this.t * 0.9 + i * 1.7) * 0.45;
      const lat = clamp(w.lat + wob - 0.2, -hw + A.r, hw - A.r);
      tx = Q[0] - E[1] * lat; tz = Q[2] + E[0] * lat; ty = Q[1]; face = Math.atan2(E[0], E[1]);
    } else {
      // walker standing or seated: sit at their feet, a little to the right of where they face
      const fx = Math.sin(w.yaw), fz = Math.cos(w.yaw);
      tx = w.x + fx * 0.75 - fz * 0.35; tz = w.z + fz * 0.75 + fx * 0.35; ty = w.y; face = w.yaw + Math.PI * 0.5;
      if (g && g.k === 'act') { ty = g.at[1] - (g.pose === 'sit' ? 0.45 : 0); }
      sitting = true;
    }
    if (st.seg < 0) { st.x = tx; st.y = ty; st.z = tz; st.yaw = face; st.seg = 0; }
    const dx = tx - st.x, dz = tz - st.z, d = Math.sqrt(dx * dx + dz * dz);
    const vmax = 2.6;
    const step = Math.min(d, vmax * dt);
    if (d > 1e-6) {
      const nx = st.x + dx / d * step, nz = st.z + dz / d * step;
      // dogs don't walk into strangers either
      let ok = true;
      for (let j = 0; j < this.agents.length; j++) {
        if (j === i || j === A.owner || !this.agents[j].visible) continue;
        const r = A.r + this.data.agents[j].r;
        const ax = this.agents[j].x - nx, az = this.agents[j].z - nz, bx = this.agents[j].x - st.x, bz = this.agents[j].z - st.z;
        if (ax * ax + az * az < r * r && ax * ax + az * az < bx * bx + bz * bz) { ok = false; break; }
      }
      if (ok && this.player.on) {
        const r = A.r + this.player.r + 0.05, ax = this.player.x - nx, az = this.player.z - nz, bx = this.player.x - st.x, bz = this.player.z - st.z;
        if (ax * ax + az * az < r * r && ax * ax + az * az < bx * bx + bz * bz) ok = false;
      }
      if (ok) { st.x = nx; st.z = nz; }
    }
    st.y += clamp(ty - st.y, -1.5 * dt, 1.5 * dt);
    // leash: never further than LEASH.max, never inside the walker
    let ox = st.x - w.x, oz = st.z - w.z, od = Math.sqrt(ox * ox + oz * oz);
    if (od > LEASH.max) { st.x = w.x + ox / od * LEASH.max; st.z = w.z + oz / od * LEASH.max; }
    ox = st.x - w.x; oz = st.z - w.z; od = Math.sqrt(ox * ox + oz * oz);
    if (od < LEASH.min && od > 1e-6) { st.x = w.x + ox / od * LEASH.min; st.z = w.z + oz / od * LEASH.min; }
    st.v = step / dt;
    if (st.v > 0.1 && d > 0.05) st.yaw = angleTo(st.yaw, Math.atan2(dx, dz), 6 * dt); else st.yaw = angleTo(st.yaw, face, 3 * dt);
    st.pose = st.v > 1.6 ? 'trot' : st.v > 0.1 ? 'walk' : sitting ? 'sit' : 'idle';
  }

  // ── vehicles: lanes, car following (IDM), stop lines and signals, braking for anyone in the lane ─
  tripOf(i: number): LifeTrip | null { const V = this.data.vehicles[i], st = this.vehicles[i]; return st.trip < V.trips.length ? V.trips[st.trip] : null; }

  stepVehicle(i: number, dt: number) {
    const V = this.data.vehicles[i], st = this.vehicles[i];
    const trip = this.tripOf(i);
    if (!trip) { st.visible = false; return; }
    if (!st.visible) {
      if (this.t < trip.t || this.t < st.waitUntil) return;
      // enter only when the start of the lane is clear
      const e0 = trip.edges[0];
      const S0 = this.edges[e0];
      for (let j = 0; j < this.vehicles.length; j++) {
        const o = this.vehicles[j];
        if (j === i || !o.visible) continue;
        const dx = o.x - S0.pts[0], dz = o.z - S0.pts[2], lim = (V.len + this.data.vehicles[j].len) / 2 + 6;
        if (dx * dx + dz * dz < lim * lim) { st.waitUntil = this.t + 1; return; }
      }
      st.visible = true; st.leg = 0; st.s = 0; st.v = this.data.edges[e0].speed * 0.6; st.dwell = 0; st.stopDone = -1;
      this.placeVehicle(i);
      return;
    }
    const eIdx = trip.edges[st.leg], E = this.data.edges[eIdx], EP = this.edges[eIdx];
    const v0 = E.speed * (V.kind === 'bus' ? 0.85 : 1);
    // the nearest thing ahead along the route: [gap, its speed]
    let gap = 1e9, lv = 0;
    // other vehicles on this edge or the next two of my route
    let base = 0;
    for (let k = 0; k < 3 && st.leg + k < trip.edges.length + (V.loop ? 3 : 0); k++) {
      const idx = (st.leg + k) % trip.edges.length;
      if (!V.loop && st.leg + k >= trip.edges.length) break;
      const ek = trip.edges[idx];
      for (let j = 0; j < this.vehicles.length; j++) {
        if (j === i) continue;
        const o = this.vehicles[j];
        if (!o.visible) continue;
        const ot = this.tripOf(j);
        if (!ot || ot.edges[o.leg] !== ek) continue;
        const along = base + o.s - (k === 0 ? st.s : 0);
        if (k === 0 && o.s <= st.s) continue;
        const gp = along - (V.len + this.data.vehicles[j].len) / 2;
        if (gp < gap) { gap = gp; lv = o.v; }
      }
      base += (k === 0 ? EP.len - st.s : this.edges[ek].len);
      if (base > 80) break;
    }
    // stop line: red, or amber when we can still stop
    if (E.stop) {
      const col = this.signal(E.stop.sig, E.stop.group, this.t);
      const toLine = EP.len - st.s - V.len / 2;
      if (col !== GREEN && toLine > -0.5) {
        const canStop = st.v * st.v / (2 * IDM.b) < toLine + 0.5;
        if (col === RED || canStop) { if (toLine < gap) { gap = Math.max(0.01, toLine + IDM.s0 - 0.3); lv = 0; } }
      }
    }
    // the junction box: don't enter a turn while a crossing or merging one is taken (or about to be, by
    // someone nearer the line; ties go to the lower index)
    const nextLeg = st.leg + 1 < trip.edges.length ? st.leg + 1 : V.loop ? 0 : -1;
    if (nextLeg >= 0) {
      const ne = this.data.edges[trip.edges[nextLeg]];
      const toLine = EP.len - st.s - V.len / 2;
      if ((ne.conf || ne.jn !== undefined) && toLine < 12) {
        let busy = false, wide = false;
        for (let j = 0; j < this.vehicles.length && !busy; j++) {
          if (j === i) continue;
          const o = this.vehicles[j];
          if (!o.visible) continue;
          const ot = this.tripOf(j)!;
          const oe = ot.edges[o.leg];
          const oj = this.data.edges[oe].jn;
          if ((V.len > 6 || this.data.vehicles[j].len > 6) && oj !== undefined && oj === ne.jn && this.data.edges[oe].turn) { busy = true; wide = this.data.vehicles[j].len > 6; break; }
          if (V.len > 6 || this.data.vehicles[j].len > 6) {
            // a bus and another about to enter the same junction at once: the one nearer its line goes (ties: lower index)
            const onx = o.leg + 1 < ot.edges.length ? ot.edges[o.leg + 1] : this.data.vehicles[j].loop ? ot.edges[0] : -1;
            if (onx >= 0 && this.data.edges[onx].jn === ne.jn && ne.jn !== undefined) {
              const ol = this.edges[oe].len - o.s - this.data.vehicles[j].len / 2;
              const os = this.data.edges[oe].stop;
              const canGo = !os || this.signal(os.sig, os.group, this.t) === GREEN;
              if (canGo && ol < 3 && ol > -0.5 && (ol < toLine - 0.5 || (Math.abs(ol - toLine) <= 0.5 && j < i))) { busy = true; wide = this.data.vehicles[j].len > 6; break; }
            }
          }
          const half = this.data.vehicles[j].len / 2 + 0.5;
          const prevE = o.leg > 0 ? ot.edges[o.leg - 1] : this.data.vehicles[j].loop ? ot.edges[ot.edges.length - 1] : -1;
          const nextE = o.leg + 1 < ot.edges.length ? ot.edges[o.leg + 1] : this.data.vehicles[j].loop ? ot.edges[0] : -1;
          for (let c = 0; ne.conf && c < ne.conf.length; c++) {
            // a body still in (or already nosing into) a conflicting turn holds the box
            if (oe === ne.conf[c] || (prevE === ne.conf[c] && o.s < half) || (nextE === ne.conf[c] && this.edges[oe].len - o.s < this.data.vehicles[j].len / 2 - 0.1)) { busy = true; break; }
            const onl = o.leg + 1 < ot.edges.length ? o.leg + 1 : this.data.vehicles[j].loop ? 0 : -1;
            if (onl >= 0 && ot.edges[onl] === ne.conf[c]) {
              const ol = this.edges[oe].len - o.s - this.data.vehicles[j].len / 2;
              const os = this.data.edges[oe].stop;
              const canGo = !os || this.signal(os.sig, os.group, this.t) === GREEN;
              if (canGo && ol < 3 && (ol < toLine - 0.5 || (Math.abs(ol - toLine) <= 0.5 && j < i))) { busy = true; break; }
            }
          }
        }
        // a bus turning through the junction swings wide: hold well back from the line
        const hold = wide ? toLine - 6 : toLine;
        if (busy && hold + IDM.s0 - 0.3 < gap) { gap = Math.max(0.01, hold + IDM.s0 - 0.3); lv = 0; }
      }
    }
    // turning: wait at the line while anyone is crossing where the turn goes (the body would sweep them)
    if (nextLeg >= 0 && this.data.edges[trip.edges[nextLeg]].turn) {
      const toLine = EP.len - st.s - V.len / 2;
      if (toLine < 10 && toLine > -0.5) {
        const reach = V.wid / 2 + (V.len > 6 ? 2.4 : 1.2);
        let yieldTo = false;
        for (let j = 0; j < this.agents.length && !yieldTo; j++) {
          const o = this.agents[j];
          // on a crossing, or walking up to one
          if (!o.visible || !(o.onCross || (o.nearCross && o.v > 0.3))) continue;
          for (let k = 1; k <= 2 && !yieldTo; k++) {
            const lg = st.leg + k < trip.edges.length ? st.leg + k : V.loop ? (st.leg + k) % trip.edges.length : -1;
            if (lg < 0) break;
            const NP = this.edges[trip.edges[lg]];
            const lim = k === 1 ? NP.len : Math.min(NP.len, 9);
            for (let q = 0; q < NP.cum.length && NP.cum[q] <= lim + 1; q++) {
              const dx = NP.pts[q * 3] - o.x, dz = NP.pts[q * 3 + 2] - o.z;
              if (dx * dx + dz * dz < (reach + 1.5) * (reach + 1.5)) { yieldTo = true; break; }
            }
          }
        }
        // a bus swings wide: don't start the turn while any vehicle stands where its body will go
        if (V.len > 6) {
          const tl = this.edges[trip.edges[nextLeg]].len, toEnd = EP.len - st.s;
          for (let q = 0; q <= tl + 4 && !yieldTo; q++) {
            const pa = this.poseAhead(i, toEnd + q);
            for (let j = 0; j < this.vehicles.length; j++) {
              const o = this.vehicles[j];
              if (j === i || !o.visible) continue;
              const ox = o.x - pa[0], oz = o.z - pa[1];
              if (ox * ox + oz * oz > 3600) continue;
              const otj = this.tripOf(j)!;
              if (otj.edges[o.leg] === trip.edges[st.leg] && o.s < st.s) continue;      // queued behind us
              // where the other could still be by the time it stops (one coming up to this junction: up to its line)
              let ext = o.v * o.v / (2 * IDM.b) + o.v;
              const ot = this.tripOf(j)!, onx = o.leg + 1 < ot.edges.length ? ot.edges[o.leg + 1] : -1;
              if (onx >= 0 && this.data.edges[onx].jn !== undefined && this.data.edges[onx].jn === this.data.edges[trip.edges[nextLeg]].jn) {
                const ol = this.edges[ot.edges[o.leg]].len - o.s - this.data.vehicles[j].len / 2, os = this.data.edges[ot.edges[o.leg]].stop;
                // on green it may come on to its line; on red it stops before it
                if (!os || this.signal(os.sig, os.group, this.t) === GREEN) ext = Math.max(ext, ol + 1); else ext = Math.min(ext, Math.max(0, ol - 0.3));
              }
              if (Math.sqrt(ox * ox + oz * oz) > 25 + ext) continue;
              const hx = Math.sin(o.yaw) * ext / 2, hz = Math.cos(o.yaw) * ext / 2;
              if (boxesTouch(pa[0], pa[1], pa[2], V.len + 1.0, V.wid + 0.6, o.x + hx, o.z + hz, o.yaw, this.data.vehicles[j].len + ext, this.data.vehicles[j].wid)) { yieldTo = true; break; }
            }
          }
        }
        if (yieldTo && toLine + IDM.s0 - 0.3 < gap) { gap = Math.max(0.01, toLine + IDM.s0 - 0.3); lv = 0; st.brake = true; }
      }
    }
    // bus stops: pull in and dwell
    if (V.kind === 'bus' && E.bus) {
      for (let b = 0; b < E.bus.length; b++) {
        const key = eIdx * 100 + b;
        const toStop = E.bus[b] - st.s;
        if (st.stopDone === key || toStop < -1) continue;
        if (toStop < 0.4 && st.v < 0.3) {
          if (st.dwell <= 0) st.dwell = 12;
          st.dwell -= dt;
          if (st.dwell <= 0) { st.stopDone = key; st.dwell = 0; }
          gap = Math.min(gap, 0.01); lv = 0;
        } else if (toStop + IDM.s0 < gap) { gap = Math.max(0.01, toStop + IDM.s0); lv = 0; }
      }
    }
    // anyone in the lane ahead (folk on a crossing, a dog, the player): brake for them
    st.brake = false;
    let hard = false;
    const look = Math.max(10, st.v * 3.2 + 6);
    const half = V.wid / 2 + 0.25;
    // where the body will be a moment from now (a long body swings wide in a turn)
    const ah = this.poseAhead(i, st.v * dt + 0.6);
    for (let j = 0; j <= this.agents.length; j++) {
      let px: number, pz: number, pr: number;
      let moving = true;
      if (j === this.agents.length) { if (!this.player.on) continue; px = this.player.x; pz = this.player.z; pr = this.player.r; }
      else {
        const o = this.agents[j];
        if (!o.visible) continue;
        moving = o.v > 0.05;
        // folk standing on the sidewalk (waiting at the curb, chatting) aren't in the road
        if (o.wait && !o.onCross) continue;
        px = o.x; pz = o.z; pr = this.data.agents[j].r;
      }
      // anyone the body would sweep into in the next moment: stop dead
      if ((moving || j === this.agents.length || this.agents[j].onCross) && inBox(px, pz, pr + 0.1, ah[0], ah[1], ah[2], V.len, V.wid)) { hard = true; st.brake = true; continue; }
      const dx = px - st.x, dz = pz - st.z;
      if (dx * dx + dz * dz > (look + V.len) * (look + V.len)) continue;
      // someone at the front corners (stepping off a curb as we turn): stop dead; beside or behind: carry on
      if (moving && ((px - st.x) * Math.sin(st.yaw) + (pz - st.z) * Math.cos(st.yaw)) > V.len * 0.25 && inBox(px, pz, pr + 0.35, st.x, st.z, st.yaw, V.len, V.wid)) { hard = true; st.brake = true; continue; }
      const hit = this.alongRoute(i, px, pz, look + V.len / 2, half + pr);
      if (hit >= 0 && hit > V.len / 2 - 0.6) {           // ahead of the nose (beside the body: they wait for us)
        const gp = hit - V.len / 2 - pr;
        if (gp + 1.0 < gap) { gap = Math.max(0.01, gp + 1.0); lv = 0; st.brake = true; }
        if (gp < 1.2) hard = true;              // right in front: stop dead (cars never touch anyone)
      }
    }
    // never drive into another vehicle's body (one stopped across our way in a junction, say): stop dead
    for (let j = 0; j < this.vehicles.length && !hard; j++) {
      const o = this.vehicles[j];
      if (j === i || !o.visible) continue;
      const ox = o.x - st.x, oz = o.z - st.z, reach = (V.len + this.data.vehicles[j].len) / 2 + 3;
      if (ox * ox + oz * oz > reach * reach || ox * Math.sin(st.yaw) + oz * Math.cos(st.yaw) <= 0) continue;
      if (boxesTouch(ah[0], ah[1], ah[2], V.len + 0.4, V.wid + 0.2, o.x, o.z, o.yaw, this.data.vehicles[j].len, this.data.vehicles[j].wid)) { hard = true; st.brake = true; }
    }
    // IDM
    const ss = IDM.s0 + Math.max(0, st.v * IDM.T + st.v * (st.v - lv) / (2 * Math.sqrt(IDM.a * IDM.b)));
    let acc = IDM.a * (1 - Math.pow(st.v / Math.max(v0, 0.1), 4) - (gap < 1e8 ? (ss / Math.max(gap, 0.01)) * (ss / Math.max(gap, 0.01)) : 0));
    if (acc < -9) acc = -9;
    st.v += acc * dt;
    if (st.v < 0 || hard) st.v = 0;
    st.s += st.v * dt;
    while (st.s > this.edges[trip.edges[st.leg]].len) {
      st.s -= this.edges[trip.edges[st.leg]].len;
      st.leg += 1;
      if (st.leg >= trip.edges.length) {
        if (V.loop) { st.leg = 0; st.stopDone = -1; }
        else { st.visible = false; st.trip += 1; st.waitUntil = this.t + 1; return; }
      }
    }
    this.placeVehicle(i);
  }

  placeVehicle(i: number) {
    const st = this.vehicles[i], trip = this.tripOf(i)!;
    const EP = this.edges[trip.edges[st.leg]];
    const P = pointAt(EP, 3, st.s), D = dirAt(EP, 3, st.s);
    st.x = P[0]; st.y = P[1]; st.z = P[2];
    st.yaw = Math.atan2(D[0], D[1]);
  }

  /** Vehicle i's pose d metres further along its route: [x, z, yaw]. */
  poseAhead(i: number, d: number): number[] {
    const st = this.vehicles[i], trip = this.tripOf(i)!, V = this.data.vehicles[i];
    let leg = st.leg, s = st.s + d;
    while (s > this.edges[trip.edges[leg]].len) {
      s -= this.edges[trip.edges[leg]].len;
      leg += 1;
      if (leg >= trip.edges.length) {
        if (V.loop) leg = 0;
        else { leg = trip.edges.length - 1; s = this.edges[trip.edges[leg]].len; break; }
      }
    }
    const EP = this.edges[trip.edges[leg]], P = pointAt(EP, 3, s), D = dirAt(EP, 3, s);
    return [P[0], P[2], Math.atan2(D[0], D[1])];
  }

  /** Arc distance ahead along vehicle i's route to the point nearest (px, pz) within `half` of the lane; -1 if none within `look`. */
  alongRoute(i: number, px: number, pz: number, look: number, half: number): number {
    const st = this.vehicles[i], trip = this.tripOf(i)!, V = this.data.vehicles[i];
    let base = -st.s;
    for (let k = 0; k < 3; k++) {
      let leg = st.leg + k;
      if (leg >= trip.edges.length) { if (!V.loop) break; leg = leg % trip.edges.length; }
      const EP = this.edges[trip.edges[leg]];
      const n = EP.cum.length;
      // through a turn the body swings wide of the lane's line (a bus most)
      const hw = this.data.edges[trip.edges[leg]].turn ? half + (V.len > 6 ? 1.6 : 0.4) : half;
      for (let q = 0; q + 1 < n; q++) {
        const s0 = EP.cum[q], s1 = EP.cum[q + 1];
        if (base + s1 < 0) continue;
        if (base + s0 > look) return -1;
        const ax = EP.pts[q * 3], az = EP.pts[q * 3 + 2], bx = EP.pts[q * 3 + 3], bz = EP.pts[q * 3 + 5];
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
        let u = L2 > 1e-9 ? ((px - ax) * ex + (pz - az) * ez) / L2 : 0;
        u = clamp(u, 0, 1);
        const cx = ax + ex * u, cz = az + ez * u;
        const dd = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
        const along = base + s0 + (s1 - s0) * u;
        if (dd < hw * hw && along > 0 && along < look) return along;
      }
      base += EP.len;
    }
    return -1;
  }

  /** Every agent's and vehicle's position, for tests and the parity check. */
  snapshot(): number[] {
    const out: number[] = [];
    for (const a of this.agents) out.push(a.visible ? 1 : 0, a.x, a.z);
    for (const v of this.vehicles) out.push(v.visible ? 1 : 0, v.x, v.z);
    return out;
  }
}
