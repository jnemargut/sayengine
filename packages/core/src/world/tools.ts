// The world module's tool group (Decisions 26–28): towns, real or invented, as one more set of typed
// studio tools. The town's recipe and its fix layer live in the scene doc (doc.world), so every change is
// one reviewable step with undo and proposals. Fetching data is `studio world-fetch` (CLI side, network).
import { z } from 'zod';
import type { ToolDef } from '../tools.ts';
import type { CheckResult } from '../checks.ts';
import { materialForPart } from '../materials.ts';
import { area, centroid, convexOverlap, distToPolyline, pointInPoly, type P2 } from './geo.ts';
import { BUILDING_USES, ROOF_TYPES } from './plan.ts';
import { STYLES } from './styles.ts';
import { validateFix, findTarget, type Fix } from './fixes.ts';
import { fixFromWords } from './words.ts';
import { partExists, partWords } from '../collab/timelines.ts';
import { buildingLabel } from './view.ts';
import { buildTown, creditsText, landmarkObjects, listAreas, type TownSpec, type WorldState } from './town.ts';
import { townNodes, nodeTriangles, type ModelMesh, type Soup } from './mesh.ts';

// notes on a building ("town:Pocket Raleigh/ov:2a17…") go stale when the building leaves the data
partExists.town = (doc: any, town: string, building: string) => {
  const spec = doc.world?.towns?.[town];
  if (!spec) return false;
  try { return buildTown(spec, doc.world).plan.buildings.some((b) => b.id === building); } catch { return false; }
};

partWords.town = (doc: any, town: string, building: string) => {
  const spec = doc.world?.towns?.[town];
  if (!spec) return null;
  try { const b = buildTown(spec, doc.world).plan.buildings.find((x) => x.id === building); return b ? buildingLabel(b) : null; } catch { return null; }
};

const P2Z = z.tuple([z.number(), z.number()]);
const TownRef = z.string().optional().describe('town name (defaults to the only town)');

function world(ctx: { doc: any }): WorldState | undefined { return ctx.doc.world; }
function townOf(ctx: { doc: any }, name?: string): TownSpec {
  const towns = Object.values(world(ctx)?.towns ?? {});
  if (!towns.length) throw new Error('no towns yet — start with `studio world-town`');
  if (!name) { if (towns.length > 1) throw new Error(`which town? --town ${towns.map((t) => `"${t.name}"`).join(' or ')}`); return towns[0]; }
  const t = towns.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t) throw new Error(`no town "${name}" (have: ${towns.map((x) => x.name).join(', ')})`);
  return t;
}

/** A studio object as a landmark mesh for a town: triangle soups in its own space, origin on its floor centre. */
export function landmarkMesh(studio: any, obj: any): ModelMesh | null {
  const res = studio.evaluate(obj);
  if (!res.ok || !res.bbox) return null;
  const soups = new Map<string, Soup>();
  for (const p of res.parts) {
    const m = materialForPart(obj, p.name.startsWith('~') ? obj.output ?? '' : p.name);
    const key = `${m.color}|${m.roughness ?? 0.8}|${m.metalness ?? 0}`;
    let s = soups.get(key);
    if (!s) { s = { mat: { name: `landmark ${m.name}`, color: m.color, roughness: m.roughness ?? 0.8, metalness: m.metalness ?? 0 }, positions: [], normals: [] }; soups.set(key, s); }
    for (const [start, count] of p.ranges) for (let t = start; t < start + count; t++) {
      const v = [0, 1, 2].map((k) => res.indices[t * 3 + k]);
      const P = v.map((i) => [res.positions[i * 3] - obj.position[0], res.positions[i * 3 + 1] - res.bbox.min[1], res.positions[i * 3 + 2] - obj.position[2]]);
      const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]], e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...n) || 1;
      for (const q of P) { s.positions.push(...q); s.normals.push(n[0] / l, n[1] / l, n[2] / l); }
    }
  }
  const b = res.bbox;
  return { soups: [...soups.values()], size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] };
}

