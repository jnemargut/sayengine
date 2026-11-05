// Benches capture from the live view (Phase 10 step 2: the separate players are retired). Serves an
// in-process studio through a daemon so the bench can call the preview commands (which play on the
// view's timeline and capture it in headless Chrome) or take stills of the view directly.
//   STUDIO_PORT (default 4713) for the daemon; STUDIO_CHROME_PORT / STUDIO_CHROME_SPAN for Chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Studio } from '../packages/core/src/index.ts';
import { startDaemon } from '../packages/daemon/src/server.ts';
import { stillsFromView, captureFromView, type ViewSegment } from '../packages/daemon/src/viewcapture.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let built = false;

export async function openView(studio: Studio, port = Number(process.env.STUDIO_PORT ?? 4713)) {
  if (!built) { execFileSync(process.execPath, [path.join(ROOT, 'apps/view/build.ts')], { stdio: 'ignore' }); built = true; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-viewbench-'));
  const { server, url } = await startDaemon({ dir, port, studio });
  return {
    url,
    /** A daemon command (motion-preview, cutscene-preview, …) as the CLI would call it. */
    async call(tool: string, args: Record<string, unknown>): Promise<any> {
      const r = await (await fetch(`${url}/api/call`, { method: 'POST', body: JSON.stringify({ tool, args }) })).json();
      if (!r.ok) throw new Error(`${tool}: ${r.error}`);
      return r;
    },
    stills: (out: string, shots: Array<ViewSegment & { t: number; name: string }>, size?: { width: number; height: number }) => stillsFromView(url, out, shots, size),
    capture: (out: string, segs: ViewSegment[], opts?: Parameters<typeof captureFromView>[3]) => captureFromView(url, out, segs, opts),
    close() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
