import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creatureWithClips } from '../src/creatures.ts';
import { creatureSkinnedGLB, creatureIkInfo } from '../src/creatureskin.ts';

const json = (glb: Uint8Array) => {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
};

for (const name of ['crab', 'spider', 'octopus', 'snake']) {
  test(`skinned export ${name}: one skin over every bone plus a tip per leg and chain; validates; IK info names real joints`, async () => {
    const { c, clips } = creatureWithClips(name);
    const glb = creatureSkinnedGLB(c, clips, { terrain: { size: 3 } });
    const { validateGlb } = await import('../src/index.ts');
    const v = await validateGlb(glb);
    assert.ok(v.ok, JSON.stringify(v).slice(0, 600));
    const g = json(glb);
    const ik = creatureIkInfo(c);
    assert.equal(g.skins.length, 1);
    assert.equal(g.skins[0].joints.length, c.bones.length + ik.legs.length + ik.chains.length);
    const names = new Set(g.skins[0].joints.map((j: number) => g.nodes[j].name));
    for (const l of ik.legs) for (const b of [l.hip, l.knee, l.tip]) assert.ok(names.has(b), b);
    for (const ch of ik.chains) for (const b of [...ch.bones, ch.tip]) assert.ok(names.has(b), b);
    assert.equal(g.animations.length, clips.length);
    assert.deepEqual(g.nodes[0].extras.ik.legs.length, c.legs.length);
    // the skinned mesh is one node with the skin, not a joint
    const meshNode = g.nodes.find((n: any) => n.skin === 0);
    assert.ok(meshNode && !g.skins[0].joints.includes(g.nodes.indexOf(meshNode)));
  });
}

test('crab IK info: tripod groups (3 + 3), step numbers from the leg reach', () => {
  const { c } = creatureWithClips('crab');
  const ik = creatureIkInfo(c);
  assert.equal(ik.legs.length, 6);
  assert.equal(ik.legs.filter((l) => l.group === 0).length, 3);
  assert.ok(ik.gait && ik.gait.stepTrigger > 0.05 && ik.gait.stepTime > 0.2);
});
