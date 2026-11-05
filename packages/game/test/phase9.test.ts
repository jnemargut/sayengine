// Phase 9 weeks 15–16 in the engines: three.quarks round trip (pinned), what `game import` writes for
// effects, the UI kit and line audio, and (with Chrome) the web runtime helpers a game uses —
// named(), hold(), say(), startCharacters({controls: 'none'}), startEffects and startUI.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { initKernel, Studio, EFFECT_PRESETS, DEFAULT_FIRE_PALETTE, ICON_NAMES } from '../../core/src/index.ts';
import { gameData } from '../../core/src/gamedata.ts';
import { exportGame } from '../../core/src/gameexport.ts';
import { loadQuarks, quarksJSON, parseQuarks, writeGameData, alphaGamma, QUARKS_VERSION } from '../src/effects.ts';
import { runGame, findChrome, type GameContext } from '../src/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-phase9-'));
before(async () => { await initKernel(); await loadQuarks(); });

test('three.quarks: pinned, and every preset round-trips through its JSON with its emitters facing their direction', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['three.quarks'], QUARKS_VERSION, 'exact pin (no ^)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/three.quarks/package.json'), 'utf8')).version, QUARKS_VERSION);
  for (const [k, p] of Object.entries(EFFECT_PRESETS)) {
    const def: any = { id: k, name: k, ...p.make() };
    const json = JSON.parse(JSON.stringify(quarksJSON({ def, at: [0, 0, 0], colours: DEFAULT_FIRE_PALETTE })));
    const back = parseQuarks(json);
    const em: any[] = [];
    back.traverse((o: any) => { if (o.type === 'ParticleEmitter') em.push(o); });
    const layers = def.layers.filter((l: any) => l.kind === 'particles');
    assert.equal(em.length, layers.length, `${k}: one emitter per particle layer`);
    for (const e of em) {
      const l = layers.find((x: any) => x.id === e.name);
      assert.ok(l, `${k}: emitter named after its layer`);
      // quarks emits along local +Z: the emitter is turned onto the layer's direction
      const dir = l.direction ?? [0, 1, 0];
      const v = new THREE.Vector3(0, 0, 1).applyQuaternion(e.quaternion);
      assert.ok(Math.abs(v.x - dir[0]) + Math.abs(v.y - dir[1]) + Math.abs(v.z - dir[2]) < 1e-3, `${k}: emits along ${dir}, got ${v.toArray()}`);
      assert.equal(e.system.emissionOverTime.value ?? e.system.emissionOverTime.a ?? 0, l.rate);
      // parity fixes (v1.1): a box fills its area (quarks' rectangle emits from its edge, sideways), a
      // streak is speed × stretch long like Godot's, and colours reach quarks as the palette's sRGB
      if (l.shape.type === 'box') assert.equal(e.system.emitterShape.type, 'grid', `${k}: a box emits from a grid`);
      if (l.stretch) {
        const avg = (r: number[]) => (r[0] + r[1]) / 2;
        assert.ok(Math.abs(e.system.rendererEmitterSettings.lengthFactor * avg(l.size) - avg(l.speed) * l.stretch) < 1e-6, `${k}: streak length`);
      }
      const grad = e.system.behaviors.find((x: any) => x.type === 'ColorOverLife').color;
      const c0 = grad.color.keys[0][0];
      assert.ok(Math.abs(c0.x - new THREE.Color().setStyle(DEFAULT_FIRE_PALETTE[l.colour[0]] ?? l.colour[0], THREE.LinearSRGBColorSpace).r) < 1e-3, `${k}: colour unlinearised`);
      // v1.2: alpha over life carries the layer's exponent (Godot blends in linear light): additive layers
      // fade on a^(1/2.2), so half way through a 1 → 0 fade the web is brighter than a straight line
      const mid = grad.alpha.keys.find((x: any) => Math.abs(x[1] - 0.6) < 1e-6)[0];
      const a = l.alpha ?? [1, 1], lin = a[0] + (a[1] - a[0]) * 0.6;
      assert.ok(Math.abs(mid - Math.pow(lin, alphaGamma(l.blend, DEFAULT_FIRE_PALETTE[l.colour[0]] ?? l.colour[0]))) < 1e-6, `${k}: alpha exponent`);
      if (l.blend === 'add' && a[0] !== a[1]) assert.ok(mid > lin, `${k}: additive fade brighter than linear`);
    }
  }
});

