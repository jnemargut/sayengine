// Phase 8 bench proofs (Decisions 52–55, "animate anything"): things that are not people, each made
// from rig parts through the real CLI and daemon, checked, and rendered to video with stills:
//   crab      a crab with a whip tail walking sideways (plus a live steered walk and a deliberately
//             wrong replay, so the check timeline shows red where feet slide)
//   spider    a spider on alternating tetrapods
//   octopus   "the octopus pours tea": a one-off action from key moments (perform-action), then the
//             same action after the notes "slower, more weight" and "hold the pour longer" (action-note)
//   bird      flap, glide and hover loops, and "the bird takes off, flies and lands"
//   fish      a fish swimming (carangiform) and an eel (anguilliform); output in fish/ and eel/
//   windmill  sails turning with shader grass, and "the windmill creaks to a stop"
//   snake     slithering;  car  a bumpy road
//   trip      "make him trip over the bucket": a kit humanoid's one-off action, next to a bucket
//   node bench/creatures.ts [names …] [--out dir]   (default: all, checkpoint-phase8/)
// STUDIO_PORT default 4630, STUDIO_CHROME_PORT default 9510.
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
const ALL = ['crab', 'spider', 'octopus', 'bird', 'fish', 'windmill', 'snake', 'car', 'trip'];
const picked = which.length ? which : ALL;
const env = { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4630', STUDIO_CHROME_PORT: process.env.STUDIO_CHROME_PORT ?? '9510' };
const action = (name: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/actions', `${name}.json`), 'utf8'));

let failed = 0;
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-creatures-'));
const studio = (...args: string[]) => {
  const raw = execFileSync('node', [path.join(ROOT, 'packages/cli/studio.ts'), ...args], { cwd: proj, env, encoding: 'utf8', maxBuffer: 64 << 20, timeout: 1800000 });
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(`studio ${args[0]}: ${r.error}`);
  console.log(`✓ ${(r.summary ?? args[0]).slice(0, 400)}`);
  return r;
};
const report = (checks: Record<string, Array<{ name: string; pass: boolean; worst: number; limit: number; unit: string }>>) => {
  for (const [mid, ks] of Object.entries(checks)) {
    const bad = ks.filter((k) => !k.pass);
    console.log(`  ${mid}: ${ks.length} checks${bad.length ? `, FAILING ${bad.map((k) => `${k.name} (${k.worst}${k.unit} > ${k.limit})`).join('; ')}` : ', all pass'}`);
    failed += bad.length;
  }
};
const preview = (id: string, dir: string, extra: string[] = []) => {
  const r = studio('creature-preview', '--object', id, '--video', 'true', '--out', dir, ...extra);
  console.log(`  video:  ${r.result.video}\n  stills: ${r.result.stills.length} in ${path.dirname(r.result.stills[0])}\n  glb:    ${r.result.glb}`);
};
const perform = (id: string, file: string, extra: string[] = []) => {
  const a = action(file);
  return studio('perform-action', '--object', id, '--action', a.action, '--id', a.id, '--keys', JSON.stringify(a.keys), ...(a.style ? ['--style', JSON.stringify(a.style)] : []), ...extra);
};

try {
  for (const name of picked) {
    if (!ALL.includes(name)) throw new Error(`unknown bench task ${name} (${ALL.join(', ')})`);
    if (name === 'trip') {
      // a kit humanoid trips over a bucket: one-off action keys in the character format, the universal
      // checks on the result, and the motion preview with the bucket beside him
      const made = studio('new-character', '--preset', 'blacksmith', '--name', 'Tom');
      const id = made.result.id;
      studio('new-object', '--name', 'Bucket', '--type', 'bucket', '--color', '#7d8a8f', '--position', '[2,0,0]');
      studio('add-op', '--object', 'bucket', '--id', 'body', '--op', 'revolve', '--args', JSON.stringify({ profile: [[0, 0.004], [0.095, 0.004], [0.11, 0.2], [0.104, 0.2], [0.09, 0.012], [0, 0.012]] }), '--output', 'true');
      const a = action('humanoid-trips');
      const r = studio('perform-action', '--object', id, '--action', a.action, '--id', a.id, '--keys', JSON.stringify(a.keys), '--duration', String(a.duration));
      report({ [a.id]: r.result.checks });
      const p = studio('motion-preview', '--object', id, '--motions', a.id, '--video', 'true', '--out', path.join(out, 'trip'), '--with', 'Bucket', '--at', JSON.stringify(a.bucket));
      console.log(`  video:  ${p.result.video}`);
      continue;
    }
    const made = studio('new-creature', '--preset', name === 'fish' ? 'fish' : name);
    const id = made.result.id;
    if (name === 'octopus') {
      perform(id, 'octopus-pours-tea');
      perform(id, 'octopus-pours-tea', ['--id', 'pour-tea-noted']);
      studio('action-note', '--object', id, '--motion', 'pour-tea-noted', '--note', 'slower, more weight');
      studio('action-note', '--object', id, '--motion', 'pour-tea-noted', '--note', 'hold the pour longer');
    }
    if (name === 'bird') perform(id, 'bird-takes-off');
    if (name === 'windmill') perform(id, 'windmill-creaks-to-a-stop');
    report(studio('motion-checks', '--object', id).result.checks);
    // long renders are split (the CLI's request to the daemon times out after ~5 minutes)
    if (name === 'bird') {
      preview(id, path.join(out, 'bird'), ['--motions', 'idle,fly,glide,hover', '--live', 'false']);
      preview(id, path.join(out, 'bird-takeoff'), ['--motions', 'takeoff-fly-land', '--live', 'false']);
    } else if (name === 'octopus') {
      preview(id, path.join(out, 'octopus'), ['--motions', 'idle,pour-tea']);
      preview(id, path.join(out, 'octopus-noted'), ['--motions', 'pour-tea-noted', '--live', 'false']);
    } else preview(id, path.join(out, name), name === 'crab' ? ['--demo-failure', 'true'] : []);
    if (name === 'fish') {
      const eel = studio('new-creature', '--preset', 'eel').result.id;
      report(studio('motion-checks', '--object', eel).result.checks);
      preview(eel, path.join(out, 'eel'));
    }
  }
} finally {
  try { studio('stop'); } catch { /* not running */ }
  fs.rmSync(proj, { recursive: true, force: true });
}
if (failed) { console.error(`\n${failed} failing check(s)`); process.exit(1); }
console.log(`\nall ${picked.length} creature bench task(s) pass`);
