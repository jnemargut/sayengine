// Creatures from rig parts (Decision 52 A): ready-made part combos, their low-poly meshes, and a
// glTF export where every piece rides its bone as a node — TRS animation that Godot's importer and
// three.js's GLTFLoader both play without skinning. DOM-free.
import { GlbBuilder } from './glb.ts';
import { qAxisAngle, qIdentity, qMul, qRot, type Q, type V3 } from './rig.ts';
import { qArc } from './motion.ts';
import { bakeCreature, buildCreature, creatureChecks, terrainHeight, type Creature, type CreatureClip, type CreatureDef, type CreatureMotion, type MotionCheck, type PartShape, type PartSpec } from './rigparts.ts';

const TAU = Math.PI * 2;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ── presets: part combos ─────────────────────────────────────────────────────────────────────────

export interface CreaturePreset { def: CreatureDef; motions: Record<string, CreatureMotion>; describe: string }

export const CREATURE_PRESETS: Record<string, () => CreaturePreset> = {
  /** Six legs and a whip tail: a robot crab that walks sideways on alternating tripods. */
  crab: () => ({
    describe: 'a six-legged robot crab with a whip tail (legs ×6 + chain + two spring antennae)',
    def: {
      name: 'Robot Crab',
      parts: [
        { kind: 'body', shape: 'box', size: [0.46, 0.16, 0.36], height: 0.24, color: '#c65d3b', style: { bob: 0.01 } },
        { kind: 'legs', id: 'legs', count: 6, upper: 0.2, lower: 0.28, spread: 0.24, span: 0.8, kneeUp: 0.11, radius: 0.022, color: '#3b3f46', lift: 0.32 },
        { kind: 'chain', id: 'tail', at: [0, 0.27, -0.17], dir: [0, 0.35, -1], length: 0.62, segments: 7, r0: 0.03, r1: 0.008, color: '#3b3f46', motion: 'whip', plane: 'yaw', amp: 70, freq: 0.9 },
        { kind: 'spring', id: 'antenna.L', at: [0.08, 0.32, 0.17], dir: [0.25, 1, 0.5], length: 0.16, r: 0.007, color: '#e7c35a', hz: 2.4, damp: 0.18 },
        { kind: 'spring', id: 'antenna.R', at: [-0.08, 0.32, 0.17], dir: [-0.25, 1, 0.5], length: 0.16, r: 0.007, color: '#e7c35a', hz: 2.4, damp: 0.18 },
        { kind: 'hinge', id: 'eyes', at: [0, 0.33, 0.17], axis: [0, 1, 0], shapes: [{ shape: { kind: 'box', c: [0, 0.335, 0.175], size: [0.2, 0.045, 0.05] }, color: '#2b2f36' }, { shape: { kind: 'ball', c: [0.06, 0.34, 0.2], r: 0.022, sides: 8 }, color: '#7fe0ff' }, { shape: { kind: 'ball', c: [-0.06, 0.34, 0.2], r: 0.022, sides: 8 }, color: '#7fe0ff' }], motion: { kind: 'swing', min: -20, max: 20, period: 2.6 }, limit: { min: -25, max: 25 } },
      ],
    },
    motions: { walk: { kind: 'walk', speed: 0.32, dir: [1, 0, 0] }, idle: { kind: 'idle', duration: 2.6 } },
  }),
  /** A snake: a small head and a long ground chain that carries it in serpentine waves. */
  snake: () => ({
    describe: 'a snake (head + a 16-segment ground chain, serpentine)',
    def: {
      name: 'Snake',
      parts: [
        { kind: 'body', shape: 'capsule', size: [0.075, 0.06, 0.13], height: 0.035, color: '#5d8a3f' },
        { kind: 'chain', id: 'spine', at: [0, 0.035, -0.06], dir: [0, 0, -1], length: 1.45, segments: 16, r0: 0.036, r1: 0.008, color: '#6f9c48', motion: 'serpent', ground: true, wavelength: 0.8, amp: 0.13 },
      ],
    },
    motions: { slither: { kind: 'slither', speed: 0.32 } },
  }),
  /** A little car on springy suspension, driving a bumpy road. */
  car: () => ({
    describe: 'a small car: body + four wheels on springy suspension (wheels part) over a bumpy road',
    def: {
      name: 'Little Car',
      parts: [
        { kind: 'body', shape: 'box', size: [0.9, 0.32, 1.7], height: 0.46, color: '#2f6f9f' },
        { kind: 'wheels', id: 'wheels', axles: [{ z: 0.56, track: 0.98, r: 0.19, w: 0.14 }, { z: -0.56, track: 0.98, r: 0.19, w: 0.14 }], ride: 0.27, travel: 0.07, hz: 1.7, damp: 0.5, color: '#24262a', hub: '#c9c2b4' },
        { kind: 'hinge', id: 'cabin', at: [0, 0.62, -0.1], axis: [1, 0, 0], shapes: [{ shape: { kind: 'box', c: [0, 0.74, -0.12], size: [0.78, 0.26, 0.82] }, color: '#e9e2d4' }, { shape: { kind: 'box', c: [0, 0.75, 0.25], size: [0.7, 0.18, 0.04] }, color: '#9ec7dd' }], motion: { kind: 'still' }, limit: { min: -2, max: 2 } },
        { kind: 'spring', id: 'aerial', at: [0.32, 0.86, -0.42], dir: [0, 1, -0.15], length: 0.34, r: 0.006, color: '#d9d4c8', hz: 2.1, damp: 0.16 },
      ],
      terrain: { period: 9.55, bumps: [{ amp: 0.035, k: 3, kx: 2.2 }, { amp: 0.022, k: 7, phase: 1.3 }, { amp: 0.012, k: 13, phase: 0.4, kx: 5 }], color: '#9a8f78' },
    },
    motions: { drive: { kind: 'drive', speed: 1.6 } },
  }),
  /** A windmill: four sails on a spinning hub, a cap that turns into the wind, grass swaying around it. */
  windmill: () => ({
    describe: 'a windmill: a spinning sail hinge, a cap hinge that turns within limits, and swaying grass',
    def: {
      name: 'Windmill',
      parts: [
        { kind: 'body', shape: 'box', size: [0.9, 2.2, 0.9], height: 1.1, color: '#d9cdb4' },
        { kind: 'hinge', id: 'cap', at: [0, 2.2, 0], axis: [0, 1, 0], shapes: [{ shape: { kind: 'box', c: [0, 2.42, 0.05], size: [1.0, 0.44, 1.1] }, color: '#7b4b33' }], motion: { kind: 'swing', min: -12, max: 12, period: 8 }, limit: { min: -15, max: 15 } },
        { kind: 'hinge', id: 'sails', parent: 'cap', at: [0, 2.42, 0.62], axis: [0, 0, 1], shapes: [
          { shape: { kind: 'ball', c: [0, 2.42, 0.64], r: 0.09, sides: 10 }, color: '#4a3528' },
          ...[0, 90, 180, 270].map((deg) => {
            const a = (deg * Math.PI) / 180, d: V3 = [Math.cos(a), Math.sin(a), 0];
            return { shape: { kind: 'blade' as const, a: add([0, 2.42, 0.66], mul(d, 0.1)), b: add([0, 2.42, 0.66], mul(d, 1.25)), w: 0.26 }, color: '#efe6d2' };
          }),
          ...[0, 90, 180, 270].map((deg) => {
            const a = (deg * Math.PI) / 180, d: V3 = [Math.cos(a), Math.sin(a), 0];
            return { shape: { kind: 'seg' as const, a: add([0, 2.42, 0.67], mul(d, 0.05)), b: add([0, 2.42, 0.67], mul(d, 1.3)), r1: 0.02, r2: 0.014, sides: 5 }, color: '#5b3b29' };
          }),
        ], motion: { kind: 'spin', rpm: 15 } },
        { kind: 'sway', id: 'grass', area: [-1.6, -1.6, 1.6, 1.6], count: 70, height: 0.32, width: 0.05, wind: [1, 0, 0.3], strength: 16, color: '#6f9a43', seed: 11 },
      ],
    },
    motions: { turn: { kind: 'idle', duration: 4 } },
  }),
};

