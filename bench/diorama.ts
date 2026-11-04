// Reference solutions for the week 5–6 tasks (29–31 in bench/TASKS.md): the forge yard (bench/forge.ts)
// as a playable diorama in Godot and in a three.js web game. The apprentice is the player — the kit
// character itself, walking at its walk clip's speed and idling when it stops — and walks up to the
// anvil; the blacksmith stands by the forge playing his idle with the hammer in his hand; props block
// the way. Each engine's tasks skip cleanly when it isn't installed.
// Run: node bench/diorama.ts   (also part of `npm run bench`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, validateGlb } from '../packages/core/src/index.ts';
import { bakeMotion, motionReport } from '../packages/core/src/motion.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';
import { buildForge } from './forge.ts';

await initKernel();
const studio = new Studio();
buildForge((t, a) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; });

const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-diorama-'));
const ctx: GameContext = {
  studioDir,
  async exportGlb(out, object, engine, opts = {}) {
    const doc = studio.doc();
    const items = selectForExport(studio, doc, { object, exclude: opts.exclude, atOrigin: opts.atOrigin });
    const r = await exportGame(items, { target: engine, baker: null, evaluateOp: (o, id) => studio.evaluateOp(o, id) });
    const v = await validateGlb(r.glb);
    if (!v.ok) return { ok: false, error: `validator: ${v.errors} errors` };
    fs.writeFileSync(out, r.glb);
    return { ok: true, result: { file: out, skipped: [] } };
  },
  async objectInfo(ref) {
    const doc = studio.doc();
    try { const o = studio.findObject(doc, ref); return { id: o.id, name: o.name, position: o.position, rotation: o.rotation ?? 0, character: o.semanticType === 'character' }; } catch { return null; }
  },
};
const call = async (name: string, args: object) => {
  const r = await runGame(name, args, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error ?? JSON.stringify(r.failures ?? r.errors)}${r.log ? `\n${r.log.join('\n')}` : ''}`);
  return r;
};

type Task = { name: string; engine: 'godot' | 'web' | null; run(): Promise<string | null> };
const tasks: Task[] = [
  {
    name: '31. the forge yard: every prop and character check green; every motion plants its feet and bends cleanly', engine: null,
    async run() {
      const doc = studio.doc();
      const bad = doc.objectOrder.flatMap((id) => studio.checks(id).filter((c) => !c.pass && !c.pending).map((c) => `${doc.objects[id].name}: ${c.label} — ${c.detail}`));
      if (bad.length) return bad.join('\n      ');
      for (const id of ['blacksmith', 'apprentice']) {
        const o = doc.objects[id], rig = studio.evaluate(o).rig!.rig;
        for (const [mid, spec] of Object.entries(o.character!.motions!)) {
          const r = motionReport(rig, bakeMotion(mid, spec, rig, o.character));
          if (!r.pass) return `${o.name} ${mid}: ${r.detail}`;
        }
      }
      const props = doc.objectOrder.filter((id) => doc.objects[id].semanticType !== 'character' && doc.objects[id].place?.kind !== 'held');
      const noCollision = props.filter((id) => !doc.objects[id].opOrder.some((k) => doc.objects[id].ops[k].op === 'collision'));
      return props.length >= 10 && !noCollision.length ? null : `${props.length} props; without collision: ${noCollision.join(', ')}`;
    },
  },
];
for (const engine of ['godot', 'web'] as const) {
  const project = `forge-${engine}`;
  const w = engine === 'web' ? 'w' : '';
  tasks.push(
    {
      name: `29${w}. ${engine}: the forge yard as a game, the apprentice as the player; round trip clean, clips and capsules in`, engine,
      async run() {
        await call('game-init', { name: project, engine });
        const r = await call('game-import', { project, player: 'Apprentice' });
        const rt = r.result.roundTrip;
        if (rt.warnings.length || rt.errors.length) return `round trip: ${rt.warnings.length} warnings, ${rt.errors.length} errors: ${[...rt.errors, ...rt.warnings].slice(0, 3).join('; ')}`;
        const man = JSON.parse(fs.readFileSync(path.join(studioDir, 'games', project, 'assets', 'studio', 'characters.json'), 'utf8'));
        if (man.player?.name !== 'Apprentice' || !man.player.clips.walk?.loop || !(man.player.walkSpeed > 1)) return `player manifest: ${JSON.stringify(man.player)?.slice(0, 200)}`;
        const smith = man.characters.find((c: any) => c.name === 'Blacksmith');
        if (!smith || smith.play !== 'idle' || !smith.clips.strike) return `blacksmith: ${JSON.stringify(smith)?.slice(0, 200)}`;
        if (man.characters.some((c: any) => c.name === 'Apprentice')) return 'the player is also in the scene';
        if (engine === 'godot' && !(rt.characters ?? []).length) return 'no character capsule in Godot';
        if (engine === 'godot' && !(rt.player?.animations > 1)) return `player clips in Godot: ${JSON.stringify(rt.player)}`;
        return null;
      },
    },
    {
      name: `30${w}. ${engine}: the apprentice walks (walk clip, its speed) up to the anvil; walking through the forge is blocked`, engine,
      async run() {
        const ok = await call('game-walk-to', { project, target: 'Anvil', reach: 0.5 });
        if (!ok.result.reached) return `not reached: ${ok.summary}`;
        if (ok.result.player !== 'Apprentice') return `walked as ${ok.result.player}, not the apprentice`;
        if (!(ok.result.speed > 1)) return `speed ${ok.result.speed}`;
        const blocked = await call('game-walk-to', { project, target: [-1.9, -3.2], from: [-1.9, 0.2], reach: 0.2, timeout: 8 });
        if (!blocked.result.blocked) return `walked through the forge: ${blocked.summary}`;
        return null;
      },
    },
  );
}

let failed = 0;
const have = { godot: !!findGodot(), web: !!findChrome() };
for (const t of tasks) {
  if (t.engine && !have[t.engine]) { console.log(`skip  ${t.name}  (${t.engine === 'godot' ? 'Godot 4' : 'Chrome'} not installed)`); continue; }
  const t0 = performance.now();
  let problem: string | null;
  try { problem = await t.run(); } catch (e: any) { problem = e.message; }
  console.log(`${problem ? 'FAIL' : 'pass'}  ${t.name}  (${((performance.now() - t0) / 1000).toFixed(1)} s)${problem ? `\n      ${problem}` : ''}`);
  if (problem) failed++;
}
if (process.env.KEEP_DIORAMA) console.log(`games kept in ${studioDir}/games`); else fs.rmSync(studioDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} diorama task(s) failed` : '\nall diorama reference solutions pass');
process.exitCode = failed ? 1 : 0;
