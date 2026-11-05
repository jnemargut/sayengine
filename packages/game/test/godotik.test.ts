// Godot live IK (Decision 52): a skinned studio creature imports as a Skeleton3D, and studio/creature_ik.gd
// drives Godot 4.7's own TwoBoneIK3D / FABRIK3D on it live — the crab steps over bumpy ground with its
// planted feet on it, the octopus's arm follows a moving goal. Headless (no rendering needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findGodot } from '../src/godot.ts';
import { copyTemplate } from '../src/project.ts';
import { creatureWithClips } from '../../core/src/creatures.ts';
import { creatureSkinnedGLB } from '../../core/src/creatureskin.ts';

test('Godot: skinned crab steps live over bumps (feet on targets and ground); octopus arm follows a goal', { skip: findGodot() ? false : 'Godot 4 not installed', timeout: 300000 }, () => {
  const bin = findGodot()!.bin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-godot-ik-'));
  try {
    copyTemplate('godot', dir, { NAME: 'ik-check' });
    for (const name of ['crab', 'octopus']) { const { c, clips } = creatureWithClips(name); fs.writeFileSync(path.join(dir, `${name}.glb`), creatureSkinnedGLB(c, clips)); }
    const imp = spawnSync(bin, ['--headless', '--path', dir, '--import'], { encoding: 'utf8', timeout: 180000 });
    assert.equal(imp.status, 0, imp.stderr?.slice(-800));
    const run = (args: string[]) => {
      const r = spawnSync(bin, ['--headless', '--fixed-fps', '60', '--path', dir, '--script', 'res://studio/creature_ik_check.gd', '--', ...args], { encoding: 'utf8', timeout: 120000 });
      const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('STUDIO_IK '));
      assert.ok(line, `no result: ${(r.stdout + r.stderr).slice(-1500)}`);
      assert.ok(!/SCRIPT ERROR/.test(r.stdout + r.stderr), (r.stdout + r.stderr).slice(-1500));
      return JSON.parse(line!.slice(10));
    };
    const crab = run(['--glb=res://crab.glb', '--strafe=1,0,0']);
    assert.equal(crab.skeleton, true, 'a Skeleton3D');
    assert.equal(crab.ik, true, 'IK attached');
    assert.equal(crab.feet, 6);
    assert.ok(crab.travelled > 0.6, `walked ${crab.travelled} m`);
    assert.ok(crab.footfalls >= 6, `footfalls ${crab.footfalls}`);
    assert.ok(crab.maxFootToTarget < 0.01, `feet on their targets: ${crab.maxFootToTarget} m`);
    assert.ok(crab.maxFootToGround < 0.02, `planted feet on the ground: ${crab.maxFootToGround} m`);
    const octo = run(['--glb=res://octopus.glb', '--reach=arm1']);
    assert.equal(octo.ik, true);
    assert.ok(octo.maxTipToFollowed < 0.03, `tip on the followed goal: ${octo.maxTipToFollowed} m`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
