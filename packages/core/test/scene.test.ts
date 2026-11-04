// Materials, scene placement, linked copies, view drags and imports.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, toGLB, toSTL, resolveMaterial, materialForPart, parseMesh, imageSize, curveProfile } from '../src/index.ts';

before(async () => { await initKernel(); });

const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

function make() {
  const s = new Studio();
  const ok = (t: string, a: object = {}, author = 'claude') => { const r = s.call(t, a, author); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  return { s, ok };
}

function stool(ok: (t: string, a?: object) => any, name = 'Walnut stool') {
  ok('new-object', { name, type: 'stool', material: 'walnut' });
  ok('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016 } });
  ok('add-op', { id: 'seat', op: 'roundedBox', part: 'seat', args: { size: ['$seatW', '$seatT', '$seatW'], r: 0.008, at: [0, '$seatH - $seatT/2', 0] } });
  ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: '$legR', h: '$seatH - $seatT + 0.01' } });
  ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04 } });
  ok('add-op', { id: 'body', op: 'union', inputs: ['seat', 'legs'], output: false });
  ok('add-op', { id: 'stool', op: 'trim', inputs: ['body'], output: true });
}

function vase(ok: (t: string, a?: object) => any) {
  ok('new-object', { name: 'Vase', type: 'vase', material: 'glazed-ceramic', color: '#2f5d62' });
  ok('add-op', { id: 'body', op: 'revolve', args: { profile: [[0, 0], [0.06, 0], [0.09, 0.1], [0.04, 0.25], [0.05, 0.28], [0.044, 0.28], [0.034, 0.25], [0.084, 0.1], [0.054, 0.006], [0, 0.006]] } });
}

test('material presets resolve to PBR values; per-part overrides win', () => {
  assert.equal(resolveMaterial({ name: 'walnut' }).grain!.contrast > 0, true);
  assert.equal(resolveMaterial({ name: 'brushed-metal' }).metalness, 1);
  assert.equal(resolveMaterial({ name: 'glass' }).transmission, 1);
  assert.equal(resolveMaterial({ name: 'ceramic' }).clearcoat, 1, 'alias ceramic → glazed-ceramic');
  assert.equal(resolveMaterial({ name: 'painted-wood', color: '#204060' }).color, '#204060');
  const { s, ok } = make();
  stool(ok);
  const r = ok('set-material', { part: 'leg*', preset: 'black-metal' });
  assert.match(r.summary!, /leg\* → black-metal/);
  const o = s.doc().objects['walnut-stool'];
  assert.equal(materialForPart(o, 'leg#2').metalness, 0.75);
  assert.equal(materialForPart(o, 'seat').name, 'walnut');
  assert.ok(materialForPart(o, 'seat').grain);
  const bad = s.call('set-material', { preset: 'mahogany-ish' });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /walnut, oak/);
});

