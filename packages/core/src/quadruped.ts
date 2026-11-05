// Quadrupeds (Phase 7, week 12): a four-legged body plan, skeleton first. The spine runs along +Z (the
// animal faces +Z like every studio character), the front legs reuse the arm bone names and the hind
// legs the leg names, so export, the engines and the motion clips treat it like any character. The head
// is the studio's face kit (muzzle or beak by default, so it still has the 15 speech shapes), built
// upright and moved to the end of the neck. Motion is its own: walk (lateral sequence), trot (diagonal
// pairs) and gallop, from leg length; idle, sit and lie down; IK foot planting; tails and wings added on.
import {
  FINGER_NAMES, characterSpec, fingerBones, forward, qAxisAngle, qIdentity, qMul, qRot, isFacePart,
  type BoneDef, type CharParams, type CharSpec, type Piece, type Q, type Rig, type V3,
} from './rig.ts';
import type { CharacterState, MotionSpec } from './types.ts';
import type { MotionClip } from './motion.ts';

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (u: number) => { const t = clamp(u); return t * t * (3 - 2 * t); };
const qInv = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const X = (d: number) => qAxisAngle([1, 0, 0], d), Y = (d: number) => qAxisAngle([0, 1, 0], d), Z = (d: number) => qAxisAngle([0, 0, 1], d);
/** The shortest rotation taking direction a onto b. */
export function qArcQ(a: V3, b: V3): Q {
  const u = norm(a), v = norm(b), d = dot(u, v);
  if (d > 0.999999) return qIdentity();
  if (d < -0.999999) { let ax = cross([1, 0, 0], u); if (len(ax) < 1e-6) ax = cross([0, 1, 0], u); ax = norm(ax); return [ax[0], ax[1], ax[2], 0]; }
  const c = cross(u, v), w = 1 + d, l = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
}

const lerpV = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** A padded paw: broad and rounded, toes bunched at the front, the heel pad behind. */
function pawPts(paw: V3, w: number, pawY: number, toeLen: number): V3[] {
  const pts: V3[] = [];
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI * (i / 6);                       // round the front of the paw
    pts.push(add(paw, [Math.cos(a) * w * 0.62, -pawY, toeLen * 0.55 + Math.sin(a) * toeLen * 0.55]));
    pts.push(add(paw, [Math.cos(a) * w * 0.5, -pawY + w * 0.36, toeLen * 0.45 + Math.sin(a) * toeLen * 0.45]));
  }
  pts.push(add(paw, [-w * 0.5, -pawY, -w * 0.3]), add(paw, [w * 0.5, -pawY, -w * 0.3]), add(paw, [0, -pawY, -w * 0.45]));
  pts.push(add(paw, [-w * 0.32, w * 0.3, -w * 0.05]), add(paw, [w * 0.32, w * 0.3, -w * 0.05]), add(paw, [0, w * 0.5, toeLen * 0.2]));
  return pts;
}

// ── the body ─────────────────────────────────────────────────────────────
/** Tail and wing add-ons, for any body plan (bones + pieces). */
export function addTail(bones: BoneDef[], pieces: Piece[], base: V3, dir: V3, length: number, r0: number, sides: number) {
  const n = 4;
  let at = base, parent = 'Hips';
  const d = norm(dir);
  for (let i = 0; i < n; i++) {
    const segLen = length * [0.3, 0.27, 0.24, 0.19][i];
    // each segment droops a little more (a relaxed tail curves)
    const di = norm(add(d, [0, -0.12 * i, 0]));
    const end = add(at, mul(di, segLen));
    const name = `Tail${i + 1}`;
    bones.push({ name, parent, head: at, tail: end });
    const r1 = r0 * (1 - i * 0.2), r2 = r0 * (1 - (i + 1) * 0.2) + r0 * 0.05;
    pieces.push({ kind: 'ball', c: at, r: r1, sides, part: name }, { kind: 'seg', a: at, b: end, r1, r2, sides, part: name });
    at = end; parent = name;
  }
  pieces.push({ kind: 'ball', c: at, r: r0 * 0.25, sides, part: 'Tail4' });
}
export function addWings(bones: BoneDef[], pieces: Piece[], root: V3, span: number, chord: number, parent: string) {
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    // rest: spread out sideways and a little back (the fold is a pose, applied by every motion)
    const a: V3 = [root[0] + sx * 0.04 * span, root[1], root[2]];
    const mid: V3 = [a[0] + sx * span * 0.45, a[1] + 0.02 * span, a[2] - 0.05 * span];
    const tip: V3 = [mid[0] + sx * span * 0.55, mid[1] - 0.02 * span, mid[2] - 0.12 * span];
    bones.push({ name: `${side}Wing1`, parent, head: a, tail: mid }, { name: `${side}Wing2`, parent: `${side}Wing1`, head: mid, tail: tip });
    const t = 0.012 * span;
    // feathers: thin cards hanging back from the wing's leading edge, overlapping like shingles —
    // short coverts on top, secondaries along the inner bone, long primaries fanned out from the tip
    const card = (root: V3, along: V3, back: V3, w: number, len: number, part: string, lift = 0): Piece => {
      const tip = add(add(root, mul(back, len)), [0, lift, 0]);
      return { kind: 'hull', part, pts: [
        add(root, mul(along, -w / 2)), add(root, mul(along, w / 2)), add(add(root, mul(along, -w / 2)), [0, t * 0.7, 0]), add(add(root, mul(along, w / 2)), [0, t * 0.7, 0]),
        add(tip, mul(along, -w * 0.32)), add(tip, mul(along, w * 0.32)), add(add(tip, mul(back, w * 0.25)), [0, t * 0.2, 0]),
      ] };
    };
    const span1 = norm(sub(mid, a)), span2 = norm(sub(tip, mid));
    for (let i = 0; i < 4; i++) {
      // secondaries: four broad cards along the inner bone, angled back
      const u = (i + 0.5) / 4;
      const root = add(a, mul(sub(mid, a), u));
      pieces.push(card(add(root, [0, -t * 0.3 * i, 0]), span1, norm([sx * 0.18, -0.06, -1]), (len(sub(mid, a)) / 4) * 1.35, chord * (0.72 + 0.22 * u), `${side}Wing1`, -0.004 * span * i));
    }
    for (let i = 0; i < 5; i++) {
      // primaries: five long cards fanned out from the outer bone, the outermost the longest and swept
      const u = (i + 0.5) / 5;
      const root = add(mid, mul(sub(tip, mid), 0.15 + 0.85 * u));
      const back = norm([sx * (0.15 + 0.85 * u), -0.05, -1 + 0.6 * u]);
      pieces.push(card(add(root, [0, -t * 0.25 * i, 0]), span2, back, (len(sub(tip, mid)) / 5) * 1.5, chord * (0.95 + 0.35 * u), `${side}Wing2`, -0.004 * span * i));
    }
    // coverts: a rounded pad over the roots of the feathers
    pieces.push({ kind: 'hull', part: `${side}Wing1`, pts: [add(a, [0, t * 1.4, 0]), add(mid, [0, t * 1.4, 0]), add(a, [0, -t, -chord * 0.4]), add(mid, [0, -t, -chord * 0.42]), add(add(a, mul(sub(mid, a), 0.5)), [0, t * 1.8, -chord * 0.25])] });
    pieces.push({ kind: 'seg', a, b: mid, r1: t * 1.7, r2: t * 1.3, sides: 6, part: `${side}Wing1` }, { kind: 'seg', a: mid, b: tip, r1: t * 1.3, r2: t * 0.7, sides: 6, part: `${side}Wing2` });
  }
}

