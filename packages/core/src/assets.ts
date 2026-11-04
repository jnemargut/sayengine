// Asset store for imported files (meshes, reference images). Content-addressed: the id is a hash
// of the bytes plus the extension, so re-importing the same file reuses it. The daemon uses a
// folder (.studio/assets); tests use memory.
const nodeFs = () => (process as any).getBuiltinModule('node:fs') as typeof import('node:fs');
const nodePath = () => (process as any).getBuiltinModule('node:path') as typeof import('node:path');
const nodeCrypto = () => (process as any).getBuiltinModule('node:crypto') as typeof import('node:crypto');

export interface AssetStore {
  put(bytes: Uint8Array, ext: string): string;
  get(id: string): Uint8Array;
  has(id: string): boolean;
  /** Read an outside file (import source). Relative paths resolve against the project folder. */
  readExternal(file: string): Uint8Array;
}

export function assetId(bytes: Uint8Array, ext: string): string {
  const h = nodeCrypto().createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  return `${h}.${ext.replace(/^\./, '').toLowerCase()}`;
}

export class MemoryAssets implements AssetStore {
  private m = new Map<string, Uint8Array>();
  private base: string;
  constructor(base = process.cwd()) { this.base = base; }
  put(bytes: Uint8Array, ext: string) { const id = assetId(bytes, ext); this.m.set(id, bytes); return id; }
  get(id: string) { const b = this.m.get(id); if (!b) throw new Error(`asset ${id} not found`); return b; }
  has(id: string) { return this.m.has(id); }
  readExternal(file: string) { return new Uint8Array(nodeFs().readFileSync(nodePath().resolve(this.base, file))); }
}

export class DirAssets implements AssetStore {
  private dir: string; private base: string;
  constructor(dir: string, base: string) { this.dir = dir; this.base = base; nodeFs().mkdirSync(dir, { recursive: true }); }
  path(id: string) {
    if (!/^[a-f0-9]{16}\.[a-z0-9]+$/.test(id)) throw new Error(`bad asset id "${id}"`);
    return nodePath().join(this.dir, id);
  }
  put(bytes: Uint8Array, ext: string) {
    const id = assetId(bytes, ext);
    const p = this.path(id);
    if (!nodeFs().existsSync(p)) nodeFs().writeFileSync(p, bytes);
    return id;
  }
  get(id: string) { return new Uint8Array(nodeFs().readFileSync(this.path(id))); }
  has(id: string) { try { return nodeFs().existsSync(this.path(id)); } catch { return false; } }
  readExternal(file: string) {
    const p = nodePath().resolve(this.base, file);
    if (!nodeFs().existsSync(p)) throw new Error(`file not found: ${p}`);
    return new Uint8Array(nodeFs().readFileSync(p));
  }
}
