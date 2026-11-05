// The proof module (Decision 31, Mac only): does the game still look right and run on a phone-sized
// screen? Fixed views with the clock and seed pinned, rendered by the game's own engine (Godot and/or the
// web build), FLIP picture diffs against the last approved pictures, budgets (draw calls, triangles, file
// size, frame time) and an imitated phone: a phone-sized WebKit window plus Chrome with the CPU throttled.
// Everything is local and free: Godot, Chrome, Playwright's WebKit, NVIDIA's flip-evaluator, ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as godot from '../../game/src/godot.ts';
import * as web from '../../game/src/web.ts';
import { resolveProject, workDir, type Engine } from '../../game/src/project.ts';
import { findChrome } from '../../game/src/chrome.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export type V3 = [number, number, number];
export interface ProofView { name: string; position: V3; target: V3; fov?: number }
export interface Budgets { drawCalls?: number; triangles?: number; glbMB?: number; phoneP50Ms?: number; phoneP95Ms?: number }
export interface ProofConfig {
  seed: number;
  steps: number;                       // fixed steps from load before the pictures (the pinned clock)
  size: number;                        // image width (height = 0.625 × width, both engines)
  views: ProofView[];
  budgets: Budgets;
  tolerance: { flipMean: number; over: number };   // a view "changed" above either
  phone?: { path: V3[]; seconds?: number; throttle?: number; lookAhead?: number; height?: number };
}

export const DEFAULT_CONFIG: Omit<ProofConfig, 'views'> = {
  seed: 1, steps: 30, size: 960,
  budgets: { drawCalls: 1500, triangles: 1_500_000, glbMB: 40, phoneP50Ms: 34, phoneP95Ms: 70 },
  tolerance: { flipMean: 0.015, over: 0.01 },
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
export const configFile = (dir: string) => path.join(dir, 'proof', 'proof.json');
export function readConfig(dir: string): ProofConfig {
  const f = configFile(dir);
  if (!fs.existsSync(f)) throw Object.assign(new Error(`no proof views for this game yet (${path.relative(process.cwd(), f)})`), { hint: 'studio proof init --project <game> --views \'[{"name":"plaza","position":[x,y,z],"target":[x,y,z]}]\'' });
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  return { ...DEFAULT_CONFIG, ...c, budgets: { ...DEFAULT_CONFIG.budgets, ...(c.budgets ?? {}) }, tolerance: { ...DEFAULT_CONFIG.tolerance, ...(c.tolerance ?? {}) } };
}
export function writeConfig(dir: string, c: Partial<ProofConfig>) {
  fs.mkdirSync(path.join(dir, 'proof'), { recursive: true });
  fs.writeFileSync(configFile(dir), JSON.stringify(c, null, 2) + '\n');
}

export function validateViews(views: any): ProofView[] {
  if (!Array.isArray(views) || !views.length) throw new Error('views must be a non-empty list of {name, position:[x,y,z], target:[x,y,z], fov?}');
  const names = new Set<string>();
  return views.map((v: any) => {
    if (!v || typeof v.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v.name)) throw new Error(`view name "${v?.name}" must be lowercase letters, digits and dashes`);
    if (names.has(v.name)) throw new Error(`two views are called ${v.name}`);
    names.add(v.name);
    for (const k of ['position', 'target']) if (!Array.isArray(v[k]) || v[k].length !== 3 || v[k].some((n: any) => typeof n !== 'number')) throw new Error(`view ${v.name}: ${k} must be [x, y, z]`);
    return { name: v.name, position: v.position, target: v.target, ...(v.fov ? { fov: Number(v.fov) } : {}) };
  });
}

