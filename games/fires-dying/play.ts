// Play Fire's Dying headlessly: a bot plays a full winning run and a losing run (it never feeds the
// fire), in fixed steps; frames become MP4s and stills in games/fires-dying/playtest/.
// Run from the repo root: node games/fires-dying/play.ts   (needs Chrome and ffmpeg)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundle, serve } from '../../packages/game/src/web.ts';
import { withPage } from '../../packages/game/src/chrome.ts';

const GAME = path.resolve(import.meta.dirname);
const OUT = path.join(GAME, 'playtest');
fs.mkdirSync(OUT, { recursive: true });
const b = await bundle(GAME);
if (!b.ok) { console.error(b.errors.join('\n')); process.exit(1); }

// the bot, run inside the page: one call plays a whole run and returns the captured frames
const BOT = (kind: 'win' | 'lose' | 'intro', every: number, maxSecs: number) => `(async () => {
  const F = window.__fires; F.pause();
  const dt = 1 / 30, frames = [], log = [];
  await F.begin(${kind === 'intro'});
  if (${kind === 'intro'}) {
    let n = 0; while (F.mode === 'intro' && n < 30 * 15) { F.advance(dt); if (n++ % 1 === 0) frames.push(F.snap(960)); }
    return { frames, log, state: null };
  }
  let n = 0, lastPhase = '';
  while (n < ${maxSecs} * 30) {
    const s = F.state;
    if (s.phase !== 'play') { for (let i = 0; i < 75; i++) { F.advance(dt); if (i % ${every} === 0) frames.push(F.snap(960)); } break; }
    if (!F.busy || n % 15 === 0) {
      const want = ${kind === 'win'} && (s.fire < 0.4 || F.carrying === 'charcoal') ? 'charcoal' : s.request;
      if (want === 'charcoal') F.goTo(F.carrying === 'charcoal' ? 'forge' : 'charcoal');
      else if (want) F.goTo(F.carrying === want ? 'smith' : want);
    }
    F.advance(dt); n++;
    if (n % ${every} === 0) frames.push(F.snap(960));
    if (n % 300 === 0) log.push({ t: +s.t.toFixed(1), fire: +s.fire.toFixed(2), done: s.done, request: s.request, carrying: F.carrying });
  }
  const s = F.state;
  return { frames, log, state: { phase: s.phase, t: +s.t.toFixed(1), done: s.done, fed: s.fed, wrongs: s.wrongs, fire: +s.fire.toFixed(2) } };
})()`;

const only = process.argv.slice(2);
const runs = ([['intro', 1, 30, 30], ['win', 6, 420, 20], ['lose', 6, 420, 20]] as Array<['intro' | 'win' | 'lose', number, number, number]>).filter((r) => !only.length || only.includes(r[0]));
const report: Record<string, unknown> = {};
await serve(GAME, (url) => withPage(url + 'index.html', { width: 1280, height: 800 }, async (page) => {
  const ready = await page.eval(`Promise.race([window.__studio.ready.then(() => true), new Promise((_, j) => setTimeout(() => j('not ready'), 90000))])`, 120000);
  if (ready !== true) throw new Error(String(ready));
  for (const [kind, every, secs, fps] of runs) {
    const r = await page.eval(BOT(kind, every, secs), 900000);
    const dir = path.join(OUT, `frames-${kind}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    r.frames.forEach((d: string, i: number) => fs.writeFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(d.split(',')[1], 'base64')));
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=960:-2', path.join(OUT, `${kind}.mp4`)]);
    // stills: a few moments through the run
    const pick = [0.12, 0.4, 0.7, 0.97].map((f) => Math.min(r.frames.length - 1, Math.floor(r.frames.length * f)));
    pick.forEach((i, k) => fs.copyFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), path.join(OUT, `${kind}-${k + 1}.jpg`)));
    fs.rmSync(dir, { recursive: true, force: true });
    report[kind] = { frames: r.frames.length, state: r.state, log: r.log };
    console.log(kind, JSON.stringify(r.state), `${r.frames.length} frames`);
  }
  const errors = page.logs.filter((l) => l.level === 'error').map((l) => l.text);
  report.errors = errors;
  if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
}));
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
