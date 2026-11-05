// Phase 9 weeks 15–16 proof (Decisions 56–58): the forge yard with five effects — a forge fire that
// follows a 0–1 value, sparks on the blacksmith's strike, chimney smoke, embers when charcoal goes in,
// and rain — and the UI kit (forge style, six house icons). Every effect is played in Godot and the web
// from the same review camera, measured, and put side by side; the UI kit gets its sheet and the HUD
// over the forge in both engines. Skips an engine that isn't installed.
// Run: node bench/effects.ts [outDir]   (also: npm run bench:effects)
//      FX_ONLY=rain,sparks node bench/effects.ts [outDir]   only those side-by-sides (no strike, UI tasks)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, ICON_NAMES } from '../packages/core/src/index.ts';
import { gameData } from '../packages/core/src/gamedata.ts';
import { exportGame } from '../packages/core/src/gameexport.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';
import { buildForge } from './forge.ts';

await initKernel();
const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bench-effects-out-')));
fs.mkdirSync(outDir, { recursive: true });
const studio = new Studio();
const step = (t: string, a: object) => { const r: any = studio.call(t, a); if (!r.ok) throw new Error(`${t} ${JSON.stringify(a)}: ${r.error}`); return r.result; };
buildForge(step);
// the Fire's Dying effects, placed in the yard (the fire bed is cut 10 cm into the hearth's top)
step('add-effect', { id: 'forge-fire', preset: 'forge-fire', at: [-1.9, 0.76, -1.65], value: 'fire' });
step('add-effect', { id: 'sparks', preset: 'sparks', at: [-0.02, 0.78, -0.5], triggers: [{ on: 'Blacksmith:strike@impact', layer: 'burst' }] });
step('add-effect', { id: 'chimney-smoke', preset: 'chimney-smoke', at: [-1.9, 2.78, -1.94] });
step('add-effect', { id: 'embers', preset: 'embers', at: [-1.9, 0.8, -1.65], triggers: [{ on: 'fed', layer: 'puff' }] });
step('add-effect', { id: 'rain', preset: 'rain', at: [0, 0, 0] });
step('ui-kit', { preset: 'forge' });
step('ui-icon', { names: ICON_NAMES });

