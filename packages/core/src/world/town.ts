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

interface Prim { mat: { name: string; roughness: number; metalness: number }; positions: number[]; normals: number[]; colors: number[] }
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linCache = new Map<string, [number, number, number]>();
function linear(hex: string): [number, number, number] {
  let c = linCache.get(hex);
  if (!c) { const n = parseInt(hex.replace('#', ''), 16); c = [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)]; linCache.set(hex, c); }
  return c;
}
/** Shading class of a material: colours ride as vertex colours, so a whole chunk needs only a few materials. */
function shadeClass(m: { name: string; roughness: number; metalness?: number }) {
  if (m.name === 'water') return { name: 'water', roughness: 0.12, metalness: 0 };
  // classes a look can light up (Decision 29 material tweaks): lit windows, lamps, neon, signs
  // (flood: floodlit stone on landmarks; shop: shop windows lit from inside; led: white LED lamp heads;
  //  pool: light pools on the ground, additive, invisible unless a look lights them)
  const special = /(^|\s)(lit|lamp|led|neon|sign|flood|shop|pool)$/.exec(m.name);
  if (special) return { name: special[2], roughness: special[2] === 'lit' || special[2] === 'shop' ? 0.28 : special[2] === 'flood' ? 0.88 : 0.5, metalness: 0 };
  if ((m.metalness ?? 0) >= 0.3) return { name: 'metal', roughness: 0.55, metalness: 0.5 };
  if (m.roughness < 0.45) return { name: 'glossy', roughness: 0.28, metalness: 0.05 };
  return { name: 'matte', roughness: 0.9, metalness: 0 };
}
function addSoups(prims: Map<string, Prim>, soups: TownNode['soups'], shift: V3) {
  for (const s of soups) {
    const cls = shadeClass(s.mat);
    let p = prims.get(cls.name);
    if (!p) { p = { mat: cls, positions: [], normals: [], colors: [] }; prims.set(cls.name, p); }
    const col = linear(s.mat.color);
    for (let i = 0; i < s.positions.length; i += 3) {
      p.positions.push(s.positions[i] + shift[0], s.positions[i + 1] + shift[1], s.positions[i + 2] + shift[2]);
      p.normals.push(s.normals[i], s.normals[i + 1], s.normals[i + 2]);
      if (s.colors) p.colors.push(s.colors[i], s.colors[i + 1], s.colors[i + 2]);
      else p.colors.push(col[0], col[1], col[2]);
    }
  }
}

export interface ChunkNode { name: string; semanticType: string; at: V3; prims: Prim[]; extras: Record<string, unknown> }
/** Merge a town's building nodes into chunks (cells of `cell` metres): few draw calls, phone-friendly. */
export function chunkNodes(nodes: TownNode[], cell = 110): ChunkNode[] {
  const out: ChunkNode[] = [];
  const cells = new Map<string, { at: V3; prims: Map<string, Prim>; buildings: any[] }>();
  for (const n of nodes) {
    if (n.semanticType !== 'building') {
      const prims = new Map<string, Prim>();
      addSoups(prims, n.soups, [0, 0, 0]);
      out.push({ name: n.name, semanticType: n.semanticType, at: n.at, prims: [...prims.values()], extras: n.extras });
      continue;
    }
    const ix = Math.floor(n.at[0] / cell), iz = Math.floor(n.at[2] / cell);
    const key = `${ix},${iz}`;
    let c = cells.get(key);
    if (!c) { c = { at: [(ix + 0.5) * cell, 0, (iz + 0.5) * cell], prims: new Map(), buildings: [] }; cells.set(key, c); }
    addSoups(c.prims, n.soups, [n.at[0] - c.at[0], n.at[1] - c.at[1], n.at[2] - c.at[2]]);
    c.buildings.push({ name: n.name, at: n.at.map((v) => +v.toFixed(2)), ...n.extras });
  }
  for (const [key, c] of [...cells.entries()].sort()) out.push({ name: `Buildings ${key}`, semanticType: 'buildings', at: c.at, prims: [...c.prims.values()], extras: { buildings: c.buildings } });
  return out;
}

/** Add towns to a GLB under one group node each ("<name> (town)"). Colours are vertex colours; materials are shared by shading class. */
export function addTownsToGlb(B: GlbBuilder, towns: ReturnType<typeof worldNodes>): Array<{ town: string; nodes: number; triangles: number; materials: number; buildings: number; primitives: number }> {
  const matIdx = new Map<string, number>();
  const report = [];
  for (const t of towns) {
    const children: number[] = [];
    let primitives = 0;
    for (const n of chunkNodes(t.nodes)) {
      const prims = n.prims.filter((p) => p.positions.length).map((p) => {
        let mi = matIdx.get(p.mat.name);
        if (mi === undefined) {
          const pool = p.mat.name === 'pool';
          B.gltf.materials.push({ name: `world ${p.mat.name}`, pbrMetallicRoughness: { baseColorFactor: pool ? [0, 0, 0, 0] : [1, 1, 1, 1], metallicFactor: p.mat.metalness, roughnessFactor: p.mat.roughness }, ...(pool ? { alphaMode: 'BLEND', extensions: { KHR_materials_unlit: {} } } : {}), extras: { world: true, vertexColors: true, ...(pool ? { lightPool: true } : {}) } });
          if (pool) { B.gltf.extensionsUsed ??= []; if (!B.gltf.extensionsUsed.includes('KHR_materials_unlit')) B.gltf.extensionsUsed.push('KHR_materials_unlit'); }
          mi = B.gltf.materials.length - 1;
          matIdx.set(p.mat.name, mi);
        }
        return { attributes: { POSITION: B.accessor(new Float32Array(p.positions), 'VEC3', true), NORMAL: B.accessor(new Float32Array(p.normals), 'VEC3'), COLOR_0: B.accessor(new Float32Array(p.colors), 'VEC3') }, material: mi };
      });
      if (!prims.length) continue;
      primitives += prims.length;
      B.gltf.meshes.push({ name: n.name, primitives: prims });
      B.gltf.nodes.push({ name: `${t.town} ${n.name}`, mesh: B.gltf.meshes.length - 1, translation: n.at.map((v) => +v.toFixed(4)), extras: { studioName: `${t.town}: ${n.name}`, semanticType: n.semanticType, town: t.town, ...n.extras } });
      children.push(B.gltf.nodes.length - 1);
    }
    const credits = t.plan.credits.map((c) => `${c.name} (${c.licence})`);
    B.gltf.nodes.push({ name: `${t.town} (town)`, children, translation: t.offset, extras: { studioName: t.town, semanticType: 'town', source: t.plan.source, style: t.plan.style, size: t.plan.size, credits } });
    B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1);
    report.push({ town: t.town, nodes: children.length, triangles: nodeTriangles(t.nodes), materials: matIdx.size, buildings: t.nodes.filter((n) => n.semanticType === 'building' || n.semanticType === 'landmark').length, primitives });
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
