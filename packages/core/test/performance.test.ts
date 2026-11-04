// Phase 3 weeks 7–8 (Decisions 16, 23, 24): the motion fixes (apron swing, a real run, a strike with
// anticipation, start/stop steps), one performance per line (gestures on words, emotion on the face,
// the held prop's hand left alone), and the cutscene file (timeline, framing, checks, 180° rule).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, curvesFromCues, toGLB, validateGlb, cutsceneTimeline, cutsceneChecks } from '../src/index.ts';
import { bakeMotion, motionReport, apronReport, RUN_FORM } from '../src/motion.ts';
import { compilePerformance, performanceReport, autoPerformance, lineWords } from '../src/performance.ts';
import { godotCutsceneScene } from '../../game/src/cutscene.ts';

before(async () => { await initKernel(); });

const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
function scene() {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-character', { name: 'Blacksmith', preset: 'blacksmith' });
  ok('new-character', { name: 'Apprentice', preset: 'apprentice' });
  ok('move-object', { object: 'blacksmith', position: [0, 0, 0], rotation: 90 });
  ok('move-object', { object: 'apprentice', position: [1.3, 0, 0.1], rotation: -90 });
  const line = (o: string, id: string, text: string, dur: number, emotion: string) => {
    const cues = [{ start: 0, end: 0.15, shape: 'X' }, { start: 0.15, end: dur * 0.45, shape: 'C' }, { start: dur * 0.45, end: dur * 0.55, shape: 'X' }, { start: dur * 0.55, end: dur - 0.15, shape: 'D' }, { start: dur - 0.15, end: dur, shape: 'X' }];
    ok('set-line', { object: o, id, line: { text, audio: 'x.wav', emotion, duration: dur, fps: 30, cues, curves: curvesFromCues(cues, dur, 30), aligner: 'test' } });
  };
  line('blacksmith', 'l1', 'Hold still. This will only take a second.', 2.6, 'firm');
  line('apprentice', 'l2', 'Is it supposed to glow like that?', 2.0, 'scared');
  return { s, ok, rig: (id: string) => s.evaluate(s.doc().objects[id]).rig!.rig };
}

test('the apron swings and bends with the legs (never behind a knee); a board-like apron fails the check', () => {
  const { s, rig } = scene();
  const o = s.doc().objects.blacksmith;
  assert.ok(rig('blacksmith').bones.some((b) => b.name === 'ApronLower'), 'apron bones on the blacksmith');
  assert.ok(!rig('apprentice').bones.some((b) => b.name === 'ApronUpper'), 'no apron bones without an apron');
  for (const kind of ['walk', 'run'] as const) {
    const c = bakeMotion('m', { kind }, rig('blacksmith'), o.character);
    const a = apronReport(rig('blacksmith'), c)!;
    assert.ok(a.pass && a.bend >= 3 && a.swing >= 10, `${kind}: ${a.detail}`);
  }
  // pin the apron rigid: the check calls it a board
  const c = bakeMotion('m', { kind: 'walk' }, rig('blacksmith'), o.character);
  const il = rig('blacksmith').bones.findIndex((b) => b.name === 'ApronLower');
  for (const q of c.local) q[il] = [0, 0, 0, 1];
  const iu = rig('blacksmith').bones.findIndex((b) => b.name === 'ApronUpper');
  for (const q of c.local) q[iu] = [0, 0, 0, 1];
  assert.equal(apronReport(rig('blacksmith'), c)!.pass, false);
});

test('a run reads as a run: flight, lean, heel recovery, 150–195 steps/min, no crouch — at jog and sprint speeds', () => {
  const { rig } = scene();
  for (const speed of [3.4, 6]) {
    const c = bakeMotion('run', { kind: 'run', speed }, rig('apprentice'), undefined);
    const r = motionReport(rig('apprentice'), c);
    assert.ok(r.pass, `${speed} m/s: ${r.detail}`);
    assert.ok(r.run!.flight >= RUN_FORM.flight && r.run!.cadence >= 150 && r.run!.cadence <= 195 && r.run!.pelvis >= RUN_FORM.pelvis, JSON.stringify(r.run));
  }
});

test('the hammer strike winds up, comes down fast, softens the knees and settles; start/stop steps keep the feet planted and travel', () => {
  const { s, rig } = scene();
  const o = s.doc().objects.blacksmith;
  const st = motionReport(rig('blacksmith'), bakeMotion('strike', { kind: 'action', action: 'hammer-strike' }, rig('blacksmith'), o.character));
  assert.ok(st.pass && st.strike!.windup >= 0.4 && st.strike!.downswing <= 0.24 && st.strike!.dip >= 0.02, st.detail);
  for (const kind of ['start', 'stop'] as const) {
    const c = bakeMotion(kind, { kind }, rig('apprentice'), s.doc().objects.apprentice.character);
    const r = motionReport(rig('apprentice'), c);
    assert.ok(r.pass && r.slip <= 0.005, `${kind}: ${r.detail}`);
    assert.ok(c.travel && c.travel[2] > 0.15, `${kind} travels forward (${c.travel})`);
  }
});

