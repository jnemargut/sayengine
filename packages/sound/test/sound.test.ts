// The sound module (Decision 33): seeded synth, seeded stems cut on the bar, beds, the licence ledger,
// sound packs read by both runtimes (Godot headless, the web in headless Chrome via Fire's Dying),
// the offline mix, and the beat tool (librosa) when the studio venv has it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sfx, SFX_KINDS, renderSfxr, DEFAULT_SFXR } from '../src/sfx.ts';
import { plan, renderStems, renderStem, STEMS, lufs, mixStems, LEVELS, arrange } from '../src/music.ts';
import { bed, BED_KINDS } from '../src/ambience.ts';
import { seamJump, peak, rms, writeWav, readWav, resample, SR } from '../src/dsp.ts';
import { writeSidecar, audit, creditsMarkdown, NEEDS_ATTRIBUTION } from '../src/ledger.ts';
import { buildPack, writeRuntimes } from '../src/pack.ts';
import { renderTrace } from '../src/offline.ts';
import { venvPython, detectBeats, gridError } from '../src/beats.ts';
import { soundCli } from '../src/cli.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `sound-${p}-`));
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => v === b[i]);

test('game sounds are kind + seed: deterministic, distinct per seed, never silent or clipped', () => {
  for (const k of SFX_KINDS) {
    const a = sfx(k, 'x'), b = sfx(k, 'x'), c = sfx(k, 'y');
    assert.ok(same(a[0], b[0]), `${k} is deterministic`);
    assert.ok(!same(a[0], c[0]), `${k} differs by seed`);
    assert.ok(peak(a) > 0.5 && peak(a) <= 0.9, `${k} peak ${peak(a)}`);
    assert.ok(a[0].length > 1000 && a[0].length < SR * 8, `${k} length`);
  }
  const raw = renderSfxr({ ...DEFAULT_SFXR, wave: 2, baseFreq: 0.35 }, 3);
  assert.ok(raw.length > 1000 && rms(raw) > 0.01);
  assert.throws(() => sfx('nope'), /unknown sound kind/);
});

test('seeded music: the seed decides key, progression and melody; stems are loops cut exactly on the bar', () => {
  const p = plan({ seed: 'test', mood: 'night', bpm: 120, bars: 4 }), q = plan({ seed: 'test', mood: 'night', bpm: 120, bars: 4 });
  assert.deepEqual(p, q);
  assert.equal(p.loopSamples, Math.round(4 * 2 * SR));                         // 4 bars at 120 bpm = 8 s
  const sc = p.mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11];  // minor allows the raised 7th (V)
  for (const ch of p.chords) for (const n of ch) assert.ok(sc.includes(((n - p.key) % 12 + 12) % 12), `${n} in ${p.keyName}`);
  for (const m of p.melody) assert.ok(sc.includes(((m.note - p.key) % 12 + 12) % 12), `melody ${m.note} in key`);
  const st = renderStems(p);
  for (const s of STEMS) {
    assert.equal(st[s][0].length, p.loopSamples, `${s} loop length`);
    // tonal stems flow across the seam; hats and beat start with a hit on beat 1 (a real onset there)
    if (!['hats', 'beat'].includes(s)) assert.ok(seamJump(st[s]) < 3.5, `${s} seam ${seamJump(st[s])}`);
  }
  // the ladder: each level is louder than the one below it
  const l = LEVELS.map((mix) => lufs(mixStems(st, mix)));
  for (let i = 1; i < l.length; i++) assert.ok(l[i] > l[i - 1], `level ${i} (${l[i]}) > level ${i - 1} (${l[i - 1]})`);
  const song = arrange(p, st, [{ bars: 2, mix: { pad: 1 } }, { bars: 2, mix: { pad: 1, beat: 1 }, hit: true }]);
  assert.equal(song.bars.length, 4);
  assert.ok(Math.abs(song.bars[2].t - 4) < 1e-3);
});

test('loudness meter: a full-scale 997 Hz sine in one channel reads −3.01 LUFS (BS.1770)', () => {
  const x = new Float32Array(SR * 3).map((_, i) => Math.sin(2 * Math.PI * 997 * i / SR));
  assert.ok(Math.abs(lufs([x]) + 3.01) < 0.3, String(lufs([x])));
});

