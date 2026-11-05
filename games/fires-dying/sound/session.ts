// A listening sample of Fire's Dying's sound pass: the play-test bot plays the web build in headless
// Chrome (fixed steps, so game time is exact), we record what the sound runtime was told (the fire, the
// music's intensity, every event) and the frames, then mix the pack offline exactly as the runtime would
// and put it under the video. Also writes the listening report (loudness, pictures).
//   node games/fires-dying/sound/session.ts [seconds=75] [out dir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundle, serve } from '../../../packages/game/src/web.ts';
import { withPage } from '../../../packages/game/src/chrome.ts';
import { renderTrace, type Trace } from '../../../packages/sound/src/offline.ts';
import { writeWav } from '../../../packages/sound/src/dsp.ts';
import { listen } from '../../../packages/sound/src/listen.ts';

const GAME = path.resolve(import.meta.dirname, '..');
const SECONDS = Number(process.argv[2] ?? 75);
const OUT = path.resolve(process.argv[3] ?? path.join(GAME, '..', '..', 'checkpoint-pocket-raleigh', 'sound', 'fires-dying'));
const DT = 1 / 30, EVERY = 2;                     // a frame every 2 steps: 15 fps of real game time
const FRAMES = path.join(GAME, '.studio', 'sound-session');
fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
const b = await bundle(GAME);
if (!b.ok) { console.error(b.errors.join('\n')); process.exit(1); }

const BOT = `window.__bot = {
  goal: null, n: 0,
  decide() {
    const F = window.__fires, s = F.state;
    if (!s || s.phase !== 'play' || F.mode !== 'play') return;
    const c = F.carrying;
    let goal = null;
    // a slightly lazy apprentice (feeds late), so the fire dips and the music has something to follow
    if (c === 'charcoal' || (s.fire < 0.3 && s.request !== 'bellows')) goal = c === 'charcoal' ? 'forge' : 'charcoal';
    else if (s.request === 'bellows') goal = 'bellows';
    else if (s.request === 'quench') goal = c === 'bucket' ? 'tub' : 'bucket';
    else if (s.request) goal = c === s.request ? 'smith' : s.request;
    if (goal && (!F.busy || goal !== this.goal || this.n % 15 === 0)) { F.goTo(goal); this.goal = goal; }
  },
  chunk(n, dt) { const F = window.__fires; for (let i = 0; i < n; i++) { this.decide(); this.n++; F.advance(dt, 1, i === n - 1); } const s = F.state; return { snd: F.sound, fire: s ? s.fire : 0, done: s ? s.done : 0, phase: s ? s.phase : null }; },
};
window.__fires.pause();
true`;

const trace: Trace = { seconds: SECONDS, values: [], events: [], musicStart: 0 };
const log: any[] = [];
await serve(GAME, (url) => withPage(url + 'index.html', { width: 960, height: 540 }, async (page) => {
  const ready = await page.eval(`Promise.race([window.__studio.ready.then(() => true), new Promise((_, j) => setTimeout(() => j('not ready'), 90000))])`, 120000);
  if (ready !== true) throw new Error(String(ready));
  await page.eval(BOT);
  await page.eval('window.__fires.begin(false)');
  let last: any = { values: {}, fired: {} }, frame = 0;
  for (let k = 0; k * DT < SECONDS; k += EVERY) {
    const st = await page.eval(`__bot.chunk(${EVERY}, ${DT})`);
    const t = +((k + EVERY) * DT).toFixed(4), s = st.snd;
    for (const [name, v] of Object.entries(s.values as Record<string, number>)) if (last.values[name] !== v) trace.values.push({ t, name, v });
    for (const [name, c] of Object.entries(s.fired as Record<string, number>)) for (let i = last.fired[name] ?? 0; i < c; i++) {
      if (name.startsWith('sting:')) trace.musicEnd = { t, sting: name.slice(6) };
      else trace.events.push({ t, name });
    }
    last = s;
    fs.writeFileSync(path.join(FRAMES, `${String(frame++).padStart(5, '0')}.jpg`), await page.screenshot({ format: 'jpeg', quality: 80 }));
    if (k % 150 === 0) log.push({ t, fire: +st.fire.toFixed(2), intensity: s.values.intensity, done: st.done, stems: s.music?.stems });
  }
}));

const wav = path.join(OUT, 'session.wav');
writeWav(wav, renderTrace(path.join(GAME, 'assets', 'studio', 'sound'), trace));
const mp4 = path.join(OUT, 'fires-dying-sound-pass.mp4');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(1 / (DT * EVERY)), '-i', path.join(FRAMES, '%05d.jpg'), '-i', wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-c:a', 'aac', '-b:a', '192k', '-shortest', mp4]);
const report = listen(wav, { picture: path.join(OUT, 'session.png') });
const counts: Record<string, number> = {};
for (const e of trace.events) counts[e.name] = (counts[e.name] ?? 0) + 1;
fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify({ seconds: SECONDS, events: counts, musicEnd: trace.musicEnd ?? null, log, listen: report, trace }, null, 2));
console.log(JSON.stringify({ mp4, events: counts, listen: { ...report, file: undefined } }, null, 2));
