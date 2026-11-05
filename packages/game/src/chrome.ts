// Minimal headless Chrome driver over the DevTools protocol (no Puppeteer): launch, open a URL,
// evaluate expressions, collect console warnings/errors. Software GL (SwiftShader) so it works
// without a GPU, same flags the studio's own view tests use.
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

export interface Page {
  eval<T = any>(expression: string, timeoutMs?: number): Promise<T>;
  logs: Array<{ level: string; text: string }>;
  /** The whole page as the player sees it — the canvas and any HTML UI over it (Fire's Dying pain #4). */
  screenshot(opts?: { format?: 'png' | 'jpeg'; quality?: number }): Promise<Buffer>;
}

/** Launch Chrome, open `url`, run `fn(page)`, always clean up. */
export async function withPage<T>(url: string, size: { width: number; height: number }, fn: (page: Page) => Promise<T>): Promise<T> {
  const bin = findChrome();
  if (!bin) throw Object.assign(new Error('Chrome not found'), { hint: 'install Google Chrome or set CHROME_BIN' });
  // a random start inside the range: test files run in parallel, and two Chromes racing for one free port
  // would leave one of them driving the other's page
  const base = Number(process.env.STUDIO_CHROME_PORT ?? 9370);
  const port = await freePort(base + Math.floor(Math.random() * 30), base + 50);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-game-chrome-'));
  const child: ChildProcess = spawn(bin, [
    '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${size.width},${size.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank',
  ], { stdio: 'ignore' });
  let ws: WebSocket | null = null;
  try {
    let target: any = null;
    for (let i = 0; i < 80 && !target; i++) {
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
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    const page: Page = {
      logs,
      async eval(expression, timeoutMs = 120000) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
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
    return await fn(page);
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
