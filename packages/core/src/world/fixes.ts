// The fix layer (Decision 27): hand fixes kept apart from the data, keyed by the building's stable ID
// (Overture GERS id, or seed + lot for invented towns) with a position fallback. Every rebuild
// re-applies them; a fix that no longer finds its building is reported, never silently dropped.
import { centroid, pointInPoly, type P2 } from './geo.ts';
import { ROOF_TYPES, BUILDING_USES, type Building, type TownPlan, type RoofType, type BuildingUse } from './plan.ts';
import { clampBuilding } from './rules.ts';
import { styleFor } from './styles.ts';

export interface FixSet {
  height?: number; floors?: number; roof?: RoofType; roofHeight?: number; use?: BuildingUse;
  wall?: string; trim?: string; roofColor?: string; glass?: string; storefront?: boolean;
}
export interface Fix {
  id?: string;                   // the building's stable id ("ov:…", "inv:…")
  at?: P2;                       // where it is (town metres): the fallback when the id is gone
  set?: FixSet;
  hide?: boolean;                // e.g. a tank, a skybridge the data got wrong
  model?: string;                // swap in this studio object (a landmark made by hand)
  modelRotation?: number;
  note?: string;
}
export interface FixReport {
  applied: Array<{ index: number; building: string; by: 'id' | 'position'; note?: string }>;
  orphaned: Array<{ index: number; id?: string; at?: P2; note?: string; reason: string }>;
}

export const FALLBACK_RADIUS = 10;

export function validateFix(f: Fix): void {
  if (!f.id && !f.at) throw new Error('a fix needs the building --id or a position --at [x, z]');
  if (!f.set && !f.hide && !f.model) throw new Error('a fix needs something to do: --set {...}, --hide true or --model <studio object>');
  const s = f.set ?? {};
  if (s.roof && !ROOF_TYPES.includes(s.roof)) throw new Error(`roof must be one of ${ROOF_TYPES.join(', ')}`);
  if (s.use && !BUILDING_USES.includes(s.use)) throw new Error(`use must be one of ${BUILDING_USES.join(', ')}`);
  for (const k of ['wall', 'trim', 'roofColor', 'glass'] as const) if (s[k] && !/^#[0-9a-f]{6}$/i.test(s[k]!)) throw new Error(`${k} must be a colour like #a85b45`);
  for (const k of ['height', 'floors', 'roofHeight'] as const) if (s[k] !== undefined && !(Number(s[k]) > 0)) throw new Error(`${k} must be a positive number`);
}

/** Find a fix's building: by id first, then the building under (or nearest within 10 m of) its position. */
export function findTarget(plan: TownPlan, f: Fix): { b: Building; by: 'id' | 'position' } | null {
  if (f.id) { const b = plan.buildings.find((x) => x.id === f.id); if (b) return { b, by: 'id' }; }
  if (f.at) {
    const under = plan.buildings.find((x) => pointInPoly(f.at!, x.footprint));
    if (under) return { b: under, by: 'position' };
    let best: Building | null = null, bd = FALLBACK_RADIUS;
    for (const x of plan.buildings) { const c = centroid(x.footprint); const d = Math.hypot(c[0] - f.at[0], c[1] - f.at[1]); if (d < bd) { bd = d; best = x; } }
    if (best) return { b: best, by: 'position' };
  }
  return null;
}

/** Apply every fix in order (later fixes win). Mutates the plan; returns what landed and what was orphaned. */
export function applyFixes(plan: TownPlan, fixes: Fix[]): FixReport {
  const rep: FixReport = { applied: [], orphaned: [] };
  const style = styleFor(plan.style);
  fixes.forEach((f, index) => {
    const t = findTarget(plan, f);
    if (!t) { rep.orphaned.push({ index, id: f.id, at: f.at, note: f.note, reason: f.id ? `no building ${f.id}${f.at ? ` and nothing within ${FALLBACK_RADIUS} m of [${f.at.map((v) => v.toFixed(1)).join(', ')}]` : ''}` : `nothing within ${FALLBACK_RADIUS} m of [${f.at!.map((v) => v.toFixed(1)).join(', ')}]` }); return; }
    const b = t.b;
    const s = f.set ?? {};
    if (s.height !== undefined) { b.height = s.height; if (s.floors === undefined) b.floors = 0; }
    if (s.floors !== undefined) { b.floors = s.floors; if (s.height === undefined) b.height = 0; }
    if (s.use) b.use = s.use;
    if (s.roof) { b.roof = s.roof; delete b.roofHeight; }
    if (s.roofHeight !== undefined) b.roofHeight = s.roofHeight;
    if (s.height !== undefined || s.floors !== undefined || s.roof || s.roofHeight !== undefined) {
      const keepRoof = b.roof;
      clampBuilding(b, style, b.notes ??= []);
      if (s.roof && b.roof !== keepRoof) b.notes.push(`fix #${index}: ${keepRoof} roof needs a 4-corner outline`);
    }
    if (s.wall || s.trim || s.roofColor || s.glass) b.palette = { ...(b.palette ?? { wall: '#bdb8ae', trim: '#e5e0d5', roof: '#5a5853', glass: '#2f3b45' }), ...(s.wall ? { wall: s.wall } : {}), ...(s.trim ? { trim: s.trim } : {}), ...(s.roofColor ? { roof: s.roofColor } : {}), ...(s.glass ? { glass: s.glass } : {}) };
    if (s.storefront !== undefined) b.storefront = s.storefront;
    if (f.hide) b.hidden = true;
    if (f.model) { b.model = f.model; b.modelRotation = f.modelRotation; }
    (b.fixes ??= []).push(index);
    rep.applied.push({ index, building: b.id, by: t.by, ...(f.note ? { note: f.note } : {}) });
  });
  return rep;
}
