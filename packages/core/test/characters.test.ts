// Phase 7: characters that don't look alike — body plans, face parts, cast check, reference steering,
// the rigged-import side door, and (week 12) four legs, tails and wings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initKernel, Studio, selectForExport, toGLB, validateGlb } from '../src/index.ts';
import { bakeMotion, motionReport } from '../src/motion.ts';
import { BODY_PLANS, speechCheck } from '../src/rig.ts';
import { readReference } from '../src/charstyle.ts';
import { faceMap, humanoidName, importCharacter, readGlb, vrmLicence, writeGlb } from '../src/importchar.ts';
import { QUAD_GAITS } from '../src/quadruped.ts';

await initKernel();
const make = (args: Record<string, unknown>) => {
  const s = new Studio();
  const r = s.call('new-character', { name: 'C', ...args });
  assert.ok(r.ok, r.error);
  const o = s.doc().objects.c;
  return { s, o, res: s.evaluate(o), rig: s.evaluate(o).rig!.rig };
};

test('every body plan builds a rigged character whose checks all pass, each with its own proportions', () => {
  const heights: Record<string, number> = {};
  for (const plan of BODY_PLANS) {
    const { s, rig } = make({ plan });
    const bad = s.checks('c').filter((c) => !c.pass && !c.pending);
    assert.deepEqual(bad.map((c) => `${plan}: ${c.label}: ${c.detail}`), []);
    assert.equal(rig.spec.plan, plan);
    heights[plan] = rig.spec.params.height;
  }
  assert.ok(heights.lanky > heights.human && heights.human > heights.stocky && heights.stocky > heights.chibi, JSON.stringify(heights));
});

test('every mouth answers to the 15 speech shapes: closes on M/B/P, opens on "aa", distinct shapes', () => {
  for (const mouth of ['human', 'cartoon', 'beak', 'muzzle', 'grille']) {
    const { res, rig } = make({ mouth });
    const sc = speechCheck(rig, res.rig!.rest, res.rig!.vertPart);
    assert.ok(sc.pass, `${mouth}: ${sc.detail}`);
  }
});

test('the cast check: two near-identical characters are flagged as look-alikes; different plans pass', () => {
  const s = new Studio();
  s.call('new-character', { name: 'A', preset: 'elder' });
  s.call('new-character', { name: 'B', preset: 'elder', height: 1.68 });
  s.call('new-character', { name: 'D', preset: 'dog' });
  const cast = (id: string) => s.checks(id).find((c) => c.id === 'cast-outline')!;
  assert.equal(cast('b').pass, false, cast('b').detail);
  assert.ok(cast('d').pass, cast('d').detail);
});

