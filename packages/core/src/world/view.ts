// A town in the live view (Phase 10 step 3): one chunk of a town, not all of it (an 8 GB Mac has to
// hold it next to everything else), with one mesh per building so a click finds the building's stable
// id, and the data the inspector shows (height, floors, roof, use, where it came from). Meshes are
// indexed, coloured by vertex, shared by shading class, base64 so they ride over HTTP as JSON.
import { centroid, type P2 } from './geo.ts';
import { buildTown, indexSoup, nodePrims, type TownSpec, type WorldState } from './town.ts';
import { townNodes, type ModelMesh, type Soup } from './mesh.ts';
import { stamp } from '../collab/address.ts';
import type { Building, TownPlan } from './plan.ts';

export interface TownChunk { center?: P2; radius?: number; maxBuildings?: number }
export const CHUNK_DEFAULT = { radius: 140, maxBuildings: 90 };

export interface ViewBuilding {
  id: string; label: string; name?: string; use: string; height: number; floors: number; roof: string; roofHeight?: number;
  storefront?: boolean; wall?: string; model?: string; hidden?: boolean; fixes: number[]; at: P2; source: string; notes?: string[];
}
export interface ViewPrim { mat: { name: string; roughness: number; metalness: number }; positions: string; normals: string; colors: string; indices: string; triangles: number }
export interface ViewNode { name: string; kind: string; worldId?: string; at: [number, number, number]; prims: ViewPrim[] }
export interface TownView {
  town: string; key: string; offset: [number, number, number]; source: string; style: string;
  chunk: { center: P2; radius: number; buildings: number; ofBuildings: number; clipped: boolean };
  buildings: ViewBuilding[]; nodes: ViewNode[]; triangles: number; credits: string[];
}

const b64 = (a: Float32Array | Uint32Array) => {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const B = (globalThis as any).Buffer;
  if (B) return B.from(u8).toString('base64');
  let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
};

