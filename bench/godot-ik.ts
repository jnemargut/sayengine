// Godot live IK (Decision 52, deferred in Phase 8): creatures export skinned (core creatureskin.ts) so
// Godot 4.7 imports a Skeleton3D, and the studio's Godot scripts drive its own IK nodes live:
//   stairs — a kit humanoid's baked walk up a flight of stairs, feet planted by studio/foot_ik.gd
//   crab   — the crab strafing over bumpy ground, stepping and planting live (studio/creature_ik.gd)
//   baked  — the same crab playing only its baked walk on that ground (the fallback), for comparison
//   reach  — the octopus's arm following a goal on a figure eight (FABRIK3D, live)
// Each shot is captured in Godot (30 fps), turned into a video and stills, and measured: the crab's
// capture goes through the universal motion checks (creatureChecks) as a clip.
// Run: node bench/godot-ik.ts [outDir] [shots…]   (outDir default checkpoint-godot-live-ik)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio } from '../packages/core/src/index.ts';
import { exportGame } from '../packages/core/src/gameexport.ts';
import { creatureWithClips } from '../packages/core/src/creatures.ts';
import { creatureSkinnedGLB, creatureIkInfo } from '../packages/core/src/creatureskin.ts';
import { creatureChecks, terrainHeight, type CreatureClip, type TerrainSpec } from '../packages/core/src/rigparts.ts';
import { qAxisAngle, qMul, qRot, type Q, type V3 } from '../packages/core/src/rig.ts';
import { findGodot } from '../packages/game/src/index.ts';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.resolve(process.argv[2] ?? path.join(ROOT, 'checkpoint-godot-live-ik'));
const shots = process.argv.slice(3).length ? process.argv.slice(3) : ['stairs', 'crab', 'baked', 'spider', 'reach'];
fs.mkdirSync(outDir, { recursive: true });
const godot = findGodot();
if (!godot) { console.log('skip: Godot not installed'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(process.env.BENCH_TMP ?? os.tmpdir(), 'godot-ik-'));
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'studio'), { recursive: true });

// ── the project ────────────────────────────────────────────────────────────────────────────────
const tpl = path.join(ROOT, 'packages', 'game', 'templates', 'godot');
fs.writeFileSync(path.join(proj, 'project.godot'), fs.readFileSync(path.join(tpl, 'project.godot'), 'utf8').replace('{{NAME}}', 'godot-ik-bench').replace('res://game/main.tscn', 'res://ik_bench.tscn'));
for (const f of ['creature_ik.gd', 'foot_ik.gd']) fs.copyFileSync(path.join(tpl, 'studio', f), path.join(proj, 'studio', f));
fs.copyFileSync(path.join(ROOT, 'bench', 'godot-ik', 'ik_bench.gd'), path.join(proj, 'ik_bench.gd'));
fs.writeFileSync(path.join(proj, 'ik_bench.tscn'), '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://ik_bench.gd" id="1"]\n\n[node name="Bench" type="Node3D"]\nscript = ExtResource("1")\n');

