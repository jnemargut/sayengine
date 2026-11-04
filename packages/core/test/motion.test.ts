// Phase 3 week 5 (Decisions 16, 22, 23): parametric motion baked onto the kit's skeleton (walk, run,
// idle, turn, library actions) with IK legs and planted feet, the life layer in idle and lines, hands
// and held props carried through motion, and the clips in glTF.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, toGLB, validateGlb, exportGame, curvesFromCues } from '../src/index.ts';
import { bakeMotion, motionReport, ACTIONS } from '../src/motion.ts';
import { lineLife } from '../src/life.ts';

before(async () => { await initKernel(); });

const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
function kit(preset = 'default', extra: Record<string, unknown> = {}) {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-character', { name: 'Smith', preset, ...extra });
  return { s, ok, rig: () => s.evaluate(s.doc().objects.smith).rig!.rig };
}

test('every motion kind and library action bakes with planted feet, nothing below the floor, closed loops', () => {
  const { s, rig } = kit();
  const specs: any[] = [{ kind: 'walk' }, { kind: 'run' }, { kind: 'idle' }, { kind: 'turn', turn: 90 }, { kind: 'turn', turn: -160 }, ...Object.keys(ACTIONS).map((a) => ({ kind: 'action', action: a }))];
  for (const spec of specs) {
    const c = bakeMotion('m', spec, rig(), s.doc().objects.smith.character);
    const r = motionReport(rig(), c);
    assert.ok(r.pass, `${spec.action ?? spec.kind}: ${r.detail}`);
    assert.ok(r.slip < 0.005, `${spec.action ?? spec.kind} slip ${r.slip}`);
    if (c.loop) assert.ok(r.loopGap < 0.5, `${spec.kind} loop gap ${r.loopGap}°`);
  }
});

test('walk fits the body: longer legs → longer stride at the same speed; faster → longer and quicker', () => {
  const short = kit('default', { legLength: 0.85 }), long = kit('default', { legLength: 1.2 });
  const a = bakeMotion('walk', { kind: 'walk', speed: 1.3 }, short.rig(), undefined);
  const b = bakeMotion('walk', { kind: 'walk', speed: 1.3 }, long.rig(), undefined);
  assert.ok(b.stride! > a.stride! * 1.15, `stride ${a.stride} → ${b.stride}`);
  const slow = bakeMotion('walk', { kind: 'walk', speed: 0.8 }, short.rig(), undefined);
  const fast = bakeMotion('walk', { kind: 'walk', speed: 1.9 }, short.rig(), undefined);
  assert.ok(fast.stride! > slow.stride! && fast.duration < slow.duration);
  assert.ok(Math.abs(fast.speed - 1.9) < 0.1, `speed kept (${fast.speed})`);
  // a planted foot moves back at exactly the clip's speed (so a game moving the node at that speed doesn't skate)
  assert.ok(motionReport(long.rig(), b).slip < 0.003);
});

test('new characters can stand and walk; set-motion adds, tunes and explains; checks run per motion', () => {
  const { s, ok } = kit('blacksmith');
  assert.deepEqual(Object.keys(s.doc().objects.smith.character!.motions!).sort(), ['idle', 'walk']);
  ok('set-motion', { object: 'smith', id: 'walk', speed: 1.0, energy: 0.2 });
  assert.deepEqual(s.doc().objects.smith.character!.motions!.walk, { kind: 'walk', speed: 1, energy: 0.2 });
  ok('set-motion', { object: 'smith', id: 'strike', kind: 'action', action: 'hammer-strike' });
  const bad = s.call('set-motion', { object: 'smith', id: 'hi', kind: 'action', action: 'wav' });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /wave/);
  const noKind = s.call('set-motion', { object: 'smith', id: 'jog', speed: 2 });
  assert.match(noKind.error!, /--kind/);
  const tooFast = s.call('set-motion', { object: 'smith', id: 'walk', speed: 5 });
  assert.match(tooFast.error!, /speed must be between/);
  const checks = s.checks('smith').filter((c) => c.id.startsWith('motion-'));
  assert.equal(checks.length, 6, checks.map((c) => c.id).join(','));
  assert.deepEqual(checks.filter((c) => !c.pass).map((c) => `${c.label}: ${c.detail}`), []);
  const m = s.call('motions', { object: 'smith' });
  assert.ok(m.ok && m.result.motions.strike.duration > 1 && m.result.actions.wave);
  ok('remove-motion', { object: 'smith', id: 'strike' });
});

