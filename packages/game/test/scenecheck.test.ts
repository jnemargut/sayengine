// The scripted-scene motion check (studio game scene-check) on made-up traces: a clean scene passes, and a
// teleport, a jitter, a snap turn, a pose pop, a foot slide, a glide, a missed reach and a camera shake each
// fail under their own name, in the right beat, at the right steps. Then the web probe and the one-owner
// helper (templates/web/studio/scene.ts), and the whole command against a small page in headless Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyseScene, sceneText, compareScenes, SCENE_LIMITS, type SceneStep } from '../src/scenecheck.ts';
import { runGame, findChrome } from '../src/index.ts';
import { browserArgs } from '../src/chrome.ts';
import { take, give, mine, ownerOf, probeScene } from '../templates/web/studio/scene.ts';

const DT = 1 / 30, STEP = 0.04;   // the walker walks at 1.2 m/s

/** 4 s: a walker waits (0–29), walks 2.4 m to a sitter (30–90), turns to it and puts a hand on it (91–119). */
function demoScene(): SceneStep[] {
  const tr: SceneStep[] = [];
  for (let i = 0; i < 120; i++) {
    const k = Math.max(0, Math.min(60, i - 30)), z = STEP * k, walking = i >= 31 && i <= 90;
    // a 30-step cycle: each foot is planted for 15 steps (still on the floor while the body passes over it), then swings
    const foot = (offset: number, x: number) => { const c = (k + offset) % 30, rel = c < 15 ? 0.3 - STEP * c : -0.3 + STEP * (c - 15); return [x, c < 15 ? 0 : 0.08 * Math.sin(Math.PI * (c - 15) / 15), z + rel]; };
    const u = Math.max(0, Math.min(1, (i - 92) / 18)), h = (u * u * (3 - 2 * u)) * 1.0;   // an eased turn of 57° over 0.6 s
    const d = Math.max(0, Math.min(1, (i - 91) / 28)), dolly = 0.5 * d * d * (3 - 2 * d);
    tr.push({
      i, beat: i < 30 ? 'wait' : i <= 90 ? 'arrive' : 'greet',
      bodies: {
        walker: { p: [0, 0, z], h, clip: walking ? 'walk' : 'idle', r: 0.2, bones: { head: [0, 1.6, z], hips: [0, 0.9, z], footL: foot(0, 0.1), footR: foot(15, -0.1) } },
        sitter: { p: [0.5, 0, 3], h: Math.PI, clip: 'sit', r: 0.2, bones: { head: [0.5, 0.7, 3] } },
      },
      cam: { p: [3 - dolly, 1.5, 1], f: [-1, 0, 0] },
      ...(i >= 112 ? { contacts: [{ name: 'walker hand on sitter', d: 0.03 }] } : {}),
    });
  }
  return tr;
}
const walkerAt = (tr: SceneStep[], i: number) => tr[i].bodies.walker;
const failed = (tr: SceneStep[]) => analyseScene(tr, DT).checks.filter((c) => !c.pass && !c.advisory);

test('a clean scene passes, with its beats and bodies in the report', () => {
  const rep = analyseScene(demoScene(), DT);
  assert.deepEqual(rep.fails, []);
  assert.equal(rep.pass, true);
  assert.deepEqual(Object.keys(rep.beats), ['wait', 'arrive', 'greet']);
  assert.equal(rep.beats.arrive.clipSwitches, 1);
  assert.equal(rep.beats.arrive.bodies.walker['no teleports'], 0);
  assert.equal(rep.totals['no shake'], 0);
  assert.match(sceneText(rep, 'demo-scene'), /SCENE MOTION demo-scene: ok \(120 steps of 1\/30 s, 4 s\)/);
});

test('a teleport fails as "no teleports" at the step it happens', () => {
  const tr = demoScene();
  for (let i = 50; i < tr.length; i++) { const w = walkerAt(tr, i); w.p[2] += 0.5; for (const b of Object.values(w.bones!)) b![2] += 0.5; }
  const f = failed(tr);
  assert.deepEqual(f.map((c) => [c.name, c.beat, c.body, c.frames]), [['no teleports', 'arrive', 'walker', [[50, 50]]]]);
  assert.ok(f[0].worst > SCENE_LIMITS.speed);
  // the same jump on a cut is a cut, not a teleport
  tr[50].cut = true;
  assert.deepEqual(failed(tr), []);
});

test('a jitter (two writers on one body) fails as "no shake" over the steps it lasts', () => {
  const tr = demoScene();
  for (let i = 95; i <= 115; i++) if (i % 2) { const w = walkerAt(tr, i); w.p[1] += 0.004; for (const b of Object.values(w.bones!)) b![1] += 0.004; }
  const f = failed(tr);
  assert.deepEqual(f.map((c) => [c.name, c.beat, c.body]), [['no shake', 'greet', 'walker']]);
  const [[a, z]] = f[0].frames;
  assert.ok(a >= 95 && a <= 98 && z >= 113 && z <= 117, `steps ${a}–${z}`);
  assert.match(f[0].detail, /one owner per body/);
});