// ── FLIP ───────────────────────────────────────────────────────────────────
export function findFlipPython(): string | null {
  const c = [process.env.FLIP_PYTHON, path.join(os.homedir(), '.studio-tools', 'venv', 'bin', 'python')].filter(Boolean) as string[];
  for (const p of c) if (fs.existsSync(p)) { const r = spawnSync(p, ['-I', '-c', 'import flip_evaluator, PIL, numpy'], { encoding: 'utf8' }); if (r.status === 0) return p; }
  return null;
}
export interface FlipResult { mean: number; p95: number; over: number; size: [number, number]; heatmap?: string; error?: string }
export function flipPairs(pairs: Array<{ ref: string; test: string; heatmap?: string }>): FlipResult[] {
  if (!pairs.length) return [];
  const py = findFlipPython();
  if (!py) throw Object.assign(new Error('FLIP is not installed'), { hint: 'python3 -m venv ~/.studio-tools/venv && ~/.studio-tools/venv/bin/pip install flip-evaluator pillow (free, local; or set FLIP_PYTHON)' });
  const r = spawnSync(py, ['-I', path.join(HERE, 'flip.py')], { input: JSON.stringify(pairs), encoding: 'utf8', maxBuffer: 64 << 20, timeout: 300000 });
  if (r.status !== 0) throw new Error(`flip failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return JSON.parse(r.stdout);
}

// ── rendering the views in each engine ────────────────────────────────────
export async function renderViews(dir: string, engine: Engine, c: ProofConfig, outDir: string): Promise<{ ok: boolean; error?: string; images: Record<string, string>; stats: any[]; memory?: any; warnings: string[]; errors: string[] }> {
  fs.mkdirSync(outDir, { recursive: true });
  const cmd = { cmd: 'views', views: c.views, size: c.size, seed: c.seed, steps: c.steps, prefix: 'proof' };
  const r: any = engine === 'godot'
    ? await godot.runnerCommand(dir, { ...cmd, outDir }, { windowed: true, size: c.size, timeoutMs: 240000 })
    : await web.webCommand(dir, cmd, { size: c.size });
  const images: Record<string, string> = {};
  for (const im of r.result?.images ?? []) {
    const dest = path.join(outDir, `${im.view}.png`);
    if (im.file && fs.existsSync(im.file)) { if (path.resolve(im.file) !== dest) fs.renameSync(im.file, dest); images[im.view] = dest; }
  }
  return { ok: r.ok !== false && Object.keys(images).length === c.views.length, error: r.error ?? (Object.keys(images).length !== c.views.length ? `${engine}: ${Object.keys(images).length} of ${c.views.length} views rendered` : undefined), images, stats: r.result?.stats ?? [], memory: r.result?.memory, warnings: r.warnings ?? [], errors: r.errors ?? [] };
}

/** Lay pictures out in a grid with ffmpeg (rows of `cols`), for the contact sheet. */
export function contactSheet(files: string[], cols: number, out: string, width = 480): string | null {
  if (!files.length) return null;
  const rows = Math.ceil(files.length / cols);
  const pad = [...files];
  while (pad.length < rows * cols) pad.push(files[0]);
  const inputs = pad.flatMap((f) => ['-i', f]);
  const scale = pad.map((_, i) => `[${i}:v]scale=${width}:-2[s${i}]`).join(';');
  const layout = pad.map((_, i) => `${(i % cols) === 0 ? '0' : Array.from({ length: i % cols }, () => 'w0').join('+')}_${Math.floor(i / cols) === 0 ? '0' : Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+')}`).join('|');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${scale};${pad.map((_, i) => `[s${i}]`).join('')}xstack=inputs=${pad.length}:layout=${layout}`, out], { encoding: 'utf8' });
  return r.status === 0 ? out : null;
}

export interface ViewReport { view: string; engine: Engine; status: 'same' | 'changed' | 'new'; flip?: FlipResult; image: string; drawCalls?: number; triangles?: number }

/** studio proof views: render, diff against approved, check budgets, optionally against the other engine. */
export async function proofViews(studioDir: string, project: string, opts: { against?: string; approveNew?: boolean } = {}) {
  const { dir, config } = resolveProject(studioDir, project);
  const c = readConfig(dir);
  const run = path.join(workDir(dir, 'proof'), stamp());
  const engines: Array<{ dir: string; engine: Engine; name: string }> = [{ dir, engine: config.engine, name: path.basename(dir) }];
  if (opts.against) { const o = resolveProject(studioDir, opts.against); engines.push({ dir: o.dir, engine: o.config.engine, name: path.basename(o.dir) }); }
  const reports: ViewReport[] = [];
  const renders: Record<string, Awaited<ReturnType<typeof renderViews>>> = {};
  const problems: string[] = [];
  for (const e of engines) {
    const r = await renderViews(e.dir, e.engine, c, path.join(run, e.engine));
    renders[e.engine] = r;
    if (!r.ok) problems.push(r.error ?? `${e.engine} failed`);
    for (const err of r.errors) problems.push(`${e.engine}: ${err}`);
    const approvedDir = path.join(e.dir, 'proof', 'approved', e.engine);
    const pairs = Object.entries(r.images).filter(([v]) => fs.existsSync(path.join(approvedDir, `${v}.png`))).map(([v, f]) => ({ view: v, ref: path.join(approvedDir, `${v}.png`), test: f, heatmap: path.join(run, e.engine, `${v}.diff.png`) }));
    const flips = flipPairs(pairs);
    for (const [v, f] of Object.entries(r.images)) {
      const k = pairs.findIndex((p) => p.view === v);
      const fl = k >= 0 ? flips[k] : undefined;
      const st = r.stats.find((s: any) => s.view === v) ?? {};
      const changed = fl && (fl.error || fl.mean > c.tolerance.flipMean || fl.over > c.tolerance.over);
      reports.push({ view: v, engine: e.engine, status: !fl ? 'new' : changed ? 'changed' : 'same', ...(fl ? { flip: fl } : {}), image: f, drawCalls: st.drawCalls, triangles: st.triangles });
    }
    if (opts.approveNew) for (const rep of reports.filter((x) => x.engine === e.engine && x.status === 'new')) { fs.mkdirSync(approvedDir, { recursive: true }); fs.copyFileSync(rep.image, path.join(approvedDir, `${rep.view}.png`)); }
  }
  // the two engines side by side (advisory: the look module will pin them closer)
  let parity: any = null;
  if (engines.length === 2 && renders.godot && renders.web) {
    const pairs = c.views.filter((v) => renders.godot.images[v.name] && renders.web.images[v.name]).map((v) => ({ view: v.name, ref: renders.godot.images[v.name], test: renders.web.images[v.name], heatmap: path.join(run, `${v.name}.godot-vs-web.png`) }));
    const fl = flipPairs(pairs);
    parity = Object.fromEntries(pairs.map((p, i) => [p.view, { mean: fl[i]?.mean, over: fl[i]?.over }]));
  }
  // budgets
  const glb = path.join(dir, 'assets', 'studio', 'scene.glb');
  const budget = (name: string, value: number | undefined, max: number | undefined, unit = '') => ({ name, value, max, pass: value === undefined || max === undefined || value <= max, detail: value === undefined ? 'not measured' : `${+value.toFixed(2)}${unit} / ${max}${unit}` });
  const maxOf = (k: 'drawCalls' | 'triangles') => { const v = reports.map((r) => r[k]).filter((x): x is number => typeof x === 'number'); return v.length ? Math.max(...v) : undefined; };
  const budgets = [
    budget('draw calls (worst view)', maxOf('drawCalls'), c.budgets.drawCalls),
    budget('triangles drawn (worst view)', maxOf('triangles'), c.budgets.triangles),
    budget('scene file', fs.existsSync(glb) ? fs.statSync(glb).size / 1048576 : undefined, c.budgets.glbMB, ' MB'),
  ];
  const sheetFiles = c.views.flatMap((v) => engines.map((e) => renders[e.engine]?.images[v.name]).filter(Boolean) as string[]);
  const sheet = contactSheet(sheetFiles, engines.length === 2 ? 4 : 3, path.join(run, 'sheet.png'));
  const changed = reports.filter((r) => r.status === 'changed');
  const report = {
    ok: !problems.length && !changed.length && budgets.every((b) => b.pass),
    run, seed: c.seed, steps: c.steps, views: reports.map(({ image, ...r }) => ({ ...r, image: path.relative(studioDir, image) })),
    changed: changed.map((r) => `${r.engine}/${r.view}: FLIP mean ${r.flip?.mean} (> ${c.tolerance.flipMean}) or ${(100 * (r.flip?.over ?? 0)).toFixed(2)}% pixels changed`),
    new: reports.filter((r) => r.status === 'new').map((r) => `${r.engine}/${r.view}`),
    budgets, parity, problems, sheet: sheet ? path.relative(studioDir, sheet) : null,
    memory: Object.fromEntries(Object.entries(renders).map(([k, v]) => [k, v.memory])),
  };
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

/** Accept the latest run's pictures as the new reference (all views, or --views a,b). */
export function approve(studioDir: string, project: string, views?: string[]) {
  const { dir } = resolveProject(studioDir, project);
  const root = path.join(dir, '.studio-game', 'proof');
  const runs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'report.json'))).sort() : [];
  if (!runs.length) throw new Error('no proof run to approve: studio proof views first');
  const run = path.join(root, runs[runs.length - 1]);
  const done: string[] = [];
  for (const engine of ['godot', 'web']) {
    const src = path.join(run, engine);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, 'proof', 'approved', engine);
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.png') && !x.includes('.diff'))) {
      const v = f.replace(/\.png$/, '');
      if (views && !views.includes(v)) continue;
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
      done.push(`${engine}/${v}`);
    }
  }
  return { approved: done, from: path.relative(studioDir, run) };
}

