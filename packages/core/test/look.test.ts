// The look module (Decision 29): the record, the pinned transport tonemapper and its 33³ LUT (both
// sampling conventions), the bake fallback (scene colours and GLBs), the gates (colourfulness, palette
// match), PNG round trips, the look tools in the scene doc, what a game import writes, and the craft
// rules the night look relies on (lit windows, signs, lamps, placed props).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio, GlbBuilder } from '../src/index.ts';
import { PRESETS, parseLook, buildLut, sampleLut, cubeText, lutStrip, bakeLinear, referenceLight, gradeSceneLinear, gradeTransport, engineLight, runtimeLook } from '../src/look/look.ts';
import { transport, untransport, toneCurve, hexToLinear, srgbToLinear, type RGB } from '../src/look/color.ts';
import { colourfulness, paletteMatch, dominantColours, boardGates } from '../src/look/gates.ts';
import { decodePng, encodePng } from '../src/look/png.ts';
import { bakeGlb, readGlb } from '../src/look/bake.ts';
import { mergeLook, activeLook } from '../src/look/tools.ts';
import { setWorldCacheDir, buildTown, worldNodes, addTownsToGlb } from '../src/world/index.ts';
import { townNodes } from '../src/world/mesh.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
before(async () => { await initKernel(); setWorldCacheDir(path.join(HERE, 'fixtures', 'world')); });
const close = (a: number[], b: number[], eps: number, msg = '') => a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= eps, `${msg} [${i}] ${v} vs ${b[i]} (±${eps})`));

test('presets parse; the transport is x/(1+x) in sRGB and inverts', () => {
  for (const p of Object.values(PRESETS)) assert.equal(parseLook(p).lutSize, 33);
  for (const x of [0, 0.01, 0.18, 1, 4, 20]) assert.ok(Math.abs(untransport(transport(x)) - x) < 1e-6 * (1 + x * x), `round trip ${x}`);
  assert.throws(() => parseLook({ ...PRESETS['day-toy'], name: 'Bad Name' }), /lowercase/);
  assert.throws(() => parseLook({ ...PRESETS['day-toy'], tonemap: { curve: 'agx-ish' } }));
});

test('a Reinhard curve with no grade gives an identity LUT (the engines\' transport passes straight through)', () => {
  const id = parseLook({ ...PRESETS['studio-neutral'], tonemap: { curve: 'reinhard', exposure: 0 } });
  const lut = buildLut(id);
  for (const s of [[0.1, 0.5, 0.9], [0.33, 0.66, 0.2], [0.02, 0.98, 0.5]] as RGB[]) close(sampleLut(lut, s), s, 2e-3, 'identity');
});

test('the LUT samples like the GPU in both conventions (texel centres for Godot + web, i/(N-1) for .cube)', () => {
  const L = PRESETS['neon-night'];
  const a = buildLut(L, 'texel-centre'), b = buildLut(L, 'cube');
  for (const s of [[0.2, 0.4, 0.6], [0.7, 0.1, 0.3], [0.5, 0.5, 0.5]] as RGB[]) {
    const exact = gradeTransport(L, s);
    close(sampleLut(a, s), exact, 0.02, 'texel-centre');
    close(sampleLut(b, s), exact, 0.02, 'cube');
  }
  const cube = cubeText(L).trim().split('\n');
  assert.ok(cube.includes('LUT_3D_SIZE 33'));
  assert.equal(cube.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l)).length, 33 ** 3);
  // the strip: slice b at x = b·N, x = r, y = g (Godot slices it into a Texture3D)
  const st = lutStrip(a);
  assert.deepEqual([st.width, st.height], [33 * 33, 33]);
  const r = 5, g = 7, bb = 11, k = (r + g * 33 + bb * 33 * 33) * 3, p = (g * st.width + bb * 33 + r) * 4;
  assert.equal(st.rgba[p], Math.round(a.data[k] * 255));
  assert.equal(st.rgba[p + 2], Math.round(a.data[k + 2] * 255));
});

