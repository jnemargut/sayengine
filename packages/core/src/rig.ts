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

/** Parameters of the humanoid template (all have defaults). */
export interface CharParams {
  height: number;      // m
  build: number;       // 0 slim … 1 broad
  headSize: number;    // × stylized head height (15 % of height)
  armLength: number;   // ×
  legLength: number;   // ×
  handSize: number;    // ×
  hair: 'short' | 'none';
}
export const CHAR_DEFAULTS: CharParams = { height: 1.75, build: 0.55, headSize: 1, armLength: 1, legLength: 1, handSize: 1, hair: 'short' };

export type Piece =
  | { kind: 'seg'; a: V3; b: V3; r1: number; r2: number; sides: number; part: string }
  | { kind: 'ball'; c: V3; r: number; sides: number; part: string; cap?: number }   // cap: keep z ≥ cap·r (a spherical cap facing +Z)
  | { kind: 'hull'; pts: V3[]; part: string };

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
}

export interface CharSpec {
  params: CharParams;
  s: number;                                              // height / 1.75
  bones: BoneDef[];
  pieces: Piece[];                                        // body + face attachments (unioned)
  head: { pts: V3[]; refine: number; part: string };      // faceted head hull, refined for the face shapes
  cuts: Array<{ kind: 'box'; c: V3; size: V3; part: string } | { kind: 'ball'; c: V3; r: number; sides: number; part: string } | { kind: 'hull'; pts: V3[]; part: string }>;
  mouth: Piece[];                                         // teeth rows and tongue: separate shells inside the mouth (upper teeth on the head, lower teeth and tongue on the jaw)
  eyes: Piece[];                                          // eyeballs (kept separate: they turn with the eye bones)
  lids: Array<{ c: V3; rIn: number; rOut: number; edgeDeg: number; closeDeg: number; part: string; bone: string }>; // eyelid shells (the lid bones turn them)
  face: FaceLandmarks;
  palm: Record<'Left' | 'Right', { c: V3; len: number; width: number; thick: number }>;
}

