// Reference solutions for the week 7–8 tasks (33–37 in bench/TASKS.md): performances on lines, the
// motion fixes, and "The Forge Lesson" cutscene in the studio (checks) and in both engines (Godot's
// generated AnimationPlayer scene, the three.js player). Lines here are synthetic (no voice model
// needed); bench/forge-lesson.ts makes the real thing with local voices and videos.
// Run: node bench/lesson.ts   (also part of `npm run bench`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, validateGlb, curvesFromCues, cutsceneTimeline, cutsceneChecks } from '../packages/core/src/index.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';
import { buildForge } from './forge.ts';

await initKernel();
const studio = new Studio();
const ok = (t: string, a: object) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
buildForge(ok);
ok('move-object', { object: 'apprentice', position: [0.45, 0, 0.3], rotation: -146 });
const line = (o: string, id: string, text: string, dur: number, emotion: string) => {
  const cues = [{ start: 0, end: 0.15, shape: 'X' }, { start: 0.15, end: dur * 0.45, shape: 'C' }, { start: dur * 0.45, end: dur * 0.55, shape: 'X' }, { start: dur * 0.55, end: dur - 0.15, shape: 'D' }, { start: dur - 0.15, end: dur, shape: 'X' }];
  ok('set-line', { object: o, id, line: { text, audio: 'none.wav', emotion, duration: dur, fps: 30, cues, curves: curvesFromCues(cues, dur, 30), aligner: 'bench' } });
};
line('blacksmith', 'hold-still', 'Hold still. This will only take a second.', 2.6, 'firm');
line('apprentice', 'glow', 'Is it supposed to glow like that?', 2.0, 'scared');
line('blacksmith', 'perfect', 'Perfect. Now we wait for the metal to cool.', 2.8, 'gentle');

const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-lesson-'));
const ctx: GameContext = {
  studioDir,
  async exportGlb(out, object, engine, opts = {}) {
    const items = selectForExport(studio, studio.doc(), { object, exclude: opts.exclude, atOrigin: opts.atOrigin });
    const r = await exportGame(items, { target: engine, baker: null, evaluateOp: (o, id) => studio.evaluateOp(o, id) });
    const v = await validateGlb(r.glb);
    if (!v.ok) return { ok: false, error: `validator: ${v.errors} errors` };
    fs.writeFileSync(out, r.glb);
    return { ok: true, result: { file: out, skipped: [] } };
  },
  async cutscenes() {
    const d = studio.doc();
    return Object.values((d as any).cutscenes ?? {}).map((c: any) => ({ timeline: cutsceneTimeline(studio, d, c), audio: {} }));
  },
};
const call = async (name: string, args: object) => {
  const r = await runGame(name, args, ctx);
  if (!r.ok) throw new Error(`${name}: ${r.error ?? JSON.stringify(r.failures ?? r.errors)}${r.log ? `\n${r.log.join('\n')}` : ''}`);
  return r;
};
const failing = (id: string, re: RegExp) => studio.checks(id).filter((c) => re.test(c.id) && !c.pass).map((c) => `${c.label}: ${c.detail}`);