/** The parts every existing body plan is made of (re-expressed; the character kit still builds them). */
export const BODY_PLAN_PARTS: Record<string, Array<{ kind: PartSpec['kind'] | 'arm' | 'face'; id: string; note: string }>> = {
  human: [
    { kind: 'legs', id: 'legs', note: '×2, knees forward; the walk/run gait planner (motion.ts) plants the feet' },
    { kind: 'chain', id: 'spine', note: 'Hips → Spine → Chest → UpperChest → Neck → Head (lean, breathing, look)' },
    { kind: 'arm', id: 'arms', note: '×2 two-bone limbs with full fingers (hands as settings, grips)' },
    { kind: 'face', id: 'face', note: 'face parts with their own 15 speech shapes + expressions' },
    { kind: 'spring', id: 'apron', note: 'apron bones (spring bones), when the character wears one' },
  ],
  chibi: [{ kind: 'legs', id: 'legs', note: '×2 (bounce gait)' }, { kind: 'chain', id: 'spine', note: 'short spine, big head' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }],
  lanky: [{ kind: 'legs', id: 'legs', note: '×2 (long stride)' }, { kind: 'chain', id: 'spine', note: 'long spine' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }],
  stocky: [{ kind: 'legs', id: 'legs', note: '×2 (swagger gait)' }, { kind: 'chain', id: 'spine', note: 'barrel spine' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }, { kind: 'spring', id: 'apron', note: 'apron bones' }],
  beaked: [{ kind: 'legs', id: 'legs', note: '×2 (waddle; bird legs optional)' }, { kind: 'chain', id: 'spine', note: 'spine + long neck' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'beak mouth part' }, { kind: 'chain', id: 'wings', note: 'wings: folded/flap pose set (optional)' }, { kind: 'chain', id: 'tail', note: 'tail chain (optional, spring-driven)' }],
  quadruped: [{ kind: 'legs', id: 'legs', note: '×4, walk/trot/gallop footfall order (quadruped.ts)' }, { kind: 'chain', id: 'spine', note: 'spine + neck + head' }, { kind: 'chain', id: 'tail', note: 'tail chain: lags and wags' }, { kind: 'face', id: 'face', note: 'muzzle mouth part' }],
};