export function charParams(a: Partial<Record<keyof CharParams, unknown>>): CharParams {
  const n = (k: keyof CharParams, lo: number, hi: number) => {
    const v = a[k] === undefined ? (CHAR_DEFAULTS[k] as number) : Number(a[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`character ${k} must be between ${lo} and ${hi} (got ${a[k]})`);
    return v;
  };
  return {
    height: n('height', 0.5, 3), build: n('build', 0, 1), headSize: n('headSize', 0.7, 1.6),
    armLength: n('armLength', 0.7, 1.4), legLength: n('legLength', 0.7, 1.4), handSize: n('handSize', 0.6, 1.6),
    hair: a.hair === 'none' ? 'none' : 'short',
  };
}

/** The humanoid template: bones, pieces and face landmarks from the parameters. Faces +Z; its left is +X. */
export function characterSpec(p: CharParams): CharSpec {
  const s = p.height / 1.75, H = p.height, b = p.build;
  const headH = 0.165 * H * p.headSize, neckLen = 0.028 * H;
  const legTotal = 0.47 * H * p.legLength;
  const hipY = legTotal + 0.035 * s;
  const torsoLen = H - hipY - neckLen - headH;
  if (torsoLen < 0.2 * s) throw new Error('character proportions leave no room for a torso: lower headSize or legLength');
  const ankleY = 0.075 * s, kneeY = ankleY + (hipY - ankleY) * 0.48;
  const legX = 0.1 * s * (0.9 + 0.25 * b);
  const shoulderY = hipY + torsoLen * 0.95;
  const shW = 0.18 * s * (0.86 + 0.34 * b);
  const upperArm = 0.165 * H * p.armLength, lowerArm = 0.145 * H * p.armLength;
  const palmLen = 0.052 * H * p.handSize, palmW = 0.048 * H * p.handSize, palmT = 0.016 * H * p.handSize;
  const fingerLen = 0.046 * H * p.handSize;
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
  const hw = 0.5 * headH * 0.8, hd = 0.5 * headH * 0.92;
  // the head's profile rings: [height 0..1, half width, front depth, back depth] (× hw / hd)
  const headRings: Array<[number, number, number, number]> = [
    [0.0, 0.3, 0.6, 0.15], [0.1, 0.62, 0.86, 0.45], [0.27, 0.86, 0.97, 0.78], [0.5, 0.97, 0.97, 0.92], [0.7, 1.0, 0.9, 1.0], [0.88, 0.87, 0.74, 0.9], [1.0, 0.42, 0.34, 0.5],
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
  const eyeR = 0.14 * hw;
  const eyeY = headBaseY + 0.5 * headH;
  const eyeX = 0.37 * hw;
  const eyeZ = surfAt(0.5, eyeX) - 0.68 * eyeR;
  const mouthY = headBaseY + 0.24 * headH;
  const mouthZ = surfZ(0.24);
  const jawPivot: V3 = [0, headBaseY + 0.42 * headH, -0.08 * hd];
  bone('LeftEye', 'Head', [eyeX, eyeY, eyeZ], [eyeX, eyeY, eyeZ + eyeR]);
  bone('RightEye', 'Head', [-eyeX, eyeY, eyeZ], [-eyeX, eyeY, eyeZ + eyeR]);
  bone('Jaw', 'Head', jawPivot, [0, headBaseY + 0.05 * headH, surfZ(0.05)]);
  // eyelids turn about the eye centre (blinks are rotations: a shape key would cut through the eyeball)
  bone('LeftUpperLid', 'Head', [eyeX, eyeY, eyeZ], [eyeX, eyeY + eyeR, eyeZ]);
  bone('RightUpperLid', 'Head', [-eyeX, eyeY, eyeZ], [-eyeX, eyeY + eyeR, eyeZ]);
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
    const fingerZ: Record<string, number> = { Index: 0.37, Middle: 0.12, Ring: -0.13, Little: -0.37 };
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
  const seg = (a: V3, c: V3, r1: number, r2: number, part: string, sides = 8) => pieces.push({ kind: 'seg', a, b: c, r1, r2, sides, part });
  const ball = (c: V3, r: number, part: string, sides = 8) => pieces.push({ kind: 'ball', c, r, sides, part });
  const ring = (y: number, rx: number, rzF: number, rzB: number, n = 8, cx = 0, cz = 0): V3[] =>
    Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; const c = Math.cos(t); return [cx + rx * Math.sin(t), y, cz + (c > 0 ? rzF : rzB) * c] as V3; });
  // torso: hips → waist → chest → shoulders
  const tw = (0.86 + 0.3 * b) * s;
  pieces.push({ kind: 'hull', part: 'torso', pts: [
    ...ring(hipY - 0.07 * s, 0.165 * tw, 0.1 * s, 0.105 * s),
    ...ring(hipY + torsoLen * 0.35, 0.155 * tw, 0.11 * s * (0.85 + 0.4 * b), 0.1 * s),
    ...ring(hipY + torsoLen * 0.7, 0.185 * tw, 0.125 * s, 0.11 * s),
    ...ring(shoulderY + 0.012 * s, shW * 0.95, 0.085 * s, 0.085 * s),
    ...ring(shoulderY + 0.035 * s, shW * 0.45, 0.07 * s, 0.07 * s),
  ] });
  seg(add(B.Neck.head, [0, -0.02 * s, 0]), add(B.Head.head, [0, 0.03 * s, 0]), 0.056 * s * (0.9 + 0.25 * b), 0.05 * s, 'Neck');
  for (const side of ['Left', 'Right'] as const) {
    const ua = B[`${side}UpperArm`], la = B[`${side}LowerArm`], hd2 = B[`${side}Hand`];
    ball(add(ua.head, [-(side === 'Left' ? 1 : -1) * 0.01 * s, -0.022 * s, 0]), 0.052 * s * (0.8 + 0.4 * b), `${side}UpperArm`);
    seg(add(ua.head, [0, -0.012 * s, 0]), ua.tail, 0.052 * s * (0.8 + 0.42 * b), 0.046 * s * (0.85 + 0.3 * b), `${side}UpperArm`);
    ball(la.head, 0.046 * s * (0.85 + 0.3 * b), `${side}LowerArm`);
    seg(la.head, la.tail, 0.045 * s * (0.85 + 0.35 * b), 0.032 * s * (0.9 + 0.2 * b), `${side}LowerArm`);
    ball(hd2.head, 0.032 * s * (0.9 + 0.2 * b), `${side}Hand`, 6);
    // palm: a flattened box from wrist to knuckles
    const sx = side === 'Left' ? 1 : -1;
    const x0 = hd2.head[0], x1 = hd2.tail[0] - sx * 0.004 * s, y = hd2.head[1];
    pieces.push({ kind: 'hull', part: `${side}Hand`, pts: [
      [x0, y + palmT * 0.5, palmW * 0.36], [x0, y + palmT * 0.5, -palmW * 0.36], [x0, y - palmT * 0.5, palmW * 0.36], [x0, y - palmT * 0.5, -palmW * 0.36],
      [x1, y + palmT * 0.45, palmW * 0.5], [x1, y + palmT * 0.45, -palmW * 0.5], [x1, y - palmT * 0.5, palmW * 0.5], [x1, y - palmT * 0.5, -palmW * 0.5],
    ] });
    for (const f of FINGER_NAMES) {
      const names = fingerBones(side, f);
      const r0 = (f === 'Thumb' ? 0.0105 : f === 'Little' ? 0.0078 : 0.0092) * s * p.handSize;
      names.forEach((n, i) => {
        const bd = B[n];
        const r = r0 * (1 - i * 0.08);
        ball(bd.head, r * 1.04, n, 6);
        seg(bd.head, bd.tail, r, r * 0.92, n, 6);
        if (i === 2) ball(bd.tail, r * 0.9, n, 6);
      });
    }
    const ul = B[`${side}UpperLeg`], ll = B[`${side}LowerLeg`], ft = B[`${side}Foot`];
    seg(ul.head, ul.tail, 0.088 * s * (0.85 + 0.35 * b), 0.064 * s * (0.9 + 0.2 * b), `${side}UpperLeg`);
    ball(ll.head, 0.064 * s * (0.9 + 0.2 * b), `${side}LowerLeg`);
    seg(ll.head, ll.tail, 0.06 * s * (0.9 + 0.2 * b), 0.044 * s, `${side}LowerLeg`);
    ball(ft.head, 0.04 * s, `${side}Foot`);
    const fx = ft.head[0];
    pieces.push({ kind: 'hull', part: `${side}Foot`, pts: [
      [fx - 0.035 * s, ankleY + 0.02 * s, -0.045 * s], [fx + 0.035 * s, ankleY + 0.02 * s, -0.045 * s],
      [fx - 0.04 * s, 0, -0.055 * s], [fx + 0.04 * s, 0, -0.055 * s],
      [fx - 0.045 * s, 0, 0.1 * s], [fx + 0.045 * s, 0, 0.1 * s], [fx - 0.04 * s, 0.05 * s, 0.09 * s], [fx + 0.04 * s, 0.05 * s, 0.09 * s],
    ] });
    pieces.push({ kind: 'hull', part: `${side}Toes`, pts: [
      [fx - 0.045 * s, 0, 0.095 * s], [fx + 0.045 * s, 0, 0.095 * s], [fx - 0.04 * s, 0.045 * s, 0.09 * s], [fx + 0.04 * s, 0.045 * s, 0.09 * s],
      [fx - 0.038 * s, 0, 0.17 * s], [fx + 0.038 * s, 0, 0.17 * s], [fx - 0.03 * s, 0.028 * s, 0.165 * s], [fx + 0.03 * s, 0.028 * s, 0.165 * s],
    ] });
  }

  // ── head: a faceted hull, refined so the face can deform ──────────────
  const hb = headBaseY;
  const headPts: V3[] = headRings.flatMap(([y, rx, rf, rbk]) => ring(hb + y * headH, rx * hw, rf * hd, rbk * hd, 12));
  const slotH = 0.018 * headH;
  const mouthW = 0.3 * hw;
  // ── mouth: chamber, teeth and tongue (all relative to the lip surface a = mouthZ, in head heights) ──
  const a = mouthZ, Hh = headH, my = mouthY;
  const chamberPts: V3[] = [];
  for (const sx of [1, -1]) {
    chamberPts.push(
      [sx * 0.105 * Hh, my + 0.05 * Hh, a - 0.075 * Hh], [sx * 0.11 * Hh, my, a - 0.072 * Hh], [sx * 0.085 * Hh, my - 0.072 * Hh, a - 0.09 * Hh],
      [sx * 0.13 * Hh, my + 0.035 * Hh, a - 0.125 * Hh], [sx * 0.135 * Hh, my, a - 0.125 * Hh], [sx * 0.1 * Hh, my - 0.066 * Hh, a - 0.125 * Hh],
      [sx * 0.1 * Hh, my + 0.045 * Hh, a - 0.22 * Hh], [sx * 0.1 * Hh, my - 0.068 * Hh, a - 0.22 * Hh],
    );
  }
  chamberPts.push([0, my + 0.05 * Hh, a - 0.03 * Hh], [0, my, a - 0.03 * Hh], [0, my - 0.072 * Hh, a - 0.055 * Hh]);
  const arch = 3.5 / Hh;                                   // the teeth follow a curve: z drops by arch·x² toward the sides
  const upperFront = a - 0.045 * Hh, lowerFront = upperFront - 0.013 * Hh, edgeY = my - 0.014 * Hh;
  const mouthPieces: Piece[] = [];
  const toothRow = (part: string, front: number, thick: number, top: (i: number) => number, bottom: (i: number) => number, widths: number[]) => {
    // one block per tooth, centre outwards on both sides, following the arch, with hairline gaps
    const gap = 0.0016 * Hh;
    for (const sx of [1, -1]) {
      let x = gap / 2;
      widths.forEach((w, i) => {
        const x0 = x, x1 = x + w * Hh;
        x = x1 + gap;
        const z = (xx: number) => front - arch * xx * xx;
        const yT = top(i), yB = bottom(i), inset = 0.0025 * Hh;  // the biting edge is a little thinner
        const pts: V3[] = [];
        for (const xx of [x0, x1]) {
          pts.push([sx * xx, yT, z(xx)], [sx * xx, yT, z(xx) - thick], [sx * xx, yB, z(xx) - inset * 0.3], [sx * xx, yB, z(xx) - thick + inset]);
        }
        mouthPieces.push({ kind: 'hull', part, pts });
      });
    }
  };
  // upper: central incisors longest, then laterals, canines, a premolar
  const upLen = [0, 0.004, 0.001, 0.004, 0.006];
  toothRow('teethUpper', upperFront, 0.011 * Hh, () => my + 0.03 * Hh, (i) => edgeY + upLen[i] * Hh, [0.023, 0.019, 0.02, 0.022, 0.02]);
  const loLen = [0, 0.001, 0.003, 0.005, 0.007];
  toothRow('teethLower', lowerFront, 0.01 * Hh, (i) => my + 0.004 * Hh - loLen[i] * Hh, () => my - 0.034 * Hh, [0.016, 0.016, 0.018, 0.02, 0.02]);
  // the tongue: a low, rounded wedge on the floor of the mouth, tip just behind the lower teeth
  const tipZ = lowerFront - 0.022 * Hh, backZ = a - 0.19 * Hh;
  const tongue: V3[] = [];
  for (const sx of [1, -1]) {
    tongue.push(
      [sx * 0.012 * Hh, my - 0.031 * Hh, tipZ], [sx * 0.03 * Hh, my - 0.036 * Hh, tipZ - 0.012 * Hh], [sx * 0.02 * Hh, my - 0.046 * Hh, tipZ - 0.004 * Hh],
      [sx * 0.05 * Hh, my - 0.028 * Hh, tipZ - 0.05 * Hh], [sx * 0.055 * Hh, my - 0.05 * Hh, tipZ - 0.05 * Hh],
      [sx * 0.05 * Hh, my - 0.03 * Hh, backZ], [sx * 0.055 * Hh, my - 0.052 * Hh, backZ],
    );
  }
  tongue.push([0, my - 0.024 * Hh, tipZ - 0.06 * Hh], [0, my - 0.03 * Hh, tipZ + 0.002 * Hh]);
  mouthPieces.push({ kind: 'hull', part: 'tongue', pts: tongue });
  const cuts: CharSpec['cuts'] = [
    { kind: 'box', c: [0, mouthY, mouthZ - 0.018 * headH], size: [2 * mouthW, slotH, 0.06 * headH], part: 'mouthInner' },
    // the mouth itself: a chamber behind the lips (the slot opens into it), roomy enough for teeth and a tongue
    { kind: 'hull', part: 'mouthInner', pts: chamberPts },
    { kind: 'ball', c: [eyeX, eyeY, eyeZ], r: eyeR * 1.13, sides: 24, part: 'eyeSocket' },
    { kind: 'ball', c: [-eyeX, eyeY, eyeZ], r: eyeR * 1.13, sides: 24, part: 'eyeSocket' },
  ];
  // nose, brows, lips, ears, hair
  const nb = surfZ(0.42);
  pieces.push({ kind: 'hull', part: 'nose', pts: [[0, hb + 0.5 * headH, nb - 0.01 * headH], [0.06 * hw, hb + 0.49 * headH, nb - 0.02 * headH], [-0.06 * hw, hb + 0.49 * headH, nb - 0.02 * headH], [0, hb + 0.35 * headH, nb + 0.1 * headH], [0.07 * hw, hb + 0.34 * headH, nb + 0.075 * headH], [-0.07 * hw, hb + 0.34 * headH, nb + 0.075 * headH], [0.17 * hw, hb + 0.32 * headH, nb - 0.005 * headH], [-0.17 * hw, hb + 0.32 * headH, nb - 0.005 * headH], [0, hb + 0.31 * headH, nb + 0.05 * headH]] });
  const browY = eyeY + eyeR * 1.75;
  const browZ = surfAt(0.62, 0.38 * hw) + 0.006 * headH;
  const brows: V3[] = [];
  for (const sx of [1, -1]) {
    const x0 = sx * 0.15 * hw, x1 = sx * 0.6 * hw;
    brows.push([(x0 + x1) / 2, browY, browZ]);
    pieces.push({ kind: 'hull', part: sx > 0 ? 'brow.L' : 'brow.R', pts: [
      [x0, browY - 0.008 * headH, browZ - 0.015 * headH], [x0, browY + 0.032 * headH, browZ - 0.015 * headH], [x0, browY - 0.008 * headH, browZ + 0.012 * headH], [x0, browY + 0.032 * headH, browZ + 0.008 * headH],
      [x1, browY - 0.01 * headH, browZ - 0.03 * headH], [x1, browY + 0.022 * headH, browZ - 0.03 * headH], [x1, browY - 0.01 * headH, browZ - 0.004 * headH], [x1, browY + 0.022 * headH, browZ - 0.008 * headH],
    ] });
    pieces.push({ kind: 'hull', part: sx > 0 ? 'ear.L' : 'ear.R', pts: [
      [sx * hw * 0.92, hb + 0.38 * headH, -0.02 * hd], [sx * hw * 0.92, hb + 0.62 * headH, -0.06 * hd], [sx * hw * 1.08, hb + 0.4 * headH, -0.08 * hd], [sx * hw * 1.1, hb + 0.6 * headH, -0.14 * hd], [sx * hw * 0.95, hb + 0.5 * headH, -0.22 * hd],
    ] });
  }
  for (const [name, dy] of [['lipUpper', 1], ['lipLower', -1]] as const) {
    const y = mouthY + dy * (slotH / 2 + 0.008 * headH);
    const z = mouthZ - 0.006 * headH;
    const r = 0.012 * headH;
    pieces.push({ kind: 'hull', part: name, pts: [
      [-mouthW * 1.02, mouthY + dy * slotH * 0.12, z - r], [mouthW * 1.02, mouthY + dy * slotH * 0.12, z - r],
      [-mouthW * 0.85, y, z + r * 0.7], [mouthW * 0.85, y, z + r * 0.7], [-mouthW * 0.6, y + dy * r * 0.8, z + r * 0.3], [mouthW * 0.6, y + dy * r * 0.8, z + r * 0.3],
      [0, y + dy * r * 0.5, z + r * 0.9], [-mouthW * 0.95, y + dy * r * 0.9, z - r * 0.6], [mouthW * 0.95, y + dy * r * 0.9, z - r * 0.6],
      // the inner edge has vertices along it, so the opening can curve (O, OO) instead of staying a straight slot
      [-mouthW * 0.55, mouthY + dy * slotH * 0.12, z - r * 0.35], [mouthW * 0.55, mouthY + dy * slotH * 0.12, z - r * 0.35], [0, mouthY + dy * slotH * 0.12, z - r * 0.2],
    ] });
  }
  if (p.hair === 'short') {
    const c: V3 = [0, hb + 0.55 * headH, 0];
    const top = headPts.filter((q) => q[1] >= hb + 0.62 * headH && !(q[2] > 0.5 * hd && q[1] < hb + 0.8 * headH));
    pieces.push({ kind: 'hull', part: 'hair', pts: top.map((q) => add(c, mul(subv(q, c), 1.07))).concat([[0, hb + 0.66 * headH, -hd * 1.06], [hw * 0.9, hb + 0.5 * headH, -hd * 0.6], [-hw * 0.9, hb + 0.5 * headH, -hd * 0.6]]) });
  }
  // eyeballs: white, iris, pupil; separate from the head so they can turn
  const eyes: Piece[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const c = B[`${side}Eye`].head;
    // iris and pupil: thin caps just proud of the eyeball, cut by planes (clean round edges; a union
    // of offset low-poly spheres gives star-shaped ones). Iris ≈ 36° from the axis, pupil ≈ 16°;
    // only the cap is kept, so the finer tessellation costs a few dozen triangles.
    eyes.push({ kind: 'ball', c, r: eyeR, sides: 24, part: `${side}Eye` });
    eyes.push({ kind: 'ball', c, r: eyeR * 1.01, sides: 48, cap: Math.cos((36 * Math.PI) / 180), part: `${side}Eye.iris` });
    eyes.push({ kind: 'ball', c, r: eyeR * 1.02, sides: 96, cap: Math.cos((16 * Math.PI) / 180), part: `${side}Eye.pupil` });
  }
  // eyelids: thin shells in the gap between eyeball and socket; at rest the edge sits just under the
  // socket's upper rim (a calm, slightly hooded eye); a blink turns the shell down over the eyeball
  const rimTop = (Math.atan2(Math.sqrt(1.13 ** 2 - 0.68 ** 2), 0.68) * 180) / Math.PI;
  const lids = (['Left', 'Right'] as const).map((side) => ({ c: B[`${side}Eye`].head, rIn: eyeR * 1.05, rOut: eyeR * 1.105, edgeDeg: rimTop - 18, closeDeg: rimTop - 18 + rimTop + 4, part: `lid.${side[0]}`, bone: `${side}UpperLid` }));
  const palm = Object.fromEntries((['Left', 'Right'] as const).map((side) => [side, { c: [B[`${side}Hand`].head[0] + (side === 'Left' ? 1 : -1) * palmLen * 0.5, B[`${side}Hand`].head[1], 0] as V3, len: palmLen, width: palmW, thick: palmT }])) as CharSpec['palm'];
  return {
    params: p, s, bones, pieces, head: { pts: headPts, refine: 0.012 * s, part: 'Head' }, cuts, mouth: mouthPieces, eyes, lids, palm,
    face: {
      headBase: [0, hb, 0], headH, hw, hd,
      mouth: [0, mouthY, mouthZ], mouthW, slotH, jawPivot,
      teeth: { upperFront, lowerFront, edgeY, arch }, tongue: { tipZ, backZ },
      eyes: [{ c: B.LeftEye.head, r: eyeR, side: 'Left' }, { c: B.RightEye.head, r: eyeR, side: 'Right' }],
      brows, nose: [0, hb + 0.35 * headH, nb + 0.1 * headH],
      cheeks: [[0.55 * hw, hb + 0.35 * headH, surfAt(0.35, 0.55 * hw)], [-0.55 * hw, hb + 0.35 * headH, surfAt(0.35, 0.55 * hw)]],
    },
  };
}

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