export function landmarkMeshes(studio: any, doc: any): Record<string, ModelMesh> {
  const out: Record<string, ModelMesh> = {};
  for (const id of landmarkObjects(doc.world)) {
    const obj = doc.objects[id] ?? Object.values(doc.objects).find((o: any) => o.name.toLowerCase() === id.toLowerCase());
    if (!obj) continue;
    const m = landmarkMesh(studio, obj);
    if (m) { out[id] = m; out[(obj as any).id] = m; }
  }
  return out;
}

/** World checks (studio check): fixes that lost their building, overlaps, budgets. */
export function worldChecks(spec: TownSpec, doc?: any): CheckResult[] {
  let t;
  try { t = buildTown(spec, doc?.world); } catch (e: any) { return [{ id: 'world-build', label: 'Town builds', pass: false, detail: e.message }]; }
  const out: CheckResult[] = [];
  const orphans = t.fixes.orphaned;
  out.push({ id: 'world-fixes', label: 'Every fix finds its building', pass: !orphans.length, detail: orphans.length ? orphans.map((o) => `fix #${o.index}${o.note ? ` (${o.note})` : ''}: ${o.reason}`).join('; ') : `${t.fixes.applied.length} fix${t.fixes.applied.length === 1 ? '' : 'es'} applied${t.fixes.applied.some((a) => a.by === 'position') ? ` (${t.fixes.applied.filter((a) => a.by === 'position').length} by position: the id changed, re-key with world-fix --id)` : ''}` });
  const missingModels = (spec.fixes ?? []).map((f, i) => [f, i] as const).filter(([f]) => f.model && doc && !doc.objects[f.model] && !Object.values(doc.objects).some((o: any) => o.name.toLowerCase() === f.model!.toLowerCase()));
  out.push({ id: 'world-landmarks', label: 'Landmark models exist in the studio', pass: !missingModels.length, detail: missingModels.length ? missingModels.map(([f, i]) => `fix #${i}: no studio object "${f.model}"`).join('; ') : `${(spec.fixes ?? []).filter((f) => f.model).length} landmark(s)` });
  const bs = t.plan.buildings.filter((b) => !b.hidden);
  const overlaps: string[] = [];
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    if (a.footprint.length !== 4 || b.footprint.length !== 4) continue;
    if (convexOverlap(a.footprint, b.footprint, 0.8)) overlaps.push(`${a.id} / ${b.id}`);
  }
  out.push({ id: 'world-overlap', label: 'Buildings don\'t overlap', pass: overlaps.length <= Math.ceil(bs.length * 0.02), detail: overlaps.length ? `${overlaps.length} overlapping pair(s)${overlaps.length <= 4 ? ': ' + overlaps.join(', ') : ''}` : 'none' });
  const onRoad = bs.filter((b) => t.plan.streets.some((s) => s.kind !== 'footway' && s.kind !== 'service' && s.kind !== 'pedestrian' && distToPolyline(centroid(b.footprint), s.points) < s.width / 2)).map((b) => b.id);
  out.push({ id: 'world-roads', label: 'No building stands in a street', pass: !onRoad.length, detail: onRoad.length ? onRoad.slice(0, 6).join(', ') : 'clear' });
  const tris = nodeTriangles(townNodes(t.plan, { detail: 'full' }));
  out.push({ id: 'world-budget', label: 'Town triangles ≤ 400k', pass: tris <= 400_000, detail: `${(tris / 1000).toFixed(0)}k triangles, ${bs.length} buildings, ${t.plan.trees.length} trees` });
  if (t.plan.credits.length) out.push({ id: 'world-credits', label: 'Open-data credits', pass: true, detail: t.plan.credits.map((c) => `${c.name} (${c.licence})`).join('; ') });
  return out;
}

