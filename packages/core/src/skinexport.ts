// Characters in glTF (Decisions 13, 20, 21): the bind pose (T-pose, neutral face) as the mesh, a skin
// on the 56-bone skeleton (Godot humanoid + two eyelid bones) (fingers optional), the face shape keys as sparse morph
// targets named in mesh.extras.targetNames, and animation clips: "pose" (the character's current
// pose and expression, one key), one "line:<id>" clip per spoken line (speech-shape curves, blinks,
// glances, breathing, head) and one clip per parametric motion (walk, idle, actions; in place, with
// its speed in extras). With several characters in one file, clips are prefixed "<character id>:".
// Both exporters (plain GLB and game export) use this. DOM-free and Node-free.
import type { EvalResult } from './kernel.ts';
import type { SceneObject } from './types.ts';
import { GlbBuilder } from './glb.ts';
import { forward, localRotations, qAxisAngle, qMul, qRot, type Q, type V3 } from './rig.ts';
import { bakeMotion } from './motion.ts';
import { compilePerformance } from './performance.ts';

/**
 * A prop in a hand rides on the hand joint (a child node), so it follows every clip — walk, actions,
 * lines. Its transform is relative to the hand as the character is posed in the studio.
 */
export function attachHeldProps(B: GlbBuilder, objs: SceneObject[], chars: Map<string, { obj: SceneObject; res: EvalResult; info: SkinInfo }>, propNodes: Map<string, number>) {
  for (const obj of objs) {
    if (obj.place?.kind !== 'held') continue;
    const c = chars.get(obj.place.target), ni = propNodes.get(obj.id);
    if (!c || ni === undefined) continue;
    const rig = c.res.rig!.rig;
    const bi = rig.bones.findIndex((b) => b.name === `${obj.place!.hand === 'left' ? 'Left' : 'Right'}Hand`);
    const k = c.info.kept.indexOf(bi);
    if (k < 0) continue;
    const posed = forward(rig.bones, rig.parents, localRotations(rig, c.obj.character));
    const qc = qAxisAngle([0, 1, 0], c.obj.rotation ?? 0);
    const hq: Q = qMul(qc, posed.worldQ[bi]);
    const hp = qRot(qc, posed.worldP[bi]);
    const handP: V3 = [c.obj.position[0] + hp[0], c.obj.position[1] + hp[1], c.obj.position[2] + hp[2]];
    const inv: Q = [-hq[0], -hq[1], -hq[2], hq[3]];
    const node = B.gltf.nodes[ni];
    const t = (node.translation as number[] | undefined) ?? [0, 0, 0];
    node.translation = qRot(inv, [t[0] - handP[0], t[1] - handP[1], t[2] - handP[2]]).map((v) => +v.toFixed(6));
    node.rotation = inv.map((v) => +v.toFixed(7));
    node.extras = { ...(node.extras ?? {}), heldBy: { character: c.obj.name, hand: obj.place.hand } };
    const roots = B.gltf.scenes[0].nodes as number[];
    roots.splice(roots.indexOf(ni), 1);
    const joint = B.gltf.nodes[c.info.jointNodes[k]];
    (joint.children ??= []).push(ni);
  }
}

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
export function addCharacterNodes(B: GlbBuilder, obj: SceneObject, res: EvalResult, mesh: number, info: SkinInfo, extras: Record<string, unknown>, opts: { clipPrefix?: string } = {}): number[] {
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
  addClips(B, obj, res, meshNode, info, opts.clipPrefix ?? '');
  return [meshNode, info.root];
}

