// IK Yard: a small Godot game that proves live feet by default (Decision 52). Built entirely through
// /game: the studio makes a yard (five 15 cm steps up to a landing, a 14° slope down the far side, a
// patch of bumpy ground with a few rocks), the Apprentice (a kit humanoid, the player) and a crab and a
// spider (rig-part creatures); `game import` brings them into Godot. Nothing is wired by hand: the
// import exports the creatures skinned with extras.ik, and the managed studio scripts attach
// foot_ik.gd to the player and creature_ik.gd to the creatures. The game's own code (game/main.gd)
// only asks the creatures to wander.
// Run from the repo root: node games/ik-yard/build.ts   (then node games/ik-yard/proof.ts)
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, Studio, exportGame, selectForExport } from '../../packages/core/src/index.ts';
import { exportGameCreatures } from '../../packages/core/src/gamecreatures.ts';
import { runGame, type GameContext } from '../../packages/game/src/index.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const GAME = path.resolve(import.meta.dirname);

await initKernel();
const studio = new Studio();
const ok = (t: string, a: object) => { const r = studio.call(t, a); if (!r.ok) throw new Error(`${t} ${JSON.stringify(a).slice(0, 200)}: ${r.error}`); return r; };

/** Builds the yard into `ok` (the studio's own tools). Exported for the test. */
export function buildYard(call: typeof ok) {
  const RISE = 0.15, TREAD = 0.32, WIDTH = 1.4, N = 5;
  // the steps: one box per step, each from the floor up (solid stairs), then the landing at 0.75 m
  const steps: Array<Record<string, unknown>> = [];
  for (let k = 0; k < N; k++) steps.push({ id: `s${k}`, op: 'box', part: 'step', output: false, args: { size: [WIDTH, RISE * (k + 1), TREAD], at: [0, (RISE * (k + 1)) / 2, TREAD * k + TREAD / 2] } });
  const landingD = 1.6, top = RISE * N;
  call('new-object', { name: 'Steps', type: 'stairs', material: 'concrete', color: '#b9b2a4', position: [0, 0, -1.6] });
  for (const s of steps) call('add-op', s);
  call('add-op', { id: 'landing', op: 'box', part: 'landing', output: false, args: { size: [WIDTH, top, landingD], at: [0, top / 2, TREAD * N + landingD / 2] } });
  call('add-op', { id: 'stairs', op: 'union', inputs: [...steps.map((s) => s.id as string), 'landing'], output: true });
  call('set-profile', { profile: 'godot-desktop' });
  // the slope down the far side: a wedge (a box turned about X, trimmed at the floor), about 14°
  const run = top / Math.tan((14 * Math.PI) / 180);
  const len = Math.hypot(run, top);
  call('new-object', { name: 'Slope', type: 'ramp', material: 'concrete', color: '#a9a294', position: [0, 0, -1.6 + TREAD * N + landingD] });
  call('add-op', { id: 'slab', op: 'box', part: 'slope', output: false, args: { size: [WIDTH, 0.4, len + 0.4], at: [0, -0.2, len / 2] } });
  call('add-op', { id: 'tilt', op: 'rotate', inputs: ['slab'], output: false, args: { deg: [(Math.atan2(top, run) * 180) / Math.PI, 0, 0] } });
  call('add-op', { id: 'lift', op: 'translate', inputs: ['tilt'], output: false, args: { by: [0, top, 0] } });
  call('add-op', { id: 'floorCut', op: 'box', part: 'slope', output: false, args: { size: [WIDTH + 1, 2, len + 2], at: [0, -1, len / 2] } });
  call('add-op', { id: 'backCut', op: 'box', part: 'slope', output: false, args: { size: [WIDTH + 1, 3, 1], at: [0, 0.5, -0.5] } });
  call('add-op', { id: 'wedge', op: 'difference', inputs: ['lift', 'floorCut', 'backCut'], output: true });
  call('set-profile', { profile: 'godot-desktop' });
  // bumpy ground beside the stairs: low domes (caps of big spheres) and a few rocks
  const bumps: Array<[number, number, number, number]> = [ // x, z, sphere radius, cap height
    [-0.9, -0.8, 0.6, 0.15], [0.5, -1.0, 0.55, 0.12], [-0.3, 0.1, 0.7, 0.17], [0.9, 0.4, 0.6, 0.14], [-1.3, 0.8, 0.5, 0.1], [0.3, 1.2, 0.6, 0.13], [1.5, -0.3, 0.45, 0.1], [-0.5, -1.7, 0.5, 0.11], [1.6, 1.4, 0.5, 0.12],
  ];
  call('new-object', { name: 'Bumpy ground', type: 'terrain', material: 'concrete', color: '#8f7a55', position: [3.6, 0, 0] });
  bumps.forEach(([x, z, r, h], i) => call('add-op', { id: `b${i}`, op: 'sphere', part: 'ground', output: false, args: { r, at: [x, h - r, z] } }));
  call('add-op', { id: 'domes', op: 'union', inputs: bumps.map((_, i) => `b${i}`), output: false });
  call('add-op', { id: 'below', op: 'box', part: 'ground', output: false, args: { size: [6, 2, 6], at: [0, -1, 0] } });
  call('add-op', { id: 'ground', op: 'difference', inputs: ['domes', 'below'], output: true });
  call('set-profile', { profile: 'godot-desktop' });
  for (const [i, [x, z, s]] of ([[2.4, 1.6, 0.16], [4.9, -1.5, 0.2], [5.1, 1.2, 0.14]] as Array<[number, number, number]>).entries()) {
    call('new-object', { name: `Rock ${i + 1}`, type: 'rock', material: 'concrete', color: '#857c6c', position: [x, 0, z] });
    call('add-op', { id: 'rock', op: 'roundedBox', part: 'rock', args: { size: [s * 1.6, s, s * 1.2], r: s * 0.3, at: [0, s / 2 - 0.02, 0] } });
    call('set-profile', { profile: 'godot-desktop' });
  }
  // the player: the Apprentice at the foot of the steps, facing up them (+Z)
  call('new-character', { name: 'Apprentice', preset: 'apprentice', position: [0, 0, -3.4] });
  call('set-motion', { object: 'apprentice', id: 'idle', kind: 'idle' });
  call('set-motion', { object: 'apprentice', id: 'walk', kind: 'walk', speed: 1.0 });
  // the creatures on the bumpy ground
  call('new-creature', { preset: 'crab', name: 'Crab', position: [3.1, 0, -0.7] });
  call('new-creature', { preset: 'spider', name: 'Spider', position: [4.2, 0, 0.8] });
}

