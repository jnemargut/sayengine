// Iterate on a look without re-exporting the scene: write a look record straight into both games
// (look.json, LUT strip, .cube) and let Godot re-import the LUT. The final look still goes through the
// studio (look-record.ts + game import), this is only for fast A/B rounds.
//   node checkpoint-pocket-raleigh/craft/recipe/quick-look.ts <record.json>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLook, runtimeLook } from '../../../packages/core/src/look/look.ts';
import { writeLook } from '../../../packages/game/src/look.ts';
const rec = runtimeLook(parseLook(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
for (const [g, e] of [['games/pocket-raleigh', 'godot'], ['games/pocket-raleigh-web', 'web']] as const) {
  const r = writeLook(path.resolve(g), e, rec);
  console.log(g, r.mode, r.files.length);
}
const r = spawnSync('godot', ['--headless', '--path', 'games/pocket-raleigh', '--import'], { encoding: 'utf8' });
console.log('godot import', r.status);
