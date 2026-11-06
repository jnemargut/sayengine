// Shared client for the engine daemon — used by the `studio` CLI and the MCP adapter.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.STUDIO_PORT ?? 4517);
export const BASE = `http://127.0.0.1:${PORT}`;
export const DIR = path.resolve(process.env.STUDIO_DIR ?? process.cwd());
/** How long to wait for a daemon that is listening but busy (a long tool call) before giving up. */
const BUSY_WAIT_MS = Number(process.env.STUDIO_BUSY_WAIT_MS ?? 300000);

export async function healthy(timeoutMs = 800): Promise<{ ok: boolean; dir?: string } | null> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Is anything accepting connections on the port? (A busy daemon still accepts: the OS queues them.) */
export function portOpen(timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(true));     // no refusal: something holds the port
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function sameDir(h: { dir?: string }) {
  if (h.dir && path.resolve(h.dir) !== DIR) {
    throw new Error(`a studio daemon for ${h.dir} is already on port ${PORT} — run \`studio stop\` there, or set STUDIO_PORT for this project`);
  }
}

/**
 * Start the daemon for DIR if none is listening. Returns a note when it started one.
 * A daemon that is busy (a big creature solving, a capture) misses the quick health check but still
 * holds the port: wait for it instead of starting a second one (which would only die on the port).
 */
export async function ensureDaemon(): Promise<string | null> {
  const h = await healthy();
  if (h) { sameDir(h); return null; }
  if (await portOpen()) {
    const t0 = Date.now();
    let noted = false;
    while (Date.now() - t0 < BUSY_WAIT_MS) {
      const b = await healthy(5000);
      if (b) { sameDir(b); return null; }
      if (!(await portOpen())) break;            // it went away: start one below
      if (!noted && Date.now() - t0 > 10000) { process.stderr.write(`studio: the daemon on port ${PORT} is busy — waiting for it\n`); noted = true; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (await portOpen()) throw new Error(`something on port ${PORT} is not answering the studio health check (a daemon busy for over ${Math.round(BUSY_WAIT_MS / 1000)} s, or another program) — see ${path.join(DIR, '.studio', 'daemon.log')}, or set STUDIO_PORT`);
  }
  fs.mkdirSync(path.join(DIR, '.studio'), { recursive: true });
  const log = fs.openSync(path.join(DIR, '.studio', 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'studio.ts'), 'serve'], {
    cwd: DIR, detached: true, stdio: ['ignore', log, log], env: { ...process.env, STUDIO_DIR: DIR },
  });
  child.unref();
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const up = await healthy(2000);
    if (up) { sameDir(up); return `started engine daemon for ${DIR} — view at http://localhost:${PORT}`; }
  }
  throw new Error(`could not start the daemon — see ${path.join(DIR, '.studio', 'daemon.log')}`);
}

/**
 * One tool call. Plain node:http with no timeout: a video capture of a heavy creature can run for
 * many minutes, longer than fetch's built-in 300 s header timeout (which failed with "fetch failed").
 */
export function callTool(tool: string, args: object, author = process.env.STUDIO_AUTHOR ?? 'claude', why?: string): Promise<any> {
  const body = JSON.stringify({ tool, args, author, ...(why ? { why } : {}) });
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`the daemon answered ${res.statusCode} with something that isn't JSON: ${text.slice(0, 200)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', (e: any) => reject(new Error(e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED'
      ? `the daemon went away during "${tool}" (${e.code}) — see ${path.join(DIR, '.studio', 'daemon.log')}`
      : `calling the daemon failed: ${e.message}`)));
    req.setTimeout(0);
    req.end(body);
  });
}
