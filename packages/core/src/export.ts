// Asset export: GLB (glTF 2.0 binary, PBR materials per part), OBJ and binary STL.
// Reference objects (imports) are skipped unless includeReferences is set.
import type { EvalResult } from './kernel.ts';
import type { Material, SceneObject } from './types.ts';
import { materialForPart } from './materials.ts';
import { GlbBuilder } from './glb.ts';
import { paintGroups } from './facepaint.ts';
import { creasedNormals } from './gameexport.ts';
import { addCharacterNodes, addSkin, attachHeldProps, cornerVerts, rigAttributes, type SkinInfo } from './skinexport.ts';

type Item = { obj: SceneObject; res: EvalResult };
export interface ExportOpts { includeReferences?: boolean }
const usable = (items: Item[], o: ExportOpts = {}) => items.filter((i) => i.res.ok && (o.includeReferences || i.obj.role !== 'reference'));

function flatten(res: EvalResult, tris?: number[]) {
  const sel = tris ?? Array.from({ length: res.indices.length / 3 }, (_, i) => i);
  const n = sel.length * 3;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const tri = sel[t / 3] * 3;
    const v = [0, 1, 2].map((k) => res.indices[tri + k]);
    const p = v.map((i) => [res.positions[i * 3], res.positions[i * 3 + 1], res.positions[i * 3 + 2]]);
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-20) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; } // degenerate sliver: any unit normal
    for (let k = 0; k < 3; k++) {
      pos.set(p[k], (t + k) * 3);
      nor.set([nx, ny, nz], (t + k) * 3);
    }
  }
  return { pos, nor };
}

function hexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return c.map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))) as [number, number, number];
}

/** glTF material from a resolved PBR material (clearcoat / transmission / ior as KHR extensions). */
export function gltfMaterial(m: Material, used: Set<string>) {
  const out: any = {
    name: m.name,
    pbrMetallicRoughness: { baseColorFactor: [...hexToLinear(m.color), m.opacity ?? 1], metallicFactor: m.metalness ?? 0, roughnessFactor: m.roughness ?? 0.6 },
    extras: m.grain ? { woodGrain: m.grain } : undefined,
  };
  if ((m.opacity ?? 1) < 1) out.alphaMode = 'BLEND';
  const ext: any = {};
  if (m.clearcoat) { ext.KHR_materials_clearcoat = { clearcoatFactor: m.clearcoat, clearcoatRoughnessFactor: m.clearcoatRoughness ?? 0.1 }; used.add('KHR_materials_clearcoat'); }
  if (m.transmission) { ext.KHR_materials_transmission = { transmissionFactor: m.transmission }; used.add('KHR_materials_transmission'); }
  if (m.ior) { ext.KHR_materials_ior = { ior: m.ior }; used.add('KHR_materials_ior'); }
  if (m.thickness && m.transmission) { ext.KHR_materials_volume = { thicknessFactor: m.thickness }; used.add('KHR_materials_volume'); }
  if (Object.keys(ext).length) out.extensions = ext;
  return out;
}

