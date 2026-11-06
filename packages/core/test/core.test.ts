// Core engine tests — run with `npm test` (node --test).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, evalExpr, toGLB, History } from '../src/index.ts';

before(async () => { await initKernel(); });

function stool(s: Studio, splay = 0, legH = '($seatH - $seatT) / cos($legSplay)') {
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33' });
  ok('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: splay } });
  ok('add-op', { id: 'seat', op: 'box', args: { size: ['$seatW', '$seatT', '$seatW'], at: [0, '$seatH - $seatT/2', 0] } });
  ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', args: { r: '$legR', h: legH }, output: false });
  ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' }, output: false });
  return ok('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'], output: true });
}

test('expressions: params, functions, errors', () => {
  assert.equal(evalExpr('$a * 2 + 1', { a: 3 }), 7);
  assert.ok(Math.abs(evalExpr('cos(60)', {}) - 0.5) < 1e-12);
  assert.equal(evalExpr('max(1, $b) - (2 ^ 2)', { b: 9 }), 5);
  assert.throws(() => evalExpr('$missing + 1', {}), /unknown parameter/);
  assert.throws(() => evalExpr('process.exit()', {}), /unexpected|unknown/);
});

test('stool builds, is watertight, connected and grounded', () => {
  const s = new Studio();
  const r = stool(s);
  const c = r.checks!['walnut-stool'];
  assert.equal(c.failed, 0, JSON.stringify(c.failures));
  const info: any = s.call('inspect').result;
  assert.equal(info.parts.filter((p: any) => p.name.startsWith('leg#')).length, 4);
  assert.ok(Math.abs(info.bbox.max[1] - 0.45) < 1e-6);
});

test('checks catch floating legs (the D6 example)', () => {
  const s = new Studio();
  stool(s, 0, '$seatH - $seatT - 0.004'); // 4 mm short
  const checks: any[] = s.call('check').result as any;
  const grounded = (checks as any)['walnut-stool'].find((c: any) => c.id.startsWith('grounded'));
  assert.equal(grounded.pass, false);
  assert.match(grounded.detail, /floats 4\.0 mm above/);
  assert.deepEqual(grounded.parts.sort(), ['leg#1', 'leg#2', 'leg#3', 'leg#4']);
});

test('proposal: per-step undo with dependents, then commit kept steps', () => {
  const s = new Studio();
  stool(s);
  const mainBefore = s.history.data.mainHead;
  assert.ok(s.call('propose', { title: 'Splay + trim' }).ok);
  s.call('set-param', { name: 'legSplay', value: 8, unit: 'deg' });
  s.call('add-op', { id: 'floorCut', op: 'box', args: { size: [2, 0.2, 2], at: [0, -0.1, 0] }, output: false });
  s.call('add-op', { id: 'legsTrim', op: 'difference', inputs: ['legs', 'floorCut'], output: false });
  s.call('set-op', { id: 'stool', inputs: ['seat', 'legsTrim'] });
  s.call('set-material', { color: '#5a3d2b' });
  const p: any = (s.call('proposals').result as any[])[0];
  assert.equal(p.steps.length, 5);
  assert.ok(p.allPass, JSON.stringify(p.checks));
  // Undoing the floor cut must also undo the trim (references floorCut) and the rewire (references legsTrim).
  const u: any = s.call('undo-step', { step: 2 }).result;
  assert.deepEqual(u.alsoUndone.length, 2);
  const after: any = (s.call('proposals').result as any[])[0];
  assert.deepEqual(after.steps.map((x: any) => x.undone), [false, true, true, true, false]);
  const r: any = s.call('commit-proposal').result;
  assert.equal(r.merged.length, 2);
  assert.equal(s.history.data.active, 'main');
  assert.notEqual(s.history.data.mainHead, mainBefore);
  const doc = s.doc();
  assert.equal(doc.objects['walnut-stool'].params.legSplay.value, 8);
  assert.equal(doc.objects['walnut-stool'].material.color, '#5a3d2b');
  assert.equal(doc.objects['walnut-stool'].ops.floorCut, undefined);
});

