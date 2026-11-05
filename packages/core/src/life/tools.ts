// The life module's tool group (Decision 30): `life-bake` turns the scene's towns and cast into one
// life.json (walk mesh, lanes, smart places, the seeded cast and its day, cars and a bus) plus a props GLB,
// and drops both runtimes next to it; `life-day` runs that day sped up and headless and reports the checks.
import { z } from 'zod';
import type { ToolDef } from '../tools.ts';
import { buildTown, type WorldState } from '../world/town.ts';
import { bakeLife, type CastModel, type LifeOptions, type LifeBake } from './bake.ts';
import { runDay, type PlayerScript } from './day.ts';
import { propsGlb } from './props.ts';
import { alongLine } from './nav.ts';

const nodeFs = () => (process as any).getBuiltinModule('node:fs') as typeof import('node:fs');
const nodePath = () => (process as any).getBuiltinModule('node:path') as typeof import('node:path');
const nodeUrl = () => (process as any).getBuiltinModule('node:url') as typeof import('node:url');

/** The cast the scene offers: characters (a four-legged one is a dog) and wheeled creatures (long = a bus). */
export function castModels(doc: any, exclude: string[] = []): CastModel[] {
  const out: CastModel[] = [];
  for (const id of doc.objectOrder ?? Object.keys(doc.objects)) {
    const o = doc.objects[id];
    if (!o || exclude.includes(id) || exclude.includes(o.name)) continue;
    if (o.character) {
      const motions = o.character.motions ?? {};
      const quad = o.params?.plan?.value === 'quadruped' || /dog/i.test(o.id);
      out.push({ id, kind: quad ? 'dog' : 'person', sits: !!motions.sit, label: o.name, ...(o.params?.height ? { height: o.params.height.value } : {}) });
    } else if (o.creature) {
      const wheels = o.creature.def.parts.find((p: any) => p.kind === 'wheels');
      const body = o.creature.def.parts.find((p: any) => p.kind === 'body');
      if (!wheels || !body) continue;
      const len = body.size?.[2] ?? 4.2, wid = body.size?.[0] ?? 1.8;
      out.push({ id, kind: len > 7 ? 'bus' : 'car', len: +len.toFixed(2), wid: +wid.toFixed(2), label: o.name });
    }
  }
  return out;
}

export interface LifeArgs { seed?: number; day?: LifeOptions['day']; season?: LifeOptions['season']; event?: string; start?: number; folk?: number[]; cars?: number[]; dogs?: number[]; player?: string }

export function bakeScene(doc: any, a: LifeArgs): { bake: LifeBake; models: CastModel[] } {
  const world: WorldState | undefined = doc.world;
  if (!world || !Object.keys(world.towns).length) throw new Error('no towns yet — the cast needs somewhere to live (studio world-town)');
  const towns = Object.values(world.towns).map((spec) => ({ plan: buildTown(spec).plan, offset: (spec.offset ?? [0, 0, 0]) as [number, number, number] }));
  const models = castModels(doc, a.player ? [a.player] : []);
  if (!models.some((m) => m.kind === 'person')) throw new Error('no folk in the scene — make a few characters first (studio new-character)');
  const bake = bakeLife(towns, { seed: a.seed ?? 1, day: a.day ?? 'saturday', season: a.season ?? 'autumn', event: (a.event ?? 'market') === 'none' ? null : 'market', start: a.start ?? 10.6, folk: a.folk, cars: a.cars, dogs: a.dogs, models });
  return { bake, models };
}

/** life.json: the runtime's data plus what the engines draw (walk polygons for the debug view, models). */
export function lifeJson(bake: LifeBake, models: CastModel[], extra: Record<string, unknown> = {}) {
  return {
    ...bake.data,
    models: Object.fromEntries(models.map((m) => [m.id, { kind: m.kind, file: `life/${m.id}.glb`, ...(m.sits !== undefined ? { sits: m.sits } : {}), ...(m.len ? { len: m.len, wid: m.wid } : {}) }])),
    walk: bake.walk,
    places: bake.places.filter((p) => p.kind !== 'door').map((p) => ({ id: p.id, kind: p.kind, at: [+p.at[0].toFixed(2), +p.y.toFixed(2), +p.at[1].toFixed(2)], offers: p.offers })),
    stats: bake.stats,
    ...extra,
  };
}

/** The runtimes ship next to the data: TS for the web, GDScript for Godot (same rules, same day). */
export function runtimeSources(): { ts: string; gd: string } {
  const fs = nodeFs(), path = nodePath();
  const here = path.dirname(nodeUrl().fileURLToPath(import.meta.url));
  return { ts: fs.readFileSync(path.join(here, 'runtime.ts'), 'utf8'), gd: fs.readFileSync(path.join(here, '../../../game/templates/godot/studio/life.gd'), 'utf8') };
}

