// Face fixes after the week-4 checkpoint: teeth and tongue inside a mouth, stronger OO and F/V that
// smoothing can't average away, the 15 speech shapes driven by phonemes, and blinks/eye darts/brow
// lifts while speaking (the first slice of the life layer).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  initKernel, Studio, toGLB, validateGlb, VISEMES, mouthCheck, curvesFromVisemeCues, rhubarbVisemeCues, lineChecks,
  ipaTokens, alignPhonemes, phonemeVisemeCues, lineLife, BLINK,
} from '../src/index.ts';

before(async () => { await initKernel(); });

const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
function kit() {
  const s = new Studio();
  const r = s.call('new-character', { name: 'Smith', preset: 'blacksmith' });
  assert.ok(r.ok, r.error);
  return s;
}

test('the mouth has teeth and a tongue: upper teeth on the head, lower teeth and tongue on the jaw, all behind the lips', () => {
  const s = kit();
  const res = s.evaluate(s.doc().objects.smith);
  const { rig, rest, vertPart } = res.rig!;
  const bone = (name: string) => rig.bones.findIndex((b) => b.name === name);
  const of = (part: string) => vertPart.map((p, v) => (p === part ? v : -1)).filter((v) => v >= 0);
  for (const part of ['teethUpper', 'teethLower', 'tongue']) assert.ok(of(part).length >= 8, `${part} exists`);
  const mainBone = (v: number) => rig.joints[v * 4 + [0, 1, 2, 3].sort((a, b) => rig.weights[v * 4 + b] - rig.weights[v * 4 + a])[0]];
  assert.ok(of('teethUpper').every((v) => mainBone(v) === bone('Head')), 'upper teeth ride the head');
  assert.ok(of('teethLower').concat(of('tongue')).every((v) => mainBone(v) === bone('Jaw')), 'lower teeth and tongue ride the jaw');
  // the jaw shape moves the lower teeth with the chin, never the upper ones
  const jaw = rig.shapes.jawOpen, moved = new Set(jaw.idx);
  assert.ok(of('teethLower').every((v) => moved.has(v)) && of('teethUpper').every((v) => !moved.has(v)));
  // TH brings the tongue forward; L/N raise its tip
  // (relative to the lower teeth, which drop with the jaw)
  const most = (shape: string, part: string, axis: number) => { const sd = rig.shapes[shape]; let m = -Infinity; sd.idx.forEach((v, i) => { if (vertPart[v] === part) m = Math.max(m, sd.d[i * 3 + axis]); }); return m; };
  assert.ok(most('TH', 'tongue', 2) - most('TH', 'teethLower', 2) > 0.01, 'TH: tongue forward');
  assert.ok(most('nn', 'tongue', 1) - most('nn', 'teethLower', 1) > 0.008, 'N/L: tongue tip up');
  const chk = s.checks('smith').find((c) => c.id === 'mouth-inside');
  assert.ok(chk?.pass, chk?.detail);
  // a tooth pushed out through the lips is caught
  const bad = new Float32Array(rest);
  for (const v of of('teethUpper')) bad[v * 3 + 2] += 0.06;
  const m = mouthCheck(rig, bad, vertPart);
  assert.equal(m.pass, false);
  assert.match(m.detail, /poke through/);
  // still inside budget (the stocky body plan's barrel chest and belly rings add some hull detail)
  assert.ok(res.indices.length / 3 < 20000, `${res.indices.length / 3} triangles`);
});