const FixSetZ = z.object({
  height: z.number().positive().optional(), floors: z.number().int().positive().optional(), roof: z.enum(ROOF_TYPES as [string, ...string[]]).optional(),
  roofHeight: z.number().positive().optional(), use: z.enum(BUILDING_USES as [string, ...string[]]).optional(),
  wall: z.string().optional(), trim: z.string().optional(), roofColor: z.string().optional(), glass: z.string().optional(), storefront: z.boolean().optional(),
}).describe('what to change: {height, floors, roof, roofHeight, use, wall, trim, roofColor, glass, storefront}');

function summary(t: ReturnType<typeof buildTown>) {
  const p = t.plan;
  return {
    town: p.name, source: p.source, style: p.style, ...(p.seed !== undefined ? { seed: p.seed } : {}),
    size: `${p.size.w.toFixed(0)} × ${p.size.d.toFixed(0)} m`,
    buildings: p.buildings.filter((b) => !b.hidden).length, streets: p.streets.length, areas: p.areas.length, trees: p.trees.length,
    tallest: p.buildings.slice().sort((a, b) => b.height - a.height).slice(0, 3).map((b) => ({ id: b.id, height: +b.height.toFixed(1), floors: b.floors })),
    rules: { squared: p.stats.squared, clamped: p.stats.clamped, droppedTiny: p.stats.droppedTiny },
    fixes: { applied: t.fixes.applied.length, orphaned: t.fixes.orphaned },
    credits: p.credits.map((c) => `${c.name} (${c.licence})`),
  };
}

