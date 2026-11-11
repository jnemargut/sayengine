// The soft-cartoon look preset (web template look.ts): which meshes pass through untouched (a pure rule),
// the look record's style option, and (with Chrome) the compose shader compiling and a real three.js
// scene rendering through the pass with coloured ink and pass-through meshes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { build } from 'esbuild';
import { softCartoonExcluded, SOFT_CARTOON_DEFAULTS, SOFT_CARTOON_FRAG, SOFT_CARTOON_VERT } from '../templates/web/studio/look.ts';
import { PRESETS, parseLook } from '../../core/src/look/look.ts';
import { findChrome, withPage } from '../src/chrome.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const mesh = (name: string, material: any, parent?: string) => Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), material), { name }, parent ? { parent: { name: parent } } : {});

test('soft-cartoon exclusions: additive, no depth write, shader materials and whiskers pass through by default', () => {
  const ex = (o: any, r?: any) => softCartoonExcluded(o, r);
  assert.equal(ex(mesh('cup', new THREE.MeshStandardMaterial())), false, 'an ordinary mesh is stylised');
  assert.equal(ex(mesh('pool', new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }))), true, 'additive');
  assert.equal(ex(mesh('decal', new THREE.MeshBasicMaterial({ depthWrite: false }))), true, 'depthWrite false');
  assert.equal(ex(mesh('fur-shell', new THREE.ShaderMaterial())), true, 'shader material (fur shells)');
  assert.equal(ex(mesh('fx', new THREE.RawShaderMaterial())), true, 'raw shader material');
  assert.equal(ex(mesh('Whisker_L', new THREE.MeshStandardMaterial())), true, 'whisker by name, any case');
  assert.equal(ex(mesh('strand', new THREE.MeshStandardMaterial(), 'whiskers')), true, 'whisker by parent name');
  assert.equal(ex(mesh('multi', [new THREE.MeshStandardMaterial(), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending })])), true, 'any material in an array');
  assert.equal(ex(new THREE.Points()), true, 'points, lines and sprites pass through');
  // the rules are options, and userData overrides them both ways
  assert.equal(ex(mesh('pool', new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending })), { ...SOFT_CARTOON_DEFAULTS.exclude, additive: false }), false);
  assert.equal(ex(mesh('antenna', new THREE.MeshStandardMaterial()), { names: ['antenna'] }), true, 'custom names');
  assert.equal(ex(mesh('whisker', new THREE.MeshStandardMaterial()), { names: [] }), false, 'no names: whiskers are stylised');
  assert.equal(ex(Object.assign(mesh('cup', new THREE.MeshStandardMaterial()), { userData: { softCartoon: false } })), true);
  assert.equal(ex(Object.assign(mesh('glow', new THREE.ShaderMaterial()), { userData: { softCartoon: true } })), false);
});

test('look record: style is an option, soft-cartoon fills in its defaults, the grade stays the default', () => {
  const base = PRESETS['day-toy'];
  assert.equal(parseLook(base).style, undefined);
  const l = parseLook({ ...base, style: { preset: 'soft-cartoon' } });
  assert.deepEqual(l.style, { preset: 'soft-cartoon', saturation: 1.35, shadow: 0.5, band: [0.45, 0.6], highlight: [1.6, 1.8, 0.35], calm: 0.8, ink: 0.32, inkWidth: 1.4, exclude: { additive: true, noDepthWrite: true, shaderMaterials: true, names: ['whisker'] }, precompile: true });
  assert.throws(() => parseLook({ ...base, style: { preset: 'oil-paint' } }));
});

const ENTRY = `
import * as THREE from 'three';
import { installSoftCartoonPass } from './packages/game/templates/web/studio/look.ts';
window.run = () => {
  const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240; document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas }); renderer.setSize(320, 240, false);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#9db7d0');
  scene.add(new THREE.AmbientLight('#ffffff', 0.6)); const sun = new THREE.DirectionalLight('#ffffff', 2.5); sun.position.set(2, 3, 4); scene.add(sun);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: '#d0402a' })); box.rotation.set(0.5, 0.6, 0); scene.add(box);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6), new THREE.MeshBasicMaterial({ color: '#204010', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  pool.position.set(-1.3, 0.8, 0); scene.add(pool);
  const whisker = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.04), new THREE.MeshStandardMaterial({ color: '#ffffff' })); whisker.name = 'whisker_r'; whisker.position.set(0, -1.1, 0.5); scene.add(whisker);
  const camera = new THREE.PerspectiveCamera(45, 320 / 240, 0.1, 50); camera.position.set(0, 0, 4.5);
  const gl = renderer.getContext();
  const pass = installSoftCartoonPass(renderer, null);
  const t0 = performance.now(); pass.precompile(scene, camera); const compileMs = performance.now() - t0;
  const progs = renderer.info.programs.length;
  renderer.render(scene, camera);
  const progsAfter = renderer.info.programs.length;
  const px = new Uint8Array(320 * 240 * 4); gl.readPixels(0, 0, 320, 240, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => { const i = ((239 - y) * 320 + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  // the darkest pixel along a row through the box's left silhouette: the ink
  let ink = [255, 255, 255]; for (let x = 60; x < 160; x++) { const p = at(x, 120); if (p[0] + p[1] + p[2] < ink[0] + ink[1] + ink[2]) ink = p; }
  return { err: gl.getError(), centre: at(160, 120), sky: at(5, 5), ink, excluded: [pass.excluded(pool), pass.excluded(whisker), pass.excluded(box)], progs, progsAfter, compileMs };
};`;

test('soft-cartoon in headless Chrome: the compose shader compiles, precompile covers every pass, ink is coloured', { skip: !findChrome() && 'Chrome not installed', timeout: 120000 }, async () => {
  const bundle = await build({ stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, format: 'iife', logLevel: 'silent' });
  const js = bundle.outputFiles[0].text;
  await withPage('about:blank', { width: 400, height: 300 }, async (page) => {
    // the raw GLSL compiles on its own (WebGL2, #version 300 es as three's RawShaderMaterial adds it)
    const log = await page.eval(`(() => { const gl = document.createElement('canvas').getContext('webgl2');
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, '#version 300 es\\n' + src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? '' : gl.getShaderInfoLog(s); };
      const v = sh(gl.VERTEX_SHADER, ${JSON.stringify(SOFT_CARTOON_VERT)}), f = sh(gl.FRAGMENT_SHADER, ${JSON.stringify(SOFT_CARTOON_FRAG)});
      return v + f; })()`);
    assert.equal(log, '', `shader compile log: ${log}`);
    await page.eval(js);
    const r = await page.eval('window.run()');
    assert.equal(r.err, 0, 'no GL error');
    assert.deepEqual(r.excluded, [true, true, false], 'the additive pool and the whisker pass through, the box does not');
    assert.equal(r.progsAfter, r.progs, `precompile made every program (${r.progs} before the first frame, ${r.progsAfter} after)`);
    const [cr, cg, cb] = r.centre;
    assert.ok(cr > cg + 40 && cr > cb + 40, `the box is still red: ${r.centre}`);
    const [ir, ig, ib] = r.ink;
    assert.ok(ir + ig + ib < cr + cg + cb, `the outline is darker than the face: ${r.ink} vs ${r.centre}`);
    assert.ok(ir > 0 && (ir > ig || ib > ig || ir + ig + ib > 30), `the outline is coloured, not black: ${r.ink}`);
    assert.ok(r.sky[2] > 120, `the sky is drawn: ${r.sky}`);
    const errors = page.logs.filter((l) => l.level === 'error');
    assert.deepEqual(errors, [], JSON.stringify(errors));
  });
});
