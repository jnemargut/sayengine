// The one town pipeline (Decision 27): source → raw plan → rules → fixes → meshes → GLB nodes.
// A town's recipe (its source, style, seed and fix layer) lives in the scene doc (doc.world), so it has
// history, undo and proposals like everything else; the built plan is a cache, rebuilt on demand.
import type { GlbBuilder } from '../glb.ts';
import { applyRules } from './rules.ts';
import { applyFixes, type Fix, type FixReport } from './fixes.ts';
import { inventedPlan, realPlan, remixPlan, type RawArea, type Sketch } from './sources.ts';
import { townNodes, nodeTriangles, type ModelMesh, type TownNode, type V3 } from './mesh.ts';
import type { TownPlan } from './plan.ts';

export interface TownSpec {
  name: string;
  source: 'real' | 'invented' | 'remix';
  area?: string;                 // real / remix: the cached area (studio world-fetch --name)
  style: string;
  seed?: number;
  description?: string;
  sketch?: Sketch;
  blocks?: number;
  offset?: [number, number, number];   // where the town sits in the scene (metres)
  fixes: Fix[];
}
export interface WorldState { towns: Record<string, TownSpec> }

const nodeFs = () => (process as any).getBuiltinModule('node:fs') as typeof import('node:fs');
const nodePath = () => (process as any).getBuiltinModule('node:path') as typeof import('node:path');

let cacheDirOverride: string | null = null;
/** Where fetched areas are cached: .studio/cache/world under the project (the daemon sets it). */
export function setWorldCacheDir(dir: string | null) { cacheDirOverride = dir; built.clear(); }
export function worldCacheDir(): string {
  return cacheDirOverride ?? process.env.STUDIO_WORLD_CACHE ?? nodePath().join(process.env.STUDIO_DIR ?? process.cwd(), '.studio', 'cache', 'world');
}

export function loadArea(area: string): RawArea {
  const fs = nodeFs(), path = nodePath();
  const dir = path.join(worldCacheDir(), area);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw new Error(`no cached area "${area}" in ${worldCacheDir()} — fetch it first: studio world-fetch --name ${area} --bbox west,south,east,north`);
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  return { meta: read('meta.json'), buildings: read('buildings.geojson'), osm: read('osm.json'), dem: read('dem.json') };
}
export function listAreas(): Array<{ area: string; bbox: any; fetchedAt: string }> {
  const fs = nodeFs(), path = nodePath(), dir = worldCacheDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'meta.json'))).map((d) => { const m = JSON.parse(fs.readFileSync(path.join(dir, d, 'meta.json'), 'utf8')); return { area: d, bbox: m.bbox, fetchedAt: m.fetchedAt }; });
}

export interface BuiltTown { spec: TownSpec; plan: TownPlan; fixes: FixReport; key: string }
const built = new Map<string, BuiltTown>();

/** Build (or reuse) a town's plan: source, rules, then the fix layer. */
export function buildTown(spec: TownSpec): BuiltTown {
  let stamp = '';
  if (spec.area) { try { stamp = String(nodeFs().statSync(nodePath().join(worldCacheDir(), spec.area, 'meta.json')).mtimeMs); } catch { /* reported by loadArea */ } }
  const key = JSON.stringify([spec.source, spec.area, spec.style, spec.seed, spec.description, spec.sketch, spec.blocks, spec.fixes, stamp]);
  const hit = built.get(spec.name);
  if (hit && hit.key === key) return { ...hit, spec };
  let plan: TownPlan;
  if (spec.source === 'real') plan = realPlan(spec.name, loadArea(spec.area!), spec.style);
  else if (spec.source === 'remix') plan = remixPlan(spec.name, loadArea(spec.area!), { style: spec.style, seed: spec.seed });
  else plan = inventedPlan(spec.name, { style: spec.style, seed: spec.seed, description: spec.description, sketch: spec.sketch, blocks: spec.blocks });
  applyRules(plan);
  const fixes = applyFixes(plan, spec.fixes ?? []);
  const b = { spec, plan, fixes, key };
  built.set(spec.name, b);
  return b;
}

/** Every town node, offset into the scene. */
export function worldNodes(world: WorldState | undefined, models: Record<string, ModelMesh> = {}, detail: 'full' | 'low' = 'full'): Array<{ town: string; offset: V3; nodes: TownNode[]; plan: TownPlan }> {
  if (!world) return [];
  return Object.values(world.towns).map((spec) => {
    const t = buildTown(spec);
    return { town: spec.name, offset: (spec.offset ?? [0, 0, 0]) as V3, nodes: townNodes(t.plan, { models, detail }), plan: t.plan };
  });
}

