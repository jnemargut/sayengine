// Creature parts keep a colour per piece (body extras, chain tips, hinge shapes), and one part can be
// replaced or removed (set-part / remove-part) with the motions and actions re-solved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreature, creatureMeshParts } from '../src/rigparts.ts';

const BODY = { kind: 'body', shape: 'capsule', size: [0.3, 0.22, 0.6], height: 0.3, color: '#7d6553',
  extras: [
    { shape: { kind: 'ball', c: [0, 0.36, 0.33], r: 0.05 }, color: '#c2414c' },        // lips
    { shape: { kind: 'ball', c: [0.08, 0.4, 0.28], r: 0.03 }, color: '#d9a32b' },      // eye
    { shape: { kind: 'ball', c: [-0.08, 0.4, 0.28], r: 0.03 }, color: '#d9a32b' },     // eye (same colour)
    { shape: { kind: 'box', c: [0.1, 0.4, 0.3], size: [0.01, 0.01, 0.02] }, color: '#140d08' },  // pupil
  ] };
const TAIL = { kind: 'chain', id: 'tail', at: [0, 0.3, -0.3], dir: [0, 0, -1], length: 0.3, segments: 4, r0: 0.03, r1: 0.012, color: '#b4565a', motion: 'whip', plane: 'yaw', amp: 30, freq: 1,
  tip: [{ shape: { kind: 'ball', c: [0, 0.3, -0.6], r: 0.03 }, color: '#e0d2b4' }] };
const LEGS = { kind: 'legs', id: 'legs', count: 4, upper: 0.12, lower: 0.16, spread: 0.08, radius: 0.02, color: '#5e4a3b' };
const PARTS = [BODY, LEGS, TAIL];

test('creature mesh parts: one per colour of each part, the part keeps its name for its first colour', () => {
  const c = buildCreature({ name: 'T', parts: PARTS as any });
  const { colors } = creatureMeshParts(c);
  const of = (p: string) => colors.filter((x) => x.part.replace(/~\d+$/, '') === p).map((x) => x.color);
  assert.deepEqual(of('body'), ['#7d6553', '#c2414c', '#d9a32b', '#140d08']);
  assert.deepEqual(of('tail'), ['#b4565a', '#e0d2b4']);
  assert.equal(colors.find((x) => x.part === 'body')!.color, '#7d6553');
  assert.equal(colors.find((x) => x.part === 'tail')!.color, '#b4565a');
});