export const WORLD_TOOLS: ToolDef[] = [
  {
    name: 'world-town', mode: 'create', mutates: true,
    description: `Make a town (Decision 27: one pipeline, real or invented). --source real builds a fetched area (studio world-fetch first) from Overture buildings, USGS ground and OSM streets/water/parks; --source invented builds from --description ("mill town on a river, 1920s, 3 blocks") or --sketch {streets:[{name,kind,points:[[x,z]…]}], river?:{points,width}, green?:[[x,z]…]} with --seed (building ids are seed + lot, so a regenerate keeps fixes); --source remix keeps a real area's streets and ground and invents the buildings. Every source goes through the same rules (square up, roofs, clamping, graded roads, --style ${Object.keys(STYLES).join('|')}) and the town's fix layer. Re-running with the same --name replaces the recipe and keeps the fixes. --offset [x,y,z] places it in the scene. Game export (studio game import) carries every town.`,
    input: z.object({
      name: z.string(), source: z.enum(['real', 'invented', 'remix']),
      area: z.string().optional().describe('cached area (real / remix): the --name given to studio world-fetch'),
      style: z.string().optional().describe(`style rules: ${Object.keys(STYLES).join(', ')}`),
      seed: z.number().int().optional(), description: z.string().optional(),
      sketch: z.object({ streets: z.array(z.object({ name: z.string().optional(), kind: z.enum(['primary', 'secondary', 'tertiary', 'residential', 'service', 'pedestrian', 'footway']).optional(), points: z.array(P2Z).min(2) })).min(1), river: z.object({ points: z.array(P2Z).min(2), width: z.number().positive() }).optional(), green: z.array(P2Z).min(3).optional(), size: z.object({ w: z.number(), d: z.number() }).optional() }).optional(),
      blocks: z.number().int().min(1).max(6).optional(),
      offset: z.tuple([z.number(), z.number(), z.number()]).optional(),
      seam: z.string().optional().describe('a neighbouring town (by name) whose ground this town meets along the shared edge: the ground is feathered over 60 m so two DEM grids join without a step'),
    }),
    example: 'studio world-town --name "Pocket Raleigh" --source real --area raleigh-fayetteville --style raleigh-downtown',
    run(ctx, a) {
      if ((a.source === 'real' || a.source === 'remix') && !a.area) {
        const have = listAreas();
        throw new Error(`--source ${a.source} needs --area (fetched: ${have.map((x) => x.area).join(', ') || 'none — studio world-fetch --name <area> --bbox west,south,east,north'})`);
      }
      if (a.style && !STYLES[a.style]) throw new Error(`unknown style "${a.style}" (have: ${Object.keys(STYLES).join(', ')})`);
      const prev: TownSpec | undefined = world(ctx)?.towns?.[a.name];
      const spec: TownSpec = {
        name: a.name, source: a.source, style: a.style ?? (a.source === 'real' ? 'raleigh-downtown' : 'river-town-1920s'),
        ...(a.area ? { area: a.area } : {}), ...(a.source !== 'real' ? { seed: a.seed ?? prev?.seed ?? 1 } : {}),
        ...(a.description ? { description: a.description } : {}), ...(a.sketch ? { sketch: a.sketch } : {}), ...(a.blocks ? { blocks: a.blocks } : {}),
        ...(a.offset ?? prev?.offset ? { offset: a.offset ?? prev!.offset } : {}),
        ...(a.seam ?? prev?.seam ? { seam: a.seam ? { town: a.seam } : prev!.seam } : {}),
        fixes: prev?.fixes ?? [],
      };
      const t = buildTown(spec, world(ctx));
      ctx.set(['world', 'towns', a.name], spec);
      const s = summary(t);
      ctx.summary(`${prev ? 'Rebuilt' : 'Built'} ${a.name}: ${s.buildings} buildings, ${s.streets} streets, ${s.trees} trees (${a.source}, ${spec.style})${spec.fixes.length ? `; ${t.fixes.applied.length}/${spec.fixes.length} fixes landed` : ''}`);
      return s;
    },
  },
  {
    name: 'world-fix', mode: 'modify', mutates: true,
    description: 'Fix a building in a town (the fix layer, Decision 27). Keyed by the building\'s stable --id (Overture GERS id "ov:…" or "inv:<seed>:<lot>") with --at [x,z] as the position fallback; every rebuild re-applies it, and `studio check` flags a fix that lost its building. --set {height, floors, roof (flat|gable|hip|shed|pyramid|dome), roofHeight, use, wall, trim, roofColor, glass, storefront}; --hide true removes it (a skybridge, a tank); --model <studio object> swaps in a landmark you modelled (it exports inside the town, standing on the footprint; --model-rotation degrees). --note says why. Find ids with world-info --near [x,z].',
    input: z.object({
      town: TownRef, id: z.string().optional(), at: P2Z.optional(), set: FixSetZ.optional(), hide: z.boolean().optional(),
      model: z.string().optional(), modelRotation: z.number().optional(), note: z.string().optional(),
      words: z.string().optional().describe('a word note about the building, read into the fix: "flat roof", "two storeys taller", "brick", "a shop", "no shopfronts", "hide it" (it also becomes the step\'s note)'),
      place: z.boolean().optional().describe('place --model at --at as a prop that replaces no building (light masts, statues)'), base: z.number().optional().describe('a placed prop\'s floor height (default: the ground)'),
    }),
    example: 'studio world-fix --town "Pocket Raleigh" --id ov:2a17… --set \'{"roof":"hip","height":24}\' --note "the old courthouse has a hipped roof"',
    run(ctx, a) {
      const spec = townOf(ctx, a.town);
      const t = buildTown(spec);
      const f: Fix = { ...(a.id ? { id: a.id } : {}), ...(a.at ? { at: a.at } : {}), ...(a.set ? { set: a.set } : {}), ...(a.hide ? { hide: true } : {}), ...(a.model ? { model: a.model } : {}), ...(a.modelRotation !== undefined ? { modelRotation: a.modelRotation } : {}), ...(a.note ? { note: a.note } : {}) };
      let heard: ReturnType<typeof fixFromWords> | null = null;
      if (a.words) {
        const tw = findTarget(t.plan, f);
        if (!tw) throw new Error(`no building ${a.id ? `"${a.id}"` : ''}${a.at ? ` at [${a.at.join(', ')}]` : ''} in ${spec.name} to read "${a.words}" against`);
        heard = fixFromWords(a.words, tw.b);
        f.set = { ...heard.set, ...(f.set ?? {}) };
        if (!Object.keys(f.set).length) delete f.set;
        if (heard.hide) f.hide = true;
        if (!f.note) f.note = a.words;
      }
      if (a.place) { f.place = true; if (a.base !== undefined) f.base = a.base; }
      validateFix(f);
      if (f.place) {
        const o = ctx.doc.objects[a.model] ?? Object.values(ctx.doc.objects).find((x: any) => x.name.toLowerCase() === String(a.model).toLowerCase());
        if (!o) throw new Error(`no studio object "${a.model}" to place (make it first, or check the name)`);
        f.model = (o as any).id;
        ctx.set(['world', 'towns', spec.name, 'fixes'], [...spec.fixes, f]);
        ctx.summary(`${spec.name}: fix #${spec.fixes.length}: placed ${(o as any).name} at [${f.at!.join(', ')}]`);
        return { index: spec.fixes.length, fix: f };
      }
      const target = findTarget(t.plan, f);
      if (!target) throw new Error(`no building ${a.id ? `"${a.id}"` : ''}${a.at ? ` at [${a.at.join(', ')}]` : ''} in ${spec.name} — world-info --near [x,z] lists ids`);
      // keep both keys, so the fix survives an id change (position) and a small move (id)
      if (!f.id) f.id = target.b.id;
      if (!f.at) { const c = centroid(target.b.footprint); f.at = [+c[0].toFixed(2), +c[1].toFixed(2)]; }
      if (a.model) {
        const o = ctx.doc.objects[a.model] ?? Object.values(ctx.doc.objects).find((x: any) => x.name.toLowerCase() === a.model.toLowerCase());
        if (!o) throw new Error(`no studio object "${a.model}" to use as a landmark (make it first, or check the name)`);
        f.model = (o as any).id;
      }
      ctx.set(['world', 'towns', spec.name, 'fixes'], [...spec.fixes, f]);
      ctx.summary(`${spec.name}: fix #${spec.fixes.length} on ${buildingLabel(target.b)}${target.b.name ? ` (${target.b.name})` : ''}: ${[f.set ? Object.entries(f.set).map(([k, v]) => `${k} ${v}`).join(', ') : '', f.hide ? 'hidden' : '', a.model ? `landmark ${f.model}` : ''].filter(Boolean).join('; ')}`);
      return { index: spec.fixes.length, fix: f, building: { id: target.b.id, by: target.by }, ...(heard ? { heard: heard.understood, ...(heard.unknown.length ? { notUnderstood: heard.unknown } : {}) } : {}) };
    },
  },
  {
    name: 'world-unfix', mode: 'modify', mutates: true,
    description: 'Remove a fix from a town\'s fix layer by its index (world-info lists them).',
    input: z.object({ town: TownRef, index: z.number().int().min(0) }),
    example: 'studio world-unfix --town "Pocket Raleigh" --index 0',
    run(ctx, a) {
      const spec = townOf(ctx, a.town);
      if (!spec.fixes[a.index]) throw new Error(`${spec.name} has no fix #${a.index} (it has ${spec.fixes.length})`);
      ctx.set(['world', 'towns', spec.name, 'fixes'], spec.fixes.filter((_, i) => i !== a.index));
      ctx.summary(`${spec.name}: removed fix #${a.index}`);
      return { removed: spec.fixes[a.index] };
    },
  },
  {
    name: 'world-remove', mode: 'modify', mutates: true,
    description: 'Remove a town (its recipe and fix layer) from the scene.',
    input: z.object({ town: z.string() }),
    run(ctx, a) {
      const spec = townOf(ctx, a.town);
      ctx.set(['world', 'towns', spec.name], undefined);
      ctx.summary(`Removed town ${spec.name}`);
      return { removed: spec.name };
    },
  },
  {
    name: 'world-info', mode: 'inspect', mutates: false,
    description: 'A town\'s summary: size, buildings, streets, what the rules did, the fix layer (applied / orphaned) and credits. --near [x,z] (with --radius m, default 30) lists the buildings there with their ids, heights, roofs, uses and data names — use it to find the id for world-fix. --credits true returns the licence text (ODbL) for the about screen.',
    input: z.object({ town: TownRef, near: P2Z.optional(), radius: z.number().positive().optional(), credits: z.boolean().optional() }),
    example: 'studio world-info --town "Pocket Raleigh" --near [0,40]',
    run(ctx, a) {
      if (!Object.keys(world(ctx)?.towns ?? {}).length) return { towns: [], areas: listAreas(), hint: 'studio world-fetch, then studio world-town' };
      const spec = townOf(ctx, a.town);
      const t = buildTown(spec);
      const out: any = { ...summary(t), fixLayer: spec.fixes.map((f, i) => ({ index: i, ...f, landed: t.fixes.applied.find((x) => x.index === i)?.building ?? null })) };
      if (a.near) {
        const r = a.radius ?? 30;
        out.near = t.plan.buildings.map((b) => ({ b, d: pointInPoly(a.near as P2, b.footprint) ? 0 : Math.hypot(...(centroid(b.footprint).map((v, k) => v - a.near[k]) as [number, number])) })).filter((x) => x.d <= r).sort((x, y) => x.d - y.d).slice(0, 12)
          .map(({ b, d }) => ({ id: b.id, ...(b.name ? { name: b.name } : {}), at: centroid(b.footprint).map((v) => +v.toFixed(1)), distance: +d.toFixed(1), height: +b.height.toFixed(1), floors: b.floors, roof: b.roof, use: b.use, area: +area(b.footprint).toFixed(0), ...(b.hidden ? { hidden: true } : {}), ...(b.model ? { model: b.model } : {}), ...(b.notes?.length ? { notes: b.notes } : {}) }));
      }
      if (a.credits) out.creditsText = creditsText(world(ctx));
      ctx.summary(`${spec.name}: ${out.buildings} buildings, ${spec.fixes.length} fixes (${t.fixes.orphaned.length} orphaned)`);
      return out;
    },
  },
  {
    name: 'world-share', mode: 'output', mutates: false,
    description: 'Write a town\'s shareable data (ODbL asks that derived data is shared): town-plan.json (the built plan), fixes.json (the fix layer) and CREDITS.txt, into --out (default world/<town>/).',
    input: z.object({ town: TownRef, out: z.string().optional() }),
    run(ctx, a) {
      const fs = (process as any).getBuiltinModule('node:fs') as typeof import('node:fs');
      const path = (process as any).getBuiltinModule('node:path') as typeof import('node:path');
      const spec = townOf(ctx, a.town);
      const t = buildTown(spec);
      const dir = path.resolve(process.env.STUDIO_DIR ?? process.cwd(), a.out ?? path.join('world', spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'town-plan.json'), JSON.stringify({ licence: t.plan.credits.some((c) => c.shareAlike) ? 'ODbL-1.0' : 'invented (no outside data)', ...t.plan }, null, 1));
      fs.writeFileSync(path.join(dir, 'fixes.json'), JSON.stringify({ town: spec.name, fixes: spec.fixes }, null, 2) + '\n');
      fs.writeFileSync(path.join(dir, 'CREDITS.txt'), creditsText({ towns: { [spec.name]: spec } }) + '\n');
      ctx.summary(`${spec.name}: shared data written to ${dir}`);
      return { dir, files: ['town-plan.json', 'fixes.json', 'CREDITS.txt'] };
    },
  },
];
