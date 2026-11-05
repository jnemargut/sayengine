// IK Yard proof: the feet check (`game feet`) in the real game, live IK on and off, with videos.
//   walk         — the Apprentice (the player) walks up the five steps, across the landing and down the slope
//   walk-baked   — the same walk with the live IK off (the baked clip alone)
//   creatures    — the crab and the spider wander the bumpy ground for 10 s
//   creatures-baked — the same, live IK off (baked walk clips)
// Writes checkpoint-godot-live-ik/games/{*.mp4, stills/, report.json}.
// Run from the repo root after build.ts: node games/ik-yard/proof.ts [shots…]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runGame } from '../../packages/game/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'checkpoint-godot-live-ik', 'games');
fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
const look = { center: [3.7, 0.1, 0.1], radius: 1.45, dir: [0.25, 0.32, 1] };
const SHOTS: Record<string, Record<string, unknown>> = {
  walk: { walk: [0, 5.5], seconds: 20 },
  'walk-baked': { walk: [0, 5.5], seconds: 20, ik: false },
  creatures: { seconds: 10, look },
  'creatures-baked': { seconds: 10, look, ik: false },
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS);
const reportFile = path.join(OUT, 'report.json');
const report: any = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};
for (const shot of want) {
  const r: any = await runGame('game-feet', { project: 'games/ik-yard', video: true, ...SHOTS[shot] }, { studioDir: ROOT } as any);
  if (!r.result?.video) { console.log(`${shot}: no video — ${r.error ?? JSON.stringify(r.errors)}`); continue; }
  const video = path.join(OUT, `${shot}.mp4`);
  fs.copyFileSync(r.result.video, video);
  // stills: six frames across the shot
  const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }).stdout.trim());
  const stills = [0.12, 0.28, 0.44, 0.6, 0.76, 0.92].map((u, i) => {
    const f = path.join(OUT, 'stills', `${shot}-${i + 1}.png`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(u * dur), '-i', video, '-frames:v', '1', f]);
    return path.relative(ROOT, f);
  });
  report[shot] = { pass: r.ok, summary: r.summary, walk: r.result.walk ?? null, subjects: r.result.subjects, video: path.relative(ROOT, video), stills };
  console.log(`${shot}: ${r.ok ? 'PASS' : 'FAIL'} ${r.summary}`);
}
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
