// Decision 30's tripwire: the GDScript life runtime (templates/godot/studio/life.gd) and the TypeScript
// one (core/src/life/runtime.ts, the web's) play the same baked day to within 0.5 m. Runs the GDScript in
// a headless Godot 4 on a throwaway project; skipped when Godot isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findGodot } from '../src/godot.ts';
import { setWorldCacheDir, buildTown } from '../../core/src/world/index.ts';
import { bakeLife } from '../../core/src/life/bake.ts';
import { LifeRuntime } from '../../core/src/life/runtime.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(HERE, '../templates/godot/studio');

test('Godot and the web play the same day: GDScript and TypeScript runtimes agree within 0.5 m', { skip: findGodot() ? false : 'Godot 4 not installed' }, () => {
  setWorldCacheDir(path.join(HERE, '../../core/test/fixtures/world'));
  const plan = buildTown({ name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', style: 'river-town-1920s', fixes: [] } as any).plan;
  const bake = bakeLife([{ plan }], { seed: 3, event: 'market', folk: [12], cars: [2], busTowns: [0], models: [
    { id: 'a', kind: 'person', sits: true }, { id: 'b', kind: 'person', sits: true }, { id: 'dog', kind: 'dog' }, { id: 'car', kind: 'car', len: 4.25, wid: 1.78 }, { id: 'bus', kind: 'bus', len: 10.4, wid: 2.5 }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-parity-'));
  fs.mkdirSync(path.join(dir, 'studio'));
  fs.writeFileSync(path.join(dir, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="life parity"\n');
  for (const f of ['life.gd', 'life_parity.gd']) fs.copyFileSync(path.join(TPL, f), path.join(dir, 'studio', f));
  fs.writeFileSync(path.join(dir, 'life.json'), JSON.stringify(bake.data));
  const t0 = 10.6 * 3600, seconds = 30;
  const r = spawnSync(findGodot()!.bin, ['--headless', '--path', dir, '--script', 'res://studio/life_parity.gd', '--', `--life=${path.join(dir, 'life.json')}`, `--t0=${t0}`, `--seconds=${seconds}`, '--every=5', '--warm=20', `--out=${path.join(dir, 'out.json')}`], { encoding: 'utf8', timeout: 300000 });
  assert.ok(fs.existsSync(path.join(dir, 'out.json')), `Godot wrote no result: ${r.stdout}\n${r.stderr}`);
  const G = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8'));
  const rt = new LifeRuntime(bake.data);
  rt.init(t0, 20);
  const snaps = [rt.snapshot()];
  for (let k = 0; k < seconds * 10; k++) { rt.step(); if ((k + 1) % 50 === 0) snaps.push(rt.snapshot()); }
  assert.equal(G.snaps.length, snaps.length);
  let worst = 0, seen = 0;
  G.snaps.forEach((g: any, k: number) => {
    const a = snaps[k];
    assert.equal(g.s.length, a.length);
    for (let i = 0; i < a.length; i += 3) {
      assert.equal(g.s[i], a[i], `visibility of entity ${i / 3} at snapshot ${k}`);
      if (!a[i]) continue;
      seen++;
      worst = Math.max(worst, Math.hypot(a[i + 1] - g.s[i + 1], a[i + 2] - g.s[i + 2]));
    }
  });
  assert.ok(seen > 20, `compared ${seen} positions`);
  assert.ok(worst <= 0.5, `worst ${worst} m`);
  fs.rmSync(dir, { recursive: true, force: true });
});
