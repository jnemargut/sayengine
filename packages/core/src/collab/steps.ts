// Steps for any asset (Decision 62). One step = about one word note's worth of change ("slower",
// "warmer", "swap the clink") on the shared branching history, whatever the asset: a model, a look,
// a character action, a cutscene, an effect, the UI kit, a town. The history stores recipes only;
// renders are caches keyed by a hash of the recipe that made them, re-made on demand.
import fs from 'node:fs';
import path from 'node:path';
import type { Change, Commit } from '../history.ts';
import type { SceneDoc } from '../types.ts';
import { stamp } from './address.ts';
import { assetRecord } from './timelines.ts';

export type AssetKind = 'model' | 'character' | 'creature' | 'look' | 'cutscene' | 'effect' | 'ui' | 'town' | 'sound' | 'scene';
export interface AssetRef { kind: AssetKind; id: string; thing: string; section?: string }

/** Which asset a change touches, and which section of it ("params", "motions/pours-tea", "grade"). */
export function assetOfChange(c: Change, doc?: SceneDoc): AssetRef {
  const [root, a, b, ...rest] = c.path;
  switch (root) {
    case 'objects': {
      if (!a) return { kind: 'scene', id: 'objects', thing: 'scene' };
      const o: any = doc?.objects[a] ?? (c.after as any) ?? (c.before as any);
      const kind: AssetKind = o?.creature ? 'creature' : o?.character || o?.semanticType === 'character' ? 'character' : 'model';
      const section = b === 'character' || b === 'creature' ? [b, ...rest.slice(0, 2)].join('/') : b;
      return { kind, id: a, thing: a, ...(section ? { section } : {}) };
    }
    case 'look': {
      if (a === 'looks' && b) return { kind: 'look', id: b, thing: `look:${b}`, ...(rest[0] ? { section: rest[0] } : {}) };
      // the active look and its palette mirror belong to the active look
      const active = (doc as any)?.look?.active ?? (a === 'active' ? c.after : undefined) ?? 'look';
      return { kind: 'look', id: String(active), thing: `look:${active}`, section: a };
    }
    case 'cutscenes': return { kind: 'cutscene', id: a, thing: `cutscene:${a}`, ...(b ? { section: b } : {}) };
    case 'effects': return { kind: 'effect', id: a, thing: `effect:${a}`, ...(b ? { section: b } : {}) };
    case 'sounds': return { kind: 'sound', id: a, thing: `sound:${a}`, ...(b ? { section: b } : {}) };
    case 'ui': return { kind: 'ui', id: 'ui', thing: 'ui', ...(a ? { section: a } : {}) };
    case 'world': return { kind: 'town', id: b ?? 'world', thing: `town:${b ?? ''}`, ...(rest[0] ? { section: rest[0] } : {}) };
    case 'objectOrder': return { kind: 'scene', id: 'order', thing: 'scene' };
    default: return { kind: 'scene', id: root, thing: 'scene' };
  }
}

