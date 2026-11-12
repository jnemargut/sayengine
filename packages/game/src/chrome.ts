// Minimal headless Chrome driver over the DevTools protocol (no Puppeteer): launch, open a URL,
// evaluate expressions, collect console warnings/errors. Software GL (SwiftShader) so it works
// without a GPU, same flags the studio's own view tests use.
// Every Chrome this process launches is in one registry, killed (and its temp profile removed) on exit, on
// SIGINT/SIGTERM/SIGHUP and on an uncaught error, not only in withPage's finally: a finally never runs
// when the runner is killed, and orphaned Chromes and profiles piled up. Profiles live in one known folder
// (<tmp>/studio-game-chrome/<owner pid>-*), and the first launch sweeps any whose owner is gone.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome', 'chromium', 'chromium-browser',
].filter(Boolean) as string[];

export function findChrome(): string | null {
  for (const c of CANDIDATES) {
    if (c.includes('/')) { if (fs.existsSync(c)) return c; continue; }
    const r = spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function freePort(start: number, end = start + 50): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > end) return reject(new Error('no free debugging port'));
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

// ── the registry ─────────────────────────────────────────────────────────
export const PROFILE_ROOT = path.join(os.tmpdir(), 'studio-game-chrome');
const live = new Map<number, { child: ChildProcess; profile: string }>();
let installed = false;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };
function processes(): Array<{ pid: number; cmd: string }> {
  const r = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m![1]), cmd: m![2] }));
}
const rmProfile = (dir: string) => { for (let i = 0; i < 5; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* Chrome still letting go */ } } };

/** Kill every Chrome this process launched and remove its profile. Synchronous: safe in 'exit'. */
export function killAllBrowsers(): number {
  let n = 0;
  for (const [pid, b] of live) { try { b.child.kill('SIGKILL'); n++; } catch { /* gone */ } rmProfile(b.profile); live.delete(pid); }
  return n;
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', killAllBrowsers);
  process.on('uncaughtExceptionMonitor', killAllBrowsers);   // observes only; the crash still happens
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const h = () => {
      killAllBrowsers();
      process.off(sig, h);
      // nobody else listens: die of the signal as if we had never been here (exit code 128 + n)
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, h);
  }
}

/**
 * Remove profiles (and kill their Chromes) left by runners that died without cleaning up: a profile in
 * PROFILE_ROOT whose owner pid is gone, and old-style tmp/studio-game-chrome-* profiles no process uses.
 */
export function sweepOrphans(): { killed: number; removed: number } {
  let killed = 0, removed = 0;
  const dirs: string[] = [];
  if (fs.existsSync(PROFILE_ROOT)) for (const d of fs.readdirSync(PROFILE_ROOT)) {
    const owner = Number(d.split('-')[0]);
    if (!owner || (owner !== process.pid && !alive(owner))) dirs.push(path.join(PROFILE_ROOT, d));
  }
  const legacy = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('studio-game-chrome-')).map((d) => path.join(os.tmpdir(), d));
  if (!dirs.length && !legacy.length) return { killed, removed };
  const procs = processes();
  for (const d of dirs) for (const p of procs) if (p.cmd.includes(`--user-data-dir=${d}`)) { try { process.kill(p.pid, 'SIGKILL'); killed++; } catch { /* gone */ } }
  for (const d of legacy) if (!procs.some((p) => p.cmd.includes(`--user-data-dir=${d}`))) dirs.push(d);
  for (const d of dirs) { rmProfile(d); removed++; }
  return { killed, removed };
}

/** A fresh temp profile owned by this process. */
export function newProfile(): string {
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(PROFILE_ROOT, `${process.pid}-`));
}

/** Spawn a browser into the registry: it dies with this process however the process ends. */
export function spawnBrowser(bin: string, args: string[], profile: string): { child: ChildProcess; release(): void } {
  if (!installed) { install(); try { sweepOrphans(); } catch { /* best effort */ } }
  const child = spawn(bin, args, { stdio: 'ignore' });
  if (child.pid) live.set(child.pid, { child, profile });
  return {
    child,
    release() { try { child.kill('SIGKILL'); } catch { /* gone */ } if (child.pid) live.delete(child.pid); rmProfile(profile); },
  };
}

export interface Page {
  eval<T = any>(expression: string, timeoutMs?: number): Promise<T>;
  logs: Array<{ level: string; text: string }>;
  /** The whole page as the player sees it — the canvas and any HTML UI over it (Fire's Dying pain #4). */
  screenshot(opts?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
  /** real touch input (with size.touch): 'touchStart' | 'touchMove' with the fingers now down, 'touchEnd' with those still down (usually none) */
  touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id?: number }>): Promise<void>;
}