test('the pinned curves: neutral keeps mid colours, ACES compresses, exposure brightens', () => {
  close(toneCurve('neutral', [0.3, 0.2, 0.1]), [0.26, 0.16, 0.06], 0.001);
  assert.ok(toneCurve('aces', [10, 10, 10])[0] < 1.0001 && toneCurve('aces', [10, 10, 10])[0] > 0.95);
  const d = PRESETS['day-toy'], brighter = parseLook({ ...d, tonemap: { ...d.tonemap, exposure: 1 } });
  assert.ok(gradeSceneLinear(brighter, [0.18, 0.18, 0.18])[1] > gradeSceneLinear(d, [0.18, 0.18, 0.18])[1]);
});

test('the bake fallback lands exactly on the graded colour under the reference light', () => {
  const L = PRESETS['day-toy'];
  const E = referenceLight(L);
  for (const hex of ['#9c4f3e', '#d6cbb5', '#56575c']) {
    const albedo = hexToLinear(hex);
    const baked = bakeLinear(L, albedo);
    const plain = baked.map((v, i) => transport(v * E[i]));            // a renderer with only the transport
    const graded = gradeSceneLinear(L, albedo.map((v, i) => v * E[i]) as RGB);
    if (baked.every((v) => v < 0.999)) close(plain, graded, 2e-3, hex);
  }
  const l = engineLight(L);
  const el = (L.light.sun.elevation * Math.PI) / 180;
  assert.ok(Math.abs(Math.hypot(...l.toSun) - 1) < 1e-9 && Math.abs(l.toSun[1] - Math.sin(el)) < 1e-9, 'a unit vector towards the sun');
  assert.ok(Math.abs(l.threeSunIntensity - L.light.sun.energy * Math.PI) < 1e-9);
});

test('bakeGlb grades vertex colours and base colours, and marks the GLB', () => {
  const B = new GlbBuilder();
  B.gltf.materials.push({ name: 'world matte', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] }, extras: { vertexColors: true } });
  B.gltf.materials.push({ name: 'Stool', pbrMetallicRoughness: { baseColorFactor: [0.4, 0.2, 0.1, 1] } });
  const pos = B.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3', true);
  const col = B.accessor(new Float32Array([0.3, 0.1, 0.05, 0.3, 0.1, 0.05, 0.3, 0.1, 0.05]), 'VEC3');
  B.gltf.meshes.push({ name: 'm', primitives: [{ attributes: { POSITION: pos, COLOR_0: col }, material: 0 }, { attributes: { POSITION: pos }, material: 1 }] });
  B.gltf.nodes.push({ name: 'n', mesh: 0 });
  B.gltf.scenes[0].nodes.push(0);
  const glb = B.build();
  const L = PRESETS['neon-night'];
  const r = bakeGlb(glb, L);
  assert.equal(r.vertexColours, 3);
  assert.equal(r.materials, 1);
  const g = readGlb(r.glb);
  assert.equal(g.json.asset.extras.lookBaked, 'neon-night');
  const acc = g.json.accessors[g.json.meshes[0].primitives[0].attributes.COLOR_0];
  const bv = g.json.bufferViews[acc.bufferView];
  const v = new Float32Array(g.bin.buffer.slice(g.bin.byteOffset + (bv.byteOffset ?? 0), g.bin.byteOffset + (bv.byteOffset ?? 0) + 12));
  close([...v], bakeLinear(L, [0.3, 0.1, 0.05]), 1e-5);
  assert.deepEqual(g.json.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 1, 1, 1], 'vertex-coloured materials keep a white factor');
  assert.notDeepEqual(g.json.materials[1].pbrMetallicRoughness.baseColorFactor.slice(0, 3), [0.4, 0.2, 0.1]);
});

function img(w: number, h: number, f: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); rgba.set([...c, 255], (y * w + x) * 4); }
  return { width: w, height: h, rgba };
}

