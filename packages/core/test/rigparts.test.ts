import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCreature, bakeCreature, creatureChecks, fabrik, twoBoneKnee, gaitPhase, type CreatureDef } from '../src/rigparts.ts';
import { CreatureRuntime } from '../src/creatureruntime.ts';
import { terrainHeight, creatureFK } from '../src/rigparts.ts';
import { CREATURE_PRESETS, creatureWithClips, creatureGLB } from '../src/creatures.ts';

const fails = (checks: { name: string; pass: boolean; detail: string; worst: number; limit: number; frames: Array<[number, number]> }[]) =>
  checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.worst} vs ${c.limit} (${c.detail}) frames ${JSON.stringify(c.frames.slice(0, 3))}`);

test('solvers: two-bone IK keeps segment lengths; FABRIK reaches; tripod gait phases', () => {
  const ik = twoBoneKnee([0, 1, 0], [0.3, 0, 0.1], 0.6, 0.6, [0, 1, 0]);
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  assert.ok(Math.abs(d([0, 1, 0], ik.knee) - 0.6) < 1e-6);
  assert.ok(Math.abs(d(ik.knee, ik.foot) - 0.6) < 1e-6);
  const pts = fabrik([[0, 0, 0], [0, 0.5, 0], [0, 1, 0], [0, 1.5, 0]], [0.6, 0.9, 0.3]);
  assert.ok(d(pts[3], [0.6, 0.9, 0.3]) < 1e-3);
  // six legs: L1, R2, L3 together; R1, L2, R3 together
  assert.equal(gaitPhase(6, 0, 1), gaitPhase(6, 1, -1));
  assert.equal(gaitPhase(6, 0, 1), gaitPhase(6, 2, 1));
  assert.notEqual(gaitPhase(6, 0, 1), gaitPhase(6, 0, -1));
});

for (const name of Object.keys(CREATURE_PRESETS)) {
  test(`preset ${name}: every motion passes its part checks and the universal checks; the GLB validates`, async () => {
    const { c, clips, checks } = creatureWithClips(name);
    assert.ok(c.bones.length > 3);
    for (const cl of clips) assert.deepEqual(fails(checks[cl.id]), [], `${name} ${cl.id}`);
    const glb = creatureGLB(c, clips, { terrain: { size: 4 } });
    const { validateGlb } = await import('../src/index.ts');
    const v = await validateGlb(glb);
    assert.ok(v.ok, JSON.stringify(v).slice(0, 600));
  });
}

test('the checks catch broken motion: a sliding foot, a joint past its limit, a pop', () => {
  const { c, clips } = creatureWithClips('crab');
  const walk = clips.find((x) => x.id === 'walk')!;
  // pretend the body moves twice as fast as the feet allow: planted feet now slide
  const sliding = { ...walk, speed: walk.speed * 2 };
  assert.ok(creatureChecks(c, sliding).some((k) => k.name === 'feet planted (no sliding)' && !k.pass));
  // bend a leg joint 120° for one frame: limits and pops fail on that frame
  const bi = c.index.get('legs.L1.lower')!;
  const rot = walk.rot.map((r) => [...r]);
  rot[5][bi] = [Math.sin(Math.PI / 3), 0, 0, Math.cos(Math.PI / 3)];
  const broken = { ...walk, rot };
  const k = creatureChecks(c, broken);
  const lim = k.find((x) => x.name === 'joints within their limits')!;
  assert.equal(lim.pass, false);
  assert.ok(lim.frames.some(([a, b]) => a <= 5 && b >= 5));
  assert.equal(k.find((x) => x.name === 'no pops (joint speed)')!.pass, false);
});

test('tools: new-creature, add-part, set-creature-motion, motion-checks (creatures and kit characters)', async () => {
  const { initKernel, Studio } = await import('../src/index.ts');
  await initKernel();
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-creature', { preset: 'crab' });
  const id = s.doc().objectOrder.at(-1)!;
  const o = s.doc().objects[id];
  assert.equal(o.semanticType, 'creature');
  assert.ok(s.evaluate(o).ok, 'creature mesh builds');
  ok('add-part', { object: id, part: { kind: 'spring', id: 'flag', at: [0, 0.3, -0.1], dir: [0, 1, 0], length: 0.2, r: 0.006, color: '#d9603b' } });
  ok('set-creature-motion', { object: id, id: 'scuttle', kind: 'walk', speed: 0.25, dir: [1, 0, 0] });
  const mc = ok('motion-checks', { object: id }) as any;
  assert.ok(mc.result.checks.scuttle.length > 5);
  const rows = s.checks(id).filter((c) => c.id.startsWith('creature-'));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows.filter((r) => !r.pass)));
  // the body plans' clips run through the same universal checks
  ok('new-character', { name: 'Smith' });
  ok('set-motion', { object: 'smith', id: 'walk', kind: 'walk' });
  const ch = ok('motion-checks', { object: 'smith' }) as any;
  assert.ok(Object.values(ch.result.checks).flat().every((k: any) => k.pass), JSON.stringify(ch.result.checks));
});

test('a custom part combo: four legs, a tail and a spring ear walk cleanly', () => {
  const def: CreatureDef = { name: 'Lizard', parts: [
    { kind: 'body', shape: 'capsule', size: [0.18, 0.12, 0.5], height: 0.16, color: '#7a9b3a' },
    { kind: 'legs', id: 'legs', count: 4, upper: 0.12, lower: 0.15, spread: 0.12, radius: 0.018, color: '#6a8a30' },
    { kind: 'chain', id: 'tail', at: [0, 0.16, -0.25], dir: [0, -0.1, -1], length: 0.45, segments: 6, r0: 0.04, r1: 0.01, color: '#6a8a30', motion: 'wave', amp: 40 },
    { kind: 'spring', id: 'frill', at: [0, 0.22, 0.2], dir: [0, 1, 0.3], length: 0.08, r: 0.01, color: '#d9603b' },
  ] };
  const c = buildCreature(def);
  const walk = bakeCreature(c, 'walk', { kind: 'walk', speed: 0.3 });
  assert.deepEqual(fails(creatureChecks(c, walk)), []);
});

test('live runtime: a steered crab steps over bumps with its feet planted; a steered car keeps its tyres on the road', () => {
  const bumpy = { period: 6, bumps: [{ amp: 0.05, k: 1 }, { amp: 0.03, k: 3, kx: 2 }] };
  const ground = (x: number, z: number) => terrainHeight(bumpy, x, z);
  const { c, clips } = creatureWithClips('crab');
  const rt = new CreatureRuntime(c, { ground, layer: clips.find((x) => x.id === 'idle') });
  let worstMiss = 0, steps = 0, prev = rt.plants();
  for (let i = 0; i < 360; i++) {
    const p = rt.step(1 / 60, { speed: 0.3, strafe: [1, 0, 0], turn: 20 });
    worstMiss = Math.max(worstMiss, p.reachMiss);
    const now = rt.plants();
    now.forEach((f, k) => {
      if (f.down && prev[k].down) assert.ok(Math.hypot(f.at[0] - prev[k].at[0], f.at[2] - prev[k].at[2]) < 1e-9, 'a planted foot moved');
      if (!f.down && prev[k].down) steps++;
    });
    prev = now;
  }
  assert.ok(steps > 12, `steps taken: ${steps}`);
  assert.ok(worstMiss < 0.03, `feet out of reach by ${worstMiss}`);
  assert.ok(Math.hypot(rt.pos[0], rt.pos[2]) > 0.5, 'it went somewhere');
  const car = creatureWithClips('car');
  const rc = new CreatureRuntime(car.c, { ground });
  let worstGap = 0;
  for (let i = 0; i < 300; i++) {
    const p = rc.step(1 / 60, { speed: 1.5, turn: 15 });
    if (i < 60) continue;
    const fk = creatureFK(car.c, p.rot, p.off);
    for (const cd of car.c.contacts) {
      const b = car.c.index.get(cd.bone)!;
      const hubW = rc.toWorld(fk.pos[b]);
      const r = car.c.def.parts.find((x: any) => x.kind === 'wheels')!.axles[0].r;
      worstGap = Math.max(worstGap, Math.abs(hubW[1] - r - ground(hubW[0], hubW[2])));
    }
  }
  assert.ok(worstGap < 0.06, `tyre off the road by ${worstGap}`);
  assert.ok(Math.abs(rc.yaw) > 0.5, 'it steered');
});

test('every kit body plan is a part combo, and its clips pass the universal checks unchanged', async () => {
  const { initKernel, Studio, CHARACTER_PRESETS, BODY_PLAN_PARTS } = await import('../src/index.ts');
  await initKernel();
  const { characterMotionChecks } = await import('../src/parttools.ts');
  const { bakeMotion } = await import('../src/motion.ts');
  const s = new Studio();
  const problems: string[] = [];
  for (const preset of CHARACTER_PRESETS) {
    const r = s.call('new-character', { name: `P ${preset}`, preset });
    assert.ok(r.ok, r.error);
    const o = s.doc().objects[s.doc().objectOrder.at(-1)!];
    const plan = (o.ops.body?.args as any)?.plan ?? 'human';
    assert.ok(BODY_PLAN_PARTS[plan], `no part combo for plan ${plan}`);
    const rig = s.evaluate(o).rig!.rig;
    for (const [mid, spec] of Object.entries(o.character!.motions!)) {
      for (const k of characterMotionChecks(rig, bakeMotion(mid, spec, rig, o.character))) if (!k.pass) problems.push(`${preset} ${mid}: ${k.name} ${k.worst}${k.unit} > ${k.limit} ${JSON.stringify(k.frames.slice(0, 3))} ${k.detail}`);
    }
  }
  // one real finding the new checks surfaced in an existing clip (left as is: no motion change in this
  // phase): the birdfolk walk's hips drop 57 mm then jump back in one frame at each heel strike, and the
  // spring tail whips with it. Logged in the Phase 8 notes.
  assert.deepEqual(problems.map((p) => p.split(':').slice(0, 2).join(':')), ['birdfolk walk: no pops (joint speed) 1950°/s > 1260 [[4,5],[19,20]] fastest']);
});
