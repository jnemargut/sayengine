// The life module (Decision 30): smart places, a seeded cast and day, one walk mesh and lane graph, the
// runtime (the web's, and the reference for Godot's), the headless day checks and the props.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setWorldCacheDir, buildTown } from '../src/world/index.ts';
import { bakeLife, density, type CastModel } from '../src/life/bake.ts';
import { LifeRuntime, GREEN, RED, type LifeData } from '../src/life/runtime.ts';
import { runDay } from '../src/life/day.ts';
import { propsGlb } from '../src/life/props.ts';
import { castModels } from '../src/life/tools.ts';
import { TOOLS, validateGlb } from '../src/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
setWorldCacheDir(path.join(HERE, 'fixtures/world'));
const MODELS: CastModel[] = [
  { id: 'folk-a', kind: 'person', sits: true }, { id: 'folk-b', kind: 'person', sits: true }, { id: 'folk-kid', kind: 'person', sits: false },
  { id: 'dog', kind: 'dog' }, { id: 'car', kind: 'car', len: 4.25, wid: 1.78 }, { id: 'bus', kind: 'bus', len: 10.4, wid: 2.5 },
];
const twinSpec = { name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', style: 'river-town-1920s', fixes: [] } as any;
let cached: ReturnType<typeof bakeLife> | null = null;
const bakeTwin = (seed = 1) => {
  if (seed === 1 && cached) return cached;
  const b = bakeLife([{ plan: buildTown(twinSpec).plan, offset: [380, 0, 0] }], { seed, event: 'market', folk: [36], cars: [5], busTowns: [0], models: MODELS });
  if (seed === 1) cached = b;
  return b;
};

test('smart places say what they offer: benches sit ×2, stalls browse ×2 + tend, piers fish ×2, a park for the dog', () => {
  const b = bakeTwin();
  const kinds = new Set(b.places.map((p) => p.kind));
  for (const k of ['bench', 'stall', 'pier', 'park', 'door']) assert.ok(kinds.has(k as any), `a ${k}`);
  const bench = b.places.find((p) => p.kind === 'bench')!;
  assert.deepEqual(bench.offers, [{ action: 'sit', who: 'person', slots: 2 }]);
  assert.equal(bench.slots.length, 2);
  const stall = b.places.find((p) => p.kind === 'stall')!;
  assert.deepEqual(stall.offers.map((o) => `${o.action}×${o.slots}`), ['browse×2', 'tend×1']);
  const pier = b.places.find((p) => p.kind === 'pier')!;
  assert.deepEqual(pier.offers, [{ action: 'fish', who: 'person', slots: 2 }]);
  assert.ok(b.places.find((p) => p.kind === 'park')!.offers.some((o) => o.action === 'walk-dog' && o.who === 'pair'));
  // every slot is reachable from the walk graph and stands on the walk (or the pier)
  for (const p of b.places) for (const s of p.slots) assert.ok(b.towns[0].graph.adj[s.approach].length > 0, `${p.id} slot ${s.id}`);
});

test('one walk mesh and one lane graph: sidewalks, crossings, piers and plazas; car lanes keep right with stop lines and signals', () => {
  const b = bakeTwin();
  const kinds = new Set(b.walk.map((w) => w.kind));
  for (const k of ['sidewalk', 'crossing', 'pier', 'plaza']) assert.ok(kinds.has(k), `walk polygons: ${k}`);
  for (const w of b.walk) assert.equal(w.poly.length % 3, 0);
  assert.ok(b.stats.walkNodes > 200 && b.stats.crossings > 4, JSON.stringify(b.stats));
  const T = b.towns[0];
  const lanes = T.lanes.filter((e) => e.kind === 'lane');
  // right-hand traffic: each lane sits right of its street's centreline, seen along its direction
  for (const e of lanes.slice(0, 20)) {
    const s = T.ws.cars[e.street], a = e.pts[0], c = e.pts[1];
    const d = [c[0] - a[0], c[2] - a[2]], L = Math.hypot(d[0], d[1]);
    let best = { d: Infinity, p: [0, 0] as number[] };
    for (const q of s.points) { const dd = Math.hypot(q[0] - a[0], q[1] - a[2]); if (dd < best.d) best = { d: dd, p: q }; }
    const side = ((a[0] - best.p[0]) * -d[1] + (a[2] - best.p[1]) * d[0]) / L;
    assert.ok(side > 0, `lane ${e.id} keeps right`);
  }
  assert.ok(b.data.edges.some((e) => e.stop), 'stop lines');
  assert.ok(b.data.signals.length >= 1, 'signals');
  // no left turns (no head-on conflicts in the junction box); right turns and straight on only
  for (const t of T.lanes.filter((e) => e.kind === 'turn' && e.from >= 0)) assert.ok(t.startDir[0] * t.endDir[1] - t.startDir[1] * t.endDir[0] > -0.5, 'no left turn');
});

test('a seeded cast and day: varied models, by hour and event; same seed → same day, another seed → another', () => {
  const b = bakeTwin();
  const folk = b.data.agents.filter((a) => a.kind === 'person');
  assert.ok(folk.length >= 30);
  assert.equal(new Set(folk.map((a) => a.model)).size, 3, 'every folk model is used');
  assert.ok(b.data.agents.some((a) => a.kind === 'dog' && a.owner !== undefined), 'a dog walker');
  assert.ok(b.data.vehicles.some((v) => v.kind === 'bus' && v.loop), 'a bus on a loop');
  // nobody tends a stall outside market hours; the kid (no sit clip) never sits
  for (const a of folk) for (const g of a.plan) {
    if (g.k !== 'act') continue;
    if (g.pose === 'tend') assert.ok(g.t < 13 * 3600 && g.t1 <= 13 * 3600 + 1, 'tend in market hours');
    if (g.pose === 'sit') assert.notEqual(a.model, 'folk-kid');
  }
  // the day follows the hour: more out at 11 than at 6
  assert.ok(density({ seed: 1, models: [] }, 11) > density({ seed: 1, models: [] }, 6) * 5);
  const small = (seed: number) => bakeLife([{ plan: buildTown(twinSpec).plan, offset: [380, 0, 0] }], { seed, event: 'market', folk: [8], cars: [2], busTowns: [0], models: MODELS });
  const one = small(1);
  assert.equal(JSON.stringify(small(1).data), JSON.stringify(one.data), 'same seed, same day');
  assert.notEqual(JSON.stringify(small(2).data.agents.map((a) => a.plan)), JSON.stringify(one.data.agents.map((a) => a.plan)), 'another seed, another day');
});

test('the runtime is deterministic, and the headless day passes its checks', () => {
  const b = bakeTwin();
  const a = new LifeRuntime(b.data), c = new LifeRuntime(b.data);
  a.init(10.6 * 3600); c.init(10.6 * 3600);
  for (let k = 0; k < 600; k++) { a.step(); c.step(); }
  assert.deepEqual(a.snapshot(), c.snapshot());
  assert.ok(a.agents.some((s) => s.visible) && a.vehicles.some((v) => v.visible));
  const rep = runDay(b, { from: 10 * 3600, to: 10.5 * 3600 });
  const by = Object.fromEntries(rep.checks.map((k) => [k.name, k]));
  for (const k of ['nobody inside a building', 'no pops', 'nobody runs a red', 'dog at leash length', 'one sitter per seat', 'no two cars in one spot']) assert.ok(by[k].pass, `${k}: ${JSON.stringify(by[k])}`);
  assert.ok(rep.peak.folk > 5, `folk out: ${rep.peak.folk}`);
});

// a tiny hand-made day: one straight lane with a stop line, two cars, a person crossing
function tinyDay(): LifeData {
  const pts: number[] = [];
  for (let x = 0; x <= 100; x += 5) pts.push(x, 0, 0);
  return {
    version: 1, dt: 0.1, start: 0, slots: 0,
    signals: [{ id: 's', at: [100, 0], cycle: 60, offset: 0, green: [20, 30], amber: 3, allRed: 2 }],
    edges: [{ id: 'e', pts, speed: 11, stop: { sig: 0, group: 0 } }],
    paths: [[50, 0, -6, 1.3, 50, 0, 6, 1.3]],
    agents: [{ id: 'p', kind: 'person', r: 0.26, speed: 1.3, model: 'folk', plan: [{ k: 'move', t: 1000, p: 0 }] }],
    vehicles: [{ id: 'lead', kind: 'car', len: 4.2, wid: 1.8, model: 'car', trips: [{ t: 25, edges: [0] }] }, { id: 'follow', kind: 'car', len: 4.2, wid: 1.8, model: 'car', trips: [{ t: 28, edges: [0] }] }],
  };
}

test('cars: following at a safe gap, stopping at the line on red, braking for the player', () => {
  const D = tinyDay();
  const rt = new LifeRuntime(D);
  rt.init(25, 0);           // group 0 is amber at 20–23, red from 23: they must stop
  let minGap = Infinity;
  for (let k = 0; k < 300; k++) {
    rt.step();
    const [a, b] = rt.vehicles;
    if (a.visible && b.visible) minGap = Math.min(minGap, Math.abs(a.x - b.x) - 4.2);
    if (a.visible) assert.ok(a.x <= 100 - 2.1 + 0.3 || rt.signal(0, 0, rt.t) !== RED, `over the line on red at ${a.x}`);
  }
  assert.ok(minGap > 1.5, `gap ${minGap}`);
  assert.ok(rt.vehicles[0].v < 0.1 && rt.vehicles[0].x > 90, `the lead waits at the line: ${rt.vehicles[0].x}`);
  // green again (t = 60 + …): they go
  while (rt.signal(0, 0, rt.t) !== GREEN) rt.step();
  for (let k = 0; k < 50; k++) rt.step();
  assert.ok(rt.vehicles[0].v > 1 || !rt.vehicles[0].visible);
  // the player steps into the lane: the next car stops short of them
  const r2 = new LifeRuntime(D);
  r2.init(25, 0);
  r2.setPlayer(40, 0, 0.35, true);
  for (let k = 0; k < 300; k++) r2.step();
  assert.ok(r2.vehicles[0].x + 2.1 < 40 - 0.35, `stopped short of the player: front at ${r2.vehicles[0].x + 2.1}`);
});

test('folk: wait for the cars, step aside for the player, never walk into them', () => {
  const D = tinyDay();
  D.vehicles = [];
  D.agents[0].plan = [{ k: 'move', t: 0, p: 0 }];
  const rt = new LifeRuntime(D);
  rt.init(0, 0);
  rt.setPlayer(50, 0, 0.35, true);              // standing on the person's line
  let closest = Infinity;
  for (let k = 0; k < 200; k++) { rt.step(); const a = rt.agents[0]; if (a.visible) closest = Math.min(closest, Math.hypot(a.x - 50, a.z)); }
  assert.ok(closest > 0.26 + 0.35 - 0.05, `kept clear of the player: ${closest}`);
  assert.ok(rt.agents[0].z > 0.5 || !rt.agents[0].visible || rt.agents[0].seg > 0, 'got past');
});

test('props: stalls, piers, bus stops and signal heads with lit lamps, a valid GLB', async () => {
  const b = bakeTwin();
  const glb = propsGlb(b.props);
  const v = await validateGlb(glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages.slice(0, 3)));
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  const names = json.nodes.map((n: any) => n.name);
  for (const p of ['stall ', 'pier ', 'signal ', 'lit:']) assert.ok(names.some((n: string) => n.startsWith(p)), p);
});