/**
 * Launch Chrome, open `url`, run `fn(page)`, always clean up (also when the process is killed).
 * `timeoutMs` (or STUDIO_PAGE_TIMEOUT_MS) is a hard limit on the whole page; 0 means none.
 */
export async function withPage<T>(url: string, size: { width: number; height: number; deviceScaleFactor?: number; mobile?: boolean; touch?: boolean }, fn: (page: Page) => Promise<T>, opts: { timeoutMs?: number } = {}): Promise<T> {
  const bin = findChrome();
  if (!bin) throw Object.assign(new Error('Chrome not found'), { hint: 'install Google Chrome or set CHROME_BIN' });
  // a random start inside the range: test files run in parallel, and two Chromes racing for one free port
  // would leave one of them driving the other's page
  // STUDIO_CHROME_SPAN keeps the ports inside [base, base + span) when a project has a fixed port range
  const base = Number(process.env.STUDIO_CHROME_PORT ?? 9370), span = Number(process.env.STUDIO_CHROME_SPAN ?? 0);
  const port = span > 0 ? await freePort(base + Math.floor(Math.random() * span), base + span - 1).catch(() => freePort(base, base + span - 1)) : await freePort(base + Math.floor(Math.random() * 30), base + 50);
  const profile = newProfile();
  const browser = spawnBrowser(bin, [
    '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${size.width},${size.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank',
  ], profile);
  const limit = opts.timeoutMs ?? Number(process.env.STUDIO_PAGE_TIMEOUT_MS ?? 0);
  let timer: NodeJS.Timeout | undefined;
  let ws: WebSocket | null = null;
  try {
    let target: any = null;
    // a loaded machine (Godot and other Chromes rendering) can take well over 10 s to start Chrome
    for (let i = 0; i < 320 && !target; i++) {
      await new Promise((r) => setTimeout(r, 125));
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t: any) => t.type === 'page'); } catch { /* not up yet */ }
    }
    if (!target) throw new Error('Chrome did not open a debugging target');
    ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((r, j) => { ws!.once('open', r); ws!.once('error', j); });
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    const logs: Page['logs'] = [];
    // software-GL performance chatter from headless Chrome itself, not from the game
    const noise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL/;
    const push = (level: string, text: string) => { if (!noise.test(text)) logs.push({ level, text }); };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) push(m.params.type === 'warning' ? 'warning' : 'error', m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') push('error', m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'exception');
      if (m.method === 'Log.entryAdded' && ['warning', 'error'].includes(m.params.entry.level)) push(m.params.entry.level, `${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
    });
    const send = (method: string, params: object = {}, timeoutMs = 60000) => new Promise<any>((resolve, reject) => {
      const my = ++id;
      const t = setTimeout(() => { pending.delete(my); reject(new Error(`${method} timed out`)); }, timeoutMs);
      pending.set(my, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      ws!.send(JSON.stringify({ id: my, method, params }));
    });
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    // a phone: its pixel ratio, the mobile viewport rules and real touch events (page.touch); the default is a desktop page
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor ?? 1, mobile: !!size.mobile });
    if (size.touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
    await send('Page.navigate', { url });
    const page: Page = {
      logs,
      async eval(expression, timeoutMs = 120000) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async touch(type: 'touchStart' | 'touchMove' | 'touchEnd', points: Array<{ x: number; y: number; id?: number }>) { await send('Input.dispatchTouchEvent', { type, touchPoints: points.map((q, k) => ({ x: q.x, y: q.y, id: q.id ?? k })) }); },
      async screenshot(o: { format?: 'png' | 'jpeg'; quality?: number } = {}) {
        const r = await send('Page.captureScreenshot', { format: o.format ?? 'png', ...(o.format === 'jpeg' ? { quality: o.quality ?? 85 } : {}), captureBeyondViewport: false });
        return Buffer.from(r.data, 'base64');
      },
    };
    // wait for the document to exist before handing over
    for (let i = 0; i < 100; i++) {
      try { if ((await page.eval('document.readyState', 2000)) === 'complete') break; } catch { /* navigating */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!(limit > 0)) return await fn(page);
    return await Promise.race([fn(page), new Promise<never>((_, j) => { timer = setTimeout(() => j(new Error(`page timed out after ${limit} ms`)), limit); })]);
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch { /* closed */ }
    browser.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150));
    browser.release();
  }
}
