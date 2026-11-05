// Bench: the life module (Decision 30) on Pocket Raleigh. Bakes the seeded Saturday for both towns (folk,
// a dog walker each, cars and a bus), writes life.json + life-props.glb + the two runtimes into both games,
// runs the sped-up headless day, and checks D30's tripwire: the GDScript runtime in Godot and the
// TypeScript one agree within 0.5 m on the same seed.
//   node bench/life.ts [--hours 1] [--from 9.5] [--parity 120] [--no-godot]
// The cast GLBs come from bench/life-cast.sh + bench/life-export.sh (studio characters and wheel-rig vehicles).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setWorldCacheDir, buildTown } from '../packages/core/src/world/index.ts';
import { bakeLife, type CastModel } from '../packages/core/src/life/bake.ts';
import { runDay } from '../packages/core/src/life/day.ts';
import { LifeRuntime } from '../packages/core/src/life/runtime.ts';
import { propsGlb } from '../packages/core/src/life/props.ts';
import { lifeJson } from '../packages/core/src/life/tools.ts';
import { alongLine } from '../packages/core/src/life/nav.ts';
import { findGodot } from '../packages/game/src/godot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const cache = fs.existsSync(path.join(ROOT, '.studio/cache/world/raleigh-city-plaza')) ? path.join(ROOT, '.studio/cache/world') : null;
if (!cache) { console.log('needs the fetched raleigh-city-plaza area (studio world-fetch, see .claude/skills/world)'); process.exit(1); }
setWorldCacheDir(cache);

// the cast (bench/life-cast.sh): eight folk on five body plans, a dog, four cars and a bus
export const CAST: CastModel[] = [
  ...['folk-ada', 'folk-bert', 'folk-dev', 'folk-esme', 'folk-faro', 'folk-gwen', 'folk-hal'].map((id) => ({ id, kind: 'person' as const, sits: true })),
  { id: 'folk-cleo', kind: 'person', sits: false, speed: [1.25, 1.5] as [number, number] },
  { id: 'dog-biscuit', kind: 'dog' },
  ...['car-red', 'car-blue', 'car-cream', 'car-green'].map((id) => ({ id, kind: 'car' as const, len: 4.25, wid: 1.78 })),
  { id: 'city-bus', kind: 'bus', len: 10.4, wid: 2.5 },
];