test('short F/V and OO sounds reach their shape; the check catches a smoothed-away one', () => {
  // a 40 ms F between two wide vowels, a 50 ms OO between two others
  const cues = [
    { start: 0, end: 0.1, mix: { sil: 1 } }, { start: 0.1, end: 0.3, mix: { aa: 1 } }, { start: 0.3, end: 0.34, mix: { FF: 1 } }, { start: 0.34, end: 0.55, mix: { E: 1 } },
    { start: 0.55, end: 0.6, mix: { ou: 1 } }, { start: 0.6, end: 0.85, mix: { aa: 1 } }, { start: 0.85, end: 1, mix: { sil: 1 } },
  ];
  const c = curvesFromVisemeCues(cues, 1, 30);
  const peak = (k: string, a: number, b: number) => Math.max(...c[k].slice(Math.floor(a * 30), Math.ceil(b * 30) + 1));
  assert.ok(peak('FF', 0.3, 0.34) >= 0.85, `F/V peak ${peak('FF', 0.3, 0.34)}`);
  assert.ok(peak('ou', 0.55, 0.6) >= 0.8, `OO peak ${peak('ou', 0.55, 0.6)}`);
  const f = Math.round(0.32 * 30);
  assert.ok(c.aa[f] < 0.35 && c.E[f] < 0.35, 'open vowels give way to the F');
  const phonemes = [{ start: 0.3, end: 0.34, ph: 'f', viseme: 'FF', stress: 0, word: 0 }, { start: 0.55, end: 0.6, ph: 'u', viseme: 'ou', stress: 0, word: 1 }];
  const ok = lineChecks('t', { text: 'x', audio: '', emotion: 'neutral', duration: 1, fps: 30, cues: [], curves: c, phonemes, aligner: 't' });
  assert.ok(ok.find((x) => x.id === 'line-t-shapes')?.pass);
  // the old plain smoothing (no guarantee) would leave them weak: the check says so
  const weak = { ...c, FF: c.FF.map((v) => v * 0.4), ou: c.ou.map((v) => v * 0.4) };
  const no = lineChecks('t', { text: 'x', audio: '', emotion: 'neutral', duration: 1, fps: 30, cues: [], curves: weak, phonemes, aligner: 't' });
  assert.equal(no.find((x) => x.id === 'line-t-shapes')?.pass, false);
  // Rhubarb's cues still work as the fallback
  const r = curvesFromVisemeCues(rhubarbVisemeCues([{ start: 0, end: 0.2, shape: 'X' }, { start: 0.2, end: 0.24, shape: 'G' }, { start: 0.24, end: 0.5, shape: 'D' }]), 0.5, 30);
  assert.ok(Math.max(...r.FF) >= 0.85);
});

test('phonemes drive all 15 shapes, placed in time on the aligner\'s shapes and silences', () => {
  // "the big thing, mum" as eSpeak writes it: two phrases
  const toks = ipaTokens(['ðə bˈɪɡ θˈɪŋ', 'mˈʌm']);
  assert.deepEqual(toks.filter((t) => !t.pause).map((t) => t.ph), ['ð', 'ə', 'b', 'ɪ', 'ɡ', 'θ', 'ɪ', 'ŋ', 'm', 'ʌ', 'm']);
  assert.equal(toks.filter((t) => t.pause).length, 3, 'optional pauses: start, between phrases, end');
  assert.equal(toks.find((t) => t.ph === 'ɪ')?.stress, 1);
  const tk = ipaTokens(['tʃˈaɪld']);
  assert.deepEqual(tk.filter((t) => !t.pause).map((t) => t.ph), ['tʃ', 'a', 'ɪ', 'l', 'd'], 'affricates stay one sound; diphthongs split');
  // aligner cues: rest, B (TH/ə), A (b), C (ɪ), B (g, th), C (ɪ ŋ), rest (comma), A (m), D (ʌ), A (m), rest
  const cues = [
    { start: 0, end: 0.2, shape: 'X' }, { start: 0.2, end: 0.32, shape: 'B' }, { start: 0.32, end: 0.4, shape: 'A' }, { start: 0.4, end: 0.5, shape: 'C' },
    { start: 0.5, end: 0.66, shape: 'B' }, { start: 0.66, end: 0.85, shape: 'C' }, { start: 0.85, end: 1.15, shape: 'X' }, { start: 1.15, end: 1.24, shape: 'A' },
    { start: 1.24, end: 1.42, shape: 'D' }, { start: 1.42, end: 1.52, shape: 'A' }, { start: 1.52, end: 1.8, shape: 'X' },
  ];
  const ph = alignPhonemes(toks, cues, 1.8);
  assert.equal(ph.length, 11);
  const at = (p: string, k = 0) => ph.filter((x) => x.ph === p)[k];
  const inside = (p: { start: number; end: number }, a: number, b: number) => (p.start + p.end) / 2 > a && (p.start + p.end) / 2 < b;
  assert.ok(inside(at('b'), 0.32, 0.4), `b on the closure: ${JSON.stringify(at('b'))}`);
  assert.ok(inside(at('m', 0), 1.15, 1.24) && inside(at('m', 1), 1.42, 1.52), 'both m on closures');
  assert.ok(inside(at('ʌ'), 1.24, 1.42), 'the open vowel on the open shape');
  assert.ok(at('ŋ').end <= 0.9 && at('m').start >= 1.1, 'nothing spoken in the pause');
  // ten different speech shapes from one short line (Rhubarb alone has nine in total)
  const used = new Set(ph.map((p) => p.viseme));
  for (const v of ['TH', 'PP', 'ih', 'kk', 'aa']) assert.ok(used.has(v as any), `uses ${v}`);
  const curves = curvesFromVisemeCues(phonemeVisemeCues(ph, 1.8), 1.8, 30);
  assert.ok(curves.sil[Math.round(1.0 * 30)] > 0.9, 'rests in the pause');
  assert.ok(Math.max(...curves.TH) > 0.5, 'TH shows');
  for (const k of VISEMES) assert.equal(curves[k].length, curves.sil.length);
});

