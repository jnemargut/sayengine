// The bake fallback (Decision 29): for renderers without colour grading (Godot's Compatibility
// renderer, old phones), grade the colours themselves. A GLB's vertex colours (towns) and material base
// colours are rewritten so that, under the look's reference light and the plain transport tonemapper,
// they land where the graded render would. Baked textures go through the same function per texel.
import { bakeLinear, type Look } from './look.ts';
import type { RGB } from './color.ts';

interface Glb { json: any; bin: Uint8Array }
export function readGlb(buf: Uint8Array): Glb {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jl)));
  let bin = new Uint8Array(0);
  if (20 + jl < buf.length) { const bl = dv.getUint32(20 + jl, true); bin = buf.slice(28 + jl, 28 + jl + bl); }
  return { json, bin };
}
export function writeGlb(g: Glb): Uint8Array {
  const enc = new TextEncoder().encode(JSON.stringify(g.json));
  const jl = Math.ceil(enc.length / 4) * 4, bl = Math.ceil(g.bin.length / 4) * 4;
  const out = new Uint8Array(12 + 8 + jl + (g.bin.length ? 8 + bl : 0));
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20); for (let i = enc.length; i < jl; i++) out[20 + i] = 0x20;
  if (g.bin.length) { dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(g.bin, 28 + jl); }
  return out;
}

/** Bake a look into a GLB's colours. Returns the new GLB and what changed. Idempotence is the caller's job (bake the studio's export, once). */
export function bakeGlb(buf: Uint8Array, look: Look): { glb: Uint8Array; vertexColours: number; materials: number; textures: number } {
  const g = readGlb(buf);
  const tweakFor = (name: string) => look.materials[name] ?? look.materials[name.replace(/^world /, '')] ?? look.materials[name.split(' ').pop() ?? ''];
  const cache = new Map<string, RGB>();
  const bake = (c: RGB, name: string): RGB => {
    const k = `${name}|${c.map((v) => Math.round(v * 4096)).join(',')}`;
    let r = cache.get(k);
    if (!r) { r = bakeLinear(look, c, tweakFor(name)); cache.set(k, r); }
    return r;
  };
  let vertexColours = 0, materials = 0;
  const done = new Set<number>();
  for (const mesh of g.json.meshes ?? []) for (const p of mesh.primitives ?? []) {
    const ci = p.attributes?.COLOR_0;
    const mat = p.material !== undefined ? g.json.materials[p.material] : null;
    const name = mat?.name ?? '';
    if (ci === undefined || done.has(ci)) continue;
    const acc = g.json.accessors[ci];
    if (acc.componentType !== 5126) continue;   // float colours only (the studio writes floats)
    done.add(ci);
    const bv = g.json.bufferViews[acc.bufferView];
    const n = acc.type === 'VEC4' ? 4 : 3, stride = bv.byteStride ?? n * 4;
    const dv = new DataView(g.bin.buffer, g.bin.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0));
    for (let i = 0; i < acc.count; i++) {
      const o = i * stride;
      const c = bake([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)], name);
      dv.setFloat32(o, c[0], true); dv.setFloat32(o + 4, c[1], true); dv.setFloat32(o + 8, c[2], true);
      vertexColours++;
    }
  }
  for (const m of g.json.materials ?? []) {
    const pbr = m.pbrMetallicRoughness;
    if (!pbr) continue;
    if (m.extras?.vertexColors) continue;   // the colour rides on the vertices (already baked); the factor stays white
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const c = bake([f[0], f[1], f[2]], m.name ?? '');
    pbr.baseColorFactor = [+c[0].toFixed(5), +c[1].toFixed(5), +c[2].toFixed(5), f[3]];
    materials++;
  }
  g.json.asset = { ...(g.json.asset ?? {}), extras: { ...(g.json.asset?.extras ?? {}), lookBaked: look.name } };
  const textures = (g.json.materials ?? []).filter((m: any) => m.pbrMetallicRoughness?.baseColorTexture).length;
  return { glb: writeGlb(g), vertexColours, materials, textures };
}
