// Phase 3 week 8 milestone (Decision 25): "The Forge Lesson" — two characters, four shots, three lines
// in local voices (Kokoro), each line performed with the whole body (Decision 23), played from one
// studio cutscene file (Decision 24) by the three.js player and by a generated Godot scene. Also the
// week 7–8 motion fixes (apron, run, strike, start/stop steps) as previews. Writes checkpoint-week8/.
// Run: node bench/forge-lesson.ts  (a few minutes; needs Chrome, Godot, ffmpeg and the local voice)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, toGLB, validateGlb, cutsceneTimeline, cutsceneChecks } from '../packages/core/src/index.ts';
import { bakeMotion } from '../packages/core/src/motion.ts';
import { curvesFromCues, curvesFromVisemeCues, syncOffset, restInSilence } from '../packages/core/src/lipsync.ts';
import { alignPhonemes, ipaTokens, phonemeVisemeCues } from '../packages/core/src/phonemes.ts';
import * as voice from '../packages/daemon/src/voice.ts';
import { runGame, findGodot, findChrome, type GameContext } from '../packages/game/src/index.ts';
import { openView } from './viewbench.ts';
import { buildForge } from './forge.ts';

const OUT = process.env.FORGE_OUT ? path.resolve(process.env.FORGE_OUT) : path.resolve(import.meta.dirname, '..', 'checkpoint-week8');   // Phase 7 recast: FORGE_OUT=checkpoint-phase7/forge-lesson
const only = process.argv.slice(2);
const want = (k: string) => !only.length || only.includes(k);
fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
await initKernel();
const studio = new Studio();
const ok = (t: string, a: object) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
const log = (s: string) => console.log(s);

export async function buildLesson(call: typeof ok, putAudio: (wav: Uint8Array) => string) {
  buildForge(call);
  // the apprentice comes in to watch, facing the blacksmith across the anvil
  call('move-object', { object: 'apprentice', position: [0.45, 0, 0.3], rotation: -146 });
  // the voices: local text-to-speech (Kokoro-82M), aligned with the script (Rhubarb + eSpeak NG phonemes)
  const say = async (object: string, id: string, text: string, voiceName: string, emotion: string) => {
    const wav = await voice.speak(text, voiceName);
    const audio = putAudio(wav);
    const tmp = path.join(os.tmpdir(), `lesson-${id}.wav`);
    fs.writeFileSync(tmp, wav);
    const al = await voice.align(tmp, text);
    const energy = voice.loudness(wav, 100);
    const cues = restInSilence(al.cues, energy, 100);
    const ipa = await voice.phonemize(text);
    const phonemes = ipa ? alignPhonemes(ipaTokens(ipa), cues, al.duration) : [];
    const curves = phonemes.length ? curvesFromVisemeCues(phonemeVisemeCues(phonemes, al.duration), al.duration, 30, emotion) : curvesFromCues(cues, al.duration, 30, emotion);
    const line = { text, audio, voice: voiceName, voiceLicence: 'Kokoro-82M, Apache-2.0', emotion, duration: +al.duration.toFixed(3), fps: 30, cues, curves, ...(phonemes.length ? { phonemes: phonemes.map(({ mix: _m, ...p }: any) => p) } : {}), aligner: 'rhubarb-1.14.0 + espeak-ng phonemes', sync: syncOffset(curves, 30, energy, 100) };
    call('set-line', { object, id, line });
  };
  await say('blacksmith', 'hold-still', 'Hold still. This will only take a second.', 'bm_george', 'firm');
  await say('apprentice', 'glow', 'Is it supposed to glow like that?', 'bm_lewis', 'scared');
  await say('blacksmith', 'perfect', 'Perfect. Now we wait for the metal to cool.', 'bm_george', 'gentle');
  // one performance per line: emotion, posture, gestures on words (the hammer hand stays on the hammer)
  call('perform', { object: 'blacksmith', line: 'hold-still', emotion: 'firm', gestures: 'palm-down@still, point@this' });
  call('perform', { object: 'apprentice', line: 'glow', emotion: 'scared', posture: 'guarded', gestures: 'point@glow*0.8, shrug@that*0.7' });
  call('perform', { object: 'blacksmith', line: 'perfect', emotion: 'gentle', gestures: 'nod@perfect, open-palms@cool*0.8', beats: [{ word: 'perfect', emotion: 'happy', intensity: 0.8 }, { word: 'now', emotion: 'gentle' }] });
  // the cutscene: an establishing wide on the strike, then the exchange
  call('new-cutscene', { id: 'forge-lesson', title: 'The Forge Lesson' });
  call('set-shot', { cutscene: 'forge-lesson', id: 'strike', camera: { framing: 'wide', move: 'push-in' }, actions: [{ character: 'blacksmith', motion: 'strike', at: 0.4 }], duration: 2.8 });
  call('set-shot', { cutscene: 'forge-lesson', id: 'hold-still', camera: { framing: 'medium', subject: 'blacksmith', move: 'push-in' }, lines: [{ character: 'blacksmith', line: 'hold-still', to: 'apprentice', at: 0.3 }] });
  call('set-shot', { cutscene: 'forge-lesson', id: 'glow', camera: { framing: 'over-shoulder', subject: 'apprentice', over: 'blacksmith' }, lines: [{ character: 'apprentice', line: 'glow', to: 'blacksmith', at: 0.25 }] });
  call('set-shot', { cutscene: 'forge-lesson', id: 'perfect', camera: { framing: 'close', subject: 'blacksmith', move: 'push-in' }, lines: [{ character: 'blacksmith', line: 'perfect', to: 'apprentice', at: 0.35 }] });
}

