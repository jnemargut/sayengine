// Fire's Dying: build the game's studio assets and import them into this web game.
// The forge yard (bench/forge.ts) plus a tool shelf, a charcoal sack, a water bucket, the big hammer,
// a file and the blade on the anvil; the blacksmith's voiced calls (local Kokoro voice, lip-synced and
// performed); a short intro cutscene. Then `game import` with the apprentice as the player.
// Run from the repo root: node games/fires-dying/build-assets.ts   (a few minutes: voices + export)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport, cutsceneTimeline } from '../../packages/core/src/index.ts';
import { gameData } from '../../packages/core/src/gamedata.ts';
import { curvesFromCues, curvesFromVisemeCues, syncOffset, restInSilence } from '../../packages/core/src/lipsync.ts';
import { alignPhonemes, ipaTokens, phonemeVisemeCues } from '../../packages/core/src/phonemes.ts';
import * as voice from '../../packages/daemon/src/voice.ts';
import { runGame, type GameContext } from '../../packages/game/src/index.ts';
import { buildForge } from '../../bench/forge.ts';
import { CALLS, LINES, type Line } from './src/lines.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GAME = path.resolve(import.meta.dirname);
const log = (s: string) => console.log(s);

await initKernel();
const studio = new Studio();
const ok = (t: string, a: object) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t} ${JSON.stringify(a).slice(0, 200)}: ${r.error}`); return r; };

buildForge(ok);

// props: one studio object per fetchable thing, small, game-ready (no collision on hand-held items)
// hand props (what the apprentice carries) have no collider: they ride the hand bone (pain #11), and
// the player no longer wedges on the sack or the bucket (pain #5)
const prop = (name: string, type: string, material: string, color: string | null, ops: Array<Record<string, unknown>>, at: [number, number, number], opts: { rotation?: number; collision?: string; hand?: boolean } = {}) => {
  ok('new-object', { name, type, material, ...(color ? { color } : {}), position: at });
  for (const o of ops) ok('add-op', o);
  if (opts.rotation) ok('move-object', { position: at, rotation: opts.rotation });
  ok('set-profile', { profile: 'godot-desktop', ...(opts.hand ? { kind: 'hand-prop' } : {}) });
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
// the tongs and the chisel on the shelf's top board, the file and the whetstone on its lower board
prop('Tongs', 'tool', 'black-metal', null, [
  { id: 'jawA', op: 'box', part: 'tongs', output: false, args: { size: [0.42, 0.018, 0.02], at: [0, 0.009, -0.012] } },
  { id: 'jawB', op: 'box', part: 'tongs', output: false, args: { size: [0.42, 0.018, 0.02], at: [0.01, 0.009, 0.012] } },
  { id: 'pin', op: 'cylinder', part: 'tongs', output: false, args: { r: 0.016, h: 0.03, at: [0.1, 0, 0] } },
  { id: 'tongs', op: 'union', inputs: ['jawA', 'jawB', 'pin'], output: true },
], [-3.1, 1.018, 1.12], { rotation: 90, hand: true });
prop('File', 'tool', 'black-metal', null, [
  { id: 'blade', op: 'box', part: 'file', output: false, args: { size: [0.24, 0.012, 0.03], at: [0.06, 0.006, 0] } },
  { id: 'grip', op: 'cylinder', part: 'grip', output: false, args: { r: 0.018, h: 0.12 } },
  { id: 'gripLaid', op: 'rotate', inputs: ['grip'], output: false, args: { deg: [0, 0, 90] } },
  { id: 'gripAt', op: 'translate', inputs: ['gripLaid'], output: false, args: { by: [-0.06, 0.018, 0] } },
  { id: 'file', op: 'union', inputs: ['blade', 'gripAt'], output: true },
], [-3.1, 0.518, 1.12], { rotation: 90, hand: true });
ok('set-material', { object: 'file', part: 'grip', preset: 'oak' });
prop('Chisel', 'tool', 'black-metal', null, [
  { id: 'bar', op: 'box', part: 'chisel', output: false, args: { size: [0.15, 0.016, 0.016], at: [0.05, 0.017, 0] } },
  { id: 'edge', op: 'box', part: 'chisel', output: false, args: { size: [0.03, 0.008, 0.026], at: [0.135, 0.013, 0] } },
  { id: 'grip', op: 'cylinder', part: 'grip', output: false, args: { r: 0.017, h: 0.09 } },
  { id: 'gripLaid', op: 'rotate', inputs: ['grip'], output: false, args: { deg: [0, 0, 90] } },
  { id: 'gripAt', op: 'translate', inputs: ['gripLaid'], output: false, args: { by: [-0.015, 0.017, 0] } },
  { id: 'chisel', op: 'union', inputs: ['bar', 'edge', 'gripAt'], output: true },
], [-3.1, 1.018, 1.5], { rotation: 90, hand: true });
ok('set-material', { object: 'chisel', part: 'grip', preset: 'walnut' });
prop('Whetstone', 'tool', 'concrete', '#8f8a80', [
  { id: 'stone', op: 'roundedBox', part: 'stone', args: { size: [0.2, 0.045, 0.07], r: 0.01, at: [0, 0.0225, 0] } },
], [-3.1, 0.518, 1.45], { rotation: 90, hand: true });
// the charcoal sack by the coal heap
prop('Charcoal sack', 'prop', 'linen', '#4a4038', [
  { id: 'body', op: 'roundedBox', part: 'sack', output: false, args: { size: [0.42, 0.5, 0.32], r: 0.08, at: [0, 0.25, 0] } },
  { id: 'neck', op: 'cylinder', part: 'neck', output: false, args: { r1: 0.1, r2: 0.06, h: 0.12, at: [0, 0.48, 0] } },
  { id: 'sack', op: 'union', inputs: ['body', 'neck'], output: true },
], [-2.2, 0, 0.9], { hand: true });
// the water bucket by the barrel
prop('Water bucket', 'prop', 'oak', '#8b6a48', [
  { id: 'pail', op: 'revolve', part: 'bucket', output: false, args: { profile: [[0, 0], [0.15, 0], [0.18, 0.3], [0.165, 0.3], [0.135, 0.02], [0, 0.02]] } },
  { id: 'water', op: 'cylinder', part: 'water', output: false, args: { r1: 0.15, r2: 0.165, h: 0.22, at: [0, 0.01, 0] } },
  { id: 'bucket', op: 'union', inputs: ['pail', 'water'], output: true },
], [1.85, 0, 0.75], { hand: true });
ok('set-material', { object: 'water-bucket', part: 'water', preset: 'glass', color: '#5f8fb0' });
// the big hammer, on the workbench
prop('Big hammer', 'tool', 'oak', null, [
  { id: 'handle', op: 'cylinder', part: 'handle', output: false, args: { r: 0.02, h: 0.62 } },
  { id: 'handleLaid', op: 'rotate', inputs: ['handle'], output: false, args: { deg: [0, 0, 90] } },
  { id: 'handleAt', op: 'translate', inputs: ['handleLaid'], output: false, args: { by: [0.31, 0.02, 0] } },
  { id: 'head', op: 'box', part: 'head', output: false, args: { size: [0.07, 0.07, 0.17], at: [0.02, 0.035, 0] } },
  { id: 'bighammer', op: 'union', inputs: ['handleAt', 'head'], output: true },
], [1.8, 0.85, -1.55], { rotation: 15, hand: true });
ok('set-material', { object: 'big-hammer', part: 'head', preset: 'black-metal' });
// the bellows by the forge's left side: two boards and the leather between, on a low stand, nozzle to the fire
prop('Bellows', 'furniture', 'oak', '#6d4c33', [
  { id: 'stand', op: 'box', part: 'stand', output: false, args: { size: [0.5, 0.36, 0.32], at: [0, 0.18, 0] } },
  { id: 'low', op: 'box', part: 'board', output: false, args: { size: [0.56, 0.03, 0.34], at: [0, 0.375, 0] } },
  { id: 'hide', op: 'roundedBox', part: 'leather', output: false, args: { size: [0.46, 0.14, 0.3], r: 0.05, at: [-0.02, 0.46, 0] } },
  { id: 'top', op: 'box', part: 'board', output: false, args: { size: [0.56, 0.03, 0.34], at: [0, 0.545, 0] } },
  { id: 'handle', op: 'box', part: 'board', output: false, args: { size: [0.14, 0.03, 0.08], at: [-0.33, 0.545, 0] } },
  { id: 'nose', op: 'cylinder', part: 'nozzle', output: false, args: { r1: 0.04, r2: 0.018, h: 0.22 } },
  { id: 'noseLaid', op: 'rotate', inputs: ['nose'], output: false, args: { deg: [0, 0, -90] } },
  { id: 'noseAt', op: 'translate', inputs: ['noseLaid'], output: false, args: { by: [0.19, 0.46, 0] } },   // a cylinder stands on its base: laid down it runs 0 → h along x
  { id: 'bellows', op: 'union', inputs: ['stand', 'low', 'hide', 'top', 'handle', 'noseAt'], output: true },
], [-2.98, 0, -1.7], { collision: 'box' });
ok('set-material', { object: 'bellows', part: 'leather', preset: 'fabric', color: '#5a3a26' });
ok('set-material', { object: 'bellows', part: 'nozzle', preset: 'brass' });

// the blade on the anvil (the work)
prop('Blade', 'tool', 'black-metal', '#3a3530', [
  { id: 'blade', op: 'extrude', part: 'blade', args: { profile: [[-0.2, -0.018], [0.14, -0.018], [0.2, 0], [0.14, 0.018], [-0.2, 0.018]], h: 0.012 } },
], [-0.04, 0.779, -0.5], { collision: 'hull' });

// the apprentice stands by the yard's open side; pick-up for fetching
ok('set-motion', { object: 'apprentice', id: 'pickup', kind: 'action', action: 'pick-up' });

// effects (D56): the forge fire follows the game's `fire` value; sparks on each strike's impact; smoke
// from the chimney; embers when charcoal goes in or the bellows blow
ok('add-effect', { id: 'forge-fire', preset: 'forge-fire', at: [-1.9, 0.76, -1.65], value: 'fire' });
ok('add-effect', { id: 'sparks', preset: 'sparks', at: [-0.02, 0.78, -0.5], triggers: [{ on: 'Blacksmith:strike@impact', layer: 'burst' }] });
ok('add-effect', { id: 'chimney-smoke', preset: 'chimney-smoke', at: [-1.9, 2.78, -1.94] });
ok('add-effect', { id: 'embers', preset: 'embers', at: [-1.9, 0.8, -1.65], triggers: [{ on: 'fed', layer: 'puff' }, { on: 'pumped', layer: 'puff' }] });

// the UI kit (D58): the forge style, this game's HUD, the house icons plus three of its own
const svg = (name: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny" viewBox="0 0 48 48" width="48" height="48"><title>${name}</title><g fill="none" stroke="#1d1410" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
ok('ui-kit', {
  preset: 'forge', profile: 'mobile',
  layout: [
    { id: 'fire', part: 'bar', x: 96, y: 28, w: 340, h: 40, text: 'Fire', value: 0.8 },
    { id: 'blade', part: 'bar', x: 96, y: 80, w: 340, h: 40, text: 'Blade 0 / 20', value: 0 },
    { id: 'want', part: 'slot', x: 96, y: 134, w: 64, h: 64, icon: 'tongs' },
    { id: 'wants', part: 'tooltip', x: 170, y: 144, w: 266, h: 44, text: 'He is working' },
    { id: 'carry-label', part: 'label', x: 96, y: 540, w: 136, h: 36, text: 'Carrying', anchor: 'bl' },
    { id: 'carry', part: 'slot', x: 96, y: 588, w: 88, h: 88, anchor: 'bl' },
    { id: 'hint', part: 'tooltip', x: 440, y: 600, w: 400, h: 44, text: 'E: take the tongs', anchor: 'center' },
    { id: 'use', part: 'button', x: 1004, y: 588, w: 180, h: 88, text: 'Use', anchor: 'br' },
  ],
});
ok('ui-icon', { names: ['tongs', 'charcoal', 'big-hammer', 'file', 'water-bucket', 'blade'] });
ok('ui-icon', { name: 'chisel', svg: svg('chisel', '<path d="M20 4 L28 4 L27 27 L21 27 Z" fill="#bfa98b"/><path d="M18 27 L30 27 L29 44 L19 44 Z" fill="#8a5a2b"/><path d="M19 31 L29 31" stroke="#bfa98b" stroke-width="2"/>') });
ok('ui-icon', { name: 'whetstone', svg: svg('whetstone', '<rect x="5" y="16" width="38" height="17" rx="3" fill="#bfa98b"/><path d="M5 27 L43 27" stroke-width="2"/><path d="M11 21 L19 21 M25 22 L35 22" stroke="#8a5a2b" stroke-width="2"/>') });
ok('ui-icon', { name: 'bellows', svg: svg('bellows', '<path d="M10 12 C2 20 2 28 10 36 L32 26 L32 22 Z" fill="#8a5a2b"/><path d="M32 22 L44 23 L44 25 L32 26 Z" fill="#bfa98b"/><path d="M10 12 L5 6 M10 36 L5 42" stroke-width="4"/><path d="M12 24 L28 24" stroke="#e0782a" stroke-width="2"/>') });

// the blacksmith's voice: local Kokoro (bm_george), aligned and performed (whole body); game import
// exports every line's audio (pain #9), so the game plays them with say()
const say = async (object: string, id: string, text: string, voiceName: string, emotion: string, gestures?: string) => {
  const wav = await voice.speak(text, voiceName);
  const audio = studio.assets.put(wav, 'wav');
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
for (const l of [...Object.values(CALLS), ...Object.values(LINES)] as Line[]) await say('blacksmith', l.id, l.text, 'bm_george', l.emotion, l.gestures);

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
  // effects, the UI kit and every recorded line go into assets/studio/ with the scene
  async gameData() { return gameData(studio); },
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
