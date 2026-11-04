// Asset export: GLB (glTF 2.0 binary, PBR materials per part), OBJ and binary STL.
// Reference objects (imports) are skipped unless includeReferences is set.
import type { EvalResult } from './kernel.ts';
import type { Material, SceneObject } from './types.ts';
import { materialForPart } from './materials.ts';

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
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
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
function gltfMaterial(m: Material, used: Set<string>) {
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
  const buffers: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], nodes: any[] = [], materials: any[] = [];
  const matIndex = new Map<string, number>();
  const used = new Set<string>();
  const add = (arr: Float32Array) => {
    const bytes = new Uint8Array(arr.buffer.slice(0));
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
    buffers.push(bytes);
    offset += bytes.length;
    return bufferViews.length - 1;
  };
  for (const { obj, res } of usable(items, opts)) {
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
    for (const [key, g] of groups) {
      if (!g.tris.length) continue;
      const { pos, nor } = flatten(res, g.tris);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
      const pv = add(pos), nv = add(nor);
      accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
      accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: 'VEC3' });
      if (!matIndex.has(key)) { materials.push(gltfMaterial(g.mat, used)); matIndex.set(key, materials.length - 1); }
      primitives.push({ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: matIndex.get(key) });
    }
    meshes.push({ name: obj.name, primitives });
    nodes.push({ name: obj.name, mesh: meshes.length - 1, extras: { semanticType: obj.semanticType, params: Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value])) } });
  }
  const bin = new Uint8Array(offset);
  let o = 0;
  for (const b of buffers) { bin.set(b, o); o += b.length; }
  const gltf = {
    asset: { version: '2.0', generator: 'ai-3d-studio' },
    ...(used.size ? { extensionsUsed: [...used] } : {}),
    scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (n: number) => (4 - (n % 4)) % 4;
  let json = new TextEncoder().encode(JSON.stringify(gltf));
  json = Uint8Array.from([...json, ...new Array(pad(json.length)).fill(0x20)]);
  const binPadded = new Uint8Array(bin.length + pad(bin.length));
  binPadded.set(bin);
  const total = 12 + 8 + json.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, json.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(json, 20);
  const bo = 20 + json.length;
  dv.setUint32(bo, binPadded.length, true); dv.setUint32(bo + 4, 0x004e4942, true); out.set(binPadded, bo + 8);
  return out;
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
