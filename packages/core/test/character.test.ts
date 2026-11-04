// Phase 3 weeks 3–4 (Decisions 14, 19–22): the character kit, its skeleton and skin weights, face
// shapes, hands and holding, pose checks, glTF skin + morph export, and lip-sync curves from cues.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  initKernel, Studio, toGLB, validateGlb, exportGame, VISEMES, SHAPE_KEYS, curvesFromCues, restInSilence, syncOffset, lineChecks,
  localRotations, forward, poseVertices,
} from '../src/index.ts';

before(async () => { await initKernel(); });

const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
function kit(preset = 'default') {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-character', { name: 'Smith', preset });
  return { s, ok };
}
const failing = (s: Studio, id: string) => s.checks(id).filter((c) => !c.pass && !c.pending);

test('the kit builds a rigged character: humanoid bones incl. fingers/jaw/eyes, ≤ 4 weights, all checks pass', () => {
  const { s } = kit();
  const res = s.evaluate(s.doc().objects.smith);
  assert.ok(res.ok && res.rig);
  const names = res.rig!.rig.bones.map((b) => b.name);
  for (const b of ['Hips', 'Spine', 'Neck', 'Head', 'Jaw', 'LeftEye', 'RightEye', 'LeftHand', 'RightIndexProximal', 'LeftThumbDistal', 'RightLittleDistal', 'LeftFoot']) assert.ok(names.includes(b), `missing bone ${b}`);
  const { joints, weights } = res.rig!.rig as any;
  const n = res.rig!.rest.length / 3;
  for (let v = 0; v < n; v++) {
    let sum = 0, used = 0;
    for (let k = 0; k < 4; k++) { sum += weights[v * 4 + k]; if (weights[v * 4 + k] > 0) used++; }
    assert.ok(Math.abs(sum - 1) < 1e-3 && used >= 1 && used <= 4, `vertex ${v}: ${used} weights summing to ${sum}`);
  }
  assert.deepEqual(failing(s, 'smith').map((c) => c.label), []);
  assert.ok(s.checks('smith').some((c) => c.id === 'pose-checks' && c.pass), '10 canonical poses bend cleanly');
  void joints;
});

test('proportions change the build; bad params are explained', () => {
  const { s, ok } = kit();
  const h = (o: string) => { const r = s.evaluate(s.doc().objects[o]); return r.bbox!.max[1] - r.bbox!.min[1]; };
  ok('new-character', { name: 'Tall', height: 2.0 });
  assert.ok(h('tall') > h('smith') + 0.2);
  assert.equal(s.call('new-character', { name: 'X', height: 7 }).ok, false);
});

test('face shapes: 15 visemes + expressions; a viseme opens the mouth, a blink turns the lid bone', () => {
  const { s, ok } = kit();
  for (const v of VISEMES) assert.ok(SHAPE_KEYS.includes(v));
  const o = () => s.doc().objects.smith;
  const cr = s.evaluate(o()).rig!;
  const mouthGap = (expr: Record<string, number>) => {
    const posed = forward(cr.rig.bones, cr.rig.parents, localRotations(cr.rig, { expression: expr }));
    const P = poseVertices(cr.rig, cr.rest, posed, expr);
    let lo = Infinity;
    cr.vertPart.forEach((p, v) => { if (p === 'lipLower') lo = Math.min(lo, P[v * 3 + 1]); });
    return lo;
  };
  assert.ok(mouthGap({ aa: 1 }) < mouthGap({}) - 0.005, 'aa lowers the lower lip');
  const lid = cr.rig.bones.findIndex((b) => b.name === 'LeftUpperLid');
  const q = localRotations(cr.rig, { expression: { eyeBlinkLeft: 1 } })[lid];
  assert.ok(Math.abs(q[3]) < 0.99, 'blink rotates the lid bone');
  ok('set-expression', { values: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7 } });
  assert.deepEqual(o().character!.expression, { mouthSmileLeft: 0.7, mouthSmileRight: 0.7 });
  const bad = s.call('set-expression', { values: { smile: 1 } });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /mouthSmile/);
});