// ── assets: the skinned crab and octopus, a kit humanoid, the bumpy ground ─────────────────────
await initKernel();
const crab = creatureWithClips('crab');
const octo = creatureWithClips('octopus');
const spider = creatureWithClips('spider');
fs.writeFileSync(path.join(proj, 'crab.glb'), creatureSkinnedGLB(crab.c, crab.clips));
fs.writeFileSync(path.join(proj, 'octopus.glb'), creatureSkinnedGLB(octo.c, octo.clips));
fs.writeFileSync(path.join(proj, 'spider.glb'), creatureSkinnedGLB(spider.c, spider.clips));
const studio = new Studio();
const step = (t: string, a: object) => { const r: any = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r.result; };
step('new-character', { name: 'Apprentice', preset: 'apprentice', position: [0, 0, 0] });
step('set-motion', { object: 'apprentice', id: 'walk', kind: 'walk', speed: 1.0 });
const doc = studio.doc();
const charId = studio.findObject(doc, 'apprentice').id;
const ex = await exportGame([{ obj: doc.objects[charId], res: studio.evaluate(doc.objects[charId]) }], { target: 'godot', baker: null, evaluateOp: (o, op) => studio.evaluateOp(o, op) } as any);
fs.writeFileSync(path.join(proj, 'apprentice.glb'), ex.glb);
const walk = crab.clips.find((x) => x.id === 'walk')!;
// bumps up to about ±15 cm (a third of the crab's leg reach), with short ones a foot can land across
const bumpy: TerrainSpec = { period: 6, bumps: [{ amp: 0.085, k: 2, kx: 1.9 }, { amp: 0.045, k: 5, phase: 1.1, kx: 3.7 }, { amp: 0.02, k: 11, phase: 0.4, kx: 6.1 }] };
const N = 120, SIZE = 6;
const heights: number[] = [];
for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) heights.push(+terrainHeight(bumpy, -SIZE / 2 + (SIZE * i) / N, -SIZE / 2 + (SIZE * j) / N).toFixed(5));
fs.writeFileSync(path.join(proj, 'bench.json'), JSON.stringify({ n: N, size: SIZE, heights, crabSpeed: walk.speed, walkSpeed: 1.0, ik: creatureIkInfo(crab.c), octoIk: creatureIkInfo(octo.c), spiderIk: creatureIkInfo(spider.c), spiderSpeed: spider.clips.find((x) => x.id === 'walk')?.speed ?? 0.3 }));

