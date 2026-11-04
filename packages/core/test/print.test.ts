// Printing path (Decisions 43–46): print profile + checks, the text / hole / split / chamfer ops,
// print-fix, the fit-test coupon and recorded fit gaps.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, onFitRecorded, setFitDefaults, DEFAULT_FIT, textOutline, type FitGaps } from '../src/index.ts';

before(async () => { await initKernel(); });

function studio() {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  return { s, ok };
}
const check = (s: Studio, obj: string, id: string) => s.checks(obj).find((c) => c.id === id)!;

/** An open-top box with walls of thickness t (metres). */
function box(t: number, size: [number, number, number] = [0.06, 0.03, 0.04]) {
  const { s, ok } = studio();
  ok('new-object', { name: 'Box', type: 'box' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'outer', op: 'box', args: { size, at: [0, size[1] / 2, 0] } });
  ok('add-op', { id: 'inner', op: 'box', output: false, args: { size: [size[0] - 2 * t, size[1], size[2] - 2 * t], at: [0, 0.002 + size[1] / 2, 0] } });
  ok('add-op', { id: 'body', op: 'difference', inputs: ['outer', 'inner'], output: true });
  return { s, ok };
}

test('a print profile adds print checks and the fit-gap params', () => {
  const { s } = box(0.002);
  const o = s.doc().objects.box;
  assert.equal(o.print?.printer, 'a1-mini');
  assert.equal(o.params.fitSlide.value, DEFAULT_FIT.slide);
  for (const id of ['print-bed', 'print-sealed', 'print-walls', 'print-overhangs', 'print-base']) assert.ok(check(s, 'box', id), id);
  assert.ok(check(s, 'box', 'print-bed').pass);
  assert.match(check(s, 'box', 'print-walls').detail, /thinnest wall 2\.00 mm/);
  assert.equal(s.checks('box').filter((c) => !c.pass).length, 0, JSON.stringify(s.checks('box').filter((c) => !c.pass)));
});

test('walls thinner than two nozzle lines fail; too big for the bed fails', () => {
  const thin = box(0.0005);
  const w = check(thin.s, 'box', 'print-walls');
  assert.equal(w.pass, false, w.detail);
  assert.match(w.detail, /thinner than 0\.8 mm/);
  const big = box(0.003, [0.2, 0.02, 0.05]);
  const b = check(big.s, 'box', 'print-bed');
  assert.equal(b.pass, false);
  assert.match(b.detail, /mm too wide/);
});

test('text: solid letters at the asked cap height; small text is flagged', () => {
  const o = textOutline('JM', 0.012);
  assert.ok(Math.abs(o.height - 0.012) < 1e-9);
  assert.ok(o.width > 0.012 && o.width < 0.025, `width ${o.width}`);
  const { s, ok } = studio();
  ok('new-object', { name: 'Tag', type: 'tag' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'plate', op: 'box', args: { size: [0.04, 0.003, 0.02], at: [0, 0.0015, 0] } });
  ok('add-op', { id: 'txt', op: 'text', output: false, args: { text: 'Hi', size: 0.003, depth: 0.0006, at: [0, 0.003, 0] } });
  ok('add-op', { id: 'tag', op: 'union', inputs: ['plate', 'txt'], output: true });
  const r = s.evaluate(s.doc().objects.tag);
  assert.ok(r.ok, r.error);
  assert.ok(r.bbox!.max[1] > 0.0035, 'letters stand 0.6 mm above the plate');
  const w = check(s, 'tag', 'print-walls');
  assert.equal(w.pass, false);
  assert.match(w.detail, /text "txt" strokes are 0\.\d+ mm/);
});

test('hole: an M3 clearance hole removes a 3.4 mm cylinder', () => {
  const { s, ok } = studio();
  ok('new-object', { name: 'Block', type: 'block' });
  ok('add-op', { id: 'b', op: 'box', args: { size: [0.02, 0.01, 0.02], at: [0, 0.005, 0] } });
  const full = s.evaluate(s.doc().objects.block).volume;
  ok('add-op', { id: 'h', op: 'hole', output: false, args: { size: 'M3', depth: 0.01, at: [0, 0.01, 0] } });
  ok('add-op', { id: 'cut', op: 'difference', inputs: ['b', 'h'], output: true });
  const removed = full - s.evaluate(s.doc().objects.block).volume;
  const expect = Math.PI * 0.0017 * 0.0017 * 0.01;
  assert.ok(Math.abs(removed - expect) / expect < 0.02, `removed ${removed}, expected ${expect}`);
});

