// Character kit (Decisions 14, 19, 20, 22): a parametric humanoid whose skeleton, skin weights and
// face shapes come with the template, so every character Claude makes is born rigged.
//   • characterSpec(params)  → bones (Godot SkeletonProfileHumanoid names) + low-poly pieces + face landmarks
//   • buildRig(...)          → skin weights (≤ 4 per vertex) and face shape keys, computed on the FINAL
//                              mesh (the kernel's booleans don't keep vertex identity), as deformation
//                              fields driven by the template's landmarks
//   • poseRig(...)           → body pose + hand poses + expression applied (what the view shows)
//   • poseChecks(...)        → a canonical pose set: joint volume, edge stretch, self-intersection, weights
// DOM-free and Node-free.
import type { CharacterState, HandPose } from './types.ts';

import { addTail, addWings, quadrupedSpec, type QuadDims } from './quadruped.ts';
export type V3 = [number, number, number];
export type Q = [number, number, number, number];

// ── math ────────────────────────────────────────────────────────────────
export const qIdentity = (): Q => [0, 0, 0, 1];
export function qMul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export function qAxisAngle(axis: V3, deg: number): Q {
  const l = Math.hypot(...axis) || 1, h = (deg * Math.PI) / 360, s = Math.sin(h);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(h)];
}
/** Euler degrees, applied X then Y then Z (q = qz · qy · qx). */
export function qEuler([x, y, z]: V3): Q {
  return qMul(qAxisAngle([0, 0, 1], z), qMul(qAxisAngle([0, 1, 0], y), qAxisAngle([1, 0, 0], x)));
}
export function qRot(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export function qFromBasis(x: V3, y: V3, z: V3): Q {
  // rotation whose columns are x, y, z (orthonormal)
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q: Q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subv = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// ── the humanoid skeleton (Godot SkeletonProfileHumanoid names) ────────
export const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_SEGS: Record<string, string[]> = { Thumb: ['Metacarpal', 'Proximal', 'Distal'], Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'], Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'] };
export const fingerBones = (side: 'Left' | 'Right', finger: string) => FINGER_SEGS[finger].map((s) => `${side}${finger}${s}`);

export interface BoneDef { name: string; parent: string | null; head: V3; tail: V3 }

/** Body plans (Decision 47 A): the skeleton comes first, then a body, face and outfit on it. Every plan
 *  keeps the standard humanoid bone names, so motion, export and the engines treat them alike. */
export const BODY_PLANS = ['human', 'chibi', 'lanky', 'stocky', 'beaked', 'quadruped'] as const;
export type BodyPlan = typeof BODY_PLANS[number];
/** Face parts (Decision 49 A): each mouth answers to the same 15 speech shapes in its own way. */
export const MOUTHS = ['human', 'cartoon', 'beak', 'muzzle', 'grille'] as const;
export const EYE_STYLES = ['natural', 'big', 'dot'] as const;
export const BROW_STYLES = ['bar', 'bushy', 'none'] as const;
export const NOSES = ['human', 'long', 'button', 'big', 'none'] as const;
export const EARS = ['human', 'pointy', 'upright', 'floppy', 'none'] as const;
export const HAIRS = ['short', 'none', 'tuft', 'bun'] as const;
/** Style families: how the low-poly shapes are cut (facet count and chunkiness). */
export const STYLE_FAMILIES = ['faceted', 'toy', 'smooth'] as const;
export type WalkStyle = 'waddle' | 'swagger' | 'shuffle' | 'bounce';
/** Shape language (craft pass): round (soft, friendly), square (solid, dependable), triangle (sharp, wiry). */
export const SHAPES = ['round', 'square', 'triangle'] as const;
export type Shape = typeof SHAPES[number];

export interface PlanDef {
  label: string;
  height: number; build: number;          // defaults
  head: number;                           // head height as a fraction of standing height
  leg: number; arm: number;               // leg length (fraction of height), arm length (× human)
  shoulder: number; limb: number;         // shoulder width, limb thickness (× human)
  hand: number; foot: number; neck: number;
  headW: number; headD: number;           // head half-width / half-depth (× human)
  torso: [number, number, number, number, number]; // hips, waist, chest widths, depth (× human), belly (front bulge at the waist, × depth)
  eyeY: number;                           // eye height on the head (0..1)
  face: { mouth: typeof MOUTHS[number]; eyes: typeof EYE_STYLES[number]; brows: typeof BROW_STYLES[number]; nose: typeof NOSES[number]; ears: typeof EARS[number]; hair: typeof HAIRS[number] };
  walk?: WalkStyle;                       // the plan's natural gait (set-motion --style overrides)
  shape: Shape;                           // its shape language
}
export const PLANS: Record<BodyPlan, PlanDef> = {
  human: { label: 'human proportions', height: 1.75, build: 0.55, head: 0.165, leg: 0.47, arm: 1, shoulder: 1, limb: 1, hand: 1.12, foot: 1, neck: 1, headW: 1, headD: 1, torso: [1, 1, 1, 1, 0], eyeY: 0.5,
    face: { mouth: 'human', eyes: 'natural', brows: 'bar', nose: 'human', ears: 'human', hair: 'short' }, shape: 'round' },
  chibi: { label: 'big head, short round body, stubby limbs', height: 1.0, build: 0.6, head: 0.34, leg: 0.3, arm: 0.86, shoulder: 1.05, limb: 1.45, hand: 1.45, foot: 1.5, neck: 0.45, headW: 1.12, headD: 1.04, torso: [1.35, 1.3, 1.15, 1.25, 0.22], eyeY: 0.44,
    face: { mouth: 'cartoon', eyes: 'big', brows: 'bar', nose: 'button', ears: 'human', hair: 'tuft' }, walk: 'bounce', shape: 'round' },
  lanky: { label: 'tall and thin, long limbs, small head', height: 2.05, build: 0.15, head: 0.125, leg: 0.53, arm: 1.16, shoulder: 0.9, limb: 0.82, hand: 1.25, foot: 1.0, neck: 1.7, headW: 0.86, headD: 0.98, torso: [0.82, 0.74, 0.86, 0.82, 0], eyeY: 0.52,
    face: { mouth: 'human', eyes: 'natural', brows: 'bar', nose: 'long', ears: 'human', hair: 'short' }, shape: 'triangle' },
  stocky: { label: 'short and broad, barrel chest, thick limbs', height: 1.38, build: 0.9, head: 0.2, leg: 0.34, arm: 0.94, shoulder: 1.42, limb: 1.5, hand: 1.5, foot: 1.35, neck: 0.5, headW: 1.08, headD: 1.0, torso: [1.2, 1.38, 1.42, 1.3, 0.18], eyeY: 0.5,
    face: { mouth: 'human', eyes: 'natural', brows: 'bushy', nose: 'big', ears: 'human', hair: 'none' }, walk: 'swagger', shape: 'square' },
  beaked: { label: 'round egg body, short legs, a beak', height: 1.22, build: 0.6, head: 0.25, leg: 0.27, arm: 0.74, shoulder: 0.9, limb: 0.9, hand: 0.95, foot: 1.6, neck: 0.35, headW: 1.0, headD: 1.06, torso: [1.4, 1.62, 1.22, 1.45, 0.42], eyeY: 0.56,
    face: { mouth: 'beak', eyes: 'dot', brows: 'none', nose: 'none', ears: 'none', hair: 'tuft' }, walk: 'waddle', shape: 'round' },
  // four legs (quadruped.ts builds it): height is nose-up standing height; the human fields only steer the face kit
  quadruped: { label: 'four legs, a level back, a tail', height: 0.95, build: 0.55, head: 0.165, leg: 0.47, arm: 1, shoulder: 1, limb: 1, hand: 1, foot: 1, neck: 1, headW: 1.0, headD: 1.1, torso: [1, 1, 1, 1, 0], eyeY: 0.56,
    face: { mouth: 'muzzle', eyes: 'natural', brows: 'none', nose: 'none', ears: 'floppy', hair: 'none' }, shape: 'round' },
};

/** Parameters of a character (all have defaults; the plan sets proportions and face parts). */
export interface CharParams {
  height: number;      // m
  build: number;       // 0 slim … 1 broad
  headSize: number;    // × the plan's head size
  armLength: number;   // ×
  legLength: number;   // ×
  handSize: number;    // ×
  hair: typeof HAIRS[number];
  apron?: boolean;     // a hanging apron: two extra bones (ApronUpper, ApronLower) so the cloth bends and swings (secondary motion)
  plan?: BodyPlan;
  style?: typeof STYLE_FAMILIES[number];
  mouth?: typeof MOUTHS[number];
  eyes?: typeof EYE_STYLES[number];
  brows?: typeof BROW_STYLES[number];
  nose?: typeof NOSES[number];
  ears?: typeof EARS[number];
  tail?: boolean;      // a tail (a spring-driven bone chain); quadrupeds have one unless tail is false
  tailLength?: number; // ×
  snout?: number;      // muzzle length (× the default snout; four-legged heads have long ones)
  wings?: boolean;     // a pair of wings on the upper back (folded at rest, a flap cycle in motion)
  shape?: Shape;       // shape language (defaults to the plan's)
  legs?: 'bird';       // bird legs: feathered drumsticks, thin scaled shanks, splayed toes
  sleeves?: 'short' | 'long'; // where the sleeve hem sits (from the look)
  mood?: Mood;         // the face at rest (built into the bind pose): warm, cheerful, gentle, proud, nervous, grumpy
}
/** Rest expressions: a character's resting face carries its personality (face appeal round). */
export const MOODS = ['neutral', 'warm', 'cheerful', 'gentle', 'proud', 'nervous', 'grumpy'] as const;
export type Mood = typeof MOODS[number];
/** A mood as a mix of expression shapes. Lips smile; beaks, muzzles and grilles can't, so their mood
 *  lives in the eyes, cheeks and brows (a smiling beak just bends). */
export function moodMix(mood: Mood | undefined, kind: typeof MOUTHS[number] | undefined): Record<string, number> {
  if (!mood || mood === 'neutral') return {};
  const lips = kind !== 'beak' && kind !== 'grille' && kind !== 'muzzle';
  // a mouth with teeth smiles more gently at rest (a wide resting grin would bare the teeth at the
  // corners in every speech shape); cartoon mouths have no teeth and can smile fully
  const sm = kind === 'cartoon' ? 1 : 0.55;
  const both = (k: string, l: number, r = l) => ({ [`${k}Left`]: k === 'mouthSmile' ? l * sm : l, [`${k}Right`]: k === 'mouthSmile' ? r * sm : r });
  switch (mood) {
    case 'warm': return lips ? { ...both('mouthSmile', 0.55), ...both('cheekSquint', kind === 'cartoon' ? 0.3 : 0), browInnerUp: 0.08 } : { ...both('cheekSquint', 0.45), ...both('browOuterUp', 0.18) };
    case 'cheerful': return lips ? { ...both('mouthSmile', 0.8), ...both('cheekSquint', 0.45), ...both('browOuterUp', 0.25) } : { ...both('cheekSquint', 0.55), ...both('browOuterUp', 0.32) };
    case 'gentle': return lips ? { ...both('mouthSmile', 0.38), ...both('cheekSquint', 0.22), browInnerUp: 0.28 } : { ...both('cheekSquint', 0.3), browInnerUp: 0.3 };
    case 'proud': return lips ? { ...both('mouthSmile', 0.5, 0.22), ...both('browOuterUp', 0.16), ...both('cheekSquint', 0.15) } : { ...both('browOuterUp', 0.22), ...both('cheekSquint', 0.2) };
    case 'nervous': return lips ? { browInnerUp: 0.6, ...both('mouthSmile', 0.25), mouthPucker: 0.08 } : { browInnerUp: 0.65 };
    case 'grumpy': return lips ? { ...both('browDown', 0.5), ...both('mouthFrown', 0.12), mouthSmileLeft: 0.18 } : { ...both('browDown', 0.5) };
  }
}
/** How much a mood curves the resting mouth line (× head height at the corners; < 0 turns them down). */
export const moodCurve = (mood: Mood | undefined) => ({ warm: 0.022, cheerful: 0.032, gentle: 0.018, proud: 0.016, nervous: 0.008, grumpy: -0.012, neutral: 0 } as Record<string, number>)[mood ?? 'neutral'] ?? 0;
/**
 * Bend the mouth into a curve at rest: the lips, the opening and the skin around them rise towards the
 * corners (∝ (x / mouth half width)²), so a smile reads as a curve rather than a straight bar with
 * lifted ends. Teeth and tongue rise with them. Lips only (beaks and grilles keep
 * their shape). Moves `pos` in place.
 */
export function curveMouth(spec: CharSpec, pos: Float32Array, vertPart: string[], k: number) {
  const F = spec.face;
  if (!k || (F.kind !== 'human' && F.kind !== 'cartoon')) return;
  const m = F.mouth, mw = F.mouthW, H = F.headH, amt = k * H * (F.kind === 'cartoon' ? 1 : 0.6);
  for (let v = 0; v < vertPart.length; v++) {
    const part = vertPart[v];
    if (!isFacePart(part) || part === 'hair' || part.startsWith('brow') || part.startsWith('lid') || part.startsWith('ear')) continue;
    const x = pos[v * 3] - m[0], y = pos[v * 3 + 1] - m[1], z = pos[v * 3 + 2];
    // teeth and tongue follow the curve too (they stay behind the lips as the corners rise)
    if (z < m[2] - 0.25 * H && !isMouthPart(part)) continue;
    const t = Math.min(1.25, Math.abs(x) / mw);
    const lift = amt * t * t * Math.exp(-((y / (0.07 * H)) ** 2)) * (1 - smooth(1.2 * mw, 1.7 * mw, Math.abs(x)));
    // a cartoon smile is a grin: the lower lip and the slot's lower edge sag in the middle, so the
    // closed line opens into a crescent (dark inside, corners still closed) instead of a thin seam
    let grin = 0;
    if (F.kind === 'cartoon' && k > 0 && y < F.slotH * 0.3) {
      const u = Math.min(1, Math.abs(x) / (mw * 0.92));
      const fall = part === 'lipLower' ? 1 : Math.exp(-(((y + F.slotH * 0.5) / (0.045 * H)) ** 2));
      grin = amt * 1.0 * (1 - u * u) ** 1.4 * fall;
    }
    pos[v * 3 + 1] += lift - grin;
  }
}
export const CHAR_DEFAULTS: CharParams = { height: 1.75, build: 0.55, headSize: 1, armLength: 1, legLength: 1, handSize: 1, hair: 'short' };
/** Where an apron hangs (its back face, object space z) for a build: the kit's apron op and the apron bones share it. */
export const apronZ = (s: number, build: number, plan: BodyPlan = 'human') => 0.123 * s * (0.9 + 0.3 * build) * apronDepth(plan);
/** How much further out an apron hangs on a plan's body (deeper torsos, bellies). */
export const apronDepth = (plan: BodyPlan) => { const t = PLANS[plan].torso; return Math.round(Math.max(1, t[3] * (1 + 0.6 * t[4])) * 100) / 100; };

export type Piece =
  | { kind: 'seg'; a: V3; b: V3; r1: number; r2: number; sides: number; part: string }
  | { kind: 'ball'; c: V3; r: number; sides: number; part: string; cap?: number; axis?: V3 }   // cap: keep the spherical cap ≥ cap·r along axis (default +Z)
  | { kind: 'hull'; pts: V3[]; part: string; loops?: boolean };

export interface FaceLandmarks {
  headBase: V3; headH: number; hw: number; hd: number;   // head bottom-centre, height, half width, half depth
  mouth: V3; mouthW: number; slotH: number;               // mouth centre on the face surface, half width, slot height
  jawPivot: V3;
  teeth: { upperFront: number; lowerFront: number; edgeY: number; arch: number }; // z of the upper/lower teeth fronts at x = 0, the upper biting edge, arch curvature
  tongue: { tipZ: number; backZ: number };
  eyes: Array<{ c: V3; r: number; side: 'Left' | 'Right' }>;
  brows: V3[];                                            // inner-to-outer centres per side [L, R]
  nose: V3;
  cheeks: V3[];
  kind?: typeof MOUTHS[number];                           // which mouth part (its speech shapes differ)
}

export interface CharSpec {
  params: CharParams;
  s: number;                                              // height / 1.75
  bones: BoneDef[];
  pieces: Piece[];                                        // body + face attachments (unioned)
  head: { pts: V3[]; extra?: V3[][]; refine: number; part: string }; // faceted head hull (plus extra hulls joined to it, e.g. a muzzle), refined for the face shapes
  cuts: Array<{ kind: 'box'; c: V3; size: V3; part: string } | { kind: 'ball'; c: V3; r: number; sides: number; part: string } | { kind: 'hull'; pts: V3[]; part: string }>;
  mouth: Piece[];                                         // teeth rows and tongue: separate shells inside the mouth (upper teeth on the head, lower teeth and tongue on the jaw)
  eyes: Piece[];                                          // eyeballs (kept separate: they turn with the eye bones)
  lids: Array<{ c: V3; rIn: number; rOut: number; edgeDeg: number; closeDeg: number; part: string; bone: string; lower?: { rIn: number; rOut: number; edgeDeg: number; part: string } }>; // eyelid shells outside the eyeball (the lid bones turn the upper ones; the lower one rides the head)
  face: FaceLandmarks;
  palm: Record<'Left' | 'Right', { c: V3; len: number; width: number; thick: number }>;
  plan: BodyPlan;
  walk?: WalkStyle;
  quad?: QuadDims;                                        // set for four-legged bodies
}

const pick = <T extends readonly string[]>(list: T, v: unknown, what: string): T[number] | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!list.includes(v as string)) throw new Error(`character ${what} must be one of ${list.join(', ')} (got ${v})`);
  return v as T[number];
};

