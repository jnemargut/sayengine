// "Show me three" (Decision 62): three deliberately distinct takes, compared per section; your pick
// is logged and the other takes are discarded, never merged. Alternatives tend to converge (AI
// suggestions and pick loops both narrow), so distinctness is enforced, not hoped for.
import { leafDiff } from './steps.ts';

export const MIN_DISTINCT = 0.15;

export interface TakeLeaves { label: string; leaves: Map<string, unknown> }

/** Every leaf a take changed relative to the base: "objects.stool.params.legSplay.value" → 8. */
export function changedLeaves(base: unknown, take: unknown, root: string[] = []): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const [p, , after] of leafDiff(base, take, root)) m.set(p, after);
  return m;
}

/** How different two values are, 0..1: numbers relative to their size, anything else equal or not. */
export function valueDistance(a: unknown, b: unknown, base: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    const scale = Math.max(Math.abs(a - (typeof base === 'number' ? base : 0)), Math.abs(b - (typeof base === 'number' ? base : 0)), Math.abs(a), Math.abs(b), 1e-9);
    return Math.min(1, Math.abs(a - b) / scale);
  }
  return JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

/**
 * Distance between two takes over every leaf either of them (or the third) changed: the mean of
 * per-leaf distances. A leaf only one take changed compares that take's value with the base.
 */
export function takeDistance(a: TakeLeaves, b: TakeLeaves, baseOf: (path: string) => unknown, paths?: string[]): number {
  const keys = paths ?? [...new Set([...a.leaves.keys(), ...b.leaves.keys()])];
  if (!keys.length) return 0;
  let sum = 0;
  for (const k of keys) {
    const base = baseOf(k);
    const va = a.leaves.has(k) ? a.leaves.get(k) : base, vb = b.leaves.has(k) ? b.leaves.get(k) : base;
    sum += valueDistance(va, vb, base);
  }
  return sum / keys.length;
}

export interface Distinctness { pairs: Array<{ a: string; b: string; distance: number }>; min: number; ok: boolean; tooAlike: string[] }

export function distinctness(takes: TakeLeaves[], baseOf: (path: string) => unknown, min = MIN_DISTINCT): Distinctness {
  const all = [...new Set(takes.flatMap((t) => [...t.leaves.keys()]))];
  const pairs: Distinctness['pairs'] = [];
  for (let i = 0; i < takes.length; i++) for (let j = i + 1; j < takes.length; j++) pairs.push({ a: takes[i].label, b: takes[j].label, distance: +takeDistance(takes[i], takes[j], baseOf, all).toFixed(3) });
  const tooAlike = pairs.filter((p) => p.distance < min).map((p) => `${p.a} and ${p.b} are only ${Math.round(p.distance * 100)}% apart (need ≥ ${Math.round(min * 100)}%)`);
  for (const t of takes) if (!t.leaves.size) tooAlike.push(`${t.label} changes nothing`);
  return { pairs, min, ok: !tooAlike.length, tooAlike };
}

/** Group changed leaves into sections for the side-by-side compare. */
export function sectionsOf(takes: TakeLeaves[], sectionOf: (path: string) => string, baseOf: (path: string) => unknown) {
  const by = new Map<string, Set<string>>();
  for (const t of takes) for (const k of t.leaves.keys()) { const s = sectionOf(k); if (!by.has(s)) by.set(s, new Set()); by.get(s)!.add(k); }
  const fmt = (v: unknown) => (typeof v === 'number' ? String(+v.toFixed(4)) : v === undefined ? '—' : JSON.stringify(v).slice(0, 40));
  return [...by.entries()].map(([section, keys]) => {
    const ks = [...keys];
    const cells = Object.fromEntries(takes.map((t) => [t.label, ks.filter((k) => t.leaves.has(k)).map((k) => `${k.split('.').slice(-2).join('.').replace(/\.value$/, '')}: ${fmt(baseOf(k))} → ${fmt(t.leaves.get(k))}`)]));
    let spread = 0, n = 0;
    for (let i = 0; i < takes.length; i++) for (let j = i + 1; j < takes.length; j++) { spread += takeDistance(takes[i], takes[j], baseOf, ks); n++; }
    return { section, takes: cells, spread: +(n ? spread / n : 0).toFixed(3) };
  });
}
