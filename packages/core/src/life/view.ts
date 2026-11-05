// Town life in the live view (Phase 10 step 3b): the life module's baked day for the scene's town, kept
// light (one town, a capped cast), with a day clock the view scrubs and plays. A person is a thing
// (`person:<id>`) on the day clock (`day`: seconds since midnight, 24,000 ticks a second); their plan's
// stops are the clock's named moments, so a note on "Ada on the bench at 09:20" follows the bench stop
// when a redirect moves it. A redirect ("go to the café at 9 instead") is a plan edit kept in
// `doc.life.redirects`: one step, applied by the bake after everyone's day with its own random source
// (nobody else's day moves), then the headless day checks re-run.
import type { SceneDoc } from '../types.ts';
import { buildTown, type WorldState } from '../world/town.ts';
import { buildingLabel } from '../world/view.ts';
import { stamp, dayTime, TICKS, type Timeline } from '../collab/address.ts';
import { addTimelineProvider, partWords } from '../collab/timelines.ts';
import { bakeLife, type LifeBake, type Redirect, type Place, type CastModel } from './bake.ts';
import { castModels, defaultPlayer } from './tools.ts';
import { runDay, type DayReport } from './day.ts';
import type { LifeAct, LifeMove } from './runtime.ts';

/** Kept light for an 8 GB Mac: one town's cast, capped. */
export const LIFE_CAPS = { folk: 40, cars: 6, defaultFolk: 24, defaultCars: 3 };
export const DAY_TICKS = 86400 * TICKS;

export interface LifeSettings {
  seed?: number; day?: 'saturday' | 'sunday' | 'weekday'; season?: 'spring' | 'summer' | 'autumn' | 'winter'; event?: 'market' | 'none';
  folk?: number; cars?: number; start?: number;
  redirects?: Redirect[];
}

export interface SceneLife { key: string; bake: LifeBake; models: CastModel[]; settings: LifeSettings; places: Map<string, PlaceInfo>; names: string[]; day?: DayReport }
export interface PlaceInfo { id: string; kind: Place['kind']; words: string; use?: string; at: [number, number, number]; building?: string }

const memo = new Map<string, SceneLife>();

/** The settings in effect (null: life isn't on in this scene). */
export function lifeSettings(doc: SceneDoc): LifeSettings | null { return ((doc as any).life as LifeSettings | undefined) ?? null; }

/** The cast characters life uses (left out of the scene timeline while life plays them). */
export function lifeCast(doc: SceneDoc): string[] { return lifeSettings(doc) ? castModels(doc).map((m) => m.id) : []; }

function lifeKey(doc: SceneDoc, s: LifeSettings) {
  const world: WorldState | undefined = (doc as any).world;
  return stamp({ towns: world?.towns ?? null, cast: castModels(doc), life: s });
}

