// Play a web game at a fixed step in Chrome and record it: the probe trace a scripted scene answers
// (studio game scene-check) and frames for strips and a film (also studio game capture).
// Headless Chrome draws in software, at about a tenth of real time, and its pictures differ a little from a
// player's; `gpu` opens a real window on the machine's GPU instead (chrome.ts keeps it in the registry, so the
// window and its temp profile go when the run ends, however it ends).
// The page's side of the contract is small:
//   window.__scene = { start?(), step(dt, draw) → SceneStep | null }      (studio/sceneprobe.ts builds one)
// step advances the game by dt seconds of game time (never real time), draws when asked, and returns the probe:
// null (or no beat) while the scene is not running. A game with its own dev hooks passes --step / --start instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withPage, type Page } from './chrome.ts';
import { analyseScene, sceneText, type SceneLimits, type SceneReport, type SceneStep } from './scenecheck.ts';

export interface PlayOpts {
  /** the page to open (the game's index.html, with its query) */
  url: string;
  width: number; height: number;
  fps?: number;
  /** expression that advances one step and returns the probe; {dt} and {draw} are filled in */
  step?: string;
  /** expression run once when the page is ready (may return a promise) */
  start?: string;
  /** expression (a promise) that resolves when the game can be stepped */
  ready?: string;
  /** the longest scene, and the longest wait for it to start, in seconds of game time */
  seconds?: number; wait?: number;
  /** a script of inputs for a scene that waits for the player: when the beat matches and `after` seconds of it have passed, `eval` runs once (or a real `click` / `tap` at [x, y]) */
  inputs?: Array<{ beat: string; after?: number; eval?: string; click?: [number, number]; tap?: [number, number] }>;
  gpu?: boolean;
  limits?: Partial<SceneLimits>;
}

const DEFAULT_STEP = 'window.__scene.step({dt}, {draw})';
const DEFAULT_READY = `(window.__studio ? window.__studio.ready : Promise.resolve()).then(() => new Promise((r, j) => { const t0 = Date.now(); const t = () => (window.__scene ? r(true) : Date.now() - t0 > 60000 ? j(new Error('no window.__scene after 60 s: install one with studio/sceneprobe.ts, or pass --step')) : setTimeout(t, 100)); t(); }))`;
const DEFAULT_START = 'window.__scene && window.__scene.start ? window.__scene.start() : true';
const fill = (expr: string, dt: number, draw: boolean) => expr.replaceAll('{dt}', String(dt)).replaceAll('{draw}', String(draw));
const size = (o: PlayOpts) => { const phone = Math.min(o.width, o.height) < 500; return { width: o.width, height: o.height, deviceScaleFactor: phone ? 2 : 1, mobile: phone, touch: phone }; };

async function open(page: Page, o: PlayOpts) {
  const ok = await page.eval(`Promise.resolve(${o.ready ?? (o.step ? '(window.__studio ? window.__studio.ready : true)' : DEFAULT_READY)}).then(() => true, (e) => String(e && e.message || e))`, 180000);
  if (ok !== true) throw new Error(`the game did not become ready: ${ok}`);
  await page.eval(`Promise.resolve(${o.start ?? (o.step ? 'true' : DEFAULT_START)}).then(() => true)`, 120000);
}

/** One play of the scene: every step with a beat, from the first to the last. `each` runs after every recorded step. */
async function play(page: Page, o: PlayOpts, draw: boolean, each?: (s: SceneStep, k: number) => Promise<void>): Promise<SceneStep[]> {
  const fps = o.fps ?? 30, dt = 1 / fps, tr: SceneStep[] = [];
  const batch = each || o.inputs?.length ? 1 : fps;
  const expr = `(() => { const out = []; for (let k = 0; k < ${batch}; k++) { let s = (${fill(o.step ?? DEFAULT_STEP, dt, draw)}); if (typeof s === 'string') s = JSON.parse(s); out.push(s && s.beat ? s : null); if (!s || !s.beat || s.done) break; } return JSON.stringify(out); })()`;
  const fired = new Set<string>(); let waited = 0, beat = '', beatAt = 0, visit = 0;
  for (let i = 0; i < (o.seconds ?? 180) * fps;) {
    const got: Array<(SceneStep & { done?: boolean }) | null> = JSON.parse(await page.eval(expr, 120000));
    let ended = false;
    for (const s of got) {
      if (!s) { if (tr.length) { ended = true; break; } if (++waited > (o.wait ?? 20) * fps) throw new Error(`the scene never started (${o.wait ?? 20} s of game time after the page was ready): is it off in this kind of run? A first-time-only scene needs a way to ask for it`); continue; }
      s.i = i++; tr.push(s);
      if (s.beat !== beat) { beat = s.beat; beatAt = s.i; visit++; }
      if (each) await each(s, tr.length - 1);
      for (const [n, inp] of (o.inputs ?? []).entries()) {
        const key = `${n}:${visit}`;
        if (fired.has(key) || !new RegExp(inp.beat).test(s.beat) || (s.i - beatAt) * dt < (inp.after ?? 1)) continue;
        fired.add(key);
        if (inp.click) await page.click(inp.click[0], inp.click[1]);
        else if (inp.tap) { await page.touch('touchStart', [{ x: inp.tap[0], y: inp.tap[1] }]); await page.touch('touchEnd', []); }
        else if (inp.eval) await page.eval(`Promise.resolve(${inp.eval}).then(() => true)`, 60000);
      }
      if (s.done) { ended = true; break; }
    }
    if (ended) break;
  }
  if (!tr.length) throw new Error('the scene never started');
  return tr;
}