// ── the imitated phone ─────────────────────────────────────────────────────

/** The fly-through the phone run times: the camera moves along the path at eye height, looking ahead. */
const PERF_FN = `async (o) => {
  const g = window.__game; if (!g) return { error: 'no game (window.__game)' };
  g.paused = true;
  const cam = g.camera, path = o.path, secs = o.seconds;
  const seg = []; let L = 0;
  for (let i = 0; i + 1 < path.length; i++) { const a = path[i], b = path[i + 1]; const l = Math.hypot(b[0]-a[0], b[2]-a[2]); seg.push([a, b, l, L]); L += l; }
  const at = (d) => { d = Math.max(0, Math.min(L - 0.001, d)); for (const [a, b, l, s] of seg) if (d <= s + l) { const t = (d - s) / l; return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; } return path[path.length-1]; };
  cam.far = Math.max(cam.far, 1500); cam.updateProjectionMatrix();
  const times = []; let calls = 0, tris = 0;
  await new Promise((res) => {
    let last = performance.now(); const t0 = last;
    const f = (now) => {
      const dt = now - last; last = now; if (now !== t0) times.push(dt);
      const d = ((now - t0) / 1000) / secs * L;
      const p = at(d), q = at(d + (o.lookAhead || 25));
      cam.position.set(p[0], p[1] + (o.height || 1.7), p[2]); cam.lookAt(q[0], q[1] + (o.height || 1.7) - 0.3, q[2]);
      g.renderer.render(g.scene, cam);
      calls = Math.max(calls, g.renderer.info.render.calls); tris = Math.max(tris, g.renderer.info.render.triangles);
      if (now - t0 < secs * 1000) requestAnimationFrame(f); else res(0);
    };
    requestAnimationFrame(f);
  });
  const s = times.slice().sort((a, b) => a - b), q = (k) => s.length ? +s[Math.min(s.length - 1, Math.floor(k * s.length))].toFixed(1) : null;
  const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
  const gl = g.renderer.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { frames: times.length, p50: q(0.5), p95: q(0.95), max: q(1), longFrames: times.filter((t) => t > 50).length, drawCalls: calls, triangles: tris, jsHeapMB: mem, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), viewport: [innerWidth, innerHeight, devicePixelRatio] };
}`;