/** Where a building came from, in words. */
export function buildingSource(plan: TownPlan, b: Building): string {
  if (b.sourceId || b.id.startsWith('ov:')) return `Overture Maps buildings (GERS ${b.sourceId ?? b.id.slice(3)}), ODbL${b.name ? `; named "${b.name}" in the data` : ''}`;
  if (b.lot || b.id.startsWith('inv:')) return `invented (${plan.source === 'remix' ? 'remix of a real street grid, ' : ''}seed ${plan.seed ?? '?'}, lot ${b.lot ?? b.id.split(':').pop()})`;
  return plan.source;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
export function buildingLabel(b: Pick<Building, 'id' | 'use' | 'name'>): string {
  return `${cap(b.use)} ${b.id.replace(/^[a-z]+:/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`;
}

/** Keep the triangles of a soup whose middle is inside the chunk. */
function clipSoup(s: Soup, at: [number, number, number], c: P2, r: number): Soup | null {
  const pos: number[] = [], nor: number[] = [], col: number[] | undefined = s.colors ? [] : undefined;
  for (let i = 0; i < s.positions.length; i += 9) {
    const x = (s.positions[i] + s.positions[i + 3] + s.positions[i + 6]) / 3 + at[0], z = (s.positions[i + 2] + s.positions[i + 5] + s.positions[i + 8]) / 3 + at[2];
    if (Math.abs(x - c[0]) > r || Math.abs(z - c[1]) > r) continue;
    for (let k = 0; k < 9; k++) { pos.push(s.positions[i + k]); nor.push(s.normals[i + k]); col?.push(s.colors![i + k]); }
  }
  return pos.length ? { mat: s.mat, positions: pos, normals: nor, ...(col ? { colors: col } : {}) } : null;
}

/** One chunk of a town for the view: the buildings nearest the chunk's centre (capped) and the ground,
 *  streets, trees and lights inside a square of ±radius around it. */
export function townView(spec: TownSpec, world: WorldState | undefined, models: Record<string, ModelMesh> = {}, chunk: TownChunk = {}): TownView {
  const t = buildTown(spec, world);
  const plan = t.plan;
  const live = plan.buildings.filter((b) => !b.hidden);
  const mid: P2 = live.length ? [live.reduce((s, b) => s + centroid(b.footprint)[0], 0) / live.length, live.reduce((s, b) => s + centroid(b.footprint)[1], 0) / live.length] : [0, 0];
  const center = chunk.center ?? mid, radius = chunk.radius ?? CHUNK_DEFAULT.radius, cap0 = chunk.maxBuildings ?? CHUNK_DEFAULT.maxBuildings;
  const dist = (b: Building) => { const c = centroid(b.footprint); return Math.max(Math.abs(c[0] - center[0]), Math.abs(c[1] - center[1])); };
  const inChunk = plan.buildings.filter((b) => dist(b) <= radius).sort((a, b) => dist(a) - dist(b)).slice(0, cap0);
  const keep = new Set(inChunk.map((b) => b.id));
  // build only the chunk's buildings (meshing every building of a big town just to throw most away is the cost to avoid)
  const sub: TownPlan = { ...plan, buildings: plan.buildings.filter((b) => keep.has(b.id)) };
  const nodes = townNodes(sub, { models, detail: 'full' });
  const out: ViewNode[] = [];
  let triangles = 0;
  for (const n of nodes) {
    const isB = n.semanticType === 'building' || (n.semanticType === 'landmark' && !!n.extras.worldId);
    const soups = isB ? n.soups : n.soups.map((s) => clipSoup(s, n.at, center, radius)).filter(Boolean) as Soup[];
    if (!soups.length) continue;
    const prims = nodePrims(soups).filter((p) => p.positions.length).map((p) => {
      const ix = indexSoup(p);
      triangles += ix.indices.length / 3;
      return { mat: { name: p.mat.name, roughness: p.mat.roughness, metalness: p.mat.metalness }, positions: b64(ix.positions), normals: b64(ix.normals), colors: b64(ix.colors), indices: b64(ix.indices), triangles: ix.indices.length / 3 };
    });
    out.push({ name: n.name, kind: n.semanticType, ...(isB ? { worldId: String(n.extras.worldId) } : {}), at: n.at, prims });
  }
  const buildings: ViewBuilding[] = plan.buildings.filter((b) => keep.has(b.id) || b.hidden && dist(b) <= radius).map((b) => ({
    id: b.id, label: buildingLabel(b), ...(b.name ? { name: b.name } : {}), use: b.use, height: +b.height.toFixed(1), floors: b.floors, roof: b.roof,
    ...(b.roofHeight ? { roofHeight: +b.roofHeight.toFixed(1) } : {}), ...(b.storefront !== undefined ? { storefront: b.storefront } : {}),
    ...(b.palette?.wall ? { wall: b.palette.wall } : {}), ...(b.model ? { model: b.model } : {}), ...(b.hidden ? { hidden: true } : {}),
    fixes: b.fixes ?? [], at: centroid(b.footprint).map((v) => +v.toFixed(1)) as P2, source: buildingSource(plan, b), ...(b.notes?.length ? { notes: b.notes } : {}),
  }));
  return {
    town: spec.name, key: stamp({ key: t.key, models: Object.keys(models).sort(), center, radius, cap0 }), offset: (spec.offset ?? [0, 0, 0]) as [number, number, number],
    source: plan.source, style: plan.style,
    chunk: { center, radius, buildings: inChunk.length, ofBuildings: live.length, clipped: inChunk.length < live.length },
    buildings, nodes: out, triangles, credits: plan.credits.map((c) => `${c.name} (${c.licence})`),
  };
}

/** The light summary the live view gets in every state message (meshes come from /api/town). */
export function townsForState(world: WorldState | undefined): Array<{ name: string; stamp: string; source: string; fixes: number; landmarks: string[] }> {
  return Object.values(world?.towns ?? {}).map((s) => ({ name: s.name, stamp: stamp(s), source: s.source, fixes: s.fixes?.length ?? 0, landmarks: [...new Set((s.fixes ?? []).map((f) => f.model).filter(Boolean) as string[])] }));
}
