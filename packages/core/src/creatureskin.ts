// A creature as a skinned glTF (Decision 52, the Godot live-IK path): the same bones, pieces and clips as
// creatureGLB, but the bones are joints of one skin and the pieces are one skinned mesh (each vertex rides
// its piece's bone at full weight, so it moves exactly like the node-per-bone export). Godot imports a
// skin as a Skeleton3D, which is what its SkeletonModifier3D IK nodes (TwoBoneIK3D, FABRIK3D) attach to.
// Two kinds of extra joint carry no weight: a ".tip" joint at the end of every leg and chain, so an IK
// chain has an end bone whose head is the foot or the tentacle tip.
// The root node's extras.ik says which bones are legs and chains, the gait numbers the live runtime uses
// (the same ones CreatureRuntime uses), and where each foot rests (studio/creature_ik.gd reads it).
// The node-per-bone creatureGLB stays as the fallback (baked clips, any engine).
import { GlbBuilder } from './glb.ts';
import { shapeMesh, terrainMesh, swayParams, type TriMesh } from './creatures.ts';
import { gaitPhase, type ChainPartSpec, type Creature, type CreatureClip, type LegsPartSpec, type MotionCheck, type SwayPartSpec } from './rigparts.ts';
import type { Q, V3 } from './rig.ts';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const r6 = (v: number[]) => v.map((x) => +x.toFixed(6));

const lin = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const f = (x: number) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return [f(parseInt(h.slice(0, 2), 16)), f(parseInt(h.slice(2, 4), 16)), f(parseInt(h.slice(4, 6), 16))];
};

/** Flat (or smooth, when the mesh has normals) triangles, de-indexed, object space. */
function triangles(m: TriMesh): { p: number[]; n: number[] } {
  const p: number[] = [], n: number[] = [];
  for (let t = 0; t < m.idx.length; t += 3) {
    const vs = [0, 1, 2].map((k) => { const i = m.idx[t + k]; return [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]] as V3; });
    const fn = norm(cross(sub(vs[1], vs[0]), sub(vs[2], vs[0])));
    vs.forEach((v, k) => { const i = m.idx[t + k]; p.push(...v); n.push(...(m.nrm ? [m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2]] : fn)); });
  }
  return { p, n };
}

/** What the live runtime needs to drive a creature's legs and chains (also in the GLB's root extras.ik). */
export interface CreatureIkInfo {
  body: string; bodyHeight: number; size: number;
  legs: Array<{ hip: string; knee: string; tip: string; foot: V3; side: 1 | -1; pair: number; group: number; pole: V3; upper: number; lower: number }>;
  gait: { count: number; stepTrigger: number; stepTime: number; lift: number } | null;
  chains: Array<{ id: string; bones: string[]; tip: string; length: number }>;
}

export function creatureIkInfo(c: Creature): CreatureIkInfo {
  const legSpec = c.def.parts.find((p): p is LegsPartSpec => p.kind === 'legs');
  const bi = (n: string) => c.index.get(n)!;
  const blen = (n: string) => len(sub(c.bones[bi(n)].tail, c.bones[bi(n)].head));
  const legs = c.legs.map((l) => ({
    hip: l.hip, knee: l.knee, tip: `${l.knee}.tip`, foot: r6(c.bones[bi(l.knee)].tail) as V3, side: l.side, pair: l.pair,
    // the runtime's gait groups: the legs that swing together (CreatureRuntime uses the same split)
    group: gaitPhase(legSpec?.count ?? 2, l.pair, l.side) < 0.25 ? 0 : 1,
    pole: l.pole, upper: +blen(l.hip).toFixed(5), lower: +blen(l.knee).toFixed(5),
  }));
  const reach = legSpec ? legSpec.upper + legSpec.lower : 0;
  const chains = c.def.parts.filter((p): p is ChainPartSpec => p.kind === 'chain').map((ch) => {
    const bones = Array.from({ length: ch.segments }, (_, k) => `${ch.id}.${k + 1}`);
    return { id: ch.id, bones, tip: `${bones[bones.length - 1]}.tip`, length: ch.length };
  });
  const body = c.bones[bi('Body')];
  return {
    body: 'Body', bodyHeight: body.head[1], size: c.size, legs, chains,
    gait: legSpec ? { count: legSpec.count, stepTrigger: +(reach * 0.22).toFixed(4), stepTime: +(0.12 + reach * 0.35).toFixed(4), lift: (legSpec.lift ?? 0.35) * legSpec.upper } : null,
  };
}

