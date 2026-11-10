// The kit face for a Blender person: the studio's code-built head (rig.ts, the same face every kit
// character gets, with its checks) cut from a kit character and handed to the Blender builder, which
// joins it to the Blender body at the neck. What goes over: the head and neck skin with its ears, the
// eyes (white, iris, pupil, catch-light), lid shells, brows, lips, mouth chamber, teeth rows, gums,
// tongue and the lock haircut; the 33 face shapes under the studio's names; the face paint texture with
// its UVs; materials; and the landmarks the builder fits glasses, bones and clips to.
//
// The face blinks by shape keys alone (params.blink 'shape': both lids close, sized so the straight-line
// blend of a morph target never cuts the eyeball), because a GLB player drives blinks as morph weights.
// Kit coordinates: Y up, faces +Z, the character's left is +X, metres.
import { Studio } from '../studio.ts';
import { initKernel } from '../kernel.ts';
import { SHAPE_KEYS, VISEMES, isFacePart, lidForm, type V3 } from '../rig.ts';
import { materialForPart } from '../materials.ts';
import { characterPaintPng, paintUvs } from '../facepaint.ts';
import type { FacePaint } from '../types.ts';

export interface KitFaceOptions {
  height?: number; build?: number; headSize?: number;
  hair?: 'short' | 'messy' | 'receding' | 'none';
  eyes?: 'natural' | 'big'; brows?: 'bar' | 'bushy'; nose?: 'human' | 'button' | 'big' | 'long'; mood?: string;
  skin?: string; hairColor?: string; iris?: string; lips?: string; browColor?: string;
  paint?: FacePaint;
}

/** The parts of a kit character that make its head (skin, ears, hair, face parts, eyes, the neck). */
export const isKitHeadPart = (part: string) => isFacePart(part) || /^(Left|Right)Eye/.test(part) || part === 'Neck';

export interface KitFace {
  positions: number[];            // rest pose, 3 per vertex
  parts: string[];                // part name per vertex
  triangles: number[];            // 3 per triangle (vertex indices)
  triMaterial: number[];          // material per triangle
  uvs: Record<string, number[]>;  // painted materials: 6 per triangle (corner UVs into the paint texture), keyed by material index
  materials: Array<{ name: string; color: string; roughness: number; metalness: number; paint?: string }>;
  shapes: Record<string, { idx: number[]; d: number[] }>;
  visemes: string[];              // which shapes are speech shapes (named viseme_<name> on the person)
  landmarks: {
    headBase: V3; headH: number; hw: number; hd: number; mouth: V3; mouthW: number; nose: V3;
    eyes: Array<{ side: string; c: V3; r: number }>; brows: V3[];
    lids: Array<{ side: string; c: V3; rIn: number; rOut: number; lowIn: number; lowOut: number; upDeg: number; lowDeg: number }>;
    ears: Array<{ side: string; top: V3; centre: V3 }>;
    bones: Record<string, { head: V3; tail: V3 }>;
  };
  params: Record<string, unknown>;
  triangleCount: number;
}

