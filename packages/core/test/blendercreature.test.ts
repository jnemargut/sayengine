// The Blender creature builder: options and specs, the clip motion checks on a GLB, the quadruped
// side door, and (when Blender is installed) a real build: body, rig, clips, export validated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initKernel, Studio, validateGlb, SHAPE_KEYS } from '../src/index.ts';
import { readGlb, writeGlb, importCharacter, type Gltf } from '../src/importchar.ts';
import { BlenderMissing, CREATURE_PLANS, PERSON_FACES, buildCreature, creatureSpec, findBlender } from '../src/blender/creature.ts';
import { kitFace } from '../src/blender/kitface.ts';
import { glbMotionChecks } from '../src/blender/glbmotion.ts';

await initKernel();
const BLENDER = findBlender();
const ROOT = path.resolve(import.meta.dirname, '../../..');

test('creature options: build words, colour names and patterns become a spec; bad values name the allowed ones', () => {
  const s = creatureSpec({ plan: 'cat', preset: 'british-shorthair', build: 'fat', coat: 'blue', eyeColor: 'copper', pattern: 'solid', out: '/tmp/x' });
  assert.equal(s.build, 0.92);
  assert.deepEqual(s.coat, { color: '#787d86', pattern: 'solid' });
  assert.equal(s.eyeColor, '#c9771f');
  assert.equal(creatureSpec({ build: 0.3, out: '/tmp/x' }).build, 0.3);
  assert.throws(() => creatureSpec({ build: 'huge', out: '/tmp/x' }), /lean\|normal\|chubby\|fat/);
  assert.throws(() => creatureSpec({ preset: 'sphynx', out: '/tmp/x' }), /presets: british-shorthair/);
  assert.throws(() => creatureSpec({ pattern: 'spots', out: '/tmp/x' }), /solid\|tabby\|tuxedo\|calico/);
  assert.throws(() => creatureSpec({ coat: 'tartan', out: '/tmp/x' }), /#rrggbb or blue/);
  assert.throws(() => creatureSpec({ clips: ['moonwalk'], out: '/tmp/x' }), /clips: idle, walk/);
  // a global tempo and per-clip tempos reach the builder; unknown clips and silly tempos are refused
  const t = creatureSpec({ tempo: 1.25, clipTempo: { walk: 1.1, jump_takeoff: 0.9 }, out: '/tmp/x' });
  assert.equal(t.tempo, 1.25);
  assert.deepEqual(t.clipTempo, { walk: 1.1, jump_takeoff: 0.9 });
  assert.equal(creatureSpec({ out: '/tmp/x' }).tempo, undefined, 'tempo 1 is the default and left out');
  assert.throws(() => creatureSpec({ clipTempo: { moonwalk: 2 }, out: '/tmp/x' }), /unknown clip "moonwalk"/);
  assert.throws(() => creatureSpec({ tempo: 5, out: '/tmp/x' }));
  for (const c of ['jump_takeoff', 'jump_air', 'jump_land', 'carried_dangle', 'carried_cradle', 'scratch_bed', 'bat_hook_windup', 'blink_quick', 'slow_blink', 'sleepy_eyes', 'squint_content', 'nictitate_flick']) {
    assert.ok((CREATURE_PLANS.cat.clips as readonly string[]).includes(c), c);
  }
});

test('the toy style reaches the builder: a cartoon cat, and a person with its own head (no kit face)', () => {
  const c = creatureSpec({ plan: 'cat', style: 'toy', build: 'fat', out: '/tmp/x' });
  assert.equal(c.toy, 1);
  assert.equal(creatureSpec({ plan: 'cat', out: '/tmp/x' }).toy, undefined, 'real is the default and leaves the spec as it was');
  const p = creatureSpec({ plan: 'person', style: 'toy', out: '/tmp/x' });
  assert.equal(p.toy, 1);
  assert.equal(p.kitFace, undefined, 'a toy person needs no kit face');
  assert.ok(creatureSpec({ plan: 'person', out: '/tmp/x' }).kitFace, 'a real person still gets one');
  assert.throws(() => creatureSpec({ style: 'clay', out: '/tmp/x' }));
});

test('without Blender the builder fails clearly and says how to install it', async () => {
  await assert.rejects(buildCreature({ out: path.join(os.tmpdir(), 'no-blender') }, { blender: null }), (e: any) => e instanceof BlenderMissing && /blender\.org/.test(e.hint));
});

test('the CLI explains new-creature --builder blender without starting anything', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'packages/cli/studio.ts'), 'new-creature', '--builder', 'blender', '--help'], { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: '4519' } });
  const body = JSON.parse(r.stdout);
  assert.match(body.command, /new-creature --builder blender/);
  assert.ok(body.flags['--build'] && body.flags['--coat'] && body.flags['--eyeColor'] && body.flags['--furLength']);
});