test('a walk\'s bob (3 Hz) is not a shake', () => {
  const tr = demoScene();
  for (let i = 31; i <= 90; i++) walkerAt(tr, i).p[1] = 0.02 * Math.sin((i - 31) / 30 * 2 * Math.PI * 3);
  for (let i = 31; i <= 90; i++) walkerAt(tr, i).floor = 0;
  assert.equal(analyseScene(tr, DT).checks.some((c) => c.name === 'no shake'), false);
});

test('a heading set in one frame fails as "no snap turns"', () => {
  const tr = demoScene();
  for (let i = 112; i < tr.length; i++) walkerAt(tr, i).h += 1.5;
  const f = failed(tr);
  assert.deepEqual(f.map((c) => [c.name, c.beat, c.body, c.frames]), [['no snap turns', 'greet', 'walker', [[112, 112]]]]);
  assert.equal(Math.round(f[0].worst), Math.round(1.5 * 180 / Math.PI * 30));
});

test('a clip switched with no blend fails as "no pose pops" and names the bone', () => {
  const tr = demoScene();
  for (let i = 70; i < tr.length; i++) walkerAt(tr, i).bones!.head![1] -= 0.25;
  const f = failed(tr);
  assert.deepEqual(f.map((c) => [c.name, c.beat, c.body, c.frames]), [['no pose pops', 'arrive', 'walker', [[70, 70]]]]);
  assert.match(f[0].detail, /walker's head jumps 25 cm/);
});

test('feet that travel with the body fail as "planted feet hold"', () => {
  const tr = demoScene();
  for (let i = 31; i <= 90; i++) { const w = walkerAt(tr, i); w.bones!.footL = [0.1, 0, w.p[2] + 0.3]; w.bones!.footR = [-0.1, 0, w.p[2] - 0.3]; }
  const f = failed(tr);
  assert.deepEqual(f.map((c) => [c.name, c.beat, c.body]), [['planted feet hold', 'arrive', 'walker']]);
  assert.deepEqual(f[0].frames, [[31, 90]]);
  assert.ok(f[0].worst > 0.9, `slides ${f[0].worst} of the way`);
});

test('travelling in a standing clip fails as "no gliding"; a walking clip going nowhere as "no walking on the spot"', () => {
  const glide = demoScene();
  for (let i = 31; i <= 90; i++) walkerAt(glide, i).clip = 'idle';
  assert.deepEqual(failed(glide).filter((c) => c.name !== 'planted feet hold').map((c) => [c.name, c.beat, c.frames]), [['no gliding', 'arrive', [[31, 90]]]]);
  const spot = demoScene();
  for (let i = 0; i < 30; i++) walkerAt(spot, i).clip = 'walk';
  assert.deepEqual(failed(spot).map((c) => [c.name, c.beat]), [['no walking on the spot', 'wait']]);
});

test('a hand that does not reach, bodies inside each other, and a shaking or jolting camera', () => {
  const reach = demoScene();
  for (let i = 112; i < 120; i++) reach[i].contacts![0].d = 0.4;
  assert.deepEqual(failed(reach).map((c) => [c.name, c.body, c.frames]), [['hands reach', 'walker hand on sitter', [[112, 119]]]]);
  const inside = demoScene();
  for (const s of inside) s.bodies.sitter.p = [0.1, 0, 2.5];
  assert.deepEqual(failed(inside).map((c) => [c.name, c.body, c.beat]), [['bodies apart', 'walker+sitter', 'arrive'], ['bodies apart', 'walker+sitter', 'greet']]);
  const shake = demoScene();
  for (let i = 40; i <= 60; i++) if (i % 2) shake[i].cam!.p[1] += 0.01;
  assert.deepEqual(failed(shake).map((c) => [c.name, c.beat]), [['camera steady', 'arrive']]);
  const jolt = demoScene();
  for (let i = 100; i < 120; i++) jolt[i].cam!.p[0] -= 0.1 * (i - 99);   // sets off at 3 m/s
  assert.deepEqual(failed(jolt).map((c) => [c.name, c.beat, c.frames[0][0]]), [['camera eases', 'greet', 100]]);
});

test('limits can be overridden per body, and two reports compare', () => {
  const tr = demoScene();
  for (let i = 112; i < tr.length; i++) walkerAt(tr, i).h += 1.5;
  const loose = analyseScene(tr, DT, { bodies: { walker: { turn: 3000 } } });
  assert.equal(loose.pass, true);
  const txt = compareScenes(analyseScene(tr, DT), analyseScene(demoScene(), DT));
  assert.match(txt, /snap turns\s+1\s+0/);
});

test('one owner per body: a second taker throws, other writers stand down, giving back frees it', () => {
  const body = {};
  assert.equal(mine(body, 'controller'), true);
  take(body, 'demo-scene');
  assert.equal(ownerOf(body), 'demo-scene');
  assert.equal(mine(body, 'controller'), false);
  assert.equal(mine(body, 'demo-scene'), true);
  assert.throws(() => take(body, 'idle-life'), /demo-scene still owns/);
  assert.throws(() => give(body, 'idle-life'), /demo-scene owns/);
  give(body, 'demo-scene');
  assert.equal(mine(body, 'controller'), true);
});

test('the web probe reads positions, headings, bones, the camera and screen points from world matrices', () => {
  const node = (x: number, y: number, z: number, yaw = 0) => ({ updateWorldMatrix() {}, matrixWorld: { elements: [Math.cos(yaw), 0, -Math.sin(yaw), 0, 0, 1, 0, 0, Math.sin(yaw), 0, Math.cos(yaw), 0, x, y, z, 1] } });
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cam = { ...node(0, 0, 0), projectionMatrix: { elements: I }, matrixWorldInverse: { elements: I } };
  let beat: string | null = null;
  const probe = { beat: () => beat, step() {}, bodies: { walker: { root: node(0.5, 0, 0.25, Math.PI / 2), clip: () => 'walk', bones: { head: node(0.5, 0.5, 0.25), tail: null }, r: 0.2 } }, camera: cam, contacts: () => [{ name: 'paw on cup', d: 0.02 }] };
  assert.equal(probeScene(probe, { width: 200, height: 100 }), null);
  beat = 'arrive';
  const s: any = probeScene(probe, { width: 200, height: 100 });
  assert.equal(s.beat, 'arrive');
  assert.deepEqual(s.bodies.walker.p, [0.5, 0, 0.25]);
  assert.ok(Math.abs(s.bodies.walker.h - Math.PI / 2) < 1e-3);
  assert.deepEqual(s.bodies.walker.bones, { head: [0.5, 0.5, 0.25], tail: null });
  assert.deepEqual(s.cam, { p: [0, 0, 0], f: [0, 0, -1] });
  assert.deepEqual(s.screen, [[150, 25], [150, 50]]);
  assert.deepEqual(s.contacts, [{ name: 'paw on cup', d: 0.02 }]);
  assert.equal(analyseScene([s, s, s], DT).pass, true);
});

test('a headed (GPU) Chrome keeps drawing when covered and is not software; a headless one is', () => {
  const headed = browserArgs({ width: 390, height: 844 }, 9400, '/tmp/p', { headed: true, vsync: false });
  assert.ok(!headed.some((a) => a.startsWith('--headless')) && !headed.some((a) => a.includes('swiftshader')));
  for (const a of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-gpu-vsync', '--user-data-dir=/tmp/p']) assert.ok(headed.includes(a), a);
  assert.ok(browserArgs({ width: 960, height: 540 }, 9400, '/tmp/p').includes('--headless=new'));
});

// a page that answers the probe without any engine: a walker that walks, then (with ?bug) is put back every other step
const PAGE = `<!doctype html><meta charset="utf-8"><body><script>
let k = 0; const bug = location.search.includes('bug');
window.__scene = { step(dt) { k++; if (k < 5 || k > 64) return null; const z = 0.04 * (k - 5) + (bug && k > 30 && k % 2 ? 0.01 : 0);
  return { beat: k < 35 ? 'arrive' : 'settle', bodies: { walker: { p: [0, 0, k < 35 ? z : 0.04 * 29 + (bug && k % 2 ? 0.01 : 0)], h: 0, clip: k < 35 ? 'walk' : 'idle' } }, cam: { p: [2, 1, 0], f: [-1, 0, 0] } }; } };
</script>`;

test('studio game scene-check plays a page at a fixed step, passes a clean scene, fails a shaking one, and re-reads a trace', { skip: !findChrome() && 'Chrome is not installed', timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-scene-test-'));
  try {
    fs.mkdirSync(path.join(root, 'site'));
    fs.writeFileSync(path.join(root, 'site', 'index.html'), PAGE);
    const ctx: any = { studioDir: root, exportGlb: async () => ({ ok: false }) };
    const good = await runGame('game-scene-check', { dir: 'site', label: 'clean' }, ctx);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.result.steps, 60);
    assert.ok(fs.existsSync(good.result.trace) && fs.existsSync(good.result.report) && fs.existsSync(good.result.text));
    assert.ok(!fs.existsSync(path.join(root, 'site', '.studio-game')), 'nothing is written into the served folder');
    const bad = await runGame('game-scene-check', { dir: 'site', query: 'bug=1', label: 'bug' }, ctx);
    assert.equal(bad.ok, false);
    assert.ok(bad.result.fails.some((f: string) => /walker: no shake/.test(f)), bad.result.fails.join('\n'));
    const again = await runGame('game-scene-check', { trace: bad.result.trace, against: good.result.report }, ctx);
    assert.equal(again.ok, false);
    assert.match(again.result.compare, /shake\s+0\s+[1-9]/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
