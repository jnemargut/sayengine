// Week 1 of the game tools (Decisions 12, 15, 17): game profiles and budget checks, collision and
// lod ops, unwrap + bake export (with a fake baker), creased normals, validation, after-export hooks.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, exportGame, validateGlb, creasedNormals, measureUv, onAfterExport, afterExport, materialGroups, type EvalResult } from '../src/index.ts';
import { solidPng } from './png.ts';

before(async () => { await initKernel(); });

const fakeBaker = async (req: { size: number; parts: unknown[] }) => ({ baseColor: solidPng(req.size, req.size, [94, 63, 44, 255]), metallicRoughness: solidPng(req.size, req.size, [0, 140, 0, 255]) });
const json = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));

function stool(profile?: string) {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Stool', type: 'stool', material: 'walnut' });
  if (profile) ok('set-profile', { profile });
  ok('add-op', { id: 'seat', op: 'roundedBox', part: 'seat', args: { size: [0.36, 0.03, 0.36], r: 0.008, at: [0, 0.435, 0] } });
  ok('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: 0.015, h: 0.42 } });
  ok('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.05 } });
  const last = ok('add-op', { id: 'body', op: 'union', inputs: ['seat', 'legs'], output: true });
  return { s, ok, last };
}
const check = (s: Studio, id: string) => s.checks('stool').find((c) => c.id === id);

test('a game profile adds budget checks; pending while building, then the collision requirement fails', () => {
  const { s, ok } = stool();
  assert.equal(check(s, 'budget-triangles'), undefined, 'no profile, no budget checks');
  const r = ok('set-profile', { profile: 'godot-desktop' });
  assert.match(r.summary!, /20,000 triangles/);
  assert.equal(check(s, 'budget-triangles')!.pass, true);
  assert.equal(check(s, 'collision')!.pass, false);
  assert.equal(check(s, 'collision')!.pending, false, 'a finished object without collision fails');
  ok('add-op', { id: 'col', op: 'collision', inputs: ['body'], args: { shape: 'box' } });
  assert.equal(check(s, 'collision'), undefined);
  const cov = check(s, 'collision-col')!;
  assert.ok(cov.pass, cov.detail);
  assert.match(cov.detail, /100% of the mesh/);
  assert.equal(s.checks('stool').filter((c) => !c.pass).length, 0, JSON.stringify(s.checks('stool').filter((c) => !c.pass)));
  // a collision op is a side product: never "not connected to output"
  assert.ok(!s.checks('stool').some((c) => c.id === 'unused'));
  ok('set-profile', { profile: 'none' });
  assert.equal(check(s, 'collision'), undefined);
});

test('over budget: pending mid-build, failing when finished; texture budget and overrides', () => {
  const { s, ok } = stool('web-mobile');
  ok('set-profile', { profile: 'web-mobile', triangles: 200 });
  ok('add-op', { id: 'spare', op: 'box', output: false, args: { size: [0.1, 0.1, 0.1] } });
  const mid = check(s, 'budget-triangles')!;
  assert.equal(mid.pending, true);
  assert.match(mid.detail, /^so far:/);
  ok('remove-op', { id: 'spare' });
  const done = check(s, 'budget-triangles')!;
  assert.equal(done.pass, false);
  assert.notEqual(done.pending, true);
  const big = s.call('set-profile', { profile: 'web-mobile', texture: 2048 });
  assert.ok(big.ok);
  assert.equal(check(s, 'budget-texture')!.pass, false, '2048 px is over web-mobile\'s 512');
  assert.equal(s.call('set-profile', { profile: 'web', texture: 300 }).ok, false, 'texture must be a power of two size');
});

test('materials budget counts baked groups: opaque parts share one material, glaze and glass get their own', () => {
  const { s, ok } = stool('web');
  ok('set-material', { part: 'leg*', preset: 'black-metal' });
  const doc = s.doc();
  assert.equal(materialGroups(doc.objects.stool, s.evaluate(doc.objects.stool)).length, 1, 'walnut + metal bake into one material');
  ok('set-material', { part: 'seat', preset: 'glazed-ceramic' });
  ok('set-material', { part: 'leg#1', preset: 'glass' });
  const groups = materialGroups(s.doc().objects.stool, s.evaluate(s.doc().objects.stool));
  assert.equal(groups.length, 3);
  assert.equal(groups.filter((g) => g.textured).length, 2);
  assert.match(check(s, 'budget-materials')!.detail, /3 \/ 3/);
});

test('collision shapes: box/hull enclose, capsule and sphere report their fit; linked copies inherit the profile', () => {
  const { s, ok } = stool('godot-desktop');
  for (const [id, shape] of [['cb', 'box'], ['ch', 'hull'], ['cs', 'sphere'], ['cc', 'capsule']] as const) ok('add-op', { id, op: 'collision', inputs: ['body'], args: { shape } });
  const doc = s.doc();
  const o = doc.objects.stool;
  const vol = s.evaluate(o).volume;
  const hull = s.evaluateOp(o, 'ch');
  assert.equal(hull.collision!.shape, 'hull');
  assert.ok(hull.volume > vol, 'a hull holds the stool');
  const cap = s.evaluateOp(o, 'cc');
  assert.equal(cap.collision!.shape, 'capsule');
  assert.ok(cap.collision!.radius! > 0.18 && cap.collision!.height! >= 0.45 - 1e-6, JSON.stringify(cap.collision));
  assert.ok(s.evaluateOp(o, 'cs').collision!.radius! > 0.25);
  for (const id of ['cb', 'ch', 'cs']) assert.ok(check(s, `collision-${id}`)!.pass, id);
  ok('duplicate-object', { object: 'stool' });
  assert.equal(s.doc().objects['stool-2'].profile?.name, 'godot-desktop');
  assert.equal(s.call('set-profile', { object: 'stool-2', profile: 'web' }).ok, false, 'linked copies follow the original');
});

test('lod: a simplified copy near the ratio that keeps part names', () => {
  const { s, ok } = stool('web');
  ok('add-op', { id: 'lod1', op: 'lod', inputs: ['body'], args: { ratio: 0.4 } });
  const o = s.doc().objects.stool;
  const full = s.evaluate(o), lod = s.evaluateOp(o, 'lod1');
  assert.ok(lod.ok && lod.triangles <= full.triangles * 0.4 + 4 && lod.triangles > full.triangles * 0.1, `${lod.triangles} of ${full.triangles}`);
  assert.deepEqual(lod.parts.map((p) => p.name).filter((n) => !n.startsWith('~')), ['leg#1', 'leg#2', 'leg#3', 'leg#4', 'seat']);
  assert.equal(s.call('add-op', { id: 'lodx', op: 'lod', inputs: ['body'], args: { ratio: 1.5 } }).ok, true);
  assert.equal(s.evaluateOp(s.doc().objects.stool, 'lodx').ok, false);
});

test('creased normals: unit length, smooth across a cylinder, sharp at a box edge', () => {
  const { s } = stool();
  const r = s.evaluate(s.doc().objects.stool);
  const tris = Array.from({ length: r.indices.length / 3 }, (_, t) => t);
  const n = creasedNormals(r, tris);
  for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4);
  // a box corner vertex keeps three different normals (one per face)
  const b = new Studio();
  b.call('new-object', { name: 'B', type: 'prop' });
  b.call('add-op', { id: 'b', op: 'box', args: { size: [1, 1, 1], at: [0, 0.5, 0] } });
  const br = b.evaluate(b.doc().objects.b);
  const bn = creasedNormals(br, Array.from({ length: 12 }, (_, t) => t));
  const distinct = new Set(Array.from({ length: 36 }, (_, k) => [0, 1, 2].map((c) => Math.round(bn[k * 3 + c])).join()));
  assert.equal(distinct.size, 6, 'six face normals, no smoothing across 90° edges');
});

test('game export: one baked material, UVs measured, collision node per target, LOD on web only, valid glTF', async () => {
  const { s, ok } = stool('web');
  ok('set-material', { part: 'leg*', preset: 'black-metal' });
  ok('add-op', { id: 'col', op: 'collision', inputs: ['body'], args: { shape: 'hull' } });
  ok('add-op', { id: 'lod1', op: 'lod', inputs: ['body'], args: { ratio: 0.4 } });
  ok('move-object', { position: [1, 0, 2] });
  const doc = s.doc();
  const items = [{ obj: doc.objects.stool, res: s.evaluate(doc.objects.stool) }];
  let baked: any = null;
  const web = await exportGame(items, { target: 'web', evaluateOp: (o, id) => s.evaluateOp(o, id), baker: async (req) => { baked = req; return fakeBaker(req); } });
  assert.equal(baked.size, 1024);
  assert.ok(baked.parts.every((p: any) => p.uvs.length / 2 === p.positions.length / 3 && p.uvs.every((u: number) => u >= 0 && u <= 1)), 'UVs in 0..1, one per corner');
  assert.ok(baked.parts.some((p: any) => p.material.metalness > 0.5) && baked.parts.some((p: any) => p.material.grain), 'each part carries its own material to bake');
  const j = json(web.glb);
  assert.equal(j.materials.filter((m: any) => m.pbrMetallicRoughness.baseColorTexture).length, 1);
  assert.equal(j.images.length, 2);
  const main = j.nodes.find((n: any) => n.name === 'Stool');
  assert.deepEqual(main.translation, [1, 0, 2], 'exported around its own origin');
  assert.ok(j.accessors[j.meshes[main.mesh].primitives[0].attributes.POSITION].min[0] > -0.3, 'positions are local');
  assert.equal(main.extensions.MSFT_lod.ids.length, 1);
  assert.ok(!j.scenes[0].nodes.includes(main.extensions.MSFT_lod.ids[0]), 'distance versions are not drawn on their own');
  const col = j.nodes.find((n: any) => n.extras?.collision);
  assert.equal(col.extras.collision.shape, 'hull');
  const uv = web.objects[0].uv!;
  assert.ok(uv.checks.every((c) => c.pass), JSON.stringify(uv.checks));
  assert.ok(uv.densitySpread < 1.5 && uv.paddingViolations === 0 && uv.stretchP95 < 1.5, JSON.stringify(uv));
  assert.equal((await validateGlb(web.glb)).errors, 0);
  const godot = await exportGame(items, { target: 'godot', evaluateOp: (o, id) => s.evaluateOp(o, id), baker: fakeBaker });
  const g = json(godot.glb);
  assert.ok(g.nodes.some((n: any) => n.name === 'Stool_col-convcolonly'), 'Godot reads the -convcolonly suffix');
  assert.ok(!g.nodes.some((n: any) => n.extensions?.MSFT_lod), 'Godot makes its own distance versions');
  assert.equal((await validateGlb(godot.glb)).errors, 0);
  // no bake: per-part factor materials, no textures, still valid
  const plain = await exportGame(items, { target: 'web', evaluateOp: (o, id) => s.evaluateOp(o, id), baker: null });
  const p = json(plain.glb);
  assert.ok(!p.images && p.materials.length >= 2);
  assert.equal((await validateGlb(plain.glb)).errors, 0);
});

test('unwrap is skipped for shapes that bring their own UVs; padding violations are measured', async () => {
  const { s } = stool();
  const o = s.doc().objects.stool;
  const r = s.evaluate(o);
  // pretend the template supplied UVs: everything squeezed into one corner → islands touch
  const uvs = new Float32Array((r.positions.length / 3) * 2).map((_, i) => (i % 2 ? 0.1 : 0.1) + (i % 7) * 0.001);
  const withUv: EvalResult = { ...r, uvs };
  let parts: any[] = [];
  const out = await exportGame([{ obj: o, res: withUv }], { target: 'web', evaluateOp: (x, id) => s.evaluateOp(x, id), baker: async (req) => { parts = req.parts; return fakeBaker(req); } });
  assert.ok(parts.length > 0 && parts.every((p) => p.uvs.every((u: number) => u < 0.2)), 'template UVs are used as given');
  assert.ok(out.objects[0].uv!.paddingViolations > 0 || out.objects[0].uv!.checks.some((c) => !c.pass), 'cramped template UVs are reported');
  assert.equal(typeof measureUv, 'function');
});

test('after-export hooks register and unregister', async () => {
  const off = onAfterExport(async (ctx) => ({ name: 'round-trip', ok: ctx.glb.length > 0, detail: `${ctx.target}` }));
  assert.equal(afterExport.length, 1);
  assert.deepEqual(await afterExport[0]({ file: 'x.glb', target: 'godot', glb: new Uint8Array(4), objects: [] }), { name: 'round-trip', ok: true, detail: 'godot' });
  off();
  assert.equal(afterExport.length, 0);
});
