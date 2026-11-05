// Fire's Dying: build the game's studio assets and import them into this web game.
// The forge yard (bench/forge.ts) plus a tool shelf, a charcoal sack, a water bucket, the big hammer,
// a file and the blade on the anvil; the blacksmith's voiced calls (local Kokoro voice, lip-synced and
// performed); a short intro cutscene. Then `game import` with the apprentice as the player.
// Run from the repo root: node games/fires-dying/build-assets.ts   (a few minutes: voices + export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, cutsceneTimeline } from '../../packages/core/src/index.ts';
import { curvesFromCues, curvesFromVisemeCues, syncOffset, restInSilence } from '../../packages/core/src/lipsync.ts';
import { alignPhonemes, ipaTokens, phonemeVisemeCues } from '../../packages/core/src/phonemes.ts';
import * as voice from '../../packages/daemon/src/voice.ts';
import { runGame, type GameContext } from '../../packages/game/src/index.ts';
import { buildForge } from '../../bench/forge.ts';
import { CALLS, LINES } from './src/lines.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GAME = path.resolve(import.meta.dirname);
const log = (s: string) => console.log(s);

await initKernel();
const studio = new Studio();
const ok = (t: string, a: object) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t} ${JSON.stringify(a).slice(0, 200)}: ${r.error}`); return r; };

buildForge(ok);

// props: one studio object per fetchable thing, small, game-ready (no collision on hand-held items)
const prop = (name: string, type: string, material: string, color: string | null, ops: Array<Record<string, unknown>>, at: [number, number, number], opts: { rotation?: number; collision?: string } = {}) => {
  ok('new-object', { name, type, material, ...(color ? { color } : {}), position: at });
  for (const o of ops) ok('add-op', o);
  if (opts.rotation) ok('move-object', { position: at, rotation: opts.rotation });
  ok('set-profile', { profile: 'godot-desktop' });
  if (opts.collision) {
    const out = (ops.find((o) => o.output === true) ?? ops[ops.length - 1]).id;
    ok('add-op', { id: 'collision', op: 'collision', inputs: [out], args: { shape: opts.collision } });
  }
};

// a tool shelf on the left, by the coal heap: two boards on two sides, against the yard's left edge
prop('Tool shelf', 'shelf', 'oak', '#7a5536', [
  { id: 'side', op: 'box', part: 'side', output: false, args: { size: [0.04, 1.1, 0.36], at: [-0.38, 0.55, 0] } },
  { id: 'sides', op: 'array', inputs: ['side'], output: false, args: { count: 2, step: [0.76, 0, 0] } },
  { id: 'board', op: 'box', part: 'board', output: false, args: { size: [0.8, 0.035, 0.36], at: [0, 0.5, 0] } },
  { id: 'board2', op: 'box', part: 'board', output: false, args: { size: [0.8, 0.035, 0.36], at: [0, 1.0, 0] } },
  { id: 'shelf', op: 'union', inputs: ['sides', 'board', 'board2'], output: true },
], [-3.15, 0, 1.25], { rotation: 90, collision: 'box' });
// the tongs (on the shelf's top board) and the file (on its lower board)
prop('Tongs', 'tool', 'black-metal', null, [
  { id: 'jawA', op: 'box', part: 'tongs', output: false, args: { size: [0.42, 0.018, 0.02], at: [0, 0.009, -0.012] } },
  { id: 'jawB', op: 'box', part: 'tongs', output: false, args: { size: [0.42, 0.018, 0.02], at: [0.01, 0.009, 0.012] } },
  { id: 'pin', op: 'cylinder', part: 'tongs', output: false, args: { r: 0.016, h: 0.03, at: [0.1, 0, 0] } },
  { id: 'tongs', op: 'union', inputs: ['jawA', 'jawB', 'pin'], output: true },
], [-3.1, 1.018, 1.25], { rotation: 90, collision: 'hull' });
prop('File', 'tool', 'black-metal', null, [
  { id: 'blade', op: 'box', part: 'file', output: false, args: { size: [0.24, 0.012, 0.03], at: [0.06, 0.006, 0] } },
  { id: 'grip', op: 'cylinder', part: 'grip', output: false, args: { r: 0.018, h: 0.12 } },
  { id: 'gripLaid', op: 'rotate', inputs: ['grip'], output: false, args: { deg: [0, 0, 90] } },
  { id: 'gripAt', op: 'translate', inputs: ['gripLaid'], output: false, args: { by: [-0.06, 0.018, 0] } },
  { id: 'file', op: 'union', inputs: ['blade', 'gripAt'], output: true },
], [-3.1, 0.518, 1.25], { rotation: 90, collision: 'hull' });
ok('set-material', { object: 'file', part: 'grip', preset: 'oak' });
// the charcoal sack by the coal heap
prop('Charcoal sack', 'prop', 'linen', '#4a4038', [
  { id: 'body', op: 'roundedBox', part: 'sack', output: false, args: { size: [0.42, 0.5, 0.32], r: 0.08, at: [0, 0.25, 0] } },
  { id: 'neck', op: 'cylinder', part: 'neck', output: false, args: { r1: 0.1, r2: 0.06, h: 0.12, at: [0, 0.48, 0] } },
  { id: 'sack', op: 'union', inputs: ['body', 'neck'], output: true },
], [-2.2, 0, 0.9], { collision: 'hull' });
// the water bucket by the barrel
prop('Water bucket', 'prop', 'oak', '#8b6a48', [
  { id: 'pail', op: 'revolve', part: 'bucket', output: false, args: { profile: [[0, 0], [0.15, 0], [0.18, 0.3], [0.165, 0.3], [0.135, 0.02], [0, 0.02]] } },
  { id: 'water', op: 'cylinder', part: 'water', output: false, args: { r1: 0.15, r2: 0.165, h: 0.22, at: [0, 0.01, 0] } },
  { id: 'bucket', op: 'union', inputs: ['pail', 'water'], output: true },
], [1.85, 0, 0.75], { collision: 'hull' });
ok('set-material', { object: 'water-bucket', part: 'water', preset: 'glass', color: '#5f8fb0' });
// the big hammer, on the workbench
prop('Big hammer', 'tool', 'oak', null, [
  { id: 'handle', op: 'cylinder', part: 'handle', output: false, args: { r: 0.02, h: 0.62 } },
  { id: 'handleLaid', op: 'rotate', inputs: ['handle'], output: false, args: { deg: [0, 0, 90] } },
  { id: 'handleAt', op: 'translate', inputs: ['handleLaid'], output: false, args: { by: [0.31, 0.02, 0] } },
  { id: 'head', op: 'box', part: 'head', output: false, args: { size: [0.07, 0.07, 0.17], at: [0.02, 0.035, 0] } },
  { id: 'bighammer', op: 'union', inputs: ['handleAt', 'head'], output: true },
], [1.8, 0.85, -1.55], { rotation: 15, collision: 'hull' });
ok('set-material', { object: 'big-hammer', part: 'head', preset: 'black-metal' });
// the blade on the anvil (the work)
prop('Blade', 'tool', 'black-metal', '#3a3530', [
  { id: 'blade', op: 'extrude', part: 'blade', args: { profile: [[-0.2, -0.018], [0.14, -0.018], [0.2, 0], [0.14, 0.018], [-0.2, 0.018]], h: 0.012 } },
], [-0.04, 0.776, -0.5], { collision: 'hull' });

// the apprentice stands by the yard's open side; pick-up for fetching
ok('set-motion', { object: 'apprentice', id: 'pickup', kind: 'action', action: 'pick-up' });

// the blacksmith's voice: local Kokoro (bm_george), aligned and performed (whole body)
const voiceDir = path.join(GAME, 'assets', 'voice');
fs.mkdirSync(voiceDir, { recursive: true });
const say = async (object: string, id: string, text: string, voiceName: string, emotion: string, gestures?: string) => {
  const wav = await voice.speak(text, voiceName);
  const audio = studio.assets.put(wav, 'wav');
  fs.writeFileSync(path.join(voiceDir, `${id}.wav`), wav);
  const tmp = path.join(os.tmpdir(), `fires-${id}.wav`);
  fs.writeFileSync(tmp, wav);
  const al = await voice.align(tmp, text);
  const energy = voice.loudness(wav, 100);
  const cues = restInSilence(al.cues, energy, 100);
  const ipa = await voice.phonemize(text);
  const phonemes = ipa ? alignPhonemes(ipaTokens(ipa), cues, al.duration) : [];
  const curves = phonemes.length ? curvesFromVisemeCues(phonemeVisemeCues(phonemes, al.duration), al.duration, 30, emotion) : curvesFromCues(cues, al.duration, 30, emotion);
  ok('set-line', { object, id, line: { text, audio, voice: voiceName, voiceLicence: 'Kokoro-82M, Apache-2.0', emotion, duration: +al.duration.toFixed(3), fps: 30, cues, curves, ...(phonemes.length ? { phonemes: phonemes.map(({ mix: _m, ...p }: any) => p) } : {}), aligner: 'rhubarb-1.14.0 + espeak-ng phonemes', sync: syncOffset(curves, 30, energy, 100) } });
  ok('perform', { object, line: id, emotion, ...(gestures ? { gestures } : { auto: true }) });
  log(`line ${id}: "${text}" ${al.duration.toFixed(2)} s`);
};
for (const l of [...Object.values(CALLS), ...Object.values(LINES)]) await say('blacksmith', l.id, l.text, 'bm_george', l.emotion, l.gestures);

// the intro: a wide on the strike, then the smith turns to the apprentice and sets the job
ok('new-cutscene', { id: 'intro', title: "Fire's Dying" });
ok('set-shot', { cutscene: 'intro', id: 'strike', camera: { framing: 'wide', move: 'push-in' }, actions: [{ character: 'blacksmith', motion: 'strike', at: 0.3 }], duration: 2.6 });
ok('set-shot', { cutscene: 'intro', id: 'job', camera: { framing: 'medium', subject: 'blacksmith', move: 'push-in' }, lines: [{ character: 'blacksmith', line: LINES.intro.id, to: 'apprentice', at: 0.25 }] });

const doc = studio.doc();
const bad = Object.keys(doc.objects).flatMap((id) => studio.checks(id, doc).filter((c) => !c.pass && c.severity !== 'info').map((c) => `${id}: ${c.label} — ${c.detail}`));
if (bad.length) log(`checks failing:\n  ${bad.join('\n  ')}`);

// into the web game: init (keeps src/ if it exists) and import with the apprentice as the player
const ctx: GameContext = {
  studioDir: ROOT,
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
if (!fs.existsSync(path.join(GAME, 'studio-game.json'))) {
  const r = await runGame('game-init', { name: "Fire's Dying", engine: 'web', dir: 'games/fires-dying' }, ctx);
  if (!r.ok) throw new Error(`game-init: ${r.error}`);
}
const imp = await runGame('game-import', { project: 'games/fires-dying', player: 'Apprentice', strict: false }, ctx);
if (!imp.ok) throw new Error(`game-import: ${imp.error} ${JSON.stringify(imp.failures ?? imp.errors ?? '').slice(0, 800)}`);
log(`imported: ${JSON.stringify(imp.result ?? imp).slice(0, 400)}`);