/** Build the kit head for a person and return it with its paint texture (PNG bytes). */
export async function kitFace(o: KitFaceOptions = {}): Promise<{ face: KitFace; png: Uint8Array }> {
  await initKernel();
  const s = new Studio();
  const args: Record<string, unknown> = { name: 'Face', hair: o.hair ?? 'receding', blink: 'shape', style: 'smooth' };
  for (const k of ['height', 'build', 'headSize', 'eyes', 'brows', 'nose', 'mood', 'skin', 'hairColor'] as const) if (o[k] !== undefined) args[k] = o[k];
  const r = s.call('new-character', args);
  if (!r.ok) throw new Error(`kit face: ${r.error}`);
  const obj = s.doc().objects.face;
  // the colours the person asks for (irises, lips, brows) over the kit look
  for (const pm of obj.partMaterials ?? []) {
    if (o.iris && pm.parts === '*Eye.iris') pm.material = { ...pm.material, color: o.iris };
    if (o.lips && pm.parts === 'lip*') pm.material = { ...pm.material, color: o.lips };
    if (o.browColor && pm.parts === 'brow.*') pm.material = { ...pm.material, color: o.browColor };
  }
  const res = s.evaluate(obj);
  const cr = res.rig;
  if (!cr) throw new Error('kit face: the character has no rig');
  const { rig, rest, vertPart } = cr;
  const spec = rig.spec;
  const triPart: string[] = new Array(res.indices.length / 3);
  for (const p of res.parts) for (const [a, c] of p.ranges) for (let t = a; t < a + c; t++) triPart[t] = p.name;
  // keep the head's triangles; renumber their vertices
  const remap = new Map<number, number>();
  const positions: number[] = [], parts: string[] = [], triangles: number[] = [], triMaterial: number[] = [];
  const matKey = new Map<string, number>(), materials: KitFace['materials'] = [];
  const keptTris: number[] = [];
  for (let t = 0; t < triPart.length; t++) {
    const part = triPart[t];
    if (!part || !isKitHeadPart(part)) continue;
    // (the socket wears the face paint: a shape-blink face shows a little more of it round the lids)
    const m = materialForPart(obj, part === 'eyeSocket' ? 'Head' : part);
    const key = JSON.stringify([m.name, m.color, m.paint ?? '']);
    if (!matKey.has(key)) { matKey.set(key, materials.length); materials.push({ name: m.name, color: m.color, roughness: m.roughness ?? 0.6, metalness: m.metalness ?? 0, ...(m.paint ? { paint: m.paint } : {}) }); }
    for (let c = 0; c < 3; c++) {
      const v = res.indices[t * 3 + c];
      let i = remap.get(v);
      if (i === undefined) { i = parts.length; remap.set(v, i); positions.push(rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]); parts.push(vertPart[v]); }
      triangles.push(i);
    }
    triMaterial.push(matKey.get(key)!);
    keptTris.push(t);
  }
  // painted materials: corner UVs into the paint texture, projected from the bind pose (as every kit export does)
  const uvs: KitFace['uvs'] = {};
  materials.forEach((m, mi) => {
    if (!m.paint) return;
    const tris = keptTris.filter((_, k) => triMaterial[k] === mi);
    const corners = new Float32Array(tris.length * 9);
    tris.forEach((t, k) => { for (let c = 0; c < 3; c++) corners.set(rest.subarray(res.indices[t * 3 + c] * 3, res.indices[t * 3 + c] * 3 + 3), (k * 3 + c) * 3); });
    uvs[mi] = Array.from(paintUvs(spec, m.paint as 'head' | 'body' | 'iris', corners, (k) => triPart[tris[Math.floor(k / 3)]] ?? ''));
  });
  const colourOf = (re: RegExp) => materials.find((m) => re.test(m.name))?.color;
  const head = materials.find((m) => m.paint === 'head' && m.name === 'skin')?.color ?? o.skin ?? '#d9a77a';
  const png = characterPaintPng(spec, o.paint ?? obj.character?.paint, { head, body: head, iris: colourOf(/^iris$/) ?? '#5b4632', lips: colourOf(/^lips$/), hair: colourOf(/^hair$/) });
  // the face shapes, on the kept vertices
  const shapes: KitFace['shapes'] = {};
  for (const k of SHAPE_KEYS) {
    const sd = rig.shapes[k], idx: number[] = [], d: number[] = [];
    for (let i = 0; i < sd.idx.length; i++) {
      const v = remap.get(sd.idx[i]);
      if (v === undefined) continue;
      idx.push(v); d.push(sd.d[i * 3], sd.d[i * 3 + 1], sd.d[i * 3 + 2]);
    }
    shapes[k] = { idx, d };
  }
  const F = spec.face, LF = lidForm(spec.params.eyes ?? 'natural', 'shape');
  const ears = (['L', 'R'] as const).map((sd) => {
    let top: V3 = [0, -Infinity, 0]; const c: V3 = [0, 0, 0]; let n = 0;
    parts.forEach((p, v) => {
      if (p !== `ear.${sd}`) return;
      const q: V3 = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
      if (q[1] > top[1]) top = q;
      c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; n++;
    });
    return { side: sd === 'L' ? 'Left' : 'Right', top, centre: c.map((x) => x / Math.max(1, n)) as V3 };
  });
  const bones: KitFace['landmarks']['bones'] = {};
  for (const b of rig.bones) if (/^(Neck|Head|Jaw|LeftEye|RightEye|UpperChest)$/.test(b.name)) bones[b.name] = { head: b.head, tail: b.tail };
  const face: KitFace = {
    positions, parts, triangles, triMaterial, uvs, materials, shapes, visemes: [...VISEMES],
    landmarks: {
      headBase: F.headBase, headH: F.headH, hw: F.hw, hd: F.hd, mouth: F.mouth, mouthW: F.mouthW, nose: F.nose,
      eyes: F.eyes.map((e) => ({ side: e.side, c: e.c, r: e.r })), brows: F.brows,
      lids: spec.lids.map((l) => ({ side: l.bone.startsWith('Left') ? 'Left' : 'Right', c: l.c, rIn: l.rIn, rOut: l.rOut, lowIn: l.lower!.rIn, lowOut: l.lower!.rOut, upDeg: LF.upDeg, lowDeg: LF.lowDeg })),
      ears, bones,
    },
    params: { ...spec.params },
    triangleCount: triangles.length / 3,
  };
  return { face, png };
}
