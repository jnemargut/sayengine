// Play Fire's Dying headlessly: the intro, then a bot playing a winning run, a losing run (it fetches
// every job but never feeds the fire) and an idle run (it does nothing), in fixed steps. Each run ends on
// the end card, presses "Play again" and checks a new game starts. Frames are whole-page captures (the
// canvas and the UI kit's HTML over it) → MP4s and stills in games/fires-dying/playtest/.
// Run from the repo root: node games/fires-dying/play.ts [intro|win|lose|idle…]   (needs Chrome and ffmpeg)
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

const DT = 1 / 30;
// the bot, installed in the page: decide() picks the next errand from what it sees (the same state the
// HUD shows); chunk() plays n fixed steps and draws the last one
const BOT = `window.__bot = {
  goal: null, n: 0,
  decide(kind) {
    const F = window.__fires, s = F.state;
    if (!s || s.phase !== 'play' || F.mode !== 'play' || kind === 'idle') return;
    const c = F.carrying;
    let goal = null;
    if (kind === 'win' && (c === 'charcoal' || (s.fire < 0.42 && s.request !== 'bellows'))) goal = c === 'charcoal' ? 'forge' : 'charcoal';
    else if (s.request === 'bellows') goal = 'bellows';
    else if (s.request === 'quench') goal = c === 'bucket' ? 'tub' : 'bucket';
    else if (s.request) goal = c === s.request ? 'smith' : s.request;
    if (goal && (!F.busy || goal !== this.goal || this.n % 15 === 0)) { F.goTo(goal); this.goal = goal; }
  },
  chunk(kind, n, dt) {
    const F = window.__fires;
    for (let i = 0; i < n; i++) { this.decide(kind); this.n++; F.advance(dt, 1, i === n - 1); }
    const s = F.state;
    return { mode: F.mode, card: F.card, t: s ? +s.t.toFixed(1) : 0, fire: s ? +s.fire.toFixed(2) : 0, done: s ? s.done : 0, request: s ? s.request : null, carrying: F.carrying, phase: s ? s.phase : null };
  },
};
window.__fires.pause();
true`;

type Kind = 'intro' | 'win' | 'lose' | 'idle';
const only = process.argv.slice(2) as Kind[];
const kinds = (['intro', 'win', 'lose', 'idle'] as Kind[]).filter((k) => !only.length || only.includes(k));
const reportFile = path.join(OUT, 'report.json');
const report: Record<string, any> = only.length && fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : {};

await serve(GAME, (url) => withPage(url + 'index.html', { width: 1280, height: 720 }, async (page) => {
  const ready = await page.eval(`Promise.race([window.__studio.ready.then(() => true), new Promise((_, j) => setTimeout(() => j('not ready'), 90000))])`, 120000);
  if (ready !== true) throw new Error(String(ready));
  await page.eval(BOT);
  for (const kind of kinds) {
    const dir = path.join(OUT, `frames-${kind}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    let frame = 0;
    const shot = async () => { fs.writeFileSync(path.join(dir, `${String(frame++).padStart(5, '0')}.jpg`), await page.screenshot({ format: 'jpeg', quality: 82 })); return frame - 1; };
    const marks: Record<string, number> = {};
    const log: any[] = [];
    let st: any;
    if (kind === 'intro') {
      // from the title card: Start plays the intro cutscene
      await page.eval(`window.__fires.advance(${DT}, 2)`);
      marks.title = await shot();
      await page.eval('window.__fires.press()');
      for (let i = 0; i < 30 * 20; i += 2) { st = await page.eval(`__bot.chunk('idle', 2, ${DT})`); await shot(); if (st.mode !== 'intro') break; }
      marks.play = await shot();
    } else {
      await page.eval('window.__fires.begin(false)');
      const every = 6;
      let lastLog = -10;
      for (let i = 0; i < 30 * 480; i += every) {
        st = await page.eval(`__bot.chunk('${kind}', ${every}, ${DT})`);
        await shot();
        if (st.t - lastLog >= 10) { lastLog = st.t; log.push({ t: st.t, fire: st.fire, done: st.done, request: st.request, carrying: st.carrying }); }
        if (st.mode === 'end') break;
      }
      const end = await page.eval(`(() => { const s = window.__fires.state; return { phase: s.phase, t: +s.t.toFixed(1), done: s.done, fed: s.fed, pumped: s.pumped, wrongs: s.wrongs, late: s.late, fire: +s.fire.toFixed(2) }; })()`);
      // the end line plays, then the card; then "Play again", as a player would press it
      for (let i = 0; i < 30 * 5; i += 3) { st = await page.eval(`__bot.chunk('idle', 3, ${DT})`); await shot(); if (st.card) break; }
      for (let i = 0; i < 8; i++) { st = await page.eval(`__bot.chunk('idle', 3, ${DT})`); const f = await shot(); if (i === 4) marks.card = f; }
      const card = st.card;
      await page.eval('window.__fires.press()');
      for (let i = 0; i < 15; i++) { st = await page.eval(`__bot.chunk('idle', 3, ${DT})`); const f = await shot(); if (i === 10) marks.again = f; }
      report[kind] = { state: end, card, playAgain: { mode: st.mode, t: st.t, phase: st.phase, card: st.card }, log };
      console.log(kind, JSON.stringify(end), `card "${card}", after Play again: ${st.mode} t=${st.t}`);
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', kind === 'intro' ? '15' : '20', '-i', path.join(dir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=1280:-2', path.join(OUT, `${kind}.mp4`)]);
    // stills: moments through the run, the end card, and the new game after "Play again"
    const pick = [0.15, 0.4, 0.65, 0.85].map((f) => Math.floor((marks.card ?? frame) * f));
    pick.forEach((i, k) => fs.copyFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), path.join(OUT, `${kind}-${k + 1}.jpg`)));
    for (const [m, i] of Object.entries(marks)) fs.copyFileSync(path.join(dir, `${String(i).padStart(5, '0')}.jpg`), path.join(OUT, `${kind}-${m}.jpg`));
    fs.rmSync(dir, { recursive: true, force: true });
    if (kind === 'intro') report.intro = { frames: frame };
    else report[kind].frames = frame;
  }
  const errors = page.logs.filter((l) => l.level === 'error').map((l) => l.text);
  report.errors = errors;
  if (errors.length) console.log('page errors:', errors.slice(0, 5).join('\n'));
}));
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
