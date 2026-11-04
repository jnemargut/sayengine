// Shared client for the engine daemon — used by the `studio` CLI and the MCP adapter.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.STUDIO_PORT ?? 4517);
export const BASE = `http://127.0.0.1:${PORT}`;
export const DIR = path.resolve(process.env.STUDIO_DIR ?? process.cwd());

export async function healthy(): Promise<{ ok: boolean; dir?: string } | null> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** Start the daemon for DIR if none is listening. Returns a note when it started one. */
export async function ensureDaemon(): Promise<string | null> {
  const h = await healthy();
  if (h) {
    if (h.dir && path.resolve(h.dir) !== DIR) {
      throw new Error(`a studio daemon for ${h.dir} is already on port ${PORT} — run \`studio stop\` there, or set STUDIO_PORT for this project`);
    }
    return null;
  }
  fs.mkdirSync(path.join(DIR, '.studio'), { recursive: true });
  const log = fs.openSync(path.join(DIR, '.studio', 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'studio.ts'), 'serve'], {
    cwd: DIR, detached: true, stdio: ['ignore', log, log], env: { ...process.env, STUDIO_DIR: DIR },
  });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await healthy()) return `started engine daemon for ${DIR} — view at http://localhost:${PORT}`;
  }
  throw new Error(`could not start the daemon — see ${path.join(DIR, '.studio', 'daemon.log')}`);
}

export async function callTool(tool: string, args: object, author = process.env.STUDIO_AUTHOR ?? 'claude'): Promise<any> {
  const r = await fetch(`${BASE}/api/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args, author }),
  });
  return r.json();
}
