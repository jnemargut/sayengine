// Parametric motion (Decision 16): walk, run, idle, turn and library actions baked from settings onto
// the character's own skeleton. Legs are solved with two-bone IK against planned foot paths, so feet
// stay planted while they carry weight and the clip re-fits when the body changes (longer legs → longer
// stride). Each clip also carries the life layer (life.ts): breathing, weight shifts, head drift, blinks
// and glances, so a character never stands frozen between lines.
//
// Clips are "in place": the hips stay over the origin and the game moves the node at `speed` m/s.
// Pure functions: MotionSpec + Rig (+ the character's hands/expression) → MotionClip.
import { type Rig, type V3, type Q, qMul, qAxisAngle, qIdentity, qRot, forward, localRotations, handRotations, NAMED_HAND_POSES } from './rig.ts';
import type { CharacterState, HandPose, MotionSpec } from './types.ts';
import { ambientLife, hashSeed, rng } from './life.ts';
import { applyTail, applyWings, bakeQuad, quadReport } from './quadruped.ts';

export interface MotionClip {
  id: string;
  kind: MotionSpec['kind'];
  fps: number;
  frames: number;                 // frames in [0, duration); a loop's frame `frames` equals frame 0
  duration: number;               // s
  loop: boolean;
  speed: number;                  // m/s the character travels while it plays (0 in place)
  turn?: number;                  // degrees turned by the end (turn clips)
  stride?: number;                // m per cycle (walk/run)
  travel?: V3;                    // start/stop: where the hips end up (m, object space); the game moves the character by it when the clip ends
  local: Q[][];                   // [frame][bone] local rotations (frames + 1 entries: the last closes a loop)
  hips: V3[];                     // [frame] Hips offset from its rest position (object space)
  contacts: { left: boolean[]; right: boolean[] };   // foot planted (carrying weight) per frame
  feet: { left: V3[]; right: V3[] };                  // planned ankle positions (object space, in place)
  shapes: Record<string, number[]>;                   // shape-key curves (blinks), 0..1
  reachMiss: number;              // worst distance (m) a foot target was beyond the leg's reach
  paws?: Record<'LF' | 'RF' | 'LH' | 'RH', { down: boolean[]; p: V3[] }>;   // four-legged bodies: every paw (contacts/feet hold the hind pair)
  settings: Required<Pick<MotionSpec, 'energy'>> & MotionSpec;
}

const D2R = Math.PI / 180;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (u: number) => { const t = clamp(u); return t * t * (3 - 2 * t); };
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const qInv = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const X = (deg: number) => qAxisAngle([1, 0, 0], deg);
const Y = (deg: number) => qAxisAngle([0, 1, 0], deg);
const Z = (deg: number) => qAxisAngle([0, 0, 1], deg);
const mulAll = (...qs: Q[]) => qs.reduce((a, b) => qMul(a, b), qIdentity());

/** The rotation taking unit vector a to unit vector b (shortest arc). */
export function qArc(a: V3, b: V3): Q {
  const d = dot(a, b);
  if (d < -0.999999) { const ax = Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]); return qAxisAngle(norm(ax), 180); }
  const c = cross(a, b);
  const q: Q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qSlerp(a: Q, b: Q, t: number): Q {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb: Q = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
  d = Math.abs(d);
  if (d > 0.9995) { const r: Q = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]; const l = Math.hypot(...r); return [r[0] / l, r[1] / l, r[2] / l, r[3] / l]; }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
/** Angle (degrees) between two rotations. */
export const qAngle = (a: Q, b: Q) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) / D2R;

const lerpHand = (a: HandPose, b: HandPose, t: number): HandPose => ({
  thumb: a.thumb + (b.thumb - a.thumb) * t, index: a.index + (b.index - a.index) * t, middle: a.middle + (b.middle - a.middle) * t,
  ring: a.ring + (b.ring - a.ring) * t, little: a.little + (b.little - a.little) * t, spread: a.spread + (b.spread - a.spread) * t,
});

// ── the library of one-off actions (Decision 16: "clips for one-off actions") ───────────────────────
// Keys are times (fraction of the action) with bone rotations as steps applied in order
// ([axis, degrees] pairs: [['y', 90], ['x', -60]] turns about Y, then about X), a hips drop (m, scaled
// by height) and hand poses. Bones not named in a key stay in the standing posture.
type Step = Array<['x' | 'y' | 'z', number]>;
/** One key of a library action. `ease` shapes the move INTO this key: smooth (default), in (accelerating:
 *  a strike), out (decelerating: settling into a wind-up), back (overshoots, then settles). `shift` moves
 *  the weight (hips, m × body scale: x to the character's left, z forward); `yaw` turns the hips. */
interface ActionKey { at: number; bones?: Record<string, Step>; drop?: number; hands?: { left?: string; right?: string }; ease?: 'smooth' | 'in' | 'out' | 'back'; shift?: [number, number]; yaw?: number }
export interface ActionDef { label: string; duration: number; keys: ActionKey[] }
const armUp = (side: 'Left' | 'Right', fwd: number, raise: number): Step => [['y', side === 'Left' ? -fwd : fwd], ['x', -raise]];
export const ACTIONS: Record<string, ActionDef> = {
  wave: {
    label: 'Wave hello (right hand)', duration: 2.2,
    keys: [
      { at: 0 },
      { at: 0.2, bones: { RightUpperArm: [['z', -20], ['x', -10]], RightLowerArm: [['z', -95]], RightHand: [['z', -10]] }, hands: { right: 'open-palm' } },
      { at: 0.35, bones: { RightUpperArm: [['z', -20], ['x', -10]], RightLowerArm: [['z', -70]], RightHand: [['z', 10]] }, hands: { right: 'open-palm' } },
      { at: 0.5, bones: { RightUpperArm: [['z', -20], ['x', -10]], RightLowerArm: [['z', -105]], RightHand: [['z', -12]] }, hands: { right: 'open-palm' } },
      { at: 0.65, bones: { RightUpperArm: [['z', -20], ['x', -10]], RightLowerArm: [['z', -70]], RightHand: [['z', 10]] }, hands: { right: 'open-palm' } },
      { at: 0.8, bones: { RightUpperArm: [['z', -20], ['x', -10]], RightLowerArm: [['z', -95]] }, hands: { right: 'open-palm' } },
      { at: 1 },
    ],
  },
  nod: {
    label: 'Nod yes', duration: 1.3,
    keys: [{ at: 0 }, { at: 0.3, bones: { Neck: [['x', 6]], Head: [['x', 12]] } }, { at: 0.55, bones: { Neck: [['x', -2]], Head: [['x', -4]] } }, { at: 0.75, bones: { Neck: [['x', 4]], Head: [['x', 8]] } }, { at: 1 }],
  },
  shrug: {
    label: 'Shrug', duration: 1.6,
    keys: [
      { at: 0 },
      { at: 0.35, bones: { LeftShoulder: [['z', 12]], RightShoulder: [['z', -12]], LeftUpperArm: [['z', -62], ['x', -10]], RightUpperArm: [['z', 62], ['x', -10]], LeftLowerArm: [['y', -70]], RightLowerArm: [['y', 70]], LeftHand: [['x', -60]], RightHand: [['x', -60]], Head: [['z', 8]] }, hands: { left: 'open-palm', right: 'open-palm' } },
      { at: 0.65, bones: { LeftShoulder: [['z', 12]], RightShoulder: [['z', -12]], LeftUpperArm: [['z', -62], ['x', -10]], RightUpperArm: [['z', 62], ['x', -10]], LeftLowerArm: [['y', -70]], RightLowerArm: [['y', 70]], LeftHand: [['x', -60]], RightHand: [['x', -60]], Head: [['z', 8]] }, hands: { left: 'open-palm', right: 'open-palm' } },
      { at: 1 },
    ],
  },
  point: {
    label: 'Point ahead (right hand)', duration: 1.8,
    keys: [{ at: 0 }, { at: 0.3, bones: { RightUpperArm: armUp('Right', 82, 8), RightLowerArm: [['y', 8]], Chest: [['y', -6]] }, hands: { right: 'point' } }, { at: 0.75, bones: { RightUpperArm: armUp('Right', 82, 8), RightLowerArm: [['y', 8]], Chest: [['y', -6]] }, hands: { right: 'point' } }, { at: 1 }],
  },
  'hammer-strike': {
    // anticipation (a slow wind-up: weight back, chest turns away, the hammer cocked high), a fast
    // accelerating downswing, impact with the knees softening and the weight forward, a follow-through
    // past the anvil, a small rebound, then settling back
    label: 'Wind up and strike down with the right hand (holds whatever is in it)', duration: 1.8,
    keys: [
      { at: 0 },
      { at: 0.1, bones: { RightUpperArm: armUp('Right', 50, -20), RightLowerArm: [['z', -40]], Chest: [['y', -4]] }, shift: [0.005, -0.008] },
      { at: 0.38, bones: { RightUpperArm: armUp('Right', 70, 62), RightLowerArm: [['z', -106]], RightHand: [['z', -38]], Chest: [['x', -7], ['y', -16]], Spine: [['x', -3], ['y', -6]], Neck: [['x', 4]], Head: [['x', 3]] }, shift: [0.01, -0.03], yaw: -7, ease: 'out' },
      { at: 0.45, bones: { RightUpperArm: armUp('Right', 71, 64), RightLowerArm: [['z', -108]], RightHand: [['z', -40]], Chest: [['x', -7], ['y', -17]], Spine: [['x', -3], ['y', -6]], Neck: [['x', 4]], Head: [['x', 3]] }, shift: [0.01, -0.032], yaw: -7.5 },
      { at: 0.54, bones: { RightUpperArm: armUp('Right', 84, -34), RightLowerArm: [['z', -8]], RightHand: [['z', 16]], Chest: [['x', 10], ['y', 7]], Spine: [['x', 7], ['y', 2]], Neck: [['x', -3]], Head: [['x', 4]] }, drop: 0.045, shift: [0, 0.035], yaw: 4, ease: 'in' },
      { at: 0.6, bones: { RightUpperArm: armUp('Right', 85, -41), RightLowerArm: [['z', -3]], RightHand: [['z', 22]], Chest: [['x', 12], ['y', 9]], Spine: [['x', 8], ['y', 3]], Neck: [['x', -4]], Head: [['x', 5]] }, drop: 0.055, shift: [0, 0.04], yaw: 5, ease: 'out' },
      { at: 0.7, bones: { RightUpperArm: armUp('Right', 84, -27), RightLowerArm: [['z', -20]], RightHand: [['z', 8]], Chest: [['x', 7], ['y', 4]], Spine: [['x', 5]], Neck: [['x', -2]], Head: [['x', 3]] }, drop: 0.032, shift: [0, 0.025], yaw: 2.5, ease: 'out' },
      { at: 0.78, bones: { RightUpperArm: armUp('Right', 84, -30), RightLowerArm: [['z', -16]], RightHand: [['z', 10]], Chest: [['x', 8], ['y', 4]], Spine: [['x', 5]] }, drop: 0.036, shift: [0, 0.027], yaw: 3 },
      { at: 1 },
    ],
  },
  'pick-up': {
    label: 'Crouch and reach down with both hands', duration: 2.4,
    keys: [
      { at: 0 },
      { at: 0.4, bones: { Spine: [['x', 24]], Chest: [['x', 18]], Neck: [['x', -12]], Head: [['x', -10]], LeftUpperArm: armUp('Left', 70, -50), RightUpperArm: armUp('Right', 70, -50), LeftLowerArm: [['y', -15]], RightLowerArm: [['y', 15]] }, drop: 0.2, hands: { left: 'relaxed', right: 'relaxed' } },
      { at: 0.6, bones: { Spine: [['x', 24]], Chest: [['x', 18]], Neck: [['x', -12]], Head: [['x', -10]], LeftUpperArm: armUp('Left', 70, -50), RightUpperArm: armUp('Right', 70, -50), LeftLowerArm: [['y', -15]], RightLowerArm: [['y', 15]] }, drop: 0.2, hands: { left: 'fist', right: 'fist' } },
      { at: 1 },
    ],
  },
  'look-around': {
    label: 'Look left, then right', duration: 3,
    keys: [{ at: 0 }, { at: 0.25, bones: { Neck: [['y', 18]], Head: [['y', 22]], Chest: [['y', 6]] } }, { at: 0.45, bones: { Neck: [['y', 18]], Head: [['y', 22]], Chest: [['y', 6]] } }, { at: 0.7, bones: { Neck: [['y', -18]], Head: [['y', -22]], Chest: [['y', -6]] } }, { at: 0.85, bones: { Neck: [['y', -18]], Head: [['y', -22]], Chest: [['y', -6]] } }, { at: 1 }],
  },
};