test('hands: named poses, and hold puts a hammer in the hand without fingers passing through it', () => {
  const { s, ok } = kit('blacksmith');
  ok('set-hand', { hand: 'left', pose: 'fist' });
  assert.equal(s.doc().objects.smith.character!.hands!.left!.name, 'fist');
  ok('new-object', { name: 'Hammer', type: 'tool', material: 'oak' });
  ok('add-op', { object: 'hammer', id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  ok('add-op', { object: 'hammer', id: 'head', op: 'box', part: 'head', args: { size: [0.11, 0.045, 0.045], at: [0, 0.33, 0] } });
  ok('add-op', { object: 'hammer', id: 'hammer', op: 'union', inputs: ['handle', 'head'], output: true });
  ok('hold', { character: 'smith', hand: 'right', prop: 'hammer' });
  const doc = s.doc();
  assert.equal(doc.objects.hammer.place?.kind, 'held');
  assert.ok(doc.objects.hammer.grip?.kind === 'power');
  const hold = s.checks('smith').find((c) => c.id === 'hold-right');
  assert.ok(hold?.pass, hold?.detail);
  ok('release', { character: 'smith', hand: 'right' });
  assert.notEqual(s.doc().objects.hammer.place?.kind, 'held');
});

test('export: GLB with skin, sparse morph targets and line clips passes the validator; budgets per profile', async () => {
  const { s, ok } = kit();
  const curves = curvesFromCues([{ start: 0, end: 0.2, shape: 'X' }, { start: 0.2, end: 0.35, shape: 'A' }, { start: 0.35, end: 0.6, shape: 'D' }, { start: 0.6, end: 1, shape: 'X' }], 1, 30);
  ok('set-line', { object: 'smith', id: 'hi', line: { text: 'Mah', audio: 'none.wav', emotion: 'neutral', duration: 1, fps: 30, cues: [], curves, aligner: 'test' } });
  const obj = s.doc().objects.smith;
  const glb = toGLB([{ obj, res: s.evaluate(obj) }], {});
  const v = await validateGlb(glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages));
  const j = json(glb);
  assert.equal(j.skins.length, 1);
  assert.ok(j.skins[0].joints.length >= 55);
  const prims = j.meshes.flatMap((m: any) => m.primitives);
  assert.ok(prims.every((p: any) => p.targets.length === SHAPE_KEYS.length), 'every primitive carries every shape');
  const targets = prims.flatMap((p: any) => p.targets);
  assert.ok(targets.every((t: any) => j.accessors[t.POSITION].bufferView === undefined), 'no dense morph targets');
  const used = new Set(prims.flatMap((p: any) => p.targets.map((t: any, i: number) => (j.accessors[t.POSITION].sparse ? i : -1))).filter((i: number) => i >= 0));
  assert.ok(used.size >= 25, `face shapes stored sparse (${used.size})`);
  assert.deepEqual(j.animations.map((a: any) => a.name).sort(), ['idle', 'line:hi', 'pose', 'start', 'stop', 'walk']);
  // web-mobile: finger bones folded into the hand, shape budget enforced
  ok('set-profile', { object: 'smith', profile: 'web-mobile' });
  assert.ok(s.checks('smith').find((c) => c.id === 'budget-shapes'));
  const g = await exportGame([{ obj: s.doc().objects.smith, res: s.evaluate(s.doc().objects.smith) }], { target: 'web', baker: null, evaluateOp: (o, id) => s.evaluateOp(o, id) });
  const gj = json(g.glb);
  assert.ok(gj.skins[0].joints.length < j.skins[0].joints.length - 20, 'no finger bones on web-mobile');
  assert.equal((await validateGlb(g.glb)).errors, 0);
});

test('lip sync: closures always close, open shapes ease in and out, rests in pauses, sync measured', () => {
  const cues = [{ start: 0, end: 0.1, shape: 'X' }, { start: 0.1, end: 0.14, shape: 'A' }, { start: 0.14, end: 0.5, shape: 'C' }, { start: 0.5, end: 1.2, shape: 'D' }, { start: 1.2, end: 1.5, shape: 'X' }];
  const c = curvesFromCues(cues, 1.5, 30, 'neutral');
  for (const k of VISEMES) assert.equal(c[k].length, c.sil.length);
  assert.equal(c.PP[Math.round(0.12 * 30)], 1, 'M/B/P fully closed even when the cue is short');
  assert.ok(c.aa[Math.round(0.8 * 30)] > 0.9 && c.aa[Math.round(0.45 * 30)] < c.aa[Math.round(0.8 * 30)], 'aa eases in');
  const loud = c.aa.map((_, f) => (f / 30 > 0.1 && f / 30 < 1.2 ? 1 : 0));
  // energy envelope at 100 fps: voiced 0.1–1.2 s except a pause 0.7–0.95 s
  const energy = Array.from({ length: 150 }, (_, i) => (i >= 10 && i < 120 && !(i >= 70 && i < 95) ? 0.8 : 0));
  const rested = restInSilence(cues, energy, 100);
  assert.ok(rested.some((q) => q.shape === 'X' && q.start > 0.7 && q.end < 0.95), 'the pause inside "D" becomes a rest');
  const c2 = curvesFromCues(rested, 1.5, 30);
  assert.ok(Math.abs(syncOffset(c2, 30, energy, 100)) <= 30, 'in sync');
  const shifted = Array.from({ length: 150 }, (_, i) => energy[i - 20] ?? 0);   // voice 200 ms later than the mouth
  assert.ok(syncOffset(c2, 30, shifted, 100) <= -150, 'mouth leading the voice is measured');
  const checks = lineChecks('t', { text: 'x', audio: '', emotion: 'neutral', duration: 1.5, fps: 30, cues, curves: c, aligner: 't', sync: 10 });
  assert.ok(checks.every((x) => x.pass), JSON.stringify(checks));
  const held = lineChecks('t', { text: 'x', audio: '', emotion: 'neutral', duration: 3, fps: 30, cues: [{ start: 0, end: 3, shape: 'D' }], curves: curvesFromCues([{ start: 0, end: 3, shape: 'D' }], 3, 30), aligner: 't', sync: 200 });
  assert.deepEqual(held.filter((x) => !x.pass).map((x) => x.id).sort(), ['line-t-held', 'line-t-sync']);
  void loud;
});