test('beds are seamless loops; resampling a loop keeps it seamless', () => {
  for (const k of BED_KINDS) { const b = bed(k, 1, 3); assert.ok(seamJump(b) < 4, `${k} seam ${seamJump(b)}`); assert.ok(rms(b[0]) > 0.005, `${k} not silent`); }
  const r = resample(renderStem(plan({ seed: 2, bars: 2, bpm: 120 }), 'pad'), SR, 32000, true);
  assert.equal(r[0].length, Math.round(4 * 32000));
  assert.ok(seamJump(r) < 3.5);
});

test('every file carries a licence: sidecars, audit, credits; unknown licences are refused', () => {
  const d = tmp('ledger');
  const a = path.join(d, 'a.wav'), b = path.join(d, 'b.wav'), c = path.join(d, 'c.wav');
  for (const f of [a, b, c]) writeWav(f, sfx('blip', f));
  writeSidecar(a, { spdx: 'CC0-1.0', copyright: '2026 Test', source: 'synth', how: 'sfx blip' });
  writeSidecar(b, { spdx: 'CC-BY-4.0', copyright: '2020 Someone', source: 'library', how: 'Freesound: a door', author: 'Someone', url: 'https://example.org', attribution: '"Door" by Someone, CC BY 4.0' });
  assert.throws(() => writeSidecar(c, { spdx: 'Totally-Free', copyright: 'x', source: 'synth', how: 'x' }), /not a licence/);
  const au = audit(d);
  assert.equal(au.files, 3);
  assert.deepEqual(au.missing, ['c.wav']);
  assert.match(fs.readFileSync(a + '.license', 'utf8'), /^SPDX-FileCopyrightText: 2026 Test\nSPDX-License-Identifier: CC0-1.0/);
  const md = creditsMarkdown('T', [{ file: 'b.wav', licence: { spdx: 'CC-BY-4.0', copyright: 'x', source: 'library', how: 'Freesound: a door', author: 'Someone', attribution: '"Door" by Someone, CC BY 4.0' } }]);
  assert.match(md, /Attribution required[\s\S]*"Door" by Someone/);
  assert.ok(NEEDS_ATTRIBUTION('CC-BY-4.0') && !NEEDS_ATTRIBUTION('CC0-1.0'));
});

async function tinyPack(dir: string) {
  return buildPack({
    title: 'Tiny', owner: 'Test', values: { fire: 0.8, intensity: 0 }, rate: 22050,
    layers: [{ id: 'roar', bed: 'forge-roar', seconds: 2, gain: 1, follow: { value: 'fire', gain: [0, 1], lowpass: [300, 3000] } }],
    events: { strike: { sounds: [{ kind: 'clink', seed: 's1' }, { kind: 'clink', seed: 's2' }], gain: 0.8 } },
    music: { seed: 'tiny', bars: 2, bpm: 120, value: 'intensity', stings: ['won'] },
  }, dir);
}

test('a sound pack: rendered files, a licence on each, sound.json for both runtimes, credits', async () => {
  const d = tmp('pack');
  const { manifest, report } = await tinyPack(d);
  assert.deepEqual(Object.keys(manifest.music!.stems), [...STEMS]);
  assert.equal(manifest.layers[0].follow?.value, 'fire');
  assert.equal(manifest.events.strike.files.length, 2);
  assert.equal(audit(d).missing.length, 0);
  for (const f of Object.keys(manifest.files)) assert.ok(fs.existsSync(path.join(d, f + '.license')), f);
  assert.match(fs.readFileSync(path.join(d, 'CREDITS.md'), 'utf8'), /Made by the studio/);
  assert.equal(readWav(path.join(d, 'roar.wav')).sr, 22050);
  assert.ok(report.layers.roar.seamJump < 4);
  // offline: the same pack with the fire high is louder than with the fire out
  const hi = renderTrace(d, { seconds: 2, values: [], events: [] });
  const lo = renderTrace(d, { seconds: 2, values: [{ t: 0, name: 'fire', v: 0 }], events: [] });
  const hit = renderTrace(d, { seconds: 2, values: [{ t: 0, name: 'fire', v: 0 }], events: [{ t: 0.5, name: 'strike' }] });
  const cut = (c: Float32Array) => c.subarray(SR, 2 * SR);
  assert.ok(rms(cut(hi[0])) > rms(cut(lo[0])) * 1.5, 'roar follows the fire');
  assert.ok(rms(hit[0].subarray(SR / 2, SR)) > rms(lo[0].subarray(SR / 2, SR)) * 2, 'the strike event is in the mix');
});