const t0 = Date.now();
const raleigh = buildTown({ name: 'Pocket Raleigh', source: 'real', area: 'raleigh-city-plaza', style: 'raleigh-downtown', fixes: [] }).plan;
const twin = buildTown({ name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', style: 'river-town-1920s', fixes: [] } as any).plan;
const bake = bakeLife([{ plan: raleigh }, { plan: twin, offset: [380, 0, 0] }], { seed: 1, day: 'saturday', season: 'autumn', event: 'market', start: 10.6, models: CAST });
const bakeMs = Date.now() - t0;
console.log(`bake ${bakeMs} ms`, JSON.stringify(bake.stats));

const json = lifeJson(bake, CAST, { seed: 1, day: 'saturday', season: 'autumn', event: 'market' });
const props = propsGlb(bake.props);
const runtimeTs = fs.readFileSync(path.join(ROOT, 'packages/core/src/life/runtime.ts'), 'utf8');
for (const [game, files] of [['games/pocket-raleigh', { 'studio/life.gd': 'packages/game/templates/godot/studio/life.gd', 'studio/life_view.gd': 'packages/game/templates/godot/studio/life_view.gd', 'studio/life_parity.gd': 'packages/game/templates/godot/studio/life_parity.gd' }], ['games/pocket-raleigh-web', { 'studio/lifeview.ts': 'packages/game/templates/web/studio/lifeview.ts' }]] as const) {
  const dir = path.join(ROOT, game);
  fs.mkdirSync(path.join(dir, 'assets/studio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets/studio/life.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(dir, 'assets/studio/life-props.glb'), props);
  for (const [to, from] of Object.entries(files)) fs.copyFileSync(path.join(ROOT, from), path.join(dir, to));
  if (game.endsWith('-web')) { fs.writeFileSync(path.join(dir, 'studio/life.ts'), runtimeTs); fs.writeFileSync(path.join(ROOT, 'packages/game/templates/web/studio/life.ts'), runtimeTs); }
}
console.log(`life.json ${(JSON.stringify(json).length / 1048576).toFixed(1)} MB, props ${(props.length / 1024).toFixed(0)} KB`);

// the headless day, with a scripted player along Fayetteville St and across it mid-block
const fay = raleigh.streets.find((s) => s.name === 'Fayetteville Street' && s.points.length > 20)!;
const w = fay.width / 2 + fay.sidewalk / 2;
const at = (d: number, o: number): [number, number] => { const { p, dir } = alongLine(fay.points, d); return [p[0] - dir[1] * o, p[1] + dir[0] * o]; };
const from = Number(arg('from', '9.5')) * 3600, hours = Number(arg('hours', '1'));
const day = runDay(bake, { from, to: from + hours * 3600, player: { pts: [at(30, -w), at(90, -w), at(90, w), at(30, w), at(30, -w)], speed: 1.3 } });
for (const c of day.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(32)} ${c.count} ${c.unit}${c.worst ? ` (worst ${c.worst})` : ''}`);
console.log(`day ${(from / 3600).toFixed(1)}h +${hours}h in ${(day.ms / 1000).toFixed(1)} s; peak ${day.peak.folk} folk, ${day.peak.cars} vehicles; cars braked for the player ${day.brakesForPlayer} samples`);

// D30's tripwire: Godot vs TypeScript on the same seed
let parity: any = null;
const seconds = Number(arg('parity', '120'));
const godot = process.argv.includes('--no-godot') ? null : findGodot();
if (godot) {
  const out = path.join(ROOT, 'games/pocket-raleigh/.studio-game/life-parity.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = spawnSync(godot.bin, ['--headless', '--path', path.join(ROOT, 'games/pocket-raleigh'), '--script', 'res://studio/life_parity.gd', '--', `--t0=${bake.data.start}`, `--seconds=${seconds}`, '--every=5', `--out=${out}`], { encoding: 'utf8', timeout: 1800000 });
  const G = JSON.parse(fs.readFileSync(out, 'utf8'));
  const rt = new LifeRuntime(bake.data);
  rt.init(bake.data.start, 60);
  const snaps = [rt.snapshot()];
  for (let k = 0; k < Math.round(seconds / 0.1); k++) { rt.step(); if ((k + 1) % 50 === 0) snaps.push(rt.snapshot()); }
  let worst = 0, vis = 0, n = 0;
  G.snaps.forEach((g: any, k: number) => { const a = snaps[k]; for (let i = 0; i < a.length; i += 3) { if (a[i] !== g.s[i]) { vis++; continue; } if (!a[i]) continue; n++; worst = Math.max(worst, Math.hypot(a[i + 1] - g.s[i + 1], a[i + 2] - g.s[i + 2])); } });
  parity = { seconds, snapshots: G.snaps.length, positions: n, worstMetres: worst, visibilityMismatches: vis, godotMs: G.ms, godot: godot.version, pass: worst <= 0.5 && vis === 0 };
  console.log(`parity ${parity.pass ? 'PASS' : 'FAIL'}: worst ${worst.toExponential(2)} m over ${n} positions, ${seconds} s (+60 s warm-up), visibility mismatches ${vis}; Godot ${(G.ms / 1000).toFixed(1)} s`);
  void r;
}
const report = { stats: bake.stats, bakeMs, day: { from: from / 3600, hours, ms: day.ms, peak: day.peak, byHour: day.byHour, checks: day.checks.map((c) => ({ name: c.name, pass: c.pass, count: c.count, worst: c.worst, limit: c.limit })) }, parity };
const repDir = path.join(ROOT, 'checkpoint-pocket-raleigh/life-v2');
fs.mkdirSync(repDir, { recursive: true });
fs.writeFileSync(path.join(repDir, 'life-report.json'), JSON.stringify(report, null, 2) + '\n');
if (day.checks.some((c) => !c.pass) || (parity && !parity.pass)) process.exitCode = 1;