test('life: idle breathes, shifts weight, blinks and glances, and loops; lines breathe and nod', () => {
  const { s, rig } = kit();
  const c = bakeMotion('idle', { kind: 'idle', duration: 8 }, rig(), s.doc().objects.smith.character);
  const blinks = c.shapes.eyeBlinkLeft;
  assert.ok(blinks.filter((v, i) => v >= 0.99 && !(blinks[i - 1] >= 0.99)).length >= 2, 'blinks during an 8 s idle');
  assert.equal(blinks[0], 0); assert.equal(blinks[c.frames], 0);
  const xs = c.hips.map((h) => h[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.02, 'weight shifts side to side');
  const hi = rig().bones.findIndex((b) => b.name === 'UpperChest');
  const ws = c.local.map((q) => q[hi][0]);
  assert.ok(Math.max(...ws) - Math.min(...ws) > 0.005, 'the chest breathes');
  const eye = rig().bones.findIndex((b) => b.name === 'LeftEye');
  assert.ok(c.local.some((q) => Math.abs(q[eye][1]) > 0.02), 'the eyes glance away');
  // the same seed gives the same idle
  assert.deepEqual(bakeMotion('idle', { kind: 'idle', duration: 8 }, rig(), undefined).shapes, bakeMotion('idle', { kind: 'idle', duration: 8 }, rig(), undefined).shapes);
  const curves = curvesFromCues([{ start: 0, end: 0.3, shape: 'X' }, { start: 0.3, end: 1.2, shape: 'D' }, { start: 1.2, end: 1.5, shape: 'X' }, { start: 1.5, end: 2.6, shape: 'C' }, { start: 2.6, end: 3, shape: 'X' }], 3, 30);
  const life = lineLife({ text: 'Bring me the hammer, and mind the embers.', duration: 3, fps: 30, cues: [{ start: 0, end: 0.3, shape: 'X' }, { start: 0.3, end: 1.2, shape: 'D' }, { start: 1.2, end: 1.5, shape: 'X' }, { start: 1.5, end: 2.6, shape: 'C' }, { start: 2.6, end: 3, shape: 'X' }], emotion: 'firm' });
  void curves;
  assert.ok(life.body && Math.max(...life.body.breath) > 0.5 && life.body.headYaw.some((v) => v !== 0));
});

test('export: walk/idle/action clips in place with speed, hips translation, blinks; validator clean', async () => {
  const { s, ok } = kit('blacksmith');
  ok('set-motion', { object: 'smith', id: 'wave', kind: 'action', action: 'wave' });
  const obj = s.doc().objects.smith;
  const glb = toGLB([{ obj, res: s.evaluate(obj) }]);
  const v = await validateGlb(glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages));
  const j = json(glb);
  const walk = j.animations.find((a: any) => a.name === 'walk');
  assert.equal(walk.extras.motion, 'walk');
  assert.ok(walk.extras.loop && walk.extras.speed > 1 && walk.extras.stride > 0.8);
  const paths = walk.channels.map((c: any) => `${j.nodes[c.target.node].name ?? ''}.${c.target.path}`);
  for (const want of ['Hips.translation', 'LeftUpperLeg.rotation', 'RightLowerLeg.rotation', 'LeftFoot.rotation', 'LeftUpperArm.rotation', 'Smith.weights']) assert.ok(paths.includes(want), `walk animates ${want}`);
  assert.equal(j.animations.find((a: any) => a.name === 'wave').extras.loop, false);
});

test('a held hammer rides on the hand joint (follows every clip); two characters get prefixed clip names', async () => {
  const { s, ok } = kit('blacksmith');
  ok('new-object', { name: 'Hammer', type: 'tool', material: 'oak' });
  ok('add-op', { object: 'hammer', id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  ok('add-op', { object: 'hammer', id: 'head', op: 'box', part: 'head', args: { size: [0.11, 0.045, 0.045], at: [0, 0.33, 0] } });
  ok('add-op', { object: 'hammer', id: 'hammer', op: 'union', inputs: ['handle', 'head'], output: true });
  ok('hold', { character: 'smith', hand: 'right', prop: 'hammer' });
  ok('set-motion', { object: 'smith', id: 'strike', kind: 'action', action: 'hammer-strike' });
  const strike = s.checks('smith').filter((c) => c.id.startsWith('motion-strike'));
  assert.ok(strike.every((c) => c.pass), strike.map((c) => c.detail).join('; '));
  ok('new-character', { name: 'Apprentice', preset: 'default', position: [2, 0, 0] });
  const doc = s.doc();
  const items = doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) }));
  const g = await exportGame(items, { target: 'godot', baker: null, evaluateOp: (o, id) => s.evaluateOp(o, id) });
  const v = await validateGlb(g.glb);
  assert.equal(v.errors, 0, JSON.stringify(v.messages));
  const j = json(g.glb);
  const hand = j.nodes.find((n: any) => n.name === 'RightHand' && (n.children ?? []).some((c: number) => j.nodes[c].name === 'Hammer'));
  assert.ok(hand, 'the hammer node is a child of the right hand joint');
  const names = j.animations.map((a: any) => a.name);
  for (const want of ['smith:walk', 'smith:idle', 'smith:strike', 'smith:pose', 'apprentice:walk', 'apprentice:idle']) assert.ok(names.includes(want), `${want} in ${names.join(', ')}`);
});