export interface QuadDims { wither: number; hipY: number; chestY: number; zRump: number; zChest: number; bodyR: number; legX: number; legLen: number }

/** A four-legged body (dog, cat, horse style): proportions from height, build, headSize, legLength. */
export function quadrupedSpec(p: CharParams): CharSpec {
  const H = p.height, b = p.build, s = H / 1.75;
  const wither = 0.66 * H * p.legLength / (0.75 + 0.25 * p.legLength);          // shoulder height
  const bodyLen = 1.12 * wither * (0.95 + 0.25 * (1 - p.legLength));
  const bodyR = 0.27 * wither * (0.75 + 0.5 * b);
  const hipY = wither * 0.97, chestY = wither, zRump = -bodyLen * 0.48, zChest = bodyLen * 0.4;
  const legX = bodyR * 0.62;
  const bones: BoneDef[] = [];
  const bone = (name: string, parent: string | null, head: V3, tail: V3) => bones.push({ name, parent, head, tail });
  bone('Root', null, [0, 0, 0], [0, 0.1 * s, 0]);
  const spinePts: V3[] = [[0, hipY, zRump], [0, hipY + 0.01 * wither, zRump + bodyLen * 0.3], [0, chestY + 0.01 * wither, zRump + bodyLen * 0.6], [0, chestY, zChest], [0, chestY + 0.02 * wither, zChest + 0.1 * wither]];
  bone('Hips', 'Root', spinePts[0], spinePts[1]);
  bone('Spine', 'Hips', spinePts[1], spinePts[2]);
  bone('Chest', 'Spine', spinePts[2], spinePts[3]);
  bone('UpperChest', 'Chest', spinePts[3], spinePts[4]);
  // the head: the studio face kit at the size this animal needs, then moved onto the neck
  const headH = 0.36 * wither * p.headSize;
  const F0 = { mouth: 'muzzle', eyes: 'natural', brows: 'none', nose: 'none', ears: 'floppy' } as const;
  const faceSpec = characterSpec({ ...p, plan: undefined, height: headH / 0.165, headSize: 1, legLength: 1, armLength: 1, apron: false, tail: false, wings: false, hair: p.hair ?? 'none', snout: p.snout ?? 1.5, shape: 'round',
    mouth: p.mouth ?? F0.mouth, eyes: p.eyes ?? F0.eyes, brows: p.brows ?? F0.brows, nose: p.nose ?? F0.nose, ears: p.ears ?? F0.ears });
  const fHead = faceSpec.bones.find((x) => x.name === 'Head')!.head;
  const headBase: V3 = [0, chestY + 0.2 * wither, zChest + 0.3 * wither];
  const dv = sub(headBase, fHead);
  const mv = (v: V3) => add(v, dv);
  bone('Neck', 'UpperChest', spinePts[4], headBase);
  for (const n of ['Head', 'LeftEye', 'RightEye', 'Jaw', 'LeftUpperLid', 'RightUpperLid']) {
    const fb = faceSpec.bones.find((x) => x.name === n)!;
    bone(n, n === 'Head' ? 'Neck' : 'Head', mv(fb.head), mv(fb.tail));
  }
  const pieces: Piece[] = [];
  const mvPiece = (pc: Piece): Piece => pc.kind === 'seg' ? { ...pc, a: mv(pc.a), b: mv(pc.b) } : pc.kind === 'ball' ? { ...pc, c: mv(pc.c) } : { ...pc, pts: pc.pts.map(mv) };
  for (const pc of faceSpec.pieces) if (isFacePart(pc.part) && pc.part !== 'Neck') pieces.push(mvPiece(pc));
  const SIDES = p.style === 'toy' ? 6 : p.style === 'smooth' ? 10 : 8;
  const seg = (a: V3, c: V3, r1: number, r2: number, part: string) => pieces.push({ kind: 'seg', a, b: c, r1, r2, sides: SIDES, part });
  const ball = (c: V3, r: number, part: string) => pieces.push({ kind: 'ball', c, r, sides: SIDES, part });
  // legs: front legs reuse the arm names (Shoulder → UpperArm → LowerArm → Hand = the paw), hind legs
  // the leg names; the knee (stifle) bends forward, the hock back, the elbow back
  const pawY = 0.03 * wither, toeLen = 0.07 * wither;
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1, x = sx * legX;
    const hip: V3 = [x, hipY - bodyR * 0.35, zRump + 0.02 * wither];
    const stifle: V3 = [x, hipY * 0.6, zRump + 0.14 * wither];
    const hock: V3 = [x, hipY * 0.27, zRump - 0.05 * wither];
    const paw: V3 = [x, pawY, zRump - 0.01 * wither];
    bone(`${side}UpperLeg`, 'Hips', hip, stifle);
    bone(`${side}LowerLeg`, `${side}UpperLeg`, stifle, hock);
    bone(`${side}Foot`, `${side}LowerLeg`, hock, paw);
    bone(`${side}Toes`, `${side}Foot`, paw, add(paw, [0, 0, toeLen]));
    const sh: V3 = [x, chestY - bodyR * 0.4, zChest];
    const elbow: V3 = [x, chestY * 0.52, zChest - 0.17 * wither];
    const wrist: V3 = [x, 0.14 * wither, zChest - 0.02 * wither];
    const fpaw: V3 = [x, pawY, zChest + 0.01 * wither];
    bone(`${side}Shoulder`, 'UpperChest', [sx * 0.03 * wither, chestY, zChest + 0.02 * wither], sh);
    bone(`${side}UpperArm`, `${side}Shoulder`, sh, elbow);
    bone(`${side}LowerArm`, `${side}UpperArm`, elbow, wrist);
    bone(`${side}Hand`, `${side}LowerArm`, wrist, fpaw);
    // toes of the front paw stand in for the finger bones (hand poses curl them a little)
    for (const f of FINGER_NAMES) {
      const fz = { Thumb: 0.45, Index: 0.25, Middle: 0.05, Ring: -0.15, Little: -0.35 }[f]!;
      let at: V3 = [x + sx * fz * 0.03 * wither, pawY, fpaw[2] + 0.01 * wither];
      fingerBones(side, f).forEach((n, i) => { const end = add(at, [0, 0, toeLen * 0.25]); bone(n, i === 0 ? `${side}Hand` : fingerBones(side, f)[i - 1], at, end); at = end; });
    }
    // legs with mass: a muscled thigh (haunch) and upper arm that run up into the body, a gaskin and
    // forearm that taper, slim pasterns, and broad padded paws
    const t = 0.105 * wither * (0.8 + 0.4 * b), ft = t * 0.92;
    // an ellipsoid's points (side rx, along the bone ry, front-back rz), for hulls that taper smoothly
    const blob = (c: V3, along: V3, rx: number, ry: number, rz: number): V3[] => {
      const yv = norm(along), xv: V3 = [1, 0, 0], zv = norm(cross(xv, yv));
      const pts: V3[] = [];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) {
        const th = (Math.PI * (i + 0.5)) / 4, ph = (Math.PI * 2 * j) / 8;
        pts.push(add(c, add(add(mul(xv, rx * Math.sin(th) * Math.cos(ph)), mul(yv, ry * Math.cos(th))), mul(zv, rz * Math.sin(th) * Math.sin(ph)))));
      }
      return pts;
    };
    // the haunch: a broad, deep thigh (flattened side to side) that narrows into the stifle
    const thigh = sub(stifle, hip);
    pieces.push({ kind: 'hull', part: `${side}UpperLeg`, pts: [
      ...blob(add(lerpV(hip, stifle, 0.3), [sx * t * 0.05, 0, 0]), thigh, t * 1.0, len(thigh) * 0.42, t * 1.55),
      ...blob(lerpV(hip, stifle, 0.93), thigh, t * 0.5, t * 0.5, t * 0.56),
    ] });
    ball(stifle, t * 0.46, `${side}LowerLeg`); seg(stifle, hock, t * 0.54, t * 0.4, `${side}LowerLeg`);
    ball(hock, t * 0.42, `${side}Foot`); seg(hock, paw, t * 0.38, t * 0.34, `${side}Foot`);
    pieces.push({ kind: 'hull', part: `${side}Toes`, pts: pawPts(paw, t * 1.05, pawY, toeLen * 1.15) });
    // the upper arm: muscle from the shoulder down to the elbow
    const arm = sub(elbow, sh);
    pieces.push({ kind: 'hull', part: `${side}UpperArm`, pts: [
      ...blob(lerpV(sh, elbow, 0.3), arm, ft * 0.9, len(arm) * 0.4, ft * 1.3),
      ...blob(lerpV(sh, elbow, 0.92), arm, ft * 0.62, ft * 0.6, ft * 0.68),
    ] });
    ball(elbow, ft * 0.66, `${side}LowerArm`); seg(elbow, wrist, ft * 0.7, ft * 0.5, `${side}LowerArm`);
    ball(wrist, ft * 0.5, `${side}Hand`); seg(wrist, fpaw, ft * 0.47, ft * 0.43, `${side}Hand`);
    pieces.push({ kind: 'hull', part: `${side}Hand`, pts: pawPts(fpaw, ft * 1.05, pawY, toeLen * 1.15) });
  }
  // the barrel: elliptical rings along the spine (rump, loin, belly, deep chest, shoulders)
  const ringZ = (z: number, cy: number, rx: number, ryUp: number, ryDn: number, n = Math.max(10, SIDES + 2)): V3[] =>
    Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2, c = Math.cos(t); return [rx * Math.sin(t), cy + (c > 0 ? ryUp : ryDn) * c, z] as V3; });
  pieces.push({ kind: 'hull', part: 'torso', pts: [
    ...ringZ(zRump - 0.1 * wither, hipY - 0.02 * wither, bodyR * 0.7, bodyR * 0.7, bodyR * 0.75),
    ...ringZ(zRump + 0.04 * wither, hipY, bodyR * 0.95, bodyR * 0.88, bodyR * 0.95),
    ...ringZ((zRump + zChest) / 2, hipY - 0.01 * wither, bodyR * 0.9, bodyR * 0.85, bodyR * 0.95),
    ...ringZ(zChest - 0.04 * wither, chestY, bodyR * 1.0, bodyR * 0.95, bodyR * 1.28),
    ...ringZ(zChest + 0.11 * wither, chestY + 0.03 * wither, bodyR * 0.78, bodyR * 0.8, bodyR * 0.9),
  ] });
  seg(spinePts[4], add(headBase, [0, 0.01 * wither, -0.03 * wither]), bodyR * 0.78, headH * 0.3, 'Neck');
  const dims: QuadDims = { wither, hipY, chestY, zRump, zChest, bodyR, legX, legLen: hipY - pawY };
  const spec: CharSpec = {
    params: p, s, bones, pieces,
    head: { pts: faceSpec.head.pts.map(mv), ...(faceSpec.head.extra ? { extra: faceSpec.head.extra.map((h) => h.map(mv)) } : {}), refine: faceSpec.head.refine * (p.style === 'smooth' ? 1.2 : 1), part: 'Head' },
    cuts: faceSpec.cuts.map((c) => (c.kind === 'hull' ? { ...c, pts: c.pts.map(mv) } : { ...c, c: mv(c.c) })) as CharSpec['cuts'],
    mouth: faceSpec.mouth.map(mvPiece), eyes: faceSpec.eyes.map(mvPiece),
    lids: faceSpec.lids.map((l) => ({ ...l, c: mv(l.c) })),
    face: {
      ...faceSpec.face, headBase: mv(faceSpec.face.headBase), mouth: mv(faceSpec.face.mouth), jawPivot: mv(faceSpec.face.jawPivot),
      teeth: { ...faceSpec.face.teeth, upperFront: faceSpec.face.teeth.upperFront + dv[2], lowerFront: faceSpec.face.teeth.lowerFront + dv[2], edgeY: faceSpec.face.teeth.edgeY + dv[1] },
      tongue: { tipZ: faceSpec.face.tongue.tipZ + dv[2], backZ: faceSpec.face.tongue.backZ + dv[2] },
      eyes: faceSpec.face.eyes.map((e) => ({ ...e, c: mv(e.c) })), brows: faceSpec.face.brows.map(mv), nose: mv(faceSpec.face.nose), cheeks: faceSpec.face.cheeks.map(mv),
    },
    palm: Object.fromEntries((['Left', 'Right'] as const).map((side) => { const h = bones.find((x) => x.name === `${side}Hand`)!; return [side, { c: h.tail, len: 0.05 * wither, width: 0.05 * wither, thick: 0.02 * wither }]; })) as CharSpec['palm'],
    plan: 'quadruped', quad: dims,
  };
  if (p.tail !== false) addTail(spec.bones, spec.pieces, [0, hipY + 0.02 * wither, zRump - 0.12 * wither], [0, 0.55, -1], 0.6 * wither * (p.tailLength ?? 1), bodyR * 0.3, SIDES);
  if (p.wings) addWings(spec.bones, spec.pieces, [0, chestY + bodyR * 0.85, zChest - 0.05 * wither], 0.9 * wither, 0.28 * wither, 'UpperChest');
  return spec;
}

