import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeCreature, buildCreature, creatureChecks, creatureFK, bonePoint, type CreatureClip } from '../src/rigparts.ts';
import { creatureFromPreset, creatureWithClips } from '../src/creatures.ts';
import { flightPlan, wingFreq, swimPlan, mirrorQ } from '../src/wings.ts';
import { applyNotes } from '../src/actions.ts';
import { CreatureRuntime } from '../src/creatureruntime.ts';
import { qAxisAngle, qMul } from '../src/rig.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const action = (n: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/actions', `${n}.json`), 'utf8'));
const fails = (ks: ReturnType<typeof creatureChecks>) => ks.filter((k) => !k.pass).map((k) => `${k.name}: ${k.worst}${k.unit} > ${k.limit} ${k.detail} ${JSON.stringify(k.frames.slice(0, 3))}`);
const check = (ks: ReturnType<typeof creatureChecks>, name: string) => ks.find((k) => k.name === name)!;
const perform = (preset: string, file: string, notes: string[] = []) => {
  const a = action(file);
  const c = buildCreature(creatureFromPreset(preset).def);
  const clip = bakeCreature(c, a.id, { kind: 'action', action: { label: a.action, keys: a.keys, ...(a.style ? { style: a.style } : {}), notes } });
  return { c, clip, checks: creatureChecks(c, clip) };
};

test('wings: flap rate and flight cycle come from the proportions; fold/flap/glide/hover pass their checks', () => {
  const small = { kind: 'wing' as const, id: 'w', at: [0.03, 0, 0] as [number, number, number], length: 0.12, chord: 0.05, color: '#000' };
  const big = { ...small, length: 0.9, chord: 0.25 };
  assert.ok(wingFreq(small) > 2 * wingFreq(big), 'small wings beat faster');
  assert.ok(flightPlan({ ...big, chord: 0.12 }).glide > 0, 'long narrow wings glide between bursts');
  const { checks } = creatureWithClips('bird');
  for (const [id, ks] of Object.entries(checks)) assert.deepEqual(fails(ks), [], `bird ${id}`);
  for (const id of ['fly', 'hover']) assert.ok(check(checks[id], 'wingbeat fits the wing size').pass);
});

test('wing checks catch a wing through the body and a lopsided stroke', () => {
  const { c, clips } = creatureWithClips('bird');
  const fly = clips.find((x) => x.id === 'fly')!;
  const arm = c.index.get('wings.L.arm')!, armR = c.index.get('wings.R.arm')!;
  // the left wing swung down 80° into the flank: through the body, and no longer mirrored by the right
  const rot = fly.rot.map((r) => r.map((q, b) => (b === arm ? qMul(qAxisAngle([0, 0, 1], -80), q) : q)));
  const k = creatureChecks(c, { ...fly, rot } as CreatureClip);
  assert.equal(check(k, 'wingbeat is symmetric').pass, false);
  assert.equal(check(k, 'wings clear the body').pass, false);
  // the right wing really is the mirror of the left in the baked clip
  for (const f of [0, 5, 11]) assert.ok(Math.abs(fly.rot[f][arm][0] - mirrorQ(fly.rot[f][armR])[0]) < 1e-9);
});

test('swimming: a fish and an eel pass; the eel waves more of its body with more slip; the checks catch a wave too slow', () => {
  for (const name of ['fish', 'eel']) { const { checks } = creatureWithClips(name); for (const [id, ks] of Object.entries(checks)) assert.deepEqual(fails(ks), [], `${name} ${id}`); }
  const fish = buildCreature(creatureFromPreset('fish').def), eel = buildCreature(creatureFromPreset('eel').def);
  const pf = swimPlan(fish, fish.def.parts.find((p: any) => p.motion === 'swim') as any), pe = swimPlan(eel, eel.def.parts.find((p: any) => p.motion === 'swim') as any);
  assert.ok(pe.slip < pf.slip && pe.lambda / pe.L < pf.lambda / pf.L);
  const { c, clips } = creatureWithClips('fish');
  const swim = clips.find((x) => x.id === 'swim')!;
  // the same wave, but the fish claims to swim 3× faster than the wave pushes it: slip > 1
  assert.equal(check(creatureChecks(c, { ...swim, speed: swim.speed * 3 }), 'body wave runs tailward faster than it swims').pass, false);
});