function addClips(B: GlbBuilder, obj: SceneObject, res: EvalResult, meshNode: number, info: SkinInfo, prefix: string) {
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
  anims.push({ name: `${prefix}pose`, samplers, channels });
  // one clip per spoken line: speech-shape curves over time (the rest of the face holds its expression),
  // plus the line's life: blinks and brow lifts as shape keys, the eyelids and eyes as bone rotations
  const jointOf = (name: string) => { const bi = rig.bones.findIndex((b) => b.name === name); const k = bi >= 0 ? info.kept.indexOf(bi) : -1; return k >= 0 ? { bi, node: info.jointNodes[k] } : null; };
  for (const [id, line] of Object.entries(obj.character?.lines ?? {})) {
    const frames = line.curves.sil?.length ?? 0;
    if (!frames) continue;
    if (line.performance) {
      // a performed line (Decision 23): the whole body — mouth, face, eyes, hands, posture, arms — one clip
      let pc;
      try { pc = compilePerformance(rig, obj.character, line, line.performance, { look: (obj.character as any)?.look }); } catch { pc = null; }
      if (pc) {
        const n = pc.local.length;
        const input = B.typed(new Float32Array(n).map((_, f) => f / pc!.fps), 'SCALAR', { minmax: true });
        const samplers: any[] = [], channels: any[] = [];
        info.kept.forEach((bi, k) => {
          let moves = false;
          for (let f = 0; f < n && !moves; f++) if (Math.abs(pc!.local[f][bi][3]) < 0.999999) moves = true;
          if (!moves) return;
          const o = new Float32Array(n * 4);
          for (let f = 0; f < n; f++) o.set(pc!.local[f][bi], f * 4);
          samplers.push({ input, output: B.typed(o, 'VEC4'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node: info.jointNodes[k], path: 'rotation' } });
        });
        const hj = jointOf('Hips');
        if (hj) {
          const restT = B.gltf.nodes[hj.node].translation as number[];
          const o = new Float32Array(n * 3);
          for (let f = 0; f < n; f++) o.set([restT[0] + pc.hips[f][0], restT[1] + pc.hips[f][1], restT[2] + pc.hips[f][2]], f * 3);
          samplers.push({ input, output: B.typed(o, 'VEC3'), interpolation: 'LINEAR' });
          channels.push({ sampler: samplers.length - 1, target: { node: hj.node, path: 'translation' } });
        }
        const out = new Float32Array(n * info.shapeNames.length);
        for (let f = 0; f < n; f++) out.set(info.shapeNames.map((nme) => pc!.shapes[nme]?.[f] ?? expr[nme] ?? 0), f * info.shapeNames.length);
        samplers.push({ input, output: B.typed(out, 'SCALAR'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: meshNode, path: 'weights' } });
        anims.push({ name: `${prefix}line:${id}`, samplers, channels, extras: { text: line.text, audio: line.audio, duration: line.duration, emotion: line.performance.emotion ?? line.emotion, performance: true, gestures: pc.gestures.map((g) => ({ gesture: g.gesture, hand: g.hand, word: g.word, stroke: g.stroke })), ...(line.voice ? { voice: line.voice, voiceLicence: line.voiceLicence } : {}) } });
        continue;
      }
    }
    const life = line.life;
    const times = new Float32Array(frames).map((_, f) => f / line.fps);
    const out = new Float32Array(frames * info.shapeNames.length);
    const lifeAt = (nme: string, f: number) => life?.curves[nme]?.[f];
    for (let f = 0; f < frames; f++) {
      const w = weightsAt((nme) => {
        const sp = line.curves[nme]?.[f], lv = lifeAt(nme, f);
        if (lv === undefined) return sp;
        const base = Math.max(sp ?? 0, expr[nme] ?? 0);
        // a blink closes the eye whatever the expression; brow lifts add to the expression
        return nme.startsWith('eyeBlink') ? Math.max(base, lv) : Math.min(1, base + lv);
      });
      out.set(w, f * info.shapeNames.length);
    }
    const input = B.typed(times, 'SCALAR', { minmax: true });
    const samplers: any[] = [{ input, output: B.typed(out, 'SCALAR'), interpolation: 'LINEAR' }];
    const channels: any[] = [{ sampler: 0, target: { node: meshNode, path: 'weights' } }];
    if (life) {
      const rotTrack = (node: number, q: (f: number) => Q) => {
        const o = new Float32Array(frames * 4);
        for (let f = 0; f < frames; f++) o.set(q(f), f * 4);
        samplers.push({ input, output: B.typed(o, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });
      };
      for (const l of rig.spec.lids) {
        const j = jointOf(l.bone);
        const key = l.bone === 'LeftUpperLid' ? 'eyeBlinkLeft' : 'eyeBlinkRight';
        if (j) rotTrack(j.node, (f) => qAxisAngle([1, 0, 0], l.closeDeg * Math.min(1, Math.max(expr[key] ?? 0, life.curves[key]?.[f] ?? 0))));
      }
      for (const side of ['LeftEye', 'RightEye']) {
        const j = jointOf(side);
        if (j) rotTrack(j.node, (f) => qMul(local[j.bi], qMul(qAxisAngle([0, 1, 0], life.gaze.yaw[f] ?? 0), qAxisAngle([1, 0, 0], -(life.gaze.pitch[f] ?? 0)))));
      }
      // breathing and the head's small nods and drift, on top of the held pose
      const body = life.body;
      if (body) {
        const at = (a: number[], f: number) => a[Math.min(f, a.length - 1)] ?? 0;
        const tracks: Array<[string, (f: number) => Q]> = [
          ['Chest', (f) => qAxisAngle([1, 0, 0], -0.8 * at(body.breath, f))],
          ['UpperChest', (f) => qAxisAngle([1, 0, 0], -1.2 * at(body.breath, f))],
          ['Neck', (f) => qMul(qAxisAngle([0, 1, 0], at(body.headYaw, f) * 0.4), qAxisAngle([1, 0, 0], at(body.headPitch, f) * 0.35))],
          ['Head', (f) => qMul(qAxisAngle([0, 1, 0], at(body.headYaw, f) * 0.6), qAxisAngle([1, 0, 0], at(body.headPitch, f) * 0.65))],
        ];
        for (const [bn, fn] of tracks) { const j = jointOf(bn); if (j) rotTrack(j.node, (f) => qMul(local[j.bi], fn(f))); }
      }
    }
    anims.push({ name: `${prefix}line:${id}`, samplers, channels, extras: { text: line.text, audio: line.audio, duration: line.duration, emotion: line.emotion, ...(line.voice ? { voice: line.voice, voiceLicence: line.voiceLicence } : {}), ...(life ? { life: { seed: life.seed, blinks: life.blinks } } : {}) } });
  }
  // parametric motions (Decision 16): baked from settings onto this skeleton; in place, with the
  // speed a game should move the character at in the clip's extras
  const hipsJ = jointOf('Hips');
  for (const [id, spec] of Object.entries(obj.character?.motions ?? {})) {
    let clip;
    try { clip = bakeMotion(id, spec, rig, obj.character); } catch { continue; }
    const n = clip.frames + 1;
    const input = B.typed(new Float32Array(n).map((_, f) => f / clip.fps), 'SCALAR', { minmax: true });
    const samplers: any[] = [], channels: any[] = [];
    info.kept.forEach((bi, k) => {
      let moves = false;
      for (let f = 0; f < n && !moves; f++) if (Math.abs(clip.local[f][bi][3]) < 0.999999) moves = true;
      if (!moves) return;
      const o = new Float32Array(n * 4);
      for (let f = 0; f < n; f++) o.set(clip.local[f][bi], f * 4);
      samplers.push({ input, output: B.typed(o, 'VEC4'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: info.jointNodes[k], path: 'rotation' } });
    });
    if (hipsJ) {
      const restT = B.gltf.nodes[hipsJ.node].translation as number[];
      const o = new Float32Array(n * 3);
      for (let f = 0; f < n; f++) o.set([restT[0] + clip.hips[f][0], restT[1] + clip.hips[f][1], restT[2] + clip.hips[f][2]], f * 3);
      samplers.push({ input, output: B.typed(o, 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: hipsJ.node, path: 'translation' } });
    }
    const out = new Float32Array(n * info.shapeNames.length);
    for (let f = 0; f < n; f++) out.set(weightsAt((nme) => (clip.shapes[nme] ? Math.max(clip.shapes[nme][f] ?? 0, expr[nme] ?? 0) : undefined)), f * info.shapeNames.length);
    samplers.push({ input, output: B.typed(out, 'SCALAR'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: meshNode, path: 'weights' } });
    anims.push({ name: `${prefix}${id}`, samplers, channels, extras: { motion: spec.kind, loop: clip.loop, speed: clip.speed, duration: clip.duration, ...(clip.stride ? { stride: clip.stride } : {}), ...(clip.turn !== undefined ? { turn: clip.turn } : {}), ...(spec.action ? { action: spec.action } : {}), ...(clip.travel ? { travel: clip.travel, then: spec.kind === 'start' ? (spec.from ?? 'walk') : 'idle', ...(spec.kind === 'start' ? { phase: 0.5 } : {}) } : {}) } });
  }
}