// ── motion ───────────────────────────────────────────────────────────────
/** Gaits by Froude number (v² / g·leg): stride and cadence follow leg length, as in real animals. */
export const QUAD_GAITS = {
  walk: { froude: 0.22, duty: 0.66, offsets: { LH: 0, LF: 0.25, RH: 0.5, RF: 0.75 }, lift: 0.1, bob: 0.012 },        // lateral sequence
  trot: { froude: 0.9, duty: 0.45, offsets: { LH: 0, RF: 0, RH: 0.5, LF: 0.5 }, lift: 0.16, bob: 0.03 },             // diagonal pairs
  gallop: { froude: 3.0, duty: 0.3, offsets: { LH: 0, RH: 0.1, RF: 0.45, LF: 0.55 }, lift: 0.22, bob: 0.035 },        // rotary gallop
} as const;
export type QuadGait = keyof typeof QUAD_GAITS;
type LegKey = 'LF' | 'RF' | 'LH' | 'RH';
const LEGS: Record<LegKey, { upper: string; lower: string; low: string; side: 'Left' | 'Right'; front: boolean }> = {
  LF: { upper: 'LeftUpperArm', lower: 'LeftLowerArm', low: 'LeftHand', side: 'Left', front: true },
  RF: { upper: 'RightUpperArm', lower: 'RightLowerArm', low: 'RightHand', side: 'Right', front: true },
  LH: { upper: 'LeftUpperLeg', lower: 'LeftLowerLeg', low: 'LeftFoot', side: 'Left', front: false },
  RH: { upper: 'RightUpperLeg', lower: 'RightLowerLeg', low: 'RightFoot', side: 'Right', front: false },
};