/** The scene's life, baked once per recipe (towns + cast + settings + redirects). */
export function sceneLife(doc: SceneDoc): SceneLife | null {
  const s = lifeSettings(doc);
  if (!s) return null;
  const key = lifeKey(doc, s);
  const hit = memo.get(key);
  if (hit) return hit;
  const world: WorldState | undefined = (doc as any).world;
  if (!world || !Object.keys(world.towns).length) throw new Error('no town yet: life needs somewhere to live (studio world-town)');
  const specs = Object.values(world.towns);
  // one town in the view: the first one (the chunk the view shows)
  const spec: any = specs[0];
  const built = buildTown(spec, world);
  const models = castModels(doc);
  if (!models.some((m) => m.kind === 'person')) throw new Error('no folk in the scene: make a few characters first (studio new-character)');
  const folk = Math.min(LIFE_CAPS.folk, s.folk ?? LIFE_CAPS.defaultFolk), cars = Math.min(LIFE_CAPS.cars, s.cars ?? LIFE_CAPS.defaultCars);
  const bake = bakeLife([{ plan: built.plan, offset: (spec.offset ?? [0, 0, 0]) as [number, number, number] }], {
    seed: s.seed ?? 1, day: s.day ?? 'saturday', season: s.season ?? 'autumn', event: (s.event ?? 'market') === 'none' ? null : 'market', start: s.start ?? 9,
    folk: [folk], cars: [cars], dogs: [models.some((m) => m.kind === 'dog') ? 1 : 0], models, redirects: s.redirects ?? [],
  });
  const places = new Map<string, PlaceInfo>();
  const benchN = new Map<string, number>();
  for (const p of bake.places) {
    let words: string = p.kind;
    let use: string | undefined;
    if (p.kind === 'door') {
      const b = built.plan.buildings.find((x) => x.id === p.building);
      use = b?.use;
      words = b ? `${b.name ? `${b.name} (${buildingLabel(b)})` : buildingLabel(b)}` : 'a door';
    } else if (p.kind === 'bench' || p.kind === 'stall' || p.kind === 'pier' || p.kind === 'busstop') {
      const n = (benchN.get(p.kind) ?? 0) + 1; benchN.set(p.kind, n);
      words = `${p.kind === 'busstop' ? 'bus stop' : p.kind} ${n}`;
    } else if (p.kind === 'park') words = 'the park';
    places.set(p.id, { id: p.id, kind: p.kind, words, ...(use ? { use } : {}), at: [+p.at[0].toFixed(2), +p.y.toFixed(2), +p.at[1].toFixed(2)], ...(p.building ? { building: p.building } : {}) });
  }
  const names = bake.data.agents.map((a, i) => personName(a.id, i));
  const life: SceneLife = { key, bake, models, settings: s, places, names };
  if (memo.size > 6) memo.delete(memo.keys().next().value!);
  memo.set(key, life);
  return life;
}

