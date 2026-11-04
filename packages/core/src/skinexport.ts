// Characters in glTF (Decisions 13, 20, 21): the bind pose (T-pose, neutral face) as the mesh, a skin
// on the 56-bone skeleton (Godot humanoid + two eyelid bones) (fingers optional), the face shape keys as sparse morph
// targets named in mesh.extras.targetNames, and animation clips: "pose" (the character's current
// pose and expression, one key) and one "line:<id>" clip per spoken line (speech-shape curves).
// Both exporters (plain GLB and game export) use this. DOM-free and Node-free.
import type { EvalResult } from './kernel.ts';
import type { SceneObject } from './types.ts';
import { GlbBuilder } from './glb.ts';
import { forward, localRotations, qAxisAngle, type Q } from './rig.ts';

/** Vertex id of every triangle corner, in triangle order. */
export function cornerVerts(res: EvalResult, tris: number[]): Uint32Array {
  const out = new Uint32Array(tris.length * 3);
  tris.forEach((t, k) => { for (let c = 0; c < 3; c++) out[k * 3 + c] = res.indices[t * 3 + c]; });
  return out;
}

/** Bind-pose positions (object space) per corner. */
export function rigCorners(res: EvalResult, verts: Uint32Array): Float32Array {
  const rest = res.rig!.rest, out = new Float32Array(verts.length * 3);
  verts.forEach((v, k) => out.set(rest.subarray(v * 3, v * 3 + 3), k * 3));
  return out;
}

const FINGER = /(Thumb|Index|Middle|Ring|Little)/;

export interface SkinInfo { skin: number; root: number; jointOfBone: Int32Array; jointNodes: number[]; shapeNames: string[]; kept: number[] }

/**
 * Joint nodes (children of the character's group node), inverse bind matrices and the skin.
 * dropFingers: finger bones are left out and their vertices follow the hand (web-mobile).
 */
export function addSkin(B: GlbBuilder, res: EvalResult, dropFingers = false): SkinInfo {
  const rig = res.rig!.rig;
  const kept = rig.bones.map((b, i) => (dropFingers && FINGER.test(b.name) ? -1 : i)).filter((i) => i >= 0);
  // bone → the kept bone that carries its vertices (a dropped finger → its hand)
  const carrier = (i: number): number => { let j = i; while (j >= 0 && dropFingers && FINGER.test(rig.bones[j].name)) j = rig.parents[j]; return j; };
  const jointOfBone = new Int32Array(rig.bones.length).fill(-1);
  kept.forEach((bi, ji) => { jointOfBone[bi] = ji; });
  for (let i = 0; i < rig.bones.length; i++) if (jointOfBone[i] < 0) jointOfBone[i] = jointOfBone[carrier(i)];
  const jointNodes: number[] = [];
  const nodeOfBone = new Map<number, number>();
  for (const bi of kept) {
    const b = rig.bones[bi];
    let pi = rig.parents[bi];
    while (pi >= 0 && !kept.includes(pi)) pi = rig.parents[pi];
    const ph = pi >= 0 ? rig.bones[pi].head : [0, 0, 0];
    B.gltf.nodes.push({ name: b.name, translation: [b.head[0] - ph[0], b.head[1] - ph[1], b.head[2] - ph[2]] });
    const n = B.gltf.nodes.length - 1;
    nodeOfBone.set(bi, n);
    jointNodes.push(n);
    if (pi >= 0) { const pn = B.gltf.nodes[nodeOfBone.get(pi)!]; (pn.children ??= []).push(n); }
  }
  const ibm = new Float32Array(kept.length * 16);
  kept.forEach((bi, k) => { const h = rig.bones[bi].head; ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -h[0], -h[1], -h[2], 1], k * 16); });
  (B.gltf.skins ??= []).push({ name: 'humanoid', joints: jointNodes, skeleton: jointNodes[0], inverseBindMatrices: B.typed(ibm, 'MAT4') });
  return { skin: B.gltf.skins.length - 1, root: jointNodes[0], jointOfBone, jointNodes, shapeNames: rig.shapeNames, kept };
}

