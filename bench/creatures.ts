// Phase 8 bench proofs (Decisions 52–54, "animate anything"): four things that are not people, each
// made from rig parts through the real CLI and daemon, checked, and rendered to video:
//   crab      six-legged robot crab with a whip tail walking (plus a live steered walk over bumps and
//             a deliberately wrong replay, so the check timeline shows red where feet slide)
//   snake     a snake slithering (follow-the-leader serpentine)
//   car       a car on a bumpy road (wheels roll at ground speed, springy suspension; plus live steering)
//   windmill  a windmill turning with grass swaying
//   node bench/creatures.ts [crab|snake|car|windmill …] [--out dir]   (default: all, checkpoint-phase8/)
// STUDIO_PORT default 4608, STUDIO_CHROME_PORT default 9470.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const out = path.resolve(oi >= 0 ? argv[oi + 1] : path.join(ROOT, 'checkpoint-phase8'));
const which = argv.filter((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1));
const ALL = ['crab', 'snake', 'car', 'windmill'];
const picked = which.length ? which : ALL;
const env = { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4608', STUDIO_CHROME_PORT: process.env.STUDIO_CHROME_PORT ?? '9470' };

let failed = 0;
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-creatures-'));
const studio = (...args: string[]) => {
  const raw = execFileSync('node', [path.join(ROOT, 'packages/cli/studio.ts'), ...args], { cwd: proj, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 900000 });
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(`studio ${args[0]}: ${r.error}`);
  console.log(`✓ ${r.summary ?? args[0]}`);
  return r;
};
try {
for (const name of picked) {
  if (!ALL.includes(name)) throw new Error(`unknown bench creature ${name} (${ALL.join(', ')})`);
  const made = studio('new-creature', '--preset', name);
  const id = made.result.id;
  const checks = studio('motion-checks', '--object', id).result.checks as Record<string, Array<{ name: string; pass: boolean; worst: number; limit: number; unit: string }>>;
  for (const [mid, ks] of Object.entries(checks)) {
    const bad = ks.filter((k) => !k.pass);
    console.log(`  ${mid}: ${ks.length} checks${bad.length ? `, FAILING ${bad.map((k) => `${k.name} (${k.worst}${k.unit} > ${k.limit})`).join('; ')}` : ', all pass'}`);
    failed += bad.length;
  }
  const dir = path.join(out, name);
  const r = studio('creature-preview', '--object', id, '--video', 'true', '--out', dir, ...(name === 'crab' ? ['--demo-failure', 'true'] : []));
  console.log(`  video:  ${r.result.video}\n  stills: ${r.result.stills.length} in ${path.dirname(r.result.stills[0])}\n  glb:    ${r.result.glb}`);
}
} finally {
  try { studio('stop'); } catch { /* not running */ }
  fs.rmSync(proj, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} failing check(s)`); process.exit(1); }
console.log(`\nall ${picked.length} creature bench(es) pass`);