test('undo is a new commit and history survives a save/load round trip', () => {
  const s = new Studio();
  stool(s);
  s.call('set-param', { name: 'seatH', value: 0.6 });
  const u = s.call('undo');
  assert.ok(u.ok);
  assert.equal(s.doc().objects['walnut-stool'].params.seatH.value, 0.45);
  const data = JSON.parse(JSON.stringify(s.history.data));
  const s2 = new Studio(data);
  assert.deepEqual(s2.doc(), s.doc());
  assert.equal(new History(data).chain(data.mainHead).length, 8);
});

test('undo reverts your own last step: a human drag in between is skipped, not undone instead', () => {
  const s = new Studio();
  const parts = [{ kind: 'body', shape: 'capsule', size: [0.3, 0.2, 0.6], height: 0.3, color: '#7d6553' }];
  const ok = (t: string, a: object, author = 'claude') => { const r = s.call(t, a, author); assert.ok(r.ok, `${t}: ${r.error}`); return r as any; };
  ok('new-object', { name: 'Vase', type: 'vase' });
  // the reported sequence: new-creature → undo → new-creature → (the human drags it) → undo → new-creature
  ok('new-creature', { name: 'Mop Lips', id: 'mop-lips', parts });
  assert.equal(ok('undo', {}).result.reverted, 'c2');
  ok('new-creature', { name: 'Mop Lips', id: 'mop-lips', parts: [{ ...parts[0], color: '#c2414c' }] });
  ok('drag-object', { object: 'mop-lips', by: [0.2, 0] }, 'human');
  const u = ok('undo', {});
  assert.equal(s.history.commit(u.result.reverted).tool, 'new-creature');
  assert.equal(s.doc().objects['mop-lips'], undefined, 'the second creature is gone');
  assert.deepEqual(s.doc().objectOrder, ['vase']);
  assert.ok(u.result.alsoDrops?.some((x: string) => /human/.test(x)), 'says the human\'s drag went with it');
  ok('new-creature', { name: 'Mop Lips', id: 'mop-lips', parts });
  assert.deepEqual(s.doc().objectOrder, ['vase', 'mop-lips'], 'no mop-lips-2, no old copy');
  assert.equal(s.doc().objects['mop-lips'].creature!.def.parts[0].color, '#7d6553');
  // undo, undo walks back through your own steps; the scene order keeps later additions
  ok('new-object', { name: 'Cup', type: 'cup' }, 'human');
  ok('set-material', { object: 'mop-lips', color: '#123456' });
  ok('undo', {});
  ok('undo', {});
  assert.deepEqual(s.doc().objectOrder, ['vase', 'cup']);
  // the human's undo undoes the human's step; --step reverts one given step; undoing an undo brings it back
  ok('undo', {}, 'human');
  assert.deepEqual(s.doc().objectOrder, ['vase']);
  const last = s.history.data.mainHead!;
  ok('undo', { step: last });
  assert.deepEqual(s.doc().objectOrder, ['vase', 'cup']);
  // history round-trips
  const s2 = new Studio(JSON.parse(JSON.stringify(s.history.data)));
  assert.deepEqual(s2.doc(), s.doc());
});

test('validation errors are actionable, not crashes', () => {
  const s = new Studio();
  stool(s);
  const r = s.call('add-op', { id: 'x', op: 'union', inputs: ['nope'] });
  assert.equal(r.ok, false);
  assert.match(r.error!, /input "nope" does not exist/);
  const bad = s.call('add-op', { id: 'y', op: 'placeAt', inputs: ['leg'], args: { target: 'seat', anchor: 'corners:middle' } });
  assert.match(bad.error!, /anchor must be one of/);
  const typo = s.call('set-param', { name: 'seatH' });
  assert.equal(typo.ok, false);
  assert.match(typo.error!, /value/);
});

test('GLB export has a valid header', () => {
  const s = new Studio();
  stool(s);
  const doc = s.doc();
  const glb = toGLB([{ obj: doc.objects['walnut-stool'], res: s.evaluate(doc.objects['walnut-stool']) }]);
  const dv = new DataView(glb.buffer);
  assert.equal(dv.getUint32(0, true), 0x46546c67);
  assert.equal(dv.getUint32(8, true), glb.length);
});