test('the life tools are registered, the cast comes from the scene, and the web runtime is the core runtime', () => {
  for (const t of ['life-bake', 'life-day']) assert.ok(TOOLS.some((x) => x.name === t), t);
  const doc = { objectOrder: ['a', 'd', 'c', 'b'], objects: {
    a: { id: 'a', name: 'Ada', character: { motions: { walk: {}, sit: {} } }, params: {} },
    d: { id: 'dog-1', name: 'Biscuit', character: { motions: {} }, params: { plan: { value: 'quadruped' } } },
    c: { id: 'c', name: 'Car', creature: { def: { parts: [{ kind: 'body', size: [1.8, 0.6, 4.2] }, { kind: 'wheels' }] } } },
    b: { id: 'b', name: 'Bus', creature: { def: { parts: [{ kind: 'body', size: [2.5, 2.3, 10.4] }, { kind: 'wheels' }] } } },
  } };
  assert.deepEqual(castModels(doc).map((m) => `${m.id}:${m.kind}${m.sits ? ':sits' : ''}`), ['a:person:sits', 'd:dog', 'c:car', 'b:bus']);
  const core = fs.readFileSync(path.join(ROOT, 'packages/core/src/life/runtime.ts'), 'utf8');
  assert.equal(fs.readFileSync(path.join(ROOT, 'packages/game/templates/web/studio/life.ts'), 'utf8'), core, 'templates/web/studio/life.ts is a copy of core/src/life/runtime.ts');
  for (const g of ['games/pocket-raleigh-web/studio/life.ts']) if (fs.existsSync(path.join(ROOT, g))) assert.equal(fs.readFileSync(path.join(ROOT, g), 'utf8'), core, g);
});
