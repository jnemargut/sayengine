// The eye-level sheet: rows = views, columns = day Godot | day web | night Godot | night web.
//   node sheet.ts <out.png> view,view,…
import path from 'node:path';
import { contactSheet } from '../../../packages/proof/src/proof.ts';
const [out, list] = process.argv.slice(2);
const S = 'checkpoint-pocket-raleigh/craft/stills';
const files = list.split(',').flatMap((v) => ['day-toy/godot', 'day-toy/web', 'neon-night/godot', 'neon-night/web'].map((k) => { const [look, e] = k.split('/'); return path.join(S, look, `${e}-${v}.png`); }));
console.log(contactSheet(files, 4, out, 480));