/** Easing of a move into a key: smoothstep; accelerating (in); decelerating (out); overshoot and settle (back). */
export function keyEase(kind: ActionKey['ease'], u: number): number {
  const t = clamp(u);
  if (kind === 'in') return t * t * t;
  if (kind === 'out') return 1 - (1 - t) ** 3;
  if (kind === 'back') { const c = 1.6; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; }
  return t * t * (3 - 2 * t);
}
const stepQ = (s: Step): Q => s.reduce<Q>((q, [ax, deg]) => qMul(ax === 'x' ? X(deg) : ax === 'y' ? Y(deg) : Z(deg), q), qIdentity());

export const MOTION_DEFAULTS = {
  walk: { speed: 1.3, bounce: 0.022, armSwing: 16, lean: 3, sway: 0.018, duty: 0.62, lift: 0.07 },
  // a real run: long flight (both feet off the ground ~40% of the cycle), forward lean, high knee drive
  // and heel recovery, a strong arm pump, ~170 steps/min
  run: { speed: 3.4, bounce: 0.045, armSwing: 46, lean: 19, sway: 0.008, duty: 0.26, lift: 0.3 },
  idle: { duration: 6, sway: 0.022 },
  start: { duration: 0.8 },
  stop: { duration: 0.9 },
};

/** A human's leg length (hip to ankle) at 1.75 m: gaits scale with leg length / this. */
export const HUMAN_LEG = 0.7833;
export const gaitScale = (legLen: number) => legLen / HUMAN_LEG;
/** Gait styles (Decision 48 A): multipliers on the computed walk. A waddle rocks over each foot with a
 *  wide stance and short steps; a swagger rolls the shoulders and swings the arms; a shuffle barely
 *  lifts its feet; a bounce dips into every step. */
export interface GaitStyle { speed: number; stride: number; sway: number; swing: number; lean: number; bounce: number; lift: number; widen: number; roll: number; yaw: number; shoulders: number; out: number; dip: number }
export const GAIT_STYLES: Record<string, GaitStyle> = {
  '': { speed: 1, stride: 1, sway: 1, swing: 1, lean: 0, bounce: 1, lift: 1, widen: 1, roll: 0, yaw: 1, shoulders: 1, out: 0, dip: 0 },
  waddle: { speed: 0.8, stride: 0.78, sway: 1.4, swing: 0.6, lean: -1, bounce: 0.6, lift: 0.7, widen: 1.12, roll: -5, yaw: 0.5, shoulders: 0.6, out: 14, dip: 0 },
  swagger: { speed: 0.92, stride: 1.03, sway: 1.5, swing: 1.5, lean: -2.5, bounce: 1.1, lift: 1, widen: 1.06, roll: 1.5, yaw: 1.7, shoulders: 2.4, out: 6, dip: 0 },
  shuffle: { speed: 0.7, stride: 0.66, sway: 0.8, swing: 0.5, lean: 5, bounce: 0.35, lift: 0.4, widen: 1, roll: 0, yaw: 0.7, shoulders: 1, out: 0, dip: 0 },
  bounce: { speed: 1.05, stride: 0.96, sway: 1, swing: 1.25, lean: 0, bounce: 2.2, lift: 1.35, widen: 1, roll: 0, yaw: 1.1, shoulders: 1, out: 0, dip: 0.014 },
};

/** Validate settings and fill defaults (throws a readable error). */
export function motionSettings(spec: MotionSpec): MotionClip['settings'] {
  const kinds = ['walk', 'run', 'idle', 'turn', 'action', 'start', 'stop', 'trot', 'gallop', 'sit', 'lie'];
  if (!kinds.includes(spec.kind)) throw new Error(`motion kind must be one of ${kinds.join(', ')}`);
  const num = (k: keyof MotionSpec, lo: number, hi: number) => {
    const v = spec[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`motion ${k} must be between ${lo} and ${hi} (got ${v})`);
  };
  num('speed', spec.kind === 'run' ? 1.8 : 0.3, spec.kind === 'run' ? 7 : 2.2);
  num('stride', 0.3, 4); num('bounce', 0, 0.12); num('armSwing', 0, 70); num('lean', -10, 25); num('sway', 0, 0.08);
  num('energy', 0, 1); num('duration', 0.5, 30); num('turn', -180, 180); num('flap', 0, 6);
  if (spec.kind === 'action') {
    if (!spec.action) throw new Error(`an action motion needs --action (${Object.keys(ACTIONS).join(', ')})`);
    if (!ACTIONS[spec.action]) throw new Error(`no action "${spec.action}" — library: ${Object.keys(ACTIONS).join(', ')}`);
  }
  if (spec.kind === 'turn' && spec.turn === undefined) throw new Error('a turn motion needs --turn degrees (+ = to the left)');
  if (spec.style !== undefined && !GAIT_STYLES[spec.style]) throw new Error(`motion style must be one of ${Object.keys(GAIT_STYLES).filter(Boolean).join(', ')}`);
  return { ...spec, energy: spec.energy ?? 0.5 };
}

interface Frame { hipsOff: V3; hipsQ: Q; body: Record<string, Q>; hands?: { left?: HandPose; right?: HandPose }; feet: { left: FootTarget; right: FootTarget } }
interface FootTarget { p: V3; q: Q; down: boolean; toes?: Q }