export async function phone(studioDir: string, project: string, opts: { seconds?: number; throttle?: number } = {}) {
  const { dir, config } = resolveProject(studioDir, project);
  if (config.engine !== 'web') throw new Error(`${path.basename(dir)} is a Godot game: the phone run drives the web build (--project <web game>)`);
  const c = readConfig(dir);
  if (!c.phone?.path?.length) throw new Error('proof.json has no phone.path (a walk route: [[x,y,z], …])');
  let pw: any;
  try { pw = await import('playwright-core'); } catch { throw Object.assign(new Error('playwright-core is not installed'), { hint: 'npm install (it is an optional dependency), then npx playwright-core install webkit' }); }
  const b = await web.bundle(dir);
  if (!b.ok) throw new Error(`the game did not compile: ${b.errors.join('; ')}`);
  const seconds = opts.seconds ?? c.phone.seconds ?? 8, throttle = opts.throttle ?? c.phone.throttle ?? 4;
  const run = path.join(workDir(dir, 'proof'), `phone-${stamp()}`);
  fs.mkdirSync(run, { recursive: true });
  const phoneCtx = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
  const results: any = {};
  await web.serve(dir, async (url) => {
    for (const which of ['webkit', 'chrome-throttled'] as const) {
      let browser: any;
      try {
        browser = which === 'webkit' ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: findChrome() ?? undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
        const ctx = await browser.newContext(which === 'webkit' ? phoneCtx : { ...phoneCtx, userAgent: undefined });
        const page = await ctx.newPage();
        const logs: string[] = [];
        page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()}: ${m.text()}`); });
        page.on('pageerror', (e: any) => logs.push(`error: ${e.message}`));
        if (which === 'chrome-throttled') { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
        const t0 = Date.now();
        await page.goto(url + 'index.html');
        const ready = await page.evaluate(`Promise.race([window.__studio?.ready, new Promise((_, j) => setTimeout(() => j(new Error('not ready in 120 s')), 120000))]).then(() => true, (e) => String(e && e.message || e))`);
        const loadSeconds = (Date.now() - t0) / 1000;
        if (ready !== true) { results[which] = { ok: false, error: String(ready), logs }; continue; }
        const perf = await page.evaluate(`(${PERF_FN})(${JSON.stringify({ path: c.phone!.path, seconds, lookAhead: c.phone!.lookAhead, height: c.phone!.height })})`);
        const shot = path.join(run, `${which}.png`);
        await page.screenshot({ path: shot });
        results[which] = { ok: !perf.error && !logs.some((l) => l.startsWith('error')), loadSeconds: +loadSeconds.toFixed(1), ...perf, ...(which === 'chrome-throttled' ? { cpuThrottle: throttle } : {}), screenshot: path.relative(studioDir, shot), logs: logs.slice(0, 12) };
      } catch (e: any) {
        results[which] = { ok: false, error: e.message };
      } finally { await browser?.close(); }
    }
  });
  const worst = Object.values(results).filter((r: any) => r.ok) as any[];
  const p50 = worst.length ? Math.max(...worst.map((r) => r.p50)) : undefined, p95 = worst.length ? Math.max(...worst.map((r) => r.p95)) : undefined;
  const budgets = [
    { name: 'phone frame time p50 (worst run)', value: p50, max: c.budgets.phoneP50Ms, pass: p50 !== undefined && p50 <= (c.budgets.phoneP50Ms ?? Infinity), detail: `${p50} ms / ${c.budgets.phoneP50Ms} ms` },
    { name: 'phone frame time p95 (worst run)', value: p95, max: c.budgets.phoneP95Ms, pass: p95 !== undefined && p95 <= (c.budgets.phoneP95Ms ?? Infinity), detail: `${p95} ms / ${c.budgets.phoneP95Ms} ms` },
  ];
  const report = {
    ok: Object.values(results).every((r: any) => r.ok) && budgets.every((b) => b.pass), run: path.relative(studioDir, run), seconds, results, budgets,
    caveat: 'Imitated phone (Decision 31, option B): Playwright WebKit at 390×844 @3x and Chrome with the CPU slowed, on this Mac\'s GPU. Real iPhone memory limits and GPU precision are not tested.',
  };
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
