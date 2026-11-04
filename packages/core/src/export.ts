// Asset export: GLB (glTF 2.0 binary), OBJ and binary STL. Flat-shaded, one mesh per object.
import type { EvalResult } from './kernel.ts';
import type { SceneObject } from './types.ts';

function flatten(res: EvalResult) {
  const n = res.indices.length;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let t = 0; t < n; t += 3) {
    const v = [0, 1, 2].map((k) => res.indices[t + k]);
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

export function toGLB(items: Array<{ obj: SceneObject; res: EvalResult }>): Uint8Array {
  const buffers: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], nodes: any[] = [], materials: any[] = [];
  for (const { obj, res } of items) {
    if (!res.ok) continue;
    const { pos, nor } = flatten(res);
    const add = (arr: Float32Array) => {
      const bytes = new Uint8Array(arr.buffer.slice(0));
      bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
      buffers.push(bytes);
      offset += bytes.length;
      return bufferViews.length - 1;
    };
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const pv = add(pos), nv = add(nor);
    accessors.push({ bufferView: pv, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: nv, componentType: 5126, count: nor.length / 3, type: 'VEC3' });
    materials.push({ name: obj.material.name, pbrMetallicRoughness: { baseColorFactor: [...hexToLinear(obj.material.color), 1], metallicFactor: 0, roughnessFactor: obj.material.roughness ?? 0.6 } });
    meshes.push({ name: obj.name, primitives: [{ attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 }, material: materials.length - 1 }] });
    nodes.push({ name: obj.name, mesh: meshes.length - 1, extras: { semanticType: obj.semanticType, params: Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value])) } });
  }
  const bin = new Uint8Array(offset);
  let o = 0;
  for (const b of buffers) { bin.set(b, o); o += b.length; }
  const gltf = {
    asset: { version: '2.0', generator: 'ai-3d-studio' },
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

export function toOBJ(items: Array<{ obj: SceneObject; res: EvalResult }>): string {
  const lines = ['# ai-3d-studio export'];
  let base = 1;
  for (const { obj, res } of items) {
    if (!res.ok) continue;
    lines.push(`o ${obj.name.replace(/\s+/g, '_')}`);
    for (let i = 0; i < res.positions.length; i += 3) lines.push(`v ${res.positions[i]} ${res.positions[i + 1]} ${res.positions[i + 2]}`);
    for (let t = 0; t < res.indices.length; t += 3) lines.push(`f ${res.indices[t] + base} ${res.indices[t + 1] + base} ${res.indices[t + 2] + base}`);
    base += res.positions.length / 3;
  }
  return lines.join('\n') + '\n';
}

/** Binary STL in millimetres, Z-up (what slicers expect). Objects are merged. */
export function toSTL(items: Array<{ obj: SceneObject; res: EvalResult }>): Uint8Array {
  const ok = items.filter((i) => i.res.ok);
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