export function charParams(a: Partial<Record<keyof CharParams, unknown>>): CharParams {
  const n = (k: keyof CharParams, lo: number, hi: number) => {
    const v = a[k] === undefined ? (CHAR_DEFAULTS[k] as number) : Number(a[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`character ${k} must be between ${lo} and ${hi} (got ${a[k]})`);
    return v;
  };
  const plan = pick(BODY_PLANS, a.plan, 'plan');
  const opt: Partial<CharParams> = {};
  if (plan && plan !== 'human') opt.plan = plan;
  const lists = { style: STYLE_FAMILIES, mouth: MOUTHS, eyes: EYE_STYLES, brows: BROW_STYLES, nose: NOSES, ears: EARS, shape: SHAPES } as const;
  for (const k of Object.keys(lists) as Array<keyof typeof lists>) {
    const v = pick(lists[k] as readonly string[], a[k], k);
    if (v) (opt as any)[k] = v;
  }
  return {
    height: n('height', 0.5, 3), build: n('build', 0, 1), headSize: n('headSize', 0.7, 1.6),
    armLength: n('armLength', 0.7, 1.4), legLength: n('legLength', 0.7, 1.4), handSize: n('handSize', 0.6, 1.6),
    hair: pick(HAIRS, a.hair, 'hair') ?? (plan ? PLANS[plan].face.hair : 'short'),
    ...(a.apron === true || a.apron === 'true' || a.apron === 1 ? { apron: true } : {}),
    ...(a.wings === true || a.wings === 'true' || a.wings === 1 ? { wings: true } : {}),
    ...(a.tail === true || a.tail === 'true' || a.tail === 1 ? { tail: true } : a.tail === false || a.tail === 'false' || a.tail === 0 ? { tail: false } : {}),
    ...(a.tailLength !== undefined ? { tailLength: n('tailLength', 0.3, 2) } : {}),
    ...(a.legs === 'bird' ? { legs: 'bird' as const } : {}),
    ...(a.sleeves === 'short' || a.sleeves === 'long' ? { sleeves: a.sleeves as 'short' | 'long' } : {}),
    ...(pick(MOODS, a.mood, 'mood') && a.mood !== 'neutral' ? { mood: a.mood as Mood } : {}),
    ...opt,
  };
}

/** The humanoid template: bones, pieces and face landmarks from the parameters. Faces +Z; its left is +X. */
export function characterSpec(p: CharParams): CharSpec {
  if (p.plan === 'quadruped') return quadrupedSpec(p);
  const plan: BodyPlan = p.plan ?? 'human';
  const PD = PLANS[plan];
  const F0 = PD.face;
  const mouthKind = p.mouth ?? F0.mouth, eyeStyle = p.eyes ?? F0.eyes, browStyle = p.brows ?? F0.brows, noseKind = p.nose ?? F0.nose, earKind = p.ears ?? F0.ears;
  const style = p.style ?? 'faceted';
  const shape: Shape = p.shape ?? PD.shape;
  const birdLegs = p.legs === 'bird';
  const SIDES = style === 'toy' ? 6 : style === 'smooth' ? (p.wings ? 10 : 12) : 8, HEAD_N = style === 'toy' ? 8 : style === 'smooth' ? 18 : 12;
  const s = p.height / 1.75, H = p.height, b = p.build;
  const L = PD.limb, T = PD.torso;
  const headH = PD.head * H * p.headSize, neckLen = 0.028 * H * PD.neck;
  const legTotal = PD.leg * H * p.legLength;
  const hipY = legTotal + 0.035 * s;
  const torsoLen = H - hipY - neckLen - headH;
  if (torsoLen < 0.16 * s) throw new Error('character proportions leave no room for a torso: lower headSize or legLength');
  const ankleY = 0.075 * s * Math.min(1, PD.foot), kneeY = ankleY + (hipY - ankleY) * 0.48;
  const legX = 0.1 * s * (0.9 + 0.25 * b) * (0.55 + 0.45 * T[0]);
  const shoulderY = hipY + torsoLen * 0.95;
  // shoulders wide enough that the arms hang clear of a broad torso (a belly, a barrel chest) and of
  // their own thickness: at least as wide as the widest torso ring, plus any extra arm girth
  const torsoHalf = Math.max(0.165 * T[0], 0.155 * T[1], 0.185 * T[2]) * (0.86 + 0.3 * b) * s;
  const extraArm = Math.max(0, 0.052 * s * (0.8 + 0.4 * b) * (L - 1));
  const shW = Math.max(0.18 * s * (0.86 + 0.34 * b) * PD.shoulder, plan === 'human' ? 0 : torsoHalf * 1.02 + extraArm * 1.3);
  const upperArm = 0.165 * H * p.armLength * PD.arm, lowerArm = 0.145 * H * p.armLength * PD.arm;
  const hs = p.handSize * PD.hand;
  const palmLen = 0.052 * H * hs, palmW = 0.056 * H * hs, palmT = 0.018 * H * hs;
  const fingerLen = 0.046 * H * hs;
  const headBaseY = hipY + torsoLen + neckLen;
  const bones: BoneDef[] = [];
  const bone = (name: string, parent: string | null, head: V3, tail: V3) => bones.push({ name, parent, head, tail });
  bone('Root', null, [0, 0, 0], [0, 0.1 * s, 0]);
  bone('Hips', 'Root', [0, hipY, 0], [0, hipY + torsoLen * 0.22, 0]);
  bone('Spine', 'Hips', [0, hipY + torsoLen * 0.22, 0], [0, hipY + torsoLen * 0.45, 0]);
  bone('Chest', 'Spine', [0, hipY + torsoLen * 0.45, 0], [0, hipY + torsoLen * 0.7, 0]);
  bone('UpperChest', 'Chest', [0, hipY + torsoLen * 0.7, 0], [0, hipY + torsoLen, 0]);
  bone('Neck', 'UpperChest', [0, hipY + torsoLen, 0], [0, headBaseY, 0]);
  bone('Head', 'Neck', [0, headBaseY, 0], [0, headBaseY + headH, 0]);
  // face
  const hw = 0.5 * headH * 0.8 * PD.headW, hd = 0.5 * headH * 0.92 * PD.headD;
  // the head's profile rings: [height 0..1, half width, front depth, back depth] (× hw / hd)
  // shape language sets the widths (the front depths stay, so the mouth and nose sit where they did):
  // square = a broad jaw and a flat crown, triangle = a narrow chin under a wide skull, round = full cheeks
  const W = shape === 'square' ? [0.5, 0.84, 0.95, 1.0, 1.0, 0.92, 0.62] : shape === 'triangle' ? [0.16, 0.46, 0.76, 0.96, 1.04, 0.92, 0.46] : [0.32, 0.64, 0.87, 0.98, 1.0, 0.87, 0.44];
  const headRings: Array<[number, number, number, number]> = [
    [0.0, W[0], 0.6, 0.15], [0.1, W[1], 0.86, 0.45], [0.27, W[2], 0.97, 0.78], [0.5, W[3], 0.97, 0.92], [0.7, W[4], 0.9, 1.0], [0.88, W[5], 0.74, 0.9], [1.0, W[6], shape === 'square' ? 0.5 : 0.34, shape === 'square' ? 0.66 : 0.5],
  ];
  // where the face surface is (front, at x = 0) at a height: the hull between two rings is linear
  const surfZ = (y01: number) => {
    for (let i = 0; i < headRings.length - 1; i++) {
      const [y0, , f0] = headRings[i], [y1, , f1] = headRings[i + 1];
      if (y01 >= y0 && y01 <= y1) return hd * (f0 + ((y01 - y0) / (y1 - y0)) * (f1 - f0));
    }
    return hd * 0.6;
  };
  // …and off-centre: the rings are (nearly) ellipses, so the surface curves back toward the sides
  const ringAt = (y01: number) => {
    for (let i = 0; i < headRings.length - 1; i++) {
      const [y0, r0] = headRings[i], [y1, r1] = headRings[i + 1];
      if (y01 >= y0 && y01 <= y1) return hw * (r0 + ((y01 - y0) / (y1 - y0)) * (r1 - r0));
    }
    return hw * 0.5;
  };
  const surfAt = (y01: number, x: number) => surfZ(y01) * Math.sqrt(Math.max(0, 1 - (x / ringAt(y01)) ** 2));
  const eyeR = (eyeStyle === 'big' ? 0.25 : eyeStyle === 'dot' ? 0.15 : 0.19) * hw;
  const eyeY01 = PD.eyeY;
  const eyeY = headBaseY + eyeY01 * headH;
  const eyeX = (eyeStyle === 'big' ? 0.46 : 0.41) * hw;
  const eyeZ = surfAt(eyeY01, eyeX) - 0.68 * eyeR;
  const mouthY01 = mouthKind === 'beak' ? 0.3 : mouthKind === 'muzzle' ? 0.2 : 0.24;
  const mouthY = headBaseY + mouthY01 * headH;
  // a muzzle pushes the mouth forward on a snout (the head hull takes the snout's points)
  const snoutZ = mouthKind === 'muzzle' ? surfZ(mouthY01) + 0.3 * (p.snout ?? 1) * headH : 0;
  const mouthZ = mouthKind === 'muzzle' ? snoutZ : surfZ(mouthY01);
  const jawPivot: V3 = [0, headBaseY + 0.42 * headH, -0.08 * hd];
  bone('LeftEye', 'Head', [eyeX, eyeY, eyeZ], [eyeX, eyeY, eyeZ + eyeR]);
  bone('RightEye', 'Head', [-eyeX, eyeY, eyeZ], [-eyeX, eyeY, eyeZ + eyeR]);
  bone('Jaw', 'Head', jawPivot, [0, headBaseY + 0.05 * headH, surfZ(0.05)]);
  // eyelids turn about the eye centre (blinks are rotations: a shape key would cut through the eyeball)
  bone('LeftUpperLid', 'Head', [eyeX, eyeY, eyeZ], [eyeX, eyeY + eyeR, eyeZ]);
  bone('RightUpperLid', 'Head', [-eyeX, eyeY, eyeZ], [-eyeX, eyeY + eyeR, eyeZ]);
  if (p.apron) {
    // the apron hangs from the waist in front of the thighs: two bones down its middle, swung by a
    // spring when motions are baked (it lags, sways and is pushed forward by the knees)
    const az = apronZ(s, b, plan) + 0.015 * s;
    bone('ApronUpper', 'Hips', [0, hipY + 0.02 * s, az], [0, hipY - 0.17 * s, az]);
    bone('ApronLower', 'ApronUpper', [0, hipY - 0.17 * s, az], [0, hipY - 0.36 * s, az]);
  }
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    const sh: V3 = [sx * shW, shoulderY, 0], el: V3 = [sx * (shW + upperArm), shoulderY, 0], wr: V3 = [sx * (shW + upperArm + lowerArm), shoulderY, 0];
    bone(`${side}Shoulder`, 'UpperChest', [sx * 0.04 * s, shoulderY - 0.01 * s, 0], sh);
    bone(`${side}UpperArm`, `${side}Shoulder`, sh, el);
    bone(`${side}LowerArm`, `${side}UpperArm`, el, wr);
    const knuckle: V3 = [wr[0] + sx * palmLen, shoulderY, 0];
    bone(`${side}Hand`, `${side}LowerArm`, wr, knuckle);
    // thumb: from the inner palm, forward (+Z, thumb side) and out
    const tDir = norm([sx * 0.55, -0.03, 0.83]);
    const tLen = fingerLen * 0.95;
    let at: V3 = [wr[0] + sx * palmLen * 0.18, shoulderY - palmT * 0.2, palmW * 0.36];
    const tSegs = [0.38, 0.33, 0.29];
    fingerBones(side, 'Thumb').forEach((name, i) => {
      const end = add(at, mul(tDir, tLen * tSegs[i]));
      bone(name, i === 0 ? `${side}Hand` : fingerBones(side, 'Thumb')[i - 1], at, end);
      at = end;
    });
    const fingerZ: Record<string, number> = { Index: 0.4, Middle: 0.135, Ring: -0.135, Little: -0.39 };
    const fingerL: Record<string, number> = { Index: 0.95, Middle: 1, Ring: 0.93, Little: 0.76 };
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
      let a: V3 = [knuckle[0] - sx * (f === 'Little' ? 0.06 : f === 'Index' ? 0.02 : 0) * palmLen, shoulderY - palmT * 0.1, fingerZ[f] * palmW];
      const segs = [0.42, 0.32, 0.26];
      fingerBones(side, f).forEach((name, i) => {
        const end: V3 = [a[0] + sx * fingerLen * fingerL[f] * segs[i], a[1], a[2]];
        bone(name, i === 0 ? `${side}Hand` : fingerBones(side, f)[i - 1], a, end);
        a = end;
      });
    }
    const hip: V3 = [sx * legX, hipY, 0], knee: V3 = [sx * legX, kneeY, 0.012 * s], ankle: V3 = [sx * legX, ankleY, -0.01 * s];
    bone(`${side}UpperLeg`, 'Hips', hip, knee);
    bone(`${side}LowerLeg`, `${side}UpperLeg`, knee, ankle);
    bone(`${side}Foot`, `${side}LowerLeg`, ankle, [sx * legX, 0.03 * s, 0.1 * s]);
    bone(`${side}Toes`, `${side}Foot`, [sx * legX, 0.03 * s, 0.1 * s], [sx * legX, 0.03 * s, 0.165 * s]);
  }
  const B = Object.fromEntries(bones.map((x) => [x.name, x]));

  // ── pieces (low-poly, faceted) ─────────────────────────────────────────
  const pieces: Piece[] = [];
  const seg = (a: V3, c: V3, r1: number, r2: number, part: string, sides = SIDES) => pieces.push({ kind: 'seg', a, b: c, r1, r2, sides, part });
  const ball = (c: V3, r: number, part: string, sides = SIDES) => pieces.push({ kind: 'ball', c, r, sides, part });
  // rings: an ellipse that a square shape language pushes toward a rounded box (sq 0 … 1)
  const sqT = shape === 'square' ? 0.55 : 0;
  const ring = (y: number, rx: number, rzF: number, rzB: number, n = SIDES, cx = 0, cz = 0, sq = sqT): V3[] =>
    Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2, sn = Math.sin(t), c = Math.cos(t), m = Math.max(Math.abs(sn), Math.abs(c));
      const ex = sn * (1 - sq) + (sn / m) * sq * 0.94, ez = c * (1 - sq) + (c / m) * sq * 0.94 + (Math.abs(c) > 0.999 ? 0.06 * sq * c : 0);
      return [cx + rx * ex, y, cz + (c > 0 ? rzF : rzB) * ez] as V3;
    });
  // a limb with volume: three oval rings (start, the muscle bulge, end) hulled, so it swells and tapers
  // instead of being a tube; flat (0..1) squashes it front to back (forearms, shins); edge loops let it bend
  const frame = (a: V3, c: V3) => {
    const d = subv(c, a), L0 = Math.hypot(...d), z = mul(d, 1 / L0);
    const fwd: V3 = Math.abs(z[1]) > 0.6 ? [0, 0, 1] : Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const side = norm(cross(z, fwd)), front = cross(side, z);
    return { d, side, front, z };
  };
  const limb = (a: V3, c: V3, r0: number, rb: number, r1: number, tb: number, part: string, flat = 0.12, n = SIDES) => {
    const { d, side, front } = frame(a, c);
    const rng = (o: V3, r: number) => Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; return add(o, add(mul(side, r * Math.sin(t)), mul(front, r * (1 - flat) * Math.cos(t)))); });
    pieces.push({ kind: 'hull', part, loops: true, pts: [...rng(a, r0), ...rng(add(a, mul(d, tb)), rb), ...rng(c, r1)] });
  };
  // a band around a limb (a hem, a cuff, a scale ring): two rings across the bone
  const bandAlong = (a: V3, c: V3, at: number, r: number, h: number, part: string, n = Math.max(SIDES, 10)) => {
    const { d, side, front, z } = frame(a, c);
    const o = add(a, mul(d, at));
    const rng = (q: V3) => Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; return add(q, add(mul(side, r * Math.sin(t)), mul(front, r * Math.cos(t)))); });
    pieces.push({ kind: 'hull', part, pts: [...rng(add(o, mul(z, -h / 2))), ...rng(add(o, mul(z, h / 2)))] });
  };
  // torso: hips → waist → chest → shoulders, shaped by the plan (V, barrel, pear, egg, straight) and
  // the shape language (a triangle tapers to a narrow waist under a wide chest)
  const tw = (0.86 + 0.3 * b) * s;
  const dpt = T[3], belly = T[4];
  const tr = Math.max(SIDES, 8);
  const [kH, kW, kC] = shape === 'triangle' ? [0.9, 0.86, 1.1] : shape === 'round' ? [1.02, 1.04, 1.0] : [1, 1, 1];
  const hipR = 0.165 * tw * T[0] * kH, waistR = 0.155 * tw * T[1] * kW, waistY = hipY + torsoLen * 0.35;
  const hipZ = 0.1 * s * dpt, waistZ = 0.11 * s * (0.85 + 0.4 * b) * dpt * (1 + belly);
  pieces.push({ kind: 'hull', part: 'torso', pts: [
    ...ring(hipY - 0.07 * s, hipR, hipZ, 0.105 * s * dpt, tr),
    ...ring(waistY, waistR, waistZ, 0.1 * s * dpt, tr),
    ...ring(hipY + torsoLen * 0.7, 0.185 * tw * T[2] * kC, 0.125 * s * dpt * (1 + belly * 0.5), 0.11 * s * dpt, tr),
    ...ring(shoulderY + 0.012 * s, shW * 0.95, 0.085 * s * dpt, 0.085 * s * dpt, tr),
    ...ring(shoulderY + 0.035 * s, shW * 0.45, 0.07 * s * dpt, 0.07 * s * dpt, tr),
  ] });
  const neckR = 0.058 * s * (0.9 + 0.25 * b) * Math.sqrt(L);
  seg(add(B.Neck.head, [0, -0.02 * s, 0]), add(B.Head.head, [0, 0.03 * s, 0]), neckR, 0.052 * s * Math.sqrt(L), 'Neck');
  // clothes with thickness: a collar at the neck, a belt at the waist (with a buckle)
  pieces.push({ kind: 'hull', part: 'collar', pts: [...ring(shoulderY + 0.02 * s, neckR * 1.6, neckR * 1.45, neckR * 1.45, Math.max(SIDES, 10), 0, 0, sqT * 0.5), ...ring(shoulderY + 0.05 * s, neckR * 1.35, neckR * 1.2, neckR * 1.3, Math.max(SIDES, 10), 0, 0, sqT * 0.5)] });
  const beltY = hipY + 0.035 * s, beltT = Math.min(1, Math.max(0, (beltY - (hipY - 0.07 * s)) / (waistY - (hipY - 0.07 * s))));
  const beltR = (hipR + (waistR - hipR) * beltT) * 1.05;
  const beltZ = (hipZ + (waistZ - hipZ) * beltT) * 1.06;
  const beltZB = 0.105 * s * dpt * 1.04;
  const ulLen = Math.hypot(...subv(B.LeftUpperLeg.tail, B.LeftUpperLeg.head));
  if (birdLegs) {
    // plumage: a full skirt of body feathers over the hips and the tops of the legs
    pieces.push({ kind: 'hull', part: 'plumage', pts: [
      ...ring(hipY + 0.04 * s, (hipR + waistR) * 0.53, (hipZ + waistZ) * 0.54, 0.1 * s * dpt * 1.08, Math.max(tr, 10)),
      ...ring(hipY - 0.03 * s, hipR * 1.14, hipZ * 1.2, 0.105 * s * dpt * 1.22, Math.max(tr, 10)),
      ...ring(hipY - 0.12 * s - 0.08 * (ulLen / s - 0.3) * s, hipR * 0.92, hipZ * 1.05, 0.105 * s * dpt * 1.08, Math.max(tr, 10)),
    ] });
  }
  if (!birdLegs) {
    pieces.push({ kind: 'hull', part: 'belt', pts: [...ring(beltY - 0.022 * s, beltR, beltZ, beltZB, Math.max(tr, 12)), ...ring(beltY + 0.022 * s, beltR, beltZ, beltZB, Math.max(tr, 12))] });
    pieces.push({ kind: 'hull', part: 'belt.buckle', pts: [[-0.03 * s, beltY - 0.027 * s, beltZ - 0.006 * s], [0.03 * s, beltY - 0.027 * s, beltZ - 0.006 * s], [-0.03 * s, beltY + 0.027 * s, beltZ - 0.006 * s], [0.03 * s, beltY + 0.027 * s, beltZ - 0.006 * s],
      [-0.026 * s, beltY - 0.022 * s, beltZ + 0.01 * s], [0.026 * s, beltY - 0.022 * s, beltZ + 0.01 * s], [-0.026 * s, beltY + 0.022 * s, beltZ + 0.01 * s], [0.026 * s, beltY + 0.022 * s, beltZ + 0.01 * s]] });
  }
  for (const side of ['Left', 'Right'] as const) {
    const ua = B[`${side}UpperArm`], la = B[`${side}LowerArm`], hd2 = B[`${side}Hand`];
    const ls = s * L;
    const sx = side === 'Left' ? 1 : -1;
    // shoulder cap (deltoid), a swelling upper arm, a forearm full near the elbow that narrows to a slim wrist
    const uaR = 0.05 * ls * (0.82 + 0.4 * b), wristR = 0.03 * ls * (0.9 + 0.2 * b);
    ball(add(ua.head, [-sx * 0.008 * s, -0.018 * s, 0]), uaR * 1.12, `${side}UpperArm`);
    limb(add(ua.head, [0, -0.01 * s, 0]), ua.tail, uaR * 1.05, uaR * 1.12, uaR * 0.8, 0.32, `${side}UpperArm`, 0.08);
    ball(la.head, uaR * 0.8, `${side}LowerArm`);
    limb(la.head, la.tail, uaR * 0.82, uaR * 0.9, wristR, 0.24, `${side}LowerArm`, 0.2);
    ball(hd2.head, wristR * 1.05, `${side}Hand`, 8);
    // sleeve hem: at the elbow for short sleeves, a cuff at the wrist for long ones
    if (p.sleeves === 'short') bandAlong(ua.head, ua.tail, 0.8, uaR * 1.1, 0.028 * s, `${side}UpperArm.hem`);
    else if (p.sleeves === 'long') bandAlong(la.head, la.tail, 0.88, wristR * 1.4, 0.03 * s, `${side}LowerArm.cuff`);
    // palm: a padded box from wrist to knuckles (wider across the knuckles, a heel at the wrist)
    const x0 = hd2.head[0], x1 = hd2.tail[0] - sx * 0.004 * s, y = hd2.head[1];
    const xm = (x0 + x1) / 2;
    pieces.push({ kind: 'hull', part: `${side}Hand`, pts: [
      [x0, y + palmT * 0.55, palmW * 0.38], [x0, y + palmT * 0.55, -palmW * 0.38], [x0, y - palmT * 0.6, palmW * 0.38], [x0, y - palmT * 0.6, -palmW * 0.38],
      [xm, y + palmT * 0.62, palmW * 0.5], [xm, y + palmT * 0.62, -palmW * 0.5], [xm, y - palmT * 0.7, palmW * 0.48], [xm, y - palmT * 0.7, -palmW * 0.48],
      [x1, y + palmT * 0.5, palmW * 0.54], [x1, y + palmT * 0.5, -palmW * 0.54], [x1, y - palmT * 0.55, palmW * 0.54], [x1, y - palmT * 0.55, -palmW * 0.54],
    ] });
    for (const f of FINGER_NAMES) {
      const names = fingerBones(side, f);
      // stylised fingers: chunky, readable at a distance (oversized hands read as friendly)
      const r0 = (f === 'Thumb' ? 0.0132 : f === 'Little' ? 0.0096 : 0.0112) * s * hs;
      names.forEach((n, i) => {
        const bd = B[n];
        const r = r0 * (1 - i * 0.07);
        ball(bd.head, r * 1.04, n, 8);
        seg(bd.head, bd.tail, r, r * 0.94, n, 8);
        if (i === 2) ball(bd.tail, r * 0.92, n, 8);
      });
    }
    const ul = B[`${side}UpperLeg`], ll = B[`${side}LowerLeg`], ft = B[`${side}Foot`];
    // legs: the thigh may be thicker than the hip spacing allows on broad plans, so cap it below the gap between the legs
    const thigh = Math.min(0.09 * ls * (0.85 + 0.35 * b), legX * 0.98);
    const knee = Math.min(0.062 * ls * (0.9 + 0.2 * b), thigh * 0.8);
    if (birdLegs) {
      // a bird's leg: a feathered drumstick at the hip, a thin scaled shank, a bony "ankle" joint
      const sh = 0.02 * s * Math.max(1, L);
      const midT = add(ul.head, mul(subv(ul.tail, ul.head), 0.3));
      limb(ul.head, midT, thigh * 1.0, thigh * 0.95, thigh * 0.55, 0.35, `${side}UpperLeg`, 0.05);
      limb(midT, ul.tail, sh * 1.3, sh * 1.2, sh * 1.15, 0.5, `${side}UpperLeg.shank`, 0, 8);
      ball(ll.head, sh * 1.7, `${side}LowerLeg.shank`, 8);
      limb(ll.head, ll.tail, sh * 1.25, sh * 1.1, sh * 0.95, 0.4, `${side}LowerLeg.shank`, 0, 8);
      for (const at of [0.55, 0.68, 0.81]) bandAlong(ll.head, ll.tail, at, sh * 1.18, 0.012 * s, `${side}LowerLeg.shank`, 6);
      ball(ft.head, sh * 1.5, `${side}Foot`, 8);
      const fx = ft.head[0], fy = 0.012 * s;
      // three long toes splayed forward and one back
      for (const [ang, len] of [[-28, 0.13], [0, 0.15], [28, 0.13], [180, 0.07]] as Array<[number, number]>) {
        const r = (ang * Math.PI) / 180;
        const tip: V3 = [fx + Math.sin(r) * len * s, sh * 0.55, ft.head[2] + Math.cos(r) * len * s];
        pieces.push({ kind: 'seg', a: [fx, sh * 0.95, ft.head[2]], b: tip, r1: sh * 0.9, r2: sh * 0.5, sides: 6, part: ang === 180 ? `${side}Foot` : `${side}Toes` });
      }
      continue;
    }
    // thigh full at the top, a knee, a calf that swells behind and narrows to the ankle
    limb(ul.head, ul.tail, thigh, thigh * 1.02, knee, 0.22, `${side}UpperLeg`, 0.06);
    ball(ll.head, knee * 1.02, `${side}LowerLeg`);
    limb(ll.head, ll.tail, knee * 1.0, knee * 1.08, 0.042 * ls, 0.3, `${side}LowerLeg`, 0.1);
    // trouser hem at the ankle
    bandAlong(ll.head, ll.tail, 0.9, Math.max(0.05 * ls, knee * 0.82), 0.026 * s, `${side}LowerLeg.cuff`);
    ball(ft.head, 0.04 * s * Math.min(1.3, Math.max(L, PD.foot)), `${side}Foot`);
    const fx = ft.head[0], fs = s * PD.foot, fw = s * Math.min(PD.foot, legX / (0.05 * s));
    // a shoe: a raised heel, a rounded toe cap
    pieces.push({ kind: 'hull', part: `${side}Foot`, pts: [
      [fx - 0.035 * fw, ankleY + 0.02 * s, -0.045 * fs], [fx + 0.035 * fw, ankleY + 0.02 * s, -0.045 * fs],
      [fx - 0.042 * fw, 0, -0.058 * fs], [fx + 0.042 * fw, 0, -0.058 * fs],
      [fx - 0.048 * fw, 0, 0.1 * s], [fx + 0.048 * fw, 0, 0.1 * s], [fx - 0.042 * fw, 0.055 * s, 0.085 * s], [fx + 0.042 * fw, 0.055 * s, 0.085 * s],
    ] });
    pieces.push({ kind: 'hull', part: `${side}Toes`, pts: [
      [fx - 0.048 * fw, 0, 0.095 * s], [fx + 0.048 * fw, 0, 0.095 * s], [fx - 0.042 * fw, 0.05 * s, 0.088 * s], [fx + 0.042 * fw, 0.05 * s, 0.088 * s],
      [fx - 0.044 * fw, 0, 0.095 * s + 0.06 * fs], [fx + 0.044 * fw, 0, 0.095 * s + 0.06 * fs], [fx - 0.03 * fw, 0.036 * s, 0.09 * s + 0.07 * fs], [fx + 0.03 * fw, 0.036 * s, 0.09 * s + 0.07 * fs],
      [fx - 0.022 * fw, 0, 0.095 * s + 0.085 * fs], [fx + 0.022 * fw, 0, 0.095 * s + 0.085 * fs], [fx, 0.02 * s, 0.095 * s + 0.086 * fs],
    ] });
  }

  // ── head: a faceted hull, refined so the face can deform ──────────────
  const hb = headBaseY;
  const headPts: V3[] = headRings.flatMap(([y, rx, rf, rbk]) => ring(hb + y * headH, rx * hw, rf * hd, rbk * hd, HEAD_N));
  // a muzzle is its own shape joined to the skull (face appeal round): where the two meet, the forehead
  // steps down to the top of the muzzle (a dog's "stop"), which one convex hull can't make
  const muzzlePts: V3[] = [];
  if (mouthKind === 'muzzle') {
    // a snout: a blunt front where the mouth sits, rooted inside the skull below the eyes
    const my0 = headBaseY + mouthY01 * headH;
    for (const sx of [1, -1]) muzzlePts.push([sx * 0.42 * hw, my0 + 0.1 * headH, surfZ(0.3) - 0.22 * hd], [sx * 0.5 * hw, my0 - 0.1 * headH, surfZ(0.12) - 0.22 * hd]);
    for (const sx of [1, -1]) muzzlePts.push(
      [sx * 0.48 * hw, my0 + 0.13 * headH, surfZ(0.36) - 0.04 * headH], [sx * 0.62 * hw, my0 - 0.12 * headH, surfZ(0.12)],
      [sx * 0.36 * hw, my0 + 0.12 * headH, snoutZ - 0.035 * headH], [sx * 0.4 * hw, my0 - 0.1 * headH, snoutZ - 0.045 * headH],
      [sx * 0.3 * hw, my0 + 0.02 * headH, snoutZ], [sx * 0.22 * hw, my0 + 0.14 * headH, snoutZ - 0.01 * headH],
    );
    muzzlePts.push([0, my0 + 0.15 * headH, snoutZ - 0.004 * headH], [0, my0 - 0.11 * headH, snoutZ - 0.03 * headH], [0, my0 + 0.02 * headH, snoutZ + 0.004 * headH]);
  }
  // designed planes (craft pass): a brow ridge over the eyes, cheekbones, and a jaw that follows the
  // shape language (square corners, a pointed chin) — none of them on the mouth's centre line, so the
  // lips, teeth and speech shapes sit where they did
  const ridgeY01 = Math.min(0.8, eyeY01 + (eyeR * 1.55) / headH);
  const ridgeZ = (x: number) => surfAt(ridgeY01, x) + (shape === 'square' ? 0.05 : 0.035) * hd;
  if (mouthKind !== 'muzzle') {
    for (const sx of [1, -1]) {
      headPts.push([sx * 0.42 * hw, hb + ridgeY01 * headH, ridgeZ(0.42 * hw)], [sx * 0.66 * hw, hb + (ridgeY01 - 0.02) * headH, ridgeZ(0.66 * hw) - 0.01 * hd]);
      headPts.push([sx * 0.7 * hw, hb + 0.4 * headH, surfAt(0.4, 0.7 * hw) + (shape === 'triangle' ? 0.07 : 0.05) * hd]);
      if (shape === 'square') headPts.push([sx * 0.76 * hw, hb + 0.08 * headH, 0.32 * hd], [sx * 0.52 * hw, hb + 0.02 * headH, 0.5 * hd]);
      else if (shape === 'round') headPts.push([sx * 0.62 * hw, hb + 0.14 * headH, 0.36 * hd]);
    }
    headPts.push([0, hb + (ridgeY01 + 0.01) * headH, surfZ(ridgeY01) + 0.012 * hd]);
    if (shape === 'triangle') headPts.push([0, hb - 0.03 * headH, surfZ(0.0) * 0.98]);
  }
  const slotH = (mouthKind === 'cartoon' ? 0.024 : 0.018) * headH;
  const mouthW = (mouthKind === 'cartoon' ? 0.38 : mouthKind === 'grille' ? 0.42 : mouthKind === 'muzzle' ? 0.26 : 0.35) * hw;
  // ── mouth: chamber, teeth and tongue (all relative to the lip surface a = mouthZ, in head heights) ──
  const a = mouthZ, Hh = headH, my = mouthY;
  // the mouth chamber: a rounded pocket behind the lips (a squared-off superellipsoid sampled densely), so
  // an open mouth shows soft dark corners, never the edges and flat walls of a box
  const CH = { cy: my - 0.008 * Hh, cz: a - 0.124 * Hh, rx: 0.136 * Hh, ryUp: 0.068 * Hh, ryDn: 0.07 * Hh, rz: 0.096 * Hh, e: 2.6 };
  const chamberPts: V3[] = [];
  {
    const sp = (t: number) => Math.sign(t) * Math.abs(t) ** (2 / CH.e);
    const NU = 12, NV = 7;
    for (let j = 0; j <= NV; j++) {
      const v = -Math.PI / 2 + (Math.PI * j) / NV, cv = sp(Math.cos(v)), svv = sp(Math.sin(v));
      for (let i = 0; i < (j === 0 || j === NV ? 1 : NU); i++) {
        const u = (2 * Math.PI * i) / NU;
        chamberPts.push([CH.rx * cv * sp(Math.cos(u)), CH.cy + (svv > 0 ? CH.ryUp : CH.ryDn) * svv, CH.cz + CH.rz * cv * sp(Math.sin(u))]);
      }
    }
  }
  const arch = 3.5 / Hh / (PD.headW * PD.headW);           // the teeth follow a curve: z drops by arch·x² toward the sides (a narrow head curves sooner)
  const upperFront = a - 0.045 * Hh, lowerFront = upperFront - 0.014 * Hh, edgeY = my - 0.018 * Hh;
  const mouthPieces: Piece[] = [];
  // a row of teeth along the arch: the front teeth side by side with no visible gaps (a continuous white
  // row, not pegs), each with rounded corners at its biting edge and a little convexity at the front;
  // the gum runs along the roots with a scalloped line (a small point down between each pair of teeth)
  const toothRow = (part: string, gum: string, front: number, thick: number, root: number, edge: (x: number, i: number) => number, gumLine: number, widths: number[]) => {
    const dir = Math.sign(root - edge(0, 0));               // +1: the roots are above (upper teeth)
    const gap = 0.0005 * Hh, zf = (xx: number) => front - arch * xx * xx;
    for (const sx of [1, -1]) {
      let x = gap / 2;
      widths.forEach((w, i) => {
        const x0 = x, x1 = x + w * Hh * Math.min(1, PD.headW), xm = (x0 + x1) / 2;
        x = x1 + gap;
        const yE = edge(xm, i), rr = 0.3 * (x1 - x0), th = thick * (1 - 0.12 * i);
        const pts: V3[] = [];
        for (const xx of [x0, x1]) {
          pts.push([sx * xx, root, zf(xx)], [sx * xx, root, zf(xx) - th]);
          pts.push([sx * xx, yE + dir * rr, zf(xx) - 0.0006 * Hh], [sx * xx, yE + dir * rr, zf(xx) - th * 0.7]);
        }
        for (const xx of [x0 + rr * 0.7, x1 - rr * 0.7]) pts.push([sx * xx, yE, zf(xx) - 0.001 * Hh], [sx * xx, yE, zf(xx) - th * 0.45]);
        // the front of the tooth bulges a little (it catches the light like enamel)
        pts.push([sx * xm, (root + yE) / 2, zf(xm) + 0.0012 * Hh]);
        mouthPieces.push({ kind: 'hull', part, pts });
        // the gum over this tooth's root, its line rising to the middle of the tooth …
        if (!gum) return;
        const gz = (xx: number) => zf(xx) + 0.0012 * Hh, gb = (xx: number) => zf(xx) - th - 0.003 * Hh;
        const gtop = root + dir * 0.004 * Hh;
        const g: V3[] = [];
        for (const xx of [x0 - gap / 2, x1 + gap / 2]) g.push([sx * xx, gtop, gz(xx)], [sx * xx, gtop, gb(xx)], [sx * xx, gumLine, gz(xx)], [sx * xx, gumLine, gb(xx)]);
        mouthPieces.push({ kind: 'hull', part: gum, pts: g });
        // … and a papilla pointing down between this tooth and the next (the front teeth: where it shows)
        if (i > 2) return;
        const pw = 0.0035 * Hh, py = gumLine - dir * 0.0045 * Hh;
        mouthPieces.push({ kind: 'hull', part: gum, pts: [
          [sx * (x1 + gap / 2 - pw), gumLine, gz(x1)], [sx * (x1 + gap / 2 + pw), gumLine, gz(x1)], [sx * (x1 + gap / 2), py, gz(x1) - 0.0004 * Hh],
          [sx * (x1 + gap / 2 - pw), gumLine, gb(x1)], [sx * (x1 + gap / 2 + pw), gumLine, gb(x1)], [sx * (x1 + gap / 2), py, gb(x1)],
        ] });
      });
    }
  };
  // the tongue: a low, rounded wedge on the floor of the mouth, tip just behind the lower teeth
  const tipZ = lowerFront - 0.022 * Hh, backZ = a - 0.19 * Hh;
  if (mouthKind === 'human') {
    // upper: incisors, canines and premolars side by side; the biting edge follows a gentle smile curve
    // (the centrals a touch longer), so an open mouth shows one clean row
    const upW = [0.024, 0.0195, 0.0195, 0.0185, 0.018];
    toothRow('teethUpper', 'gumUpper', upperFront, 0.011 * Hh, my + 0.03 * Hh, (xx, i) => edgeY + (i === 0 ? 0 : 0.0012 * Hh) + 0.5 * (xx * xx) / Hh, my + 0.009 * Hh, upW);
    const loW = [0.0165, 0.0165, 0.0175, 0.0185, 0.0185];
    toothRow('teethLower', '', lowerFront, 0.0095 * Hh, my - 0.045 * Hh, (xx) => my + 0.006 * Hh - 0.35 * (xx * xx) / Hh, my - 0.019 * Hh, loW);
    // the tongue: a soft, rounded body (a hull of rings), tip rounded behind the lower teeth
    const tongue: V3[] = [];
    const tRing = (z: number, w: number, yTop: number, yBot: number, n = 9) => {
      for (let i = 0; i <= n; i++) {
        const t = (Math.PI * i) / n, c = Math.cos(t), sn = Math.sin(t);
        tongue.push([w * c, yBot + (yTop - yBot) * (0.25 + 0.75 * Math.sqrt(sn)), z]);
      }
    };
    tRing(tipZ + 0.002 * Hh, 0.016 * Hh, my - 0.031 * Hh, my - 0.04 * Hh, 7);
    tRing(tipZ - 0.01 * Hh, 0.036 * Hh, my - 0.029 * Hh, my - 0.046 * Hh);
    tRing(tipZ - 0.035 * Hh, 0.052 * Hh, my - 0.027 * Hh, my - 0.05 * Hh);
    tRing(backZ, 0.052 * Hh, my - 0.03 * Hh, my - 0.052 * Hh);
    mouthPieces.push({ kind: 'hull', part: 'tongue', pts: tongue });
  }
  // the opening between the lips: a lens (tapering to the corners), cut through into the chamber
  const lens: V3[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = -mouthW + (2 * mouthW * i) / 16, u = Math.abs(x) / mouthW;
    const h = (slotH / 2) * Math.max(0.18, Math.sqrt(Math.max(0, 1 - u ** 2.5)));
    for (const y of [mouthY - h, mouthY + h]) lens.push([x, y, mouthZ + 0.012 * headH], [x, y, mouthZ - 0.085 * headH]);
  }
  const cuts: CharSpec['cuts'] = [
    mouthKind === 'human' || mouthKind === 'muzzle'
      ? { kind: 'hull', part: 'mouthInner', pts: lens }
      : { kind: 'box', c: [0, mouthY, mouthZ - 0.018 * headH], size: [2 * mouthW, slotH, 0.06 * headH], part: 'mouthInner' },
    // the mouth itself: a chamber behind the lips (the slot opens into it), roomy enough for teeth and a tongue
    { kind: 'hull', part: 'mouthInner', pts: chamberPts },
    { kind: 'ball', c: [eyeX, eyeY, eyeZ], r: eyeR * LID.socket, sides: 32, part: 'eyeSocket' },
    { kind: 'ball', c: [-eyeX, eyeY, eyeZ], r: eyeR * LID.socket, sides: 32, part: 'eyeSocket' },
  ];
  if (mouthKind === 'cartoon') {
    // a cartoon mouth curves into a smile at rest (curveMouth): its opening is cut in slices across
    // the mouth, so the cut's edges have vertices all along and bend smoothly instead of kinking
    const K = 10, c0 = cuts[0] as Extract<CharSpec['cuts'][number], { kind: 'box' }>;
    cuts.splice(0, 1, ...Array.from({ length: K }, (_, i) => {
      const x0 = -mouthW + (2 * mouthW * i) / K - 0.002 * headH, x1 = -mouthW + (2 * mouthW * (i + 1)) / K + 0.002 * headH;
      const [cy, cz] = [c0.c[1], c0.c[2]], [hy, hz] = [c0.size[1] / 2, c0.size[2] / 2];
      const pts: V3[] = [];
      for (const x of [x0, x1]) for (const y of [cy - hy, cy + hy]) for (const z of [cz - hz, cz + hz]) pts.push([x, y, z]);
      return { kind: 'hull' as const, part: 'mouthInner', pts };
    }));
  }
  if (mouthKind === 'grille') {
    // a speaker grille: a shallow dark panel behind three bars
    cuts[0] = { kind: 'box', c: [0, mouthY, mouthZ - 0.02 * headH], size: [2.3 * mouthW, 0.1 * headH, 0.05 * headH], part: 'mouthInner' };
  }
  // nose, brows, lips, ears, hair
  const nb = surfZ(0.42);
  const noseTop = hb + 0.5 * headH;
  // soft forms (face appeal): a hull of balls is a rounded, smooth shape (the bridge, tip and wings of a
  // nose); `soft` rounds any hull by putting a small ball at each of its points, pulled in by the radius.
  // The toy style keeps its crisp planes.
  const toy = style === 'toy';
  const BALL = Array.from({ length: 48 }, (_, i) => {
    const k = i + 0.5, yy = 1 - (2 * k) / 48, rr = Math.sqrt(1 - yy * yy), t = Math.PI * (3 - Math.sqrt(5)) * k;
    return [rr * Math.cos(t), yy, rr * Math.sin(t)] as V3;
  });
  const blobs = (bs: Array<[V3, number]>): V3[] => bs.flatMap(([c, r]) => BALL.map((d) => add(c, mul(d, r))));
  const soft = (pts: V3[], rr: number): V3[] => {
    if (toy) return pts;
    const c = mul(pts.reduce((acc, q) => add(acc, q), [0, 0, 0] as V3), 1 / pts.length);
    return pts.flatMap((q) => { const d = subv(q, c), l = Math.hypot(...d), k = Math.max(0, l - rr) / (l || 1); return BALL.map((u) => add(add(c, mul(d, k)), mul(u, Math.min(rr, l)))); });
  };
  if (noseKind === 'human') {
    const hard: V3[] = [[0, noseTop, nb - 0.01 * headH], [0.06 * hw, hb + 0.49 * headH, nb - 0.02 * headH], [-0.06 * hw, hb + 0.49 * headH, nb - 0.02 * headH], [0, hb + 0.35 * headH, nb + 0.1 * headH], [0.07 * hw, hb + 0.34 * headH, nb + 0.075 * headH], [-0.07 * hw, hb + 0.34 * headH, nb + 0.075 * headH], [0.17 * hw, hb + 0.32 * headH, nb - 0.005 * headH], [-0.17 * hw, hb + 0.32 * headH, nb - 0.005 * headH], [0, hb + 0.31 * headH, nb + 0.05 * headH]];
    // a rounded nose: a narrow bridge running down into a soft ball of a tip, with two rounded wings
    pieces.push({ kind: 'hull', part: 'nose', pts: toy ? hard : blobs([
      [[0, noseTop - 0.01 * headH, nb - 0.03 * headH], 0.05 * hw], [[0, hb + 0.43 * headH, nb + 0.025 * headH], 0.055 * hw],
      [[0, hb + 0.355 * headH, nb + 0.07 * headH], 0.085 * hw], [[0.105 * hw, hb + 0.33 * headH, nb + 0.018 * headH], 0.065 * hw], [[-0.105 * hw, hb + 0.33 * headH, nb + 0.018 * headH], 0.065 * hw],
    ]) });
  } else if (noseKind === 'long') {
    // a long, pointed nose that juts out and down
    pieces.push({ kind: 'hull', part: 'nose', pts: soft([[0, noseTop + 0.02 * headH, nb - 0.02 * headH], [0.07 * hw, hb + 0.47 * headH, nb - 0.02 * headH], [-0.07 * hw, hb + 0.47 * headH, nb - 0.02 * headH], [0.12 * hw, hb + 0.34 * headH, nb], [-0.12 * hw, hb + 0.34 * headH, nb], [0, hb + 0.3 * headH, nb + 0.24 * headH], [0, hb + 0.34 * headH, nb + 0.22 * headH]], 0.035 * hw) });
  } else if (noseKind === 'button') {
    pieces.push({ kind: 'ball', c: [0, hb + 0.38 * headH, surfZ(0.38) + 0.01 * headH], r: 0.07 * hw, sides: toy ? Math.max(6, SIDES) : 16, part: 'nose' });
  } else if (noseKind === 'big') {
    // a bulbous nose: wide, round, low on the face
    pieces.push({ kind: 'hull', part: 'nose', pts: soft([[0, noseTop, nb - 0.015 * headH], [0.08 * hw, hb + 0.47 * headH, nb - 0.02 * headH], [-0.08 * hw, hb + 0.47 * headH, nb - 0.02 * headH]], 0.03 * hw) });
    pieces.push({ kind: 'ball', c: [0, hb + 0.35 * headH, nb + 0.09 * headH], r: 0.22 * hw, sides: toy ? Math.max(8, SIDES) : 20, part: 'nose' });
  } else if (mouthKind === 'muzzle') {
    // no separate nose, but the snout gets a nose pad at its tip
  }
  if (mouthKind === 'muzzle') {
    // the nose pad: a broad, dark, slightly upturned wedge on the tip of the snout
    const ny = mouthY + 0.13 * headH, nz = snoutZ + 0.005 * headH;
    pieces.push({ kind: 'hull', part: 'nose.pad', pts: soft([
      [-0.22 * hw, ny + 0.05 * headH, nz - 0.06 * headH], [0.22 * hw, ny + 0.05 * headH, nz - 0.06 * headH], [-0.26 * hw, ny - 0.02 * headH, nz - 0.03 * headH], [0.26 * hw, ny - 0.02 * headH, nz - 0.03 * headH],
      [-0.18 * hw, ny + 0.04 * headH, nz + 0.03 * headH], [0.18 * hw, ny + 0.04 * headH, nz + 0.03 * headH], [-0.14 * hw, ny - 0.05 * headH, nz + 0.01 * headH], [0.14 * hw, ny - 0.05 * headH, nz + 0.01 * headH],
      [0, ny - 0.07 * headH, nz - 0.02 * headH],
    ], 0.018 * headH) });
  }
  const browY = eyeY + eyeR * (eyeStyle === 'big' ? 1.4 : 1.6);
  const browZ = Math.max(surfAt(Math.min(0.75, eyeY01 + 0.12), 0.38 * hw) + 0.006 * headH, mouthKind === 'muzzle' ? -Infinity : ridgeZ(0.38 * hw) + 0.004 * headH);
  const brows: V3[] = [];
  const bushy = browStyle === 'bushy';
  const browSurf = (x: number) => (mouthKind === 'muzzle' ? surfAt(Math.min(0.75, eyeY01 + 0.12), x) : Math.max(surfAt(Math.min(0.75, eyeY01 + 0.12), x), ridgeZ(x)));
  for (const sx of [1, -1]) {
    const x0 = sx * 0.15 * hw, x1 = sx * (bushy ? 0.66 : 0.6) * hw;
    brows.push([(x0 + x1) / 2, browY, browZ]);
    if (browStyle !== 'none' && !toy) {
      // a shaped brow: a full head at the inner end, a gentle arch, a tail that thins and drops a little;
      // slices along it, each a rounded section lying on the brow ridge
      const t = bushy ? 2.3 : 1.35, f = bushy ? 1.9 : 1.2, K = 7;
      const section = (q: number): V3[] => {
        const x = x0 + (x1 - x0) * q;
        const th = 0.034 * headH * t * (0.42 + 0.58 * (1 - q ** 1.6)) * (q < 0.08 ? 0.82 + 2.2 * q : 1);
        const yc = browY + 0.012 * headH * t * (0.5 + 0.9 * Math.sin(Math.PI * Math.min(1, q * 1.15) ** 0.85)) - 0.012 * headH * q * q;
        const zs = browZ + browSurf(Math.abs(x)) - browSurf(0.38 * hw);   // follows the brow ridge round the head
        const zf = zs + 0.008 * headH * f * (1 - 0.6 * q), zb = zs - 0.016 * headH;
        const bulge = 0.006 * headH * f * (1 - 0.5 * q);
        return [
          [x, yc - th * 0.5, zb], [x, yc - th * 0.5, zf - bulge * 0.3], [x, yc - th * 0.18, zf + bulge * 0.4], [x, yc + th * 0.15, zf + bulge * 0.5],
          [x, yc + th * 0.45, zf], [x, yc + th * 0.5, zb],
        ];
      };
      for (let i = 0; i < K; i++) pieces.push({ kind: 'hull', part: sx > 0 ? 'brow.L' : 'brow.R', pts: [...section(i / K), ...section((i + 1) / K)] });
    } else if (browStyle !== 'none') {
      const t = bushy ? 2.3 : 1.35, f = bushy ? 1.9 : 1.2;
      pieces.push({ kind: 'hull', part: sx > 0 ? 'brow.L' : 'brow.R', pts: [
        [x0, browY - 0.008 * headH * t, browZ - 0.015 * headH], [x0, browY + 0.032 * headH * t, browZ - 0.015 * headH], [x0, browY - 0.008 * headH * t, browZ + 0.012 * headH * f], [x0, browY + 0.032 * headH * t, browZ + 0.008 * headH * f],
        [x1, browY - 0.01 * headH * t, browZ - 0.03 * headH], [x1, browY + 0.022 * headH * t, browZ - 0.03 * headH], [x1, browY - 0.01 * headH * t, browZ - 0.004 * headH * f], [x1, browY + 0.022 * headH * t, browZ - 0.008 * headH * f],
      ] });
    }
    if (earKind === 'human') {
      pieces.push({ kind: 'hull', part: sx > 0 ? 'ear.L' : 'ear.R', pts: [
        [sx * hw * 0.92, hb + 0.38 * headH, -0.02 * hd], [sx * hw * 0.92, hb + 0.62 * headH, -0.06 * hd], [sx * hw * 1.08, hb + 0.4 * headH, -0.08 * hd], [sx * hw * 1.1, hb + 0.6 * headH, -0.14 * hd], [sx * hw * 0.95, hb + 0.5 * headH, -0.22 * hd],
      ] });
    } else if (earKind === 'pointy') {
      // long pointed ears that sweep up and back
      pieces.push({ kind: 'hull', part: sx > 0 ? 'ear.L' : 'ear.R', pts: [
        [sx * hw * 0.9, hb + 0.38 * headH, -0.02 * hd], [sx * hw * 0.9, hb + 0.62 * headH, -0.1 * hd], [sx * hw * 1.06, hb + 0.4 * headH, -0.06 * hd],
        [sx * hw * 1.1, hb + 0.58 * headH, -0.16 * hd], [sx * hw * 1.62, hb + 0.86 * headH, -0.36 * hd], [sx * hw * 0.95, hb + 0.5 * headH, -0.24 * hd],
      ] });
    } else if (earKind === 'floppy') {
      // soft ears hanging from the top of the head down past the cheeks (a dog's, a hound's)
      const ey = hb + 0.86 * headH;
      pieces.push({ kind: 'hull', part: sx > 0 ? 'ear.L' : 'ear.R', pts: [
        [sx * hw * 0.62, ey, 0.05 * hd], [sx * hw * 0.62, ey, -0.32 * hd], [sx * hw * 0.98, ey - 0.06 * headH, 0.08 * hd], [sx * hw * 0.98, ey - 0.06 * headH, -0.34 * hd],
        [sx * hw * 1.2, ey - 0.5 * headH, 0.02 * hd], [sx * hw * 1.16, ey - 0.55 * headH, -0.28 * hd], [sx * hw * 1.08, ey - 0.62 * headH, -0.12 * hd],
        [sx * hw * 1.02, ey - 0.45 * headH, -0.1 * hd],
      ] });
    } else if (earKind === 'upright') {
      // tall triangular ears standing on top of the head (dogs, cats, foxes), a little cupped forward
      const ey = hb + 0.82 * headH;
      pieces.push({ kind: 'hull', part: sx > 0 ? 'ear.L' : 'ear.R', pts: [
        [sx * hw * 0.3, ey, 0.12 * hd], [sx * hw * 0.82, ey - 0.1 * headH, 0.04 * hd], [sx * hw * 0.3, ey, -0.22 * hd], [sx * hw * 0.82, ey - 0.1 * headH, -0.26 * hd],
        [sx * hw * 0.72, ey + 0.52 * headH, -0.12 * hd], [sx * hw * 0.6, ey + 0.2 * headH, 0.04 * hd],
      ] });
    }
  }
  if (mouthKind === 'beak') {
    // a beak: an upper bill on the head and a shorter lower bill on the jaw, a gap between them
    const up: V3[] = [], lo: V3[] = [];
    for (const sx of [1, -1]) {
      // a big, readable bill: wide at the face, a hooked tip well forward of it
      up.push([sx * 0.42 * hw, my + 0.006 * Hh, a - 0.06 * Hh], [sx * 0.3 * hw, my + 0.17 * Hh, a - 0.06 * Hh], [sx * 0.1 * hw, my + 0.006 * Hh, a + 0.34 * Hh]);
      lo.push([sx * 0.36 * hw, my - 0.006 * Hh, a - 0.06 * Hh], [sx * 0.24 * hw, my - 0.11 * Hh, a - 0.06 * Hh], [sx * 0.07 * hw, my - 0.008 * Hh, a + 0.24 * Hh]);
    }
    up.push([0, my + 0.2 * Hh, a - 0.03 * Hh], [0, my + 0.1 * Hh, a + 0.3 * Hh], [0, my - 0.02 * Hh, a + 0.46 * Hh]);
    lo.push([0, my - 0.12 * Hh, a - 0.04 * Hh], [0, my - 0.016 * Hh, a + 0.3 * Hh], [0, my - 0.055 * Hh, a + 0.18 * Hh]);
    pieces.push({ kind: 'hull', part: 'lipUpper', pts: up }, { kind: 'hull', part: 'lipLower', pts: lo });
  } else if (mouthKind === 'grille') {
    // three bars across the dark panel: the top one on the head, the bottom one on the jaw
    const bar = (part: string, y: number, w: number): Piece => ({ kind: 'hull', part, pts: [
      [-w, y - 0.009 * Hh, a - 0.03 * Hh], [w, y - 0.009 * Hh, a - 0.03 * Hh], [-w, y + 0.009 * Hh, a - 0.03 * Hh], [w, y + 0.009 * Hh, a - 0.03 * Hh],
      [-w, y - 0.009 * Hh, a - 0.004 * Hh], [w, y - 0.009 * Hh, a - 0.004 * Hh], [-w, y + 0.009 * Hh, a - 0.004 * Hh], [w, y + 0.009 * Hh, a - 0.004 * Hh],
    ] });
    pieces.push(bar('lipUpper', my + 0.03 * Hh, mouthW * 1.05), bar('lipMid', my, mouthW * 1.05), bar('lipLower', my - 0.03 * Hh, mouthW * 1.05));
  } else {
    const thin = mouthKind === 'cartoon' ? 0.6 : 1;
    if (mouthKind === 'cartoon') for (const [name, dy] of [['lipUpper', 1], ['lipLower', -1]] as const) {
      // cartoon lips: slices along the mouth (a soft rim, thinning to the corners), so the resting
      // smile bends them into a smooth curve; the lower lip is a little fuller
      const K = 10, full = dy < 0 ? 1.1 : 0.85;
      const y = mouthY + dy * (slotH / 2 + 0.008 * headH * thin), z = mouthZ - 0.006 * headH, r = 0.012 * headH * thin * full;
      const section = (x: number): V3[] => {
        const f = Math.sqrt(Math.max(0.08, 1 - (Math.abs(x) / (mouthW * 1.04)) ** 4));
        const y0 = mouthY + dy * slotH * 0.12;
        const at = (yy: number, zz: number): V3 => [x, y0 + (yy - y0) * f, z + (zz - z) * f];
        return [at(y0, z - r), at(y0, z - r * 0.3), at(y, z + r * 0.7), at(y + dy * r * 0.5, z + r * 0.9), at(y + dy * r * 0.85, z + r * 0.25), at(y + dy * r * 0.9, z - r * 0.6)];
      };
      for (let i = 0; i < K; i++) {
        const xa = -mouthW * 1.02 + (2.04 * mouthW * i) / K, xb = -mouthW * 1.02 + (2.04 * mouthW * (i + 1)) / K;
        pieces.push({ kind: 'hull', part: name, pts: [...section(xa), ...section(xb)] });
      }
    }
    else for (const [name, dy] of [['lipUpper', 1], ['lipLower', -1]] as const) {
      // lips with volume: slices along the mouth, each a rounded section (the lip rolls out from the
      // opening, swells and turns back into the skin); they thin toward the corners and tuck back into
      // the face there, and the upper lip has a soft bow. Vertices all along the inner edge let the
      // opening curve (O, OO) instead of staying a straight slot.
      const lt = mouthKind === 'muzzle' ? 0.7 : 1, full = dy < 0 ? 1.12 : 0.92;
      const yOut = mouthY + dy * (slotH / 2 + 0.009 * headH * lt * full), z = mouthZ - 0.006 * headH, r = 0.013 * headH * lt * full;
      // the section: (how far out from the opening 0..1, how far forward −1..1 × r)
      const prof: Array<[number, number]> = [[0, -1], [0.04, 0], [0.2, 0.6], [0.45, 0.95], [0.7, 0.85], [0.9, 0.45], [1, -0.2], [0.85, -1]];
      const K = 12;
      const section = (x: number): V3[] => {
        const u = Math.min(1, Math.abs(x) / (mouthW * 1.03));
        const f = Math.sqrt(Math.max(0.05, 1 - u ** 3)), tuck = 0.012 * headH * u ** 2.2;
        const bow = dy > 0 && mouthKind === 'human' ? 0.0035 * headH * Math.exp(-(((u - 0.3) / 0.16) ** 2)) - 0.002 * headH * Math.exp(-((u / 0.09) ** 2)) : 0;
        const y0 = mouthY + dy * slotH * 0.12, zc = z - r * 0.2, D = Math.abs(yOut - y0) + 0.9 * r;
        return prof.map(([t, pz]) => {
          // the outer half carries the bow
          const yy = y0 + dy * (t * D + bow * smooth(0.5, 0.95, t));
          const zz = z + pz * r;
          return [x, y0 + (yy - y0) * f, zc + (zz - zc) * f - tuck] as V3;
        });
      };
      for (let i = 0; i < K; i++) {
        const xa = -mouthW * 1.03 + (2.06 * mouthW * i) / K, xb = -mouthW * 1.03 + (2.06 * mouthW * (i + 1)) / K;
        pieces.push({ kind: 'hull', part: name, pts: [...section(xa), ...section(xb)] });
      }
    }
  }
  const hc: V3 = [0, hb + 0.55 * headH, 0];
  if (p.hair === 'short') {
    const top = headPts.filter((q) => q[1] >= hb + 0.62 * headH && !(q[2] > 0.5 * hd && q[1] < hb + 0.8 * headH));
    pieces.push({ kind: 'hull', part: 'hair', pts: top.map((q) => add(hc, mul(subv(q, hc), 1.07))).concat([[0, hb + 0.66 * headH, -hd * 1.06], [hw * 0.9, hb + 0.5 * headH, -hd * 0.6], [-hw * 0.9, hb + 0.5 * headH, -hd * 0.6]]) });
  } else if (p.hair === 'tuft') {
    // a crest of three spikes on the crown, swept back
    const crown = hb + 0.92 * headH;
    [[0, 0.32, 0.05], [0.22, 0.24, -0.1], [-0.22, 0.24, -0.1], [0, 0.26, -0.32]].forEach(([x, hgt, z]) => {
      const bx = x * hw, bz = z * hd;
      pieces.push({ kind: 'hull', part: 'hair', pts: [
        [bx - 0.16 * hw, crown - 0.06 * headH, bz + 0.1 * hd], [bx + 0.16 * hw, crown - 0.06 * headH, bz + 0.1 * hd], [bx, crown - 0.06 * headH, bz - 0.22 * hd],
        [bx * 1.3, crown + hgt * headH, bz - 0.25 * hd],
      ] });
    });
  } else if (p.hair === 'bun') {
    const top = headPts.filter((q) => q[1] >= hb + 0.66 * headH && !(q[2] > 0.45 * hd && q[1] < hb + 0.85 * headH));
    pieces.push({ kind: 'hull', part: 'hair', pts: top.map((q) => add(hc, mul(subv(q, hc), 1.06))) });
    pieces.push({ kind: 'ball', c: [0, hb + 0.92 * headH, -0.78 * hd], r: 0.34 * hw, sides: Math.max(8, SIDES), part: 'hair' });
  }
  // eyeballs: white, iris, pupil; separate from the head so they can turn
  const eyes: Piece[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const c = B[`${side}Eye`].head;
    // iris and pupil: thin caps just proud of the eyeball, cut by planes (clean round edges; a union
    // of offset low-poly spheres gives star-shaped ones). Iris ≈ 36° from the axis, pupil ≈ 16°;
    // only the cap is kept, so the finer tessellation costs a few dozen triangles.
    // dot eyes are almost all pupil (a bead); big eyes have a large iris and a bright catch-light
    const irisDeg = eyeStyle === 'dot' ? 70 : eyeStyle === 'big' ? 44 : 36, pupilDeg = eyeStyle === 'dot' ? 64 : eyeStyle === 'big' ? 22 : 16;
    eyes.push({ kind: 'ball', c, r: eyeR, sides: 24, part: `${side}Eye` });
    eyes.push({ kind: 'ball', c, r: eyeR * 1.01, sides: 48, cap: Math.cos((irisDeg * Math.PI) / 180), part: `${side}Eye.iris` });
    eyes.push({ kind: 'ball', c, r: eyeR * 1.02, sides: pupilDeg > 30 ? 48 : 72, cap: Math.cos((pupilDeg * Math.PI) / 180), part: `${side}Eye.pupil` });
    // a catch-light: a small bright bead up and to the outer side of the pupil (eyes read as alive)
    // (face appeal round: big enough to read at cutscene distance, plus a small second one low on the other side)
    // (both are thin caps on the eyeball's own sphere, so they never stand out of it: a closing lid
    // slides over them instead of bumping over a bead)
    const gd = norm([(side === 'Left' ? 1 : -1) * 0.26, 0.3, 0.9]);
    eyes.push({ kind: 'ball', c, r: eyeR * 1.028, sides: 96, cap: Math.cos(((eyeStyle === 'dot' ? 15 : 13.5) * Math.PI) / 180), axis: gd, part: `${side}Eye.glint` });
    const gd2 = norm([(side === 'Left' ? -1 : 1) * 0.2, -0.24, 0.95]);
    eyes.push({ kind: 'ball', c, r: eyeR * 1.028, sides: 96, cap: Math.cos((6 * Math.PI) / 180), axis: gd2, part: `${side}Eye.glint` });
  }
  // eyelids: thin shells in the gap between eyeball and socket, always outside the eyeball (and its iris,
  // pupil and catch-lights, which stay within 1.03 r); at rest the upper edge sits just under the
  // socket's upper rim (a calm, slightly hooded eye) and a blink turns that shell down over the eyeball.
  // The lower lid is a second shell just outside the upper one, under the iris; the upper lid closes
  // behind it, so the two never cut each other.
  const rimTop = (Math.atan2(Math.sqrt(1.13 ** 2 - 0.68 ** 2), 0.68) * 180) / Math.PI;   // (the lid's resting edge keeps its old angle)
  const lids = (['Left', 'Right'] as const).map((side) => ({
    c: B[`${side}Eye`].head, rIn: eyeR * LID.upIn, rOut: eyeR * LID.upOut, edgeDeg: rimTop - 18, closeDeg: rimTop - 18 + rimTop + 4, part: `lid.${side[0]}`, bone: `${side}UpperLid`,
    lower: { rIn: eyeR * LID.lowIn, rOut: eyeR * LID.lowOut, edgeDeg: eyeStyle === 'big' ? -46 : -40, part: `lidLow.${side[0]}` },
  }));
  const palm = Object.fromEntries((['Left', 'Right'] as const).map((side) => [side, { c: [B[`${side}Hand`].head[0] + (side === 'Left' ? 1 : -1) * palmLen * 0.5, B[`${side}Hand`].head[1], 0] as V3, len: palmLen, width: palmW, thick: palmT }])) as CharSpec['palm'];
  // add-ons: a tail from the base of the back, wings from between the shoulder blades
  const addOnZ = -0.11 * s * T[3] * (0.9 + 0.3 * b);
  if (p.tail) addTail(bones, pieces, [0, B.Hips.head[1] - 0.02 * s, addOnZ * 0.9], [0, -0.35, -1], 0.5 * H * (p.tailLength ?? 1), 0.035 * s * L, SIDES);
  if (p.wings) addWings(bones, pieces, [0, B.UpperChest.head[1], addOnZ * 1.05], 0.42 * H, 0.17 * H, 'UpperChest');
  return {
    params: p, s, bones, pieces, head: { pts: headPts, ...(muzzlePts.length ? { extra: [muzzlePts] } : {}), refine: 0.012 * s * Math.sqrt(Math.max(1, headH / (0.165 * H * 1.1))), part: 'Head' }, cuts, mouth: mouthPieces, eyes, lids, palm,
    face: {
      headBase: [0, hb, 0], headH, hw, hd,
      mouth: [0, mouthY, mouthZ], mouthW, slotH, jawPivot,
      teeth: { upperFront, lowerFront, edgeY, arch }, tongue: { tipZ, backZ },
      eyes: [{ c: B.LeftEye.head, r: eyeR, side: 'Left' }, { c: B.RightEye.head, r: eyeR, side: 'Right' }],
      brows, nose: [0, hb + 0.35 * headH, nb + 0.1 * headH],
      cheeks: [[0.55 * hw, hb + 0.35 * headH, surfAt(0.35, 0.55 * hw)], [-0.55 * hw, hb + 0.35 * headH, surfAt(0.35, 0.55 * hw)]],
      kind: mouthKind,
    },
    plan, ...(PD.walk ? { walk: PD.walk } : {}),
  };
}