await buildLesson(ok, (wav) => studio.assets.put(wav, 'wav'));
const doc = studio.doc();
const cs = (doc as any).cutscenes['forge-lesson'];
const tl = cutsceneTimeline(studio, doc, cs);
const checks = [...cutsceneChecks(studio, doc, cs), ...['blacksmith', 'apprentice'].flatMap((id) => studio.checks(id, doc).filter((c) => /^(line-|motion-)/.test(c.id)))];
for (const c of checks) log(`${c.pass ? 'PASS' : 'FAIL'} ${c.label}: ${c.detail}`);
fs.writeFileSync(path.join(OUT, 'cutscene.json'), JSON.stringify(tl, null, 2));
fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));

// 1. the studio's preview (three.js player, the same one web games use): storyboard + MP4 with the voices
if (want('preview')) {
  // the cutscene on the live view's timeline (shot clock, shot markers, voice waveforms), captured headless
  const dir = path.join(os.tmpdir(), 'forge-lesson-preview');
  fs.rmSync(dir, { recursive: true, force: true });
  const view = await openView(studio);
  const r = (await view.call('cutscene-preview', { id: 'forge-lesson', video: true, out: dir })).result;
  view.close();
  if (r.video) fs.copyFileSync(r.video, path.join(OUT, 'forge-lesson-preview.mp4'));
  fs.mkdirSync(path.join(OUT, 'storyboard'), { recursive: true });
  for (const st of r.stills ?? []) fs.copyFileSync(st, path.join(OUT, 'storyboard', path.basename(st)));
  fs.copyFileSync(r.storyboard, path.join(OUT, 'storyboard.html'));
  log(`preview: ${tl.shots.length} shots, ${tl.duration} s → forge-lesson-preview.mp4, storyboard.html (from the live view)`);
}