const ffmpeg = () => (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0 ? 'ffmpeg' : null);
/** Tile pictures into one strip (ffmpeg); false when it could not. */
export function strip(files: string[], out: string, tile = 300, cols = 8): boolean {
  const ff = ffmpeg();
  if (!ff || !files.length) return false;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-strip-'));
  try {
    files.forEach((f, j) => fs.copyFileSync(f, path.join(tmp, `t${String(j).padStart(3, '0')}.jpg`)));
    const c = Math.min(cols, files.length), rows = Math.ceil(files.length / c);
    const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-start_number', '0', '-i', path.join(tmp, 't%03d.jpg'), '-frames:v', '1', '-vf', `scale=${tile}:${tile}:force_original_aspect_ratio=decrease,pad=${tile}:${tile}:(ow-iw)/2:(oh-ih)/2:white,tile=${c}x${rows}:padding=4:color=white`, '-q:v', '3', out]);
    return r.status === 0;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function film(frames: string, out: string, fps: number): string | null {
  const ff = ffmpeg();
  if (!ff) return null;
  const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, 'f%05d.jpg'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
  return r.status === 0 ? out : null;
}

export interface SceneRun { report: SceneReport; text: string; trace: string; reportFile: string; renderer: string; strips: string[]; film: string | null; notes: string[] }

/**
 * Play the scene, measure it, and (with `pictures`) play it again taking every frame: a strip per shot whose
 * crop is fixed for the shot (so a shake in the strip is a shake in the game), a dense strip of sixteen
 * consecutive steps at each failure, and a film.
 */
export async function playScene(o: PlayOpts & { out: string; label?: string; pictures?: boolean }): Promise<SceneRun> {
  const fps = o.fps ?? 30, notes: string[] = [];
  fs.mkdirSync(o.out, { recursive: true });
  let renderer = '';
  const trace = await withPage(o.url, size(o), async (page) => { await open(page, o); renderer = await page.renderer(); return play(page, o, false); }, { headed: !!o.gpu });
  const report = analyseScene(trace, 1 / fps, o.limits), text = sceneText(report, o.label ?? 'scene');
  const traceFile = path.join(o.out, 'trace.json'), reportFile = path.join(o.out, 'report.json');
  fs.writeFileSync(traceFile, JSON.stringify(trace));
  fs.writeFileSync(reportFile, JSON.stringify({ ...report, shot: undefined }, null, 1));
  fs.writeFileSync(path.join(o.out, 'report.txt'), text + '\n');
  const strips: string[] = []; let filmFile: string | null = null;
  if (o.pictures) {
    // the crop of each shot: everything the probe's screen points cover during it (fixed, so the strip does not move)
    const boxes = new Map<number, number[]>();
    trace.forEach((s, k) => { const b = boxes.get(report.shot[k]) ?? [1e9, 1e9, -1e9, -1e9]; for (const p of s.screen ?? []) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } boxes.set(report.shot[k], b); });
    const clipOf = (k: number) => { const b = boxes.get(report.shot[k])!, W = o.width, H = o.height; if (b[0] > 1e8) return { x: 0, y: 0, width: W, height: H }; const m = 34, side = Math.min(W, H, Math.max(150, b[2] - b[0] + m * 2, b[3] - b[1] + m * 2)); return { x: Math.max(0, Math.min(W - side, (b[0] + b[2]) / 2 - side / 2)), y: Math.max(0, Math.min(H - side, (b[1] + b[3]) / 2 - side / 2)), width: side, height: side }; };
    const FR = path.join(o.out, 'frames'), CR = path.join(o.out, 'crops'), ST = path.join(o.out, 'strips');
    for (const d of [FR, CR, ST]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
    const name = (dir: string, c: string, k: number) => path.join(dir, `${c}${String(k).padStart(5, '0')}.jpg`);
    const second = await withPage(o.url, size(o), async (page) => {
      await open(page, o);
      return play(page, o, true, async (_s, k) => {
        if (k >= trace.length) return;
        fs.writeFileSync(name(FR, 'f', k), await page.screenshot({ format: 'jpeg', quality: 86, clip: { x: 0, y: 0, width: o.width, height: o.height, scale: Math.min(1, 640 / o.width) } }));
        const c = clipOf(k);
        fs.writeFileSync(name(CR, 'c', k), await page.screenshot({ format: 'jpeg', quality: 88, clip: { ...c, scale: Math.min(1, 300 / c.width) } }));
      });
    }, { headed: !!o.gpu });
    if (second.length !== trace.length) notes.push(`the second play had ${second.length} steps, the first ${trace.length}: the scene is not the same twice (real time or randomness in it?)`);
    const have = (k: number) => fs.existsSync(name(CR, 'c', k));
    const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').slice(0, 28);
    for (const sh of [...new Set(report.shot)]) {
      const ks = report.shot.map((v, j) => (v === sh ? j : -1)).filter((j) => j >= 0 && have(j));
      if (ks.length < 4) continue;
      const N = Math.min(16, ks.length), out = path.join(ST, `${String(sh).padStart(2, '0')}-${safe(trace[ks[0]].beat)}.jpg`);
      if (strip(Array.from({ length: N }, (_, j) => name(CR, 'c', ks[Math.round(j * (ks.length - 1) / (N - 1))])), out)) strips.push(out);
    }
    for (const [n, c] of report.checks.filter((x) => !x.pass && x.frames.length).slice(0, 8).entries()) {
      const at = trace.findIndex((s) => s.i === c.frames[0][0]), picks = Array.from({ length: 16 }, (_, q) => Math.max(0, at - 2) + q).filter(have);
      const out = path.join(ST, `fail-${n + 1}-${safe(c.name)}-${safe(c.body)}-from${trace[picks[0]]?.i ?? 0}.jpg`);
      if (picks.length >= 4 && strip(picks.map((k) => name(CR, 'c', k)), out)) strips.push(out);
    }
    filmFile = film(FR, path.join(o.out, 'film.mp4'), fps);
    if (!filmFile || !strips.length) notes.push('no strips or film: ffmpeg is missing or failed (the frames are kept)');
    else { fs.rmSync(FR, { recursive: true, force: true }); fs.rmSync(CR, { recursive: true, force: true }); }
  }
  return { report, text, trace: traceFile, reportFile, renderer, strips, film: filmFile, notes };
}

/** Frames of the running game at a fixed step (default: the template game's own step and draw), a film and a strip. */
export async function captureFrames(o: PlayOpts & { out: string; every?: number }) {
  const fps = o.fps ?? 30, dt = 1 / fps, secs = o.seconds ?? 5, every = Math.max(1, Math.round(o.every ?? 1));
  const FR = path.join(o.out, 'frames');
  fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
  const stepExpr = fill(o.step ?? '(() => { const g = window.__game; g.paused = true; g.step({dt}); g.renderer.render(g.scene, g.camera); return 1; })()', dt, true);
  return withPage(o.url, size(o), async (page) => {
    const ok = await page.eval(`Promise.resolve(${o.ready ?? '(window.__studio ? window.__studio.ready : true)'}).then(() => true, (e) => String(e && e.message || e))`, 180000);
    if (ok !== true) throw new Error(`the game did not become ready: ${ok}`);
    if (o.start) await page.eval(`Promise.resolve(${o.start}).then(() => true)`, 120000);
    const renderer = await page.renderer(), files: string[] = [], t0 = Date.now();
    for (let i = 0, n = Math.round(secs * fps); i < n; i++) {
      await page.eval(`Promise.resolve(${stepExpr}).then(() => true)`, 60000);
      if (i % every) continue;
      const f = path.join(FR, `f${String(files.length).padStart(5, '0')}.jpg`);
      fs.writeFileSync(f, await page.screenshot({ format: 'jpeg', quality: 88 }));
      files.push(f);
    }
    const N = Math.min(16, files.length), stripFile = path.join(o.out, 'strip.jpg');
    const hasStrip = strip(Array.from({ length: N }, (_, j) => files[Math.round(j * (files.length - 1) / Math.max(1, N - 1))]), stripFile, 300, 8);
    const video = film(FR, path.join(o.out, 'film.mp4'), fps / every);
    const errors = page.logs.filter((l) => l.level === 'error').map((l) => l.text);
    return { renderer, gpu: !!o.gpu, frames: files.length, framesDir: FR, seconds: secs, fps, tookSeconds: +((Date.now() - t0) / 1000).toFixed(1), strip: hasStrip ? stripFile : null, video, errors, ...(video ? {} : { note: 'no film: ffmpeg is missing or failed (the frames are kept)' }) };
  }, { headed: !!o.gpu });
}
