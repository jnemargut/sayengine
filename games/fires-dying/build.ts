// npm run build: bundle src/main.ts and copy the playable files into dist/web/ (a static site).
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '../../packages/game/src/web.ts';

const GAME = path.resolve(import.meta.dirname);
const b = await bundle(GAME);
if (!b.ok) { console.error(b.errors.join('\n')); process.exit(1); }
const out = path.join(GAME, 'dist', 'web');
fs.rmSync(out, { recursive: true, force: true });
for (const f of ['index.html', 'dist/game.js', 'assets']) fs.cpSync(path.join(GAME, f), path.join(out, f), { recursive: true });
console.log(`built ${path.relative(process.cwd(), out)}: npm run play serves it`);
