// IK Yard (games/ik-yard): live feet by default in a real Godot game. `game feet` watches the player walk
// up the steps, over the landing and down the slope while the crab and the spider roam the bumpy ground,
// and checks planted feet against the game's own colliders. With the live IK it passes; with it off (the
// baked clips alone, on the same ground) the same check fails — so the check catches feet that float
// or sink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runGame, findGodot } from '../../../packages/game/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const ctx = { studioDir: ROOT } as any;
const skip = !findGodot() ? 'Godot 4 not installed' : !fs.existsSync(path.join(ROOT, 'games', 'ik-yard', 'assets', 'studio', 'creatures.json')) ? 'ik-yard not built (node games/ik-yard/build.ts)' : false;

test('ik-yard: the import says which path each creature took (skinned, live)', { skip }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'games', 'ik-yard', 'assets', 'studio', 'creatures.json'), 'utf8'));
  assert.deepEqual(m.creatures.map((c: any) => [c.name, c.path]), [['Crab', 'skinned-live'], ['Spider', 'skinned-live']]);
  const chars = JSON.parse(fs.readFileSync(path.join(ROOT, 'games', 'ik-yard', 'assets', 'studio', 'characters.json'), 'utf8'));
  assert.equal(chars.player.footIk, true, 'the player GLB carries extras.character.footIk');
});

test('ik-yard: feet stay on steps, slope and bumps with live IK; the baked clips fail the same check', { skip, timeout: 600000 }, async () => {
  const live: any = await runGame('game-feet', { project: 'games/ik-yard', walk: [0, 5.5], seconds: 20 }, ctx);
  assert.ok(live.result?.walk?.reached, `the player reached the foot of the slope: ${JSON.stringify(live.result?.walk)}`);
  const names = (live.result?.subjects ?? []).map((s: any) => s.name).sort();
  assert.deepEqual(names, ['Crab', 'Spider', 'player']);
  assert.equal(live.ok, true, live.summary ?? live.error);
  const baked: any = await runGame('game-feet', { project: 'games/ik-yard', walk: [0, 5.5], seconds: 20, ik: false }, ctx);
  assert.equal(baked.ok, false, `the baked fallback should fail: ${baked.summary}`);
  for (const s of baked.result.subjects) assert.equal(s.pass, false, `${s.name} baked: ${s.detail}`);
});
