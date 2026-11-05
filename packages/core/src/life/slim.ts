// Slim a cast GLB for a crowd (Phase 4 polish): town folk never speak, so their face shapes go; the
// vertex data is quantized (KHR_mesh_quantization: positions 16-bit, normals 8-bit, UVs 16-bit, weights
// and joints 8-bit); clips drop the channels that never move to a single key; unused buffers go. A
// skinned mesh's dequantization (offset + scale) is folded into the skin's inverse bind matrices, which
// is exact (the vertex is joint × IBM × v, and v = offset + scale × q), so nothing moves on screen.
// Both engines read it as is (three.js GLTFLoader and Godot's glTF import support the extension).
// Pure: bytes in, bytes out.

interface Acc { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[]; sparse?: unknown }
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const CSIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export interface SlimReport { before: number; after: number; morphTargets: number; constantChannels: number; vertices: number }

export function slimGlb(input: Uint8Array, o: { keepMorphs?: boolean; quantize?: boolean } = {}): { glb: Uint8Array; report: SlimReport } {
  const quantize = o.quantize !== false;
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const jlen = dv.getUint32(12, true);
  const J = JSON.parse(new TextDecoder().decode(input.subarray(20, 20 + jlen)));
  const binStart = 20 + jlen + 8;
  const bin = input.subarray(binStart, binStart + dv.getUint32(20 + jlen, true));
  if ((J.extensionsUsed ?? []).includes('KHR_mesh_quantization')) return { glb: input, report: { before: input.length, after: input.length, morphTargets: 0, constantChannels: 0, vertices: 0 } };
  const accs: Acc[] = J.accessors;
  const views: any[] = J.bufferViews;

  /** An accessor's values as floats (dense; sparse accessors are expanded). */
  const read = (ai: number): Float64Array => {
    const a = accs[ai], n = NCOMP[a.type], out = new Float64Array(a.count * n);
    if (a.bufferView !== undefined) {
      const v = views[a.bufferView], cs = CSIZE[a.componentType], stride = v.byteStride ?? cs * n;
      const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      const d = new DataView(bin.buffer, bin.byteOffset + base);
      for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) {
        const off = i * stride + k * cs;
        out[i * n + k] = a.componentType === 5126 ? d.getFloat32(off, true) : a.componentType === 5125 ? d.getUint32(off, true) : a.componentType === 5123 ? d.getUint16(off, true) : a.componentType === 5122 ? d.getInt16(off, true) : a.componentType === 5121 ? d.getUint8(off) : d.getInt8(off);
      }
    }
    return out;
  };

  // the new binary, written view by view (4-byte aligned)
  const chunks: Uint8Array[] = [];
  let size = 0;
  const newViews: any[] = [], newAccs: Acc[] = [];
  const addView = (bytes: Uint8Array, extra: Record<string, unknown> = {}) => {
    const pad = (4 - (size % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); size += pad; }
    newViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length, ...extra });
    chunks.push(bytes); size += bytes.length;
    return newViews.length - 1;
  };
  const addAcc = (a: Acc) => { newAccs.push(a); return newAccs.length - 1; };
  /** Copy an accessor unchanged (densified, tightly packed) into the new binary. */
  const copied = new Map<number, number>();
  const copyAcc = (ai: number): number => {
    if (copied.has(ai)) return copied.get(ai)!;
    const a = accs[ai];
    let idx: number;
    if (a.sparse || a.bufferView === undefined) {
      const vals = read(ai), f = new Float32Array(vals);
      idx = addAcc({ bufferView: addView(new Uint8Array(f.buffer)), componentType: 5126, count: a.count, type: a.type, ...(a.min ? { min: a.min, max: a.max } : {}) });
    } else {
      const v = views[a.bufferView], n = NCOMP[a.type], cs = CSIZE[a.componentType], el = n * cs, stride = v.byteStride ?? el;
      const src = bin.subarray((v.byteOffset ?? 0) + (a.byteOffset ?? 0));
      const out = new Uint8Array(a.count * el);
      for (let i = 0; i < a.count; i++) out.set(src.subarray(i * stride, i * stride + el), i * el);
      const { bufferView: _b, byteOffset: _o, ...rest } = a;
      idx = addAcc({ ...rest, bufferView: addView(out) });
    }
    copied.set(ai, idx);
    return idx;
  };

  let morphTargets = 0, constantChannels = 0, vertices = 0;
  // ── meshes ──
  const skinOfMesh = new Map<number, number>();
  for (const n of J.nodes ?? []) if (n.mesh !== undefined && n.skin !== undefined) skinOfMesh.set(n.mesh, n.skin);
  const meshDequant = new Map<number, { off: number[]; scale: number[] }>();
  for (let mi = 0; mi < (J.meshes ?? []).length; mi++) {
    const m = J.meshes[mi];
    const skinned = skinOfMesh.has(mi);
    // one position range for the whole mesh (every primitive shares the skin)
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of m.primitives) { const P = read(p.attributes.POSITION); for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], P[i + k]); hi[k] = Math.max(hi[k], P[i + k]); } }
    // one scale for all three axes, so the skinning matrices stay uniform and normals keep their directions
    const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6), scale = [ext, ext, ext];
    // (Godot's glTF import has no KHR_mesh_quantization: there positions and normals stay floats; 8-bit
    // weights and joints and 16-bit UVs are core glTF, so every engine gets those)
    if (skinned && quantize) meshDequant.set(mi, { off: lo, scale });
    for (const p of m.primitives) {
      if (!o.keepMorphs && p.targets) { morphTargets += p.targets.length; delete p.targets; }
      const at: Record<string, number> = {};
      for (const [name, ai] of Object.entries(p.attributes) as Array<[string, number]>) {
        const a = accs[ai], vals = read(ai), count = a.count;
        if (name === 'POSITION') vertices += count;
        if (name === 'POSITION' && skinned && quantize) {
          const q = new Uint16Array(count * 4);       // padded to 8 bytes a vertex
          for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.round(((vals[i * 3 + k] - lo[k]) / scale[k]) * 65535);
          const mn = [65535, 65535, 65535], mx = [0, 0, 0];
          for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], q[i * 4 + k]); mx[k] = Math.max(mx[k], q[i * 4 + k]); }
          at[name] = addAcc({ bufferView: addView(new Uint8Array(q.buffer), { byteStride: 8, target: 34962 }), componentType: 5123, normalized: true, count, type: 'VEC3', min: mn, max: mx });
        } else if (name === 'NORMAL' && quantize) {
          const q = new Int8Array(count * 4);
          for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) q[i * 4 + k] = Math.max(-127, Math.min(127, Math.round(vals[i * 3 + k] * 127)));
          at[name] = addAcc({ bufferView: addView(new Uint8Array(q.buffer), { byteStride: 4, target: 34962 }), componentType: 5120, normalized: true, count, type: 'VEC3' });
        } else if (name.startsWith('TEXCOORD') && vals.every((x) => x >= 0 && x <= 1)) {
          const q = new Uint16Array(count * 2);
          for (let i = 0; i < count * 2; i++) q[i] = Math.round(vals[i] * 65535);
          at[name] = addAcc({ bufferView: addView(new Uint8Array(q.buffer), { target: 34962 }), componentType: 5123, normalized: true, count, type: 'VEC2' });
        } else if (name.startsWith('WEIGHTS')) {
          const q = new Uint8Array(count * 4);
          for (let i = 0; i < count; i++) {
            const w = [0, 1, 2, 3].map((k) => vals[i * 4 + k]), s = w.reduce((x, y) => x + y, 0) || 1;
            const b = w.map((x) => Math.round((x / s) * 255));
            // keep the sum exactly 255: the rounding error goes to the biggest weight
            const big = b.indexOf(Math.max(...b)); b[big] += 255 - b.reduce((x, y) => x + y, 0);
            for (let k = 0; k < 4; k++) q[i * 4 + k] = b[k];
          }
          at[name] = addAcc({ bufferView: addView(q, { target: 34962 }), componentType: 5121, normalized: true, count, type: 'VEC4' });
        } else if (name.startsWith('JOINTS') && vals.every((x) => x < 256)) {
          const q = new Uint8Array(count * 4);
          for (let i = 0; i < count * 4; i++) q[i] = vals[i];
          at[name] = addAcc({ bufferView: addView(q, { target: 34962 }), componentType: 5121, count, type: 'VEC4' });
        } else at[name] = copyAcc(ai);
      }
      p.attributes = at;
      if (p.indices !== undefined) p.indices = copyAcc(p.indices);
    }
    if (!o.keepMorphs) { delete m.weights; if (m.extras) delete m.extras.targetNames; }
  }
  // ── skins: fold the dequantization into the inverse bind matrices ──
  for (let si = 0; si < (J.skins ?? []).length; si++) {
    const sk = J.skins[si];
    const mesh = [...skinOfMesh.entries()].find(([, s]) => s === si)?.[0];
    const dq = mesh !== undefined ? meshDequant.get(mesh) : undefined;
    if (sk.inverseBindMatrices === undefined) { if (dq) throw new Error('a quantized skin needs inverse bind matrices'); continue; }
    const M = read(sk.inverseBindMatrices);
    if (dq) {
      // IBM' = IBM × T(off) × S(scale)   (column-major 4×4)
      for (let j = 0; j < M.length / 16; j++) {
        const b = j * 16, c0 = [M[b], M[b + 1], M[b + 2], M[b + 3]], c1 = [M[b + 4], M[b + 5], M[b + 6], M[b + 7]], c2 = [M[b + 8], M[b + 9], M[b + 10], M[b + 11]], c3 = [M[b + 12], M[b + 13], M[b + 14], M[b + 15]];
        for (let r = 0; r < 4; r++) {
          M[b + 12 + r] = c0[r] * dq.off[0] + c1[r] * dq.off[1] + c2[r] * dq.off[2] + c3[r];
          M[b + r] = c0[r] * dq.scale[0]; M[b + 4 + r] = c1[r] * dq.scale[1]; M[b + 8 + r] = c2[r] * dq.scale[2];
        }
      }
    }
    const f = new Float32Array(M);
    sk.inverseBindMatrices = addAcc({ bufferView: addView(new Uint8Array(f.buffer)), componentType: 5126, count: M.length / 16, type: 'MAT4' });
  }
  // ── animations: a channel that never moves keeps one key ──
  for (const an of J.animations ?? []) {
    if (!o.keepMorphs) {
      // the face shapes are gone, so are the channels that drove them
      an.channels = an.channels.filter((c: any) => c.target.path !== 'weights');
      const used = [...new Set(an.channels.map((c: any) => c.sampler))] as number[];
      const remap = new Map(used.map((s, k) => [s, k]));
      an.samplers = used.map((s) => an.samplers[s]);
      for (const c of an.channels) c.sampler = remap.get(c.sampler);
    }
    const done = new Map<number, number>();
    for (const sm of an.samplers) {
      const out = read(sm.output), n = NCOMP[accs[sm.output].type], cnt = accs[sm.output].count;
      let still = sm.interpolation !== 'CUBICSPLINE';
      for (let i = 1; i < cnt && still; i++) for (let k = 0; k < n; k++) if (Math.abs(out[i * n + k] - out[k]) > 1e-5) { still = false; break; }
      if (still && cnt > 1) {
        constantChannels++;
        const inp = read(sm.input);
        const fi = new Float32Array([inp[0]]), fo = new Float32Array(out.subarray(0, n));
        sm.input = addAcc({ bufferView: addView(new Uint8Array(fi.buffer)), componentType: 5126, count: 1, type: 'SCALAR', min: [inp[0]], max: [inp[0]] });
        sm.output = addAcc({ bufferView: addView(new Uint8Array(fo.buffer)), componentType: 5126, count: 1, type: accs[sm.output].type });
      } else {
        if (!done.has(sm.input)) done.set(sm.input, copyAcc(sm.input));
        sm.input = done.get(sm.input)!;
        sm.output = copyAcc(sm.output);
      }
    }
  }
  // ── images ──
  for (const im of J.images ?? []) if (im.bufferView !== undefined) {
    const v = views[im.bufferView];
    im.bufferView = addView(bin.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength));
  }
  J.accessors = newAccs; J.bufferViews = newViews;
  J.buffers = [{ byteLength: size }];
  if (quantize) {
    J.extensionsUsed = [...new Set([...(J.extensionsUsed ?? []), 'KHR_mesh_quantization'])];
    J.extensionsRequired = [...new Set([...(J.extensionsRequired ?? []), 'KHR_mesh_quantization'])];
  }
  // pack
  const jsonBytes = new TextEncoder().encode(JSON.stringify(J));
  const jpad = (4 - (jsonBytes.length % 4)) % 4, bpad = (4 - (size % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jpad + 8 + size + bpad;
  const outB = new Uint8Array(total), od = new DataView(outB.buffer);
  od.setUint32(0, 0x46546c67, true); od.setUint32(4, 2, true); od.setUint32(8, total, true);
  od.setUint32(12, jsonBytes.length + jpad, true); od.setUint32(16, 0x4e4f534a, true);
  outB.set(jsonBytes, 20); for (let i = 0; i < jpad; i++) outB[20 + jsonBytes.length + i] = 0x20;
  let p = 20 + jsonBytes.length + jpad;
  od.setUint32(p, size + bpad, true); od.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { outB.set(c, p); p += c.length; }
  return { glb: outB, report: { before: input.length, after: total, morphTargets, constantChannels, vertices } };
}

/**
 * Give a wheel-rig vehicle exported as one mesh its wheels back as nodes the engines can turn: the
 * "wheels" primitive is split into one mesh per wheel (by side and axle), each under a pivot at its hub:
 * "steer-<k>" (turned about Y to steer; the views only turn the front ones) → "wheel-<k>" (spun about X
 * as it rolls). Body and cabin stay one mesh. extras.wheels lists [{ node, r, front }]. Bytes in, bytes out.
 */
export function rigWheels(input: Uint8Array): { glb: Uint8Array; wheels: number } {
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const jlen = dv.getUint32(12, true);
  const J = JSON.parse(new TextDecoder().decode(input.subarray(20, 20 + jlen)));
  const binStart = 20 + jlen + 8;
  const bin = input.subarray(binStart, binStart + dv.getUint32(20 + jlen, true));
  if (J.nodes.some((n: any) => /^wheel-/.test(n.name ?? ''))) return { glb: input, wheels: 0 };
  const f32 = (ai: number): Float32Array => {
    const a = J.accessors[ai], v = J.bufferViews[a.bufferView], n = a.type === 'VEC3' ? 3 : a.type === 'VEC2' ? 2 : 4;
    const out = new Float32Array(a.count * n), stride = v.byteStride ?? n * 4;
    const d = new DataView(bin.buffer, bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0));
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) out[i * n + k] = d.getFloat32(i * stride + k * 4, true);
    return out;
  };
  const rootIdx = J.nodes.findIndex((n: any) => n.mesh !== undefined);
  if (rootIdx < 0) return { glb: input, wheels: 0 };
  const root = J.nodes[rootIdx], mesh = J.meshes[root.mesh];
  const wi = mesh.primitives.findIndex((p: any) => /wheel/i.test(J.materials[p.material]?.name ?? ''));
  if (wi < 0 || mesh.primitives[wi].indices !== undefined) return { glb: input, wheels: 0 };
  const wp = mesh.primitives[wi];
  const P = f32(wp.attributes.POSITION), N = f32(wp.attributes.NORMAL);
  const tris = P.length / 9;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < P.length; i += 3) { zmin = Math.min(zmin, P[i + 2]); zmax = Math.max(zmax, P[i + 2]); }
  const zmid = (zmin + zmax) / 2;
  const groups = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    const cx = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, cz = (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3;
    const key = `${cz > zmid ? 'f' : 'r'}${cx > 0 ? 'l' : 'r'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const chunks: Uint8Array[] = [bin.slice()];
  let size = bin.length;
  const add = (arr: Float32Array, min?: number[], max?: number[]) => {
    const pad = (4 - (size % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); size += pad; }
    J.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: arr.byteLength, target: 34962 });
    chunks.push(new Uint8Array(arr.buffer.slice(0))); size += arr.byteLength;
    J.accessors.push({ bufferView: J.bufferViews.length - 1, componentType: 5126, count: arr.length / 3, type: 'VEC3', ...(min ? { min, max } : {}) });
    return J.accessors.length - 1;
  };
  const wheelsInfo: Array<{ node: string; r: number; front: boolean }> = [];
  const children: number[] = [];
  J.meshes.push({ name: `${root.name} body`, primitives: mesh.primitives.filter((_: any, k: number) => k !== wi) });
  J.nodes.push({ name: `${root.name} body`, mesh: J.meshes.length - 1 });
  children.push(J.nodes.length - 1);
  for (const [key, ts] of [...groups.entries()].sort()) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of ts) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) { const x = P[t * 9 + v * 3 + k]; lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x); }
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    const pos = new Float32Array(ts.length * 9), nor = new Float32Array(ts.length * 9);
    ts.forEach((t, q) => { for (let v = 0; v < 9; v++) { pos[q * 9 + v] = P[t * 9 + v] - c[v % 3]; nor[q * 9 + v] = N[t * 9 + v]; } });
    const pa = add(pos, [0, 1, 2].map((k) => lo[k] - c[k]), [0, 1, 2].map((k) => hi[k] - c[k])), na = add(nor);
    J.meshes.push({ name: `wheel ${key}`, primitives: [{ attributes: { POSITION: pa, NORMAL: na }, material: wp.material }] });
    J.nodes.push({ name: `wheel-${key}`, mesh: J.meshes.length - 1 });
    const wheelNode = J.nodes.length - 1;
    J.nodes.push({ name: `steer-${key}`, translation: c, children: [wheelNode] });
    children.push(J.nodes.length - 1);
    wheelsInfo.push({ node: `wheel-${key}`, r: +((hi[1] - lo[1]) / 2).toFixed(3), front: key[0] === 'f' });
  }
  delete root.mesh;
  root.children = [...(root.children ?? []), ...children];
  root.extras = { ...(root.extras ?? {}), wheels: wheelsInfo };
  J.buffers = [{ byteLength: size }];
  const jsonBytes = new TextEncoder().encode(JSON.stringify(J));
  const jpad = (4 - (jsonBytes.length % 4)) % 4, bpad = (4 - (size % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jpad + 8 + size + bpad;
  const outB = new Uint8Array(total), od = new DataView(outB.buffer);
  od.setUint32(0, 0x46546c67, true); od.setUint32(4, 2, true); od.setUint32(8, total, true);
  od.setUint32(12, jsonBytes.length + jpad, true); od.setUint32(16, 0x4e4f534a, true);
  outB.set(jsonBytes, 20); for (let i = 0; i < jpad; i++) outB[20 + jsonBytes.length + i] = 0x20;
  let p = 20 + jsonBytes.length + jpad;
  od.setUint32(p, size + bpad, true); od.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { outB.set(c, p); p += c.length; }
  return { glb: outB, wheels: wheelsInfo.length };
}
