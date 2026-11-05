// Fit the web glow chain to Godot's: render only the web build for a few (shift, gain) pairs and FLIP each
// against fixed Godot frames. node fit-glow.ts <godot-dir> <out> <views> shift:gain shift:gain …
import fs from 'node:fs';
import path from 'node:path';
import { renderViews, flipPairs, readConfig } from '../../../packages/proof/src/proof.ts';
const [godotDir, out, viewList, ...pairs] = process.argv.slice(2);
const tpl = 'games/pocket-raleigh-web/studio/look.ts';
const src = fs.readFileSync(tpl, 'utf8');
const cfg = readConfig(path.resolve('games/pocket-raleigh'));
const views = cfg.views.filter((v) => viewList.split(',').includes(v.name));
try {
  for (const pr of pairs) {
    const [shift, gain] = pr.split(':').map(Number);
    fs.writeFileSync(tpl, src.replace(/export const GLOW_SHIFT = [\d.]+, GLOW_GAIN = [\d.]+;/, `export const GLOW_SHIFT = ${shift}, GLOW_GAIN = ${gain};`));
    const dir = path.join(out, `s${shift}-g${gain}`);
    const r = await renderViews(path.resolve('games/pocket-raleigh-web'), 'web', { ...cfg, views } as any, dir);
    const names = views.map((v) => v.name).filter((n) => r.images[n]);
    const f = flipPairs(names.map((n) => ({ ref: path.join(godotDir, `${n}.png`), test: r.images[n] })));
    const res = Object.fromEntries(names.map((n, i) => [n, +f[i].mean.toFixed(4)]));
    console.log(pr, JSON.stringify(res), 'mean', (f.reduce((s, x) => s + x.mean, 0) / f.length).toFixed(4));
  }
} finally { fs.writeFileSync(tpl, src); }