/** JOINTS_0 / WEIGHTS_0 and the morph targets for one primitive (its corners' source vertices). */
export function rigAttributes(B: GlbBuilder, res: EvalResult, verts: Uint32Array, info: SkinInfo, webTargets = true) {
  const rig = res.rig!.rig;
  const n = verts.length;
  const J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const v = verts[k];
    const acc = new Map<number, number>();
    for (let s = 0; s < 4; s++) { const w = rig.weights[v * 4 + s]; if (w > 0) { const j = info.jointOfBone[rig.joints[v * 4 + s]]; acc.set(j, (acc.get(j) ?? 0) + w); } }
    const list = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = list.reduce((s, e) => s + e[1], 0) || 1;
    list.forEach(([j, w], s) => { J[k * 4 + s] = j; W[k * 4 + s] = w / sum; });
  }
  const attributes = { JOINTS_0: B.typed(J, 'VEC4'), WEIGHTS_0: B.typed(W, 'VEC4') };
  void webTargets;
  // morph targets: sparse deltas at the corners whose vertex moves
  const targets = info.shapeNames.map((name) => {
    const sd = rig.shapes[name];
    const at = new Map<number, number>();
    for (let i = 0; i < sd.idx.length; i++) at.set(sd.idx[i], i);
    const idx: number[] = [], vals: number[] = [];
    for (let k = 0; k < n; k++) { const i = at.get(verts[k]); if (i !== undefined) { idx.push(k); vals.push(sd.d[i * 3], sd.d[i * 3 + 1], sd.d[i * 3 + 2]); } }
    return { POSITION: B.sparseVec3(n, Uint32Array.from(idx), Float32Array.from(vals)) };
  });
  return { attributes, targets };
}

/** The skinned mesh node and the joints (placement on the Root joint); then the clips. Returns the scene roots. */
export function addCharacterNodes(B: GlbBuilder, obj: SceneObject, res: EvalResult, mesh: number, info: SkinInfo, extras: Record<string, unknown>): number[] {
  const m = B.gltf.meshes[mesh];
  m.extras = { ...(m.extras ?? {}), targetNames: info.shapeNames };
  m.weights = info.shapeNames.map(() => 0);
  // a skinned mesh's own transform is ignored, so it is a scene root; the character's placement goes
  // on the skeleton's Root joint (the inverse bind matrices stay in object space)
  B.gltf.nodes.push({ name: obj.name, mesh, skin: info.skin, extras });
  const meshNode = B.gltf.nodes.length - 1;
  const root = B.gltf.nodes[info.root];
  root.translation = [obj.position[0] + root.translation[0], obj.position[1] + root.translation[1], obj.position[2] + root.translation[2]];
  if (obj.rotation) root.rotation = qAxisAngle([0, 1, 0], obj.rotation);
  addClips(B, obj, res, meshNode, info);
  return [meshNode, info.root];
}

function addClips(B: GlbBuilder, obj: SceneObject, res: EvalResult, meshNode: number, info: SkinInfo) {
  const rig = res.rig!.rig;
  const anims = (B.gltf.animations ??= []);
  const expr = obj.character?.expression ?? {};
  const weightsAt = (vis: (name: string) => number | undefined) => info.shapeNames.map((nme) => vis(nme) ?? expr[nme] ?? 0);
  // "pose": the current pose and face, one key
  const local = localRotations(rig, obj.character);
  const posed = forward(rig.bones, rig.parents, local);
  void posed;
  const samplers: any[] = [], channels: any[] = [];
  const t0 = B.typed(new Float32Array([0]), 'SCALAR', { minmax: true });
  info.kept.forEach((bi, k) => {
    const q = local[bi];
    if (Math.abs(q[3] - 1) < 1e-6) return;
    samplers.push({ input: t0, output: B.typed(new Float32Array(q as Q), 'VEC4'), interpolation: 'STEP' });
    channels.push({ sampler: samplers.length - 1, target: { node: info.jointNodes[k], path: 'rotation' } });
  });
  samplers.push({ input: t0, output: B.typed(new Float32Array(weightsAt(() => undefined)), 'SCALAR'), interpolation: 'STEP' });
  channels.push({ sampler: samplers.length - 1, target: { node: meshNode, path: 'weights' } });
  anims.push({ name: 'pose', samplers, channels });
  // one clip per spoken line: speech-shape curves over time (the rest of the face holds its expression)
  for (const [id, line] of Object.entries(obj.character?.lines ?? {})) {
    const frames = line.curves.sil?.length ?? 0;
    if (!frames) continue;
    const times = new Float32Array(frames).map((_, f) => f / line.fps);
    const out = new Float32Array(frames * info.shapeNames.length);
    for (let f = 0; f < frames; f++) {
      const w = weightsAt((nme) => (line.curves[nme] ? line.curves[nme][f] : undefined));
      out.set(w, f * info.shapeNames.length);
    }
    const input = B.typed(times, 'SCALAR', { minmax: true });
    anims.push({ name: `line:${id}`, samplers: [{ input, output: B.typed(out, 'SCALAR'), interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: meshNode, path: 'weights' } }], extras: { text: line.text, audio: line.audio, duration: line.duration, emotion: line.emotion, ...(line.voice ? { voice: line.voice, voiceLicence: line.voiceLicence } : {}) } });
  }
}