export function creatureFromPreset(name: string): CreaturePreset {
  const p = CREATURE_PRESETS[name];
  if (!p) throw new Error(`no creature preset "${name}" (presets: ${Object.keys(CREATURE_PRESETS).join(', ')})`);
  return p();
}

// ── low-poly meshes (flat-shaded triangles, object space) ───────────────────────────────────────

export interface TriMesh { pos: number[]; idx: number[] }

function basis(z: V3): [V3, V3, V3] {
  const zz = norm(z);
  const helper: V3 = Math.abs(zz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = norm(cross(helper, zz));
  const y = cross(zz, x);
  return [x, y, zz];
}

/** A closed triangle mesh for a shape (object space). */
export function shapeMesh(s: PartShape): TriMesh {
  const pos: number[] = [], idx: number[] = [];
  const v = (p: V3) => { pos.push(p[0], p[1], p[2]); return pos.length / 3 - 1; };
  const tri = (a: number, b: number, c: number) => idx.push(a, b, c);
  const ring = (c: V3, x: V3, y: V3, r: number, n: number, rot = 0) => Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n + rot; return v(add(c, add(mul(x, Math.cos(a) * r), mul(y, Math.sin(a) * r)))); });
  switch (s.kind) {
    case 'box': {
      const [hx, hy, hz] = s.size.map((x) => x / 2);
      const c = s.c;
      const P = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(([a, b, d]) => v([c[0] + a * hx, c[1] + b * hy, c[2] + d * hz]));
      const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
      for (const [a, b, c2, d] of F) { tri(P[a], P[b], P[c2]); tri(P[a], P[c2], P[d]); }
      break;
    }
    case 'seg': {
      const n = s.sides ?? 8;
      const [x, y, z] = basis(sub(s.b, s.a));
      const A = ring(s.a, x, y, s.r1, n), B = ring(s.b, x, y, s.r2, n);
      const ca = v(s.a), cb = v(s.b);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]);
        tri(ca, A[j], A[i]); tri(cb, B[i], B[j]);
      }
      void z;
      break;
    }
    case 'ball': {
      const n = s.sides ?? 10, rings = Math.max(3, Math.round(n / 2));
      const k = s.scale ?? [1, 1, 1];
      const top = v([s.c[0], s.c[1] + s.r * k[1], s.c[2]]), bot = v([s.c[0], s.c[1] - s.r * k[1], s.c[2]]);
      const R: number[][] = [];
      for (let j = 1; j < rings; j++) {
        const th = (Math.PI * j) / rings;
        R.push(Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n; return v([s.c[0] + Math.sin(th) * Math.cos(a) * s.r * k[0], s.c[1] + Math.cos(th) * s.r * k[1], s.c[2] + Math.sin(th) * Math.sin(a) * s.r * k[2]]); }));
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(top, R[0][j], R[0][i]);
        for (let r = 0; r < R.length - 1; r++) { tri(R[r][i], R[r][j], R[r + 1][j]); tri(R[r][i], R[r + 1][j], R[r + 1][i]); }
        tri(bot, R[R.length - 1][i], R[R.length - 1][j]);
      }
      break;
    }
    case 'wheel': {
      const n = 14;
      const x: V3 = [0, 0, 1], y: V3 = [0, 1, 0];
      const a = add(s.c, [-s.w / 2, 0, 0]), b = add(s.c, [s.w / 2, 0, 0]);
      // a tyre with a slightly smaller rim face, so the turning shows
      const A = ring(a, x, y, s.r, n), B = ring(b, x, y, s.r, n);
      const Ai = ring(add(a, [-0.002, 0, 0]), x, y, s.r * 0.62, n), Bi = ring(add(b, [0.002, 0, 0]), x, y, s.r * 0.62, n);
      const ca = v(add(a, [-0.004, 0, 0])), cb = v(add(b, [0.004, 0, 0]));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(A[i], B[j], A[j]); tri(A[i], B[i], B[j]);
        tri(A[i], A[j], Ai[j]); tri(A[i], Ai[j], Ai[i]);
        tri(B[i], Bi[j], B[j]); tri(B[i], Bi[i], Bi[j]);
        tri(ca, Ai[j], Ai[i]); tri(cb, Bi[i], Bi[j]);
      }
      break;
    }
    case 'blade': {
      // a thin tapered slab (closed), widest at the base
      const d = sub(s.b, s.a);
      const [x, y] = basis(d);
      const t = Math.max(0.004, s.w * 0.06);
      const w0 = s.w / 2, w1 = s.w * 0.12;
      const q = (p: V3, w: number, side: number) => v(add(add(p, mul(x, w)), mul(y, t * side)));
      const a0 = q(s.a, -w0, 1), a1 = q(s.a, w0, 1), b0 = q(s.b, -w1, 1), b1 = q(s.b, w1, 1);
      const c0 = q(s.a, -w0, -1), c1 = q(s.a, w0, -1), d0 = q(s.b, -w1, -1), d1 = q(s.b, w1, -1);
      const F = [[a0, a1, b1, b0], [c1, c0, d0, d1], [a0, b0, d0, c0], [a1, c1, d1, b1], [b0, b1, d1, d0], [a0, c0, c1, a1]];
      for (const [p1, p2, p3, p4] of F) { tri(p1, p2, p3); tri(p1, p3, p4); }
      break;
    }
  }
  return { pos, idx };
}