export interface QuadFrame { hips: V3; body: Record<string, Q>; paws: Record<LegKey, V3>; contact: Record<LegKey, boolean>; wag: number; cannon?: Partial<Record<LegKey, V3>> }

/** Two-bone IK in the leg's plane: world directions for the upper and lower bone reaching `target`
 *  from `root`, bending toward `bendDir` (forward for a hind stifle, back for an elbow). */
function twoBone(root: V3, target: V3, l1: number, l2: number, bendDir: V3): { d1: V3; d2: V3; miss: number } {
  const toT = sub(target, root);
  let dist = len(toT);
  const miss = Math.max(0, dist - (l1 + l2) * 0.999);
  dist = Math.min(dist, (l1 + l2) * 0.999); dist = Math.max(dist, Math.abs(l1 - l2) + 1e-4);
  const dir = norm(toT);
  const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  // the bend plane: contains dir and the bend hint
  let side = sub(bendDir, mul(dir, dot(bendDir, dir)));
  if (len(side) < 1e-6) side = [0, 0, 1];
  side = norm(side);
  const d1 = norm(add(mul(dir, Math.cos(a)), mul(side, Math.sin(a))));
  const knee = add(root, mul(d1, l1));
  const d2 = norm(sub(add(root, mul(dir, dist)), knee));
  return { d1, d2, miss };
}