export interface CreatureSkinOpts { terrain?: { size: number; along?: number }; checks?: Record<string, MotionCheck[]> }

/** A creature as a skinned GLB: one skin over its bones (plus weightless .tip joints), one mesh, the same
 *  clips as creatureGLB (rotation and translation channels on the joints). */
export function creatureSkinnedGLB(c: Creature, clips: CreatureClip[], opts: CreatureSkinOpts = {}): Uint8Array {
  const B = new GlbBuilder();
  const g = B.gltf;
  const ik = creatureIkInfo(c);
  const root = g.nodes.length;
  g.nodes.push({ name: c.def.name, children: [], extras: { creature: true, skinned: true, ik, parts: c.parts.map((p) => ({ kind: p.spec.kind, id: (p.spec as any).id ?? 'body', checks: p.checks })), ...(opts.checks ? { checks: opts.checks } : {}) } });
  g.scenes[0].nodes.push(root);
  // joints: every bone (rest = translation from its parent's head), then a tip per leg and chain end
  const heads: V3[] = [], jointNode: number[] = [];
  c.bones.forEach((b, i) => {
    const p = c.parents[i];
    const t = p < 0 ? b.head : sub(b.head, c.bones[p].head);
    const sw = c.def.parts.find((x) => x.kind === 'sway' && (x as SwayPartSpec).mode === 'shader' && x.id === b.name) as SwayPartSpec | undefined;
    g.nodes.push({ name: b.name, translation: r6(t), children: [], ...(sw ? { extras: { sway: swayParams(sw) } } : {}) });
    jointNode.push(g.nodes.length - 1);
    heads.push(b.head);
    if (p < 0) g.nodes[root].children.push(g.nodes.length - 1); else g.nodes[jointNode[p]].children.push(g.nodes.length - 1);
  });
  const tips: Array<{ name: string; bone: number }> = [...ik.legs.map((l) => ({ name: l.tip, bone: c.index.get(l.knee)! })), ...ik.chains.map((ch) => ({ name: ch.tip, bone: c.index.get(ch.bones[ch.bones.length - 1])! }))];
  for (const tp of tips) {
    const b = c.bones[tp.bone];
    g.nodes.push({ name: tp.name, translation: r6(sub(b.tail, b.head)) });
    jointNode.push(g.nodes.length - 1);
    heads.push(b.tail);
    g.nodes[jointNode[tp.bone]].children.push(g.nodes.length - 1);
  }
  const ibm = new Float32Array(heads.length * 16);
  heads.forEach((h, k) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -h[0], -h[1], -h[2], 1], k * 16));
  // props without a parent are roots of their own: then there is no single skeleton root to name
  const oneRoot = c.parents.filter((p) => p < 0).length === 1;
  g.skins = [{ name: `${c.def.name} skeleton`, joints: jointNode, ...(oneRoot ? { skeleton: jointNode[0] } : {}), inverseBindMatrices: B.typed(ibm, 'MAT4') }];
  // one skinned mesh: a primitive per colour, every vertex on its piece's bone
  const mats = new Map<string, number>();
  const byColor = new Map<string, { p: number[]; n: number[]; j: number[] }>();
  for (const pc of c.pieces) {
    const j = c.index.get(pc.bone)!;
    const t = triangles(shapeMesh(pc.shape));
    if (!byColor.has(pc.color)) byColor.set(pc.color, { p: [], n: [], j: [] });
    const acc = byColor.get(pc.color)!;
    acc.p.push(...t.p); acc.n.push(...t.n);
    for (let k = 0; k < t.p.length / 3; k++) acc.j.push(j);
  }
  const prims: any[] = [];
  for (const [color, a] of byColor) {
    if (!mats.has(color)) { g.materials.push({ name: color, pbrMetallicRoughness: { baseColorFactor: [...lin(color), 1], metallicFactor: 0, roughnessFactor: 0.75 } }); mats.set(color, g.materials.length - 1); }
    const nv = a.p.length / 3;
    const J = new Uint16Array(nv * 4), W = new Float32Array(nv * 4);
    for (let k = 0; k < nv; k++) { J[k * 4] = a.j[k]; W[k * 4] = 1; }
    prims.push({ attributes: { POSITION: B.accessor(Float32Array.from(a.p), 'VEC3', true), NORMAL: B.accessor(Float32Array.from(a.n), 'VEC3'), JOINTS_0: B.typed(J, 'VEC4'), WEIGHTS_0: B.typed(W, 'VEC4') }, material: mats.get(color)! });
  }
  g.meshes.push({ name: `${c.def.name}.mesh`, primitives: prims });
  g.nodes.push({ name: `${c.def.name} mesh`, mesh: g.meshes.length - 1, skin: 0 });
  g.nodes[root].children.push(g.nodes.length - 1);
  if (opts.terrain) {
    const t = triangles(terrainMesh(c, opts.terrain.size, opts.terrain.along ?? opts.terrain.size));
    const col = c.def.terrain?.color ?? '#a99f8a';
    g.materials.push({ name: 'ground', pbrMetallicRoughness: { baseColorFactor: [...lin(col), 1], metallicFactor: 0, roughnessFactor: 0.9 } });
    g.meshes.push({ name: 'ground', primitives: [{ attributes: { POSITION: B.accessor(Float32Array.from(t.p), 'VEC3', true), NORMAL: B.accessor(Float32Array.from(t.n), 'VEC3') }, material: g.materials.length - 1 }] });
    g.nodes.push({ name: 'ground', mesh: g.meshes.length - 1, extras: { terrain: c.def.terrain ?? null } });
    g.scenes[0].nodes.push(g.nodes.length - 1);
  }
  // clips: the same channels as creatureGLB, on the joints
  g.animations = [];
  for (const clip of clips) {
    const F = clip.frames + 1;
    const times = new Float32Array(F);
    for (let f = 0; f < F; f++) times[f] = f / clip.fps;
    const input = B.typed(times, 'SCALAR', { minmax: true });
    const samplers: any[] = [], channels: any[] = [];
    c.bones.forEach((b, bi) => {
      if (clip.rot.some((r) => Math.abs(r[bi][3]) < 0.99999)) {
        const q = new Float32Array(F * 4);
        let prev: Q | null = null;
        for (let f = 0; f < F; f++) {
          let r = clip.rot[f][bi];
          if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
          q.set(r, f * 4); prev = r;
        }
        samplers.push({ input, output: B.typed(q, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: jointNode[bi], path: 'rotation' } });
      }
      if (clip.off.some((o) => Math.hypot(...o[bi]) > 1e-6)) {
        const p = c.parents[bi];
        const rest = p < 0 ? b.head : sub(b.head, c.bones[p].head);
        const tr = new Float32Array(F * 3);
        for (let f = 0; f < F; f++) tr.set(add(rest, clip.off[f][bi]), f * 3);
        samplers.push({ input, output: B.typed(tr, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: jointNode[bi], path: 'translation' } });
      }
    });
    g.animations.push({ name: clip.id, samplers, channels, extras: { loop: clip.loop, speed: clip.speed, dir: clip.dir, duration: clip.duration } });
  }
  for (const nd of g.nodes) if (Array.isArray(nd.children) && !nd.children.length) delete nd.children;
  return B.build();
}