if (import.meta.main) {
  buildYard(ok);
  const ctx: GameContext = {
    studioDir: ROOT,
    async exportGlb(out, object, engine, opts = {}) {
      const items = selectForExport(studio, studio.doc(), { object, exclude: opts.exclude, atOrigin: opts.atOrigin });
      const r = await exportGame(items, { target: engine, baker: null, evaluateOp: (o, i) => studio.evaluateOp(o, i) });
      fs.writeFileSync(out, r.glb);
      return { ok: true, result: { file: out, skipped: [] } };
    },
    async objectInfo(ref) { try { const o = studio.findObject(studio.doc(), ref); return { id: o.id, name: o.name, position: o.position, rotation: o.rotation ?? 0, character: o.semanticType === 'character' }; } catch { return null; } },
    async creatures(outDir, opts) { return exportGameCreatures(studio.doc(), outDir, opts); },
  };
  if (!fs.existsSync(path.join(GAME, 'studio-game.json'))) {
    const r = await runGame('game-init', { name: 'ik-yard', engine: 'godot', dir: 'games/ik-yard' }, ctx);
    if (!r.ok) throw new Error(`game-init: ${r.error}`);
  }
  const imp = await runGame('game-import', { project: 'games/ik-yard', player: 'Apprentice' }, ctx);
  console.log(JSON.stringify({ ok: imp.ok, error: imp.error, failures: imp.failures, creatures: imp.result?.creatures, characters: imp.result?.characters, player: imp.result?.player, roundTrip: imp.result && { triangles: imp.result.roundTrip.triangles, warnings: imp.result.roundTrip.warnings, errors: imp.result.roundTrip.errors, creatures: imp.result.roundTrip.creatures } }, null, 2));
  if (!imp.ok) process.exitCode = 1;
}
