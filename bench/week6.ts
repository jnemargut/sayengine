// Week 5–6 artefacts: the forge yard (bench/forge.ts) built in-process, then
//   • motion previews of the blacksmith and the apprentice (MP4 + two stills per motion), and
//   • the apprentice walking up to the anvil in Godot and in the three.js web game (MP4 + stills),
// all written to checkpoint-week6/. Run: node bench/week6.ts  (about two minutes; needs Chrome,
// Godot for the Godot walk, and ffmpeg for the MP4s)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, toGLB, validateGlb } from '../packages/core/src/index.ts';
import { bakeMotion } from '../packages/core/src/motion.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';
import { buildMotionPreview, captureMotionVideo, showTime } from '../packages/daemon/src/motionplayer/make.ts';
import { buildForge } from './forge.ts';

const OUT = path.resolve(import.meta.dirname, '..', 'checkpoint-week6');
fs.mkdirSync(OUT, { recursive: true });
await initKernel();
const studio = new Studio();
buildForge((t, a) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; });
const doc = studio.doc();
const log = (s: string) => console.log(s);

// 1. motion previews (the character alone at the origin, with what it holds)
for (const [id, extra] of [['blacksmith', null], ['apprentice', { run: { kind: 'run' }, 'turn-left': { kind: 'turn', turn: 90 }, 'look-around': { kind: 'action', action: 'look-around' } }]] as const) {
  const o = doc.objects[id];
  const solo = { ...o, character: { ...o.character, motions: { ...o.character!.motions, ...(extra ?? {}) } } };
  const sdoc = { ...doc, objects: { ...doc.objects, [id]: solo as any } };
  const items = selectForExport(studio, sdoc, { object: id, atOrigin: true });
  const glb = toGLB(items, {});
  if (!(await validateGlb(glb)).ok) throw new Error(`${id}: GLB does not validate`);
  const rig = items[0].res.rig!.rig;
  const motions = Object.entries(solo.character!.motions!).map(([mid, spec]: [string, any]) => {
    const c = bakeMotion(mid, spec, rig, solo.character);
    const what = spec.kind === 'action' ? spec.action : spec.kind;
    return { id: mid, kind: spec.kind, label: `${o.name}: ${mid}${mid === what ? '' : ` (${what})`}${c.speed ? `, ${c.speed.toFixed(2)} m/s` : ''}`, duration: c.duration, loop: c.loop, speed: c.speed, show: showTime(c) };
  });
  const dir = path.join(os.tmpdir(), `week6-${id}-motions`);
  fs.rmSync(dir, { recursive: true, force: true });
  await buildMotionPreview(dir, o.name, glb, motions);
  const r = await captureMotionVideo(dir, motions);
  if (r.video) fs.copyFileSync(r.video, path.join(OUT, `motions-${id}.mp4`));
  fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
  for (const st of r.stills ?? []) fs.copyFileSync(st, path.join(OUT, 'stills', `${id}-${path.basename(st)}`));
  log(`motions: ${o.name} — ${motions.map((m) => m.id).join(', ')} (${r.seconds} s)`);
}

// 2. the diorama in both engines: the apprentice walks up to the anvil
const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'week6-games-'));
const ctx: GameContext = {
  studioDir,
  async exportGlb(out, object, engine, opts = {}) {
    const items = selectForExport(studio, studio.doc(), { object, exclude: opts.exclude, atOrigin: opts.atOrigin });
    const r = await exportGame(items, { target: engine, baker: null, evaluateOp: (o, i) => studio.evaluateOp(o, i) });
    fs.writeFileSync(out, r.glb);
    return { ok: true, result: { file: out, skipped: [] } };
  },
  async objectInfo(ref) { try { const o = studio.findObject(studio.doc(), ref); return { id: o.id, name: o.name, position: o.position, rotation: o.rotation ?? 0, character: o.semanticType === 'character' }; } catch { return null; } },
};
const have = { godot: !!findGodot(), web: !!findChrome() };
for (const engine of ['godot', 'web'] as const) {
  if (!have[engine]) { log(`skip ${engine}: not installed`); continue; }
  const project = `forge-${engine}`;
  for (const [cmd, args] of [['game-init', { name: project, engine }], ['game-import', { project, player: 'Apprentice' }]] as const) {
    const r = await runGame(cmd, args, ctx);
    if (!r.ok) throw new Error(`${engine} ${cmd}: ${r.error} ${JSON.stringify(r.failures ?? r.errors ?? '').slice(0, 400)}`);
  }
  const shot = await runGame('game-screenshot', { project, views: 'iso', size: 1280 }, ctx);
  if (shot.ok) fs.copyFileSync(shot.result.images[0].file, path.join(OUT, 'stills', `yard-${engine}${path.extname(shot.result.images[0].file)}`));
  const w = await runGame('game-walk-to', { project, target: 'Anvil', reach: 0.5, video: true }, ctx);
  if (!w.ok) throw new Error(`${engine} walk: ${w.error}`);
  if (w.result.video) fs.copyFileSync(w.result.video, path.join(OUT, `walk-${engine}.mp4`));
  (w.result.stills ?? []).forEach((st: string, i: number) => fs.copyFileSync(st, path.join(OUT, 'stills', `walk-${engine}-${i + 1}${path.extname(st)}`)));
  log(`${engine}: ${w.summary} as ${w.result.player} at ${w.result.speed} m/s → walk-${engine}.mp4`);
}
fs.rmSync(studioDir, { recursive: true, force: true });
log(`artefacts in ${OUT}`);
