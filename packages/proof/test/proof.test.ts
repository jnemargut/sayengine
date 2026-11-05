// The proof module (Decision 31): pinned views rendered by the game's own engine, FLIP diffs against the
// approved pictures (same / changed / new), budgets, and the CLI surface. Uses the web build in headless
// Chrome with a small town from the world module's offline fixture.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, GlbBuilder } from '../../core/src/index.ts';
import { setWorldCacheDir, worldNodes, addTownsToGlb } from '../../core/src/world/index.ts';
import { initProject } from '../../game/src/project.ts';
import { findChrome } from '../../game/src/chrome.ts';
import { validateViews, writeConfig, proofViews, approve, findFlipPython } from '../src/proof.ts';
import { writeGameData } from '../../game/src/effects.ts';
import { proofCli } from '../src/cli.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
before(async () => { await initKernel(); setWorldCacheDir(path.join(HERE, '../../core/test/fixtures/world')); });

function townGlb(seed: number) {
  const B = new GlbBuilder();
  addTownsToGlb(B, worldNodes({ towns: { T: { name: 'T', source: 'invented', style: 'river-town-1920s', seed, description: 'a river town, 2 blocks', fixes: [] }, R: { name: 'R', source: 'real', area: 'raleigh-mini', style: 'raleigh-downtown', fixes: [], offset: [-260, 0, 0] } as any } }));
  return B.build();
}

test('views are checked before anything renders', () => {
  assert.throws(() => validateViews([]), /non-empty/);
  assert.throws(() => validateViews([{ name: 'Bad Name', position: [0, 1, 0], target: [0, 0, 0] }]), /lowercase/);
  assert.throws(() => validateViews([{ name: 'a', position: [0, 1], target: [0, 0, 0] }]), /position/);
  assert.throws(() => validateViews([{ name: 'a', position: [0, 1, 2], target: [0, 0, 0] }, { name: 'a', position: [0, 1, 2], target: [0, 0, 0] }]), /two views/);
  assert.equal(validateViews([{ name: 'plaza', position: [0, 1.7, 5], target: [0, 2, -50], fov: 60 }])[0].fov, 60);
});

test('the proof CLI lists its commands and corrects bad flags without starting anything', async () => {
  const h = await proofCli(['help'], () => ({}));
  assert.deepEqual(Object.keys(h.commands).sort(), ['approve', 'init', 'look-ab', 'look-board', 'look-pick', 'phone', 'views']);
  const bad = await proofCli(['views', '--projct', 'x'], (a) => ({ [a[0].slice(2)]: a[1] }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown flag --projct/);
});

test('pinned web views: new → approved → same, and a different town is flagged as changed', { skip: !findChrome() || !findFlipPython() ? 'needs Chrome and flip-evaluator' : false, timeout: 240000 }, async () => {
  const studio = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proof-'));
  try {
    const { dir } = initProject(studio, { name: 'town', engine: 'web' });
    fs.mkdirSync(path.join(dir, 'assets', 'studio'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'studio', 'scene.glb'), townGlb(3));
    fs.writeFileSync(path.join(dir, 'assets', 'studio', 'characters.json'), JSON.stringify({ player: null, characters: [] }));
    await writeGameData(dir, 'web', null);
    writeConfig(dir, { seed: 1, steps: 5, size: 320, views: validateViews([{ name: 'aerial', position: [-120, 140, 220], target: [-60, 0, 0] }, { name: 'street', position: [0, 3, 40], target: [0, 3, -60] }]) });
    const first = await proofViews(studio, 'town', { approveNew: true });
    assert.deepEqual(first.problems, []);
    assert.deepEqual(first.new.sort(), ['web/aerial', 'web/street']);
    assert.ok(first.budgets.every((b: any) => b.pass), JSON.stringify(first.budgets));
    assert.ok(first.views.every((v: any) => v.drawCalls > 0 && v.drawCalls < 60), 'chunked towns draw in a few dozen calls');
    const second = await proofViews(studio, 'town');
    assert.ok(second.ok, JSON.stringify(second.changed));
    assert.ok(second.views.every((v: any) => v.status === 'same' && v.flip.mean < 0.005), JSON.stringify(second.views.map((v: any) => v.flip)));
    fs.writeFileSync(path.join(dir, 'assets', 'studio', 'scene.glb'), townGlb(4));
    const third = await proofViews(studio, 'town');
    assert.equal(third.ok, false);
    assert.ok(third.changed.length >= 1, 'another seed is another town');
    const ap = approve(studio, 'town', ['street']);
    assert.deepEqual(ap.approved, ['web/street']);
  } finally { fs.rmSync(studio, { recursive: true, force: true }); }
});