/** Bake a motion for a rigged character. `state` gives the hands (and what they hold) and expression. */
export function bakeMotion(id: string, spec: MotionSpec, rig: Rig, state: CharacterState | undefined, fps = 30): MotionClip {
  const S = motionSettings(spec);
  if (rig.spec.quad) {
    const q = bakeQuad(S, rig, state, fps);
    return {
      id, kind: S.kind, fps, frames: q.frames, duration: +q.duration.toFixed(4), loop: q.loop, speed: +q.speed.toFixed(4), ...(q.stride ? { stride: +q.stride.toFixed(4) } : {}),
      local: q.local, hips: q.hips, contacts: { left: q.contacts.LH, right: q.contacts.RH }, feet: { left: q.paws.LH, right: q.paws.RH },
      paws: Object.fromEntries((['LF', 'RF', 'LH', 'RH'] as const).map((k) => [k, { down: q.contacts[k], p: q.paws[k] }])) as MotionClip['paws'],
      shapes: q.shapes, reachMiss: +q.reachMiss.toFixed(4), settings: S,
    };
  }
  if (['trot', 'gallop', 'sit', 'lie'].includes(S.kind)) throw new Error(`${S.kind} is a four-legged motion (this character stands on two legs: walk, run, idle, turn, action, start, stop)`);
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const bone = (n: string) => rig.bones[idx.get(n)!];
  const s = rig.spec.s, en = S.energy;
  const hipsRest = bone('Hips').head;
  const leg = (side: 'Left' | 'Right') => {
    const up = bone(`${side}UpperLeg`), lo = bone(`${side}LowerLeg`), ft = bone(`${side}Foot`);
    return { hip: up.head, l1: len(sub(lo.head, up.head)), l2: len(sub(ft.head, lo.head)), dir1: norm(sub(lo.head, up.head)), dir2: norm(sub(ft.head, lo.head)), ankle: ft.head };
  };
  const L = leg('Left'), R = leg('Right');
  const legLen = L.l1 + L.l2;
  const ankleY = L.ankle[1];
  const holds = state?.holds ?? {};
  const restHands = { left: state?.hands?.left ?? NAMED_HAND_POSES.relaxed, right: state?.hands?.right ?? NAMED_HAND_POSES.relaxed };
  const seed = S.seed ?? hashSeed(`${id}:${S.kind}`);

  // ── the standing posture: arms hang relaxed at the sides (a held prop keeps its arm a little bent) ──
  const arm = (side: 'Left' | 'Right', swing: number, bend: number, out = 0): Record<string, Q> => {
    const sx = side === 'Left' ? 1 : -1;
    const holding = !!holds[side === 'Left' ? 'left' : 'right'];
    const down = 74 - out - (holding ? 6 : 0);
    return {
      [`${side}UpperArm`]: qMul(X(-swing - (holding ? 12 : 3)), Z(-sx * down)),
      [`${side}LowerArm`]: Y(-sx * (bend + (holding ? 28 : 0))),
      [`${side}Hand`]: Z(sx * 4),
    };
  };
  const breathe = (b: number): Record<string, Q> => ({ Chest: X(-0.9 * b), UpperChest: X(-1.4 * b), LeftShoulder: Z(1.2 * b), RightShoulder: Z(-1.2 * b) });

  let frames: number, duration: number, loop: boolean, speed = 0, stride: number | undefined, turnDeg: number | undefined, travel: V3 | undefined;
  let make: (t: number) => Frame;
  const restFoot = (side: 'Left' | 'Right', widen = 1): V3 => { const a = side === 'Left' ? L.ankle : R.ankle; return [a[0] * widen, ankleY, a[2]]; };
  const flat = qIdentity();

  if (S.kind === 'walk' || S.kind === 'run') {
    const D = MOTION_DEFAULTS[S.kind];
    const run = S.kind === 'run';
    // everything scales with leg length (bodies of different sizes walk alike at the same Froude number):
    // short legs patter with quick steps, long legs lope; for a human g = height / 1.75
    const g = gaitScale(legLen), sg = Math.sqrt(g);
    const SM0 = GAIT_STYLES[S.style ?? ''] ?? GAIT_STYLES[''];
    // a style changes how a walk steps; a run keeps its mechanics and only takes the upper-body flavour
    const SM = run ? { ...GAIT_STYLES[''], swing: SM0.swing, yaw: SM0.yaw, shoulders: SM0.shoulders } : SM0;
    const v = S.speed ?? D.speed * sg * SM.speed;
    const k = 0.6 + 0.8 * en;                                          // energy scales the flourishes
    // runners lengthen the stride more than they quicken the step: ~170 steps/min at 3.4 m/s, ~180 sprinting
    const strideWanted = S.stride ?? (run ? legLen * 3.28 * (v / (3.4 * sg)) ** 0.85 : legLen * 1.55 * (v / (1.3 * sg)) ** 0.42) * SM.stride;
    frames = Math.max(12, Math.round((strideWanted / v) * fps));
    duration = frames / fps;
    stride = strideWanted; speed = stride / duration; loop = true;
    // a faster run spends less of the stride on the ground (the stance stays about as long in metres;
    // the extra length is flight)
    const duty = run ? clamp(D.duty - (v / sg - 3.4) * 0.042, 0.16, 0.33) : D.duty, Lst = stride * duty;
    const swing = (S.armSwing ?? D.armSwing * SM.swing) * k, sway = (S.sway ?? D.sway * s * SM.sway);
    // a faster run leans further into it
    const lean = S.lean ?? (run ? D.lean * (0.85 + 0.25 * clamp((v / sg - 3) / 3)) : D.lean + SM.lean);
    const yawAmp = (run ? 7 : 5) * k * SM.yaw, lift = D.lift * s * (run ? 1 : 0.8 + 0.4 * en) * SM.lift;
    // the foot rolls: it lands on the heel (toe up), goes flat, then the heel lifts and it pivots over
    // the ball of the foot (toes stay on the ground) before it leaves. The planted point — heel, then
    // sole, then ball — moves back at exactly the ground's speed. Runners land flatter.
    const ankleZ = L.ankle[2];
    const front = run ? 0.5 : 0.4;
    const toeJoint = bone('LeftToes').head;
    const heelRel: V3 = [0, -ankleY, -0.035 * s], ballRel: V3 = [0, toeJoint[1] - ankleY, toeJoint[2] - ankleZ];
    // a faster walk pushes off harder over the toes (that, not a deeper dip, makes the longer step)
    const brisk = clamp((v / sg - 1.2) / 0.7);
    const strikeU = run ? 0.04 : 0.12, strikeDeg = run ? -4 : -14, offU = run ? 0.42 : 0.55 - 0.08 * brisk, offDeg = run ? 34 : 32 + 16 * brisk;
    const pivot = (pt: V3, rel: V3, deg: number): V3 => { const o = qRot(X(deg), mul(rel, -1)); return add(pt, o); };
    const stance = (r: V3, u: number) => {
      // where the ankle would be with the foot flat: a walker lands a little ahead and pushes off further
      // behind (rolling over the toes), so the hips stay high; a runner lands under the body
      const zA = r[2] + Lst * front - u * Lst;
      if (u < strikeU) { const deg = strikeDeg * (1 - ease(u / strikeU)); return { p: pivot([r[0], 0, zA + heelRel[2]], heelRel, deg), deg }; }
      if (u < offU) return { p: [r[0], ankleY, zA] as V3, deg: 0 };
      const deg = offDeg * ease((u - offU) / (1 - offU));
      return { p: pivot([r[0], toeJoint[1], zA + ballRel[2]], ballRel, deg), deg };
    };
    const footPath = (side: 'Left' | 'Right', phi: number) => {
      const r = restFoot(side, (run ? 0.75 : 0.85) * SM.widen);
      if (phi < duty) { const st = stance(r, phi / duty); return { p: st.p, q: X(st.deg), toes: st.deg > 0 ? X(-st.deg) : flat, down: true }; }
      const u = (phi - duty) / (1 - duty);
      const a = stance(r, 1), b = stance(r, 0);
      if (run) {
        // heel recovery: the foot leaves behind and folds up toward the seat first, then the knee
        // drives forward and the foot reaches out and comes down under the body
        const e = ease(clamp((u - 0.12) / 0.8));
        const up = Math.sin(Math.PI * clamp(u / 0.92) ** 0.7);
        const y = a.p[1] + (b.p[1] - a.p[1]) * e + lift * up;
        const back = -0.09 * s * Math.sin(Math.PI * clamp(u / 0.55));
        const deg = a.deg + (b.deg - a.deg) * ease(u * 1.15) + 25 * Math.sin(Math.PI * clamp(u / 0.6));
        return { p: [r[0], y, a.p[2] + (b.p[2] - a.p[2]) * e + back] as V3, q: X(deg), toes: X(-a.deg * (1 - ease(u / 0.35))), down: false };
      }
      const e = ease(u);
      const y = a.p[1] + (b.p[1] - a.p[1]) * e + lift * Math.sin(Math.PI * u) ** 1.3;
      const deg = a.deg + (b.deg - a.deg) * ease(u * 1.2);
      return { p: [r[0], y, a.p[2] + (b.p[2] - a.p[2]) * e] as V3, q: X(deg), toes: X(-a.deg * (1 - ease(u / 0.35))), down: false };
    };
    // hip height from the actual foot paths: the highest the hips can ride with every foot in reach
    // (a soft knee at full stretch), then the bounce on top of that
    const bobAt = (p: number) => (run ? (1 + Math.cos(4 * Math.PI * p)) / 2 : (1 - Math.cos(4 * Math.PI * p)) / 2);
    const bounceWanted = (S.bounce ?? D.bounce * s * SM.bounce) * k;
    const hipDrop = L.hip[1] - hipsRest[1];
    let baseY = hipsRest[1] - (run ? 0.03 * s : 0.004 * s);
    const reach = legLen * (run ? 0.985 : 0.985);
    for (let i = 0; i < 64; i++) {
      const p = i / 64;
      for (const [side, ph] of [['Left', p], ['Right', (p + 0.5) % 1]] as const) {
        const fp = footPath(side, ph);
        if (!fp.down) continue;
        const f = fp.p, hx = (side === 'Left' ? L : R).hip[0];
        const dx = f[0] - hx, dz = f[2];
        const allowed = f[1] + Math.sqrt(Math.max(0, reach ** 2 - dx * dx - dz * dz)) - hipDrop - bounceWanted * bobAt(p);
        baseY = Math.min(baseY, allowed);
      }
    }
    const bounce = bounceWanted;
    const walkReach = legLen * 0.995;
    make = (t) => {
      const p = t / duration, w = 2 * Math.PI * p;
      const fl = footPath('Left', p % 1), fr = footPath('Right', (p + 0.5) % 1);
      // hips: lowest when a foot lands (walk) / mid-stance (run); shift over the standing foot; turn with the legs
      const bob = bobAt(p);
      const swayX = sway * Math.cos(w - Math.PI * duty);
      let hipY = baseY + bounce * bob;
      if (!run) {
        // a walk vaults over the planted leg (an inverted pendulum): the hips ride as high as the
        // planted leg reaches nearly straight, highest at mid-stance, lowest where both feet are down
        // (a soft minimum rounds that corner), never above standing height
        const k = 0.012 * s;
        let acc = 0;
        for (const [side, f] of [['Left', fl], ['Right', fr]] as const) {
          if (!f.down) continue;
          const hx = (side === 'Left' ? L : R).hip[0] + swayX;
          const dx = f.p[0] - hx, dz = f.p[2];
          const top = f.p[1] + Math.sqrt(Math.max(0, walkReach ** 2 - dx * dx - dz * dz)) - hipDrop;
          acc += Math.exp(-(top - hipsRest[1]) / k);
        }
        hipY = Math.min(hipsRest[1] - 0.003 * s, acc > 0 ? hipsRest[1] - k * Math.log(acc) : baseY);
        // a bouncy gait dips into each step (where both feet are down)
        if (SM.dip) hipY -= SM.dip * s * (1 + Math.cos(4 * Math.PI * (p - duty / 2 + 0.25))) / 2;
      }
      const hipsOff: V3 = [swayX, hipY - hipsRest[1], 0];
      const yaw = -yawAmp * Math.cos(w);
      // a waddle rocks the whole body over the standing foot; others only tilt the hips a little
      const roll = (1.5 * k + SM.roll) * Math.sin(w - Math.PI * duty);
      const hipsQ = qMul(Y(yaw), Z(roll));
      const breath = Math.sin((2 * Math.PI * t) / duration);
      const armR = swing * Math.cos(w), armLf = -swing * Math.cos(w);
      // a runner pumps the arms: elbows near 90°, closing as the hand drives forward
      const bend = run ? 88 : 12, bendExtra = run ? 22 : 18;
      // the spine stays upright against the hips' roll (a waddle keeps a little of it)
      const counter = SM.roll ? -roll * 0.55 : 0;
      const body: Record<string, Q> = {
        Spine: qMul(qMul(X(lean * 0.5), Y(-yaw * 0.5)), Z(counter * 0.6)),
        Chest: qMul(qMul(X(lean * 0.3 + (run ? -0.6 * breath : 0)), Y(-yaw * 0.45)), Z(counter * 0.4)),
        UpperChest: Y(-yaw * 0.35 * SM.shoulders),
        Neck: X(-lean * 0.35),
        Head: qMul(X(-lean * 0.45 - (bounce / s) * 40 * (bob - 0.5)), Y(yaw * 0.3)),
        ...arm('Left', holds.left ? armLf * 0.25 : armLf, bend + bendExtra * Math.max(0, armLf / Math.max(1, swing)), run ? 4 : SM.out),
        ...arm('Right', holds.right ? armR * 0.25 : armR, bend + bendExtra * Math.max(0, armR / Math.max(1, swing)), run ? 4 : SM.out),
      };
      const runHand = { ...NAMED_HAND_POSES.relaxed, index: 0.55, middle: 0.6, ring: 0.65, little: 0.7, thumb: 0.45 };
      return { hipsOff, hipsQ, body, hands: run ? { left: holds.left ? restHands.left : runHand, right: holds.right ? restHands.right : runHand } : undefined, feet: { left: fl, right: fr } };
    };
  } else if (S.kind === 'idle') {
    duration = S.duration ?? MOTION_DEFAULTS.idle.duration;
    frames = Math.max(2, Math.round(duration * fps)); duration = frames / fps; loop = true;
    const r = rng(seed);
    const shift = (S.sway ?? MOTION_DEFAULTS.idle.sway * s) * (0.7 + 0.6 * en);
    const breaths = Math.max(1, Math.round(duration / (4.2 - 1.2 * en)));
    // head drift: a few slow harmonics of the loop, so it never repeats within the loop and closes it
    const harm = [1, 2, 3].map((h) => ({ h, yaw: (r() * 2 - 1) * 3.2 / h, pitch: (r() * 2 - 1) * 1.8 / h, ph: r() * 2 * Math.PI, ph2: r() * 2 * Math.PI }));
    const fl = restFoot('Left', 1.08), fr = restFoot('Right', 1.08);
    fl[2] += 0.03 * s; fr[2] -= 0.02 * s;
    make = (t) => {
      const w = (2 * Math.PI * t) / duration;
      const x = shift * Math.sin(w);
      const b = Math.sin(breaths * w);
      const hipsOff: V3 = [x, -0.004 * s - 0.003 * s * Math.abs(Math.sin(w)), 0];
      const hipsQ = qMul(Z(-(x / s) * 60), Y(1.2 * Math.sin(w + 0.7)));
      let hy = 0, hp = 0;
      for (const hm of harm) { hy += hm.yaw * Math.sin(hm.h * w + hm.ph); hp += hm.pitch * Math.sin(hm.h * w + hm.ph2); }
      const lean = (x / s) * 40;
      const body: Record<string, Q> = {
        Spine: Z(lean * 0.6), Chest: qMul(Z(lean * 0.4), X(-0.9 * b)), ...breathe(b),
        Neck: Y(hy * 0.4), Head: qMul(X(hp - 0.6 * b), Y(hy * 0.6)),
        ...arm('Left', 1.5 * Math.sin(w + 1.1), 14 + 2 * b), ...arm('Right', 1.5 * Math.sin(w + 2.3), 14 + 2 * b),
      };
      body.UpperChest = qMul(body.UpperChest, Z(lean * 0.2));
      return { hipsOff, hipsQ, body, feet: { left: { p: fl, q: flat, down: true }, right: { p: fr, q: flat, down: true } } };
    };
  } else if (S.kind === 'turn') {
    const A = S.turn!;
    duration = S.duration ?? 0.55 + (Math.abs(A) / 180) * 0.7;
    frames = Math.max(8, Math.round(duration * fps)); duration = frames / fps; loop = false; turnDeg = A;
    const lead: 'Left' | 'Right' = A >= 0 ? 'Left' : 'Right', trail = lead === 'Left' ? 'Right' : 'Left';
    const win = { [lead]: [0.06, 0.52], [trail]: [0.42, 0.92] } as Record<'Left' | 'Right', [number, number]>;
    const lift = 0.06 * s;
    make = (t) => {
      const u = t / duration;
      const hy = A * ease((u - 0.04) / 0.86);
      const chestY = (A * ease((u + 0.06) / 0.8) - hy) * 0.6, headY = (A * ease((u + 0.14) / 0.7) - hy) * 0.6;
      const foot = (side: 'Left' | 'Right') => {
        const [a, b] = win[side];
        const k = clamp((u - a) / (b - a));
        const ang = A * ease(k);
        const p0 = restFoot(side, 1.05);
        const p = qRot(Y(ang), p0);
        p[1] += lift * Math.sin(Math.PI * k);
        return { p, q: qMul(Y(ang), X(10 * Math.sin(Math.PI * k))), down: k <= 0 || k >= 1 };
      };
      const b = Math.sin(2 * Math.PI * u);
      return {
        hipsOff: [0, -0.02 * s * Math.sin(Math.PI * u), 0], hipsQ: Y(hy),
        body: { Spine: Y(chestY * 0.5), Chest: Y(chestY * 0.5), ...breathe(b * 0.5), Neck: Y(headY * 0.5), Head: Y(headY * 0.5), ...arm('Left', -6 * Math.sin(Math.PI * u) * Math.sign(A), 16), ...arm('Right', 6 * Math.sin(Math.PI * u) * Math.sign(A), 16) },
        feet: { left: foot('Left'), right: foot('Right') },
      };
    };
  } else if (S.kind === 'start' || S.kind === 'stop') {
    // ── start / stop steps (the walk ↔ idle transitions): the hips travel inside the clip (the game moves
    // the character by `travel` when it ends), the left foot stays planted the whole time, the right foot
    // steps out into the walk (start) or comes in beside the left (stop) ──
    const startK = S.kind === 'start';
    const ws: MotionSpec = { ...(state?.motions?.[S.from ?? 'walk'] ?? { kind: 'walk' }), kind: 'walk', ...(S.speed ? { speed: S.speed } : {}) };
    const W = bakeMotion('_walk', ws, rig, state, fps);
    const I = bakeMotion('_idle', { kind: 'idle', energy: en, seed }, rig, state, fps);
    duration = S.duration ?? MOTION_DEFAULTS[S.kind].duration;
    frames = Math.max(10, Math.round(duration * fps)); duration = frames / fps; loop = false;
    // start joins the walk at the right heel strike (phase 0.5); stop leaves it at the left heel strike (0)
    const fW = startK ? Math.round(W.frames * 0.5) : 0;
    const PW = forward(rig.bones, rig.parents, W.local[fW]);
    const pitchOf = (side: 'Left' | 'Right') => { const q = PW.worldQ[idx.get(`${side}Foot`)!]; return (2 * Math.atan2(q[0], q[3])) / D2R; };
    const toeJ = bone('LeftToes').head, ankZ = L.ankle[2];
    const ballRel: V3 = [0, toeJ[1] - ankleY, toeJ[2] - ankZ], heelRel: V3 = [0, -ankleY, -0.035 * s];
    const pivot = (pt: V3, rel: V3, deg: number): V3 => add(pt, qRot(X(deg), mul(rel, -1)));
    const iL = I.feet.left[0], iR = I.feet.right[0];
    const wL = W.feet.left[fW], wR = W.feet.right[fW];
    const v = W.speed;
    const restIdx = ['Hips', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes', 'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'].map((n) => idx.get(n));
    const upper = rig.bones.map((_, i) => i).filter((i) => !restIdx.includes(i));
    const hipsI = idx.get('Hips')!;
    const hermite = (u: number, D: number, m0: number, m1: number) => { const u2 = u * u, u3 = u2 * u; return (3 * u2 - 2 * u3) * D + (u3 - 2 * u2 + u) * m0 + (u3 - u2) * m1; };
    if (startK) {
      // the left (planted) foot: walk width, idle depth; by the end it rolls up onto the ball like the walk's
      const degL = pitchOf('Left'), degR = pitchOf('Right');
      const leftFlat: V3 = [wL[0], ankleY, iL[2]];
      const ball: V3 = add(leftFlat, ballRel);
      const leftEnd = pivot([ball[0], toeJ[1], ball[2]], ballRel, degL);
      const D = leftEnd[2] - wL[2];
      const dx = leftEnd[0] - wL[0];
      const rightFrom: V3 = [iR[0], ankleY, iR[2]], rightTo: V3 = [wR[0] + dx, wR[1], wR[2] + D];
      const m1 = Math.min(3 * D, v * duration);
      travel = [dx, 0, D];
      make = (t) => {
        const u = t / duration;
        const w = ease(u / 0.85);
        const lift = clamp((u - 0.62) / 0.38);
        const pL = lift > 0 ? pivot([ball[0], toeJ[1], ball[2]], ballRel, degL * ease(lift)) : leftFlat;
        const k = clamp((u - 0.28) / 0.72);
        let pR: V3 = rightFrom, qR = flat, downR = true;
        if (k > 0) {
          const e = ease(k);
          pR = [rightFrom[0] + (rightTo[0] - rightFrom[0]) * e, rightFrom[1] + (rightTo[1] - rightFrom[1]) * e + 0.075 * s * Math.sin(Math.PI * k) ** 1.2, rightFrom[2] + (rightTo[2] - rightFrom[2]) * e];
          qR = X(10 * Math.sin(Math.PI * k) * (1 - k) + degR * ease(k));
          downR = k >= 1;
        }
        // weight shifts over the left foot before the right one lifts, then the hips go
        const wx = 0.022 * s * Math.sin(Math.PI * clamp(u / 0.75));
        const hz = hermite(u, D, 0, m1);
        const hy = I.hips[0][1] + (W.hips[fW][1] - I.hips[0][1]) * w;
        const hx = I.hips[0][0] + (W.hips[fW][0] + dx - I.hips[0][0]) * ease(u) + wx * (1 - ease(u));
        const body: Record<string, Q> = {};
        for (const i of upper) body[rig.bones[i].name] = qSlerp(I.local[0][i], W.local[fW][i], w);
        // a little forward lean as it pushes off (anticipation of the first step)
        body.Spine = qMul(body.Spine, X(3 * Math.sin(Math.PI * clamp(u / 0.8))));
        return { hipsOff: [hx, hy, hz], hipsQ: qSlerp(I.local[0][hipsI], W.local[fW][hipsI], w), body, feet: { left: { p: pL, q: lift > 0 ? X(degL * ease(lift)) : flat, toes: lift > 0 ? X(-degL * ease(lift)) : undefined, down: true }, right: { p: pR, q: qR, down: downR } } };
      };
    } else {
      // stop: the left heel has just struck; the foot rolls flat about the heel, the right foot pushes off,
      // swings in and lands beside it at idle width; the hips slow to a stop over both feet
      const degL = pitchOf('Left'), degR = pitchOf('Right');
      const heel = add(wL, qRot(X(degL), heelRel));
      const leftFlat: V3 = [wL[0], ankleY, heel[2] - heelRel[2]];
      const rightTo: V3 = [wL[0] - (iL[0] - iR[0]), ankleY, leftFlat[2] + (iR[2] - iL[2])];
      const hipsEnd: V3 = [(leftFlat[0] + rightTo[0]) / 2 - (iL[0] + iR[0]) / 2 + I.hips[0][0], I.hips[0][1], leftFlat[2] - iL[2]];
      const D = hipsEnd[2];
      const m0 = Math.min(3 * D, v * duration);
      travel = [hipsEnd[0] - I.hips[0][0], 0, D];
      make = (t) => {
        const u = t / duration;
        const w = ease(u / 0.9);
        const roll = ease(u / 0.18);
        const pL = pivot([heel[0], 0, heel[2]], heelRel, degL * (1 - roll));
        const k = clamp((u - 0.1) / 0.6);
        let pR: V3 = wR, qR = X(degR), downR = true, toesR: Q | undefined = X(-degR);
        if (u <= 0.1) { qR = X(degR); }
        else if (k < 1) {
          const e = ease(k);
          pR = [wR[0] + (rightTo[0] - wR[0]) * e, wR[1] + (rightTo[1] - wR[1]) * e + 0.05 * s * Math.sin(Math.PI * k), wR[2] + (rightTo[2] - wR[2]) * e];
          qR = X(degR * (1 - ease(k * 1.4)));
          toesR = X(-degR * (1 - ease(k / 0.35)));
          downR = false;
        } else { pR = rightTo; qR = flat; toesR = undefined; }
        const hz = hermite(u, D, m0, 0);
        const hy = W.hips[0][1] + (hipsEnd[1] - W.hips[0][1]) * w;
        const hx = W.hips[0][0] + (hipsEnd[0] - W.hips[0][0]) * ease(u);
        const body: Record<string, Q> = {};
        for (const i of upper) body[rig.bones[i].name] = qSlerp(W.local[0][i], I.local[0][i], w);
        // the body settles back a touch as it stops (follow-through of the deceleration)
        body.Spine = qMul(body.Spine, X(-2.5 * Math.sin(Math.PI * clamp((u - 0.35) / 0.65))));
        return { hipsOff: [hx, hy, hz], hipsQ: qSlerp(W.local[0][hipsI], I.local[0][hipsI], w), body, feet: { left: { p: pL, q: X(degL * (1 - roll)), down: true }, right: { p: pR, q: qR, toes: toesR, down: downR } } };
      };
    }
  } else {
    const def = ACTIONS[S.action!];
    duration = S.duration ?? def.duration;
    frames = Math.max(4, Math.round(duration * fps)); duration = frames / fps; loop = false;
    const fl = restFoot('Left', 1.08), fr = restFoot('Right', 1.08);
    const keyAt = (u: number) => { let i = 0; while (i + 1 < def.keys.length - 1 && def.keys[i + 1].at <= u) i++; return i; };
    const handOf = (k: ActionKey, side: 'left' | 'right') => (holds[side] ? restHands[side] : k.hands?.[side] ? NAMED_HAND_POSES[k.hands[side]!] : restHands[side]);
    make = (t) => {
      const u = t / duration;
      const i = keyAt(u), a = def.keys[i], c = def.keys[Math.min(def.keys.length - 1, i + 1)];
      const f = keyEase(c.ease, (u - a.at) / Math.max(1e-6, c.at - a.at));
      const names = new Set([...Object.keys(a.bones ?? {}), ...Object.keys(c.bones ?? {})]);
      const b = Math.sin(2 * Math.PI * u * Math.max(1, Math.round(duration / 3.5)));
      const body: Record<string, Q> = { ...breathe(b * 0.6), ...arm('Left', 0, 14), ...arm('Right', 0, 14) };
      for (const n of names) {
        const base = body[n] ?? qIdentity();
        const qa = a.bones?.[n] ? stepQ(a.bones[n]) : null, qc = c.bones?.[n] ? stepQ(c.bones[n]) : null;
        // arm keys replace the hanging posture (they are absolute); other bones add to it
        const isArm = /(UpperArm|LowerArm)$/.test(n);
        const A0 = qa ? (isArm ? qa : qMul(base, qa)) : base, C0 = qc ? (isArm ? qc : qMul(base, qc)) : base;
        body[n] = qSlerp(A0, C0, f);
      }
      const lerpK = (x: number | undefined, y: number | undefined) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * f;
      const drop = lerpK(a.drop, c.drop) * s;
      const sx = lerpK(a.shift?.[0], c.shift?.[0]) * s, sz = lerpK(a.shift?.[1], c.shift?.[1]) * s;
      const hands = { left: lerpHand(handOf(a, 'left'), handOf(c, 'left'), clamp(f)), right: lerpHand(handOf(a, 'right'), handOf(c, 'right'), clamp(f)) };
      return { hipsOff: [sx, -0.012 * s - drop, -drop * 0.35 + sz], hipsQ: Y(lerpK(a.yaw, c.yaw)), body, hands, feet: { left: { p: fl, q: flat, down: true }, right: { p: fr, q: flat, down: true } } };
    };
  }

  // ── solve every frame: posture + IK legs + hands (+ the frame that closes a loop) ──
  const base = localRotations(rig, { hands: restHands, expression: state?.expression });
  const local: Q[][] = [], hips: V3[] = [], cl: boolean[] = [], cr: boolean[] = [], fpL: V3[] = [], fpR: V3[] = [];
  let reachMiss = 0;
  for (let f = 0; f <= frames; f++) {
    const t = loop ? (f % frames) / fps : Math.min(duration, f / fps);
    const fr = make(t);
    const q = base.slice();
    for (const [n, r] of Object.entries(fr.body)) { const i = idx.get(n); if (i !== undefined) q[i] = r; }
    if (fr.hands) for (const side of ['Left', 'Right'] as const) {
      const h = fr.hands[side === 'Left' ? 'left' : 'right'];
      if (h) for (const [n, r] of Object.entries(handRotations(side, h))) { const i = idx.get(n); if (i !== undefined) q[i] = r; }
    }
    q[idx.get('Hips')!] = fr.hipsQ;
    const hipsP = add(hipsRest, fr.hipsOff);
    for (const [side, lg] of [['Left', L], ['Right', R]] as const) {
      const target = fr.feet[side === 'Left' ? 'left' : 'right'];
      const H = add(hipsP, qRot(fr.hipsQ, sub(lg.hip, hipsRest)));
      const d = sub(target.p, H);
      const dist0 = len(d);
      const maxR = (lg.l1 + lg.l2) * 0.9995, minR = Math.abs(lg.l1 - lg.l2) + 1e-3;
      // a planted foot must be reached; a swinging foot falling a little short only straightens the knee
      if (dist0 > maxR && target.down) reachMiss = Math.max(reachMiss, dist0 - maxR);
      const dist = clamp(dist0, minR, maxR);
      const dh = norm(d);
      const cosA = clamp((lg.l1 ** 2 + dist ** 2 - lg.l2 ** 2) / (2 * lg.l1 * dist), -1, 1);
      const sinA = Math.sqrt(1 - cosA * cosA);
      const pole = qRot(target.q, [0, 0, 1]);
      let perp = sub(pole, mul(dh, dot(pole, dh)));
      perp = len(perp) < 1e-6 ? [0, 0, 1] : norm(perp);
      const u = add(mul(dh, cosA), mul(perp, sinA));
      const knee = add(H, mul(u, lg.l1));
      const ankle = add(H, mul(dh, dist));
      const w = norm(sub(ankle, knee));
      const Qu = qMul(qArc(qRot(fr.hipsQ, lg.dir1), u), fr.hipsQ);
      const Ql = qMul(qArc(qRot(Qu, lg.dir2), w), Qu);
      q[idx.get(`${side}UpperLeg`)!] = qMul(qInv(fr.hipsQ), Qu);
      q[idx.get(`${side}LowerLeg`)!] = qMul(qInv(Qu), Ql);
      q[idx.get(`${side}Foot`)!] = qMul(qInv(Ql), target.q);
      q[idx.get(`${side}Toes`)!] = target.toes ?? qIdentity();
    }
    local.push(q); hips.push(fr.hipsOff);
    cl.push(fr.feet.left.down); cr.push(fr.feet.right.down);
    fpL.push(fr.feet.left.p); fpR.push(fr.feet.right.p);
  }

  apronSwing(rig, local, hips, fps, loop, frames);
  // add-ons: a tail swings with the body; wings stay folded unless the motion beats them
  applyTail(rig, local, hips, fps, S.kind === 'idle' ? 1 : 0.5, loop ? duration : undefined);
  if (idx.has('LeftWing1')) {
    const flapHz = S.flap ? (loop ? Math.max(1, Math.round(S.flap * duration)) / duration : S.flap) : 0;
    local.forEach((q, f) => applyWings(rig, idx, q, flapHz ? flapHz * (f / fps) : undefined, f / fps));
  }

  // ── the life layer: blinks (shape keys + lids) and glances (eyes), on top of the posture ──
  const life = ambientLife(duration, fps, seed, { loop, glance: S.kind === 'idle' ? 1 : S.kind === 'action' ? 0.5 : 0.35, energy: en });
  const lids = rig.spec.lids;
  for (let f = 0; f <= frames; f++) {
    const lf = loop ? f % frames : Math.min(f, frames);
    const q = local[f];
    const blink = life.blink[lf] ?? 0;
    for (const l of lids) { const i = idx.get(l.bone); if (i !== undefined) q[i] = X(l.closeDeg * Math.max(blink, state?.expression?.[l.bone === 'LeftUpperLid' ? 'eyeBlinkLeft' : 'eyeBlinkRight'] ?? 0)); }
    for (const e of ['LeftEye', 'RightEye']) { const i = idx.get(e); if (i !== undefined) q[i] = qMul(q[i], qMul(Y(life.yaw[lf] ?? 0), X(-(life.pitch[lf] ?? 0)))); }
  }
  const blinkCurve = Array.from({ length: frames + 1 }, (_, f) => life.blink[loop ? f % frames : Math.min(f, frames)] ?? 0);
  return {
    id, kind: S.kind, fps, frames, duration: +duration.toFixed(4), loop, speed: +speed.toFixed(4),
    ...(turnDeg !== undefined ? { turn: turnDeg } : {}), ...(travel ? { travel: travel.map((x) => +x.toFixed(4)) as V3 } : {}), ...(stride !== undefined ? { stride: +stride.toFixed(4) } : {}),
    local, hips, contacts: { left: cl, right: cr }, feet: { left: fpL, right: fpR },
    shapes: { eyeBlinkLeft: blinkCurve, eyeBlinkRight: blinkCurve }, reachMiss: +reachMiss.toFixed(4), settings: S,
  };
}

// ── checks (the authority on motion, Decision 6): planted feet, ground, reach, loops ──────────────
export interface MotionReport { slip: number; below: number; reachMiss: number; loopGap: number; kneeWorst: number; elbowWorst: number; pelvis?: number; stanceKnee?: number; run?: { flight: number; cadence: number; lean: number; heelRecovery: number; pelvis: number }; strike?: { windup: number; downswing: number; dip: number; settle: boolean }; quad?: import('./quadruped.ts').QuadReport; pass: boolean; detail: string }

/** A run must read as a run: both feet off the ground for part of the stride, a forward lean, the heel
 *  folding up behind (swing knee), a quick cadence, without the hips sinking into a crouch. */
export const RUN_FORM = { flight: 0.2, lean: 8, heelRecovery: 95, cadence: [150, 195] as [number, number], pelvis: 0.87 };
/** A strike must wind up, come down fast, sink into the knees at impact and settle. */
export const STRIKE_FORM = { windup: 0.4, downswing: 0.24, dip: 0.02 };

/** A walk mustn't crouch: hips on average at least this share of standing height, and the planted knee nearly straight at mid-stance. */
export const WALK_UPRIGHT = { pelvis: 0.95, stanceKnee: 165 };

/** Forward-kinematics a clip's frame (object space, in place). */
export function clipPose(rig: Rig, clip: MotionClip, f: number) {
  const hi = rig.bones.findIndex((b) => b.name === 'Hips');
  const bones = rig.bones.map((b, i) => (i === hi ? { ...b, head: add(b.head, clip.hips[f]) } : b));
  const posed = forward(bones.map((b, i) => {
    if (i === hi) return b;
    // shift every descendant of Hips by the same offset so relative offsets stay the rest ones
    let p = rig.parents[i];
    while (p >= 0 && p !== hi) p = rig.parents[p];
    return p === hi ? { ...b, head: add(b.head, clip.hips[f]) } : b;
  }), rig.parents, clip.local[f]);
  return posed;
}

export function motionReport(rig: Rig, clip: MotionClip): MotionReport {
  if (rig.spec.quad) {
    const q = quadReport(rig, clip);
    return { slip: q.slip, below: q.grounded, reachMiss: q.reachMiss, loopGap: 0, kneeWorst: 0, elbowWorst: 0, pass: q.pass, detail: q.detail, quad: q };
  }
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const s = rig.spec.s;
  let slip = 0, below = 0, kneeWorst = 0, elbowWorst = 0;
  const soleRest = (side: 'Left' | 'Right') => {
    const ft = rig.bones[idx.get(`${side}Foot`)!], toe = rig.bones[idx.get(`${side}Toes`)!];
    return { heel: [ft.head[0], 0, ft.head[2] - 0.035 * s] as V3, toe: [toe.tail[0], 0, toe.tail[2] + 0.005 * s] as V3, ft, toeB: toe };
  };
  const soles = { Left: soleRest('Left'), Right: soleRest('Right') };
  const planted: Record<string, V3 | null> = { Left: null, Right: null };
  for (let f = 0; f <= clip.frames; f++) {
    const P = clipPose(rig, clip, f);
    const t = f / clip.fps;
    for (const side of ['Left', 'Right'] as const) {
      const fi = idx.get(`${side}Foot`)!, ti = idx.get(`${side}Toes`)!;
      const so = soles[side];
      const heel = add(P.worldP[fi], qRot(P.worldQ[fi], sub(so.heel, so.ft.head)));
      const toe = add(P.worldP[ti], qRot(P.worldQ[ti], sub(so.toe, so.toeB.head)));
      below = Math.max(below, -Math.min(heel[1], toe[1]));
      // a planted foot doesn't move against the ground (the ground moves back at the clip's speed):
      // whichever of heel and ball is on the floor stays put while it is there
      const down = (side === 'Left' ? clip.contacts.left : clip.contacts.right)[Math.min(f, clip.frames)];
      const inPlay = down && f < clip.frames + (clip.loop ? 0 : 1);
      const ballW = add(P.worldP[ti], qRot(P.worldQ[ti], sub([so.toeB.head[0], 0, so.toeB.head[2]], so.toeB.head)));
      for (const [key, pt] of [[`${side}heel`, heel], [`${side}ball`, ballW]] as const) {
        const onFloor = inPlay && pt[1] < 0.006 * s;
        const g: V3 = [pt[0], pt[1], pt[2] + clip.speed * t];
        if (onFloor) { if (planted[key]) slip = Math.max(slip, len(sub(g, planted[key]!))); else planted[key] = g; }
        else planted[key] = null;
      }
      const ki = idx.get(`${side}LowerLeg`)!, ei = idx.get(`${side}LowerArm`)!;
      kneeWorst = Math.max(kneeWorst, qAngle(clip.local[f][ki], qIdentity()));
      elbowWorst = Math.max(elbowWorst, qAngle(clip.local[f][ei], qIdentity()));
    }
  }
  // upright walk: the hips near standing height, the planted leg nearly straight when it's under the body
  let pelvis: number | undefined, stanceKnee: number | undefined;
  if (clip.kind === 'walk') {
    const stand = rig.bones[idx.get('Hips')!].head[1];
    pelvis = clip.hips.slice(0, clip.frames).reduce((a, h) => a + stand + h[1], 0) / clip.frames / stand;
    stanceKnee = 180;
    for (const side of ['Left', 'Right'] as const) {
      const down = side === 'Left' ? clip.contacts.left : clip.contacts.right, feet = side === 'Left' ? clip.feet.left : clip.feet.right;
      let best = -1, bz = Infinity;
      for (let f = 0; f < clip.frames; f++) if (down[f] && Math.abs(feet[f][2]) < bz) { bz = Math.abs(feet[f][2]); best = f; }
      if (best >= 0) stanceKnee = Math.min(stanceKnee, 180 - qAngle(clip.local[best][idx.get(`${side}LowerLeg`)!], qIdentity()));
    }
  }
  let run: MotionReport['run'];
  if (clip.kind === 'run') {
    const stand = rig.bones[idx.get('Hips')!].head[1];
    let air = 0, swingKnee = 0;
    for (let f = 0; f < clip.frames; f++) {
      if (!clip.contacts.left[f] && !clip.contacts.right[f]) air++;
      for (const side of ['Left', 'Right'] as const) if (!(side === 'Left' ? clip.contacts.left : clip.contacts.right)[f]) swingKnee = Math.max(swingKnee, qAngle(clip.local[f][idx.get(`${side}LowerLeg`)!], qIdentity()));
    }
    const P0 = clipPose(rig, clip, 0);
    const neck = P0.worldP[idx.get('Neck')!], hp = P0.worldP[idx.get('Hips')!];
    const lean = Math.atan2(neck[2] - hp[2], neck[1] - hp[1]) / D2R;
    run = { flight: +(air / clip.frames).toFixed(3), cadence: +((2 / clip.duration) * 60).toFixed(0), lean: +lean.toFixed(1), heelRecovery: +swingKnee.toFixed(0), pelvis: +(clip.hips.slice(0, clip.frames).reduce((a, h) => a + stand + h[1], 0) / clip.frames / stand).toFixed(3) };
  }
  let strike: MotionReport['strike'];
  if (clip.kind === 'action' && clip.settings.action === 'hammer-strike') {
    const hi = idx.get('RightHand')!, stand = rig.bones[idx.get('Hips')!].head[1];
    const ys: number[] = [];
    for (let f = 0; f <= clip.frames; f++) ys.push(clipPose(rig, clip, f).worldP[hi][1]);
    // the downswing: around the fastest downward hand speed; it starts where the hand was last still or
    // rising (the top of the wind-up) and ends at the first low point (impact)
    let fast = 1;
    for (let f = 1; f <= clip.frames; f++) if (ys[f] - ys[f - 1] < ys[fast] - ys[fast - 1]) fast = f;
    let leave = fast - 1;
    while (leave > 0 && ys[leave] - ys[leave - 1] < -0.004 * s) leave--;
    let imp = fast;
    while (imp + 1 <= clip.frames && ys[imp + 1] <= ys[imp] + 1e-5) imp++;
    const top = leave;
    const dip = -Math.min(...clip.hips.slice(Math.max(0, imp - 3), imp + 4).map((h) => h[1])) - 0.012 * s;
    const after = ys.slice(imp);
    const settle = after.length > 2 && Math.max(...after) - ys[imp] > 0.01 * s;
    strike = { windup: +(top / clip.fps).toFixed(2), downswing: +((imp - leave) / clip.fps).toFixed(2), dip: +Math.max(0, dip).toFixed(3), settle };
    void stand;
  }
  let loopGap = 0;
  if (clip.loop) for (let i = 0; i < rig.bones.length; i++) loopGap = Math.max(loopGap, qAngle(clip.local[0][i], clip.local[clip.frames][i]));
  const fails: string[] = [];
  if (slip > 0.012 * s) fails.push(`a planted foot slides ${(slip * 100).toFixed(1)} cm`);
  if (below > 0.012 * s) fails.push(`a foot sinks ${(below * 100).toFixed(1)} cm below the floor`);
  if (clip.reachMiss > 0.01 * s) fails.push(`the legs can't reach the ground by ${(clip.reachMiss * 100).toFixed(1)} cm (shorter stride or lower bounce)`);
  if (loopGap > 1.5) fails.push(`the loop jumps ${loopGap.toFixed(1)}° where it wraps`);
  if (kneeWorst > 150) fails.push(`a knee bends ${kneeWorst.toFixed(0)}°`);
  if (elbowWorst > 155) fails.push(`an elbow bends ${elbowWorst.toFixed(0)}°`);
  if (pelvis !== undefined && pelvis < WALK_UPRIGHT.pelvis) fails.push(`walks in a crouch: hips average ${(pelvis * 100).toFixed(0)}% of standing height (want ≥ ${WALK_UPRIGHT.pelvis * 100}%)`);
  if (stanceKnee !== undefined && stanceKnee < WALK_UPRIGHT.stanceKnee) fails.push(`the planted knee is bent to ${stanceKnee.toFixed(0)}° at mid-stance (want ≥ ${WALK_UPRIGHT.stanceKnee}°, nearly straight)`);
  if (run) {
    if (run.flight < RUN_FORM.flight) fails.push(`a run needs both feet off the ground for part of each stride (${(run.flight * 100).toFixed(0)}% of the cycle, want ≥ ${RUN_FORM.flight * 100}%)`);
    if (run.lean < RUN_FORM.lean) fails.push(`the runner leans only ${run.lean}° forward (want ≥ ${RUN_FORM.lean}°)`);
    if (run.heelRecovery < RUN_FORM.heelRecovery) fails.push(`the swinging heel doesn't fold up behind (knee ${run.heelRecovery}°, want ≥ ${RUN_FORM.heelRecovery}°)`);
    // short legs step faster: the cadence range scales with leg length like the gait does
    const lb = (n: string) => rig.bones[idx.get(n)!];
    const legLen = len(sub(lb('LeftLowerLeg').head, lb('LeftUpperLeg').head)) + len(sub(lb('LeftFoot').head, lb('LeftLowerLeg').head));
    const cs = 1 / Math.sqrt(gaitScale(legLen));
    const cad: [number, number] = [Math.round(RUN_FORM.cadence[0] * Math.min(1, cs)), Math.round(RUN_FORM.cadence[1] * Math.max(1, cs))];
    if (run.cadence < cad[0] || run.cadence > cad[1]) fails.push(`cadence ${run.cadence} steps/min (a run with these legs is ${cad[0]}–${cad[1]})`);
    if (run.pelvis < RUN_FORM.pelvis) fails.push(`runs in a crouch: hips average ${(run.pelvis * 100).toFixed(0)}% of standing height (want ≥ ${RUN_FORM.pelvis * 100}%)`);
  }
  if (strike) {
    if (strike.windup < STRIKE_FORM.windup) fails.push(`the strike barely winds up (${strike.windup} s to the top, want ≥ ${STRIKE_FORM.windup} s)`);
    if (strike.downswing > STRIKE_FORM.downswing) fails.push(`the downswing is slow (${strike.downswing} s, want ≤ ${STRIKE_FORM.downswing} s)`);
    if (strike.dip < STRIKE_FORM.dip * s) fails.push(`the knees don't soften at impact (hips dip ${(strike.dip * 100).toFixed(1)} cm, want ≥ ${(STRIKE_FORM.dip * 100).toFixed(0)} cm)`);
    if (!strike.settle) fails.push('the strike stops dead at impact (no rebound or settle)');
  }
  const pass = !fails.length;
  const detail = pass
    ? `${clip.loop ? 'loops cleanly; ' : ''}planted feet slide ≤ ${(slip * 1000).toFixed(0)} mm, nothing below the floor${pelvis !== undefined ? `; upright: hips ${(pelvis * 100).toFixed(0)}% of standing, planted knee ${stanceKnee!.toFixed(0)}°` : ''}${run ? `; run: ${(run.flight * 100).toFixed(0)}% flight, ${run.cadence} steps/min, ${run.lean}° lean, heel folds to ${run.heelRecovery}°` : ''}${strike ? `; strike: ${strike.windup} s wind-up, ${strike.downswing} s downswing, knees dip ${(strike.dip * 100).toFixed(1)} cm` : ''}${clip.travel ? `; travels ${len(clip.travel).toFixed(2)} m` : ''}${clip.speed ? `; ${clip.speed.toFixed(2)} m/s, ${clip.stride?.toFixed(2)} m stride, ${clip.duration.toFixed(2)} s cycle` : `; ${clip.duration.toFixed(2)} s`}`
    : fails.join('; ');
  return { slip: +slip.toFixed(4), below: +below.toFixed(4), reachMiss: clip.reachMiss, loopGap: +loopGap.toFixed(2), kneeWorst: +kneeWorst.toFixed(1), elbowWorst: +elbowWorst.toFixed(1), ...(pelvis !== undefined ? { pelvis: +pelvis.toFixed(3), stanceKnee: +stanceKnee!.toFixed(1) } : {}), ...(run ? { run } : {}), ...(strike ? { strike } : {}), pass, detail };
}

/** Frames worth a skin check: the extremes of a cycle, or an action's keys. */
export function checkFrames(clip: MotionClip): number[] {
  if (clip.kind === 'walk' || clip.kind === 'run' || clip.kind === 'trot' || clip.kind === 'gallop') return [0, Math.round(clip.frames * 0.25)];
  if (clip.kind === 'sit' || clip.kind === 'lie') return [clip.frames];
  if (clip.kind === 'idle') return [Math.round(clip.frames * 0.25)];
  if (clip.kind === 'turn' || clip.kind === 'start' || clip.kind === 'stop') return [Math.round(clip.frames * 0.5)];
  const def = ACTIONS[clip.settings.action!];
  return def.keys.filter((k) => k.bones).map((k) => Math.min(clip.frames, Math.round(k.at * clip.frames))).filter((f, i, a) => a.indexOf(f) === i).slice(0, 3);
}

// ── secondary motion: a hanging apron (the kit's ApronUpper/ApronLower bones) ─────────────────────
/** Physical properties of the apron's swing: a spring per panel (Hz, damping ratio), how much the lower
 *  panel lags the upper, and how far in front of the bone line the thigh and shin fronts sit (× body scale). */
export const APRON = { upperHz: 1.7, upperDamp: 0.3, lowerHz: 2.2, lowerDamp: 0.18, lag: 1.3, thigh: 0.072, shin: 0.055 };

/** Knee and ankle in the hips' frame, and the angle the upper panel must swing forward to clear the thighs. */
function apronNeeds(rig: Rig, q: Q[]) {
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const s = rig.spec.s;
  const hi = idx.get('Hips')!, iu = idx.get('ApronUpper')!, il = idx.get('ApronLower')!;
  const P = forward(rig.bones, rig.parents, q);
  const hq = P.worldQ[hi], inv: Q = [-hq[0], -hq[1], -hq[2], hq[3]];
  const toHips = (p: V3) => qRot(inv, sub(p, P.worldP[hi]));
  const up = rig.bones[iu], lo = rig.bones[il];
  const head = sub(up.head, rig.bones[hi].head);
  const lenU = len(sub(up.tail, up.head)), lenL = len(sub(lo.tail, lo.head));
  const back = -0.016 * s;                                      // the cloth's back face, behind the bone line
  let needU = 0;
  const kneeRel: V3[] = [], ankleRel: V3[] = [];
  for (const side of ['Left', 'Right']) {
    const knee = toHips(P.worldP[idx.get(`${side}LowerLeg`)!]), ankle = toHips(P.worldP[idx.get(`${side}Foot`)!]);
    kneeRel.push(knee); ankleRel.push(ankle);
    // the thigh's front at the knee and halfway up: the panel (through its head) passes in front of both
    for (const [pt, r] of [[knee, APRON.thigh], [mul(knee, 0.5), APRON.thigh * 1.1]] as const) {
      const dz = pt[2] + r * s - (head[2] + back), dy = head[1] - pt[1];
      if (dy > 0.02 * s) needU = Math.max(needU, Math.atan2(dz, dy) / D2R);
    }
  }
  return { head, lenU, lenL, back, needU: Math.max(0, needU), kneeRel, ankleRel, iu, il };
}

/** The lower panel's forward angle (relative to the upper) needed to clear the knees and shins. */
function apronLowerNeed(n: ReturnType<typeof apronNeeds>, thetaDeg: number, s: number) {
  const th = thetaDeg * D2R;
  const tail: V3 = [0, n.head[1] - n.lenU * Math.cos(th), n.head[2] + n.lenU * Math.sin(th)];
  let need = -90;
  for (let k = 0; k < 2; k++) {
    const kn = n.kneeRel[k], an = n.ankleRel[k];
    const yb = tail[1] - n.lenL;
    const tt = clamp((kn[1] - yb) / Math.max(1e-6, kn[1] - an[1]));
    const shin: V3 = [0, kn[1] + (an[1] - kn[1]) * tt, kn[2] + (an[2] - kn[2]) * tt + APRON.shin * s];
    const kneeFront: V3 = [0, kn[1], kn[2] + APRON.thigh * s];
    for (const q of [kneeFront, shin]) {
      const dy = tail[1] - q[1];
      if (dy <= 0.01 * s) continue;
      need = Math.max(need, Math.atan2(q[2] - (tail[2] + n.back), dy) / D2R - thetaDeg);
    }
  }
  return need;
}

/**
 * Swing the apron: each panel is a damped spring hanging from the one above (the upper from the hips),
 * pushed forward by the knees and shins (never behind them) and lagging the hips' motion, so the cloth
 * bends, sways and settles instead of turning with the body like a board. Loops are simulated until
 * they repeat, so the swing closes the loop.
 */
export function apronSwing(rig: Rig, local: Q[][], hips: V3[], fps: number, loop: boolean, frames: number) {
  const iu = rig.bones.findIndex((b) => b.name === 'ApronUpper');
  if (iu < 0) return;
  const s = rig.spec.s, dt = 1 / fps;
  const needs = local.map((q) => apronNeeds(rig, q));
  const il = needs[0].il;
  const n = local.length;
  const period = loop ? frames : n;
  const acc = (f: number) => {
    const a = hips[loop ? (f - 1 + period) % period : Math.max(0, f - 1)], b = hips[f], c = hips[loop ? (f + 1) % period : Math.min(n - 1, f + 1)];
    return [(a[0] - 2 * b[0] + c[0]) / (dt * dt), (a[1] - 2 * b[1] + c[1]) / (dt * dt), (a[2] - 2 * b[2] + c[2]) / (dt * dt)];
  };
  const wU = 2 * Math.PI * APRON.upperHz, wL = 2 * Math.PI * APRON.lowerHz;
  let th = needs[0].needU, thV = 0, ph = Math.max(0, apronLowerNeed(needs[0], th, s)), phV = 0;
  const outU: number[] = new Array(n).fill(0), outL: number[] = new Array(n).fill(0);
  const passes = loop ? 4 : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let f = 0; f < period; f++) {
      const N = needs[f];
      const a = acc(f);
      // the cloth swings back when the hips accelerate forward (and the other way), in degrees/s²
      const push = (-a[2] / Math.max(0.05, N.lenU)) / D2R;
      const thA = -wU * wU * th - 2 * APRON.upperDamp * wU * thV + push;
      const thPrevV = thV;
      thV += thA * dt; th += thV * dt;
      if (th < N.needU) { th = N.needU; thV = Math.max(thV, 0); }
      const thAcc = (thV - thPrevV) / dt;
      const needL = apronLowerNeed(N, th, s);
      const phA = -wL * wL * ph - 2 * APRON.lowerDamp * wL * phV - APRON.lag * thAcc;
      phV += phA * dt; ph += phV * dt;
      if (ph < needL) { ph = needL; phV = Math.max(phV, 0); }
      ph = clamp(ph, -35, 70);
      if (pass === passes - 1) { outU[f] = th; outL[f] = ph; }
    }
  }
  if (loop) { outU[frames] = outU[0]; outL[frames] = outL[0]; }
  for (let f = 0; f < n; f++) {
    local[f][iu] = X(-outU[f]);
    local[f][il] = X(-outL[f]);
  }
}

