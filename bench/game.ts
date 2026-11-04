// Reference solutions for the /game benchmark tasks (19+ in bench/TASKS.md): a studio scene goes
// into Godot and a three.js web game, round-trips cleanly, renders, and a capsule player can walk
// to the stool. Each engine's tasks skip cleanly when it isn't installed.
// Run: node bench/game.ts   (also part of `npm run bench`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, toGLB } from '../packages/core/src/index.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';

await initKernel();

function buildScene(): Studio {
  const s = new Studio();
  const step = (t: string, a: object) => { const r = s.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); };
  step('new-object', { name: 'Walnut stool', type: 'stool', material: 'walnut' });
  step('set-params', { values: { seatH: 0.45, seatT: 0.032, seatW: 0.36, legR: 0.017, legSplay: { value: 10, unit: 'deg' } } });
  step('add-op', { id: 'seat', op: 'roundedBox', part: 'seat', args: { size: ['$seatW', '$seatT', '$seatW'], r: 0.008, at: [0, '$seatH - $seatT/2', 0] } });
  step('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r1: '$legR*0.6', r2: '$legR', h: '($seatH - $seatT) / cos($legSplay) + 0.012' } });
  step('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.06, splay: '$legSplay' } });
  step('add-op', { id: 'body', op: 'union', inputs: ['seat', 'legs'], output: false });
  step('add-op', { id: 'stool', op: 'trim', inputs: ['body'], output: true });
  step('new-object', { name: 'Vase', type: 'vase', material: 'glazed-ceramic' });
  step('add-op', { id: 'body', op: 'revolve', args: { curve: true, profile: [[0, 0], [0.05, 0], [0.08, 0.09], [0.032, 0.2], [0.042, 0.24], [0.036, 0.24], [0.026, 0.2], [0.074, 0.09], [0.044, 0.006], [0, 0.006]] } });
  step('place-object', { object: 'vase', relation: 'on', target: 'walnut-stool' });
  return s;
}

const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-game-'));
const studio = buildScene();
const ctx: GameContext = {
  studioDir,
  async exportGlb(out, object) {
    const doc = studio.doc();
    const ids = object ? [studio.findObject(doc, object).id] : doc.objectOrder;
    fs.writeFileSync(out, toGLB(ids.map((id) => ({ obj: doc.objects[id], res: studio.evaluate(doc.objects[id]) }))));
    return { ok: true, result: { file: out, skipped: [] } };
  },
};

type Task = { name: string; engine: 'godot' | 'web'; run(): Promise<string | null> };
const call = async (name: string, args: object) => {
  const r = await runGame(name, args, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error ?? JSON.stringify(r.failures ?? r.errors)}`);
  return r;
};

const tasks: Task[] = [];
for (const engine of ['godot', 'web'] as const) {
  const project = `bench-${engine}`;
  tasks.push(
    {
      name: `19${engine === 'web' ? 'w' : ''}. ${engine}: make a game from the studio scene; round trip is clean`, engine,
      async run() {
        await call('game-init', { name: project, engine });
        const r = await call('game-import', { project });
        const rt = r.result.roundTrip;
        if (!(rt.triangles > 10000) || rt.warnings.length || rt.errors.length) return `round trip: ${rt.triangles} triangles, ${rt.warnings.length} warnings, ${rt.errors.length} errors`;
        if (engine === 'godot' && !rt.materials.some((m: any) => m.name === 'studio:glazed-ceramic' && m.clearcoat > 0)) return 'glaze clearcoat lost in Godot';
        return null;
      },
    },
    {
      name: `20${engine === 'web' ? 'w' : ''}. ${engine}: a player can walk up to the stool; walking through it is blocked`, engine,
      async run() {
        const ok = await call('game-walk-to', { project, target: 'Walnut stool' });
        if (!ok.result.reached) return `not reached: ${ok.summary}`;
        const blocked = await call('game-walk-to', { project, target: [0, -2], from: [0, 2], reach: 0.2, timeout: 8 });
        if (!blocked.result.blocked) return `walked through the stool: ${blocked.summary}`;
        return null;
      },
    },
    {
      name: `21${engine === 'web' ? 'w' : ''}. ${engine}: the vase rests on the stool in the game; screenshots render`, engine,
      async run() {
        const t = await call('game-test', { project, assertions: [{ kind: 'on', node: 'Vase', target: 'Walnut stool' }, { kind: 'grounded', node: 'Walnut stool' }, { kind: 'count', pattern: '*', min: 2, max: 2 }] });
        if (t.result.failed) return JSON.stringify(t.result.results);
        const shot = await call('game-screenshot', { project, views: 'iso' });
        const f = shot.result.images[0]?.file;
        return f && fs.statSync(f).size > 5000 ? null : `screenshot missing or blank: ${f}`;
      },
    },
  );
}

let failed = 0;
const have = { godot: !!findGodot(), web: !!findChrome() };
for (const t of tasks) {
  if (!have[t.engine]) { console.log(`skip  ${t.name}  (${t.engine === 'godot' ? 'Godot 4' : 'Chrome'} not installed)`); continue; }
  const t0 = performance.now();
  let problem: string | null;
  try { problem = await t.run(); } catch (e: any) { problem = e.message; }
  console.log(`${problem ? 'FAIL' : 'pass'}  ${t.name}  (${((performance.now() - t0) / 1000).toFixed(1)} s)${problem ? `\n      ${problem}` : ''}`);
  if (problem) failed++;
}
fs.rmSync(studioDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} game task(s) failed` : '\nall game reference solutions pass');
process.exitCode = failed ? 1 : 0;