const FIRST = ['June', 'Omar', 'Priya', 'Theo', 'Rosa', 'Malik', 'Ines', 'Felix', 'Nora', 'Kenji', 'Lena', 'Sami', 'Ada', 'Bram', 'Cleo', 'Dara', 'Eli', 'Fern', 'Gus', 'Hana', 'Ivo', 'Jade', 'Kofi', 'Lior', 'Mina', 'Nils', 'Opal', 'Pia', 'Quin', 'Rafa'];
/** A first name for a person (stable for their id), so "June on bench 4" reads better than an id. */
export function personName(id: string, i: number): string {
  if (/-dog$/.test(id)) return 'the dog';
  let h = 0; for (const c of id.replace(/-pal$/, '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const base = FIRST[(h + i * 7) % FIRST.length];
  return base;
}

/** The headless day for the scene's life (the existing checks), run once per recipe. */
export function lifeDay(doc: SceneDoc, o: { from?: number; hours?: number } = {}): DayReport {
  const L = sceneLife(doc);
  if (!L) throw new Error('life is not on in this scene (studio life-on)');
  const from = (o.from ?? 5) * 3600, hours = o.hours ?? 24;
  if (L.day && L.day.from === from && L.day.to === from + hours * 3600) return L.day;
  const day = runDay(L.bake, { from, to: from + hours * 3600, player: defaultPlayer(doc) });
  L.day = day;
  return day;
}

// ── a person and their day, in words ────────────────────────────────────────────────────────────

export interface Stop { name: string; from: number; to: number; words: string; place?: string; kind: 'out' | 'stop' | 'home' }

const POSE_WORDS: Record<string, string> = { sit: 'sits on', browse: 'browses', tend: 'keeps', fish: 'fishes off', wait: 'waits at', look: 'looks around at', inside: 'goes into' };

/** Agent index for a person id (or a name/index the user said). */
export function findPerson(L: SceneLife, who: string): number {
  const id = who.replace(/^person:/, '');
  let i = L.bake.data.agents.findIndex((a) => a.id === id);
  if (i < 0) i = L.names.findIndex((n, k) => n.toLowerCase() === id.toLowerCase() && L.bake.data.agents[k].kind === 'person');
  if (i < 0) throw new Error(`no person "${who}" in town (try one of ${L.bake.data.agents.slice(0, 6).map((a) => a.id).join(', ')}…)`);
  return i;
}

/** Who they are: name, look (the cast model), role, where they live, and who they're with. */
export function personInfo(L: SceneLife, i: number) {
  const D = L.bake.data, a = D.agents[i];
  const lead = a.owner !== undefined ? a.owner : i;
  const member = L.bake.cast.find((c) => c.id === D.agents[lead].id);
  const model = L.models.find((m) => m.id === a.model);
  const ROLE: Record<string, string> = { folk: 'out and about', vendor: 'keeps a market stall', fisher: 'fishes off the pier', dogwalker: 'walks the dog', kid: 'a kid out with family' };
  const role = a.kind === 'dog' ? `${L.names[lead]}'s dog` : a.owner !== undefined ? `out with ${L.names[lead]} (walks beside them)` : ROLE[member?.role ?? 'folk'] ?? member?.role ?? 'out and about';
  return {
    id: a.id, index: i, name: L.names[i], kind: a.kind, looksLike: model?.label ?? a.model, model: a.model, role,
    home: member ? L.places.get(member.home)?.words ?? member.home : null,
    ...(a.pal !== undefined ? { with: L.names[a.pal] } : {}), ...(a.owner !== undefined ? { follows: D.agents[a.owner].id } : {}),
    speed: a.speed,
  };
}

/** Their plan for the day: when they go out, each stop (with times), when they're home again. */
export function personPlan(L: SceneLife, i: number): Stop[] {
  const D = L.bake.data;
  const a = D.agents[i];
  const lead = a.owner !== undefined ? a.owner : i;           // a friend or a dog keeps their leader's day
  const plan = D.agents[lead].plan;
  const out: Stop[] = [];
  const pathLen = (p: number) => { const q = D.paths[p]; let s = 0; for (let k = 4; k < q.length; k += 4) s += Math.hypot(q[k] - q[k - 4], q[k + 2] - q[k - 2]); return s; };
  const used = new Map<string, number>();
  const name = (base: string) => { const n = (used.get(base) ?? 0) + 1; used.set(base, n); return n === 1 ? base : `${base} (${n})`; };
  let outAt = -1;
  plan.forEach((g, k) => {
    if (g.k === 'move') {
      if (outAt < 0) { outAt = g.t; out.push({ name: name('out'), from: g.t, to: g.t, words: 'leaves home', kind: 'out' }); }
      const nx = plan[k + 1];
      if (!nx || (nx.k === 'act' && (nx as LifeAct).pose === 'inside' && !(nx as LifeAct).place)) {
        const end = g.t + pathLen((g as LifeMove).p) / D.agents[lead].speed;
        out.push({ name: name('home'), from: end, to: end, words: nx ? 'home again' : 'home for the day', kind: 'home' });
        outAt = -1;
      }
      return;
    }
    const act = g as LifeAct;
    if (act.pose === 'inside' && !act.place) return;           // at home between outings
    if (act.pose === 'look' && !act.place) return;              // a glance in a window on a stroll
    const pl = act.place ? L.places.get(act.place) : undefined;
    const where = pl?.words ?? 'a spot';
    const verb = POSE_WORDS[act.pose] ?? act.pose;
    const what = act.pose === 'tend' ? `keeps ${where}` : act.pose === 'inside' ? `goes into ${where}` : `${verb} ${pl?.kind === 'bench' ? where : pl?.kind === 'door' ? where : `the ${where}`}`;
    out.push({ name: name(pl?.words ?? act.pose), from: act.t, to: act.t1, words: what, ...(act.place ? { place: act.place } : {}), kind: 'stop' });
  });
  return out;
}

/** The plan as lines: "09:12–09:31 sits on bench 4". */
export const planWords = (stops: Stop[]) => stops.map((s) => `${dayTime(s.from)}${s.to > s.from + 30 ? `–${dayTime(s.to)}` : ''} ${s.words}`);

/** Where someone is at a time of day, in words. */
export function nowWords(stops: Stop[], t: number): string {
  const at = stops.find((s) => s.kind === 'stop' && t >= s.from && t < s.to);
  if (at) return at.words.replace(/^sits/, 'sitting').replace(/^browses/, 'browsing').replace(/^goes into/, 'inside').replace(/^keeps/, 'keeping').replace(/^fishes/, 'fishing').replace(/^waits/, 'waiting').replace(/^looks around/, 'looking around');
  let out = false;
  for (const s of stops) { if (s.from > t) break; out = s.kind !== 'home'; }
  return out ? 'walking' : 'at home';
}

// ── the day clock (Decision 61): a person's stops are its named moments ─────────────────────────

export function dayTimeline(doc: SceneDoc, thing: string): Timeline | null {
  const id = thing.split('/')[0].replace(/^person:/, '');
  let L: SceneLife | null = null;
  try { L = sceneLife(doc); } catch { L = null; }
  const gone: Timeline = { clock: 'day', thing, length: DAY_TICKS, version: 'gone', markers: {}, exists: false };
  if (!L) return gone;
  const i = L.bake.data.agents.findIndex((a) => a.id === id);
  if (i < 0) return gone;
  const stops = personPlan(L, i);
  const markers: Timeline['markers'] = {};
  for (const s of stops) markers[s.name] = { at: Math.round(s.from * TICKS), ...(s.to > s.from ? { len: Math.round((s.to - s.from) * TICKS) } : {}) };
  return { clock: 'day', thing, length: DAY_TICKS, version: stamp(L.bake.data.agents[i].owner !== undefined ? L.bake.data.agents[L.bake.data.agents[i].owner!].plan : L.bake.data.agents[i].plan), markers };
}

/** The named stop a time of day falls in (to anchor a day address), else the nearest start within 10 min. */
export function stopAt(stops: Stop[], seconds: number): Stop | undefined {
  const inside = stops.find((s) => s.kind === 'stop' && seconds >= s.from && seconds < s.to);
  if (inside) return inside;
  let best: Stop | undefined, bd = 600;
  for (const s of stops) { const d = Math.abs(s.from - seconds); if (d <= bd) { bd = d; best = s; } }
  return best;
}

addTimelineProvider((doc, thing, clock) => (clock === 'day' && thing.startsWith('person:') ? dayTimeline(doc, thing) : undefined));
partWords.person = (doc, id) => { try { const L = sceneLife(doc); if (!L) return null; const i = L.bake.data.agents.findIndex((a) => a.id === id); return i < 0 ? null : `${L.names[i]} (${id})`; } catch { return null; } };

// ── redirects from words ("go to the café at 9 instead") ─────────────────────────────────────────

/** A time of day said in words: "at 9", "at 9:30", "3pm", "15:00", "at noon". Hours. */
export function hoursFromWords(w: string): number | null {
  const s = w.toLowerCase();
  if (/\bnoon\b|\bmidday\b/.test(s)) return 12;
  const m = s.match(/\b(?:at|by|around|from)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?\b/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (m[3]?.startsWith('p') && h < 12) h += 12;
  if (m[3]?.startsWith('a') && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h + min / 60;
}

/** How long they stay, in minutes: "for 20 minutes", "for an hour", "for half an hour". */
export function stayFromWords(w: string): number | null {
  const s = w.toLowerCase();
  if (/half an hour/.test(s)) return 30;
  if (/for an hour|for one hour/.test(s)) return 60;
  const m = s.match(/for (\d+(?:\.\d+)?)\s*(min|minutes?|h|hours?)/);
  if (!m) return null;
  return m[2].startsWith('h') ? Number(m[1]) * 60 : Number(m[1]);
}

const KIND_WORDS: Array<[RegExp, (p: PlaceInfo) => boolean]> = [
  [/caf[eé]|coffee|shop|store|bakery|bar\b|pub/, (p) => p.kind === 'door' && p.use === 'shop'],
  [/office|work/, (p) => p.kind === 'door' && p.use === 'office'],
  [/hotel/, (p) => p.kind === 'door' && p.use === 'hotel'],
  [/church/, (p) => p.kind === 'door' && p.use === 'church'],
  [/bench|sit/, (p) => p.kind === 'bench'],
  [/stall|market/, (p) => p.kind === 'stall'],
  [/pier|fish/, (p) => p.kind === 'pier'],
  [/bus/, (p) => p.kind === 'busstop'],
  [/park/, (p) => p.kind === 'park'],
];

/** Words → a redirect: the place (by its words, its kind or a café = a shop), the time and the stay. */
export function redirectFromWords(L: SceneLife, who: number, words: string): { at: number; place: string; stay: number; heard: string } {
  const s = words.toLowerCase();
  const at = hoursFromWords(s.replace(/for \d+(\.\d+)?\s*(min|minutes?|h|hours?)/, ''));
  if (at === null) throw new Error(`I didn't catch a time in "${words}" (say "at 9", "at 14:30", "3pm")`);
  const all = [...L.places.values()];
  // a place named outright ("bench 4", "Shop 2a17ab")
  let pick = all.find((p) => s.includes(p.words.toLowerCase()));
  if (!pick) {
    for (const [re, ok] of KIND_WORDS) {
      if (!re.test(s)) continue;
      const cands = all.filter(ok);
      if (!cands.length) continue;
      // the nearest one to where they are at that time (else their home door)
      const D = L.bake.data, lead = D.agents[who].owner ?? who;
      const homeId = L.bake.cast.find((c) => c.id === D.agents[lead].id)?.home;
      const home = homeId ? L.places.get(homeId) : undefined;
      const ref = home?.at ?? cands[0].at;
      pick = cands.slice().sort((a, b) => Math.hypot(a.at[0] - ref[0], a.at[2] - ref[2]) - Math.hypot(b.at[0] - ref[0], b.at[2] - ref[2]))[0];
      break;
    }
  }
  if (!pick) throw new Error(`I didn't catch where in "${words}" (say a café, a shop, a bench, the market, the pier, the bus stop, the park, or a place's name like "bench 4")`);
  const stay = stayFromWords(s) ?? (pick.kind === 'door' ? 40 : pick.kind === 'bench' ? 25 : 30);
  return { at: +at.toFixed(3), place: pick.id, stay, heard: `${pick.words} at ${dayTime(at * 3600)} for ${stay} min` };
}

// ── the payload for the view (/api/life) ───────────────────────────────────────────────────────

const colourOf = (doc: any, id: string, part: string, d: string) => {
  const o = doc.objects?.[id];
  if (!o) return d;
  if (o.creature) return o.creature.def.parts.find((p: any) => p.kind === 'body')?.color ?? d;
  const pm = (o.partMaterials ?? []).find((x: any) => x.parts === part);
  return pm?.material?.color ?? o.material?.color ?? d;
};

/** What the view plays: the runtime's data, who everyone is (colours from their cast model), the places, the redirects. */
export function lifeForView(doc: SceneDoc) {
  const L = sceneLife(doc);
  if (!L) return null;
  const D = L.bake.data;
  const people = D.agents.map((a, i) => ({
    i, id: a.id, name: L.names[i], kind: a.kind, model: a.model,
    colours: a.kind === 'dog' ? { body: colourOf(doc, a.model, 'torso', '#8a6a4a') } : { shirt: colourOf(doc, a.model, 'torso', '#6f8fa8'), trousers: colourOf(doc, a.model, '*UpperLeg', '#3f4654'), skin: colourOf(doc, a.model, 'Head', '#d9a77a'), hair: colourOf(doc, a.model, 'hair', '#4a3022') },
    height: (doc as any).objects?.[a.model]?.params?.height?.value ?? 1.7, scale: a.scale ?? 1,
    info: personInfo(L, i), stops: personPlan(L, i).map((x) => ({ ...x, from: Math.round(x.from), to: Math.round(x.to) })),
  }));
  const vehicles = D.vehicles.map((v, i) => ({ i, id: v.id, kind: v.kind, len: v.len, wid: v.wid, colour: colourOf(doc, v.model, '', v.kind === 'bus' ? '#d9a23a' : '#b8382c') }));
  return {
    key: L.key, settings: L.settings,
    data: { version: D.version, dt: D.dt, start: D.start, slots: D.slots, signals: D.signals, edges: D.edges, paths: D.paths, agents: D.agents, vehicles: D.vehicles },
    people, vehicles, places: [...L.places.values()],
    stats: L.bake.stats, redirected: L.bake.redirected ?? [], redirects: L.settings.redirects ?? [],
    caps: LIFE_CAPS,
  };
}

/** For the state the view gets: is life on, its recipe key (to refetch), the redirects. */
export function lifeForState(doc: SceneDoc) {
  const s = lifeSettings(doc);
  if (!s) return null;
  const cast = castModels(doc).map((m) => m.id);
  return { stamp: stamp({ towns: (doc as any).world?.towns ?? null, cast, life: s }), settings: s, redirects: (s.redirects ?? []).length, cast };
}