const run = (args: string[], timeout = 240000) => {
  const r = spawnSync(godot.bin, args, { cwd: proj, encoding: 'utf8', timeout, maxBuffer: 1 << 28 });
  return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const imp = run(['--headless', '--path', proj, '--import'], 300000);
const importErrors = imp.text.split('\n').filter((l) => /ERROR|SCRIPT ERROR/.test(l));
if (importErrors.filter((l) => !/UVs are required/.test(l)).length) console.log(`import: ${importErrors.slice(0, 8).join('\n')}`);

const report: any = { out: outDir, godot: godot.version, shots: {} };
const ff = (args: string[]) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const r3 = (x: number) => +x.toFixed(3);

for (const shot of shots) {
  const frames = path.join(tmp, 'frames', shot);
  fs.mkdirSync(frames, { recursive: true });
  const seconds = shot === 'stairs' ? 6 : 8;
  const r = run(['--resolution', '960x600', '--position', '30000,30000', '--fixed-fps', '30', '--path', proj, 'res://ik_bench.tscn', '--', `--shot=${shot}`, `--out=${frames}`, `--seconds=${seconds}`]);
  const errs = r.text.split('\n').filter((l) => /SCRIPT ERROR|ERROR:/.test(l) && !/UVs are required/.test(l)).slice(0, 10);
  if (errs.length) console.log(`${shot}: Godot said\n  ${errs.join('\n  ')}`);
  if (!/IK_BENCH_DONE/.test(r.text)) { console.log(`FAIL ${shot}: Godot did not finish\n${r.text.slice(-3000)}`); report.shots[shot] = { error: errs }; continue; }
  const video = path.join(outDir, `${shot}.mp4`);
  ff(['-framerate', '30', '-i', path.join(frames, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', video]);
  fs.mkdirSync(path.join(outDir, 'stills'), { recursive: true });
  const n = fs.readdirSync(frames).filter((f) => f.endsWith('.png')).length;
  const stills = [0.25, 0.5, 0.75, 0.95].map((u) => { const k = Math.min(n - 1, Math.round(u * (n - 1))); const dst = path.join(outDir, 'stills', `${shot}-${String(k).padStart(3, '0')}.png`); fs.copyFileSync(path.join(frames, `${String(k).padStart(5, '0')}.png`), dst); return dst; });
  const m = JSON.parse(fs.readFileSync(path.join(frames, 'metrics.json'), 'utf8'));
  const res: any = { video, stills, frames: n, errors: errs, clip: m.clip };
  if (shot === 'stairs') res.feet = stairsMetrics(m.frames);
  if (shot === 'crab') res.checks = liveChecks(crab.c, m);
  if (shot === 'spider') res.checks = liveChecks(spider.c, m);
  if (shot === 'baked') res.checks = bakedChecks();
  if (shot === 'reach') {
    const st = (e: number[]) => ({ meanCm: r3(e.reduce((s, x) => s + x, 0) / e.length * 100), p95Cm: r3(pct(e, 0.95) * 100), maxCm: r3(Math.max(...e) * 100) });
    // tip → goal includes the designed lag of the damped follow (1.6 Hz, as the web runtime); tip → the
    // followed point is the IK alone
    res.reach = { tipToGoal: st(m.reachErr), tipToFollowed: st(m.reachIk), samples: m.reachErr.length };
  }
  report.shots[shot] = res;
  console.log(`${shot}: ${n} frames → ${path.relative(ROOT, video)} ${JSON.stringify(res.feet ?? res.reach ?? (res.checks ? res.checks.summary : ''))}`);
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
if (!process.env.BENCH_KEEP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log(`kept ${tmp}`);
console.log(`report: ${path.join(outDir, 'report.json')}`);

// ── measures ───────────────────────────────────────────────────────────────────────────────────
/** Humanoid feet on the stairs. A foot is planted while its ankle barely moves across the ground
 *  (< 0.12 m/s). For planted frames: the sole's gap to the ground under it (the lower of heel and toe,
 *  each against its own height on the flat floor at the start), how far the ankle drifts during one plant
 *  (sliding), and frames where the toes go into a step. */
function stairsMetrics(rows: any[]) {
  const out: any = {};
  const skip = 10;
  for (const s of ['Left', 'Right']) {
    const flat = rows.slice(skip, 40);
    const a0 = pct(flat.map((r) => r[s].ankle[1] - r[s].ground), 0.05), t0 = pct(flat.map((r) => r[s].toe[1] - r[s].ground), 0.05);
    const gap: number[] = [];
    const drift: number[] = [];
    let toeIn = 0, planted = 0, runStart: number[] | null = null, runMax = 0;
    for (let f = skip + 1; f < rows.length; f++) {
      const r = rows[f], q = rows[f - 1][s].ankle, an = r[s].ankle;
      const v = Math.hypot(an[0] - q[0], an[2] - q[2]) * 30;
      if (r[s].toe[1] - r[s].ground < -0.012) toeIn++;
      if (v < 0.12) {
        planted++;
        gap.push(Math.min(an[1] - r[s].ground - a0, r[s].toe[1] - r[s].ground - t0));
        if (!runStart) { runStart = an; runMax = 0; }
        runMax = Math.max(runMax, Math.hypot(an[0] - runStart[0], an[2] - runStart[2]));
      } else if (runStart) { drift.push(runMax); runStart = null; }
    }
    if (runStart) drift.push(runMax);
    out[s] = { plantedFrames: planted, soleGapP95Cm: r3(pct(gap.map(Math.abs), 0.95) * 100), soleGapMaxCm: r3(Math.max(...gap.map(Math.abs)) * 100), plantDriftMaxCm: r3(Math.max(0, ...drift) * 100), toeIntoStepFrames: toeIn };
  }
  out.climbedM = r3(rows[rows.length - 1].root[1] - rows[0].root[1]);
  return out;
}

/** A creature's live capture (the crab, the spider) as a clip, through the universal motion checks on the bumpy ground. */
function liveChecks(c: typeof crab.c, m: any) {
  const names: string[] = m.bones;
  const idx = c.bones.map((b) => { const i = names.indexOf(b.name); return i >= 0 ? i : names.indexOf(b.name.replace(/\./g, '_')); });
  const rows: any[] = m.frames.slice(15);
  const F = rows.length - 1;
  const legsOf = creatureIkInfo(c).legs;
  const clip: CreatureClip = {
    id: 'live', kind: 'walk', fps: 30, frames: F, duration: F / 30, loop: false, speed: 0, dir: [1, 0, 0],
    // the Body (the root bone) carries the creature's travel and yaw: world = root + yaw × pose
    rot: rows.map((r) => idx.map((g, bi) => (c.parents[bi] < 0 && c.bones[bi].name === 'Body' ? qMul(qAxisAngle([0, 1, 0], (r.yaw * 180) / Math.PI), r.rot[g]) : r.rot[g]) as Q)),
    off: rows.map((r) => idx.map((g, bi) => {
      const p = c.parents[bi];
      const rest = p < 0 ? c.bones[bi].head : c.bones[bi].head.map((v, k) => v - c.bones[p].head[k]);
      if (p < 0 && c.bones[bi].name === 'Body') {
        const w = qRot(qAxisAngle([0, 1, 0], (r.yaw * 180) / Math.PI), r.pos[g]);
        return [w[0] + r.root[0] - rest[0], w[1] - rest[1], w[2] + r.root[2] - rest[2]] as V3;
      }
      return r.pos[g].map((v: number, k: number) => v - rest[k]) as V3;
    })),
    contacts: rows.map((r) => c.contacts.map((cd) => { const li = legsOf.findIndex((l) => l.knee === cd.bone); return li >= 0 ? !!r.down[li] : false; })),
    notes: [], reachMiss: 0,
  };
  const live = { ...c, def: { ...c.def, terrain: bumpy } };
  const checks = creatureChecks(live as any, clip);
  // a live run is not a loop and does not end in idle: those two don't apply
  const use = checks.filter((k) => !/loop|idle/i.test(k.name));
  // how close the drawn feet are to the runtime's targets (the IK's own accuracy), and the fastest joint
  const miss = rows.flatMap((r) => r.feet.map((p: number[], i: number) => Math.hypot(p[0] - r.targets[i][0], p[1] - r.targets[i][1], p[2] - r.targets[i][2])));
  let fastest = 0;
  for (let f = 1; f <= F; f++) for (let b = 0; b < c.bones.length; b++) {
    const q0 = clip.rot[f - 1][b], q1 = clip.rot[f][b];
    const d = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
    fastest = Math.max(fastest, (2 * Math.acos(Math.min(1, d)) * 180 / Math.PI) * 30);
  }
  const steps = rows.reduce((n: number, r: any, i: number) => n + (i ? r.down.filter((d: boolean, k: number) => d && !rows[i - 1].down[k]).length : 0), 0);
  return { footToTargetP95Cm: r3(pct(miss, 0.95) * 100), footToTargetMaxCm: r3(Math.max(...miss) * 100), fastestJointDegS: Math.round(fastest), footfalls: steps, travelledM: r3(Math.hypot(rows[rows.length - 1].root[0] - rows[0].root[0], rows[rows.length - 1].root[2] - rows[0].root[2])),
    summary: `${use.filter((k) => k.pass).length}/${use.length} pass`, checks: use.map((k) => `${k.pass ? 'ok' : 'NO'} ${k.name}: worst ${k.worst} ${k.unit} (limit ${k.limit})${k.pass ? '' : ` frames ${JSON.stringify(k.frames.slice(0, 4))}`}`), notApplicable: checks.filter((k) => /loop|idle/i.test(k.name)).map((k) => k.name) };
}

/** The baked walk (no live IK) on the same bumpy ground: what the fallback gets wrong there. */
function bakedChecks() {
  const c = { ...crab.c, def: { ...crab.c.def, terrain: bumpy } };
  const checks = creatureChecks(c as any, walk);
  return { summary: `${checks.filter((k) => k.pass).length}/${checks.length} pass`, checks: checks.map((k) => `${k.pass ? 'ok' : 'NO'} ${k.name}: worst ${k.worst} ${k.unit} (limit ${k.limit})`) };
}