test('gates: colourfulness ranks grey < muted < vivid; palette match finds the palette; PNG round trip', () => {
  const grey = img(64, 64, () => [128, 128, 128]);
  const muted = img(64, 64, (x) => (x < 32 ? [150, 120, 110] : [110, 125, 150]));
  const vivid = img(64, 64, (x, y) => (x < 32 ? (y < 32 ? [230, 30, 40] : [30, 200, 60]) : (y < 32 ? [40, 60, 230] : [240, 220, 30])));
  const [a, b, c] = [grey, muted, vivid].map((i) => colourfulness(i));
  assert.ok(a < 1 && a < b && b < c && c > 59, `${a} < ${b} < ${c}`);
  const pal = ['#e61e28', '#1ec83c', '#283ce6', '#f0dc1e'];
  assert.ok(paletteMatch(vivid, pal) > 0.9);
  assert.ok(paletteMatch(grey, pal) < 0.3);
  assert.deepEqual(dominantColours(vivid).map((d) => +d.share.toFixed(2)), dominantColours(vivid).map((d) => +d.share.toFixed(2)), 'deterministic');
  const gates = boardGates(muted, { references: [], colourfulness: [45, 60] }, { a: '#967b6e' });
  assert.equal(gates.find((g) => g.name === 'colourfulness')!.pass, false, 'muted is below the range');
  assert.equal(gates.find((g) => g.name === 'style score')!.value, null);
  const back = decodePng(encodePng(vivid.rgba, 64, 64));
  assert.deepEqual([...back.rgba.slice(0, 8)], [...vivid.rgba.slice(0, 8)]);
});

test('look tools: new from a preset, deep-merge set, use, info; effects read the active palette', () => {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  const n = ok('look-new', { preset: 'day-toy' }).result as any;
  assert.equal(n.curve, 'neutral');
  ok('look-new', { preset: 'neon-night', activate: false });
  assert.equal(activeLook(s.doc())!.name, 'day-toy');
  ok('look-set', { look: 'day-toy', set: { grade: { saturation: 0.9 }, materials: { lit: { emission: '#ffffff' } } } });
  const d = activeLook(s.doc())!;
  assert.equal(d.grade.saturation, 0.9);
  assert.equal(d.grade.contrast, PRESETS['day-toy'].grade.contrast, 'other grade values kept');
  assert.equal(d.materials.lamp.emission, '#fff2cc', 'merged, not replaced');
  const bad = s.call('look-set', { look: 'day-toy', set: { grade: { saturation: 9 } } });
  assert.equal(bad.ok, false);
  ok('look-use', { look: 'neon-night' });
  assert.equal((s.doc() as any).look.palette.magenta, '#ff3fa4');
  const info = ok('look-info', {}).result as any;
  assert.equal(info.active, 'neon-night');
  assert.equal(info.looks.length, 2);
  assert.ok(s.snapshot().look, 'the view gets the active look');
  ok('look-use', { look: 'none' });
  assert.equal(activeLook(s.doc()), null);
  assert.deepEqual(mergeLook({ a: { b: 1, c: 2 } }, { a: { c: null, d: 3 } }), { a: { b: 1, d: 3 } });
});

test('a game import writes look.json, the LUT strip and .cube; a Compatibility Godot gets the grade baked instead', async () => {
  const { writeLook } = await import('../../game/src/look.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'look-game-'));
  fs.mkdirSync(path.join(dir, 'assets', 'studio'), { recursive: true });
  const rec = runtimeLook(PRESETS['day-toy']);
  const r = writeLook(dir, 'web', rec);
  assert.equal(r.mode, 'grade');
  const strip = decodePng(new Uint8Array(fs.readFileSync(path.join(dir, 'assets', 'studio', 'look', 'lut.png'))));
  assert.deepEqual([strip.width, strip.height], [1089, 33]);
  assert.ok(fs.readFileSync(path.join(dir, 'assets', 'studio', 'look', 'look.cube'), 'utf8').includes('LUT_3D_SIZE 33'));
  // Godot on the Compatibility renderer: no colour correction there, so the scene's colours get the grade
  fs.writeFileSync(path.join(dir, 'project.godot'), '[rendering]\nrenderer/rendering_method="gl_compatibility"\n');
  const B = new GlbBuilder();
  B.gltf.materials.push({ name: 'Box', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } });
  B.gltf.meshes.push({ name: 'm', primitives: [{ attributes: { POSITION: B.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3', true) }, material: 0 }] });
  B.gltf.nodes.push({ name: 'n', mesh: 0 }); B.gltf.scenes[0].nodes.push(0);
  fs.writeFileSync(path.join(dir, 'assets', 'studio', 'scene.glb'), B.build());
  const g = writeLook(dir, 'godot', rec);
  assert.equal(g.mode, 'bake');
  assert.equal(g.baked![0].materials, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'assets', 'studio', 'look', 'look.json'), 'utf8')).baked);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'studio', 'look', 'lut.png.import')), 'Godot keeps the strip lossless');
  assert.equal(writeLook(dir, 'godot', null).mode, 'none');
  assert.equal(fs.readFileSync(path.join(dir, 'assets', 'studio', 'look', 'look.json'), 'utf8').trim(), 'null', 'no look: a null manifest, never a 404');
});