/** Eyelid shell radii (× the eyeball radius): the eyeball and everything on it stays within 1.03; the
 *  upper lid turns in [upIn, upOut], the lower lid sits in [lowIn, lowOut], the socket is cut at 1.13. */
export const LID = { upIn: 1.052, upOut: 1.074, lowIn: 1.106, lowOut: 1.121, socket: 1.136, eyeMax: 1.03 } as const;

// ── face shape keys (Decision 20 A) ─────────────────────────────────────
export const VISEMES = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'ih', 'oh', 'ou'] as const;
export const EXPRESSIONS = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'cheekSquintLeft', 'cheekSquintRight',
  'noseSneerLeft', 'noseSneerRight', 'mouthPucker', 'mouthClose', 'jawOpen',
] as const;
export const SHAPE_KEYS: readonly string[] = [...VISEMES, ...EXPRESSIONS];

/** Each speech shape as a mix of mouth primitives: jaw drop, wide, round (pucker), press (close), tuck (F/V). */
export const VISEME_MIX: Record<string, Partial<Record<'jaw' | 'wide' | 'round' | 'press' | 'tuck' | 'upper' | 'tongueUp' | 'tongueOut', number>>> = {
  sil: { press: 0.8 }, PP: { press: 1, round: 0.12 }, FF: { jaw: 0.12, tuck: 1, upper: 1.1 }, TH: { jaw: 0.22, wide: 0.15, upper: 0.3, tongueOut: 1 },
  DD: { jaw: 0.28, wide: 0.35, upper: 0.15, tongueUp: 0.8 }, kk: { jaw: 0.38, wide: 0.25, upper: 0.1 }, CH: { jaw: 0.2, round: 0.7, upper: 0.4 }, SS: { jaw: 0.08, wide: 0.6, upper: 0.4 },
  nn: { jaw: 0.2, wide: 0.25, tongueUp: 1 }, RR: { jaw: 0.22, round: 0.6 }, aa: { jaw: 1, wide: 0.2, upper: 0.3 }, E: { jaw: 0.5, wide: 0.65, upper: 0.35 },
  ih: { jaw: 0.28, wide: 0.6, upper: 0.3 }, oh: { jaw: 0.6, round: 0.95 }, ou: { jaw: 0.22, round: 1.3 },
};

