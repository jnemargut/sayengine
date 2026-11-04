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
  local: Q[][];                   // [frame][bone] local rotations (frames + 1 entries: the last closes a loop)
  hips: V3[];                     // [frame] Hips offset from its rest position (object space)
  contacts: { left: boolean[]; right: boolean[] };   // foot planted (carrying weight) per frame
  feet: { left: V3[]; right: V3[] };                  // planned ankle positions (object space, in place)
  shapes: Record<string, number[]>;                   // shape-key curves (blinks), 0..1
  reachMiss: number;              // worst distance (m) a foot target was beyond the leg's reach
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
interface ActionKey { at: number; bones?: Record<string, Step>; drop?: number; hands?: { left?: string; right?: string } }
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
    label: 'Raise the right hand and strike down (holds whatever is in it)', duration: 1.4,
    keys: [
      { at: 0 },
      { at: 0.42, bones: { RightUpperArm: armUp('Right', 84, 25), RightLowerArm: [['z', -120]], RightHand: [['z', -20]], Chest: [['x', -4], ['y', -8]], Spine: [['x', -2]] } },
      { at: 0.58, bones: { RightUpperArm: armUp('Right', 84, -32), RightLowerArm: [['z', -12]], RightHand: [['z', 12]], Chest: [['x', 8], ['y', 4]], Spine: [['x', 6]] }, drop: 0.03 },
      { at: 0.7, bones: { RightUpperArm: armUp('Right', 84, -28), RightLowerArm: [['z', -16]], Chest: [['x', 7], ['y', 3]], Spine: [['x', 5]] }, drop: 0.03 },
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

const stepQ = (s: Step): Q => s.reduce<Q>((q, [ax, deg]) => qMul(ax === 'x' ? X(deg) : ax === 'y' ? Y(deg) : Z(deg), q), qIdentity());

export const MOTION_DEFAULTS = {
  walk: { speed: 1.3, bounce: 0.022, armSwing: 16, lean: 3, sway: 0.018, duty: 0.62, lift: 0.07 },
  run: { speed: 3.4, bounce: 0.035, armSwing: 32, lean: 9, sway: 0.008, duty: 0.32, lift: 0.17 },
  idle: { duration: 6, sway: 0.022 },
};

/** Validate settings and fill defaults (throws a readable error). */
export function motionSettings(spec: MotionSpec): MotionClip['settings'] {
  const kinds = ['walk', 'run', 'idle', 'turn', 'action'];
  if (!kinds.includes(spec.kind)) throw new Error(`motion kind must be one of ${kinds.join(', ')}`);
  const num = (k: keyof MotionSpec, lo: number, hi: number) => {
    const v = spec[k];
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`motion ${k} must be between ${lo} and ${hi} (got ${v})`);
  };
  num('speed', spec.kind === 'run' ? 1.8 : 0.3, spec.kind === 'run' ? 7 : 2.2);
  num('stride', 0.3, 4); num('bounce', 0, 0.12); num('armSwing', 0, 70); num('lean', -10, 25); num('sway', 0, 0.08);
  num('energy', 0, 1); num('duration', 0.5, 30); num('turn', -180, 180);
  if (spec.kind === 'action') {
    if (!spec.action) throw new Error(`an action motion needs --action (${Object.keys(ACTIONS).join(', ')})`);
    if (!ACTIONS[spec.action]) throw new Error(`no action "${spec.action}" — library: ${Object.keys(ACTIONS).join(', ')}`);
  }
  if (spec.kind === 'turn' && spec.turn === undefined) throw new Error('a turn motion needs --turn degrees (+ = to the left)');
  return { ...spec, energy: spec.energy ?? 0.5 };
}

interface Frame { hipsOff: V3; hipsQ: Q; body: Record<string, Q>; hands?: { left?: HandPose; right?: HandPose }; feet: { left: FootTarget; right: FootTarget } }
interface FootTarget { p: V3; q: Q; down: boolean; toes?: Q }

