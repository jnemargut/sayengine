// Phase 7 artefacts (Decisions 47–51): a cast of studio-made characters that don't look alike.
//   • the cast built in-process (one character per body plan and style, via presets), every check run
//     (including the cast outline check and the speech-shape check),
//   • a lineup still + front still + turntable MP4 (checkpoint-phase7/cast/),
//   • a motion preview per body plan (walk in its own gait, run, idle; MP4 + stills).
// Run: node bench/cast.ts  (needs Chrome; ffmpeg for the MP4s)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, selectForExport, toGLB, validateGlb } from '../packages/core/src/index.ts';
import { bakeMotion } from '../packages/core/src/motion.ts';
import { buildCastLineup, captureCast } from '../packages/daemon/src/castplayer/make.ts';
import { buildMotionPreview, captureMotionVideo, showTime } from '../packages/daemon/src/motionplayer/make.ts';

export const CAST: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'Blacksmith', args: { preset: 'blacksmith' } },
  { name: 'Apprentice', args: { preset: 'apprentice' } },
  { name: 'Goblin Shopkeeper', args: { preset: 'goblin' } },
  { name: 'Robot Porter', args: { preset: 'robot' } },
  { name: 'Marsh Bird', args: { preset: 'bird', palette: 'forest' } },
  { name: 'Kid', args: { preset: 'kid' } },
  { name: 'Elder', args: { preset: 'elder' } },
  // week 12: four legs, a tail and wings
  { name: 'Dog', args: { preset: 'dog' } },
  { name: 'Heron Courier', args: { preset: 'birdfolk' } },
];

/** Build the cast in a studio (used by the bench runner too). */
export function buildCast(call: (tool: string, args: any) => any) {
  for (const c of CAST) call('new-character', { name: c.name, ...c.args });
}

if (import.meta.main) {
  const OUT = path.resolve(import.meta.dirname, '..', 'checkpoint-phase7');
  fs.mkdirSync(OUT, { recursive: true });
  await initKernel();
  const studio = new Studio();
  buildCast((t, a) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; });
  const doc = studio.doc();
  const report: string[] = [];
  const cast = [];
  for (const id of doc.objectOrder) {
    const o = doc.objects[id];
    const checks = studio.checks(id);
    const bad = checks.filter((c) => !c.pass && !c.pending);
    const castC = checks.find((c) => c.id === 'cast-outline'), speech = checks.find((c) => c.id === 'speech-shapes');
    const sp = studio.evaluate(o).rig!.rig.spec;
    const label = `${sp.plan} · ${sp.face.kind} mouth · ${sp.params.height} m`;
    report.push(`${o.name} (${label}): ${checks.length - bad.length}/${checks.length} checks pass${bad.length ? ` — FAIL: ${bad.map((c) => `${c.label}: ${c.detail}`).join(' | ')}` : ''}\n   cast: ${castC?.detail}\n   speech: ${speech?.detail}`);
    const items = selectForExport(studio, doc, { object: id, atOrigin: true });
    const glb = toGLB(items, {});
    if (!(await validateGlb(glb)).ok) throw new Error(`${id}: GLB does not validate`);
    cast.push({ id, name: o.name, label, glb, height: sp.params.height, idle: 'idle', headH: sp.face.headH, headY: sp.face.headBase[1], headZ: sp.face.headBase[2] });
  }
  fs.writeFileSync(path.join(OUT, 'checks.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  const castDir = path.join(OUT, 'cast');
  fs.rmSync(castDir, { recursive: true, force: true });
  await buildCastLineup(castDir, 'The cast: one studio, six body plans, tails and wings', cast);
  const cap = await captureCast(castDir);
  console.log(`lineup: ${cap.still}${cap.video ? `, turntable ${cap.video}` : ` (${cap.note})`}`);

  // a motion preview per body plan: its walk (in its own gait), a run and an idle
  const biped = { run: { kind: 'run' } };
  const per: Array<[string, string, string[], Record<string, any>]> = [
    ['blacksmith', 'stocky', ['walk', 'run', 'idle'], biped], ['apprentice', 'lanky', ['walk', 'run', 'idle'], biped], ['marsh-bird', 'beaked', ['walk', 'run', 'idle'], biped],
    ['kid', 'chibi', ['walk', 'run', 'idle'], biped], ['elder', 'human', ['walk', 'run', 'idle'], biped],
    // the dog: walk → trot → gallop → sit (and lie down); the bird-person walks, then beats its wings
    ['dog', 'quadruped', ['walk', 'trot', 'gallop', 'sit', 'lie', 'idle'], { gallop: { kind: 'gallop' }, lie: { kind: 'lie' } }],
    ['heron-courier', 'beaked-winged', ['walk', 'flap', 'idle'], { flap: { kind: 'idle', flap: 2.2, duration: 3 } }],
  ];
  fs.mkdirSync(path.join(OUT, 'motions'), { recursive: true });
  const only = process.env.ONLY?.split(',');
  for (const [id, plan, mids, extra] of process.env.CAST_ONLY ? [] : per.filter((p) => !only || only.includes(p[0]))) {
    const o = doc.objects[id];
    const solo = { ...o, character: { ...o.character, motions: { ...o.character!.motions, ...extra } } };
    const sdoc = { ...doc, objects: { ...doc.objects, [id]: solo as any } };
    const items = selectForExport(studio, sdoc, { object: id, atOrigin: true });
    const glb = toGLB(items, {});
    const rig = items[0].res.rig!.rig;
    const motions = mids.map((mid) => {
      const spec = (solo.character.motions as any)[mid];
      const c = bakeMotion(mid, spec, rig, solo.character);
      return { id: mid, kind: spec.kind, label: `${o.name} (${plan}): ${mid}${spec.style ? ` — ${spec.style}` : ''}${c.speed ? `, ${c.speed.toFixed(2)} m/s, ${Math.round(((c.paws ? 4 : 2) / c.duration) * 60)} ${c.paws ? 'footfalls' : 'steps'}/min` : ''}${spec.flap ? `, wings ${spec.flap}/s` : ''}`, duration: c.duration, loop: c.loop, speed: c.speed, show: showTime(c) };
    });
    const dir = path.join(os.tmpdir(), `phase7-${id}-motions`);
    fs.rmSync(dir, { recursive: true, force: true });
    await buildMotionPreview(dir, o.name, glb, motions);
    const r = await captureMotionVideo(dir, motions);
    if (r.video) fs.copyFileSync(r.video, path.join(OUT, 'motions', `${plan}-${id}.mp4`));
    for (const st of r.stills ?? []) fs.copyFileSync(st, path.join(OUT, 'motions', `${plan}-${path.basename(st)}`));
    console.log(`motions: ${o.name} (${plan}) ${r.seconds} s`);
  }
}