/** How a mouth part says a speech shape. Lips use the full mix; a beak can only open and snap shut (it
 *  opens wider for vowels, a little for consonants, closes on M/B/P); a speaker grille opens and widens. */
export function visemeMix(kind: string | undefined, v: string): Partial<Record<string, number>> {
  const m = VISEME_MIX[v];
  if (kind === 'beak') return { jaw: m.press ? 0 : Math.min(1.2, (m.jaw ?? 0) * 1.25 + (m.round ?? 0) * 0.18 + (m.wide ?? 0) * 0.1),   // a pressed beak is shut, whatever the lips would do
    ...(m.press ? { press: m.press } : {}) };
  if (kind === 'grille') return { jaw: (m.jaw ?? 0) * 1.1 + (m.round ?? 0) * 0.15, wide: (m.wide ?? 0) * 1.2 - (m.round ?? 0) * 0.6, ...(m.press ? { press: m.press } : {}) };
  return m;
}

/** Parts that belong to the face (deformed by shape keys, weighted to Head/Jaw). */
export const isFacePart = (part: string) => /^(Head|mouthInner|eyeSocket|nose|brow\.|lip|lid\.|lidLow\.|ear\.|hair|teeth|gum|tongue)/.test(part);
/** Teeth, gums and tongue: rigid shells inside the mouth (only the jaw and the tongue's own shapes move them). */
export const isMouthPart = (part: string) => part === 'teethUpper' || part === 'teethLower' || part === 'gumUpper' || part === 'gumLower' || part === 'tongue';
/** Eyelids: rigid shells around the eyeball (moved only by turning about the eye centre). */
export const isLidPart = (part: string) => part.startsWith('lid.') || part.startsWith('lidLow.');
/** Parts carried by the jaw outright. */
const onJaw = (part: string) => part === 'teethLower' || part === 'gumLower' || part === 'tongue';
const boneOfPart = (part: string) => part.split('.')[0];