function forgeBits() {
  const s = new Studio();
  const ok = (t: string, a: object = {}) => { const r: any = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-character', { name: 'Blacksmith', preset: 'blacksmith' });
  ok('set-motion', { object: 'blacksmith', id: 'idle', energy: 0.4 });
  ok('new-object', { name: 'Big hammer', type: 'tool', material: 'oak', position: [0.8, 0, 0.3] });
  ok('add-op', { id: 'handle', op: 'cylinder', part: 'handle', args: { r: 0.016, h: 0.34 } });
  ok('add-op', { id: 'head', op: 'box', part: 'head', args: { size: [0.11, 0.045, 0.045], at: [0, 0.33, 0] } });
  ok('add-op', { id: 'hammer', op: 'union', inputs: ['handle', 'head'], output: true });
  ok('set-profile', { profile: 'web', kind: 'hand-prop' });
  ok('add-effect', { id: 'forge-fire', preset: 'forge-fire', at: [-1, 0.7, 0], value: 'fire' });
  ok('add-effect', { id: 'embers', preset: 'embers', at: [-1, 0.75, 0], triggers: [{ on: 'fed', layer: 'puff' }] });
  ok('ui-kit', { preset: 'forge' });
  ok('ui-icon', { names: ICON_NAMES });
  const b = Object.values(s.doc().objects).find((o) => o.name === 'Blacksmith')!;
  const wav = s.assets.put(Uint8Array.from(Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64')), 'wav');
  // a line as record-line stores it (here without a mouth clip: say() still plays voice and bubble)
  s.call('set-motion', { object: 'blacksmith', id: 'idle', energy: 0.4 });
  const doc = s.doc();
  (doc.objects[b.id].character as any).lines = { 'good-lad': { text: 'Good lad.', audio: wav, emotion: 'warm', duration: 0.4, fps: 30, cues: [], curves: {}, aligner: 'test', sync: -130 } };
  return { s, doc };
}

test('game import writes effects, the UI kit and every line for Godot and the web', async () => {
  const { s, doc } = forgeBits();
  const data = gameData(s, doc);
  for (const engine of ['godot', 'web'] as const) {
    const dir = tmp();
    const files = (await writeGameData(dir, engine, data)).map((f) => path.relative(path.join(dir, 'assets', 'studio'), f)).sort();
    const want = engine === 'godot'
      ? ['effects/forge-fire.tscn', 'effects/embers.tscn', 'effects/shape.gdshader', 'effects/effects.json', 'ui/theme.tres', 'ui/font.woff', 'ui/ui.json', 'ui/icons/tongs.svg', 'lines/blacksmith/good-lad.wav', 'lines/lines.json']
      : ['effects/forge-fire.json', 'effects/embers.json', 'effects/effects.json', 'ui/ui.css', 'ui/font.woff', 'ui/ui.json', 'ui/icons/blade.svg', 'lines/blacksmith/good-lad.wav', 'lines/lines.json'];
    for (const w of want) assert.ok(files.includes(w), `${engine}: ${w} (wrote ${files.join(', ')})`);
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'assets/studio/effects/effects.json'), 'utf8'));
    assert.equal(man.find((m: any) => m.id === 'embers').triggers[0].on, 'fed');
    assert.ok(man[0].frame.radius > 0, 'review camera in the manifest');
    const lines = JSON.parse(fs.readFileSync(path.join(dir, 'assets/studio/lines/lines.json'), 'utf8'));
    assert.deepEqual(lines.Blacksmith['good-lad'], { text: 'Good lad.', clip: 'line:good-lad', duration: 0.4, sync: -130, file: 'blacksmith/good-lad.wav' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const MAIN = `import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { addStaticColliders, installHarness, startCharacters, registerTest, named, hold, type StudioGame } from '../studio/harness.ts';
import { startEffects } from '../studio/effects.ts';
import { startUI, say } from '../studio/ui.ts';
async function start(): Promise<StudioGame> {
  await RAPIER.init();
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(innerWidth, innerHeight); document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);
  camera.position.set(0, 1.6, 3); camera.lookAt(0, 1, 0);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const gltf = await new GLTFLoader().loadAsync('assets/studio/scene.glb');
  scene.add(gltf.scene);
  addStaticColliders(world, RAPIER, gltf.scene);
  let hammer: any = null; gltf.scene.traverse((o: any) => { if (o.userData?.studioName === 'Big hammer') hammer = o; });
  (window as any).__hammerColliders = addStaticColliders(world, RAPIER, hammer);
  const game: StudioGame = { renderer, scene, camera, studio: gltf.scene, world, RAPIER, animations: gltf.animations, paused: false, step(dt) { world.timestep = dt; world.step(); } };
  await startCharacters(game, { controls: 'none' });
  await startEffects(game);
  await startUI(game);
  return game;
}
registerTest('named() finds a studio name GLTFLoader rewrote', (g) => { const o = named(g, 'Big hammer'); return { pass: o.name !== 'Big hammer' || !!o.userData.studioName, detail: o.name }; });
registerTest('hold() puts the hammer in the right hand', (g) => {
  const p = hold(g, 'Blacksmith', 'Big hammer');
  let bone: any = null; g.scene.traverse((o: any) => { if (o.isBone && o.name === 'RightHand') bone = o; });
  const d = p.getWorldPosition(new THREE.Vector3()).distanceTo(bone.getWorldPosition(new THREE.Vector3()));
  return { pass: p.parent === bone && d < 0.4, detail: 'parent ' + p.parent?.name + ', ' + d.toFixed(3) + ' m from the hand' };
});
registerTest('hand props get no collider', () => ({ pass: (window as any).__hammerColliders === 0, detail: (window as any).__hammerColliders + ' colliders for the hammer' }));
registerTest('startEffects: value and event', (g) => { const fx: any = (g as any).effects; fx.setValue('fire', 0.3); fx.event('fed'); return { pass: Object.keys(fx.live).length === 2 && fx.fired['embers:puff'] === 1, detail: JSON.stringify(fx.fired) }; });
registerTest('startUI builds the HUD from the kit', (g) => { const ui: any = (g as any).ui; ui.setBar('heat', 0.2); return { pass: Object.keys(ui.els).length === 9 && !!document.querySelector('.ui-slot img'), detail: Object.keys(ui.els).join(',') }; });
registerTest('say() shows the line in a bubble over the speaker', async (g) => { const p = say(g, 'Blacksmith', 'good-lad', { audio: false }); await new Promise((r) => setTimeout(r, 50)); const b = document.querySelector('.ui-bubble'); await p; return { pass: !!b && b.textContent === 'Good lad.', detail: String(b?.textContent) }; });
registerTest('controls none: the player is made, no keyboard', (g) => ({ pass: g.characters!.keyboard === null, detail: 'keyboard ' + !!g.characters!.keyboard }));
installHarness(start());
`;

test('web runtime: named, hold, say, effects, UI and controls none in headless Chrome', { skip: !findChrome() && 'Chrome not installed', timeout: 240000 }, async () => {
  const { s, doc } = forgeBits();
  const studioDir = tmp();
  const ctx: GameContext = {
    studioDir,
    async exportGlb(out, object, engine, opts) {
      const ids = (object ? [object] : doc.objectOrder).filter((id) => !opts?.exclude?.includes(id));
      const r = await exportGame(ids.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })), { target: engine, baker: null, evaluateOp: (o, op) => s.evaluateOp(o, op) });
      fs.writeFileSync(out, r.glb);
      return { ok: true, result: { file: out, skipped: [] } };
    },
    async gameData() { return gameData(s, doc); },
  };
  const init = await runGame('game-init', { name: 'p9', engine: 'web' }, ctx);
  assert.ok(init.ok, init.error);
  fs.writeFileSync(path.join(init.result.dir, 'src', 'main.ts'), MAIN);
  const imp = await runGame('game-import', { project: 'games/p9', strict: false }, ctx);
  assert.ok(imp.ok, imp.error ?? JSON.stringify(imp.failures));
  assert.deepEqual(imp.result.assets, { effects: 2, ui: true, icons: 6, lines: 1 });
  const t = await runGame('game-test', { project: 'games/p9' }, ctx);
  const res = t.result?.results ?? [];
  for (const r of res) assert.ok(r.pass, `${r.name}: ${r.detail}`);
  assert.equal(res.length, 7, JSON.stringify(t).slice(0, 800));
  fs.rmSync(studioDir, { recursive: true, force: true });
});