/** A scripted player for the headless day: along a sidewalk of the first town's widest street and across it, mid-block. */
export function defaultPlayer(doc: any): PlayerScript | null {
  const spec: any = Object.values(doc.world?.towns ?? {})[0];
  if (!spec) return null;
  const plan = buildTown(spec).plan, off = spec.offset ?? [0, 0, 0];
  const s = plan.streets.filter((x: any) => x.sidewalk > 3 && ['tertiary', 'secondary', 'residential'].includes(x.kind)).sort((a: any, b: any) => b.sidewalk - a.sidewalk)[0];
  if (!s) return null;
  const w = s.width / 2 + s.sidewalk / 2;
  const at = (d: number, o: number): [number, number] => { const { p, dir } = alongLine(s.points, d); return [p[0] - dir[1] * o + off[0], p[1] + dir[0] * o + off[2]]; };
  return { pts: [at(30, -w), at(90, -w), at(90, w), at(30, w), at(30, -w)], speed: 1.3 };
}

const Hours = z.number().min(0).max(30);
export const LIFE_TOOLS: ToolDef[] = [
  {
    name: 'life-bake', mode: 'output', mutates: false,
    description: 'Give the towns life (Decision 30): bakes one walk mesh and lane graph from the town plans (sidewalks, plazas, crosswalks, piers; car lanes split at junctions with stop lines and signals), smart places that say what they offer (bench "sit ×2", stall "browse ×2 + tend", pier "fish ×2", park "walk the dog", bus stop "wait ×3", doors), a seeded cast drawn from the scene\'s characters (four-legged = dog) and wheeled creatures (long = bus), and their day by hour, season and event. Writes life.json, life-props.glb and both runtimes (life.ts, life.gd) into --out (a game\'s assets/studio). --day saturday|sunday|weekday --season autumn… --event market|none --start 10.6 (hour the games open on) --seed n. Same seed, same day, in both engines.',
    input: z.object({
      out: z.string().optional().describe('folder (default: return the summary only)'), seed: z.number().optional(), day: z.enum(['saturday', 'sunday', 'weekday']).optional(), season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
      event: z.enum(['market', 'none']).optional(), start: Hours.optional(), player: z.string().optional().describe('the game\'s player character (left out of the cast)'),
      folk: z.array(z.number()).optional().describe('cast size per town'), cars: z.array(z.number()).optional(), dogs: z.array(z.number()).optional(),
    }),
    example: 'studio life-bake --out games/pocket-raleigh/assets/studio --seed 1 --day saturday --event market --player walker',
    run(ctx, a) {
      const { bake, models } = bakeScene(ctx.doc, a);
      const files: string[] = [];
      if (a.out) {
        const fs = nodeFs(), path = nodePath();
        fs.mkdirSync(a.out, { recursive: true });
        const json = lifeJson(bake, models, { seed: a.seed ?? 1, day: a.day ?? 'saturday', season: a.season ?? 'autumn', event: a.event ?? 'market' });
        fs.writeFileSync(path.join(a.out, 'life.json'), JSON.stringify(json));
        fs.writeFileSync(path.join(a.out, 'life-props.glb'), propsGlb(bake.props));
        files.push('life.json', 'life-props.glb');
      }
      ctx.summary(`Baked life: ${bake.stats.folk} folk, ${bake.stats.dogs} dog${bake.stats.dogs === 1 ? '' : 's'}, ${bake.stats.cars} cars, ${bake.stats.buses} bus; ${bake.places.length} smart places`);
      return { stats: bake.stats, models: models.map((m) => `${m.id} (${m.kind})`), files, next: 'studio life-day --hours 24  (the sped-up headless day)' };
    },
  },
  {
    name: 'life-day', mode: 'inspect', mutates: false,
    description: 'Run the baked day sped up and headless through the same runtime the web plays, with a scripted player walking a sidewalk and across the street, and check it: nobody inside anybody or a building, folk on the walk, no pops (no jump past the body\'s speed + 0.3 m), no car hits anyone or another car, nobody runs a red, no gridlock, the dog at leash length, one sitter per seat, folk make room for the player and cars brake for them. --from 5 --hours 24.',
    input: z.object({ from: Hours.optional(), hours: z.number().min(0.05).max(24).optional(), seed: z.number().optional(), player: z.string().optional(), event: z.enum(['market', 'none']).optional() }),
    example: 'studio life-day --from 5 --hours 24',
    run(ctx, a) {
      const { bake } = bakeScene(ctx.doc, a);
      const from = (a.from ?? 5) * 3600;
      const rep = runDay(bake, { from, to: from + (a.hours ?? 24) * 3600, player: defaultPlayer(ctx.doc) });
      const failing = rep.checks.filter((c) => !c.pass);
      ctx.summary(`Headless day ${a.from ?? 5}:00 +${a.hours ?? 24} h: ${rep.checks.length - failing.length}/${rep.checks.length} checks pass (${(rep.ms / 1000).toFixed(0)} s)`);
      return { ...rep, failing: failing.map((c) => c.name) };
    },
  },
];
