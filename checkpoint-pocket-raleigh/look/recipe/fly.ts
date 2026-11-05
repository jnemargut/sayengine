// A short flythrough of Pocket Raleigh (Fayetteville St north to City Plaza, up past PNC Plaza's crown,
// out to the aerial) rendered as pinned views in both engines for the active look, then cut with ffmpeg.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderViews } from '../../../packages/proof/src/proof.ts';

const look = process.argv[2] ?? 'look';
const frames = Number(process.argv[3] ?? 96);
type V = [number, number, number];
const K: Array<{ p: V; t: V }> = [
  { p: [-4, 2.2, 190], t: [2, 5, 0] },
  { p: [-1, 2.6, 100], t: [6, 9, -60] },
  { p: [3, 4, 25], t: [30, 45, -45] },
  { p: [-30, 45, -5], t: [45, 150, -40] },
  { p: [-150, 150, 140], t: [10, 50, -110] },
];
const cr = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
const at = (u: number, key: 'p' | 't'): V => {
  const n = K.length - 1, s = Math.min(n - 1e-6, u * n), i = Math.floor(s), f = s - i;
  const P = (k: number) => K[Math.max(0, Math.min(n, k))][key];
  const ease = f * f * (3 - 2 * f) * 0.35 + f * 0.65;
  return [0, 1, 2].map((c) => cr(P(i - 1)[c], P(i)[c], P(i + 1)[c], P(i + 2)[c], ease)) as V;
};
const views = Array.from({ length: frames }, (_, k) => { const u = k / (frames - 1); return { name: `f${String(k).padStart(3, '0')}`, position: at(u, 'p'), target: at(u, 't'), fov: 55 }; });
const out = path.resolve('.studio', 'fly', look);
fs.rmSync(out, { recursive: true, force: true });
const cfg: any = { seed: 1, steps: 30, size: 640, views, budgets: {}, tolerance: { flipMean: 1, over: 1 } };
for (const [game, engine] of [['games/pocket-raleigh', 'godot'], ['games/pocket-raleigh-web', 'web']] as const) {
  const r = await renderViews(path.resolve(game), engine, cfg, path.join(out, engine));
  console.log(engine, r.ok, r.error ?? '', Object.keys(r.images).length);
}
const mp4 = path.join(out, `fly-${look}.mp4`);
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '24', '-i', path.join(out, 'godot', 'f%03d.png'), '-framerate', '24', '-i', path.join(out, 'web', 'f%03d.png'), '-filter_complex', '[0:v][1:v]hstack=inputs=2,format=yuv420p', '-c:v', 'libx264', '-crf', '20', mp4], { encoding: 'utf8' });
console.log(r.status === 0 ? mp4 : r.stderr);