test('split: two halves with pin holes and the pins; each piece fits and rests on the bed', () => {
  const { s, ok } = studio();
  ok('new-object', { name: 'Long block', type: 'block' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'b', op: 'box', args: { size: [0.24, 0.02, 0.03], at: [0, 0.01, 0] } });
  assert.equal(check(s, 'long-block', 'print-bed').pass, false);
  const r = ok('print-fix', { object: 'long-block', fix: 'split', axis: 'x' });
  assert.equal((r.result as any).pins, 2, r.summary);
  const ev = s.evaluate(s.doc().objects['long-block']);
  assert.deepEqual([...new Set(ev.parts.map((p) => p.name.replace(/#\d+$/, '')))].sort(), ['half-a', 'half-b', 'pin']);
  assert.equal(ev.components, 4);
  assert.ok(check(s, 'long-block', 'print-bed').pass, check(s, 'long-block', 'print-bed').detail);
  const c = check(s, 'long-block', 'connected-0');
  assert.ok(c.pass, c.detail);
  assert.match(c.detail, /4 pieces, each resting on the bed/);
});

test('a floating extra piece still fails "one connected piece"', () => {
  const { s, ok } = studio();
  ok('new-object', { name: 'Thing', type: 'thing' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'a', op: 'box', args: { size: [0.02, 0.02, 0.02], at: [0, 0.01, 0] } });
  ok('add-op', { id: 'b', op: 'box', output: false, args: { size: [0.01, 0.01, 0.01], at: [0.04, 0.03, 0] } });
  ok('add-op', { id: 'u', op: 'union', inputs: ['a', 'b'], output: true });
  const c = check(s, 'thing', 'connected-0');
  assert.equal(c.pass, false);
  assert.match(c.detail, /would float above the bed/);
});

test('lay-flat turns an L bracket onto the side that needs no support', () => {
  const { s, ok } = studio();
  ok('new-object', { name: 'Bracket', type: 'bracket' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'a', op: 'box', args: { size: [0.04, 0.004, 0.03], at: [0, 0.05, 0.013] } });
  ok('add-op', { id: 'b', op: 'box', output: false, args: { size: [0.04, 0.052, 0.004], at: [0, 0.026, 0] } });
  ok('add-op', { id: 'br', op: 'union', inputs: ['a', 'b'], output: true });
  assert.match(check(s, 'bracket', 'print-overhangs').detail, /about 1\d\.\d cm²/);
  const r = ok('print-fix', { object: 'bracket', fix: 'lay-flat' });
  assert.equal((r.result as any).changed, true);
  assert.match(check(s, 'bracket', 'print-overhangs').detail, /^none/);
  const ev = s.evaluate(s.doc().objects.bracket);
  assert.ok(Math.abs(ev.bbox!.min[1]) < 1e-6, 'sits on the floor');
  // a second lay-flat has nothing left to do
  assert.equal((ok('print-fix', { object: 'bracket', fix: 'lay-flat' }).result as any).changed, false);
});

test('chamfer keeps the shape and trims the bottom edge', () => {
  const { s, ok } = box(0.002);
  const before = s.evaluate(s.doc().objects.box).volume;
  ok('print-fix', { object: 'box', fix: 'chamfer', size: 0.0008 });
  const after = s.evaluate(s.doc().objects.box);
  assert.ok(after.ok, after.error);
  assert.ok(after.volume < before && after.volume > before * 0.98, `${before} → ${after.volume}`);
});

test('fit-test coupon and fit-result: gaps update every printable object and are remembered', () => {
  const { s, ok } = box(0.002);
  ok('fit-test', {});
  const fitObj = s.doc().objects['fit-test'];
  const ev = s.evaluate(fitObj);
  assert.ok(ev.ok, ev.error);
  assert.equal(ev.components, 2, 'plate + pin');
  assert.equal(s.checks('fit-test').filter((c) => !c.pass).length, 0, JSON.stringify(s.checks('fit-test').filter((c) => !c.pass)));
  let saved: FitGaps | null = null;
  onFitRecorded((f) => { saved = f; });
  ok('fit-result', { press: 2, slide: 3, loose: 5 });
  onFitRecorded(null);
  assert.deepEqual(saved, { press: 0.00015, slide: 0.0002, loose: 0.0004 });
  assert.equal(s.doc().objects.box.params.fitLoose.value, 0.0004);
  // new printable objects start from the recorded gaps
  setFitDefaults(() => saved!);
  ok('new-object', { name: 'Next', type: 'thing' });
  ok('set-print-profile', { printer: 'a1-mini' });
  assert.equal(s.doc().objects.next.params.fitPress.value, 0.00015);
  setFitDefaults(null);
  assert.equal(s.call('fit-result', { press: 4, slide: 2, loose: 5 }).ok, false, 'press must not be looser than slide');
});