/** Every piece's mesh at rest, grouped by part (for the studio view and print/plain exports). */
export function creatureRestMeshes(c: Creature): Array<{ part: string; bone: string; color: string; mesh: TriMesh }> {
  return c.pieces.map((pc) => ({ part: pc.part, bone: pc.bone, color: pc.color, mesh: shapeMesh(pc.shape) }));
}

/** A ground patch for the terrain (periodic bumps) under a creature, `size` metres square. */
export function terrainMesh(c: Creature, size: number, along = size, step = 0.12): TriMesh {
  const pos: number[] = [], idx: number[] = [];
  const nx = Math.max(2, Math.round(size / step)), nz = Math.max(2, Math.round(along / step));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const x = -size / 2 + (size * i) / nx, z = -along / 2 + (along * j) / nz;
    pos.push(x, terrainHeight(c.def.terrain, x, z), z);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, cc = a + nx + 1, d = cc + 1;
    idx.push(a, cc, d, a, d, b);
  }
  return { pos, idx };
}

// ── glTF: one node per bone, pieces as meshes on their bone, TRS animation per clip ──────────────

function flat(m: TriMesh, origin: V3): { p: Float32Array; n: Float32Array } {
  const p = new Float32Array(m.idx.length * 3), n = new Float32Array(m.idx.length * 3);
  for (let t = 0; t < m.idx.length; t += 3) {
    const vs = [0, 1, 2].map((k) => { const i = m.idx[t + k]; return [m.pos[i * 3] - origin[0], m.pos[i * 3 + 1] - origin[1], m.pos[i * 3 + 2] - origin[2]] as V3; });
    const nn = norm(cross(sub(vs[1], vs[0]), sub(vs[2], vs[0])));
    vs.forEach((vv, k) => { p.set(vv, (t + k) * 3); n.set(nn, (t + k) * 3); });
  }
  return { p, n };
}

