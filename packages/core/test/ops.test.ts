// Tests for the thickened op vocabulary, pending checks, STL export and set-params units.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, toSTL } from '../src/index.ts';

before(async () => { await initKernel(); });

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

function studioWith(ops: Array<[string, object]>) {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Thing', type: 'prop' });
  for (const [t, a] of ops) ok(t, a);
  return { s, info: s.call('inspect').result as any, ok };
}

test('roundedBox keeps its size and rounds edges (less volume than a box)', () => {
  const { info } = studioWith([['add-op', { id: 'a', op: 'roundedBox', args: { size: [0.4, 0.04, 0.4], r: 0.01, at: [0, 0.02, 0] } }]]);
  assert.ok(near(info.bbox.max[0] - info.bbox.min[0], 0.4));
  assert.ok(info.stats.volume_m3 < 0.4 * 0.04 * 0.4);
  assert.equal(info.stats.components, 1);
});

test('extrude works on all three axes, either winding, and a numeric scaleTop does not collapse', () => {
  const tri = [[-1, 0], [1, 0], [0, 1]];
  for (const [axis, size] of [['y', [2, 3, 1]], ['z', [2, 1, 3]], ['x', [3, 1, 2]]] as const) {
    for (const prof of [tri, [...tri].reverse()]) {
      const { info } = studioWith([['add-op', { id: 'a', op: 'extrude', args: { profile: prof, h: 3, axis } }]]);
      const d = [0, 1, 2].map((k) => info.bbox.max[k] - info.bbox.min[k]);
      assert.deepEqual(d.map((x) => +x.toFixed(3)), size, `axis ${axis}`);
      assert.ok(near(info.stats.volume_m3, 3), `axis ${axis} volume ${info.stats.volume_m3}`);
    }
  }
  // Regression: the JS binding turns scaleTop: n into [n, 0]; we always pass a pair.
  const { info } = studioWith([['add-op', { id: 'a', op: 'extrude', args: { profile: [[-1, 2], [1, 2], [0, 3]], h: 2, axis: 'z', scaleTop: 1 } }]]);
  assert.ok(near(info.bbox.min[1], 2), `min y ${info.bbox.min[1]}`);
});

test('revolve makes a lathe; a ring profile makes a hollow vessel', () => {
  const solid = studioWith([['add-op', { id: 'a', op: 'revolve', args: { profile: [[0, 0], [0.1, 0], [0.1, 0.3], [0, 0.3]] } }]]).info;
  assert.ok(near(solid.bbox.max[1], 0.3) && near(solid.bbox.max[0], 0.1, 2e-3));
  const ring = studioWith([['add-op', { id: 'a', op: 'revolve', args: { profile: [[0, 0], [0.1, 0], [0.1, 0.3], [0.09, 0.3], [0.09, 0.01], [0, 0.01]] } }]]).info;
  assert.ok(ring.stats.volume_m3 < solid.stats.volume_m3 * 0.3, 'hollow vessel uses far less material');
});

test('smooth subdivides, round grows by r, trim cuts at the floor', () => {
  const box = { id: 'b', op: 'box', args: { size: [0.2, 0.2, 0.2], at: [0, 0, 0] } };
  const sm = studioWith([['add-op', box], ['add-op', { id: 'a', op: 'smooth', inputs: ['b'], args: { levels: 2 }, output: true }]]).info;
  assert.ok(sm.stats.triangles > 12 * 4);
  const rd = studioWith([['add-op', box], ['add-op', { id: 'a', op: 'round', inputs: ['b'], args: { r: 0.02 }, output: true }]]).info;
  assert.ok(near(rd.bbox.max[0], 0.12));
  const tr = studioWith([['add-op', box], ['add-op', { id: 'a', op: 'trim', inputs: ['b'], output: true }]]).info;
  assert.ok(near(tr.bbox.min[1], 0) && near(tr.bbox.max[1], 0.1));
  assert.ok(!tr.parts.some((p: any) => p.name === 'unknown'), 'cut faces are named ~cut, not unknown');
});

test('splayed legs + trim: grounded and nothing below the floor', () => {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Stool', type: 'stool' });
  ok('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: { value: 10, unit: 'deg' } } });
  ok('add-op', { id: 'seat', op: 'roundedBox', part: 'seat', args: { size: ['$seatW', '$seatT', '$seatW'], r: 0.008, at: [0, '$seatH - $seatT/2', 0] } });
  ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: '$legR', h: '($seatH - $seatT) / cos($legSplay) + 0.01' } });
  ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.05, splay: '$legSplay' } });
  ok('add-op', { id: 'body', op: 'union', inputs: ['seat', 'legs'], output: false });
  const r = ok('add-op', { id: 'stool', op: 'trim', inputs: ['body'], output: true });
  assert.equal(r.checks!.stool.failed, 0, JSON.stringify(r.checks!.stool.failures));
  assert.equal((s.doc().objects.stool.params.legSplay as any).unit, 'deg', 'set-params can set units');
});

test('in-progress states are pending, not failures', () => {
  const s = new Studio();
  const r1 = s.call('new-object', { name: 'Stool', type: 'stool' });
  assert.equal(r1.checks!.stool.failed, 0);
  assert.ok(r1.checks!.stool.pending!.length > 0);
  s.call('add-op', { id: 'seat', op: 'box', args: { size: [0.3, 0.03, 0.3], at: [0, 0.45, 0] } });
  const r2 = s.call('add-op', { id: 'leg', op: 'cylinder', part: 'leg', args: { r: 0.015, h: 0.4 }, output: false });
  assert.equal(r2.checks!.stool.failed, 0, 'an unused op and no legs yet are pending');
  assert.ok(r2.checks!.stool.pending!.some((p) => /not connected/.test(p)));
});

test('check always returns { objectId: results } with a summary', () => {
  const { s } = studioWith([['add-op', { id: 'a', op: 'box', args: { size: [1, 1, 1], at: [0, 0.5, 0] } }]]);
  for (const r of [s.call('check'), s.call('check', { object: 'thing' })]) {
    assert.ok(Array.isArray((r.result as any).thing));
    assert.match(r.summary!, /checks pass|failing/);
  }
});

test('STL export: binary, millimetres, Z-up', () => {
  const { s } = studioWith([['add-op', { id: 'a', op: 'box', args: { size: [0.1, 0.2, 0.3], at: [0, 0.1, 0] } }]]);
  const doc = s.doc();
  const buf = toSTL(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  assert.equal(buf.byteLength, 84 + n * 50);
  let zmax = -Infinity, ymax = -Infinity;
  for (let t = 0; t < n; t++) for (let v = 0; v < 3; v++) {
    ymax = Math.max(ymax, dv.getFloat32(84 + t * 50 + 12 + v * 12 + 4, true));
    zmax = Math.max(zmax, dv.getFloat32(84 + t * 50 + 12 + v * 12 + 8, true));
  }
  assert.ok(near(zmax, 200, 0.01), `height becomes Z in mm (got ${zmax})`);
  assert.ok(near(ymax, 150, 0.01), `depth becomes Y in mm (got ${ymax})`);
});