// a tiny quadruped GLB: root, spine, four legs with toes, a tail; one walk clip and one bad clip
function tinyQuadruped(): Gltf {
  const names = ['root', 'spine', 'tail.001', 'upper_arm.L', 'f_toe.L', 'upper_arm.R', 'f_toe.R', 'thigh.L', 'r_toe.L', 'thigh.R', 'r_toe.R'];
  const parent: Record<string, string> = { spine: 'root', 'tail.001': 'spine', 'upper_arm.L': 'spine', 'upper_arm.R': 'spine', 'thigh.L': 'spine', 'thigh.R': 'spine', 'f_toe.L': 'upper_arm.L', 'f_toe.R': 'upper_arm.R', 'r_toe.L': 'thigh.L', 'r_toe.R': 'thigh.R' };
  const T: Record<string, number[]> = { root: [0, 0, 0], spine: [0, 0.25, 0], 'tail.001': [0, 0, -0.2], 'upper_arm.L': [0.05, 0, 0.15], 'upper_arm.R': [-0.05, 0, 0.15], 'thigh.L': [0.05, 0, -0.12], 'thigh.R': [-0.05, 0, -0.12], 'f_toe.L': [0, -0.24, 0], 'f_toe.R': [0, -0.24, 0], 'r_toe.L': [0, -0.24, 0], 'r_toe.R': [0, -0.24, 0] };
  const nodes = names.map((n) => ({ name: n, translation: T[n], children: names.filter((c) => parent[c] === n).map((c) => names.indexOf(c)) }));
  const g: Gltf = { json: { asset: { version: '2.0' }, nodes, skins: [{ joints: names.map((_, i) => i) }], animations: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }] }, bin: new Uint8Array(0) };
  const add = (data: Float32Array, type: string, minmax = false) => {
    const pad = (4 - (g.bin.length % 4)) % 4;
    const nb = new Uint8Array(g.bin.length + pad + data.byteLength); nb.set(g.bin); nb.set(new Uint8Array(data.buffer), g.bin.length + pad);
    g.json.bufferViews.push({ buffer: 0, byteOffset: g.bin.length + pad, byteLength: data.byteLength });
    g.bin = nb; g.json.buffers[0].byteLength = nb.length;
    const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]!;
    const acc: any = { bufferView: g.json.bufferViews.length - 1, componentType: 5126, count: data.length / n, type };
    if (minmax) { acc.min = [Math.min(...data)]; acc.max = [Math.max(...data)]; }
    g.json.accessors.push(acc);
    return g.json.accessors.length - 1;
  };
  const F = 30;
  const times = add(Float32Array.from({ length: F + 1 }, (_, f) => f / 30), 'SCALAR', true);
  // walk: each leg swings sinusoidally about X (loops cleanly, gentle)
  const swing = (phase: number, amp: number) => {
    const q = new Float32Array((F + 1) * 4);
    for (let f = 0; f <= F; f++) { const a = amp * Math.sin(2 * Math.PI * (f / F + phase)) / 2; q.set([Math.sin(a), 0, 0, Math.cos(a)], f * 4); }
    return q;
  };
  const walk: any = { name: 'walk', samplers: [], channels: [], extras: { loop: true, speed: 0 } };
  ['upper_arm.L', 'upper_arm.R', 'thigh.L', 'thigh.R'].forEach((n, k) => {
    walk.samplers.push({ input: times, output: add(swing(k * 0.25, 0.4), 'VEC4'), interpolation: 'LINEAR' });
    walk.channels.push({ sampler: walk.samplers.length - 1, target: { node: names.indexOf(n), path: 'rotation' } });
  });
  // pop: the spine snaps half a turn in one frame and the body drops through the floor
  const snap = new Float32Array((F + 1) * 4); for (let f = 0; f <= F; f++) snap.set(f < 15 ? [0, 0, 0, 1] : [0, 1, 0, 0], f * 4);
  const sink = new Float32Array((F + 1) * 3); for (let f = 0; f <= F; f++) sink.set([0, f < 15 ? 0.25 : 0.0, 0], f * 3);
  const pop: any = { name: 'pop', samplers: [{ input: times, output: add(snap, 'VEC4'), interpolation: 'LINEAR' }, { input: times, output: add(sink, 'VEC3'), interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }, { sampler: 1, target: { node: 1, path: 'translation' } }], extras: { loop: false } };
  g.json.animations.push(walk, pop);
  return g;
}