test('perform: gestures land just before their word, move to the free hand when one holds a prop, the face shows the emotion; auto picks from the words', () => {
  const { s, ok, rig } = scene();
  ok('new-object', { name: 'Hammer', type: 'tool', material: 'oak', position: [0.3, 0, 0.5] });
  ok('add-op', { id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  ok('hold', { character: 'blacksmith', hand: 'right', prop: 'hammer' });
  const r = ok('perform', { object: 'blacksmith', line: 'l1', gestures: 'palm-down@still, point@this', emotion: 'firm' });
  const g = (r.result as any).gestures;
  assert.deepEqual(g.map((x: any) => [x.gesture, x.hand]), [['palm-down', 'left'], ['point', 'left']]);
  const words = lineWords(s.doc().objects.blacksmith.character!.lines!.l1);
  assert.ok(Math.abs(g[0].stroke - (words[1].stress - 0.08)) < 0.01, 'stroke just before the stressed syllable');
  const line = s.doc().objects.blacksmith.character!.lines!.l1;
  const clip = compilePerformance(rig('blacksmith'), s.doc().objects.blacksmith.character, line, line.performance!);
  const rep = performanceReport(rig('blacksmith'), line, line.performance!, clip, s.doc().objects.blacksmith.character);
  assert.ok(rep.pass, rep.detail);
  assert.ok(clip.shapes.browDownLeft[Math.floor(clip.local.length / 2)] > 0.2, 'firm brows');
  const bad = s.call('perform', { object: 'blacksmith', line: 'l1', gestures: 'point@anvil' });
  assert.match(bad.error!, /not a word/);
  const auto = autoPerformance(s.doc().objects.apprentice.character!.lines!.l2);
  assert.ok(auto.gestures!.length >= 1, JSON.stringify(auto));
  assert.ok(s.checks('blacksmith').some((c) => c.id === 'line-l1-performance' && c.pass));
});

test('a performed line exports as one full-body clip; the GLB validates', async () => {
  const { s, ok } = scene();
  ok('perform', { object: 'blacksmith', line: 'l1', auto: true });
  const o = s.doc().objects.blacksmith;
  const glb = toGLB([{ obj: o, res: s.evaluate(o) }], {});
  assert.equal((await validateGlb(glb)).errors, 0);
  const clip = json(glb).animations.find((a: any) => a.name === 'line:l1');
  assert.ok(clip.extras.performance && clip.channels.length > 20, 'bones + face in the line clip');
});

test('cutscene: shots resolve to a timeline; checks catch a speaker out of frame and a camera across the line; godot scene generated', () => {
  const { s, ok } = scene();
  ok('perform', { object: 'blacksmith', line: 'l1', auto: true });
  ok('new-cutscene', { id: 'lesson', title: 'The Lesson' });
  ok('set-shot', { cutscene: 'lesson', id: 'a', camera: { framing: 'medium', subject: 'blacksmith' }, lines: [{ character: 'blacksmith', line: 'l1', to: 'apprentice' }] });
  ok('set-shot', { cutscene: 'lesson', id: 'b', camera: { framing: 'over-shoulder', subject: 'apprentice', over: 'blacksmith' }, lines: [{ character: 'apprentice', line: 'l2' }] });
  const doc = s.doc();
  const tl = cutsceneTimeline(s, doc, (doc as any).cutscenes.lesson);
  assert.equal(tl.shots.length, 2);
  assert.ok(tl.cues[0].clip === 'line:l1' && tl.cues[1].t >= tl.shots[1].start);
  assert.ok(doc.objects.blacksmith.character!.lines!.l1.performance!.look, 'the line turns to its listener');
  assert.deepEqual(cutsceneChecks(s, doc, (doc as any).cutscenes.lesson).filter((c) => !c.pass).map((c) => c.detail), []);
  // a close-up on the apprentice while the blacksmith talks: out of frame; an explicit wrong side: across the line
  ok('set-shot', { cutscene: 'lesson', id: 'a', camera: { framing: 'close', subject: 'apprentice', side: 'left' } });
  const bad = cutsceneChecks(s, s.doc(), (s.doc() as any).cutscenes.lesson).filter((c) => !c.pass).map((c) => c.id);
  assert.ok(bad.includes('cutscene-lesson-framing'), bad.join(','));
  const tscn = godotCutsceneScene(tl as any, (a) => `res://a/${a}`, 'res://a/lesson.json');
  assert.match(tscn, /\[gd_scene/);
  assert.match(tscn, /tracks\/0\/path = NodePath\("CutCam:transform"\)/);
  assert.match(tscn, /"method": &"cue"/);
  assert.match(tscn, /type="AudioStream"/);
});
