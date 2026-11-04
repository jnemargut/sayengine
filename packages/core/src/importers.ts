// Mesh and image importers (DOM-free). Meshes come back welded (shared vertices) so watertight
// files become valid manifolds and can be used in booleans; units and up-axis are normalised to
// the studio's metres, Y-up.

export interface RawMesh { positions: Float32Array; indices: Uint32Array }
export type MeshFormat = 'stl' | 'obj' | 'glb';
export type Units = 'm' | 'cm' | 'mm' | 'in';
export const UNIT_SCALE: Record<Units, number> = { m: 1, cm: 0.01, mm: 0.001, in: 0.0254 };

export function formatOf(file: string): MeshFormat | 'png' | 'jpg' | null {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  if (ext === 'stl' || ext === 'obj' || ext === 'glb') return ext;
  if (ext === 'png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpg';
  return null;
}

/** Sensible defaults per format: STL is usually mm and Z-up (slicers), OBJ/GLB metres and Y-up. */
export const FORMAT_DEFAULTS: Record<MeshFormat, { units: Units; up: 'y' | 'z' }> = {
  stl: { units: 'mm', up: 'z' }, obj: { units: 'm', up: 'y' }, glb: { units: 'm', up: 'y' },
};

function parseSTL(b: Uint8Array): number[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: number[] = [];
  if (b.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === b.byteLength) {
      for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) out.push(dv.getFloat32(84 + t * 50 + 12 + v * 12 + k * 4, true));
      return out;
    }
  }
  const text = new TextDecoder().decode(b);
  if (!/^\s*solid/.test(text)) throw new Error('not a valid STL (binary size mismatch and no "solid" header)');
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) out.push(+m[1], +m[2], +m[3]);
  if (out.length % 9) throw new Error('ASCII STL: vertex count is not a multiple of 3');
  return out;
}

function parseOBJ(b: Uint8Array): { pos: number[]; idx: number[] } {
  const pos: number[] = [], idx: number[] = [];
  for (const line of new TextDecoder().decode(b).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') pos.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'f') {
      const n = pos.length / 3;
      const vs = t.slice(1).map((s) => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? n + i : i - 1; });
      for (let k = 1; k + 1 < vs.length; k++) idx.push(vs[0], vs[k], vs[k + 1]);
    }
  }
  if (!idx.length) throw new Error('OBJ has no faces');
  return { pos, idx };
}

type M4 = number[];
const ident = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n: any): M4 {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function parseGLB(b: Uint8Array): { pos: number[]; idx: number[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB file (bad magic); export as binary .glb');
  let off = 12, json: any = null, bin: Uint8Array | null = null;
  while (off < b.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const chunk = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('GLB is missing its JSON or BIN chunk');
  if ((json.extensionsRequired ?? []).some((e: string) => /draco|meshopt/i.test(e))) throw new Error('compressed GLB (Draco/meshopt) is not supported — export uncompressed');
  const read = (ai: number): { data: number[]; comps: number } => {
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string] ?? 1;
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as number] ?? 4;
    const stride = bv.byteStride ?? comps * size;
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const bd = new DataView(bin!.buffer, bin!.byteOffset, bin!.byteLength);
    const data: number[] = [];
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      data.push(a.componentType === 5126 ? bd.getFloat32(o, true) : a.componentType === 5125 ? bd.getUint32(o, true) : a.componentType === 5123 ? bd.getUint16(o, true) : a.componentType === 5121 ? bd.getUint8(o) : a.componentType === 5122 ? bd.getInt16(o, true) : bd.getInt8(o));
    }
    return { data, comps };
  };
  const pos: number[] = [], idx: number[] = [];
  const visit = (ni: number, parent: M4) => {
    const n = json.nodes[ni];
    const m = mul(parent, trs(n));
    if (n.mesh !== undefined) {
      for (const prim of json.meshes[n.mesh].primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
        const p = read(prim.attributes.POSITION).data;
        const base = pos.length / 3;
        for (let i = 0; i < p.length; i += 3) {
          const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
          pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        const ix = prim.indices !== undefined ? read(prim.indices).data : Array.from({ length: p.length / 3 }, (_, i) => i);
        for (const i of ix) idx.push(base + i);
      }
    }
    for (const c of n.children ?? []) visit(c, m);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? json.nodes.map((_: any, i: number) => i);
  for (const r of roots) visit(r, ident());
  if (!idx.length) throw new Error('GLB has no triangle meshes');
  return { pos, idx };
}

/** Merge vertices closer than `eps` so the mesh shares edges (needed for a valid manifold). */
function weld(pos: number[], idx: number[] | null, eps = 1e-6): RawMesh {
  const key = (x: number, y: number, z: number) => `${Math.round(x / eps)},${Math.round(y / eps)},${Math.round(z / eps)}`;
  const map = new Map<string, number>();
  const outP: number[] = [];
  const remap: number[] = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    let j = map.get(k);
    if (j === undefined) { j = outP.length / 3; map.set(k, j); outP.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    remap.push(j);
  }
  const src = idx ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
  const outI: number[] = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = remap[src[t]], b = remap[src[t + 1]], c = remap[src[t + 2]];
    if (a !== b && b !== c && a !== c) outI.push(a, b, c); // drop degenerate triangles
  }
  return { positions: new Float32Array(outP), indices: new Uint32Array(outI) };
}

export interface MeshImportOpts { units?: Units; up?: 'y' | 'z'; scale?: number; center?: boolean }

/** Parse a mesh file into metres, Y-up. center=true puts it on the floor, centred on the origin. */
export function parseMesh(bytes: Uint8Array, format: MeshFormat, opts: MeshImportOpts = {}): RawMesh {
  let pos: number[], idx: number[] | null = null;
  if (format === 'stl') pos = parseSTL(bytes);
  else if (format === 'obj') ({ pos, idx } = parseOBJ(bytes));
  else ({ pos, idx } = parseGLB(bytes));
  const d = FORMAT_DEFAULTS[format];
  const s = UNIT_SCALE[opts.units ?? d.units] * (opts.scale ?? 1);
  const zUp = (opts.up ?? d.up) === 'z';
  for (let i = 0; i < pos.length; i += 3) {
    const [x, y, z] = [pos[i] * s, pos[i + 1] * s, pos[i + 2] * s];
    if (zUp) { pos[i] = x; pos[i + 1] = z; pos[i + 2] = -y; } // inverse of the STL export mapping
    else { pos[i] = x; pos[i + 1] = y; pos[i + 2] = z; }
  }
  const m = weld(pos, idx, 1e-6); // 1 µm, in metres
  if (opts.center !== false && m.positions.length) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.positions[i + k]); max[k] = Math.max(max[k], m.positions[i + k]); }
    const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
    for (let i = 0; i < m.positions.length; i += 3) { m.positions[i] -= cx; m.positions[i + 1] -= min[1]; m.positions[i + 2] -= cz; }
  }
  return m;
}

/** Pixel size of a PNG or JPEG (enough to keep a reference image's aspect ratio). */
export function imageSize(b: Uint8Array): { width: number; height: number; type: 'png' | 'jpg' } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'png' };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1];
      const len = dv.getUint16(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7), type: 'jpg' };
      o += 2 + len;
    }
  }
  throw new Error('reference images must be PNG or JPEG');
}