test('life while speaking: seeded blinks (at pauses too), eye darts that return, brow lifts; exported as clip channels', async () => {
  const line = { text: 'Hold still. This will only take a second.', duration: 3.2, fps: 30, emotion: 'firm', cues: [] as any[],
    phonemes: [
      { start: 0.2, end: 0.5, ph: 'o', viseme: 'oh', stress: 1, word: 0 }, { start: 0.5, end: 1.0, ph: 'ɪ', viseme: 'ih', stress: 1, word: 1 },
      { start: 1.4, end: 1.8, ph: 'ɪ', viseme: 'ih', stress: 0, word: 2 }, { start: 1.8, end: 2.4, ph: 'eɪ', viseme: 'E', stress: 1, word: 3 }, { start: 2.4, end: 3.0, ph: 'ɛ', viseme: 'E', stress: 1, word: 4 },
    ] };
  const a = lineLife(line), b = lineLife(line);
  assert.deepEqual(a, b, 'same line, same life');
  assert.ok([2, 3, 4, 5, 6].some((seed) => JSON.stringify(lineLife(line, seed).blinks) !== JSON.stringify(a.blinks)), 'a different seed is a different take');
  const frames = Math.ceil(3.2 * 30) + 1;
  assert.equal(a.curves.eyeBlinkLeft.length, frames);
  for (let i = 1; i < a.blinks.length; i++) assert.ok(a.blinks[i] - a.blinks[i - 1] >= BLINK.minGap - 1e-6, 'blinks not too close');
  // over many takes: most pauses get a blink, and eyes always come back near the listener
  let pauseBlinks = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const l = lineLife(line, seed);
    if (l.blinks.some((t) => t >= 1.0 && t <= 1.4)) pauseBlinks++;
    assert.ok(Math.max(...l.gaze.yaw.map(Math.abs)) <= 4.01 && Math.max(...l.gaze.pitch.map(Math.abs)) <= 1.51, 'darts stay small');
    assert.ok(Math.max(...l.curves.eyeBlinkLeft) <= 1);
  }
  assert.ok(pauseBlinks >= 25, `${pauseBlinks}/40 takes blink in the pause`);
  // recorded with the line, exported as eyelid + eye rotations and blink/brow weights in its clip
  const s = kit();
  const curves = Object.fromEntries(VISEMES.map((v) => [v, new Array(frames).fill(v === 'sil' ? 1 : 0)]));
  const r = s.call('set-line', { object: 'smith', id: 'hold', line: { ...line, audio: 'none.wav', curves, aligner: 'test' } });
  assert.ok(r.ok, r.error);
  const saved = s.doc().objects.smith.character!.lines!.hold;
  assert.ok(saved.life && saved.life.blinks.length >= 1);
  const obj = s.doc().objects.smith;
  const glb = toGLB([{ obj, res: s.evaluate(obj) }], {});
  const v = await validateGlb(glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages));
  const j = json(glb);
  const clip = j.animations.find((x: any) => x.name === 'line:hold');
  const animated = clip.channels.filter((c: any) => c.target.path === 'rotation').map((c: any) => j.nodes[c.target.node].name).sort();
  assert.deepEqual(animated, ['Chest', 'Head', 'LeftEye', 'LeftUpperLid', 'Neck', 'RightEye', 'RightUpperLid', 'UpperChest']);
  // opting out keeps the clip to the mouth
  const r2 = s.call('set-line', { object: 'smith', id: 'still', line: { ...line, audio: 'none.wav', curves, aligner: 'test', life: null } });
  assert.ok(r2.ok && !s.doc().objects.smith.character!.lines!.still.life);
});