/** Parts that belong to the face (deformed by shape keys, weighted to Head/Jaw). */
export const isFacePart = (part: string) => /^(Head|mouthInner|eyeSocket|nose|brow\.|lip|lid\.|ear\.|hair|teeth|tongue)/.test(part);
/** Teeth and tongue: rigid shells inside the mouth (only the jaw and the tongue's own shapes move them). */
export const isMouthPart = (part: string) => part === 'teethUpper' || part === 'teethLower' || part === 'tongue';
/** Parts carried by the jaw outright. */
const onJaw = (part: string) => part === 'teethLower' || part === 'tongue';
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
  const prim = (fn: (p: V3, v: number) => V3 | null, inside = false) => {
    const d = new Float32Array(n * 3);
    for (const v of face) { if (!inside && isMouthPart(vertPart[v])) continue; const r = fn(P(v), v); if (r) d.set(r, v * 3); }
    return d;
  };
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
    const w = onJaw(vertPart[v]) ? 1 : vertPart[v] === 'teethUpper' ? 0 : lower * sideFade * smooth(-0.6 * F.hd, -0.1 * F.hd, p[2]);
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
  for (const vname of VISEMES) out[vname] = mix(VISEME_MIX[vname]);
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
  out.mouthPucker = mix({ round: 1.15 });
  out.mouthClose = mix({ press: 1 });
  out.jawOpen = mix({ jaw: 1 });
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
    for (const k of kids(base)) if (!/Eye|Jaw/.test(k)) set.add(k);
    if (/Hand$/.test(base)) for (const k of kids(base)) set.add(k);
    if (/UpperLeg$/.test(base)) set.add('Hips');
    return [...set].map(id);
  }
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
    if (part !== 'torso') return 1;
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
      const lower = onJaw(part) || part === 'lipLower' ? 1 : part === 'lipUpper' || part === 'teethUpper' ? 0 : below * (1 - smooth(0.75 * F.hw, 1.05 * F.hw, Math.abs(p[0]))) * smooth(-0.6 * F.hd, -0.1 * F.hd, p[2]);
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
  const shapes = faceShapes(spec, pos, vertPart);
  return { bones, parents: bones.map((b) => (b.parent ? byName.get(b.parent)! : -1)), joints, weights, shapes, shapeNames: [...SHAPE_KEYS], spec };
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
export function poseChecks(rig: Rig, rest: Float32Array, indices: Uint32Array, vertPart: string[]): PoseCheck[] {
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
  const NEIGHBOURS = new Set(['LH|LLA', 'RH|RLA', 'LLA|LUA', 'RLA|RUA', 'LUA|T', 'RUA|T', 'LLL|LUL', 'RLL|RUL', 'LUL|T', 'RUL|T', 'H|T', 'LUL|RUL', 'LLL|RLL']);
  const triRegion: string[] = [];
  const clothTri: boolean[] = [];
  for (let t = 0; t < indices.length / 3; t++) {
    const v = indices[t * 3];
    clothTri.push(!isKitPart(vertPart[v]));
    triRegion.push(region(dominant[v]));
  }
  const out: PoseCheck[] = [];
  for (const [name, pose] of Object.entries(CANONICAL_POSES)) {
    const local = rig.bones.map((b) => (pose[b.name] ? qEuler(pose[b.name]) : qIdentity()));
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
      for (let jj = j - 3; jj <= j + 3; jj++) for (let ii = i - 1; ii <= i + 1; ii++) if (ii >= 0 && ii < XB && jj >= 0 && jj < YB) f = Math.max(f, grid[jj * XB + ii]);
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