test('one-off action: the octopus pours tea — every check passes, the pot comes back to the table, the stream shows only while pouring', () => {
  const { c, clip, checks } = perform('octopus', 'octopus-pours-tea');
  assert.deepEqual(fails(checks), []);
  assert.equal(clip.loop, false);
  const pot = c.index.get('teapot')!, tea = c.index.get('tea')!;
  assert.ok(Math.hypot(...clip.off[clip.frames][pot]) < 0.02, 'teapot back where it was');
  const keys = clip.keys!;
  const at = (label: string) => Math.round(keys.find((k) => k.label === label)!.t * clip.fps);
  assert.ok(Math.abs(clip.off[at('pour') + 5][tea][1]) < 1e-6, 'stream visible while pouring');
  assert.ok(clip.off[at('lift')][tea][1] < -1, 'stream hidden before');
  assert.equal(clip.held![at('lift')].teapot, 'arm1');
  // the spout is over the cup while pouring
  const fk = creatureFK(c, clip.rot[at('pour') + 5], clip.off[at('pour') + 5]);
  const spout = bonePoint(c, fk, tea, c.bones[tea].head);
  assert.ok(Math.hypot(spout[0] + 0.1, spout[2] - 0.69) < 0.03, `spout at ${spout.map((x) => x.toFixed(3))}`);
});

test('notes steer an action in words; unknown notes are refused; a sloppy grab is caught', () => {
  const base = perform('octopus', 'octopus-pours-tea');
  const noted = perform('octopus', 'octopus-pours-tea', ['slower, more weight', 'hold the pour longer']);
  assert.deepEqual(fails(noted.checks), []);
  const lastKey = (cl: CreatureClip) => cl.keys![cl.keys!.length - 1].t;
  assert.ok(Math.abs(lastKey(noted.clip) - ((lastKey(base.clip) + 0.5) * 1.25)) < 1e-6);
  assert.throws(() => applyNotes({ label: 'x', keys: [{ t: 0 }], notes: ['make it purple'] }), /not understood/);
  // grip the pot before the tentacle gets there: the pot floats beside the tip
  const a = action('octopus-pours-tea');
  const keys = a.keys.map((k: any) => (k.label === 'grab the handle' ? { ...k, hold: { teapot: 'arm1' } } : k.label === 'reach for the handle' ? { ...k, hold: { teapot: 'arm1' } } : k));
  const c = buildCreature(creatureFromPreset('octopus').def);
  const sloppy = creatureChecks(c, bakeCreature(c, 'x', { kind: 'action', action: { label: 'sloppy', keys } }));
  assert.equal(check(sloppy, 'held props stay in the grip').pass, false);
});

test('actions: a bird takes off, flies and lands; a windmill creaks to a stop', () => {
  const bird = perform('bird', 'bird-takes-off');
  assert.deepEqual(fails(bird.checks), []);
  const B = bird.c.index.get('Body')!;
  const ys = bird.clip.off.map((o) => o[B][1]);
  assert.ok(Math.max(...ys) > 1, 'it flies');
  assert.ok(Math.abs(bird.clip.off[bird.clip.frames][B][2] - 12.7) < 0.05, 'it lands where the keys say');
  assert.ok(bird.clip.contacts[0].some(Boolean) && bird.clip.contacts[bird.clip.frames].some(Boolean) && bird.clip.contacts[Math.round(3 * 30)].every((x) => !x), 'feet down, up, down');
  const mill = perform('windmill', 'windmill-creaks-to-a-stop');
  assert.deepEqual(fails(mill.checks), []);
  const s = mill.c.index.get('sails')!;
  const ang = (f: number) => 2 * Math.acos(Math.min(1, Math.abs(mill.clip.rot[f][s][3])));
  assert.ok(Math.abs(ang(mill.clip.frames) - ang(mill.clip.frames - 3)) < 0.003, 'stopped');
});

