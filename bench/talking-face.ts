// Phase 3 week 4 checkpoint (Decision 21): the blacksmith, built from the character kit, says three
// short lines in close-up. Everything goes through the real CLI and daemon: new-character → say ×3
// (local Kokoro voice → Rhubarb → smoothed speech-shape curves) → line-preview --video (the exported
// GLB in three.js, rendered frame by frame in headless Chrome, muxed with the audio by ffmpeg).
//   node bench/talking-face.ts [outDir]     (default: checkpoint-week4/; STUDIO_PORT default 4589)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-week4'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-talking-face-'));
const env = { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4589' };

function studio(...args: string[]) {
  const raw = execFileSync('node', [path.join(ROOT, 'packages/cli/studio.ts'), ...args], { cwd: proj, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 600000 });
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(`studio ${args[0]}: ${r.error}`);
  console.log(`✓ ${r.summary ?? args[0]}`);
  for (const [obj, c] of Object.entries<any>(r.checks ?? {})) for (const f of c.failures ?? []) console.log(`  ! ${obj}: ${f.label} — ${f.detail}`);
  return r;
}

const LINES: Array<[string, string]> = [
  ['Hold still. This will only take a second.', 'firm'],
  ['Bring me the big hammer, and mind the embers.', 'firm'],   // M/B/P closures
  ['Perfect. Now we wait for the metal to cool.', 'calm'],
];

try {
  studio('new-character', '--preset', 'blacksmith', '--name', 'Blacksmith');
  for (const [text, emotion] of LINES) studio('say', '--text', text, '--emotion', emotion);
  const r = studio('line-preview', '--video', 'true', '--out', out);
  console.log(`\nvideo:  ${r.result.video}\nplayer: ${r.result.page} (serve the folder: npx http-server ${out})\nstills: ${r.result.stills.map((s: string) => path.basename(s)).join(', ')}`);
} finally {
  try { execFileSync('node', [path.join(ROOT, 'packages/cli/studio.ts'), 'stop'], { cwd: proj, env, stdio: 'ignore' }); } catch { /* not running */ }
  fs.rmSync(proj, { recursive: true, force: true });
}
