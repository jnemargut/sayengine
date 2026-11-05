// Copy a render run (<run>/{godot,web}/*.png + parity.json) into the checkpoint as <dest>/<engine>-<view>.png.
//   node collect.ts .studio/craft/final-day checkpoint-pocket-raleigh/craft/stills/day-toy
import fs from 'node:fs';
import path from 'node:path';
const [run, dest] = process.argv.slice(2);
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const e of ['godot', 'web']) for (const f of fs.readdirSync(path.join(run, e)).filter((x) => x.endsWith('.png'))) { fs.copyFileSync(path.join(run, e, f), path.join(dest, `${e}-${f}`)); n++; }
fs.copyFileSync(path.join(run, 'parity.json'), path.join(dest, 'parity.json'));
console.log(dest, n, 'stills');