export interface QuadClip { frames: number; duration: number; loop: boolean; speed: number; stride?: number; local: Q[][]; hips: V3[]; contacts: Record<LegKey, boolean[]>; paws: Record<LegKey, V3[]>; shapes: Record<string, number[]>; reachMiss: number }

export function bakeQuad(spec: MotionSpec, rig: Rig, state: CharacterState | undefined, fps = 30): QuadClip {
  const Q = rig.spec.quad!;
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  const B = (n: string) => rig.bones[idx.get(n)!];
  const has = (n: string) => idx.has(n);
  const legLen = Q.legLen, g = 9.81;
  const kind = spec.kind === 'run' ? 'gallop' : spec.kind;
  const en = spec.energy ?? 0.5;
  let frames: number, duration: number, loop = true, speed = 0, stride: number | undefined;
  let make: (t: number) => QuadFrame;
  const restPaw = (k: LegKey): V3 => { const L = LEGS[k]; return [...B(L.low).tail] as V3; };
  const zero = { LF: true, RF: true, LH: true, RH: true };
  if (kind === 'walk' || kind === 'trot' || kind === 'gallop') {
    const G = QUAD_GAITS[kind];
    const vA = Math.sqrt(G.froude * g * legLen), strideA = legLen * 2.3 * Math.pow(G.froude, 0.3);
    // Alexander's relative stride (2.3·Fr^0.3 leg lengths), capped so a planted paw never ranges more than
    // 0.31 leg lengths either side of the hip (no sliding shoulder blade here)
    stride = spec.stride ?? Math.min(strideA, (0.62 * legLen) / G.duty);
    // the stride frequency stays the animal's own (vA / strideA); a shorter stride means a slower gait
    const v = spec.speed ?? stride * (vA / strideA);
    frames = Math.max(12, Math.round((stride / v) * fps)); duration = frames / fps; speed = stride / duration;
    const duty = G.duty, lift = G.lift * legLen * (0.8 + 0.4 * en), bob = G.bob * legLen;
    make = (t) => {
      const p = t / duration;
      const paws = {} as Record<LegKey, V3>, contact = {} as Record<LegKey, boolean>;
      for (const k of Object.keys(LEGS) as LegKey[]) {
        const ph = (((p - (G.offsets as any)[k]) % 1) + 1) % 1;   // touches down at p = offset
        const r = restPaw(k);
        if (ph < duty) {
          const u = ph / duty;
          paws[k] = [r[0], r[1], r[2] + stride! * duty * (0.5 - u)];
          contact[k] = true;
        } else {
          const u = (ph - duty) / (1 - duty), e = ease(u);
          paws[k] = [r[0], r[1] + lift * Math.sin(Math.PI * u) ** 1.2, r[2] + stride! * duty * (-0.5 + e)];
          contact[k] = false;
        }
      }
      // the back rises and falls with the footfalls; a gallop rocks nose-up / nose-down
      const w = 2 * Math.PI * p;
      const rise = kind === 'walk' ? bob * Math.cos(2 * w) : bob * Math.cos(2 * w + 0.6);
      const pitch = kind === 'gallop' ? 4 * Math.sin(w) : kind === 'trot' ? 1.2 * Math.sin(2 * w) : 0.8 * Math.sin(2 * w);
      const flex = kind === 'gallop' ? 9 * Math.sin(w + 0.8) : 0;
      const roll = kind === 'walk' ? 2.5 * Math.sin(w) : kind === 'trot' ? 1.5 * Math.sin(2 * w) : 0;
      const body: Record<string, Q> = {
        Hips: qMul(X(pitch), Z(roll)), Spine: X(-flex * 0.5), Chest: X(flex * 0.5), UpperChest: X(-pitch * 0.4),
        // the head nods with the front legs at a walk and stays steadier at speed (the eyes hold the horizon)
        Neck: X(kind === 'walk' ? 4 * Math.sin(2 * w + 1) : -pitch * 0.6), Head: X(kind === 'walk' ? -2 * Math.sin(2 * w + 1) : -pitch * 0.3),
      };
      return { hips: [0, rise - { walk: 0.015, trot: 0.03, gallop: 0.03 }[kind] * legLen, 0], body, paws, contact, wag: kind === 'walk' ? 0.35 : 0.15 };
    };
  } else if (kind === 'idle') {
    duration = spec.duration ?? 6; frames = Math.round(duration * fps); duration = frames / fps;
    make = (t) => {
      const w = (2 * Math.PI * t) / duration, br = Math.sin(4 * w);
      const look = 18 * Math.sin(w + 0.4) * Math.max(0, Math.sin(w * 2 + 1)), nod = 5 * Math.sin(3 * w + 0.7);
      const paws = Object.fromEntries((Object.keys(LEGS) as LegKey[]).map((k) => [k, restPaw(k)])) as Record<LegKey, V3>;
      return { hips: [0.006 * Q.wither * Math.sin(w), -0.004 * Q.wither * Math.abs(Math.sin(w)), 0], body: { Chest: X(-0.8 * br), UpperChest: X(-0.6 * br), Neck: qMul(Y(look * 0.6), X(nod)), Head: qMul(Y(look * 0.4), X(-nod * 0.5)) }, paws, contact: { ...zero }, wag: 1 };
    };
  } else if (kind === 'sit' || kind === 'lie') {
    loop = false;
    duration = spec.duration ?? (kind === 'sit' ? 1.6 : 2.2); frames = Math.round(duration * fps); duration = frames / fps;
    const tSettle = kind === 'sit' ? 0.9 : 1.4, SIT_TILT = 55;
    make = (t) => {
      const u = ease(t / tSettle);
      const paws = Object.fromEntries((Object.keys(LEGS) as LegKey[]).map((k) => [k, restPaw(k)])) as Record<LegKey, V3>;
      let hips: V3, body: Record<string, Q>;
      const contact = { ...zero };
      let sitCannon: Partial<Record<LegKey, V3>> = {};
      if (kind === 'sit') {
        // haunches down, chest up: the back tips up about the rump, which slides forward under the body
        // so the chest stays over the planted front paws; the hind paws step in under the haunches
        const d = Q.zChest - Q.zRump, tilt = SIT_TILT * u;
        const drop = (Q.hipY - Q.bodyR * 1.15) * u, fwd = d * (1 - Math.cos((tilt * Math.PI) / 180));
        hips = [0, -drop, fwd];
        body = { Hips: X(-tilt), Spine: X(6 * u), Chest: X(10 * u), UpperChest: X(12 * u), Neck: X(8 * u), Head: X(10 * u) };
        const v = clamp((t - 0.15) / 0.5), lift = 0.06 * Q.wither * Math.sin(Math.PI * v);
        // the hocks come down to the ground: the cannon lies nearly flat, pointing forward
        const cannon = {} as Partial<Record<LegKey, V3>>;
        for (const k of ['LH', 'RH'] as const) { const r0 = norm(sub(B(LEGS[k].low).tail, B(LEGS[k].low).head)); cannon[k] = norm(add(mul(r0, 1 - ease(v)), mul([0, -0.18, 1], ease(v)))); }
        sitCannon = cannon;
        for (const k of ['LH', 'RH'] as const) { paws[k] = [paws[k][0] * (1 + 0.15 * ease(v)), paws[k][1] + lift, paws[k][2] + (d * (1 - Math.cos((SIT_TILT * Math.PI) / 180)) + 0.1 * Q.wither) * ease(v)]; contact[k] = v <= 0 || v >= 1; }
      } else {
        // lie down: the whole body lowers until the chest rests just above the ground, front legs reach forward
        const drop = (Q.chestY - Q.bodyR * 1.62) * u;
        hips = [0, -drop, 0];
        body = { Hips: X(-3 * u), Chest: X(2 * u), Neck: X(-12 * u), Head: X(14 * u) };
        const step = (k: LegKey, dx: number, dz: number, t0: number) => {
          const v = clamp((t - t0) / 0.4), lift = 0.08 * Q.wither * Math.sin(Math.PI * v);
          paws[k] = [paws[k][0] * (1 + dx * ease(v)), paws[k][1] + lift, paws[k][2] + dz * Q.wither * ease(v)];
          contact[k] = v <= 0 || v >= 1;
        };
        step('LF', 0, 0.14, 0.1); step('RF', 0, 0.14, 0.35); step('LH', 0.25, 0.22, 0.7); step('RH', 0.25, 0.22, 0.95);
      }
      const br = Math.sin((2 * Math.PI * t) / 1.6) * clamp((t - tSettle) / 0.4);
      body.Chest = qMul(body.Chest ?? qIdentity(), X(-0.8 * br));
      return { hips, body, paws, contact, wag: 0.5 * u, ...(kind === 'sit' ? { cannon: sitCannon } : {}) };
    };
  } else throw new Error(`a four-legged body can walk, trot, gallop (or run), idle, sit and lie down (not "${spec.kind}")`);

  // solve every frame: body bones, then each leg by IK, then tail and wings
  const local: Q[][] = [], hipsOut: V3[] = [], contacts = { LF: [] as boolean[], RF: [] as boolean[], LH: [] as boolean[], RH: [] as boolean[] }, pawsOut = { LF: [] as V3[], RF: [] as V3[], LH: [] as V3[], RH: [] as V3[] };
  let reachMiss = 0;
  const hipsHead = B('Hips').head;
  const nf = loop ? frames : frames + 1;
  const tailBones = rig.bones.filter((b) => /^Tail\d$/.test(b.name)).map((b) => idx.get(b.name)!);
  void state;
  // periodic rates in a loop (the tail wags, the wings beat a whole number of times per cycle)
  const per = (hz: number) => (loop ? Math.max(1, Math.round(hz * duration)) / duration : hz);
  const wagHz = per(1.6), flapHz = spec.flap ? per(spec.flap) : 0;
  const blinkAt = [0.31 * duration, 0.77 * duration];
  const blinkOf = (t: number) => Math.max(...blinkAt.map((b) => Math.max(0, 1 - Math.abs(t - b) / 0.09)));
  for (let f = 0; f <= nf - (loop ? 0 : 1); f++) {
    const t = Math.min(f / fps, duration);
    const fr = make(loop ? (f % frames) / fps : t);
    const L: Q[] = rig.bones.map(() => qIdentity());
    for (const [n, q] of Object.entries(fr.body)) if (has(n)) L[idx.get(n)!] = q;
    // the hips move by fr.hips: shift the hip bone head for FK (as clipPose does)
    const bones = rig.bones.map((b) => ({ ...b }));
    const descends = (i: number) => { for (let p = i; p >= 0; p = rig.parents[p]) if (rig.bones[p].name === 'Hips') return true; return false; };
    bones.forEach((b, i) => { if (descends(i)) { b.head = add(b.head, fr.hips); b.tail = add(b.tail, fr.hips); } });
    const body = forward(bones, rig.parents, L);
    for (const k of Object.keys(LEGS) as LegKey[]) {
      const LG = LEGS[k];
      const iu = idx.get(LG.upper)!, il = idx.get(LG.lower)!, iw = idx.get(LG.low)!;
      const up = rig.bones[iu], lo = rig.bones[il], low = rig.bones[iw];
      const root = body.worldP[iu];
      // keep the lowest segment (cannon / pastern) at its rest slant: the ankle sits above the paw by that offset
      // the cannon / pastern swings with the whole leg (as the leg line tips forward or back, it tips
      // with it), so the joints above don't have to fold to reach a paw out in front or behind
      const restLine = sub(low.tail, up.head), newLine = sub(fr.paws[k], root);
      const swing = qArcQ([0, restLine[1], restLine[2]], [0, newLine[1], newLine[2]]);
      const lowRest = sub(low.tail, low.head);
      const lowVec = fr.cannon?.[k] ? mul(norm(fr.cannon[k]!), len(lowRest)) : qRot(swing, lowRest);
      const ankle = sub(fr.paws[k], lowVec);
      const l1 = len(sub(up.tail, up.head)), l2 = len(sub(lo.tail, lo.head));
      // elbows fold back and down, stifles forward (the hint must stay off the leg line when a paw reaches forward)
      const bend: V3 = LG.front ? [0, -0.5, -1] : [0, -0.2, 1];
      const ik = twoBone(root, ankle, l1, l2, bend);
      reachMiss = Math.max(reachMiss, ik.miss); if (process.env.QDEBUG && ik.miss > 0.005) console.log(kind, f, k, ik.miss.toFixed(3), fr.paws[k].map((v) => v.toFixed(2)).join(","), root.map((v) => v.toFixed(2)).join(","));
      const pw = body.worldQ[rig.parents[iu]];
      const wUp = qArcQ(norm(sub(up.tail, up.head)), ik.d1);
      const wLo = qArcQ(norm(sub(lo.tail, lo.head)), ik.d2);
      L[iu] = qMul(qInv(pw), wUp);
      L[il] = qMul(qInv(wUp), wLo);
      L[iw] = qMul(qInv(wLo), fr.cannon?.[k] ? qArcQ(lowRest, lowVec) : swing);
      contacts[k].push(fr.contact[k]);
      pawsOut[k].push(fr.paws[k]);
    }
    // the tail: a travelling wave (a wag) plus a lag behind the body's rise and pitch
    tailBones.forEach((ti, i) => {
      const wag = fr.wag * 22 * Math.sin(2 * Math.PI * wagHz * t - i * 0.7) * (0.6 + 0.2 * i);
      const lag = -(fr.hips[1] / Math.max(0.05, Q.wither)) * 40 * (i + 1) * 0.5;
      L[ti] = qMul(Y(wag), X(lag));
    });
    applyWings(rig, idx, L, flapHz ? flapHz * t : undefined, t);
    for (const l of rig.spec.lids) { const i = idx.get(l.bone); if (i !== undefined) L[i] = X(l.closeDeg * blinkOf(t)); }
    local.push(L);
    hipsOut.push(fr.hips);
  }
  // blinks: two per loop, never on the frame a gait begins
  const shapes: Record<string, number[]> = { eyeBlinkLeft: [], eyeBlinkRight: [] };
  for (let f = 0; f < local.length; f++) {
    const bl = blinkOf(Math.min(f / fps, duration));
    shapes.eyeBlinkLeft.push(bl); shapes.eyeBlinkRight.push(bl);
  }
  void hipsHead;
  return { frames, duration, loop, speed, ...(stride ? { stride } : {}), local, hips: hipsOut, contacts, paws: pawsOut, shapes, reachMiss };
}