/** Bake a motion for a rigged character. `state` gives the hands (and what they hold) and expression. */
export function bakeMotion(id: string, spec: MotionSpec, rig: Rig, state: CharacterState | undefined, fps = 30): MotionClip {
  const S = motionSettings(spec);
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

  let frames: number, duration: number, loop: boolean, speed = 0, stride: number | undefined, turnDeg: number | undefined;
  let make: (t: number) => Frame;
  const restFoot = (side: 'Left' | 'Right', widen = 1): V3 => { const a = side === 'Left' ? L.ankle : R.ankle; return [a[0] * widen, ankleY, a[2]]; };
  const flat = qIdentity();

  if (S.kind === 'walk' || S.kind === 'run') {
    const D = MOTION_DEFAULTS[S.kind];
    const run = S.kind === 'run';
    const v = S.speed ?? D.speed * Math.sqrt(s);
    const k = 0.6 + 0.8 * en;                                          // energy scales the flourishes
    const strideWanted = S.stride ?? (run ? legLen * 2.7 * (v / (3.4 * Math.sqrt(s))) ** 0.55 : legLen * 1.55 * (v / (1.3 * Math.sqrt(s))) ** 0.42);
    frames = Math.max(12, Math.round((strideWanted / v) * fps));
    duration = frames / fps;
    stride = strideWanted; speed = stride / duration; loop = true;
    const duty = D.duty, Lst = stride * duty;
    const swing = (S.armSwing ?? D.armSwing) * k, lean = S.lean ?? D.lean, sway = (S.sway ?? D.sway * s);
    const yawAmp = (run ? 7 : 5) * k, lift = D.lift * s * (run ? 1 : 0.8 + 0.4 * en);
    // the foot rolls: it lands on the heel (toe up), goes flat, then the heel lifts and it pivots over
    // the ball of the foot (toes stay on the ground) before it leaves. The planted point — heel, then
    // sole, then ball — moves back at exactly the ground's speed. Runners land flatter.
    const ankleZ = L.ankle[2];
    const toeJoint = bone('LeftToes').head;
    const heelRel: V3 = [0, -ankleY, -0.035 * s], ballRel: V3 = [0, toeJoint[1] - ankleY, toeJoint[2] - ankleZ];
    const strikeU = run ? 0.04 : 0.12, strikeDeg = run ? -4 : -12, offU = run ? 0.42 : 0.58, offDeg = run ? 34 : 30;
    const pivot = (pt: V3, rel: V3, deg: number): V3 => { const o = qRot(X(deg), mul(rel, -1)); return add(pt, o); };
    const stance = (r: V3, u: number) => {
      const zA = r[2] + Lst / 2 - u * Lst;                               // where the ankle would be with the foot flat
      if (u < strikeU) { const deg = strikeDeg * (1 - ease(u / strikeU)); return { p: pivot([r[0], 0, zA + heelRel[2]], heelRel, deg), deg }; }
      if (u < offU) return { p: [r[0], ankleY, zA] as V3, deg: 0 };
      const deg = offDeg * ease((u - offU) / (1 - offU));
      return { p: pivot([r[0], toeJoint[1], zA + ballRel[2]], ballRel, deg), deg };
    };
    const footPath = (side: 'Left' | 'Right', phi: number) => {
      const r = restFoot(side, run ? 0.75 : 0.85);
      if (phi < duty) { const st = stance(r, phi / duty); return { p: st.p, q: X(st.deg), toes: st.deg > 0 ? X(-st.deg) : flat, down: true }; }
      const u = (phi - duty) / (1 - duty);
      const a = stance(r, 1), b = stance(r, 0), e = ease(u);
      const y = a.p[1] + (b.p[1] - a.p[1]) * e + lift * Math.sin(Math.PI * u) ** (run ? 1 : 1.3);
      const deg = a.deg + (b.deg - a.deg) * ease(u * 1.2);
      return { p: [r[0], y, a.p[2] + (b.p[2] - a.p[2]) * e] as V3, q: X(deg), toes: X(-a.deg * (1 - ease(u / 0.35))), down: false };
    };
    // hip height from the actual foot paths: the highest the hips can ride with every foot in reach
    // (a soft knee at full stretch), then the bounce on top of that
    const bobAt = (p: number) => (run ? (1 + Math.cos(4 * Math.PI * p)) / 2 : (1 - Math.cos(4 * Math.PI * p)) / 2);
    const bounceWanted = (S.bounce ?? D.bounce * s) * k;
    const hipDrop = L.hip[1] - hipsRest[1];
    let baseY = hipsRest[1] - (run ? 0.03 * s : 0.004 * s);
    const reach = legLen * (run ? 0.965 : 0.985);
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
    make = (t) => {
      const p = t / duration, w = 2 * Math.PI * p;
      const fl = footPath('Left', p % 1), fr = footPath('Right', (p + 0.5) % 1);
      // hips: lowest when a foot lands (walk) / mid-stance (run); shift over the standing foot; turn with the legs
      const bob = bobAt(p);
      const hipsOff: V3 = [sway * Math.cos(w - Math.PI * duty), baseY - hipsRest[1] + bounce * bob, 0];
      const yaw = -yawAmp * Math.cos(w);
      const hipsQ = qMul(Y(yaw), Z(1.5 * k * Math.sin(w - Math.PI * duty)));
      const breath = Math.sin((2 * Math.PI * t) / duration);
      const armR = swing * Math.cos(w), armLf = -swing * Math.cos(w);
      const bend = run ? 82 : 12, bendExtra = run ? 10 : 18;
      const body: Record<string, Q> = {
        Spine: qMul(X(lean * 0.5), Y(-yaw * 0.5)),
        Chest: qMul(X(lean * 0.3 + (run ? -0.6 * breath : 0)), Y(-yaw * 0.45)),
        UpperChest: Y(-yaw * 0.35),
        Neck: X(-lean * 0.35),
        Head: qMul(X(-lean * 0.45 - (bounce / s) * 40 * (bob - 0.5)), Y(yaw * 0.3)),
        ...arm('Left', holds.left ? armLf * 0.25 : armLf, bend + bendExtra * Math.max(0, armLf / Math.max(1, swing)), run ? 4 : 0),
        ...arm('Right', holds.right ? armR * 0.25 : armR, bend + bendExtra * Math.max(0, armR / Math.max(1, swing)), run ? 4 : 0),
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
      const f = ease((u - a.at) / Math.max(1e-6, c.at - a.at));
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
      const drop = ((a.drop ?? 0) + ((c.drop ?? 0) - (a.drop ?? 0)) * f) * s;
      const hands = { left: lerpHand(handOf(a, 'left'), handOf(c, 'left'), f), right: lerpHand(handOf(a, 'right'), handOf(c, 'right'), f) };
      return { hipsOff: [0, -0.012 * s - drop, -drop * 0.35], hipsQ: qIdentity(), body, hands, feet: { left: { p: fl, q: flat, down: true }, right: { p: fr, q: flat, down: true } } };
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
      if (dist0 > maxR) reachMiss = Math.max(reachMiss, dist0 - maxR);
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
    ...(turnDeg !== undefined ? { turn: turnDeg } : {}), ...(stride !== undefined ? { stride: +stride.toFixed(4) } : {}),
    local, hips, contacts: { left: cl, right: cr }, feet: { left: fpL, right: fpR },
    shapes: { eyeBlinkLeft: blinkCurve, eyeBlinkRight: blinkCurve }, reachMiss: +reachMiss.toFixed(4), settings: S,
  };
}

// ── checks (the authority on motion, Decision 6): planted feet, ground, reach, loops ──────────────
export interface MotionReport { slip: number; below: number; reachMiss: number; loopGap: number; kneeWorst: number; elbowWorst: number; pass: boolean; detail: string }

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
  let loopGap = 0;
  if (clip.loop) for (let i = 0; i < rig.bones.length; i++) loopGap = Math.max(loopGap, qAngle(clip.local[0][i], clip.local[clip.frames][i]));
  const fails: string[] = [];
  if (slip > 0.012 * s) fails.push(`a planted foot slides ${(slip * 100).toFixed(1)} cm`);
  if (below > 0.012 * s) fails.push(`a foot sinks ${(below * 100).toFixed(1)} cm below the floor`);
  if (clip.reachMiss > 0.01 * s) fails.push(`the legs can't reach the ground by ${(clip.reachMiss * 100).toFixed(1)} cm (shorter stride or lower bounce)`);
  if (loopGap > 1.5) fails.push(`the loop jumps ${loopGap.toFixed(1)}° where it wraps`);
  if (kneeWorst > 150) fails.push(`a knee bends ${kneeWorst.toFixed(0)}°`);
  if (elbowWorst > 155) fails.push(`an elbow bends ${elbowWorst.toFixed(0)}°`);
  const pass = !fails.length;
  const detail = pass
    ? `${clip.loop ? 'loops cleanly; ' : ''}planted feet slide ≤ ${(slip * 1000).toFixed(0)} mm, nothing below the floor${clip.speed ? `; ${clip.speed.toFixed(2)} m/s, ${clip.stride?.toFixed(2)} m stride, ${clip.duration.toFixed(2)} s cycle` : `; ${clip.duration.toFixed(2)} s`}`
    : fails.join('; ');
  return { slip: +slip.toFixed(4), below: +below.toFixed(4), reachMiss: clip.reachMiss, loopGap: +loopGap.toFixed(2), kneeWorst: +kneeWorst.toFixed(1), elbowWorst: +elbowWorst.toFixed(1), pass, detail };
}

/** Frames worth a skin check: the extremes of a cycle, or an action's keys. */
export function checkFrames(clip: MotionClip): number[] {
  if (clip.kind === 'walk' || clip.kind === 'run') return [0, Math.round(clip.frames * 0.25)];
  if (clip.kind === 'idle') return [Math.round(clip.frames * 0.25)];
  if (clip.kind === 'turn') return [Math.round(clip.frames * 0.5)];
  const def = ACTIONS[clip.settings.action!];
  return def.keys.filter((k) => k.bones).map((k) => Math.min(clip.frames, Math.round(k.at * clip.frames))).filter((f, i, a) => a.indexOf(f) === i).slice(0, 3);
}