test('GLB export carries PBR materials per part (clearcoat and transmission as extensions)', () => {
  const { s, ok } = make();
  stool(ok);
  ok('set-material', { part: 'leg*', preset: 'brushed-metal' });
  vase(ok);
  const doc = s.doc();
  const glb = toGLB(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
  const dv = new DataView(glb.buffer, glb.byteOffset);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
  const names = json.materials.map((m: any) => m.name);
  assert.ok(names.includes('walnut') && names.includes('brushed-metal') && names.includes('glazed-ceramic'), names.join());
  const metal = json.materials.find((m: any) => m.name === 'brushed-metal');
  assert.equal(metal.pbrMetallicRoughness.metallicFactor, 1);
  const glaze = json.materials.find((m: any) => m.name === 'glazed-ceramic');
  assert.equal(glaze.extensions.KHR_materials_clearcoat.clearcoatFactor, 1);
  assert.ok(json.extensionsUsed.includes('KHR_materials_clearcoat'));
  assert.equal(json.meshes[0].primitives.length, 2, 'stool: walnut seat + metal legs');
});

test('a vase placed on the stool stays on it when the stool gets taller', () => {
  const { s, ok } = make();
  stool(ok);
  vase(ok);
  const r = ok('place-object', { object: 'vase', relation: 'on', target: 'Walnut stool' });
  assert.match(r.summary!, /Vase on top of Walnut stool, centred/);
  const cs = r.checks!.vase;
  assert.equal(cs.failed, 0, JSON.stringify(cs.failures));
  assert.ok(near(s.evaluate(s.doc().objects.vase).bbox!.min[1], 0.45));
  const r2 = ok('set-param', { object: 'walnut-stool', name: 'seatH', value: 0.6 });
  assert.ok(r2.checks!.vase, 'checks of the vase are reported when the stool changes');
  assert.equal(r2.checks!.vase.failed, 0);
  assert.ok(near(s.evaluate(s.doc().objects.vase).bbox!.min[1], 0.6), 'vase followed the seat up');
  const checks = s.checks('vase');
  assert.ok(checks.find((c) => c.id === 'restsOn')!.pass);
  assert.ok(checks.find((c) => c.id === 'noOverlap')!.pass);
});

test('overlap and support checks fail when they should', () => {
  const { s, ok } = make();
  stool(ok);
  vase(ok);
  ok('move-object', { object: 'vase', position: [0.1, 0.3, 0] });
  const ov = s.checks('vase').find((c) => c.id === 'noOverlap')!;
  assert.equal(ov.pass, false);
  assert.match(ov.detail, /overlaps Walnut stool/);
  ok('place-object', { object: 'vase', relation: 'on', target: 'walnut-stool', offset: [0.2, 0] });
  const ro = s.checks('vase').find((c) => c.id === 'restsOn')!;
  assert.equal(ro.pass, false, 'mostly off the edge of the seat');
  assert.match(ro.detail, /only \d+%/);
});

test('next-to, under and align relations', () => {
  const { s, ok } = make();
  stool(ok);
  vase(ok);
  ok('place-object', { object: 'vase', relation: 'next-to', target: 'walnut-stool', side: 'right', gap: 0.1 });
  const sb = s.evaluate(s.doc().objects['walnut-stool']).bbox!, vb = s.evaluate(s.doc().objects.vase).bbox!;
  assert.ok(near(vb.min[0] - sb.max[0], 0.1), `gap ${vb.min[0] - sb.max[0]}`);
  assert.ok(near(vb.min[1], 0));
  ok('place-object', { object: 'vase', relation: 'align', target: 'walnut-stool', axis: 'z', edge: 'max' });
  const vb2 = s.evaluate(s.doc().objects.vase).bbox!;
  assert.ok(near(vb2.max[2], sb.max[2]));
  ok('place-object', { object: 'vase', relation: 'under', target: 'walnut-stool' });
  const vb3 = s.evaluate(s.doc().objects.vase).bbox!;
  assert.ok(near((vb3.min[0] + vb3.max[0]) / 2, 0) && near(vb3.min[1], 0));
  assert.ok(s.checks('vase').find((c) => c.id === 'noOverlap')!.pass, 'fits between the legs');
  const loop = s.call('place-object', { object: 'walnut-stool', relation: 'on', target: 'vase' });
  assert.equal(loop.ok, false);
  assert.match(loop.error!, /loop/);
});

test('linked copies arranged around a table follow edits to the original', () => {
  const { s, ok } = make();
  ok('new-object', { name: 'Table', type: 'table', material: 'oak' });
  ok('set-params', { values: { r: 0.45, h: 0.75 } });
  ok('add-op', { id: 'top', op: 'cylinder', part: 'top', args: { r: '$r', h: 0.03, at: [0, '$h - 0.03', 0] }, output: false });
  ok('add-op', { id: 'post', op: 'cylinder', part: 'leg', args: { r: 0.04, h: '$h - 0.02' }, output: false });
  ok('add-op', { id: 'foot', op: 'cylinder', part: 'base', args: { r: 0.25, h: 0.03 }, output: false });
  ok('add-op', { id: 'table', op: 'union', inputs: ['top', 'post', 'foot'], output: true });
  stool(ok, 'Stool');
  const d = ok('duplicate-object', { object: 'stool', count: 3 });
  assert.deepEqual((d.result as any).copies, ['stool-2', 'stool-3', 'stool-4']);
  const a = ok('arrange', { objects: ['stool', 'stool-2', 'stool-3', 'stool-4'], around: 'table', radius: 0.62, start: 45 });
  assert.match(a.summary!, /4 objects around Table at 0.62 m/);
  const doc = s.doc();
  for (const id of ['stool', 'stool-2', 'stool-3', 'stool-4']) {
    const b = s.evaluate(doc.objects[id]).bbox!;
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    assert.ok(near(Math.hypot(cx, cz), 0.62, 2e-3), `${id} at radius ${Math.hypot(cx, cz)}`);
    assert.ok(s.checks(id).every((c) => c.pass), `${id}: ${JSON.stringify(s.checks(id).filter((c) => !c.pass))}`);
  }
  ok('set-param', { object: 'stool', name: 'seatH', value: 0.62 });
  const h = s.evaluate(s.doc().objects['stool-3']).bbox!.max[1];
  assert.ok(near(h, 0.62), `copy followed the original (${h})`);
  const blocked = s.call('set-param', { object: 'stool-3', name: 'seatH', value: 0.5 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /linked copy/);
  ok('unlink', { object: 'stool-3' });
  ok('set-param', { object: 'stool-3', name: 'seatH', value: 0.5 });
  assert.ok(near(s.evaluate(s.doc().objects['stool-3']).bbox!.max[1], 0.5));
  assert.ok(near(s.evaluate(s.doc().objects['stool-2']).bbox!.max[1], 0.62));
  const del = s.call('delete-object', { object: 'table' });
  assert.equal(del.ok, false, 'cannot delete something others are placed around');
});

test('view drags: dragging a placed vase updates its offset (stays on); dragging a part edits its op', () => {
  const { s, ok } = make();
  stool(ok);
  vase(ok);
  ok('place-object', { object: 'vase', relation: 'on', target: 'walnut-stool' });
  const r = ok('drag-object', { object: 'vase', by: [0.05, -0.03] }, 'human');
  assert.match(r.summary!, /still on top of Walnut stool/);
  assert.deepEqual((s.doc().objects.vase.place as any).offset, [0.05, -0.03]);
  ok('set-param', { object: 'walnut-stool', name: 'seatH', value: 0.5 });
  const vb = s.evaluate(s.doc().objects.vase).bbox!;
  assert.ok(near(vb.min[1], 0.5) && near((vb.min[0] + vb.max[0]) / 2, 0.05, 2e-3));
  const log = s.log('main', 3);
  assert.equal(log[1].author, 'human', 'a drag is one reviewable step by the human');
  // part drag: seat "at" is an expression → gets "+ d"; a leg copy moves the whole object
  const pr = ok('drag-part', { object: 'walnut-stool', part: 'seat', by: [0, 0.02, 0] }, 'human');
  assert.match(pr.summary!, /Moved seat of Walnut stool/);
  assert.match(JSON.stringify(s.doc().objects['walnut-stool'].ops.seat.args.at), /\+ 0\.02/);
  const lr = ok('drag-part', { object: 'walnut-stool', part: 'leg#3', by: [0.1, 0, 0] }, 'human');
  assert.match(lr.summary!, /whole Walnut stool.*copies/);
  // literal at: shifted in place
  ok('add-op', { object: 'vase', id: 'knob', op: 'sphere', part: 'knob', args: { r: 0.02, at: [0, 0.3, 0] }, output: false });
  ok('add-op', { object: 'vase', id: 'all', op: 'union', inputs: ['body', 'knob'], output: true });
  ok('drag-part', { object: 'vase', part: 'knob', by: [0.01, 0, 0] }, 'human');
  assert.deepEqual(s.doc().objects.vase.ops.knob.args.at, [0.01, 0.3, 0]);
});

test('curve:true rounds a revolve profile through its points but keeps the lip and base sharp', () => {
  const prof = [[0, 0], [0.06, 0], [0.1, 0.1], [0.04, 0.25], [0.05, 0.3], [0.044, 0.3], [0.034, 0.25], [0.094, 0.1], [0.054, 0.006], [0, 0.006]];
  const c = curveProfile(prof as any, 55, 10, true);
  assert.ok(c.length > prof.length * 3, `subdivided (${c.length} points)`);
  for (const p of prof) assert.ok(c.some((q) => near(q[0], p[0], 1e-9) && near(q[1], p[1], 1e-9)), `passes through ${p}`);
  const { s, ok } = make();
  ok('new-object', { name: 'Vase', type: 'vase' });
  ok('add-op', { id: 'v', op: 'revolve', args: { profile: prof, curve: true } });
  const info: any = s.call('inspect').result;
  assert.ok(near(info.bbox.max[1], 0.3) && info.stats.components === 1 && info.checks.every((x: any) => x.pass));
});

test('a new object starts clear of what is already there', () => {
  const { s, ok } = make();
  stool(ok);
  vase(ok);
  const b = s.evaluate(s.doc().objects.vase).bbox!;
  assert.ok(b.min[0] > 0.18, `vase starts right of the stool (min x ${b.min[0]})`);
  assert.ok(s.checks('vase').every((c) => c.pass));
});

test('rotation turns an object about its origin and moves its bounding box', () => {
  const { s, ok } = make();
  ok('new-object', { name: 'Plank', type: 'prop' });
  ok('add-op', { id: 'p', op: 'box', args: { size: [1, 0.02, 0.1], at: [0, 0.01, 0] } });
  ok('move-object', { rotation: 90 });
  const b = s.evaluate(s.doc().objects.plank).bbox!;
  assert.ok(near(b.max[0] - b.min[0], 0.1) && near(b.max[2] - b.min[2], 1));
});

test('import: STL round-trip in mm/Z-up comes back at the right size; references are excluded from export', () => {
  const { s, ok } = make();
  stool(ok);
  const doc = s.doc();
  const stl = toSTL([{ obj: doc.objects['walnut-stool'], res: s.evaluate(doc.objects['walnut-stool']) }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-'));
  fs.writeFileSync(path.join(dir, 'stool.stl'), stl);
  const s2 = new Studio(undefined, { assets: new (s.assets.constructor as any)(dir) });
  const r = s2.call('import', { file: 'stool.stl' });
  assert.ok(r.ok, r.error);
  const info: any = s2.call('inspect', { object: 'stool' }).result;
  assert.ok(near(info.bbox.max[1] - info.bbox.min[1], 0.45, 1e-3), `height ${info.bbox.max[1]}`);
  assert.ok(near(info.bbox.max[0] - info.bbox.min[0], 0.36, 1e-3));
  assert.equal(info.role, 'reference');
  assert.ok(info.checks[0].pass && /watertight/.test(info.checks[0].detail), info.checks[0].detail);
  // a watertight import can be used in a boolean via a mesh op
  const asset = (r.result as any).asset;
  s2.call('new-object', { name: 'Cut', type: 'prop' });
  assert.ok(s2.call('add-op', { id: 'block', op: 'box', args: { size: [0.5, 0.1, 0.5], at: [0, 0.4, 0] } }).ok);
  assert.ok(s2.call('add-op', { id: 'ref', op: 'mesh', args: { asset, format: 'stl', units: 'mm', up: 'z' }, output: false }).ok);
  const cut = s2.call('add-op', { id: 'out', op: 'difference', inputs: ['block', 'ref'], output: true });
  assert.ok(cut.ok && cut.checks!.cut.failed === 0, JSON.stringify(cut.checks));
  const d2 = s2.doc();
  const glb = toGLB(d2.objectOrder.map((id) => ({ obj: d2.objects[id], res: s2.evaluate(d2.objects[id]) })));
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
  assert.deepEqual(json.nodes.map((n: any) => n.name), ['Cut'], 'the reference is not exported');
});

test('import: OBJ in metres; open meshes still show and measure; images become backdrop planes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-import-'));
  // an open box (no top) — not watertight
  fs.writeFileSync(path.join(dir, 'tray.obj'), 'v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nv 0 0.2 0\nv 1 0.2 0\nv 1 0.2 1\nv 0 0.2 1\nf 1 2 3 4\nf 1 5 6 2\nf 2 6 7 3\nf 3 7 8 4\nf 4 8 5 1\n');
  const m = parseMesh(fs.readFileSync(path.join(dir, 'tray.obj')), 'obj');
  assert.equal(m.indices.length / 3, 10);
  // a 4×2 px PNG header is enough for the size
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000040000000208060000007f', 'hex');
  fs.writeFileSync(path.join(dir, 'sketch.png'), Buffer.concat([png, Buffer.alloc(40)]));
  assert.deepEqual(imageSize(fs.readFileSync(path.join(dir, 'sketch.png'))), { width: 4, height: 2, type: 'png' });
  const s = new Studio(undefined, { assets: new (new Studio().assets.constructor as any)(dir) });
  assert.ok(s.call('import', { file: 'tray.obj' }).ok);
  const info: any = s.call('inspect', { object: 'tray' }).result;
  assert.ok(near(info.bbox.max[1], 0.2) && info.checks[0].pass && /not watertight/.test(info.checks[0].detail));
  const r = s.call('import', { file: 'sketch.png', plane: 'side', size: 0.8 });
  assert.ok(r.ok, r.error);
  const ref = s.doc().objects.sketch.reference as any;
  assert.equal(ref.kind, 'image'); assert.equal(ref.plane, 'side'); assert.equal(ref.height, 0.4);
  const bad = s.call('import', { file: 'nope.fbx' });
  assert.equal(bad.ok, false);
  assert.match(bad.error!, /\.stl .obj .glb/);
});
