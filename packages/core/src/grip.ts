// Grip sockets (Decision 22 A): where a hand holds a prop, generated from the prop's shape (a long
// thin section is a handle → power grip; a small object → pinch) and editable with set-grip. A
// hold solves the prop's placement from the socket and the posed hand, and fits the finger curls
// so no finger passes through the prop. Pure geometry: DOM-free, Node-free.
import type { GripSocket, HandPose } from './types.ts';
import { forward, fingerBones, gripFrame, handRotations, poseVertices, qFromBasis, qMul, qRot, qIdentity, type Q, type V3 } from './rig.ts';
import type { CharacterRig } from './kernel.ts';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];

/** Principal axis of a point cloud (power iteration on the covariance). */
function principalAxis(P: Float32Array): { c: V3; axis: V3; side: V3 } {
  const n = P.length / 3;
  const c: V3 = [0, 0, 0];
  for (let i = 0; i < n; i++) { c[0] += P[i * 3]; c[1] += P[i * 3 + 1]; c[2] += P[i * 3 + 2]; }
  c[0] /= n; c[1] /= n; c[2] /= n;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r * 3 + k] += d[r] * d[k];
  }
  let v: V3 = [0.31, 0.92, 0.23];
  for (let it = 0; it < 60; it++) v = norm([C[0] * v[0] + C[1] * v[1] + C[2] * v[2], C[3] * v[0] + C[4] * v[1] + C[5] * v[2], C[6] * v[0] + C[7] * v[1] + C[8] * v[2]]);
  const helper: V3 = Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return { c, axis: v, side: norm(cross(v, helper)) };
}

/**
 * A grip socket from a prop's mesh (object space): the thinnest long run along its main axis is a
 * handle (power grip, held a third of the way from the free end); a small object is pinched.
 */
export function autoGrip(P0: Float32Array, I?: Uint32Array, scaleHint = 1): GripSocket {
  // sample along every edge too: a cylinder's vertices sit only at its ends
  let P = P0;
  if (I) {
    const pts: number[] = Array.from(P0);
    for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = I[t + k] * 3, b = I[t + (k + 1) % 3] * 3;
      if (I[t + k] > I[t + (k + 1) % 3]) continue;
      const len = Math.hypot(P0[b] - P0[a], P0[b + 1] - P0[a + 1], P0[b + 2] - P0[a + 2]);
      const n = Math.min(60, Math.floor(len / 0.008));
      for (let i = 1; i < n; i++) { const u = i / n; pts.push(P0[a] + (P0[b] - P0[a]) * u, P0[a + 1] + (P0[b + 1] - P0[a + 1]) * u, P0[a + 2] + (P0[b + 2] - P0[a + 2]) * u); }
    }
    P = Float32Array.from(pts);
  }
  const { c, axis, side } = principalAxis(P);
  const n = P.length / 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const t = dot(sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c), axis); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  const len = hi - lo;
  const third = cross(axis, side);
  if (len < 0.09 * scaleHint) {
    let r = 0;
    for (let i = 0; i < n; i++) { const d = sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c); r = Math.max(r, Math.abs(dot(d, side))); }
    return { kind: 'pinch', center: c, axis, side, radius: Math.min(r, 0.03), auto: true };
  }
  // radius profile along the axis
  const bins = 24;
  const rad = new Array(bins).fill(0), cnt = new Array(bins).fill(0);
  for (let i = 0; i < n; i++) {
    const d = sub([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], c);
    const t = dot(d, axis);
    const b = Math.min(bins - 1, Math.floor(((t - lo) / len) * bins));
    rad[b] = Math.max(rad[b], Math.hypot(dot(d, side), dot(d, third)));
    cnt[b]++;
  }
  const thin = 0.028 * scaleHint;
  let best = { from: -1, to: -1 };
  for (let i = 0; i < bins; ) {
    if (rad[i] > 0 && rad[i] <= thin) {
      let j = i; while (j + 1 < bins && rad[j + 1] > 0 && rad[j + 1] <= thin) j++;
      if (j - i > best.to - best.from) best = { from: i, to: j };
      i = j + 1;
    } else i++;
  }
  if (best.from < 0) throw new Error('no handle found (nothing long and thinner than ~3 cm) — define one with studio set-grip --center … --axis …');
  // the working end is the heavier side: the axis points toward it
  const run = (k: number) => lo + ((k + 0.5) / bins) * len;
  const heavyHigh = rad.slice(best.to + 1).reduce((a, b) => a + b, 0) >= rad.slice(0, best.from).reduce((a, b) => a + b, 0);
  const dir = heavyHigh ? axis : scale(axis, -1);
  const freeEnd = heavyHigh ? run(best.from) : run(best.to);
  const handleLen = ((best.to - best.from + 1) / bins) * len;
  const tGrip = freeEnd + (heavyHigh ? 1 : -1) * Math.min(handleLen * 0.38, 0.06 * scaleHint);
  const r = rad.slice(best.from, best.to + 1).reduce((a, b) => a + b, 0) / (best.to - best.from + 1);
  return { kind: 'power', center: [c[0] + axis[0] * tGrip, c[1] + axis[1] * tGrip, c[2] + axis[2] * tGrip], axis: dir, side: norm(cross(dir, third)), radius: r, auto: true };
}

