// The reel module (Decision 32): the reel file, cameras, the cut on beats, crop boxes per shape, the
// ffmpeg recipe (run end to end on synthetic takes), and the release checks (word lists, OCR, REUSE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseReel, cameraAt, takeFrames, cutToBeats, cutErrors, cropBox, OUTPUT, type Reel } from '../src/reel.ts';
import { buildRecipe } from '../src/recipe.ts';
import { steadyBeats, reelCut, editBeats } from '../src/make.ts';
import { reelCli } from '../src/cli.ts';
import { matchWords, checkText, reuseToml, loadLists, ocr, ocrTool } from '../../proof/src/release.ts';
import { findChrome } from '../../game/src/chrome.ts';
import { writeWav, silence } from '../../sound/src/dsp.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `reel-${p}-`));
const base = (over: any = {}): Reel => parseReel({
  id: 't', title: 'T', size: 256, fps: 30,
  takes: [
    { id: 'a', seconds: 3, keys: [{ position: [0, 2, 10], target: [0, 2, 0] }, { position: [0, 4, 6], target: [0, 3, 0] }], crop: { '9:16': { x: 0.2 } } },
    { id: 'b', seconds: 3, keys: [{ position: [5, 2, 10], target: [0, 2, 0] }] },
  ],
  edit: [{ take: 'a', beats: 4, in: 0.2, caption: 'Hello' }, { take: 'b', beats: 2, in: 0.3 }],
  endCard: { beats: 2, title: 'End', credit: 'Map data © OpenStreetMap contributors' },
  ...over,
});

test('the reel file is checked: takes the edit names must exist', () => {
  assert.throws(() => base({ edit: [{ take: 'nope', beats: 2 }] }), /isn't in takes/);
  assert.equal(editBeats(base()), 8);
});

test('cameras: keys at the ends, one per frame', () => {
  const r = base(), t = r.takes[0];
  assert.deepEqual(cameraAt(t, 0).position, [0, 2, 10]);
  assert.deepEqual(cameraAt(t, 1).position.map((v) => +v.toFixed(6)), [0, 4, 6]);
  assert.equal(takeFrames(t, 30).length, 90);
});

test('the cut lands on beats; shots that outrun their take are reported', () => {
  const beats = Array.from({ length: 40 }, (_, k) => +(0.02 + k * 0.5).toFixed(4));   // 120 bpm, a little late
  const r = base(), cut = cutToBeats(r, beats);
  assert.equal(cut.shots[0].start, 0);
  assert.equal(cut.shots[1].start, beats[4]);
  assert.equal(cut.endCard!.start, beats[6]);
  assert.equal(cut.duration, beats[8]);
  assert.ok(cutErrors(cut, beats).every((e) => e === 0));
  assert.equal(cut.bpm, 120);
  const long = cutToBeats(base({ edit: [{ take: 'a', beats: 8, in: 0.5 }] }), beats);
  assert.match(long.warnings.join(), /hold the last frame/);
});

test('steady beats: librosa\'s jittery, gappy detections become one even grid with the right phase', () => {
  const period = 60 / 128, truth = Array.from({ length: 64 }, (_, k) => 0.03 + k * period);
  const found = truth.filter((_, k) => k > 15 && k % 7 !== 3).map((t, k) => t + (k % 2 ? 0.01 : -0.008));
  const s = steadyBeats({ bpm: 129, beats: found, downbeats: [], downbeatPhase: 0, onsets: [], duration: 30.2, tool: 'x' }, 30.2);
  assert.ok(Math.abs((s[1] - s[0]) - period) < 0.002);
  for (const k of [0, 10, 40, 63]) assert.ok(Math.abs(s[k] - truth[k]) < 0.015, `beat ${k}: ${s[k]} vs ${truth[k]}`);
});

test('crop boxes per shape: right aspect, inside the square, centre moves the box', () => {
  const r = base();
  for (const a of ['16:9', '1:1', '9:16'] as const) {
    const b = cropBox(r, 'a', a), [W, H] = OUTPUT[a];
    assert.ok(Math.abs(b.w / b.h - W / H) < 0.02, a);
    assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 256 && b.y + b.h <= 256);
    assert.equal(b.w % 2, 0);
  }
  assert.equal(cropBox(r, 'a', '9:16').x, 0);                       // x 0.2 clamps to the left edge
  assert.ok(cropBox(r, 'b', '9:16').x > 40);                        // default centre
});