const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-effects-'));
const ctx: GameContext = {
  studioDir,
  async exportGlb(out, object, engine, opts) {
    const doc = studio.doc();
    const ids = (object ? [studio.findObject(doc, object).id] : doc.objectOrder).filter((id) => !opts?.exclude?.includes(id));
    const r = await exportGame(ids.map((id) => ({ obj: doc.objects[id], res: studio.evaluate(doc.objects[id]) })), { target: engine, baker: null, evaluateOp: (o, op) => studio.evaluateOp(o, op) } as any);
    fs.writeFileSync(out, r.glb);
    return { ok: true, result: { file: out, skipped: [] } };
  },
  async gameData() { return gameData(studio); },
  async studioCall(tool, args) { const r: any = studio.call(tool, args); return { ok: r.ok, error: r.error, result: r.result }; },
};
const call = async (name: string, args: object) => {
  const r = await runGame(name, args, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error ?? ''} ${JSON.stringify(r.failures ?? r.errors ?? '')}`.slice(0, 1500));
  return r;
};
const keep = (f: string | null | undefined, name: string) => { if (!f || !fs.existsSync(f)) return null; const d = path.join(outDir, name); fs.copyFileSync(f, d); return d; };

const have = { godot: !!findGodot(), web: !!findChrome() };
const report: any = { out: outDir, engines: have, effects: {}, ui: {} };
let failed = 0;
const task = async (name: string, fn: () => Promise<string | null>) => {
  const t0 = performance.now();
  let problem: string | null;
  try { problem = await fn(); } catch (e: any) { problem = e.message; }
  console.log(`${problem ? 'FAIL' : 'pass'}  ${name}  (${((performance.now() - t0) / 1000).toFixed(1)} s)${problem ? `\n      ${problem}` : ''}`);
  if (problem) failed++;
};

for (const engine of ['godot', 'web'] as const) {
  if (!have[engine]) { console.log(`skip  ${engine} (not installed)`); continue; }
  await task(`${engine}: import the forge with effects, UI kit and lines`, async () => {
    await call('game-init', { name: `fx-${engine}`, engine });
    const r = await call('game-import', { project: `fx-${engine}`, strict: false });
    report[`${engine}Import`] = r.result.assets;
    return r.result.assets?.effects === 5 && r.result.assets?.ui ? null : `assets: ${JSON.stringify(r.result.assets)}`;
  });
}

const runs: Array<{ id: string; args: object; expect?: (r: any) => string | null }> = [
  { id: 'forge-fire', args: { value: [0.1, 1], seconds: 5 } },
  { id: 'sparks', args: { seconds: 3, events: [{ at: 0.4, burst: 'burst' }, { at: 1.3, burst: 'burst' }, { at: 2.2, burst: 'burst' }] } },
  { id: 'chimney-smoke', args: { seconds: 6 } },
  { id: 'embers', args: { seconds: 4, events: [{ at: 0.5, name: 'fed' }, { at: 2.2, name: 'fed' }] } },
  { id: 'rain', args: { seconds: 3 } },
];
const only = process.env.FX_ONLY ? process.env.FX_ONLY.split(',') : null;
if (have.godot && have.web) for (const x of runs.filter((r) => !only || only.includes(r.id))) {
  await task(`effect ${x.id}: Godot and web side by side`, async () => {
    const r = await call('game-effect', { project: 'fx-godot', id: x.id, against: 'fx-web', ...x.args });
    const g = r.result.godot, w = r.result.web;
    report.effects[x.id] = {
      parity: r.result.parity, godot: { video: keep(g.video, `${x.id}-godot.mp4`), still: keep(g.stills?.[1], `${x.id}-godot.png`), stats: g.stats, fired: g.fired },
      web: { video: keep(w.video, `${x.id}-web.mp4`), still: keep(w.stills?.[1], `${x.id}-web.png`), stats: w.stats, fired: w.fired },
      card: keep(r.result.card?.card, `${x.id}-card.png`), sideBySide: keep(r.result.card?.video, `${x.id}-side-by-side.mp4`),
      godotPeak: keep(g.peak, `${x.id}-godot-peak${path.extname(g.peak ?? '.png')}`), webPeak: keep(w.peak, `${x.id}-web-peak${path.extname(w.peak ?? '.png')}`),
    };
    const problem = x.expect?.({ godot: g, web: w }) ?? null;
    if (problem) return problem;
    if (!g.stats?.coverage || !w.stats?.coverage) return `nothing drawn: godot ${JSON.stringify(g.stats)}, web ${JSON.stringify(w.stats)}`;
    return null;
  });
}
// sparks on the strike: the blacksmith's strike clip loops and the motion trigger fires at its impact
for (const engine of ['godot', 'web'] as const) {
  if (!have[engine] || only) continue;
  await task(`${engine}: sparks fire on the blacksmith's strike (motion trigger at the impact)`, async () => {
    const r = await call('game-effect', { project: `fx-${engine}`, id: 'sparks', seconds: 4, play: [{ character: 'Blacksmith', clip: 'strike' }] });
    const n = r.result.fired?.['sparks:burst'] ?? 0;
    report.effects.sparks[`${engine}Strike`] = { video: keep(r.result.video, `sparks-on-strike-${engine}.mp4`), still: keep(r.result.peak, `sparks-on-strike-${engine}${path.extname(r.result.peak ?? '.png')}`), fired: n };
    return n >= 2 ? null : `bursts fired in 4 s of strikes: ${n} (want 2: the clip is 1.8 s)`;
  });
}
if (have.godot && !only) await task('godot: the CPU fallback draws the fire', async () => {
  const r = await call('game-effect', { project: 'fx-godot', id: 'forge-fire', value: 0.8, seconds: 3, cpu: true });
  report.effects['forge-fire'].cpuFallback = { video: keep(r.result.video, 'forge-fire-godot-cpu.mp4'), stats: r.result.stats };
  return r.result.cpu && r.result.stats?.coverage > 0 ? null : `cpu ${r.result.cpu}, stats ${JSON.stringify(r.result.stats)}`;
});

if (!only) await task('UI kit sheet: parts, HUD on a phone (pseudolocalised), icons scored', async () => {
  const r = await call('game-ui-sheet', { out: path.join(outDir, 'ui-sheet') });
  report.ui.sheet = r.result.png;
  report.ui.iconScores = r.result.scores;
  const bad = Object.entries(r.result.scores ?? {}).filter(([, s]: any) => !s.pass);
  return bad.length ? `icons: ${bad.map(([k, s]: any) => `${k} ${s.notes.join(', ')}`).join('; ')}` : null;
});
for (const engine of ['godot', 'web'] as const) {
  if (!have[engine] || only) continue;
  await task(`${engine}: the HUD and a speech bubble over the forge (whole-page capture)`, async () => {
    const r = await call('game-screenshot', { project: `fx-${engine}`, page: true, size: 1280, seconds: 1.5, values: { fire: 0.7 }, bubbles: [{ character: 'Blacksmith', text: 'Good lad. Now hold it still.' }] });
    report.ui[`${engine}Page`] = keep(r.result.images?.[0]?.file, `ui-over-forge-${engine}.png`);
    return report.ui[`${engine}Page`] ? null : `no capture: ${JSON.stringify(r).slice(0, 1200)}`;
  });
}
report.checks = step('check', {});
const fxChecks = Object.fromEntries(Object.entries(report.checks).filter(([k]) => k.startsWith('effect:') || k === 'ui'));
report.studioChecks = Object.fromEntries(Object.entries(fxChecks).map(([k, v]: any) => [k, v.map((c: any) => `${c.pass ? 'ok' : c.pending ? '..' : 'NO'} ${c.id}: ${c.detail}`)]));
delete report.checks;
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
if (process.env.BENCH_KEEP) console.log(`kept the games in ${studioDir}`); else fs.rmSync(studioDir, { recursive: true, force: true });
console.log(`\nreport: ${path.join(outDir, 'report.json')}`);
console.log(failed ? `${failed} effects/UI task(s) failed` : 'all effects/UI tasks pass');
process.exitCode = failed ? 1 : 0;