/** How the apron behaves in a clip: the most it passes behind a thigh or shin (degrees, ≤ 0 is clear), and how much it bends and swings (degrees). */
export function apronReport(rig: Rig, clip: MotionClip): { clearance: number; bend: number; swing: number; pass: boolean; detail: string } | null {
  const iu = rig.bones.findIndex((b) => b.name === 'ApronUpper');
  if (iu < 0) return null;
  const il = rig.bones.findIndex((b) => b.name === 'ApronLower');
  const s = rig.spec.s;
  let worst = -90, bendMin = Infinity, bendMax = -Infinity, swMin = Infinity, swMax = -Infinity;
  for (let f = 0; f <= clip.frames; f++) {
    const q = clip.local[f];
    const N = apronNeeds(rig, q);
    const th = -(2 * Math.atan2(q[iu][0], q[iu][3])) / D2R, ph = -(2 * Math.atan2(q[il][0], q[il][3])) / D2R;
    worst = Math.max(worst, N.needU - th, apronLowerNeed(N, th, s) - ph);
    bendMin = Math.min(bendMin, ph); bendMax = Math.max(bendMax, ph);
    swMin = Math.min(swMin, th); swMax = Math.max(swMax, th);
  }
  const bend = bendMax - bendMin, swing = swMax - swMin;
  const moving = clip.kind === 'walk' || clip.kind === 'run';
  const fails: string[] = [];
  if (worst > 1.5) fails.push(`the apron passes ${worst.toFixed(1)}° behind a knee or shin`);
  if (moving && bend < 3) fails.push(`the apron moves like a board: its lower half bends only ${bend.toFixed(1)}°`);
  return { clearance: +worst.toFixed(2), bend: +bend.toFixed(1), swing: +swing.toFixed(1), pass: !fails.length, detail: fails.length ? fails.join('; ') : `apron clears the legs, swings ${swing.toFixed(0)}° and bends ${bend.toFixed(0)}°` };
}