export interface SparseDelta { idx: Uint32Array; d: Float32Array }

/** Shape-key displacement fields over the face, in object space (rest). */
export function faceShapes(spec: CharSpec, pos: Float32Array, vertPart: string[]): Record<string, SparseDelta> {
  const F = spec.face, n = pos.length / 3, s = spec.s;
  const face: number[] = [];
  for (let v = 0; v < n; v++) if (isFacePart(vertPart[v])) face.push(v);
  const P = (v: number): V3 => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
  const lipPart = (v: number) => vertPart[v] === 'lipUpper' || vertPart[v] === 'lipLower' || vertPart[v] === 'mouthInner';
  // primitive fields: displacement for weight 1
  // the skin fields leave the teeth and tongue alone (rigid shells); only `inside` fields move them
  // eyelids are rigid shells too: no skin field moves them (it would push them into the eyeball); only
  // `lidTurn` below turns them, about the eye centre
  const prim = (fn: (p: V3, v: number) => V3 | null, inside = false) => {
    const d = new Float32Array(n * 3);
    for (const v of face) { if ((!inside && isMouthPart(vertPart[v])) || isLidPart(vertPart[v])) continue; const r = fn(P(v), v); if (r) d.set(r, v * 3); }
    return d;
  };
  // a lid turned about its eye's centre (left-right axis), as a shape key: + closes the upper lid / lifts
  // the lower one. A shape key blends linearly, so part-way the shell comes in by r·(1 − cos(θ/2)): the
  // angles stay small enough that it still clears the eyeball (see LID)
  const lidTurn = (side: 'Left' | 'Right', which: 'lid' | 'lidLow', deg: number) => {
    const d = new Float32Array(n * 3);
    const e = F.eyes.find((x) => x.side === side)!, part = `${which}.${side[0]}`;
    const q = qAxisAngle([1, 0, 0], which === 'lid' ? deg : -deg);
    for (const v of face) {
      if (vertPart[v] !== part) continue;
      const rel = subv(P(v), e.c);
      d.set(subv(qRot(q, rel), rel), v * 3);
    }
    return d;
  };
  const addInto = (dst: Float32Array, src: Float32Array, k = 1) => { for (let i = 0; i < dst.length; i++) dst[i] += src[i] * k; return dst; };
  const m = F.mouth, mw = F.mouthW, H = F.headH;
  const frontness = (p: V3) => smooth(-0.15 * F.hd, 0.35 * F.hd, p[2]);
  const mouthBand = (p: V3, rx: number, ry: number) => {
    const x = (p[0] - m[0]) / rx, y = (p[1] - m[1]) / ry;
    return Math.exp(-(x * x + y * y)) * frontness(p);
  };
  const jawDeg = 20;
  const jaw = prim((p, v) => {
    // the lower face rotates about the hinge: below the mouth line, fading up the cheeks
    const below = smooth(m[1] + F.slotH * 0.25, m[1] - F.slotH * 0.6, p[1]);
    const lower = vertPart[v] === 'lipLower' ? 1 : vertPart[v] === 'lipUpper' ? 0 : below;
    const sideFade = 1 - smooth(0.75 * F.hw, 1.05 * F.hw, Math.abs(p[0]));
    // an open mouth is an oval: the lips' corners drop less than their middles
    const corner = /^lip|^mouthInner/.test(vertPart[v]) ? 1 - 0.45 * smooth(0.3 * mw, 1.05 * mw, Math.abs(p[0] - m[0])) * Math.exp(-(((p[1] - m[1]) / (0.05 * H)) ** 2)) : 1;
    const w = onJaw(vertPart[v]) ? 1 : vertPart[v] === 'teethUpper' || vertPart[v] === 'gumUpper' ? 0 : lower * sideFade * corner * smooth(-0.6 * F.hd, -0.1 * F.hd, p[2]);
    if (w <= 0) return null;
    const rel = subv(p, F.jawPivot);
    const r = qRot(qAxisAngle([1, 0, 0], jawDeg), rel);
    return mul(subv(add(r, F.jawPivot), p), w);
  }, true);
  // the tongue: 1 at the tip, 0 at the root
  const along = (p: V3) => clamp((p[2] - F.tongue.backZ) / (F.tongue.tipZ - F.tongue.backZ));
  const tongueUp = prim((p, v) => {
    // L, T, D, N: the tip rises to just behind the upper teeth
    if (vertPart[v] !== 'tongue') return null;
    const u = along(p) ** 1.5;
    return [0, 0.042 * H * u, 0.006 * H * u];
  }, true);
  const tongueOut = prim((p, v) => {
    // TH: the tip comes forward between the teeth (still behind the lips)
    if (vertPart[v] !== 'tongue') return null;
    const u = along(p) ** 2;
    return [-p[0] * 0.2 * u, 0.05 * H * u, 0.056 * H * u];
  }, true);
  const wide = prim((p) => {
    const w = mouthBand(p, mw * 1.25, 0.06 * H);
    return w ? [(p[0] - m[0]) * 0.32 * w, 0, -Math.abs(p[0] - m[0]) / mw * 0.006 * H * w] : null;
  });
  const round = prim((p, v) => {
    // O / OO: the corners pull in and the lips push forward into a funnel (the deep mouth walls stay put, clear of the teeth)
    const w = mouthBand(p, mw * 1.3, 0.07 * H);
    if (!w) return null;
    const dx = p[0] - m[0], dy = p[1] - m[1];
    const lip = vertPart[v] === 'lipUpper' || vertPart[v] === 'lipLower' ? 1 : 0;
    // the lips' middles part while their corners pinch together: a round opening, not a slot
    const mid = 1 - clamp(Math.abs(dx) / (mw * 0.75)) ** 2;
    const part = lip ? Math.sign(dy) * 0.012 * H * (mid - 0.35) : -dy * 0.2;
    return [-dx * 0.55 * w, part * w, (0.042 + 0.012 * lip) * H * w * (1 - clamp(Math.abs(dx) / (mw * 1.4)))];
  });
  const press = prim((p, v) => {
    // lips close over the slot: both lips move to the mouth line
    const w = mouthBand(p, mw * 1.2, 0.035 * H) * (lipPart(v) || Math.abs(p[1] - m[1]) < 0.05 * H ? 1 : 0);
    if (!w) return null;
    const dy = p[1] - m[1];
    const close = Math.abs(dy) < F.slotH * 2.2 ? -Math.sign(dy) * Math.min(Math.abs(dy), F.slotH * 0.55) : 0;
    return [0, close * w, 0.002 * H * w];
  });
  const tuck = prim((p, v) => {
    // F/V: the lower lip rises and tucks under the upper teeth line
    const below = p[1] < m[1] ? 1 : 0;
    const w = mouthBand(p, mw * 1.1, 0.04 * H) * below * (vertPart[v] === 'lipUpper' ? 0 : 1);
    // the lower lip itself rolls in (back and up) so its top sits under the upper teeth
    const lip = vertPart[v] === 'lipLower' ? 1 : 0;
    return w ? [0, F.slotH * (0.25 + 0.15 * lip) * w, -(0.012 + 0.024 * lip) * H * w] : null;
  });
  const upper = prim((p, v) => {
    const above = p[1] > m[1] ? 1 : 0;
    const w = mouthBand(p, mw * 1.1, 0.04 * H) * above * (vertPart[v] === 'lipLower' ? 0 : 1);
    return w ? [0, 0.012 * H * w, 0.002 * H * w] : null;
  });
  const prims: Record<string, Float32Array> = { jaw, wide, round, press, tuck, upper, tongueUp, tongueOut };
  const mix = (weights: Partial<Record<string, number>>) => {
    const d = new Float32Array(n * 3);
    for (const [k, w] of Object.entries(weights)) { const src = prims[k]; for (let i = 0; i < d.length; i++) d[i] += src[i] * (w ?? 0); }
    return d;
  };
  const out: Record<string, Float32Array> = {};
  for (const vname of VISEMES) out[vname] = mix(visemeMix(F.kind, vname));
  // expressions
  const sideField = (sx: number, fn: (p: V3, v: number) => V3 | null) => prim((p, v) => (Math.sign(p[0] || 1e-9) === sx || Math.abs(p[0]) < 0.004 ? fn(p, v) : null));
  for (const e of F.eyes) {
    // the eyelid itself is a bone (rotations stay outside the eyeball; see localRotations): this shape
    // key moves the skin just above the eye with it
    out[`eyeBlink${e.side}`] = prim((p, v) => {
      const rel = subv(p, e.c);
      if (vertPart[v] !== 'Head' && vertPart[v] !== 'eyeSocket') return null;
      const planar = Math.hypot(rel[0], rel[1]);
      const w = (1 - smooth(1.1 * e.r, 2.0 * e.r, planar)) * smooth(0.2 * e.r, 0.9 * e.r, rel[1]) * (rel[2] > -0.3 * e.r ? 1 : 0);
      return w > 0.01 ? [0, -0.25 * e.r * w, 0.04 * e.r * w] : null;
    });
  }
  const browField = (sx: number, dyIn: number, dyOut: number, dxIn: number) => sideField(sx, (p, v) => {
    const b = F.brows[sx > 0 ? 0 : 1];
    const rx = 0.55 * F.hw, ry = 0.09 * H;
    const x = (p[0] - b[0]) / rx, y = (p[1] - b[1]) / ry;
    let w = Math.exp(-(x * x + y * y)) * frontness(p);
    if (vertPart[v].startsWith('brow')) w = 1;
    if (vertPart[v] === 'hair' || vertPart[v].startsWith('Left') || vertPart[v].startsWith('Right')) return null;
    if (w < 0.01) return null;
    const t = clamp((Math.abs(p[0]) - 0.15 * F.hw) / (0.45 * F.hw)); // 0 inner … 1 outer
    return [-sx * dxIn * (1 - t) * w, (dyIn * (1 - t) + dyOut * t) * w, 0];
  });
  const bL = browField(1, 0.028 * H, 0.004 * H, 0), bR = browField(-1, 0.028 * H, 0.004 * H, 0);
  out.browInnerUp = new Float32Array(n * 3).map((_, i) => bL[i] + bR[i]);
  out.browDownLeft = browField(1, -0.022 * H, -0.008 * H, 0.012 * H);
  out.browDownRight = browField(-1, -0.022 * H, -0.008 * H, 0.012 * H);
  out.browOuterUpLeft = browField(1, 0.004 * H, 0.026 * H, 0);
  out.browOuterUpRight = browField(-1, 0.004 * H, 0.026 * H, 0);
  const corner = (sx: number, dy: number, dxOut: number, dz: number) => sideField(sx, (p) => {
    const c: V3 = [m[0] + sx * mw, m[1], m[2]];
    const x = (p[0] - c[0]) / (mw * 0.85), y = (p[1] - c[1]) / (0.07 * H);
    const w = Math.exp(-(x * x + y * y)) * frontness(p);
    return w > 0.01 ? [sx * dxOut * w, dy * w, dz * w] : null;
  });
  out.mouthSmileLeft = corner(1, 0.045 * H, 0.016 * H, -0.008 * H);
  out.mouthSmileRight = corner(-1, 0.045 * H, 0.016 * H, -0.008 * H);
  out.mouthFrownLeft = corner(1, -0.036 * H, 0.004 * H, 0);
  out.mouthFrownRight = corner(-1, -0.036 * H, 0.004 * H, 0);
  const cheek = (sx: number) => sideField(sx, (p, v) => {
    const c = F.cheeks[sx > 0 ? 0 : 1];
    if (vertPart[v] === 'hair') return null;
    const x = (p[0] - c[0]) / (0.35 * F.hw), y = (p[1] - c[1]) / (0.11 * H);
    const w = Math.exp(-(x * x + y * y)) * frontness(p);
    return w > 0.01 ? [0, 0.016 * H * w, 0.003 * H * w] : null;
  });
  out.cheekSquintLeft = cheek(1); out.cheekSquintRight = cheek(-1);
  const sneer = (sx: number) => sideField(sx, (p) => {
    const c: V3 = [sx * 0.13 * F.hw, F.nose[1] + 0.02 * H, F.nose[2] - 0.03 * H];
    const x = (p[0] - c[0]) / (0.16 * F.hw), y = (p[1] - c[1]) / (0.07 * H);
    const w = Math.exp(-(x * x + y * y)) * frontness(p);
    return w > 0.01 ? [0, 0.012 * H * w, 0] : null;
  });
  out.noseSneerLeft = sneer(1); out.noseSneerRight = sneer(-1);
  out.mouthPucker = F.kind === 'beak' || F.kind === 'grille' ? mix({ jaw: 0.12, press: 0.4 }) : mix({ round: 1.15 });
  out.mouthClose = mix({ press: 1 });
  out.jawOpen = mix({ jaw: 1 });
  // the lids follow the brows and cheeks (a squint narrows the eye from both lids; a lifted brow opens it)
  for (const [side, sfx] of [['Left', 'Left'], ['Right', 'Right']] as const) {
    if (!F.eyes.some((e) => e.side === side)) continue;
    addInto(out[`browDown${sfx}`], lidTurn(side, 'lid', 6));
    addInto(out[`cheekSquint${sfx}`], lidTurn(side, 'lid', 2));
    addInto(out[`cheekSquint${sfx}`], lidTurn(side, 'lidLow', 11));
    addInto(out[`browOuterUp${sfx}`], lidTurn(side, 'lid', -3));
    addInto(out.browInnerUp, lidTurn(side, 'lid', -1.5));
  }
  // skin near an eye never moves toward the eye's centre: it slides over it (a brow pressing down rolls
  // over the lid) instead of cutting into the lids or the eyeball. Each shape keeps only the part of its
  // motion that is not inward, so any mix of shapes keeps the skin at least as far out as at rest
  for (const e of F.eyes) {
    for (const k of Object.keys(out)) {
      const d = out[k];
      for (const v of face) {
        const part = vertPart[v];
        if (isLidPart(part) || isMouthPart(part)) continue;
        if (!d[v * 3] && !d[v * 3 + 1] && !d[v * 3 + 2]) continue;
        const rel = subv(P(v), e.c), r0 = Math.hypot(...rel);
        if (r0 > 2 * e.r) continue;
        const dv: V3 = [d[v * 3], d[v * 3 + 1], d[v * 3 + 2]], u = mul(rel, 1 / (r0 || 1)), inward = dot(dv, u);
        if (inward < 0) d.set(subv(dv, mul(u, inward)), v * 3);
      }
    }
  }
  // sparse storage (only vertices that move)
  const sparse: Record<string, SparseDelta> = {};
  for (const k of SHAPE_KEYS) {
    const d = out[k];
    const idx: number[] = [];
    for (let v = 0; v < n; v++) if (Math.abs(d[v * 3]) + Math.abs(d[v * 3 + 1]) + Math.abs(d[v * 3 + 2]) > 1e-7) idx.push(v);
    const dd = new Float32Array(idx.length * 3);
    idx.forEach((v, i) => dd.set(d.subarray(v * 3, v * 3 + 3), i * 3));
    sparse[k] = { idx: Uint32Array.from(idx), d: dd };
  }
  void s;
  return sparse;
}