test('Godot runtime: the pack loads, layers follow values, stems walk the ladder, events and stings fire', { skip: spawnSync('which', ['godot']).status !== 0 && 'no godot' }, async () => {
  const proj = tmp('godot');
  fs.writeFileSync(path.join(proj, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="soundcheck"\n');
  await tinyPack(path.join(proj, 'assets', 'studio', 'sound'));
  writeRuntimes(proj, 'godot');
  fs.copyFileSync(path.join(HERE, 'fixtures', 'sound_check.gd'), path.join(proj, 'sound_check.gd'));
  const r = spawnSync('godot', ['--headless', '--audio-driver', 'Dummy', '--path', proj, '--script', 'res://sound_check.gd'], { encoding: 'utf8', timeout: 120000 });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('SOUND_CHECK '));
  assert.ok(line, r.stdout + r.stderr);
  const out = JSON.parse(line!.slice(12));
  assert.equal(out.start.layers.roar.playing, true);
  assert.ok(out.after.layers.roar.volume_db < out.start.layers.roar.volume_db - 6, 'the roar drops with the fire');
  assert.equal(out.after.music.clips, 2);
  assert.ok(out.after.music.stems.lead > 0.7 && out.start.music.stems.lead < 0.01, 'intensity 1 brings in the lead');
  assert.equal(out.after.fired.strike, 2);
  assert.equal(out.ended.music.ended, true);
});

test('web runtime in Fire\'s Dying: the forge follows the fire, clinks on strikes, music intensity moves', { skip: !(await import('../../game/src/chrome.ts')).findChrome() && 'no Chrome' }, async () => {
  const GAME = path.resolve(HERE, '../../../games/fires-dying');
  const { bundle, serve } = await import('../../game/src/web.ts');
  const { withPage } = await import('../../game/src/chrome.ts');
  assert.ok((await bundle(GAME)).ok);
  const res = await serve(GAME, (url) => withPage(url + 'index.html', { width: 640, height: 400 }, async (page) => {
    assert.equal(await page.eval(`Promise.race([window.__studio.ready.then(() => true), new Promise((_, j) => setTimeout(() => j('not ready'), 90000))])`, 120000), true);
    await page.eval('window.__fires.pause(); window.__fires.begin(false); true');
    const a = await page.eval('(window.__fires.advance(1/30, 30, false), window.__fires.sound)');
    await page.eval('(window.__fires.state.fire = 0.1, window.__fires.state.request = "hammer", window.__fires.state.waited = 30, true)');
    const b = await page.eval('(window.__fires.advance(1/30, 6, false), window.__fires.sound)');
    return { a, b };
  }));
  assert.ok(res.a.layers['forge-roar'] && res.a.layers['fire-crackle'] && res.a.layers.yard);
  assert.ok(res.a.values.fire > 0.7 && res.b.values.fire < 0.2, 'fire value reaches the sound');
  assert.ok(res.b.values.intensity > res.a.values.intensity + 0.3, `intensity ${res.a.values.intensity} → ${res.b.values.intensity}`);
  assert.ok(res.b.music.target.beat > res.a.music.target.beat, 'the ladder adds the beat');
});

test('beat tool (librosa): finds the tempo and beats of a generated groove', { skip: (!venvPython() || spawnSync(venvPython()!, ['-I', '-c', 'import librosa']).status !== 0) && 'no librosa in ~/.studio-tools/venv' }, () => {
  const p = plan({ seed: 'beats', bpm: 120, bars: 8, mood: 'night' });
  const st = renderStems(p, ['beat', 'hats', 'bass']);
  const d = tmp('beats'), f = path.join(d, 'groove.wav');
  writeWav(f, mixStems(st, { beat: 1, hats: 1, bass: 1 }));
  const g = detectBeats(f, 120);
  const e = gridError(g, 120, 0);
  assert.ok(e.bpmError < 3, JSON.stringify(e));
  assert.ok(e.medianOffsetS < 0.07, JSON.stringify(e));
});

test('the sound CLI lists its commands and corrects bad flags', async () => {
  const pf = (argv: string[]) => { const o: any = {}; for (let i = 0; i < argv.length; i += 2) o[argv[i].slice(2)] = argv[i + 1]; return o; };
  const h = await soundCli(['help'], pf);
  assert.ok(h.ok && h.commands.pack && h.commands.sao);
  const bad = await soundCli(['sfx', '--kinnd', 'clink'], pf);
  assert.equal(bad.ok, false); assert.match(bad.error, /--kinnd/);
  const s = await soundCli(['sao'], pf);
  assert.ok(s.ok && s.result.licence.spdx === 'LicenseRef-Stability-AI-Community');
});