/** Wings on any body: folded along the back unless a flap cycle is running (flap = cycles elapsed). */
export function applyWings(rig: Rig, idx: Map<string, number>, L: Q[], flap: number | undefined, t: number) {
  if (!idx.has('LeftWing1')) return;
  for (const side of ['Left', 'Right'] as const) {
    const sx = side === 'Left' ? 1 : -1;
    const i1 = idx.get(`${side}Wing1`)!, i2 = idx.get(`${side}Wing2`)!;
    if (flap === undefined) {
      // folded: the wing turns on edge (feathers hanging down, leading edge on top), swings back and
      // lies along the side of the body, sloping down to the tail; the outer half follows on
      L[i1] = qMul(qMul(Y(sx * 78), Z(-sx * 32)), X(-90));
      L[i2] = Y(sx * 6);
    } else {
      // a flap: up-stroke slower than the down-stroke; the outer wing lags and tucks on the way up
      const ph = flap % 1, down = ph < 0.42, u = down ? ph / 0.42 : (ph - 0.42) / 0.58;
      const ang = down ? 72 - 110 * ease(u) : -38 + 110 * ease(u);
      L[i1] = qMul(Y(-sx * 16), Z(sx * ang));
      L[i2] = qMul(Z(sx * (down ? -12 * Math.sin(Math.PI * u) : 22 * Math.sin(Math.PI * u))), Y(sx * (down ? 4 : 26) * Math.sin(Math.PI * u)));
    }
  }
}