/** Studio objects a town has swapped in as landmarks (they export inside the town, not on their own). */
export function landmarkObjects(world: WorldState | undefined): string[] {
  if (!world) return [];
  return [...new Set(Object.values(world.towns).flatMap((t) => (t.fixes ?? []).map((f) => f.model).filter(Boolean) as string[]))];
}

/** Add towns to a GLB under one group node each ("<name> (town)"). Materials are shared by colour. */
export function addTownsToGlb(B: GlbBuilder, towns: ReturnType<typeof worldNodes>): Array<{ town: string; nodes: number; triangles: number; materials: number; buildings: number }> {
  const matIdx = new Map<string, number>();
  const report = [];
  for (const t of towns) {
    const children: number[] = [];
    for (const n of t.nodes) {
      const prims = n.soups.map((s) => {
        const key = `${s.mat.name}|${s.mat.color}|${s.mat.roughness}|${s.mat.metalness ?? 0}`;
        let mi = matIdx.get(key);
        if (mi === undefined) {
          const c = s.mat.color.replace('#', '');
          const lin = [0, 2, 4].map((k) => { const v = parseInt(c.slice(k, k + 2), 16) / 255; return +(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).toFixed(5); });
          B.gltf.materials.push({ name: `${s.mat.name} ${s.mat.color}`, pbrMetallicRoughness: { baseColorFactor: [...lin, 1], metallicFactor: s.mat.metalness ?? 0, roughnessFactor: s.mat.roughness }, extras: { world: true } });
          mi = B.gltf.materials.length - 1;
          matIdx.set(key, mi);
        }
        return { attributes: { POSITION: B.accessor(new Float32Array(s.positions), 'VEC3', true), NORMAL: B.accessor(new Float32Array(s.normals), 'VEC3') }, material: mi };
      });
      if (!prims.length) continue;
      B.gltf.meshes.push({ name: n.name, primitives: prims });
      B.gltf.nodes.push({ name: n.name, mesh: B.gltf.meshes.length - 1, translation: n.at.map((v) => +v.toFixed(4)), extras: { studioName: n.name, semanticType: n.semanticType, town: t.town, ...n.extras } });
      children.push(B.gltf.nodes.length - 1);
    }
    const credits = t.plan.credits.map((c) => `${c.name} (${c.licence})`);
    B.gltf.nodes.push({ name: `${t.town} (town)`, children, translation: t.offset, extras: { studioName: t.town, semanticType: 'town', source: t.plan.source, style: t.plan.style, size: t.plan.size, credits } });
    B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1);
    report.push({ town: t.town, nodes: children.length, triangles: nodeTriangles(t.nodes), materials: matIdx.size, buildings: t.nodes.filter((n) => n.semanticType === 'building' || n.semanticType === 'landmark').length });
  }
  if (towns.some((t) => t.plan.credits.length)) {
    B.gltf.asset.copyright = [...new Set(towns.flatMap((t) => t.plan.credits.map((c) => c.text)))].join(' ');
  }
  return report;
}

/** The credits text (ODbL needs it shown, and the derived data shared) for every town in the scene. */
export function creditsText(world: WorldState | undefined): string {
  if (!world) return '';
  const lines: string[] = [];
  for (const spec of Object.values(world.towns)) {
    const t = buildTown(spec);
    if (!t.plan.credits.length) { lines.push(`${spec.name}: invented (${spec.style}, seed ${spec.seed ?? 1}); no outside data.`); continue; }
    lines.push(`${spec.name}: ${t.plan.source === 'remix' ? 'real streets with invented buildings' : 'built from open data'}${t.plan.bbox ? ` for ${[t.plan.bbox.west, t.plan.bbox.south, t.plan.bbox.east, t.plan.bbox.north].join(', ')}` : ''}.`);
    for (const c of t.plan.credits) lines.push(`  - ${c.text} ${c.url}`);
    if (t.plan.credits.some((c) => c.shareAlike)) lines.push('  - The derived town data (town-plan.json, the fix layer) is shared under the ODbL 1.0: https://opendatacommons.org/licenses/odbl/1-0/');
  }
  return lines.join('\n');
}