// ── skin weights ─────────────────────────────────────────────────────────
function segDist(p: V3, a: V3, b: V3): number {
  const ab = subv(b, a), ap = subv(p, a);
  const t = clamp(dot(ap, ab) / (dot(ab, ab) || 1));
  return Math.hypot(...subv(p, add(a, mul(ab, t))));
}

/** Which bones may influence a vertex of a given part (keeps fingers from bleeding into each other). */
function allowedBones(part: string, bones: BoneDef[], byName: Map<string, number>, p: V3, spec: CharSpec): number[] {
  const id = (n: string) => byName.get(n)!;
  const kids = (n: string) => bones.filter((b) => b.parent === n).map((b) => b.name);
  const base = boneOfPart(part);
  if (base === 'LeftEye' || base === 'RightEye') return [id(base)];
  if (byName.has(base) && base !== 'Head' && base !== 'Neck' && base !== 'Root') {
    const b = bones[id(base)];
    const set = new Set([base]);
    if (b.parent && b.parent !== 'Root') set.add(b.parent);
    for (const k of kids(base)) if (!/Eye|Jaw/.test(k) && !(spec.quad && /Thumb|Index|Middle|Ring|Little/.test(k))) set.add(k);
    if (/Hand$/.test(base) && !spec.quad) for (const k of kids(base)) set.add(k);   // a paw's toe bones carry nothing
    if (/UpperLeg$/.test(base)) set.add('Hips');
    return [...set].map(id);
  }
  if (part === 'apron' && byName.has('ApronUpper')) return ['Hips', 'Spine', 'Chest', 'UpperChest', 'ApronUpper', 'ApronLower'].map(id);
  if (part === 'torso') return ['Hips', 'Spine', 'Chest', 'UpperChest', 'LeftShoulder', 'RightShoulder', 'LeftUpperArm', 'RightUpperArm', 'Neck', 'LeftUpperLeg', 'RightUpperLeg'].map(id);
  if (base === 'Neck') return ['Neck', 'Head', 'UpperChest'].map(id);
  if (isFacePart(part)) return ['Head'].map(id);
  // anything else (clothes, hair, hats, an apron added with ops): the trunk, head and legs — never
  // the arms, or lifting an arm would drag the clothes with it
  return bones.map((b, i) => (/(Thumb|Index|Middle|Ring|Little|Eye|Lid|Jaw|Root|Arm|Hand|Shoulder)/.test(b.name) ? -1 : i)).filter((i) => i >= 0);
}