test('the recipe: trim, crop and scale per shot, concat, cards on their shots, music', () => {
  const r = base(), cut = cutToBeats(r, Array.from({ length: 40 }, (_, k) => k * 0.5));
  const rec = buildRecipe(r, cut, '9:16', { takes: { a: 'a.mp4', b: 'b.mp4' }, music: 'm.wav', cards: { 'caption-1': 'c.png', end: 'e.png' } }, 'out.mp4');
  const b = cropBox(r, 'a', '9:16');
  assert.match(rec.filter, new RegExp(`trim=start=0\\.200:end=2\\.200.*crop=${b.w}:${b.h}:${b.x}:${b.y},scale=1080:1920`));
  assert.match(rec.filter, /concat=n=3:v=1:a=0/);                    // two shots + the end card
  assert.match(rec.filter, /overlay=0:0:enable='between\(t,0\.250,1\.900\)'/);
  assert.deepEqual(rec.overlays.map((o) => o.card), ['caption-1', 'end']);
  assert.ok(rec.args.includes('m.wav') && rec.args.includes('[aout]'));
});

test('cut end to end on synthetic takes: three shapes, a recipe script, stills', { skip: !findChrome() && 'no Chrome' }, async () => {
  const work = tmp('work'), out = tmp('out');
  fs.mkdirSync(path.join(work, 'takes'), { recursive: true });
  for (const [id, src] of [['a', 'testsrc2'], ['b', 'smptebars']]) spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `${src}=size=256x256:rate=30:duration=3`, '-pix_fmt', 'yuv420p', path.join(work, 'takes', `${id}.mp4`)]);
  writeWav(path.join(work, 'music.wav'), silence(44100 * 6));
  fs.writeFileSync(path.join(work, 'beats.json'), JSON.stringify({ bpm: 120, beats: Array.from({ length: 12 }, (_, k) => k * 0.5), downbeats: [], downbeatPhase: 0, onsets: [], duration: 6, tool: 'test' }));
  const rep = await reelCut(base(), work, out);
  assert.equal(rep.videos.length, 3);
  for (const v of rep.videos) {
    const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', v.video], { encoding: 'utf8' });
    const j = JSON.parse(p.stdout), [W, H] = OUTPUT[v.aspect as keyof typeof OUTPUT];
    assert.equal(j.streams[0].width, W); assert.equal(j.streams[0].height, H);
    assert.ok(Math.abs(Number(j.format.duration) - 4) < 0.15, `${v.aspect} ${j.format.duration}`);
    assert.ok(fs.existsSync(v.recipe) && fs.readFileSync(v.recipe, 'utf8').startsWith('#!/bin/sh'));
  }
  assert.equal(rep.stills['9x16'].length, 3);
});

test('release lists: whole words, accents, allow-list; required credits; REUSE.toml', () => {
  assert.deepEqual(matchWords('Visit the Wells Fargo tower', ['Wells Fargo', 'Fargo Bank']), ['Wells Fargo']);
  assert.deepEqual(matchWords('POKEMON town', ['Pokémon']), ['Pokémon']);
  assert.deepEqual(matchWords('a cocktail', ['Coke']), []);
  assert.deepEqual(matchWords('real time and real-time', ['real-time']), ['real-time']);
  const lists = { ...loadLists(), required: ['OpenStreetMap'], allow: ['Wells Fargo Capitol Center'] };
  const r = checkText([{ where: 's1', text: 'The Wells Fargo Capitol Center, accurate to the inch' }, { where: 's2', text: 'Go Canes!' }], lists);
  const kinds = r.findings.map((f) => `${f.kind}:${f.word}`).sort();
  assert.deepEqual(kinds, ['required-missing:OpenStreetMap', 'team:Canes', 'wording:accurate']);
  assert.match(reuseToml([{ path: 't-*.mp4', copyright: ['2026 A'], licence: 'CC0-1.0' }]), /version = 1[\s\S]*\[\[annotations\]\][\s\S]*SPDX-License-Identifier = "CC0-1.0"/);
});

test('on-Mac OCR reads a title card', { skip: (process.platform !== 'darwin' || !findChrome()) && 'macOS + Chrome only' }, async () => {
  if (!ocrTool()) return;
  const { renderCards } = await import('../src/titles.ts');
  const d = tmp('ocr');
  const cards = await renderCards([{ id: 'end', kind: 'end', text: 'Pocket Raleigh', credit: 'Map data © OpenStreetMap contributors' }], d, ['16:9']);
  // OCR needs an opaque picture: put the card on grey
  const flat = path.join(d, 'flat.png');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x334455:s=1920x1080', '-i', cards['16:9'].end, '-filter_complex', 'overlay', '-frames:v', '1', flat]);
  const text = ocr([flat])[0].lines.map((l) => l.text).join(' ');
  assert.match(text, /Pocket Raleigh/);
  assert.match(text, /OpenStreetMap/);
});

test('the reel CLI lists its commands and corrects bad flags', async () => {
  const pf = (argv: string[]) => { const o: any = {}; for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1]; return o; };
  const h = await reelCli(['help'], pf);
  assert.ok(h.ok && h.commands.cut && h.commands.release);
  const bad = await reelCli(['cut', '--aspect', '1:1'], pf);
  assert.equal(bad.ok, false); assert.match(bad.error, /--aspect/);
});