test('tools: perform-action and action-note on a creature and on a kit character (he trips over the bucket)', async () => {
  const { initKernel, Studio } = await import('../src/index.ts');
  await initKernel();
  const st = new Studio();
  const ok = (t: string, a: object) => { const r = st.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-creature', { preset: 'octopus' });
  const oct = st.doc().objectOrder.at(-1)!;
  const a = action('octopus-pours-tea');
  const r = ok('perform-action', { object: oct, action: a.action, id: 'pour', keys: a.keys });
  assert.ok((r.result as any).checks.every((k: any) => k.pass));
  const n = ok('action-note', { object: oct, motion: 'pour', note: 'faster' });
  assert.ok((n.result as any).duration < (r.result as any).duration);
  assert.equal(st.call('action-note', { object: oct, motion: 'pour', note: 'more purple' }).ok, false);
  ok('new-character', { name: 'Tom', preset: 'blacksmith' });
  const tom = st.doc().objectOrder.at(-1)!;
  const t = action('humanoid-trips');
  const tr = ok('perform-action', { object: tom, action: t.action, id: 'trip', keys: t.keys, duration: t.duration });
  assert.deepEqual((tr.result as any).checks.filter((k: any) => !k.pass), []);
  const { motionReport, bakeMotion } = await import('../src/motion.ts');
  const o = st.doc().objects[tom];
  const rig = st.evaluate(o).rig!.rig;
  const clip = bakeMotion('trip', o.character!.motions!.trip, rig, o.character);
  assert.ok(motionReport(rig, clip).pass, motionReport(rig, clip).detail);
  assert.ok(clip.contacts.right.some((d) => !d) && clip.contacts.left.some((d) => !d), 'both feet leave the floor at some point');
});

test('live runtime: a tentacle reaches for a point and lets go; a spring antenna whips on a stop and settles', () => {
  const c = buildCreature(creatureFromPreset('octopus').def);
  const rt = new CreatureRuntime(c, { layer: bakeCreature(c, 'idle', { kind: 'idle', duration: 4 }) });
  const goal: [number, number, number] = [0.15, 0.3, 0.45];
  rt.reach('arm1', goal);
  let pose = rt.step(1 / 60, { speed: 0 });
  for (let i = 0; i < 240; i++) pose = rt.step(1 / 60, { speed: 0 });
  const tip = rt.tip('arm1', pose);
  assert.ok(Math.hypot(tip[0] - goal[0], tip[1] - goal[1], tip[2] - goal[2]) < 0.01, `tip ${tip}`);
  rt.reach('arm1', null);
  for (let i = 0; i < 120; i++) pose = rt.step(1 / 60, { speed: 0 });
  { const t2 = rt.tip("arm1", pose); assert.ok(Math.hypot(t2[0] - goal[0], t2[1] - goal[1], t2[2] - goal[2]) > 0.05, `it let go: ${t2}`); }
  const crab = buildCreature(creatureFromPreset('crab').def);
  const cr = new CreatureRuntime(crab);
  const ai = crab.index.get('antenna.L')!;
  const angle = (p: ReturnType<CreatureRuntime['step']>) => 2 * Math.acos(Math.min(1, Math.abs(p.rot[ai][3]))) * 180 / Math.PI;
  let peak = 0;
  for (let i = 0; i < 120; i++) cr.step(1 / 60, { speed: 0.3, strafe: [1, 0, 0] });
  for (let i = 0; i < 30; i++) peak = Math.max(peak, angle(cr.step(1 / 60, { speed: 0, strafe: [1, 0, 0] })));
  let late = 0;
  for (let i = 0; i < 300; i++) late = angle(cr.step(1 / 60, { speed: 0, strafe: [1, 0, 0] }));
  assert.ok(peak > 1 && late < peak * 0.3, `peak ${peak}, late ${late}`);
});