export interface Rig {
  bones: BoneDef[];
  parents: number[];
  joints: Uint16Array;     // 4 per vertex
  weights: Float32Array;   // 4 per vertex, normalized
  shapes: Record<string, SparseDelta>;
  shapeNames: string[];
  spec: CharSpec;
}

/** Skin weights (≤ 4 per vertex) and face shape keys for a final character mesh (object space, rest). */
export function buildRig(spec: CharSpec, pos: Float32Array, vertPart: string[]): Rig {
  const bones = spec.bones;
  const byName = new Map(bones.map((b, i) => [b.name, i]));
  const n = pos.length / 3;
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  const F = spec.face;
  // the torso hands over to the legs and shoulders gradually (no hard cut-offs: those tear when posed)
  const hipY = bones[byName.get('Hips')!].head[1], shY = bones[byName.get('LeftUpperArm')!].head[1], shX = bones[byName.get('LeftUpperArm')!].head[0], s = spec.s;
  const regionFactor = (part: string, bone: string, p: V3) => {
    if (part === 'apron') {
      // below the waist the apron bones carry it (the cloth swings), above it the trunk
      if (/^Apron/.test(bone)) return smooth(hipY + 0.01 * s, hipY - 0.06 * s, p[1]);
      if (bone !== 'Hips') return smooth(hipY - 0.01 * s, hipY + 0.07 * s, p[1]);
      return 1;
    }
    if (spec.quad && bone === 'Hips' && /UpperLeg$/.test(part)) {
      // the haunch above the hip joint is part of the rump: it moves with the hips, not the thigh
      const j = bones[byName.get(part)!].head;
      return 1 + 120 * smooth(j[1] - 0.07 * spec.quad.wither, j[1] + 0.12 * spec.quad.wither, p[1]) ** 2;
    }
    if (part !== 'torso') return 1;
    if (spec.quad) {
      // a level body: the legs take the underside near their hip/shoulder, the neck the front end
      const Qd = spec.quad;
      const side = smooth(0.15 * Qd.legX, 0.75 * Qd.legX, Math.abs(p[0])) * (Math.sign(p[0]) === (/^Left/.test(bone) ? 1 : -1) ? 1 : 0);
      if (/UpperLeg$/.test(bone)) return side * smooth(Qd.hipY - 0.1 * Qd.bodyR, Qd.hipY - 0.8 * Qd.bodyR, p[1]) * smooth(Qd.zRump + 0.5 * Qd.bodyR + 0.25 * Qd.wither, Qd.zRump + 0.2 * Qd.wither, p[2]);
      if (/UpperArm$/.test(bone)) return side * smooth(Qd.chestY - 0.1 * Qd.bodyR, Qd.chestY - 0.9 * Qd.bodyR, p[1]) * smooth(Qd.zChest - 0.5 * Qd.bodyR - 0.2 * Qd.wither, Qd.zChest - 0.15 * Qd.wither, p[2]);
      if (/Shoulder$/.test(bone)) return 0.5 * smooth(Qd.zChest - 0.3 * Qd.wither, Qd.zChest, p[2]);
      if (bone === 'Neck') return smooth(Qd.zChest - 0.02 * Qd.wither, Qd.zChest + 0.12 * Qd.wither, p[2]);
      return 1;
    }
    if (/UpperLeg$/.test(bone)) return smooth(hipY + 0.13 * s, hipY - 0.1 * s, p[1]);
    if (/Shoulder$/.test(bone)) return smooth(shY - 0.16 * s, shY - 0.02 * s, p[1]);
    if (/UpperArm$/.test(bone)) return smooth(shY - 0.14 * s, shY - 0.03 * s, p[1]) * smooth(shX * 0.55, shX * 0.95, Math.abs(p[0]));
    if (bone === 'Neck') return smooth(shY - 0.02 * s, shY + 0.06 * s, p[1]);
    return 1;
  };
  for (let v = 0; v < n; v++) {
    const p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const part = vertPart[v] ?? '';
    let cand: Array<[number, number]>;
    if (part.startsWith('lid.')) {
      cand = [[byName.get(part === 'lid.L' ? 'LeftUpperLid' : 'RightUpperLid')!, 1]];
    } else if (isFacePart(part) && part !== 'hair' && !part.startsWith('ear')) {
      // face: the jaw carries the lower face, the head the rest (shape keys do the fine work)
      const below = smooth(F.mouth[1] + F.slotH * 0.25, F.mouth[1] - F.slotH * 0.6, p[1]);
      const lower = onJaw(part) || part === 'lipLower' ? 1 : part === 'lipUpper' || part === 'teethUpper' || part === 'gumUpper' || part.startsWith('lidLow.') ? 0 : below * (1 - smooth(0.75 * F.hw, 1.05 * F.hw, Math.abs(p[0]))) * smooth(-0.6 * F.hd, -0.1 * F.hd, p[2]);
      // where the head meets the neck (under the chin, the nape) the neck takes over gradually
      const neck = smooth(F.headBase[1] + 0.14 * F.headH, F.headBase[1] - 0.02 * F.headH, p[1]) * 0.6;
      cand = [[byName.get('Head')!, (1 - lower) * (1 - neck)], [byName.get('Jaw')!, lower * (1 - neck)], [byName.get('Neck')!, neck]];
    } else {
      const allowed = allowedBones(part, bones, byName, p, spec);
      cand = allowed.map((i) => {
        const b = bones[i];
        const d = segDist(p, b.head, b.tail);
        return [i, regionFactor(part, b.name, p) / Math.pow(d + 0.004 * spec.s, 5)] as [number, number];
      });
    }
    cand.sort((a, b) => b[1] - a[1]);
    const top = cand.slice(0, 4).filter((c) => c[1] > 0);
    let sum = top.reduce((s, c) => s + c[1], 0);
    // drop tiny influences, then normalise
    const kept = top.filter((c) => c[1] / sum > 0.02);
    sum = kept.reduce((s, c) => s + c[1], 0);
    kept.forEach((c, k) => { joints[v * 4 + k] = c[0]; weights[v * 4 + k] = c[1] / sum; });
  }
  if (spec.quad) smoothWeights(pos, vertPart, joints, weights, 0.06 * spec.quad.wither, 6);
  const shapes = faceShapes(spec, pos, vertPart);
  return { bones, parents: bones.map((b) => (b.parent ? byName.get(b.parent)! : -1)), joints, weights, shapes, shapeNames: [...SHAPE_KEYS], spec };
}

/** Average skin weights with nearby vertices (a few passes): where a level body meets four legs the
 *  nearest-bone weights change too abruptly, and the skin tears when a leg swings far. Face parts,
 *  eyes and wings keep their own weights. */