const hexRGB = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const lin = (x: number) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return [lin(parseInt(h.slice(0, 2), 16)), lin(parseInt(h.slice(2, 4), 16)), lin(parseInt(h.slice(4, 6), 16))];
};

export interface CreatureGlbOpts { terrain?: { size: number; along?: number }; checks?: Record<string, MotionCheck[]> }

/** A creature as GLB: a node per bone (rest offsets), its pieces as meshes, and an animation per clip. */
export function creatureGLB(c: Creature, clips: CreatureClip[], opts: CreatureGlbOpts = {}): Uint8Array {
  const B = new GlbBuilder();
  const g = B.gltf;
  const mats = new Map<string, number>();
  const matOf = (color: string) => {
    if (!mats.has(color)) { g.materials.push({ name: color, pbrMetallicRoughness: { baseColorFactor: [...hexRGB(color), 1], metallicFactor: 0, roughnessFactor: 0.75 } }); mats.set(color, g.materials.length - 1); }
    return mats.get(color)!;
  };
  const root = g.nodes.length;
  g.nodes.push({ name: c.def.name, children: [], extras: { creature: true, parts: c.parts.map((p) => ({ kind: p.spec.kind, id: (p.spec as any).id ?? 'body', checks: p.checks })), ...(opts.checks ? { checks: opts.checks } : {}) } });
  g.scenes[0].nodes.push(root);
  const nodeOf: number[] = [];
  c.bones.forEach((b, i) => {
    const p = c.parents[i];
    const t = p < 0 ? b.head : sub(b.head, c.bones[p].head);
    const node = g.nodes.length;
    g.nodes.push({ name: b.name, translation: t.map((x) => +x.toFixed(6)), children: [] });
    nodeOf.push(node);
    if (p < 0) g.nodes[root].children.push(node); else g.nodes[nodeOf[p]].children.push(node);
  });
  // pieces: one mesh per bone, one primitive per colour (vertices relative to the bone's head)
  const byBone = new Map<number, Map<string, TriMesh[]>>();
  for (const pc of c.pieces) {
    const bi = c.index.get(pc.bone)!;
    if (!byBone.has(bi)) byBone.set(bi, new Map());
    const m = byBone.get(bi)!;
    if (!m.has(pc.color)) m.set(pc.color, []);
    m.get(pc.color)!.push(shapeMesh(pc.shape));
  }
  for (const [bi, byColor] of byBone) {
    const prims: any[] = [];
    for (const [color, meshes] of byColor) {
      const merged: TriMesh = { pos: [], idx: [] };
      for (const m of meshes) { const base = merged.pos.length / 3; merged.pos.push(...m.pos); merged.idx.push(...m.idx.map((i) => i + base)); }
      const { p, n } = flat(merged, c.bones[bi].head);
      prims.push({ attributes: { POSITION: B.accessor(p, 'VEC3', true), NORMAL: B.accessor(n, 'VEC3') }, material: matOf(color) });
    }
    g.meshes.push({ name: `${c.bones[bi].name}.mesh`, primitives: prims });
    g.nodes[nodeOf[bi]].mesh = g.meshes.length - 1;
  }
  // the ground (terrain), as its own node beside the creature
  if (opts.terrain) {
    const tm = terrainMesh(c, opts.terrain.size, opts.terrain.along ?? opts.terrain.size);
    const { p, n } = flat(tm, [0, 0, 0]);
    g.meshes.push({ name: 'ground', primitives: [{ attributes: { POSITION: B.accessor(p, 'VEC3', true), NORMAL: B.accessor(n, 'VEC3') }, material: matOf(c.def.terrain?.color ?? '#a99f8a') }] });
    g.nodes.push({ name: 'ground', mesh: g.meshes.length - 1, extras: { terrain: c.def.terrain ?? null } });
    g.scenes[0].nodes.push(g.nodes.length - 1);
  }
  // animations: rotation for every bone, translation where it moves (struts, sliders, the body)
  g.animations = [];
  for (const clip of clips) {
    const F = clip.frames + 1;
    const times = new Float32Array(F);
    for (let f = 0; f < F; f++) times[f] = f / clip.fps;
    const input = B.typed(times, 'SCALAR', { minmax: true });
    const samplers: any[] = [], channels: any[] = [];
    c.bones.forEach((b, bi) => {
      const moves = clip.rot.some((r) => Math.abs(r[bi][3]) < 0.99999);
      const slides = clip.off.some((o) => Math.hypot(...o[bi]) > 1e-6);
      if (moves) {
        const q = new Float32Array(F * 4);
        let prev: Q | null = null;
        for (let f = 0; f < F; f++) {
          let r = clip.rot[f][bi];
          // keep consecutive keys on the same hemisphere so the engine interpolates the short way
          if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
          q.set(r, f * 4); prev = r;
        }
        samplers.push({ input, output: B.typed(q, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[bi], path: 'rotation' } });
      }
      if (slides) {
        const p = c.parents[bi];
        const rest = p < 0 ? b.head : sub(b.head, c.bones[p].head);
        const tr = new Float32Array(F * 3);
        for (let f = 0; f < F; f++) tr.set(add(rest, clip.off[f][bi]), f * 3);
        samplers.push({ input, output: B.typed(tr, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[bi], path: 'translation' } });
      }
    });
    g.animations.push({ name: clip.id, samplers, channels, extras: { loop: clip.loop, speed: clip.speed, dir: clip.dir, duration: clip.duration } });
  }
  return finishGlb(B);
}

function finishGlb(B: GlbBuilder): Uint8Array {
  // GlbBuilder.finish may not exist in every version: assemble the GLB container here
  const anyB = B as any;
  if (typeof anyB.finish === 'function') return anyB.finish();
  if (typeof anyB.build === 'function') return anyB.build();
  throw new Error('GlbBuilder has no finish/build');
}

/** Build a preset creature and bake every motion with its checks. */
export function creatureWithClips(name: string, fps = 30): { c: Creature; preset: CreaturePreset; clips: CreatureClip[]; checks: Record<string, MotionCheck[]> } {
  const preset = creatureFromPreset(name);
  const c = buildCreature(preset.def);
  const clips = Object.entries(preset.motions).map(([id, m]) => bakeCreature(c, id, m, fps));
  const checks = Object.fromEntries(clips.map((cl) => [cl.id, creatureChecks(c, cl)]));
  return { c, preset, clips, checks };
}

export { qIdentity, qMul, qRot, qAxisAngle, qArc };