/** A tail on a biped: same wave-and-lag rule, applied to a baked clip. */
export function applyTail(rig: Rig, local: Q[][], hips: V3[], fps: number, wag = 0.6, loopLen?: number) {
  const tails = rig.bones.map((b, i) => (/^Tail\d$/.test(b.name) ? i : -1)).filter((i) => i >= 0);
  if (!tails.length) return;
  const s = rig.spec.s;
  const hz = loopLen ? Math.max(1, Math.round(1.2 * loopLen)) / loopLen : 1.2;
  for (let f = 0; f < local.length; f++) {
    const t = f / fps;
    // vertical speed of the hips (wrapping round in a loop, so the last frame meets the first)
    const fl = loopLen ? Math.round(loopLen * fps) : 0;
    const prev = f > 0 ? f - 1 : fl ? fl - 1 : -1;
    const vy = prev >= 0 ? (hips[f][1] - hips[prev][1]) * fps : 0;
    tails.forEach((ti, i) => { local[f][ti] = qMul(qMul(Y(wag * 16 * Math.sin(2 * Math.PI * hz * t - i * 0.7) * (0.5 + 0.25 * i)), X(-vy / Math.max(0.2, s) * 18 * (i + 1) * 0.4)), local[f][ti]); });
  }
}

// ── checks ───────────────────────────────────────────────────────────────
export interface QuadReport { slip: number; grounded: number; sag: number; reachMiss: number; footfalls: string; cadence?: number; pass: boolean; detail: string }
/** Planted paws don't slide, every paw in stance is on the ground, the back doesn't sag, legs reach. */
export function quadReport(rig: Rig, clip: MotionClip): QuadReport {
  const kind = clip.kind;
  const Q = rig.spec.quad!;
  const idx = new Map(rig.bones.map((b, i) => [b.name, i]));
  let slip = 0, grounded = 0, sag = 0;
  // sag: how far the middle of the back drops below the straight line from the rump to the withers
  // (a gallop may pitch and flex, but the back must not hang between the legs)
  const iH = idx.get('Hips')!, iS = idx.get('Chest')!, iU = idx.get('UpperChest')!;
  const below = (h: V3, m: V3, u: V3) => { const d = norm(sub(u, h)), up = norm(sub([0, 1, 0], mul(d, d[1]))); return -dot(sub(m, h), up); };
  const sag0 = below(rig.bones[iH].head, rig.bones[iS].head, rig.bones[iU].head);
  for (const k of ['LF', 'RF', 'LH', 'RH'] as LegKey[]) {
    let plant: V3 | null = null;
    const LG = LEGS[k], iw = idx.get(LG.low)!;
    for (let f = 0; f < clip.local.length; f++) {
      // the paw where the solved leg actually puts it (forward kinematics), in ground coordinates
      const bones = rig.bones.map((b) => ({ ...b }));
      const descends = (i: number) => { for (let p = i; p >= 0; p = rig.parents[p]) if (rig.bones[p].name === 'Hips') return true; return false; };
      bones.forEach((b, i) => { if (descends(i)) b.head = add(b.head, clip.hips[f]); });
      const P = forward(bones, rig.parents, clip.local[f]);
      const paw = add(P.worldP[iw], qRot(P.worldQ[iw], sub(rig.bones[iw].tail, rig.bones[iw].head)));
      const ground: V3 = clip.speed ? [paw[0], paw[1], paw[2] + (clip.speed * f) / clip.fps] : paw;
      if (clip.paws![k].down[f]) {
        grounded = Math.max(grounded, Math.abs(paw[1] - rig.bones[iw].tail[1]));
        if (plant) slip = Math.max(slip, Math.hypot(ground[0] - plant[0], ground[2] - plant[2])); else plant = ground;
      } else plant = null;
      if (k === 'LF') sag = Math.max(sag, below(P.worldP[iH], P.worldP[iS], P.worldP[iU]) - sag0);
    }
  }
  const W = Q.wither, fails: string[] = [];
  if (slip > 0.012 * W + 0.004) fails.push(`planted paws slide ${(slip * 1000).toFixed(0)} mm`);
  if (grounded > 0.01 * W + 0.004) fails.push(`a paw in stance floats ${(grounded * 1000).toFixed(0)} mm off the ground`);
  if (sag > 0.04 * W) fails.push(`the back sags ${(sag * 100).toFixed(1)} cm between the hips and the withers`);
  if (clip.reachMiss > 0.02 * W) fails.push(`a leg can't reach its paw by ${(clip.reachMiss * 100).toFixed(1)} cm`);
  const order = (['LH', 'LF', 'RH', 'RF'] as LegKey[]).map((k) => [k, clip.paws![k].down.findIndex((c, f) => c && f > 0 && !clip.paws![k].down[f - 1])] as const).filter(([, f]) => f >= 0).sort((a, b) => a[1] - b[1]).map(([k]) => k).join(' → ');
  const cadence = clip.speed ? Math.round((4 * 60) / clip.duration) : undefined;   // footfalls a minute
  return { slip, grounded, sag, reachMiss: clip.reachMiss, footfalls: order, ...(cadence ? { cadence } : {}), pass: !fails.length,
    detail: fails.length ? fails.join('; ') : `paws planted (slide ≤ ${(slip * 1000).toFixed(0)} mm), all four grounded in stance, the back holds its line (sags ≤ ${(sag * 100).toFixed(1)} cm)${order ? `; footfalls ${order}` : ''}${clip.speed ? `; ${clip.speed.toFixed(2)} m/s, ${clip.stride?.toFixed(2)} m stride` : ''}` };
}