export function toGLB(items: Item[], opts: ExportOpts = {}): Uint8Array {
  const B = new GlbBuilder();
  const matIndex = new Map<string, number>();
  const characterCount = usable(items, opts).filter((i) => i.res.rig).length;
  const chars = new Map<string, { obj: SceneObject; res: EvalResult; info: SkinInfo }>();
  const propNodes = new Map<string, number>();
  for (const { obj, res: posedRes } of usable(items, opts)) {
    // characters: bind pose (T-pose, neutral face) + skin + face shapes + clips; others: world-space mesh
    const rigged = !!posedRes.rig;
    const res = rigged ? { ...posedRes, positions: posedRes.rig!.rest } : posedRes;
    const skin = rigged ? addSkin(B, posedRes) : null;
    // group the object's triangles by the material their part resolves to
    const groups = new Map<string, { mat: Material; tris: number[] }>();
    const parts = res.parts.length ? res.parts : [{ name: obj.output ?? 'object', ranges: [[0, res.indices.length / 3]] as Array<[number, number]> }];
    for (const p of parts) {
      const m = materialForPart(obj, p.name.startsWith('~') ? obj.output ?? '' : p.name);
      const key = JSON.stringify(m);
      const g = groups.get(key) ?? { mat: m, tris: [] };
      for (const [start, count] of p.ranges) for (let t = start; t < start + count; t++) g.tris.push(t);
      groups.set(key, g);
    }
    const primitives: any[] = [];
    // painted characters: one small texture (eyes, lashes, smile lines, blush, markings) on the parts that ask for it
    const painted = rigged ? paintGroups(obj, res, [...groups.values()], (part) => materialForPart(obj, part)) : null;
    let texture = -1;
    // characters export with the normals the view shows: smooth style creased at 58°, the default faceted
    // style at 35° (a smoothed head and soft face forms, a body that keeps its planes), toy flat
    const charStyle = rigged ? posedRes.rig!.rig.spec.params.style ?? 'faceted' : 'toy';
    for (const [key, g] of groups) {
      if (!g.tris.length) continue;
      const { pos, nor: flatNor } = flatten(res, g.tris);
      const nor = charStyle === 'smooth' ? creasedNormals(res, g.tris, 58) : charStyle === 'faceted' ? creasedNormals(res, g.tris, 35) : flatNor;
      const matKey = g.mat.paint && painted ? `${obj.id}|${key}` : key;   // a painted material carries this character's own texture
      if (!matIndex.has(matKey)) {
        const m = gltfMaterial(g.mat, B.used);
        if (g.mat.paint && painted) {
          if (texture < 0) texture = B.image(painted.png, `${obj.name} paint`);
          m.pbrMetallicRoughness.baseColorTexture = { index: texture };
          m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, m.pbrMetallicRoughness.baseColorFactor[3]];
        }
        B.gltf.materials.push(m); matIndex.set(matKey, B.gltf.materials.length - 1);
      }
      const prim: any = { attributes: { POSITION: B.accessor(pos, 'VEC3', true), NORMAL: B.accessor(nor, 'VEC3') }, material: matIndex.get(matKey) };
      if (g.mat.paint && painted) prim.attributes.TEXCOORD_0 = B.accessor(painted.uvOf(g, pos), 'VEC2');
      if (skin) { const rg = rigAttributes(B, posedRes, cornerVerts(posedRes, g.tris), skin); Object.assign(prim.attributes, rg.attributes); prim.targets = rg.targets; }
      primitives.push(prim);
    }
    B.gltf.meshes.push({ name: obj.name, primitives });
    const mesh = B.gltf.meshes.length - 1;
    const extras = { semanticType: obj.semanticType, params: Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value])) };
    if (skin) { B.gltf.scenes[0].nodes.push(...addCharacterNodes(B, obj, posedRes, mesh, skin, extras, { clipPrefix: characterCount > 1 ? `${obj.id}:` : '' })); chars.set(obj.id, { obj, res: posedRes, info: skin }); }
    else { B.gltf.nodes.push({ name: obj.name, mesh, extras }); propNodes.set(obj.id, B.gltf.nodes.length - 1); B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1); }
  }
  attachHeldProps(B, usable(items, opts).map((i) => i.obj), chars, propNodes);
  return B.build();
}

export function toOBJ(items: Item[], opts: ExportOpts = {}): string {
  const lines = ['# ai-3d-studio export'];
  let base = 1;
  for (const { obj, res } of usable(items, opts)) {
    lines.push(`o ${obj.name.replace(/\s+/g, '_')}`);
    for (let i = 0; i < res.positions.length; i += 3) lines.push(`v ${res.positions[i]} ${res.positions[i + 1]} ${res.positions[i + 2]}`);
    for (let t = 0; t < res.indices.length; t += 3) lines.push(`f ${res.indices[t] + base} ${res.indices[t + 1] + base} ${res.indices[t + 2] + base}`);
    base += res.positions.length / 3;
  }
  return lines.join('\n') + '\n';
}

/** Binary STL in millimetres, Z-up (what slicers expect). Objects are merged. */
export function toSTL(items: Item[], opts: ExportOpts = {}): Uint8Array {
  const ok = usable(items, opts).filter((i) => i.res.manifold !== false || opts.includeReferences);
  const tris = ok.reduce((n, i) => n + i.res.indices.length / 3, 0);
  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  const head = 'ai-3d-studio STL (mm, Z-up)';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, tris, true);
  let o = 84;
  for (const { res } of ok) {
    const { pos, nor } = flatten(res);
    for (let t = 0; t < pos.length / 9; t++) {
      // Y-up metres → Z-up millimetres: (x, y, z) → (x, -z, y)
      const n = [nor[t * 9], -nor[t * 9 + 2], nor[t * 9 + 1]];
      for (const c of n) { dv.setFloat32(o, c, true); o += 4; }
      for (let k = 0; k < 3; k++) {
        const b = t * 9 + k * 3;
        for (const c of [pos[b] * 1000, -pos[b + 2] * 1000, pos[b + 1] * 1000]) { dv.setFloat32(o, c, true); o += 4; }
      }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return new Uint8Array(buf);
}
