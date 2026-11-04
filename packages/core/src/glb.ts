// A small glTF 2.0 binary (GLB) writer shared by the plain and game exporters.
// DOM-free and Node-free.
export class GlbBuilder {
  buffers: Uint8Array[] = []; offset = 0;
  gltf: any = { asset: { version: '2.0', generator: 'ai-3d-studio' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], images: [], textures: [], samplers: [] };
  used = new Set<string>();
  view(bytes: Uint8Array, target?: number) {
    const pad = (4 - (this.offset % 4)) % 4;
    if (pad) { this.buffers.push(new Uint8Array(pad)); this.offset += pad; }
    this.gltf.bufferViews.push({ buffer: 0, byteOffset: this.offset, byteLength: bytes.length, ...(target ? { target } : {}) });
    this.buffers.push(bytes); this.offset += bytes.length;
    return this.gltf.bufferViews.length - 1;
  }
  accessor(arr: Float32Array, type: 'VEC2' | 'VEC3', minmax = false) {
    const comps = type === 'VEC2' ? 2 : 3;
    const acc: any = { bufferView: this.view(new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)), 34962), componentType: 5126, count: arr.length / comps, type };
    if (minmax) {
      const mn = Array(comps).fill(Infinity), mx = Array(comps).fill(-Infinity);
      for (let i = 0; i < arr.length; i += comps) for (let k = 0; k < comps; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); }
      acc.min = mn; acc.max = mx;
    }
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }
  /** Any typed array as an accessor (joints, weights, matrices, animation keys…). */
  typed(arr: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', opts: { target?: number; minmax?: boolean } = {}) {
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType = arr instanceof Float32Array ? 5126 : arr instanceof Uint16Array ? 5123 : 5125;
    const acc: any = { bufferView: this.view(new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)), opts.target), componentType, count: arr.length / comps, type };
    if (opts.minmax) {
      const mn = Array(comps).fill(Infinity), mx = Array(comps).fill(-Infinity);
      for (let i = 0; i < arr.length; i += comps) for (let k = 0; k < comps; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); }
      acc.min = mn; acc.max = mx;
    }
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }
  /** A sparse VEC3 accessor: zeros except at `idx` (morph-target deltas). */
  sparseVec3(count: number, idx: Uint32Array, values: Float32Array) {
    // min/max over the real values: zeros count only where the sparse list leaves elements untouched
    const zeros = idx.length < count;
    const mn = zeros ? [0, 0, 0] : [Infinity, Infinity, Infinity], mx = zeros ? [0, 0, 0] : [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < values.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], values[i + k]); mx[k] = Math.max(mx[k], values[i + k]); }
    if (!zeros && !values.length) { mn.fill(0); mx.fill(0); }
    const acc: any = { componentType: 5126, count, type: 'VEC3', min: mn, max: mx };
    if (idx.length) acc.sparse = { count: idx.length, indices: { bufferView: this.view(new Uint8Array(idx.buffer.slice(idx.byteOffset, idx.byteOffset + idx.byteLength))), componentType: 5125 }, values: { bufferView: this.view(new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength))) } };
    this.gltf.accessors.push(acc);
    return this.gltf.accessors.length - 1;
  }
  image(png: Uint8Array, name: string) {
    this.gltf.images.push({ name, mimeType: 'image/png', bufferView: this.view(png) });
    if (!this.gltf.samplers.length) this.gltf.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    this.gltf.textures.push({ source: this.gltf.images.length - 1, sampler: 0 });
    return this.gltf.textures.length - 1;
  }
  build(): Uint8Array {
    const g = this.gltf;
    for (const k of ['images', 'textures', 'samplers', 'materials', 'skins', 'animations']) if (g[k] && !g[k].length) delete g[k];
    if (this.used.size) g.extensionsUsed = [...this.used];
    const bin = new Uint8Array(this.offset);
    let o = 0;
    for (const b of this.buffers) { bin.set(b, o); o += b.length; }
    g.buffers = [{ byteLength: bin.length }];
    const pad = (n: number) => (4 - (n % 4)) % 4;
    let json = new TextEncoder().encode(JSON.stringify(g));
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
}