// 2. both engines: game import writes the cutscene (Godot: a generated AnimationPlayer scene), then play it
if (want('games')) {
  const studioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lesson-games-'));
  const ctx: GameContext = {
    studioDir,
    async exportGlb(out, object, engine, opts = {}) {
      const items = selectForExport(studio, studio.doc(), { object, exclude: opts.exclude, atOrigin: opts.atOrigin });
      const r = await exportGame(items, { target: engine, baker: null, evaluateOp: (o, i) => studio.evaluateOp(o, i) });
      fs.writeFileSync(out, r.glb);
      return { ok: true, result: { file: out, skipped: [] } };
    },
    async objectInfo(ref) { try { const o = studio.findObject(studio.doc(), ref); return { id: o.id, name: o.name, position: o.position, rotation: o.rotation ?? 0, character: o.semanticType === 'character' }; } catch { return null; } },
    async cutscenes() {
      const d = studio.doc();
      return Object.values((d as any).cutscenes ?? {}).map((c: any) => {
        const timeline = cutsceneTimeline(studio, d, c);
        return { timeline, audio: Object.fromEntries(timeline.cues.filter((q) => q.audio).map((q) => [q.audio!, Buffer.from(studio.assets.get(q.audio!)).toString('base64')])) };
      });
    },
  };
  const have = { godot: !!findGodot(), web: !!findChrome() };
  for (const engine of ['godot', 'web'] as const) {
    if (!have[engine]) { log(`skip ${engine}: not installed`); continue; }
    const project = `lesson-${engine}`;
    for (const [cmd, args] of [['game-init', { name: project, engine }], ['game-import', { project }]] as const) {
      const r = await runGame(cmd, args, ctx);
      if (!r.ok) throw new Error(`${engine} ${cmd}: ${r.error} ${JSON.stringify(r.failures ?? r.errors ?? '').slice(0, 600)}`);
    }
    const r = await runGame('game-cutscene', { project, id: 'forge-lesson', video: true }, ctx);
    if (!r.ok) throw new Error(`${engine} cutscene: ${r.error} ${JSON.stringify(r.errors ?? r.log ?? '').slice(0, 800)}`);
    if (r.result.video) fs.copyFileSync(r.result.video, path.join(OUT, `forge-lesson-${engine}.mp4`));
    (r.result.stills ?? []).forEach((st: string) => fs.copyFileSync(st, path.join(OUT, 'stills', `${engine}-${path.basename(st).replace(/^.*-forge-lesson-/, '')}`)));
    log(`${engine}: ${r.summary}${r.warnings?.length ? ` (warnings: ${r.warnings.join('; ')})` : ''}`);
    // start and stop steps in the game: the apprentice as the player walks to the anvil
    if (want('walk')) {
      const imp = await runGame('game-import', { project, player: 'Apprentice' }, ctx);
      if (!imp.ok) throw new Error(`${engine} import with player: ${imp.error}`);
      const w = await runGame('game-walk-to', { project, target: 'Anvil', from: [0.6, 3.2], reach: 0.5, video: true }, ctx);
      if (!w.ok) throw new Error(`${engine} walk: ${w.error}`);
      if (w.result.video) fs.copyFileSync(w.result.video, path.join(OUT, `walk-start-stop-${engine}.mp4`));
      (w.result.stills ?? []).forEach((st: string, i: number) => fs.copyFileSync(st, path.join(OUT, 'stills', `walk-${engine}-${i + 1}${path.extname(st)}`)));
      log(`${engine} walk: ${w.summary}`);
    }
  }
  fs.rmSync(studioDir, { recursive: true, force: true });
}

// 3. the motion fixes: apron (walk), the run, the hammer strike, start/stop steps
if (want('motions')) {
  const view = await openView(studio);
  for (const [id, extra] of [['blacksmith', { walk: { kind: 'walk' }, strike: undefined }], ['apprentice', { run: { kind: 'run' }, sprint: { kind: 'run', speed: 6 }, start: undefined, stop: undefined }]] as const) {
    for (const [k, v] of Object.entries(extra)) if (v) ok('set-motion', { object: id, id: k, ...v });
    const dir = path.join(os.tmpdir(), `week8-${id}-motions`);
    fs.rmSync(dir, { recursive: true, force: true });
    const r = (await view.call('motion-preview', { object: id, motions: Object.keys(extra).join(','), video: true, out: dir })).result;
    if (r.video) fs.copyFileSync(r.video, path.join(OUT, `motions-${id}.mp4`));
    for (const st of r.stills ?? []) fs.copyFileSync(st, path.join(OUT, 'stills', `${id}-${path.basename(st)}`));
    log(`motions: ${doc.objects[id].name} — ${r.segments.join(', ')}`);
  }
  view.close();
}
log(`artefacts in ${OUT}`);