const tasks: Array<{ name: string; engine?: 'godot' | 'web'; run: () => Promise<string | null> }> = [
  {
    name: '33. perform each line: gestures on words, the free hand while the hammer is held, the face follows the emotion',
    async run() {
      ok('perform', { object: 'blacksmith', line: 'hold-still', emotion: 'firm', gestures: 'palm-down@still, point@this' });
      ok('perform', { object: 'apprentice', line: 'glow', auto: true });
      const r = ok('perform', { object: 'blacksmith', line: 'perfect', gestures: 'nod@perfect, open-palms@cool', beats: [{ word: 'perfect', emotion: 'happy' }] });
      if ((r.result as any).gestures.some((g: any) => g.hand === 'right' || g.hand === 'both')) return 'a gesture uses the hammer hand';
      const bad = [...failing('blacksmith', /^line-.*-performance$/), ...failing('apprentice', /^line-.*-performance$/)];
      return bad.length ? bad.join('; ') : null;
    },
  },
  {
    name: '34. the motion fixes: apron follows the legs, a real run, the strike winds up, start/stop steps planted',
    async run() {
      ok('set-motion', { object: 'apprentice', id: 'run', kind: 'run' });
      const bad = [...failing('blacksmith', /^motion-/), ...failing('apprentice', /^motion-/)];
      if (!studio.checks('blacksmith').some((c) => c.id === 'motion-walk-apron' && c.pass)) bad.push('no apron check on the walk');
      return bad.length ? bad.join('; ') : null;
    },
  },
  {
    name: '35. "The Forge Lesson": four shots (wide strike, medium, over-shoulder, close); speakers in frame, cuts between words, 180° rule',
    async run() {
      ok('new-cutscene', { id: 'forge-lesson', title: 'The Forge Lesson' });
      ok('set-shot', { cutscene: 'forge-lesson', id: 'strike', camera: { framing: 'wide', move: 'push-in' }, actions: [{ character: 'blacksmith', motion: 'strike', at: 0.4 }], duration: 2.8 });
      ok('set-shot', { cutscene: 'forge-lesson', id: 'hold-still', camera: { framing: 'medium', subject: 'blacksmith', move: 'push-in' }, lines: [{ character: 'blacksmith', line: 'hold-still', to: 'apprentice', at: 0.3 }] });
      ok('set-shot', { cutscene: 'forge-lesson', id: 'glow', camera: { framing: 'over-shoulder', subject: 'apprentice', over: 'blacksmith' }, lines: [{ character: 'apprentice', line: 'glow', to: 'blacksmith' }] });
      ok('set-shot', { cutscene: 'forge-lesson', id: 'perfect', camera: { framing: 'close', subject: 'blacksmith', move: 'push-in' }, lines: [{ character: 'blacksmith', line: 'perfect', to: 'apprentice' }] });
      const doc = studio.doc();
      const bad = cutsceneChecks(studio, doc, (doc as any).cutscenes['forge-lesson']).filter((c) => !c.pass).map((c) => c.detail);
      const tl = cutsceneTimeline(studio, doc, (doc as any).cutscenes['forge-lesson']);
      if (tl.shots.length !== 4 || tl.cues.length !== 4) bad.push(`timeline: ${tl.shots.length} shots, ${tl.cues.length} cues`);
      return bad.length ? bad.join('; ') : null;
    },
  },
];
for (const engine of ['godot', 'web'] as const) {
  const project = `lesson-${engine}`;
  tasks.push({
    name: `36${engine === 'godot' ? 'g' : 'w'}. ${engine}: game import writes the cutscene${engine === 'godot' ? ' (a generated AnimationPlayer scene)' : ''}; it plays to the end with every clip found`, engine,
    async run() {
      await call('game-init', { name: project, engine });
      const imp = await call('game-import', { project });
      const files: string[] = imp.result.cutscenes ?? [];
      if (!files.some((f) => f.endsWith('forge-lesson.json'))) return `no cutscene written: ${JSON.stringify(files)}`;
      if (engine === 'godot' && !files.some((f) => f.endsWith('forge-lesson.tscn'))) return 'no Godot cutscene scene';
      const r = await call('game-cutscene', { project, id: 'forge-lesson' });
      const warn = [...(r.warnings ?? []), ...(r.result?.warnings ?? [])].filter((w: string) => /cutscene|clip|character/.test(w));
      if (warn.length) return warn.join('; ');
      if (!(r.result.seconds > 10)) return `played ${r.result.seconds} s`;
      return null;
    },
  });
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
fs.rmSync(studioDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} lesson task(s) failed` : '\nall lesson reference solutions pass');
process.exitCode = failed ? 1 : 0;
