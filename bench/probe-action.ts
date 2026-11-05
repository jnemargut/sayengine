// Quick probe (dev aid): solve an action for a preset and print its checks.
//   node bench/probe-action.ts octopus bench/actions/octopus-pours-tea.json ["note" …]
import fs from 'node:fs';
import { creatureFromPreset } from '../packages/core/src/creatures.ts';
import { bakeCreature, buildCreature, creatureChecks } from '../packages/core/src/rigparts.ts';

const [preset, file, ...notes] = process.argv.slice(2);
const a = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = buildCreature(creatureFromPreset(preset).def);
const clip = bakeCreature(c, a.id, { kind: 'action', action: { label: a.action, keys: a.keys, ...(a.style ? { style: a.style } : {}), notes: [...(a.notes ?? []), ...notes] } });
console.log(clip.notes.join('\n'), `\n${clip.duration.toFixed(2)} s`);
for (const k of creatureChecks(c, clip)) console.log(`${k.pass ? 'ok  ' : 'FAIL'} ${k.name}: ${k.worst}${k.unit} (limit ${k.limit}) ${k.pass ? '' : JSON.stringify(k.frames.slice(0, 4))} ${k.detail}`);