test('clip motion checks catch pops and paws through the floor, and pass a clean loop', () => {
  const r = glbMotionChecks(tinyQuadruped());
  const by = (clip: string, name: string) => r[clip].find((c) => c.name === name)!;
  assert.ok(by('walk', 'loop closes').pass);
  assert.ok(by('walk', 'no pops').pass);
  assert.ok(by('walk', 'paws above the floor').pass);
  assert.equal(by('pop', 'no pops').pass, false);
  assert.equal(by('pop', 'paws above the floor').pass, false);
  assert.ok(by('pop', 'no pops').frames.length > 0);
});

test('a rigged quadruped comes in through the side door with its own clips, checked, and is marked to ship', () => {
  const { report } = importCharacter(writeGlb(tinyQuadruped()), { name: 'Tiny cat' });
  assert.equal(report.kind, 'quadruped');
  assert.deepEqual(report.motions, ['walk', 'pop']);
  assert.ok(report.motionChecks?.walk.every((c) => c.pass));
  assert.ok(report.warnings.some((w) => /pop: no pops/.test(w)));
});

test('a Blender-built cat: all-quad body under budget, Rigify-named deform skeleton, every clip, a valid GLB, clips checked, and it imports as a shipping creature', { skip: !BLENDER && 'Blender is not installed', timeout: 900000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'creature-'));
  const r = await buildCreature({ plan: 'cat', preset: 'british-shorthair', build: 'fat', coat: 'blue', eyeColor: 'copper', faces: 5000, texture: 512, name: 'test-cat', out });
  assert.ok(fs.existsSync(r.glb) && fs.existsSync(r.blend));
  assert.ok(r.triangles > 6000 && r.triangles < 25000, `${r.triangles} triangles`);
  for (const b of ['root', 'spine', 'spine.006', 'upper_arm.L', 'forearm.R', 'thigh.L', 'shin.R', 'foot.L', 'tail.004', 'eye.L', 'lid.T.R', 'ear.L', 'belly.C', 'jaw']) assert.ok(r.bones.includes(b), b);
  for (const c of CREATURE_PLANS.cat.clips) assert.ok(c in r.clips, `clip ${c}`);
  assert.ok((r.clips.bat_push_final.contact as any).length >= 1, 'bats carry their contact times');
  // a key press feels instant: every one-shot bat makes contact within 0.12 s; the anticipation is its own windup loop
  for (const [name, c] of Object.entries(r.clips)) {
    if (!name.startsWith('bat_') || name.endsWith('_windup') || c.loop) continue;
    assert.ok((c.contact as number[])[0] <= 0.121, `${name} contact at ${(c.contact as number[])[0]} s`);
    if (`${name}_windup` in r.clips) assert.equal(r.clips[`${name}_windup`].windupFor, name);
  }
  // the jump in three parts with its timing marks; scratches mark every rake; carried clips name their hand anchors
  assert.ok(Number(r.clips.jump_takeoff.launch) > Number(r.clips.jump_takeoff.gather));
  assert.equal(r.clips.jump_air.loop, true);
  assert.ok(Number(r.clips.jump_land.hindContact) > 0);
  for (const s of ['scratch_vertical', 'scratch_horizontal', 'scratch_bed']) {
    assert.equal((r.clips[s].contact as number[]).length, String(r.clips[s].rakePaws).split(',').length, s);
    assert.ok((r.clips[s].contact as number[]).length >= 4, `${s}: four rakes a second`);
  }
  assert.equal(r.clips.carried_dangle.holdNodes, 'hold.L,hold.R');
  assert.equal(r.clips.carried_cradle.holdNodes, 'cradle.F,cradle.B');
  for (const b of ['hold.L', 'hold.R', 'cradle.F', 'cradle.B', 'claw.L', 'claw.R']) assert.ok(r.bones.includes(b), b);
  assert.equal(r.clips.tail_flick.partial, 'tail');
  assert.equal(r.clips.walk.speed, 0.3);
  // blinks by shape key: the lids shut and never cut the eyeball along the whole blend
  for (const k of ['blinkL', 'blinkR', 'eyeSquintL', 'eyeSquintR', 'nictitateL', 'nictitateR', 'pupilNarrow']) assert.ok(r.shapes!.includes(k), k);
  assert.deepEqual(r.eyeChecks!.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`), []);
  assert.ok(r.validation?.ok, JSON.stringify(r.validation?.messages));
  const g = readGlb(new Uint8Array(fs.readFileSync(r.glb)));
  assert.equal(g.json.skins.length, 1);
  assert.ok(g.json.extensionsUsed.includes('KHR_materials_sheen'), 'the fur has sheen');
  // every clip passes every check: loops close, paws above the floor, planted paws keep pace (walk, trot),
  // no pops (the jump included), and no self-intersection
  const bad = Object.entries(r.motion!).flatMap(([clip, cs]) => cs.filter((c) => !c.pass).map((c) => `${clip}: ${c.name} ${c.detail}`));
  assert.deepEqual(bad, []);
  assert.ok(r.motion!.walk.some((c) => c.name === 'planted paws keep pace with the ground'));
  assert.ok(r.motion!.jump.some((c) => c.name === 'no self-intersection'));
  // the blink clip carries its morph track in the same animation as its bones
  const blink = g.json.animations.find((a: any) => a.name === 'blink_quick');
  assert.ok(blink.channels.some((c: any) => c.target.path === 'weights'), 'blink_quick animates the lid morphs');
  // the studio side: import-character keeps the clips and the checks show on the object
  const s = new Studio();
  const imp = s.call('import-character', { file: r.glb, name: 'Test cat' });
  assert.ok(imp.ok, imp.error);
  const id = (imp.result as any).id;
  const checks = s.checks(id);
  assert.ok(checks.some((c) => c.id === 'rigged-creature' && c.pass));
  assert.ok(checks.some((c) => c.id === 'motion-walk'));
  assert.ok((await validateGlb(new Uint8Array(fs.readFileSync(r.glb)))).ok);
});

test('a Blender-built person: garments, hands with fingers, 33 face shapes under the studio names, clips, valid, and lip sync carries through the side door', { skip: !BLENDER && 'Blender is not installed', timeout: 1200000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'person-'));
  const r: any = await buildCreature({ plan: 'person', preset: 'dad', texture: 256, clips: ['idle', 'walk', 'carry_cat', 'idle_breathe'], name: 'test-dad', out });
  assert.ok(r.validation?.ok, JSON.stringify(r.validation?.messages));
  for (const s of ['viseme_sil', 'viseme_aa', 'viseme_ou', 'eyeBlinkLeft', 'jawOpen', 'mouthSmileRight', 'browInnerUp']) assert.ok(r.shapes.includes(s), s);
  assert.equal(r.shapes.length, 33);
  for (const b of ['Hips', 'Head', 'LeftUpperArm', 'RightHand', 'LeftIndexDistal', 'RightThumbMetacarpal', 'LeftEye', 'RightToes']) assert.ok(r.bones.includes(b), b);
  assert.deepEqual(Object.keys(r.clips).sort(), ['carry_cat', 'idle', 'idle_breathe', 'walk']);
  const s = new Studio();
  const imp = s.call('import-character', { file: r.glb, name: 'Test dad' });
  assert.ok(imp.ok, imp.error);
  const rep = (imp.result as any).report;
  assert.equal(rep.face.mode, 'oculus');
  assert.ok(rep.ownClips.includes('carry_cat'));
  // the face is the kit face, and the kit's face checks pass on the finished Blender head
  assert.equal(r.face, 'kit');
  assert.deepEqual(r.faceChecks.filter((c: any) => !c.pass).map((c: any) => `${c.name}: ${c.detail}`), []);
  assert.ok(r.faceChecks.length >= 6);
  assert.ok(r.triangles < 43000, `${r.triangles} triangles`);
});

test('the kit face for a person: the head cut from a kit character, shape blinks, 33 face shapes, paint, landmarks', async () => {
  const { face, png } = await kitFace(PERSON_FACES.dad);
  assert.equal(face.params.blink, 'shape');
  assert.deepEqual(Object.keys(face.shapes), [...SHAPE_KEYS]);
  for (const p of ['Head', 'Neck', 'hair', 'lid.L', 'lidLow.R', 'teethUpper', 'teethLower', 'gumUpper', 'tongue', 'lipUpper', 'LeftEye.iris', 'brow.L', 'ear.R']) assert.ok(face.parts.includes(p), p);
  assert.ok(!face.parts.some((p) => /torso|Arm|Leg|Hand|collar/.test(p)), 'only the head and neck');
  assert.ok(face.triangleCount > 6000 && face.triangleCount < 16000, `${face.triangleCount} triangles`);
  // no face shape moves an eyeball; the blink turns both lids
  const eye = new Set(face.parts.flatMap((p, v) => (/^(Left|Right)Eye/.test(p) ? [v] : [])));
  for (const [k, sd] of Object.entries(face.shapes)) assert.ok(!sd.idx.some((v) => eye.has(v)), `${k} moves an eyeball`);
  const blinkParts = new Set(face.shapes.eyeBlinkLeft.idx.map((v) => face.parts[v]));
  assert.ok(blinkParts.has('lid.L') && blinkParts.has('lidLow.L') && !blinkParts.has('lid.R'));
  assert.equal(face.triMaterial.length, face.triangles.length / 3);
  for (const [mi, uv] of Object.entries(face.uvs)) assert.equal(uv.length, face.triMaterial.filter((m) => m === Number(mi)).length * 6);
  assert.ok(png.length > 1000 && png[1] === 0x50, 'a PNG');
  assert.ok(face.landmarks.ears.every((e) => Number.isFinite(e.top[1])));
});

test('a Blender-built toy cat: a closed fat body, a mouth that opens, every clip, follow-through that never moves a paw', { skip: !BLENDER && 'Blender is not installed', timeout: 600000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-toycat-'));
  const r = await buildCreature({ plan: 'cat', style: 'toy', build: 'fat', name: 'toy cat', rigify: false, faces: 7000, out });
  assert.ok(r.ok && r.validation?.ok, 'a valid GLB');
  assert.ok(r.quadriflow, 'the remesh took the body: it is one closed surface (a body cut open by the bounds comes back as a two-sided shell and fails here)');
  assert.ok(r.shapes?.includes('mouthOpen') && r.shapes.includes('blinkL') && r.shapes.includes('pupilWide'), `face shapes: ${r.shapes}`);
  for (const c of CREATURE_PLANS.cat.clips) assert.ok(r.clips[c], `clip ${c}`);
  // the acting pass (overshoot, belly spring, tail follow-through) must not put a planted paw through the floor or pop a loop
  for (const c of ['idle', 'walk', 'trot', 'sit', 'loaf']) for (const k of r.motion?.[c] ?? []) if (/floor|loop|pop/.test(k.name)) assert.ok(k.pass, `${c}: ${k.name}: ${k.detail}`);
  const g = readGlb(new Uint8Array(fs.readFileSync(r.glb)));
  const mesh = (g.json.meshes ?? [])[0] as { weights?: number[] };
  assert.ok((mesh.weights ?? []).every((w) => w === 0), 'every shape key rests at 0 (a key left at 1 opens the mouth and blows the pupils in an engine)');
});

test('a Blender-built toy person: a cartoon head with the studio face shape names, garments, fingers, clips, valid', { skip: !BLENDER && 'Blender is not installed', timeout: 600000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-toyperson-'));
  const r = await buildCreature({ plan: 'person', style: 'toy', build: 'round', name: 'toy person', out });
  assert.ok(r.ok && r.validation?.ok, 'a valid GLB');
  for (const s of ['eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browDownLeft', 'browOuterUpRight', 'mouthSmileLeft', 'mouthFrownRight', 'jawOpen', 'mouthPucker', 'viseme_aa', 'viseme_oh']) assert.ok(r.shapes?.includes(s), `face shape ${s}`);
  for (const b of ['Hips', 'Head', 'LeftHand', 'RightIndexDistal', 'LeftToes']) assert.ok(r.bones.includes(b), `bone ${b}`);
  for (const c of CREATURE_PLANS.person.clips) assert.ok(r.clips[c], `clip ${c}`);
  const g = readGlb(new Uint8Array(fs.readFileSync(r.glb)));
  const face = (g.json.meshes ?? []).find((m: { name?: string }) => /face/.test(m.name ?? '')) as { weights?: number[]; primitives: unknown[] };
  assert.ok(face && (face.weights ?? []).every((w) => w === 0), 'the face rests with every shape at 0');
  assert.ok(face.primitives.length >= 7, 'the mouth keeps its teeth and cavity faces (zero-area faces are dropped on export)');
});