/** Is a point inside a closed mesh (ray parity along +X with a slight tilt to dodge edges)? */
export function inside(P: Float32Array, I: Uint32Array, p: V3): boolean {
  const d: V3 = norm([1, 0.0123, 0.0071]);
  let hits = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a: V3 = [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], b: V3 = [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], c: V3 = [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]];
    const e1 = sub(b, a), e2 = sub(c, a), h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-14) continue;
    const f = 1 / det, s = sub(p, a), u = f * dot(s, h);
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1), v = f * dot(d, q);
    if (v < 0 || u + v > 1) continue;
    if (f * dot(e2, q) > 0) hits++;
  }
  return hits % 2 === 1;
}

/** The prop's world placement that puts its grip socket in the posed hand (object space of the character). */
export function heldPlacement(cr: CharacterRig, hand: 'left' | 'right', grip: GripSocket): { q: Q; p: V3 } {
  const f = gripFrame(cr.rig, cr.posed, hand, grip.kind, grip.radius);
  // rotation taking the socket basis (axis, side, axis×side) onto the hand's (axis, side, axis×side)
  const src = qFromBasis(grip.axis, grip.side, norm(cross(grip.axis, grip.side)));
  const dst = qFromBasis(f.axis, f.side, norm(cross(f.axis, f.side)));
  const q = qMul(dst, [-src[0], -src[1], -src[2], src[3]]);
  const rc = qRot(q, grip.center);
  return { q, p: [f.p[0] - rc[0], f.p[1] - rc[1], f.p[2] - rc[2]] };
}

/** Finger curls that wrap a held prop without passing through it (search from open to closed per finger). */
export function fitGrip(cr: CharacterRig, hand: 'left' | 'right', propWorld: { P: Float32Array; I: Uint32Array }, base: HandPose, grip: GripSocket): HandPose {
  const S = hand === 'left' ? 'Left' : 'Right';
  const rig = cr.rig;
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const fingerVerts = (f: string) => {
    const set = new Set(fingerBones(S, f).map((n) => idx.get(n)!));
    const out: number[] = [];
    for (let v = 0; v < cr.rest.length / 3; v++) if (set.has(rig.joints[v * 4])) out.push(v);
    return out.filter((_, i) => i % 2 === 0);
  };
  const pose: HandPose = { ...base, name: grip.kind === 'power' ? 'grip' : 'pinch' };
  const local0 = cr.posed.local.map((q) => q.slice() as Q);
  const tryPose = (h: HandPose) => {
    const local = local0.map((q, i) => (rig.bones[i].name.startsWith(S) && /(Thumb|Index|Middle|Ring|Little)/.test(rig.bones[i].name) ? qIdentity() : q));
    for (const [n, q] of Object.entries(handRotations(S, h))) { const i = idx.get(n); if (i !== undefined) local[i] = qMul(local[i], q); }
    return poseVertices(rig, cr.rest, forward(rig.bones, rig.parents, local), undefined);
  };
  const fingers = ['index', 'middle', 'ring', 'little', 'thumb'] as const;
  const caps = grip.kind === 'pinch' ? { thumb: 0.7, index: 0.7, middle: 0.5, ring: 0.55, little: 0.6 } : { thumb: 0.95, index: 1, middle: 1, ring: 1, little: 1 };
  for (const f of fingers) {
    const verts = fingerVerts(f === 'thumb' ? 'Thumb' : f[0].toUpperCase() + f.slice(1));
    let ok = 0;
    for (let c = 0.05; c <= caps[f] + 1e-9; c += 0.05) {
      const P = tryPose({ ...pose, [f]: c });
      const hit = verts.some((v) => inside(propWorld.P, propWorld.I, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
      if (hit) break;
      ok = c;
    }
    (pose as any)[f] = +ok.toFixed(2);
  }
  pose.spread = 0;
  return pose;
}

/** Finger vertices (world) of one hand inside a held prop, deeper than tol. */
export function fingerPenetration(cr: CharacterRig, worldPos: Float32Array, hand: 'left' | 'right', propWorld: { P: Float32Array; I: Uint32Array }, tol = 0.0015): number {
  const S = hand === 'left' ? 'Left' : 'Right';
  const ids = new Set(cr.rig.bones.map((b, i) => (b.name.startsWith(S) && /(Thumb|Index|Middle|Ring|Little)/.test(b.name) ? i : -1)).filter((i) => i >= 0));
  let n = 0;
  const I = propWorld.I, P = propWorld.P;
  for (let v = 0; v < worldPos.length / 3; v++) {
    if (!ids.has(cr.rig.joints[v * 4])) continue;
    const p: V3 = [worldPos[v * 3], worldPos[v * 3 + 1], worldPos[v * 3 + 2]];
    if (!inside(P, I, p)) continue;
    // depth below the surface (distance to the nearest triangle): only count clear penetrations
    let best = Infinity;
    for (let t = 0; t < I.length && best > tol; t += 3) best = Math.min(best, triDist(p, [P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]], [P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2]], [P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2]]));
    if (best > tol) n++;
  }
  return n;
}

/** Distance from a point to a triangle. */
function triDist(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: V3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const lerp = (x: V3, y: V3, t: number): V3 => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(lerp(a, b, d1 / (d1 - d3)));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(lerp(a, c, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return at(lerp(b, c, (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}