/** The assets a step changes (deduplicated). */
export function stepAssets(c: Commit, doc?: SceneDoc): AssetRef[] {
  const seen = new Map<string, AssetRef>();
  for (const ch of c.changes) {
    const r = assetOfChange(ch, doc);
    if (r.kind === 'scene' && c.changes.length > 1) continue;
    const k = `${r.kind}:${r.id}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

// ── before / after in plain words ────────────────────────────────────────────────────────────────

const short = (v: unknown): string => {
  if (v === undefined) return '—';
  if (typeof v === 'number') return String(+v.toFixed(4));
  if (typeof v === 'string') return v.length > 40 ? JSON.stringify(v.slice(0, 37) + '…') : JSON.stringify(v);
  const j = JSON.stringify(v);
  return j.length > 60 ? j.slice(0, 57) + '…' : j;
};

/** Leaf-level differences between two values: [path, before, after]. */
export function leafDiff(a: unknown, b: unknown, base: string[] = [], out: Array<[string, unknown, unknown]> = [], depth = 0): Array<[string, unknown, unknown]> {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (x: unknown) => x && typeof x === 'object' && !Array.isArray(x);
  if (depth < 9 && isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) leafDiff((a as any)[k], (b as any)[k], [...base, k], out, depth + 1);
    return out;
  }
  out.push([base.join('.'), a, b]);
  return out;
}

export interface BeforeAfter {
  step: string; note?: string; summary: string;
  assets: AssetRef[];
  lines: string[];                       // "seatH: 0.45 → 0.42", "added op foot", "removed key 'pause'"
  before: Record<string, string>;        // asset thing → recipe stamp before the step
  after: Record<string, string>;         // … and after (render caches are keyed by these)
}

/** A step's before and after, in plain words, with the recipe stamps of each asset it touched. */
export function beforeAfter(c: Commit, docBefore: SceneDoc, docAfter: SceneDoc): BeforeAfter {
  const assets = stepAssets(c, docAfter);
  const lines: string[] = [];
  for (const ch of c.changes) {
    const where = ch.path.slice(0, 2).join('/');
    if (ch.before === undefined) { lines.push(`added ${ch.path.slice(1).join(' ') || where}`); continue; }
    if (ch.after === undefined) { lines.push(`removed ${ch.path.slice(1).join(' ') || where}`); continue; }
    for (const [p, x, y] of leafDiff(ch.before, ch.after).slice(0, 8)) {
      const label = [...ch.path.slice(2), ...(p ? [p] : [])].join('.') || ch.path.join('.');
      lines.push(`${label.replace(/\.value$/, '')}: ${short(x)} → ${short(y)}`);
    }
  }
  const rec = (d: SceneDoc, r: AssetRef) => { const kind = r.kind === 'model' || r.kind === 'character' || r.kind === 'creature' ? 'object' : r.kind; const x = assetRecord(d, kind, r.id); return x === undefined ? 'none' : stamp(x); };
  return {
    step: c.id, ...(c.note ? { note: c.note } : {}), summary: c.summary, assets, lines: lines.slice(0, 16),
    before: Object.fromEntries(assets.map((r) => [r.thing, rec(docBefore, r)])),
    after: Object.fromEntries(assets.map((r) => [r.thing, rec(docAfter, r)])),
  };
}

// ── render caches (never history) ─────────────────────────────────────────────────────────────────

/** The cache key for a render: what was rendered (the recipe, plus the look it is graded with) and how. */
export function renderKey(recipe: unknown, how: Record<string, unknown> = {}): string {
  return stamp({ recipe, how });
}

/** Renders on disk, keyed by recipe hash. Delete the folder any time: everything is re-made on demand. */
export class RenderCache {
  dir: string; private maxFiles: number;
  constructor(dir: string, maxFiles = 400) { this.dir = dir; this.maxFiles = maxFiles; fs.mkdirSync(dir, { recursive: true }); }
  file(key: string, name: string): string { return path.join(this.dir, `${key}-${name.replace(/[^a-z0-9._-]/gi, '_')}`); }
  has(key: string, names: string[]): boolean { return names.every((n) => fs.existsSync(this.file(key, n))); }
  get(key: string, names: string[]): string[] | null { return this.has(key, names) ? names.map((n) => this.file(key, n)) : null; }
  put(key: string, name: string, bytes: Uint8Array): string {
    const f = this.file(key, name);
    fs.writeFileSync(f, bytes);
    this.prune();
    return f;
  }
  /** Render through the cache: `make` runs only when some file for this recipe is missing. */
  async through(key: string, names: string[], make: () => Promise<Record<string, Uint8Array>>): Promise<{ files: string[]; cached: boolean }> {
    const hit = this.get(key, names);
    if (hit) return { files: hit, cached: true };
    const made = await make();
    return { files: names.map((n) => this.put(key, n, made[n])), cached: false };
  }
  private prune() {
    const all = fs.readdirSync(this.dir).map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => a.t - b.t);
    for (const x of all.slice(0, Math.max(0, all.length - this.maxFiles))) fs.rmSync(path.join(this.dir, x.f), { force: true });
  }
}