function smoothWeights(pos: Float32Array, vertPart: string[], joints: Uint16Array, weights: Float32Array, r: number, iters: number) {
  const n = pos.length / 3;
  const skip = (v: number) => { const p = vertPart[v] ?? ''; return isFacePart(p) || /Eye|Wing|^lid/.test(p); };
  const cell = (x: number) => Math.floor(x / r);
  const grid = new Map<string, number[]>();
  for (let v = 0; v < n; v++) { if (skip(v)) continue; const k = `${cell(pos[v * 3])},${cell(pos[v * 3 + 1])},${cell(pos[v * 3 + 2])}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(v); }
  const nbrs: number[][] = [];
  for (let v = 0; v < n; v++) {
    if (skip(v)) { nbrs.push([]); continue; }
    const cx = cell(pos[v * 3]), cy = cell(pos[v * 3 + 1]), cz = cell(pos[v * 3 + 2]), out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (const u of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
      // stay on the same side of the body (the two legs never share weights)
      if (Math.abs(pos[u * 3] - pos[v * 3]) + Math.abs(pos[u * 3 + 1] - pos[v * 3 + 1]) + Math.abs(pos[u * 3 + 2] - pos[v * 3 + 2]) < r * 1.5) out.push(u);
    }
    nbrs.push(out);
  }
  for (let it = 0; it < iters; it++) {
    const nj = joints.slice(), nw = weights.slice();
    for (let v = 0; v < n; v++) {
      if (!nbrs[v].length) continue;
      const acc = new Map<number, number>();
      for (const u of nbrs[v]) for (let k = 0; k < 4; k++) { const w = weights[u * 4 + k]; if (w > 0) acc.set(joints[u * 4 + k], (acc.get(joints[u * 4 + k]) ?? 0) + w); }
      const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, c) => s + c[1], 0);
      for (let k = 0; k < 4; k++) { nj[v * 4 + k] = top[k]?.[0] ?? 0; nw[v * 4 + k] = top[k] ? top[k][1] / sum : 0; }
    }
    joints.set(nj); weights.set(nw);
  }
}

// ── posing ───────────────────────────────────────────────────────────────
export const NAMED_HAND_POSES: Record<string, HandPose> = {
  relaxed: { thumb: 0.25, index: 0.22, middle: 0.28, ring: 0.33, little: 0.38, spread: 0.08, name: 'relaxed' },
  fist: { thumb: 0.9, index: 1, middle: 1, ring: 1, little: 1, spread: 0, name: 'fist' },
  point: { thumb: 0.85, index: 0, middle: 1, ring: 1, little: 1, spread: 0, name: 'point' },
  pinch: { thumb: 0.62, index: 0.55, middle: 0.35, ring: 0.4, little: 0.45, spread: 0.05, name: 'pinch' },
  'open-palm': { thumb: 0, index: 0, middle: 0, ring: 0, little: 0, spread: 0.35, name: 'open-palm' },
};

/** Local rotations for one hand's finger bones from a hand pose (rest frame: fingers along ±X, palm down). */
export function handRotations(side: 'Left' | 'Right', h: HandPose): Record<string, Q> {
  const sx = side === 'Left' ? 1 : -1;
  const out: Record<string, Q> = {};
  const spreadDir: Record<string, number> = { Index: 1, Middle: 0.3, Ring: -0.35, Little: -1 };
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    const c = clamp((h as any)[f.toLowerCase()] ?? 0);
    const [p, i, d] = fingerBones(side, f);
    // curl bends the finger toward the palm (−Y): about +Z for the left hand, −Z for the right
    const curl = (deg: number) => qAxisAngle([0, 0, 1], -sx * deg);
    out[p] = qMul(qAxisAngle([0, 1, 0], -sx * spreadDir[f] * 14 * clamp(h.spread ?? 0) * (1 - c)), curl(c * 82));
    out[i] = curl(c * 98);
    out[d] = curl(c * 72);
  }
  const t = clamp(h.thumb ?? 0);
  const [tm, tp, td] = fingerBones(side, 'Thumb');
  // the thumb folds across the palm: about +X (forward → down), then inward
  out[tm] = qMul(qAxisAngle([0, 1, 0], sx * t * 28), qAxisAngle([1, 0, 0], t * 34));
  out[tp] = qAxisAngle([1, 0, 0], t * 42);
  out[td] = qAxisAngle([1, 0, 0], t * 48);
  return out;
}

export interface Posed {
  local: Q[];            // per bone local rotation
  worldQ: Q[];           // per bone world rotation (object space)
  worldP: V3[];          // per bone world head position (object space)
}

/** Forward kinematics: bone heads/rotations for a set of local rotations (rest bones have identity orientation). */
export function forward(bones: BoneDef[], parents: number[], local: Q[]): Posed {
  const worldQ: Q[] = [], worldP: V3[] = [];
  bones.forEach((b, i) => {
    const pi = parents[i];
    if (pi < 0) { worldQ[i] = local[i]; worldP[i] = b.head; return; }
    const rel = subv(b.head, bones[pi].head);
    worldP[i] = add(worldP[pi], qRot(worldQ[pi], rel));
    worldQ[i] = qMul(worldQ[pi], local[i]);
  });
  return { local, worldQ, worldP };
}

/** Local rotations from a character state (body pose + hand poses). */
export function localRotations(rig: Pick<Rig, 'bones'> & { spec?: CharSpec }, state: CharacterState | undefined): Q[] {
  const local = rig.bones.map(() => qIdentity());
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  // blinks turn the lid bones (the eyeBlink shape keys move the skin around them)
  for (const l of rig.spec?.lids ?? []) {
    const w = state?.expression?.[l.bone === 'LeftUpperLid' ? 'eyeBlinkLeft' : 'eyeBlinkRight'] ?? 0;
    const i = idx.get(l.bone);
    if (w && i !== undefined) local[i] = qAxisAngle([1, 0, 0], l.closeDeg * Math.min(1, Math.max(0, w)));
  }
  for (const [name, e] of Object.entries(state?.pose ?? {})) { const i = idx.get(name); if (i !== undefined) local[i] = qEuler(e); }
  for (const side of ['Left', 'Right'] as const) {
    const h = state?.hands?.[side === 'Left' ? 'left' : 'right'];
    if (!h) continue;
    for (const [name, q] of Object.entries(handRotations(side, h))) { const i = idx.get(name); if (i !== undefined) local[i] = qMul(local[i], q); }
  }
  return local;
}

/** Rest positions + shape keys (expression) → skinned positions for a pose. */
export function poseVertices(rig: Rig, rest: Float32Array, posed: Posed, expression: Record<string, number> | undefined): Float32Array {
  const n = rest.length / 3;
  const base = new Float32Array(rest);
  for (const [k, w] of Object.entries(expression ?? {})) {
    const sd = rig.shapes[k];
    if (!sd || !w) continue;
    for (let i = 0; i < sd.idx.length; i++) { const v = sd.idx[i]; base[v * 3] += sd.d[i * 3] * w; base[v * 3 + 1] += sd.d[i * 3 + 1] * w; base[v * 3 + 2] += sd.d[i * 3 + 2] * w; }
  }
  const out = new Float32Array(n * 3);
  const heads = rig.bones.map((b) => b.head);
  for (let v = 0; v < n; v++) {
    const p: V3 = [base[v * 3], base[v * 3 + 1], base[v * 3 + 2]];
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = rig.weights[v * 4 + k];
      if (!w) continue;
      const j = rig.joints[v * 4 + k];
      const r = add(posed.worldP[j], qRot(posed.worldQ[j], subv(p, heads[j])));
      x += r[0] * w; y += r[1] * w; z += r[2] * w;
    }
    out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
  }
  return out;
}

/** Where a hand holds a prop (object space, posed): grip point, handle axis, and the side axis. */
export function gripFrame(rig: Rig, posed: Posed, side: 'left' | 'right', kind: 'power' | 'pinch', radius: number): { p: V3; axis: V3; side: V3 } {
  const S = side === 'left' ? 'Left' : 'Right', sx = side === 'left' ? 1 : -1;
  const i = rig.bones.findIndex((b) => b.name === `${S}Hand`);
  const palm = rig.spec.palm[S];
  const local: V3 = kind === 'power'
    ? [sx * palm.len * 0.7, -(palm.thick * 0.5 + radius * 1.25 + 0.003 * rig.spec.s), palm.width * 0.06]
    : [sx * (palm.len + 0.03 * rig.spec.s), -palm.thick * 1.3, palm.width * 0.42];
  const q = posed.worldQ[i];
  return { p: add(posed.worldP[i], qRot(q, local)), axis: norm(qRot(q, [0, 0, 1])), side: norm(qRot(q, [sx, 0, 0])) };
}

// ── pose checks ─────────────────────────────────────────────────────────
export const CANONICAL_POSES: Record<string, Record<string, V3>> = {
  'T-pose': {},
  'A-pose': { LeftUpperArm: [0, 0, -45], RightUpperArm: [0, 0, 45] },
  'arms down': { LeftUpperArm: [0, 0, -78], RightUpperArm: [0, 0, 78] },
  'elbows bent': { LeftUpperArm: [0, 0, -60], RightUpperArm: [0, 0, 60], LeftLowerArm: [0, -95, 0], RightLowerArm: [0, 95, 0] },
  'arms forward': { LeftUpperArm: [0, -80, 0], RightUpperArm: [0, 80, 0] },
  'sitting': { LeftUpperLeg: [-80, 0, 0], RightUpperLeg: [-80, 0, 0], LeftLowerLeg: [80, 0, 0], RightLowerLeg: [80, 0, 0] },
  'step': { LeftUpperLeg: [-35, 0, 0], RightUpperLeg: [25, 0, 0], LeftLowerLeg: [30, 0, 0] },
  'bend forward': { Spine: [20, 0, 0], Chest: [15, 0, 0], LeftUpperArm: [0, 0, -70], RightUpperArm: [0, 0, 70] },
  'twist + look': { Spine: [0, 15, 0], Chest: [0, 15, 0], Neck: [0, 20, 0], Head: [10, 25, 0], LeftUpperArm: [0, 0, -70], RightUpperArm: [0, 0, 70] },
  'fists + wrists': { LeftUpperArm: [0, 0, -70], RightUpperArm: [0, 0, 70], LeftHand: [40, 0, 0], RightHand: [-40, 0, 0] },
};

export interface PoseCheck { pose: string; volume: number; worstJoint: string; stretch: number; intersections: number; clothes: number; pass: boolean; detail: string }

/** Parts the kit itself makes (body, face, hands); anything else was added with ops (clothes, hair, tools). */
export const isKitPart = (part: string) => part === 'torso' || isFacePart(part) || /^(Left|Right|Neck|Hips|Spine|Chest|UpperChest|Head)/.test(part);

/**
 * Deform the character through the canonical poses and measure: the smallest joint volume ratio
 * (candy-wrapping shrinks it), the largest edge stretch, and triangles of non-neighbouring body
 * regions passing through each other.
 */
/** Skin checks for a set of poses: the canonical set, or any named local-rotation sets (motion frames). */
export function poseChecks(rig: Rig, rest: Float32Array, indices: Uint32Array, vertPart: string[], poses?: Record<string, Q[]>): PoseCheck[] {
  const n = rest.length / 3;
  const dominant = new Int32Array(n);
  for (let v = 0; v < n; v++) dominant[v] = rig.joints[v * 4];
  const joints = ['LeftUpperArm', 'LeftLowerArm', 'LeftHand', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'RightUpperLeg', 'RightLowerLeg', 'Neck', 'Spine'];
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  // vertices near each joint (within its radius of the joint centre)
  const near = new Map<string, number[]>();
  for (const j of joints) {
    const b = rig.bones[idx.get(j)!];
    const r = Math.max(0.04, Math.hypot(...subv(b.tail, b.head)) * 0.22);
    const list: number[] = [];
    for (let v = 0; v < n; v++) {
      if (/(Thumb|Index|Middle|Ring|Little|Eye)/.test(vertPart[v]) || isFacePart(vertPart[v])) continue;
      if (Math.hypot(rest[v * 3] - b.head[0], rest[v * 3 + 1] - b.head[1], rest[v * 3 + 2] - b.head[2]) < r) list.push(v);
    }
    near.set(j, list);
  }
  const edges = new Set<string>();
  const edgeList: Array<[number, number]> = [];
  for (let t = 0; t < indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = indices[t + k], b = indices[t + (k + 1) % 3];
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!edges.has(key)) { edges.add(key); edgeList.push([a, b]); }
  }
  // body regions for intersection: limbs and torso, not neighbours in the hierarchy
  const region = (bi: number) => {
    const name = rig.bones[bi].name;
    if (/^(Left|Right)(Thumb|Index|Middle|Ring|Little|Hand)/.test(name)) return name.startsWith('Left') ? 'LH' : 'RH';
    if (/^(Left|Right)LowerArm/.test(name)) return name.startsWith('Left') ? 'LLA' : 'RLA';
    if (/^(Left|Right)(UpperArm|Shoulder)/.test(name)) return name.startsWith('Left') ? 'LUA' : 'RUA';
    if (/^(Left|Right)(LowerLeg|Foot|Toes)/.test(name)) return name.startsWith('Left') ? 'LLL' : 'RLL';
    if (/^(Left|Right)UpperLeg/.test(name)) return name.startsWith('Left') ? 'LUL' : 'RUL';
    if (/^(Head|Neck|Jaw|LeftEye|RightEye|LeftUpperLid|RightUpperLid)/.test(name)) return 'H';
    return 'T';
  };
  const NEIGHBOURS = new Set(['LH|LLA', 'RH|RLA', 'LLA|LUA', 'RLA|RUA', 'LUA|T', 'RUA|T', 'LLL|LUL', 'RLL|RUL', 'LUL|T', 'RUL|T', 'H|T', 'LUL|RUL', 'LLL|RLL',
    // four legs fold against the body when the animal sits or lies down (haunch on hock, forearms under the chest)
    ...(rig.spec.quad ? ['LLL|T', 'RLL|T', 'LLA|T', 'RLA|T', 'LH|LUA', 'RH|RUA', 'LH|RH', 'LLA|RLA'] : [])]);
  const triRegion: string[] = [];
  const clothTri: boolean[] = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const v = indices[t * 3];
    clothTri.push(!isKitPart(vertPart[v]));
    triRegion.push(region(dominant[v]));
  }
  const out: PoseCheck[] = [];
  // the test poses follow the body's range of motion: a belly or a round torso stops the thighs short
  // of a human's 80° sit, so those bodies sit as far as they can (body-relative checks, Decision 48 A)
  const PDp = PLANS[rig.spec.plan ?? 'human'];
  const hipFlex = 1 - Math.min(0.35, PDp.torso[4] * 0.8 + Math.max(0, PDp.limb - 1) * 0.3);
  const posesFor = (name: string, pose: Record<string, V3>): Record<string, V3> => {
    if (hipFlex === 1 || name !== 'sitting') return pose;
    return Object.fromEntries(Object.entries(pose).map(([k, v]) => [k, /Leg$/.test(k) ? (v.map((x) => x * hipFlex) as V3) : v]));
  };
  const sets: Record<string, Q[]> = poses ?? Object.fromEntries(Object.entries(CANONICAL_POSES).map(([name, pose0]) => { const pose = posesFor(name, pose0); return [name, rig.bones.map((b) => (pose[b.name] ? qEuler(pose[b.name]) : qIdentity()))]; }));
  for (const [name, local] of Object.entries(sets)) {
    const posed = forward(rig.bones, rig.parents, local);
    const P = poseVertices(rig, rest, posed, undefined);
    // joint volume: mean distance from the joint centre, posed vs rest
    let worst = 1, worstJoint = '';
    for (const j of joints) {
      const list = near.get(j)!;
      if (list.length < 6) continue;
      const bi = idx.get(j)!;
      const c0 = rig.bones[bi].head, c1 = posed.worldP[bi];
      let r0 = 0, r1 = 0;
      for (const v of list) {
        r0 += Math.hypot(rest[v * 3] - c0[0], rest[v * 3 + 1] - c0[1], rest[v * 3 + 2] - c0[2]);
        r1 += Math.hypot(P[v * 3] - c1[0], P[v * 3 + 1] - c1[1], P[v * 3 + 2] - c1[2]);
      }
      const ratio = (r1 / r0) ** 2; // area-like: a collapsing joint loses radius²
      if (ratio < worst) { worst = ratio; worstJoint = j; }
    }
    let stretch = 1;
    for (const [a, b] of edgeList) {
      if (!isKitPart(vertPart[a]) || !isKitPart(vertPart[b])) continue;
      const l0 = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
      if (l0 < 0.008 * rig.spec.s) continue; // tiny seam edges from the booleans exaggerate ratios
      const l1 = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
      stretch = Math.max(stretch, l1 / l0);
    }
    const inter = countIntersections(P, indices, triRegion, NEIGHBOURS, (t) => !clothTri[t]);
    const clothes = clothTri.some(Boolean) ? countIntersections(P, indices, triRegion, NEIGHBOURS, (t) => clothTri[t], true) : 0;
    const pass = worst >= 0.55 && stretch <= 2.6 && inter === 0;
    out.push({
      pose: name, volume: +worst.toFixed(2), worstJoint, stretch: +stretch.toFixed(2), intersections: inter, clothes, pass,
      detail: `${worstJoint ? `${worstJoint} keeps ${Math.round(worst * 100)}% of its volume` : 'joints keep their volume'}, edges stretch ≤ ${stretch.toFixed(2)}×${inter ? `, ${inter} triangle pairs pass through each other` : ''}${clothes ? ` (clothes clip the body in ${clothes} places: expected without cloth simulation)` : ''}`,
    });
  }
  return out;
}

/** Triangle pairs from non-neighbouring body regions that intersect (uniform grid + Möller test). */
function countIntersections(P: Float32Array, I: Uint32Array, triRegion: string[], neighbours: Set<string>, include: (t: number) => boolean = () => true, againstAll = false): number {
  const nt = I.length / 3;
  const cell = 0.05;
  const grid = new Map<string, number[]>();
  const box = (t: number) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    return [0, 1, 2].map((k) => [Math.min(P[a + k], P[b + k], P[c + k]), Math.max(P[a + k], P[b + k], P[c + k])]);
  };
  for (let t = 0; t < nt; t++) {
    if (triRegion[t] === 'H') continue;
    if (!againstAll && !include(t)) continue;
    const bb = box(t);
    for (let x = Math.floor(bb[0][0] / cell); x <= Math.floor(bb[0][1] / cell); x++)
      for (let y = Math.floor(bb[1][0] / cell); y <= Math.floor(bb[1][1] / cell); y++)
        for (let z = Math.floor(bb[2][0] / cell); z <= Math.floor(bb[2][1] / cell); z++) {
          const k = `${x},${y},${z}`;
          let l = grid.get(k);
          if (!l) { l = []; grid.set(k, l); }
          l.push(t);
        }
  }
  const seen = new Set<string>();
  let count = 0;
  for (const list of grid.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      // againstAll: one triangle must be included (clothes) and the other not (body)
      if (againstAll && include(a) === include(b)) continue;
      const ra = triRegion[a], rb = triRegion[b];
      if (ra === rb) continue;
      const pair = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
      if (neighbours.has(pair)) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sharesVertex(I, a, b)) continue;
      if (triTri(P, I, a, b)) count++;
    }
  }
  return count;
}

function sharesVertex(I: Uint32Array, a: number, b: number) {
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (I[a * 3 + i] === I[b * 3 + j]) return true;
  return false;
}

function triTri(P: Float32Array, I: Uint32Array, a: number, b: number): boolean {
  const v = (t: number, k: number): V3 => { const i = I[t * 3 + k] * 3; return [P[i], P[i + 1], P[i + 2]]; };
  const A = [v(a, 0), v(a, 1), v(a, 2)], B = [v(b, 0), v(b, 1), v(b, 2)];
  // segment-triangle tests both ways (robust enough for counting)
  const segTri = (p: V3, q: V3, T: V3[]) => {
    const e1 = subv(T[1], T[0]), e2 = subv(T[2], T[0]), d = subv(q, p);
    const h = cross(d, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-12) return false;
    const f = 1 / det, s = subv(p, T[0]), u = f * dot(s, h);
    if (u < 0 || u > 1) return false;
    const qv = cross(s, e1), w = f * dot(d, qv);
    if (w < 0 || u + w > 1) return false;
    const t = f * dot(e2, qv);
    return t > 1e-6 && t < 1 - 1e-6;
  };
  for (let k = 0; k < 3; k++) {
    if (segTri(A[k], A[(k + 1) % 3], B)) return true;
    if (segTri(B[k], B[(k + 1) % 3], A)) return true;
  }
  return false;
}

/** Weight sanity: sums to 1, at most 4 influences, every vertex bound. */
/**
 * Teeth and tongue stay behind the lips in every speech shape (and closed lips hide them): for each
 * shape at full weight, the margin between each tooth/tongue point and the front of the lips above
 * or below it. Negative = something pokes through.
 */
/** Speech on any mouth part (Decision 49 A): it closes on M/B/P, opens clearly for vowels, and its 15
 *  speech shapes fall into enough visibly different groups (lips can do more than a beak or a grille). */
export function speechCheck(rig: Rig, rest: Float32Array, vertPart: string[]): { pass: boolean; groups: number; need: number; closed: number; open: number; detail: string } {
  const F = rig.spec.face, kind = F.kind ?? 'human', Hh = F.headH;
  const band = (v: number) => Math.abs(rest[v * 3] - F.mouth[0]) < F.mouthW * 0.5;
  const up: number[] = [], lo: number[] = [], mouthVerts: number[] = [];
  for (let v = 0; v < vertPart.length; v++) {
    const p = vertPart[v];
    if (p === 'lipUpper' && band(v)) up.push(v);
    if (p === 'lipLower' && band(v)) lo.push(v);
    if (/^lip|^mouthInner/.test(p)) mouthVerts.push(v);
  }
  // bars and bills may have no vertices near the centre line: then the whole part stands in
  if (!up.length) for (let v = 0; v < vertPart.length; v++) if (vertPart[v] === 'lipUpper') up.push(v);
  if (!lo.length) for (let v = 0; v < vertPart.length; v++) if (vertPart[v] === 'lipLower') lo.push(v);
  if (!up.length || !lo.length) return { pass: false, groups: 0, need: 0, closed: 0, open: 0, detail: 'no upper and lower mouth parts found' };
  const deltaAt = (key: string) => {
    const d = new Map<number, V3>();
    const sh = rig.shapes[key];
    if (sh) for (let i = 0; i < sh.idx.length; i++) d.set(sh.idx[i], [sh.d[i * 3], sh.d[i * 3 + 1], sh.d[i * 3 + 2]]);
    return d;
  };
  const cy = (vs: number[], d: Map<number, V3>) => vs.reduce((a, v) => a + rest[v * 3 + 1] + (d.get(v)?.[1] ?? 0), 0) / vs.length;
  const opening = (key: string) => { const d = deltaAt(key); return cy(up, d) - cy(lo, d); };
  const rest0 = opening('__none__');
  const closed = opening('PP') - rest0, open = opening('aa') - rest0;
  // group the speech shapes by how they move the mouth (RMS difference over its vertices)
  const fields = VISEMES.map((k) => { const d = deltaAt(k); return mouthVerts.map((v) => d.get(v) ?? [0, 0, 0]); });
  const groups: number[] = [];
  const reps: V3[][] = [];
  fields.forEach((f) => {
    let found = -1;
    reps.forEach((r, gi) => {
      let e = 0; for (let i = 0; i < f.length; i++) e += (f[i][0] - r[i][0]) ** 2 + (f[i][1] - r[i][1]) ** 2 + (f[i][2] - r[i][2]) ** 2;
      if (found < 0 && Math.sqrt(e / Math.max(1, f.length)) < 0.004 * Hh) found = gi;
    });
    if (found < 0) { reps.push(f); groups.push(reps.length - 1); } else groups.push(found);
  });
  const need = kind === 'beak' || kind === 'grille' ? 4 : 8;
  const fails: string[] = [];
  if (closed > 0.002 * Hh) fails.push(`M/B/P leaves the ${kind === 'beak' ? 'beak' : 'mouth'} ${(closed * 1000).toFixed(1)} mm more open than at rest (it must close)`);
  if (open < 0.03 * Hh) fails.push(`"aa" opens only ${(open * 1000).toFixed(1)} mm (vowels must read)`);
  if (reps.length < need) fails.push(`the 15 speech shapes fall into only ${reps.length} visibly different groups (want ≥ ${need})`);
  return {
    pass: !fails.length, groups: reps.length, need, closed, open,
    detail: fails.length ? fails.join('; ') : `${kind} mouth: closes on M/B/P (${(closed * 1000).toFixed(1)} mm), opens ${(open * 1000).toFixed(0)} mm on "aa", ${reps.length} distinct speech shapes of 15`,
  };
}

export function mouthCheck(rig: Rig, rest: Float32Array, vertPart: string[]): { pass: boolean; worst: number; shape: string; detail: string } {
  const H = rig.spec.face.headH, mw = rig.spec.face.mouthW;
  const F0 = rig.spec.face.mouth;
  const inner: number[] = [], skin: number[] = [];
  for (let v = 0; v < vertPart.length; v++) {
    if (isMouthPart(vertPart[v])) inner.push(v);
    else if (/^(lip|Head)/.test(vertPart[v]) && Math.abs(rest[v * 3 + 1] - F0[1]) < 0.15 * H && rest[v * 3 + 2] > F0[2] - 0.1 * H) skin.push(v);
  }
  if (!inner.length) return { pass: true, worst: Infinity, shape: '', detail: 'no teeth or tongue' };
  let worst = Infinity, worstShape = '';
  for (const shape of [...VISEMES, 'mouthClose', 'mouthPucker', 'jawOpen']) {
    const sd = rig.shapes[shape];
    const P = new Float32Array(rest);
    if (sd) for (let i = 0; i < sd.idx.length; i++) { const v = sd.idx[i]; P[v * 3] += sd.d[i * 3]; P[v * 3 + 1] += sd.d[i * 3 + 1]; P[v * 3 + 2] += sd.d[i * 3 + 2]; }
    // the face's front around the mouth (lips and skin), on a grid across the mouth: a tooth may sit
    // anywhere behind it, and nothing may come out in front of it
    const XB = 32, YB = 24, x0 = -mw * 1.4, xs = (2.8 * mw) / XB, y0 = F0[1] - 0.2 * H, ys = (0.3 * H) / YB;
    const grid = new Float32Array(XB * YB).fill(-Infinity);
    for (const v of skin) {
      const i = Math.floor((P[v * 3] - x0) / xs), j = Math.floor((P[v * 3 + 1] - y0) / ys);
      if (i >= 0 && i < XB && j >= 0 && j < YB) grid[j * XB + i] = Math.max(grid[j * XB + i], P[v * 3 + 2]);
    }
    for (const v of inner) {
      const i = Math.floor((P[v * 3] - x0) / xs), j = Math.floor((P[v * 3 + 1] - y0) / ys);
      let f = -Infinity;
      for (let jj = j - 3; jj <= j + 3; jj++) for (let ii = i - 2; ii <= i + 2; ii++) if (ii >= 0 && ii < XB && jj >= 0 && jj < YB) f = Math.max(f, grid[jj * XB + ii]);
      if (!Number.isFinite(f)) continue;
      const margin = f - P[v * 3 + 2];
      if (margin < worst) { worst = margin; worstShape = shape; }
    }
  }
  const min = 0.006 * H;
  const mm = (x: number) => `${(x * 1000).toFixed(1)} mm`;
  return {
    pass: worst >= min, worst, shape: worstShape,
    detail: worst >= min ? `teeth and tongue stay ≥ ${mm(worst)} behind the lips in every speech shape (closest: ${worstShape})` : `in "${worstShape}" the ${worst < 0 ? 'teeth or tongue poke through the lips' : 'teeth or tongue nearly touch the front of the lips'} (${mm(worst)}; need ≥ ${mm(min)})`,
  };
}

export function weightReport(rig: Rig): { unbound: number; badSum: number; maxInfluences: number } {
  const n = rig.weights.length / 4;
  let unbound = 0, badSum = 0, maxInf = 0;
  for (let v = 0; v < n; v++) {
    let s = 0, c = 0;
    for (let k = 0; k < 4; k++) { const w = rig.weights[v * 4 + k]; s += w; if (w > 0) c++; }
    if (c === 0) unbound++;
    else if (Math.abs(s - 1) > 1e-4) badSum++;
    maxInf = Math.max(maxInf, c);
  }
  return { unbound, badSum, maxInfluences: maxInf };
}