test('new-creature: every piece keeps its colour in the materials, the view pack and the GLB export', async () => {
  const { initKernel, Studio, toGLB, materialForPart } = await import('../src/index.ts');
  await initKernel();
  const s = new Studio();
  const r = s.call('new-creature', { name: 'Mop', parts: PARTS });
  assert.ok(r.ok, r.error);
  const o = s.doc().objects.mop;
  const ev = s.evaluate(o);
  assert.ok(ev.ok, ev.error);
  const names = ev.parts.map((p) => p.name).sort();
  assert.ok(names.includes('body') && names.includes('body~2') && names.includes('body~4') && names.includes('tail~2'), names.join(','));
  // the material list: one rule per colour
  assert.equal(materialForPart(o, 'body').color, '#7d6553');
  assert.equal(materialForPart(o, 'body~2').color, '#c2414c');
  assert.equal(materialForPart(o, 'tail').color, '#b4565a');
  assert.equal(materialForPart(o, 'tail~2').color, '#e0d2b4');
  // the view: one part "body" (picking/selection say body) with its other colours as tints
  const packed = s.pack(s.doc()).find((x: any) => x.id === 'mop')!;
  const body = packed.parts.find((p: any) => p.name === 'body')!;
  assert.ok(!packed.parts.some((p: any) => /~\d/.test(p.name)), 'no colour siblings in the view parts');
  assert.deepEqual(body.tints.map((t: any) => t.material.color), ['#c2414c', '#d9a32b', '#140d08'].filter((c) => body.tints.some((t: any) => t.material.color === c)));
  assert.equal(body.tints.length, 3);
  assert.equal(packed.parts.find((p: any) => p.name === 'tail').tints[0].material.color, '#e0d2b4');
  // GLB export: a material per colour
  const glb = toGLB([{ obj: o, res: ev }]);
  const len = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
  const lin = (h: string) => { const c = parseInt(h.slice(1, 3), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  for (const hex of ['#7d6553', '#c2414c', '#d9a32b', '#140d08', '#b4565a', '#e0d2b4', '#5e4a3b']) {
    assert.ok(json.materials.some((m: any) => Math.abs(m.pbrMetallicRoughness.baseColorFactor[0] - lin(hex)) < 0.01), `a material for ${hex}`);
  }
  // set-material on a part recolours all of it (its colour siblings too); a sibling alone stays settable
  assert.ok(s.call('set-material', { object: 'mop', part: 'body~2', color: '#ff0000' }).ok);
  assert.equal(materialForPart(s.doc().objects.mop, 'body~2').color, '#ff0000');
  assert.equal(materialForPart(s.doc().objects.mop, 'body').color, '#7d6553');
});

test('set-part replaces one part by id, keeps the motions and actions (re-solved), survives undo; remove-part', async () => {
  const { initKernel, Studio, materialForPart } = await import('../src/index.ts');
  await initKernel();
  const s = new Studio();
  const ok = (t: string, a: object, why?: string) => { const r = s.call(t, a, 'claude', why ? { why } : {}); assert.ok(r.ok, `${t}: ${r.error}`); return r as any; };
  ok('new-creature', { name: 'Mop', parts: PARTS });
  ok('set-creature-motion', { object: 'mop', id: 'walk', kind: 'walk', speed: 0.2 });
  ok('perform-action', { object: 'mop', id: 'wag', action: 'it wags', keys: [{ t: 0, label: 'start' }, { t: 0.6, label: 'up', reach: { tail: [0.1, 0.45, -0.5] } }, { t: 1.2, label: 'back', reach: { tail: null } }] });
  ok('set-material', { object: 'mop', part: 'legs', preset: 'black-metal' });
  const before = s.history.chain(s.history.data.mainHead).length;
  const r = ok('set-part', { object: 'mop', part: { ...TAIL, length: 0.4, tip: [{ shape: { kind: 'ball', c: [0, 0.3, -0.7], r: 0.03 }, color: '#00ff00' }] } }, 'longer tail');
  assert.equal(s.history.chain(s.history.data.mainHead).length, before + 1, 'one step');
  assert.deepEqual(Object.keys(r.result.checks).sort(), ['idle', 'wag', 'walk']);
  assert.ok(!r.result.checks.wag.error, r.result.checks.wag.error);
  const o = s.doc().objects.mop;
  assert.equal((o.creature!.def.parts.find((p: any) => p.id === 'tail') as any).length, 0.4);
  assert.deepEqual(Object.keys(o.creature!.motions).sort(), ['idle', 'wag', 'walk']);
  assert.equal(materialForPart(o, 'tail~2').color, '#00ff00');
  assert.equal(materialForPart(o, 'legs').name, 'black-metal', 'a hand-set material survives');
  assert.ok(s.evaluate(o).ok);
  // errors: unknown id, a body replaced by something else
  assert.equal(s.call('set-part', { object: 'mop', part: { ...TAIL, id: 'nope' } }).ok, false);
  assert.equal(s.call('set-part', { object: 'mop', part: { ...TAIL, id: 'body' } }).ok, false);
  assert.equal(s.call('add-part', { object: 'mop', part: TAIL }).ok, false, 'add-part refuses a duplicate id');
  // the body by its id "body"
  ok('set-part', { object: 'mop', part: { ...BODY, color: '#333333' } });
  assert.equal(materialForPart(s.doc().objects.mop, 'body').color, '#333333');
  // remove-part: the motions stay; an action reaching with the removed chain reports it
  const rm = ok('remove-part', { object: 'mop', id: 'tail' });
  assert.deepEqual(rm.result.removed, ['tail']);
  assert.ok(!s.doc().objects.mop.creature!.def.parts.some((p: any) => p.id === 'tail'));
  assert.ok(s.evaluate(s.doc().objects.mop).ok);
  assert.ok(rm.result.checks.walk && !rm.result.checks.walk.error);
  assert.equal(s.call('remove-part', { object: 'mop', id: 'body' }).ok, false);
  // undo brings the tail back
  assert.ok(s.call('undo', {}).ok);
  assert.ok(s.doc().objects.mop.creature!.def.parts.some((p: any) => p.id === 'tail'));
});

test('legs: hips sit in the body where a capsule tapers (one connected piece); the presets\' hips stay put', async () => {
  const { CREATURE_PRESETS, creatureFromPreset } = await import('../src/creatures.ts');
  for (const name of Object.keys(CREATURE_PRESETS)) {
    const { def } = creatureFromPreset(name);
    const c = buildCreature(def);
    const body: any = def.parts.find((p) => p.kind === 'body');
    for (const spec of def.parts.filter((p) => p.kind === 'legs') as any[]) {
      for (const b of c.bones.filter((x) => x.name.startsWith(`${spec.id}.`) && x.name.endsWith('.upper'))) assert.ok(Math.abs(Math.abs(b.head[0]) - (body.size[0] / 2) * (spec.hipX ?? 0.9)) < 1e-9, `${name} ${b.name} moved`);
    }
  }
  const { initKernel, Studio } = await import('../src/index.ts');
  await initKernel();
  const s = new Studio();
  // eight legs spread over 90 % of a tapering capsule: the end pairs' hips used to float outside it
  const r = s.call('new-creature', { name: 'Long', parts: [
    { kind: 'body', shape: 'capsule', size: [0.34, 0.24, 0.8], height: 0.32, color: '#bfa984' },
    { kind: 'legs', id: 'outer', count: 8, upper: 0.2, lower: 0.3, spread: 0.26, span: 0.9, kneeUp: 0.1, radius: 0.02, color: '#5e4a3b' },
  ] }) as any;
  assert.ok(r.ok, r.error);
  assert.equal(s.evaluate(s.doc().objects.long).components, 1);
  assert.ok(r.result.checks.idle.pass, JSON.stringify(r.result.checks));
});
