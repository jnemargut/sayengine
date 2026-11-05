// Wings, fins and body waves (Decision 52, weeks 15–20): the parts that move air and water. A wing is
// arm, forearm and hand bones carrying feathers; its flap rate, stroke and the flight cycle come from
// its proportions the way a gait comes from leg length (small wings beat fast, long narrow wings glide
// between bursts). A swimming body is a travelling wave down a chain: carangiform for a fish (the tail
// does the work), anguilliform for an eel (the whole body waves), with the wave speed, tail-beat
// frequency and amplitude computed from the body length and swimming speed. Fins flutter or ride
// along. Each declares its checks: wings clear the body, the stroke is symmetric and within range, the
// beat fits the wing size; a swimming wave runs tailward faster than the fish moves, the tail beat is
// in range and the head stays steady. DOM-free.
import { qAxisAngle, qIdentity, qMul, qRot, type Q, type V3 } from './rig.ts';
import { qAngle, qArc, qInv } from './motion.ts';
import { bonePoint, type ChainPartSpec, type Creature, type CreatureClip, type FK, type FinPartSpec, type JointLimit, type MotionCheck, type PartPiece, type PropPartSpec, type WingPartSpec, type BodyPartSpec, type LegsPartSpec } from './rigparts.ts';

const TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mod1 = (x: number) => x - Math.floor(x);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const X = (d: number) => qAxisAngle([1, 0, 0], d), Y = (d: number) => qAxisAngle([0, 1, 0], d), Z = (d: number) => qAxisAngle([0, 0, 1], d);
const ranges = (bad: boolean[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let s = -1;
  bad.forEach((b, i) => { if (b && s < 0) s = i; if (!b && s >= 0) { out.push([s, i - 1]); s = -1; } });
  if (s >= 0) out.push([s, bad.length - 1]);
  return out;
};

/** A left-side rotation mirrored to the right (across the X = 0 plane). */
export const mirrorQ = (q: Q): Q => [q[0], -q[1], -q[2], q[3]];

// ── wings ────────────────────────────────────────────────────────────────────────────────────────

const WING_SPLIT = [0.3, 0.3, 0.4];          // arm, forearm, hand (with the primaries), as fractions of the wing

/** The whole wingspan (tip to tip, m). */
export const wingSpan = (w: WingPartSpec) => 2 * (w.length + Math.abs(w.at[0]));
/** Wingbeats per second from the wingspan: f ≈ 3.9 / span^0.9 (a sparrow beats ~13 Hz, a pigeon ~6, a heron ~2.4). */
export const wingFreq = (w: WingPartSpec) => w.flapHz ?? clamp(3.9 / Math.pow(wingSpan(w), 0.9), 1.2, 14);
/** Stroke amplitude (deg each way): shorter wings sweep wider. */
export const wingAmp = (w: WingPartSpec) => w.stroke ?? clamp(52 - 9 * wingSpan(w), 30, 55);

export function wingBuild(spec: WingPartSpec) {
  const bones: Array<{ name: string; parent: string; head: V3; tail: V3 }> = [];
  const pieces: PartPiece[] = [];
  const limits: Record<string, JointLimit> = {};
  const fast: Record<string, number> = {};
  const sides: Creature['wings'] = [];
  const L = spec.length, c = spec.chord;
  const peak = TAU * wingFreq(spec) * wingAmp(spec);        // peak shoulder speed in a flap (°/s)
  for (const side of [1, -1] as const) {
    const tag = side > 0 ? 'L' : 'R';
    const sx = side;
    const at: V3 = [spec.at[0] * sx, spec.at[1], spec.at[2]];
    const names = ['arm', 'fore', 'hand'].map((n) => `${spec.id}.${tag}.${n}`);
    let head = at;
    const heads: V3[] = [], tails: V3[] = [];
    WING_SPLIT.forEach((f, i) => {
      const tail = add(head, [sx * L * f, 0, 0]);
      bones.push({ name: names[i], parent: i === 0 ? (spec.parent ?? 'Body') : names[i - 1], head, tail });
      heads.push(head); tails.push(tail);
      head = tail;
    });
    const up: V3 = [0, 1, 0];
    const edge = spec.edgeColor ?? spec.color;
    // the leading edge: a tapered, rounded bone line
    const er = [c * 0.085, c * 0.07, c * 0.055, c * 0.025];
    for (let i = 0; i < 3; i++) pieces.push({ bone: names[i], shape: { kind: 'seg', a: heads[i], b: tails[i], r1: er[i], r2: er[i + 1], sides: 10, round: true, squash: [1, 0.7] }, color: edge, part: spec.id });
    // coverts and secondaries: feathered planes trailing each bone (centred behind it)
    const chordAt = [c, c * 0.9, c * 0.62];
    for (let i = 0; i < 2; i++) {
      pieces.push({ bone: names[i], shape: { kind: 'blade', a: add(heads[i], [0, 0.001 * i, -chordAt[i] * 0.47]), b: add(tails[i], [sx * L * 0.01, 0.001 * i, -chordAt[i + 1] * 0.47]), w: chordAt[i] * 0.94, normal: up, taper: chordAt[i + 1] / chordAt[i] }, color: spec.color, part: spec.id });
    }
    // primaries: a fan of long feathers from the hand, outer ones darker
    const lh = L * WING_SPLIT[2];
    for (let k = 0; k < 5; k++) {
      const ang = (60 - k * 13) * (Math.PI / 180);
      const root = add(heads[2], [sx * lh * (0.04 + 0.2 * k), 0.002 + 0.0015 * k, -c * 0.12]);
      const dir: V3 = [sx * Math.cos(ang), 0, -Math.sin(ang)];
      const fl = lh * (0.62 + 0.11 * k) + c * 0.25;
      pieces.push({ bone: names[2], shape: { kind: 'blade', a: root, b: add(root, mul(dir, fl)), w: c * 0.3, normal: up, taper: 0.5 }, color: k >= 3 ? (spec.tipColor ?? spec.color) : spec.color, part: spec.id });
    }
    limits[names[0]] = { kind: 'cone', maxDeg: 150 };
    limits[names[1]] = { kind: 'cone', maxDeg: 172 };
    limits[names[2]] = { kind: 'cone', maxDeg: 172 };
    for (const n of names) fast[n] = Math.max(900, peak * 1.9 + 300);
    sides.push({ part: spec.id, side, arm: names[0], fore: names[1], hand: names[2] });
  }
  return { bones, pieces, limits, fast, sides };
}

export type WingMode = 'spread' | 'flap' | 'glide' | 'hover' | 'fold';
export interface WingPoseOut { arm: Q; fore: Q; hand: Q; bob: number }

/** The left wing's local rotations for a mode at a beat phase (cycles) and time; `bob` is the body's
 *  rise from the stroke (-1..1: the downstroke lifts it). The right wing is `mirrorQ` of these. */
export function wingPose(spec: WingPartSpec, mode: WingMode, phase: number, t: number): WingPoseOut {
  const amp = wingAmp(spec);
  if (mode === 'spread') return { arm: qIdentity(), fore: qIdentity(), hand: qIdentity(), bob: 0 };
  if (mode === 'fold') {
    const f = spec.fold ?? {};
    return { arm: qMul(Y(f.sweep ?? 80), qMul(Z(f.drop ?? -6), X(f.twist ?? -112))), fore: Y(-158), hand: Y(160), bob: 0 };
  }
  if (mode === 'glide') {
    const g = Math.sin((TAU * t) / 2.3);
    return { arm: qMul(Y(-3), qMul(Z(6 + 1.5 * g), X(2))), fore: Z(-5), hand: qMul(Y(9), Z(7 + 1.5 * Math.sin((TAU * t) / 2.3 - 0.6))), bob: 0 };
  }
  // flap / hover: a downstroke that takes 55 % of the beat; the outer wing lags the arm (a wave out
  // along the wing); the leading edge dips on the way down (pronation) and the wing flexes on the way up
  const d = mode === 'hover' ? 0.5 : 0.55;
  const u = mod1(phase);
  const e = u < d ? Math.cos((Math.PI * u) / d) : -Math.cos((Math.PI * (u - d)) / (1 - d));   // +1 top … −1 bottom … +1
  const dn = u < d ? Math.sin((Math.PI * u) / d) : 0;
  const upS = u >= d ? Math.sin((Math.PI * (u - d)) / (1 - d)) : 0;
  const A = mode === 'hover' ? amp * 1.1 : amp;
  const mid = mode === 'hover' ? 22 : 10;
  const elev = mid + A * e;
  const twist = mode === 'hover' ? 28 * dn - 10 * upS : 14 * dn - 10 * upS;
  const sweep = mode === 'hover' ? -26 * dn + 8 * upS : -5 * dn + 9 * upS;
  const fold = (mode === 'hover' ? 18 : 42) * upS;
  return {
    arm: qMul(Y(sweep), qMul(Z(elev), X(twist))),
    fore: qMul(Y(-0.8 * fold), Z(0.2 * A * dn - 0.25 * A * upS)),
    hand: qMul(Y(1.5 * fold), qMul(Z(0.3 * A * dn - 0.35 * A * upS), X(twist * 0.6))),
    bob: -e,
  };
}

/** A flight cycle from the wing's proportions: the beat rate, a cruising speed from the span, and for
 *  long narrow wings (aspect ratio over 6) bursts of flapping between glides. */
export function flightPlan(spec: WingPartSpec) {
  const span = wingSpan(spec);
  const area = 2 * spec.length * spec.chord * 0.78;
  const aspect = (span * span) / area;
  const freq = wingFreq(spec);
  const speed = 1.5 + 2.2 * span;
  const glide = aspect > 6 ? clamp((aspect - 6) * 0.35, 0.5, 1.6) : 0;
  const flaps = glide ? 4 : Math.max(2, Math.round(2 * freq));
  return { span: r3(span), aspect: r3(aspect), freq: r3(freq), amp: r3(wingAmp(spec)), speed: r3(speed), flaps, glide: r3(glide), cycle: flaps / freq + glide };
}

/** Where a bird tucks a foot in flight (rest object space): under and behind the hip. */
export function legTuck(c: Creature, leg: Creature['legs'][number]): V3 {
  const hip = c.bones[c.index.get(leg.hip)!];
  const lp = c.def.parts.find((p): p is LegsPartSpec => p.kind === 'legs' && p.id === leg.part)!;
  const reach = lp.upper + lp.lower;
  return add(hip.head, [leg.side * reach * 0.05, -reach * 0.38, -reach * 0.55]);
}

// ── fins and props ───────────────────────────────────────────────────────────────────────────────

export function finBuild(spec: FinPartSpec) {
  const bones: Array<{ name: string; parent: string; head: V3; tail: V3 }> = [];
  const pieces: PartPiece[] = [];
  const limits: Record<string, JointLimit> = {};
  for (const side of spec.mirror ? [1, -1] : [1]) {
    const name = spec.mirror ? `${spec.id}.${side > 0 ? 'L' : 'R'}` : spec.id;
    const m = (v: V3): V3 => [v[0] * side, v[1], v[2]];
    const at = m(spec.at), dir = norm(m(spec.dir));
    const tail = add(at, mul(dir, spec.length));
    bones.push({ name, parent: spec.parent ?? 'Body', head: at, tail });
    pieces.push({ bone: name, shape: { kind: 'blade', a: at, b: tail, w: spec.width, normal: norm(m(spec.normal ?? [0, 1, 0])), taper: spec.taper ?? 0.45 }, color: spec.color, part: spec.id });
    limits[name] = { kind: 'cone', maxDeg: 70 };
  }
  return { bones, pieces, limits };
}

/** The axis a fin flutters about (left one; the right mirrors), and its bone names. */
export function finAxis(spec: FinPartSpec): V3 {
  if (spec.axis) return norm(spec.axis);
  const n = norm(spec.normal ?? [0, 1, 0]), d = norm(spec.dir);
  return norm(cross(d, n));       // along the fin's root edge: the fin swings like a paddle
}

export function propBuild(spec: PropPartSpec) {
  const pieces: PartPiece[] = spec.shapes.map((s) => ({ bone: spec.id, shape: s.shape, color: s.color, part: spec.id }));
  return { bone: { name: spec.id, parent: spec.parent ?? null, head: spec.at, tail: add(spec.at, [0, 0.05, 0]) }, pieces };
}

// ── swimming: a travelling body wave ─────────────────────────────────────────────────────────────

export interface SwimPlan { style: 'fish' | 'eel'; L: number; front: number; lambda: number; slip: number; A: number; freq: number; speed: number; env: (k: number) => number }

/** The body wave for a swimming chain: wavelength, tail amplitude and beat frequency from the body
 *  length and the speed (fish: λ ≈ 1 L, tail ±0.1 L, slip U/V ≈ 0.7; eel: λ ≈ 0.6 L, slip ≈ 0.45). */
export function swimPlan(c: Creature, chain: ChainPartSpec, speed?: number): SwimPlan {
  const body = c.def.parts.find((p): p is BodyPartSpec => p.kind === 'body')!;
  const bl = body.size[2];
  const head = c.bones[c.index.get('Body')!].head;
  const front = head[2] + bl / 2;
  const L = (front - chain.at[2]) + chain.length;
  const style = chain.swim ?? 'fish';
  const lambda = style === 'eel' ? 0.62 * L : 1.0 * L;
  const slip = style === 'eel' ? 0.45 : 0.7;
  const A = (chain.amp ?? (style === 'eel' ? 0.075 : 0.1)) * L;
  const U = speed ?? (style === 'eel' ? 0.45 : 0.9) * L;
  const freq = U / slip / lambda;
  const env = style === 'eel' ? (k: number) => 0.32 + 0.68 * k : (k: number) => 0.06 + 0.94 * k * k;
  return { style, L, front, lambda, slip, A, freq, speed: U, env };
}

/** The pose of a swimming body at time t (in place): the head's lateral offset and yaw, and the chain's
 *  joints walked along the wave at their own segment lengths. */
export function swimJoints(c: Creature, chain: ChainPartSpec, plan: SwimPlan, t: number): { bodyOff: V3; bodyRot: Q; joints: V3[] } {
  const head = c.bones[c.index.get('Body')!].head;
  const lat = (s: number) => plan.A * plan.env(clamp(s / plan.L)) * Math.sin(TAU * (s / plan.lambda - plan.freq * t));
  const curve = (s: number): V3 => [lat(s), head[1], plan.front - s];
  const sC = plan.front - head[2];
  const slope = (lat(sC + 0.005) - lat(sC - 0.005)) / 0.01;
  const forward = norm([-slope * 0.75, 0, 1]);
  const bodyRot = qArc([0, 0, 1], forward);
  const bodyOff: V3 = [lat(sC), 0, 0];
  const attach = add(add(head, bodyOff), qRot(bodyRot, sub(chain.at, head)));
  const joints: V3[] = [attach];
  const seg = chain.length / chain.segments;
  let s = plan.front - chain.at[2];
  for (let i = 0; i < chain.segments; i++) {
    const from = joints[joints.length - 1];
    let lo = s, hi = s + seg * 2;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (len(sub(curve(mid), from)) < seg) lo = mid; else hi = mid;
    }
    s = (lo + hi) / 2;
    const p = curve(s);
    joints.push([p[0], from[1] + (p[1] - from[1]), p[2]]);
  }
  return { bodyOff, bodyRot, joints };
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────

const mk = (name: string, bad: boolean[], worst: number, limit: number, unit: string, detail: string, part?: string): MotionCheck =>
  ({ name, ...(part ? { part } : {}), pass: !bad.some(Boolean), worst: r3(worst), limit: r3(limit), unit, frames: ranges(bad), detail });

function bladePoints(s: PartPiece['shape']): V3[] {
  if (s.kind !== 'blade') return s.kind === 'seg' ? [s.b] : [];
  const d = sub(s.b, s.a);
  const x = s.normal ? norm(cross(s.normal, d)) : norm(cross([0, 1, 0], d));
  const w0 = s.w / 2, w1 = (s.w / 2) * (s.taper ?? 0.24);
  return [add(s.a, mul(x, w0)), add(s.a, mul(x, -w0)), add(s.b, mul(x, w1)), add(s.b, mul(x, -w1)), add(add(s.a, s.b), [0, 0, 0]).map((v) => v / 2) as V3];
}

/** Wing checks: clear of the body, symmetric, within the stroke range, a beat that fits the wing. */
export function wingChecks(c: Creature, clip: CreatureClip, fks: FK[]): MotionCheck[] {
  const out: MotionCheck[] = [];
  const F = clip.frames + 1;
  const B = c.index.get('Body')!;
  const body = c.def.parts.find((p): p is BodyPartSpec => p.kind === 'body')!;
  const half: V3 = mul(body.size, 0.5 * 0.97);
  const bodyHead = c.bones[B].head;
  const inside = (pLocal: V3) => body.shape === 'box'
    ? Math.abs(pLocal[0]) < half[0] && Math.abs(pLocal[1]) < half[1] && Math.abs(pLocal[2]) < half[2]
    : (pLocal[0] / half[0]) ** 2 + (pLocal[1] / half[1]) ** 2 + (pLocal[2] / half[2]) ** 2 < 1;
  for (const spec of c.def.parts) {
    if (spec.kind !== 'wing') continue;
    const sides = c.wings.filter((w) => w.part === spec.id);
    const boneSet = new Set(sides.flatMap((s) => [s.arm, s.fore, s.hand]));
    // sample points: blade corners and bone tips; points already inside the body at rest are how it's built
    const samples = c.pieces.filter((pc) => boneSet.has(pc.bone)).flatMap((pc) => bladePoints(pc.shape).map((p) => ({ b: c.index.get(pc.bone)!, p })))
      .filter((s) => !inside(sub(s.p, bodyHead)));
    const bad = new Array(F).fill(false);
    let worst = 0, who = '';
    for (let f = 0; f < F; f++) {
      const fk = fks[f];
      for (const s of samples) {
        const w = bonePoint(c, fk, s.b, s.p);
        const l = qRot(qInv(fk.rot[B]), sub(w, fk.pos[B]));
        if (inside(l)) {
          bad[f] = true;
          const depth = 1 - Math.sqrt((l[0] / half[0]) ** 2 + (l[1] / half[1]) ** 2 + (l[2] / half[2]) ** 2);
          if (depth * Math.min(...half) > worst) { worst = depth * Math.min(...half); who = c.bones[s.b].name; }
        }
      }
    }
    out.push(mk('wings clear the body', bad, worst, 0, 'm deep', who ? `deepest: ${who}` : 'no feather tip or wing edge passes into the body', spec.id));
    // symmetry: the right wing mirrors the left
    const L = sides.find((s) => s.side > 0)!, R = sides.find((s) => s.side < 0)!;
    const sb = new Array(F).fill(false);
    let sw = 0;
    for (let f = 0; f < F; f++) for (const k of ['arm', 'fore', 'hand'] as const) {
      const a = clip.rot[f][c.index.get(L[k])!], b = mirrorQ(clip.rot[f][c.index.get(R[k])!]);
      const d = qAngle(a, b);
      if (d > 2) sb[f] = true;
      sw = Math.max(sw, d);
    }
    out.push(mk('wingbeat is symmetric', clip.kind === 'action' && clip.notes.includes('asymmetric wings') ? sb.map(() => false) : sb, sw, 2, '°', 'the right wing mirrors the left through the stroke', spec.id));
    // stroke range: the arm's elevation in the body's frame
    const ai = c.index.get(L.arm)!;
    const restDir = norm(sub(c.bones[ai].tail, c.bones[ai].head));
    const elev = fks.map((fk) => { const d = qRot(qInv(fk.rot[B]), qRot(fk.rot[ai], restDir)); return Math.asin(clamp(d[1], -1, 1)) * (180 / Math.PI); });
    const rb = elev.map((e) => e > 80 || e < -68);
    out.push(mk('stroke within its range', rb, Math.max(...elev.map((e) => Math.max(e - 80, -68 - e, 0))), 0, '° over', `arm elevation ${r3(Math.min(...elev))}° … ${r3(Math.max(...elev))}° (limits −68° … 80°)`, spec.id));
    // beat rate vs the wing's size (only when it beats)
    const swing = Math.max(...elev) - Math.min(...elev);
    let peaks = 0;
    for (let f = 1; f < F - 1; f++) if (elev[f] > elev[f - 1] && elev[f] >= elev[f + 1] && elev[f] > Math.min(...elev) + swing * 0.7) peaks++;
    const f0 = wingFreq(spec);
    const beating = clip.kind === 'fly' || clip.kind === 'hover' ? 1 : 0;
    const flapTime = beating ? clip.duration * (clip.kind === 'fly' ? Math.min(1, (flightPlan(spec).flaps / f0) / flightPlan(spec).cycle) : 1) : 0;
    const measured = flapTime ? peaks / flapTime : 0;
    const ratio = measured / f0;
    const fits = !beating || (ratio > 0.6 && ratio < 1.6);
    out.push({ name: 'wingbeat fits the wing size', part: spec.id, pass: fits, worst: r3(measured), limit: r3(f0), unit: 'Hz', frames: fits ? [] : [[0, F - 1]], detail: beating ? `${r3(measured)} beats/s for a ${r3(wingSpan(spec))} m span (expected ≈ ${r3(f0)})` : 'not flapping in this motion' });
  }
  return out;
}

/** Swimming checks: the wave runs tailward faster than the body moves, the tail beat is in range, the
 *  head stays steady. */
export function swimChecks(c: Creature, clip: CreatureClip, fks: FK[]): MotionCheck[] {
  const out: MotionCheck[] = [];
  if (clip.kind !== 'swim') return out;
  const F = clip.frames + 1;
  const B = c.index.get('Body')!;
  const side = norm(cross([0, 1, 0], clip.dir));
  for (const spec of c.def.parts) {
    if (spec.kind !== 'chain' || spec.motion !== 'swim') continue;
    const plan = swimPlan(c, spec, clip.speed);
    const names = Array.from({ length: spec.segments }, (_, i) => `${spec.id}.${i + 1}`);
    const tailB = c.index.get(names[names.length - 1])!;
    const tailRest = c.bones[tailB].tail;
    const latAt = (bi: number, rest: V3) => fks.map((fk) => { const p = bonePoint(c, fk, bi, rest); return p[0] * side[0] + p[2] * side[2]; });
    const tail = latAt(tailB, tailRest);
    const amp = Math.max(...tail.map(Math.abs)) / plan.L;
    const ab = tail.map((x) => Math.abs(x) / plan.L > 0.17);
    out.push(mk('tail beat in range', amp < 0.035 ? ab.map(() => true) : ab, amp, 0.17, '× body length', `the tail swings ±${r3(amp)} body lengths (a fish ±0.05–0.15)`, spec.id));
    // wave speed: the lag between the lateral swing a third of the way down and at the tail
    const k1 = Math.max(0, Math.floor(spec.segments / 3) - 1);
    const b1 = c.index.get(names[k1])!;
    const mid = latAt(b1, c.bones[b1].tail);
    const s1 = plan.front - c.bones[b1].tail[2], s2 = plan.front - tailRest[2];
    const n = F - 1;
    const corr = Array.from({ length: n }, (_, lag) => { let acc = 0; for (let f = 0; f < n; f++) acc += mid[f] * tail[(f + lag) % n]; return acc; });
    const best = Math.max(...corr);
    // the first lag at the top of the correlation (a loop of several beats peaks once per beat)
    let bestLag = corr.findIndex((v, i) => v >= best * 0.95 && v >= corr[(i + n - 1) % n] && v >= corr[(i + 1) % n]);
    if (bestLag < 0) bestLag = corr.indexOf(best);
    const V = bestLag ? (s2 - s1) / (bestLag / clip.fps) : Infinity;
    const slip = clip.speed / V;
    const ok = V > clip.speed && slip > 0.25 && slip < 0.95;
    out.push({ name: 'body wave runs tailward faster than it swims', part: spec.id, pass: ok, worst: r3(slip), limit: 0.95, unit: 'U/V', frames: ok ? [] : [[0, F - 1]], detail: `wave ${r3(V)} m/s down the body, swimming ${r3(clip.speed)} m/s (slip ${r3(slip)}; fish ≈ 0.7, eel ≈ 0.45)` });
    const yaw = clip.rot.map((r) => qAngle(r[B], qIdentity()));
    out.push(mk('head stays steady', yaw.map((y) => y > 15), Math.max(...yaw), 15, '°', 'the head yaws a little against the tail (recoil), not with it', spec.id));
  }
  return out;
}