test('both engines run the same transport: the web pass and Godot\'s environment agree on paper', () => {
  const web = fs.readFileSync(path.join(HERE, '..', '..', 'game', 'templates', 'web', 'studio', 'look.ts'), 'utf8');
  const gd = fs.readFileSync(path.join(HERE, '..', '..', 'game', 'templates', 'godot', 'studio', 'look.gd'), 'utf8');
  assert.ok(web.includes('c = c / (vec3(1.0) + c);') && web.includes('texture(tLut, c)'), 'web: Reinhard transport, then the LUT sampled plainly');
  assert.ok(gd.includes('TONE_MAPPER_REINHARDT') && gd.includes('tonemap_white = 1000.0') && gd.includes('adjustment_color_correction'), 'Godot: Reinhard with a huge white, then the LUT');
  assert.ok(gd.includes('DIFFUSE_LAMBERT'), 'Godot shades Lambert like three.js');
  assert.ok(gd.includes('REFLECTION_SOURCE_DISABLED'), 'no background reflections (three.js has no environment map)');
});

test('craft: Raleigh windows vary (lit, blinds, blank bays), street life and signs exist, props are placed', () => {
  const s = new Studio();
  s.call('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown' });
  const spec = s.doc().world!.towns['Mini Raleigh'];
  const nodes = townNodes(buildTown(spec).plan);
  const mats = new Set(nodes.flatMap((n) => n.soups.map((x) => x.mat.name)));
  for (const m of ['glass lit', 'brick pavers', 'lamp']) assert.ok(mats.has(m), `has ${m}`);
  assert.ok(nodes.some((n) => n.name === 'Street life'), 'street life node');
  // a placed prop: a studio model stands at a spot without replacing a building
  const r1 = s.call('new-object', { name: 'Mast', type: 'lamp' });
  assert.ok(r1.ok, r1.error);
  s.call('add-op', { object: 'Mast', id: 'pole', op: 'cylinder', args: { r: 0.3, h: 10, at: [0, 0, 0] } });
  s.call('set-material', { object: 'Mast', name: 'lantern lamp', color: '#ffffff' });
  const r = s.call('world-fix', { town: 'Mini Raleigh', place: true, model: 'Mast', at: [3, 4] });
  assert.ok(r.ok, r.error);
  const before = buildTown(s.doc().world!.towns['Mini Raleigh']).plan;
  assert.equal(before.props?.length, 1);
  const B = new GlbBuilder();
  const { landmarkMeshes } = await_import_world();
  addTownsToGlb(B, worldNodes(s.doc().world, landmarkMeshes(s, s.doc())));
  assert.ok(B.gltf.nodes.some((n: any) => /Prop mast/.test(n.name)), 'the prop rides in the town');
  assert.ok(B.gltf.materials.some((m: any) => m.name === 'world lamp'), 'its lamp material keeps its class (a night look lights it)');
  const bad = s.call('world-fix', { town: 'Mini Raleigh', place: true, model: 'Mast' });
  assert.equal(bad.ok, false, 'a prop needs a spot');
});

import * as worldIndex from '../src/world/index.ts';
function await_import_world() { return worldIndex; }
