// Import the studio scene into both games, render pinned views in Godot and on the web, and report
// Godot-vs-web FLIP per view. Run from the repo root with a daemon on STUDIO_PORT:
//   node checkpoint-pocket-raleigh/craft/recipe/render.ts <out-dir> [view,view,…|all] [--no-import]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderViews, flipPairs, readConfig, contactSheet } from '../../../packages/proof/src/proof.ts';

const out = path.resolve(process.argv[2] ?? '.studio/craft/run');
const pick = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'all';
const env = { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4660', STUDIO_CHROME_PORT: process.env.STUDIO_CHROME_PORT ?? '9540', STUDIO_WEB_PORT: process.env.STUDIO_WEB_PORT ?? '9545' };
Object.assign(process.env, env);
if (!process.argv.includes('--no-import')) for (const g of ['pocket-raleigh', 'pocket-raleigh-web']) {
  const r = spawnSync('./studio', ['game', 'import', '--project', g], { encoding: 'utf8', env });
  let j: any; try { j = JSON.parse(r.stdout); } catch { j = { ok: false, error: (r.stdout + r.stderr).slice(-600) }; }
  console.log('import', g, j.ok ? (j.summary ?? 'ok') : j.error);
}
const cfg = readConfig(path.resolve('games/pocket-raleigh'));
const views = pick === 'all' ? cfg.views : cfg.views.filter((v) => pick.split(',').includes(v.name));
const c = { ...cfg, views };
const res: Record<string, Record<string, string>> = {};
for (const [game, engine] of [['games/pocket-raleigh', 'godot'], ['games/pocket-raleigh-web', 'web']] as const) {
  const r = await renderViews(path.resolve(game), engine, c as any, path.join(out, engine));
  if (!r.ok || r.errors.length) console.log(engine, r.error ?? '', JSON.stringify(r.errors.slice(0, 8)), JSON.stringify(r.warnings.slice(0, 4)));
  res[engine] = r.images;
}
const names = views.map((v) => v.name).filter((n) => res.godot[n] && res.web[n]);
const flips = flipPairs(names.map((n) => ({ ref: res.godot[n], test: res.web[n], heatmap: path.join(out, `flip-${n}.png`) })));
const parity: Record<string, number> = {};
names.forEach((n, i) => { parity[n] = +flips[i].mean.toFixed(4); });
fs.writeFileSync(path.join(out, 'parity.json'), JSON.stringify(parity, null, 2));
console.log(JSON.stringify(parity));
contactSheet(names.flatMap((n) => [res.godot[n], res.web[n]]), 2, path.join(out, 'sheet.png'), 640);