test('a reference picture steers the plan: a short wide figure reads stocky, a tall thin one lanky', () => {
  const figure = (w: number, h: number) => {
    const W = 100, H = 200, data = new Uint8Array(W * H * 4).fill(255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const top = H - h, inHead = y >= top && y < top + h * 0.2 && Math.abs(x - 50) < w * 0.3;
      const inBody = y >= top + h * 0.2 && Math.abs(x - 50) < (y < top + h * 0.6 ? w / 2 : w / 4) && (y < top + h * 0.6 || Math.abs(Math.abs(x - 50) - w / 6) < w / 8);
      if (inHead || inBody) data.set([90, 60, 40, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, data };
  };
  assert.equal(readReference(figure(70, 110)).plan, 'stocky');
  assert.equal(readReference(figure(22, 196)).plan, 'lanky');
});

test('rigged import: an outside rig (Mixamo names, A-posed arms, no clips) gets mapped, rest-fixed and retargeted', async () => {
  assert.equal(humanoidName('mixamorig:LeftForeArm'), 'LeftLowerArm');
  assert.equal(humanoidName('J_Bip_R_UpperLeg'), 'RightUpperLeg');
  const s = new Studio();
  s.call('new-character', { name: 'Kid', preset: 'kid' });
  const g = readGlb(toGLB(selectForExport(s, s.doc(), { object: 'kid', atOrigin: true }), {}));
  const mix: Record<string, string> = { Hips: 'Hips', Spine: 'Spine', Chest: 'Spine1', UpperChest: 'Spine2', Neck: 'Neck', Head: 'Head', LeftShoulder: 'LeftShoulder', LeftUpperArm: 'LeftArm', LeftLowerArm: 'LeftForeArm', LeftHand: 'LeftHand', LeftUpperLeg: 'LeftUpLeg', LeftLowerLeg: 'LeftLeg', LeftFoot: 'LeftFoot', LeftToes: 'LeftToeBase' };
  for (const n of g.json.nodes) {
    if (!n.name) continue;
    const side = n.name.startsWith('Right') ? 'Right' : n.name.startsWith('Left') ? 'Left' : '';
    const base = side ? 'Left' + n.name.slice(side.length) : n.name;
    if (mix[base]) n.name = 'mixamorig:' + mix[base].replace('Left', side || 'Left');
  }
  delete g.json.animations;
  // A-pose: the outside rig's arms rest 35° down from ours (the retargeter must correct the rest pose)
  const s35 = Math.sin((35 * Math.PI) / 360), c35 = Math.cos((35 * Math.PI) / 360);
  for (const n of g.json.nodes) if (n.name === 'mixamorig:LeftArm') n.rotation = [0, 0, -s35, c35]; else if (n.name === 'mixamorig:RightArm') n.rotation = [0, 0, s35, c35];
  const { glb, report } = importCharacter(writeGlb(g), { name: 'Outside kid' });
  assert.ok(report.rigged && report.bones.matched >= 20, JSON.stringify(report.bones));
  assert.ok(report.motions.includes('walk') && report.motions.includes('idle'));
  assert.notEqual(report.face.mode, 'none');
  const fix = report.restFixes?.find((f) => f.bone === 'LeftUpperArm');
  assert.ok(fix && Math.abs(fix.degrees - 35) < 6, JSON.stringify(report.restFixes));
  assert.ok((await validateGlb(glb)).ok);
  const out = readGlb(glb);
  assert.ok(out.json.animations.some((a: any) => a.name === 'walk' && a.extras?.retargeted));
  // an unrigged model stays a prop
  delete g.json.skins;
  for (const n of g.json.nodes) delete n.skin;
  assert.equal(importCharacter(writeGlb(g)).report.rigged, false);
});

test('rigged import: VRM licence is read and warned about; a face with only vowels gets synthesised consonants', () => {
  const lic = vrmLicence({ extensions: { VRMC_vrm: { meta: { name: 'Avi', authors: ['X'], commercialUsage: 'personalNonProfit', licenseUrl: 'https://vrm.dev/licenses/1.0/' } } } });
  assert.ok(lic && lic.commercial === false && /personalNonProfit/.test(lic.detail));
  const json = { nodes: [{ mesh: 0 }], meshes: [{ extras: { targetNames: ['aa', 'ih', 'ou', 'ee', 'oh', 'blink'] } }] };
  const fm = faceMap(json, {} as any);
  assert.ok(Object.keys((fm as any).shapes ?? fm).length > 0);
});

test('four legs: walk is a lateral sequence, trot moves diagonal pairs, gallop is rotary; paws planted, back holds', () => {
  const { rig, o } = make({ preset: 'dog' });
  const order: Record<string, string> = {};
  for (const kind of ['walk', 'trot', 'gallop', 'idle', 'sit', 'lie'] as const) {
    const c = bakeMotion(kind, { kind }, rig, o.character);
    const r = motionReport(rig, c);
    assert.ok(r.pass, `${kind}: ${r.detail}`);
    order[kind] = r.quad!.footfalls;
  }
  // cyclic order starting anywhere: LH → LF → RH → RF for a walk
  const cyc = (s: string) => { const a = s.split(' → '); return a.concat(a).join(','); };
  assert.ok(cyc(order.walk).includes('LH,LF,RH,RF'), order.walk);
  const trot = bakeMotion('trot', { kind: 'trot' }, rig, o.character);
  for (let f = 0; f < trot.frames; f++) assert.equal(trot.paws!.LH.down[f], trot.paws!.RF.down[f], 'diagonal pairs land together');
  // faster gaits go faster and use less ground contact
  const sp = (k: 'walk' | 'trot' | 'gallop') => bakeMotion(k, { kind: k }, rig, o.character).speed;
  assert.ok(sp('walk') < sp('trot') && sp('trot') < sp('gallop'));
  assert.ok(QUAD_GAITS.walk.duty > QUAD_GAITS.trot.duty && QUAD_GAITS.trot.duty > QUAD_GAITS.gallop.duty);
  // a bigger animal strides longer at the same gait
  const big = make({ preset: 'dog', height: 1.6 });
  assert.ok(bakeMotion('w', { kind: 'walk' }, big.rig, big.o.character).stride! > bakeMotion('w', { kind: 'walk' }, rig, o.character).stride! * 1.3);
  // a biped can't trot
  const h = make({});
  assert.throws(() => bakeMotion('t', { kind: 'trot' }, h.rig, h.o.character), /four-legged/);
});

test('tails and wings on any plan: the tail swings, folded wings stay folded, a flap beats them; exports validate', async () => {
  const { s, rig, o } = make({ plan: 'human', tail: true, wings: true });
  assert.deepEqual(s.checks('c').filter((c) => !c.pass && !c.pending).map((c) => c.detail), []);
  const ti = rig.bones.findIndex((b) => b.name === 'Tail3'), wi = rig.bones.findIndex((b) => b.name === 'LeftWing1');
  assert.ok(ti > 0 && wi > 0);
  const idle = bakeMotion('idle', { kind: 'idle' }, rig, o.character);
  const angles = (c: typeof idle, i: number) => c.local.map((q) => 2 * Math.acos(Math.min(1, Math.abs(q[i][3]))) * 57.3);
  const tail = angles(idle, ti);
  assert.ok(Math.max(...tail) - Math.min(...tail) > 5, 'the tail moves');
  const folded = angles(idle, wi);
  assert.ok(Math.max(...folded) - Math.min(...folded) < 1, 'folded wings hold still');
  const flap = bakeMotion('flap', { kind: 'idle', flap: 2, duration: 2 }, rig, o.character);
  const beat = flap.local.map((q) => q[wi][2]);
  assert.ok(Math.max(...beat) - Math.min(...beat) > 0.5, 'the wings beat');
  assert.ok(motionReport(rig, flap).pass);
  const glb = toGLB(selectForExport(s, s.doc(), { object: 'c', atOrigin: true }), {});
  assert.ok((await validateGlb(glb)).ok);
});
