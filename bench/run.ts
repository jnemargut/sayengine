// Reference-solution benchmark: proves the engine can express each benchmark task and that
// checks behave. (The AI benchmark — Claude Code driving /studio — is described in bench/TASKS.md.)
// Run: npm run bench
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio, MemoryAssets, toGLB, toSTL, exportGame, validateGlb } from '../packages/core/src/index.ts';
import { solidPng } from '../packages/core/test/png.ts';

await initKernel();

type Task = { name: string; run(s: Studio, step: (t: string, a?: object) => any): void | Promise<void>; expect(s: Studio): string | null | Promise<string | null> };

// Game export without a browser: a fake baker returns solid textures (the real bake runs in the view).
const fakeBaker = async (req: { size: number }) => ({ baseColor: solidPng(req.size, req.size, [94, 63, 44, 255]), metallicRoughness: solidPng(req.size, req.size, [0, 140, 0, 255]) });
const gltfJson = (glb: Uint8Array) => JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
const gameExport = (s: Studio, target: 'godot' | 'web', ids?: string[]) => {
  const doc = s.doc();
  return exportGame((ids ?? doc.objectOrder).map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })), { target, baker: fakeBaker, evaluateOp: (o, id) => s.evaluateOp(o, id) });
};

const allPass = (s: Studio, id?: string) => {
  const doc = s.doc();
  const fails = (id ? [id] : doc.objectOrder).flatMap((o) => s.checks(o, doc).filter((c) => !c.pass).map((c) => `${o}: ${c.label} — ${c.detail}`));
  return fails.length ? fails.join('; ') : null;
};

function buildStool(step: (t: string, a?: object) => any) {
  step('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33', material: 'walnut' });
  step('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: 0 } });
  step('add-op', { id: 'seat', op: 'box', part: 'seat', args: { size: ['$seatW', '$seatT', '$seatW'], at: [0, '$seatH - $seatT/2', 0] } });
  step('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: '$legR', h: '($seatH - $seatT) / cos($legSplay)' } });
  step('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: 0.04, splay: '$legSplay' } });
  step('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'], output: true });
}

const tasks: Task[] = [
  {
    name: '1. Create a wooden stool',
    run: (_s, step) => buildStool(step),
    expect: (s) => allPass(s),
  },
  {
    name: '2. Modify the stool: splay legs 8°, keep it grounded, via a reviewed proposal',
    run: (_s, step) => {
      buildStool(step);
      step('propose', { title: 'Mid-century splay' });
      step('set-param', { name: 'legSplay', value: 8, unit: 'deg' });
      step('add-op', { id: 'floorCut', op: 'box', output: false, args: { size: [2, 0.2, 2], at: [0, -0.1, 0] } });
      step('add-op', { id: 'legsTrim', op: 'difference', inputs: ['legs', 'floorCut'], output: false });
      step('set-op', { id: 'stool', inputs: ['seat', 'legsTrim'], label: 'Trim splayed legs flat at the floor' });
      step('commit-proposal');
    },
    expect: (s) => allPass(s) ?? (s.doc().objects['walnut-stool'].params.legSplay.value === 8 ? null : 'splay not applied'),
  },
  {
    name: '3. Cabin with a door and two windows',
    run: (_s, step) => {
      step('new-object', { name: 'Cabin', type: 'cabin', color: '#b07a4a', material: 'cedar' });
      step('set-params', { values: { W: 4, D: 3, H: 2.6, t: 0.15, doorW: 0.9, doorH: 2.0, winW: 0.8, winH: 0.7, sill: 1.0, roofRise: 1.1 } });
      step('add-op', { id: 'shell', op: 'box', output: false, args: { size: ['$W', '$H', '$D'], at: [0, '$H/2', 0] } });
      step('add-op', { id: 'hollow', op: 'box', output: false, args: { size: ['$W - 2*$t', '$H', '$D - 2*$t'], at: [0, '$H/2 + $t', 0] } });
      step('add-op', { id: 'door', op: 'box', part: 'door', output: false, args: { size: ['$doorW', '$doorH', '$t * 3'], at: [0, '$doorH/2 + 0.001', '$D/2'] } });
      step('add-op', { id: 'win', op: 'box', part: 'window', output: false, args: { size: ['$t * 3', '$winH', '$winW'], at: ['$W/2', '$sill + $winH/2', 0] } });
      step('add-op', { id: 'wins', op: 'mirror', inputs: ['win'], output: false, args: { normal: [1, 0, 0], keep: true } });
      step('add-op', { id: 'walls', op: 'difference', inputs: ['shell', 'hollow', 'door', 'wins'], output: false });
      step('add-op', { id: 'ridge', op: 'box', output: false, args: { size: ['$W + 0.3', 0.01, 0.01], at: [0, '$H + $roofRise', 0] } });
      step('add-op', { id: 'eaves', op: 'box', output: false, args: { size: ['$W + 0.3', 0.01, '$D + 0.4'], at: [0, '$H', 0] } });
      step('add-op', { id: 'roof', op: 'hull', part: 'roof', inputs: ['ridge', 'eaves'], output: false });
      step('add-op', { id: 'cabin', op: 'union', inputs: ['walls', 'roof'], output: true });
      step('add-rule', { rule: { kind: 'range', expr: 'height', min: 3.5, max: 3.9, label: 'Overall height 3.5–3.9 m' } });
    },
    expect: (s) => {
      const f = allPass(s);
      if (f) return f;
      const info: any = s.inspect('cabin');
      // Roofed hollow cabin = outer shell + inner shell joined by n openings → genus n − 1.
      return info.stats.genus === 2 ? null : `expected door + 2 windows (3 openings → genus 2), got genus ${info.stats.genus}`;
    },
  },
  {
    name: '4. Fix a broken model (legs 6 mm short, one leg detached)',
    run: (_s, step) => {
      buildStool(step);
      step('set-op', { id: 'leg', args: { h: '$seatH - $seatT - 0.006' } });
      step('set-op', { id: 'legs', args: { inset: -0.05 } }); // pushes legs outside the seat footprint → detached
      // the "repair" a good agent should find from the check messages:
      step('set-op', { id: 'leg', args: { h: '($seatH - $seatT) / cos($legSplay)' }, label: 'Legs reach the floor' });
      step('set-op', { id: 'legs', args: { inset: 0.04 }, label: 'Legs back under the seat' });
    },
    expect: (s) => allPass(s),
  },
  {
    name: '5. Export GLB',
    run: (_s, step) => buildStool(step),
    expect: (s) => {
      const doc = s.doc();
      const glb = toGLB(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
      return glb.length > 1000 && new DataView(glb.buffer).getUint32(0, true) === 0x46546c67 ? null : 'bad GLB';
    },
  },
  {
    name: '6. Organic shape: a hollow ceramic vase (revolve + smooth)',
    run: (_s, step) => {
      step('new-object', { name: 'Vase', type: 'vase', color: '#c9b8a3', material: 'ceramic' });
      step('set-params', { values: { h: 0.32, t: 0.006, rBase: 0.07, rBelly: 0.11, rNeck: 0.045, rLip: 0.055 } });
      step('add-op', { id: 'body', op: 'revolve', args: { profile: [[0, 0], ['$rBase', 0], ['$rBelly', '$h*0.38'], ['$rNeck', '$h*0.86'], ['$rLip', '$h'], ['$rLip - $t', '$h'], ['$rNeck - $t', '$h*0.86'], ['$rBelly - $t', '$h*0.38'], ['$rBase - $t', '$t'], [0, '$t']] } });
      step('add-op', { id: 'vase', op: 'smooth', inputs: ['body'], args: { levels: 2, sharpAngle: 80 }, output: true });
      step('add-rule', { rule: { kind: 'range', expr: 'height', min: 0.3, max: 0.34, label: 'About 32 cm tall' } });
      step('add-rule', { rule: { kind: 'aboveFloor' } });
    },
    expect: (s) => {
      const info: any = s.call('inspect').result;
      if (info.stats.volume_m3 > 0.002) return `vase should be hollow (volume ${info.stats.volume_m3})`;
      return allPass(s);
    },
  },
  {
    name: '7. Alternatives: two seat proposals side by side, keep one',
    run: (_s, step) => {
      buildStool(step);
      step('propose', { title: 'Round seat' });
      step('add-op', { id: 'seatRound', op: 'cylinder', part: 'seat', output: false, args: { r: '$seatW/2 + 0.02', h: '$seatT + 0.002', at: [0, '$seatH - $seatT - 0.002', 0] } });
      step('set-op', { id: 'stool', inputs: ['seatRound', 'legs'], label: 'Use the round seat' });
      step('switch', { branch: 'main' });
      step('propose', { title: 'Soft-edged seat' });
      step('add-op', { id: 'seatSoft', op: 'roundedBox', part: 'seat', output: false, args: { size: ['$seatW', '$seatT', '$seatW'], r: 0.012, at: [0, '$seatH - $seatT/2', 0] } });
      step('set-op', { id: 'stool', inputs: ['seatSoft', 'legs'], label: 'Use the soft-edged seat' });
    },
    expect: (s) => {
      const p: any[] = s.call('proposals').result as any;
      if (p.length !== 2) return `expected 2 open proposals, got ${p.length}`;
      const r = s.call('commit-proposal', { proposal: p[0].id });
      if (!r.ok) return r.error ?? 'commit failed';
      s.call('discard-proposal', { proposal: p[1].id });
      return allPass(s);
    },
  },
  {
    name: '8. Export STL for printing (mm, Z-up)',
    run: (_s, step) => buildStool(step),
    expect: (s) => {
      const doc = s.doc();
      const stl = toSTL(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
      const n = new DataView(stl.buffer).getUint32(80, true);
      return n > 12 && stl.length === 84 + 50 * n ? null : 'bad STL';
    },
  },
  {
    name: '9. Materials: walnut seat, black-metal legs, carried into the GLB',
    run: (_s, step) => {
      buildStool(step);
      step('set-material', { part: 'leg*', preset: 'black-metal' });
    },
    expect: (s) => {
      const doc = s.doc();
      const glb = toGLB(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
      const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
      const metal = json.materials.find((m: any) => m.name === 'black-metal');
      const wood = json.materials.find((m: any) => m.name === 'walnut');
      if (!metal || !wood) return `materials in GLB: ${json.materials.map((m: any) => m.name).join(', ')}`;
      return metal.pbrMetallicRoughness.metallicFactor > 0.5 && wood.extras?.woodGrain ? allPass(s) : 'PBR values missing';
    },
  },
  {
    name: '10. Scene: a vase on the stool stays on it when the stool gets taller',
    run: (_s, step) => {
      buildStool(step);
      step('new-object', { name: 'Vase', type: 'vase', material: 'glazed-ceramic', color: '#2f5d62' });
      step('add-op', { id: 'body', op: 'revolve', args: { curve: true, profile: [[0, 0], [0.06, 0], [0.09, 0.1], [0.04, 0.25], [0.05, 0.28], [0.044, 0.28], [0.034, 0.25], [0.084, 0.1], [0.054, 0.006], [0, 0.006]] } });
      step('place-object', { object: 'vase', relation: 'on', target: 'walnut-stool' });
      step('set-param', { object: 'walnut-stool', name: 'seatH', value: 0.6 });
    },
    expect: (s) => {
      const y = s.evaluate(s.doc().objects.vase).bbox!.min[1];
      return Math.abs(y - 0.6) > 0.001 ? `vase base at ${y}, seat at 0.6` : allPass(s);
    },
  },
  {
    name: '11. Arrange: four linked stools around a round table, then make them all taller',
    run: (_s, step) => {
      step('new-object', { name: 'Table', type: 'table', material: 'oak' });
      step('add-op', { id: 'top', op: 'cylinder', part: 'top', output: false, args: { r: 0.5, h: 0.035, at: [0, 0.705, 0] } });
      step('add-op', { id: 'post', op: 'cylinder', part: 'leg', output: false, args: { r: 0.04, h: 0.71 } });
      step('add-op', { id: 'foot', op: 'cylinder', part: 'leg-foot', output: false, args: { r: 0.25, h: 0.03 } });
      step('add-op', { id: 'table', op: 'union', inputs: ['top', 'post', 'foot'], output: true });
      buildStool(step);
      step('duplicate-object', { object: 'walnut-stool', count: 3 });
      step('arrange', { objects: ['walnut-stool', 'walnut-stool-2', 'walnut-stool-3', 'walnut-stool-4'], around: 'table', radius: 0.62, start: 45 });
      step('set-param', { object: 'walnut-stool', name: 'seatH', value: 0.5 });
    },
    expect: (s) => {
      const doc = s.doc();
      for (const id of ['walnut-stool', 'walnut-stool-2', 'walnut-stool-3', 'walnut-stool-4']) {
        const b = s.evaluate(doc.objects[id]).bbox!;
        const r = Math.hypot((b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2);
        if (Math.abs(r - 0.62) > 0.003) return `${id} at radius ${r.toFixed(3)}`;
        if (Math.abs(b.max[1] - 0.5) > 0.001) return `${id} did not follow the original (${b.max[1]})`;
      }
      return allPass(s);
    },
  },
  {
    name: '12. Hand edits from the view: drag the vase across the seat, drag a part, scrub a param',
    run: (s, step) => {
      buildStool(step);
      step('new-object', { name: 'Vase', type: 'vase', material: 'glazed-ceramic' });
      step('add-op', { id: 'body', op: 'cylinder', args: { r: 0.05, h: 0.2 } });
      step('place-object', { object: 'vase', relation: 'on', target: 'walnut-stool' });
      const human = (t: string, a: object) => { const r = s.call(t, a, 'human'); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };
      human('drag-object', { object: 'vase', by: [0.06, 0.04] });
      human('drag-part', { object: 'walnut-stool', part: 'seat', by: [0, 0, 0.01] });
      human('set-param', { object: 'walnut-stool', name: 'seatH', value: 0.47 });
    },
    expect: (s) => {
      const log = s.log('main', 3);
      if (log.some((c) => c.author !== 'human')) return 'hand edits should be human steps';
      const p = s.doc().objects.vase.place as any;
      if (p?.kind !== 'on' || p.offset?.[0] !== 0.06) return `vase relation lost: ${JSON.stringify(p)}`;
      return allPass(s);
    },
  },
  {
    name: '13. Import: an STL scan as a measurable reference (left out of export)',
    run: (s, step) => {
      buildStool(step);
      const doc = s.doc();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-import-'));
      fs.writeFileSync(path.join(dir, 'scan.stl'), toSTL([{ obj: doc.objects['walnut-stool'], res: s.evaluate(doc.objects['walnut-stool']) }]));
      (s as any).assets = new MemoryAssets(dir);
      step('import', { file: 'scan.stl' });
      step('move-object', { object: 'scan', position: [0.8, 0, 0] });
    },
    expect: (s) => {
      const info: any = s.call('inspect', { object: 'scan' }).result;
      const h = info.bbox.max[1] - info.bbox.min[1];
      if (Math.abs(h - 0.45) > 0.001) return `scan height ${h}`;
      const doc = s.doc();
      const glb = toGLB(doc.objectOrder.map((id) => ({ obj: doc.objects[id], res: s.evaluate(doc.objects[id]) })));
      const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
      return json.nodes.length === 1 ? allPass(s) : 'reference was exported';
    },
  },
  {
    name: '15. Game asset for Godot: profile, collision, baked export that validates',
    run(s, step) {
      buildStool(step);
      step('set-profile', { profile: 'godot-desktop' });
      step('add-op', { id: 'col', op: 'collision', inputs: ['stool'], args: { shape: 'hull' } });
    },
    async expect(s) {
      const fail = allPass(s);
      if (fail) return fail;
      const out = await gameExport(s, 'godot');
      const v = await validateGlb(out.glb);
      if (!v.ok) return `validator: ${JSON.stringify(v.messages)}`;
      const j = gltfJson(out.glb);
      if (!j.nodes.some((n: any) => /-convcolonly$/.test(n.name))) return 'no Godot collision node';
      if (j.materials.length !== 1 || !j.materials[0].pbrMetallicRoughness.baseColorTexture) return `expected one baked material, got ${JSON.stringify(j.materials.map((m: any) => m.name))}`;
      const uv = out.objects[0].uv!;
      return uv.checks.every((c) => c.pass) ? null : uv.checks.filter((c) => !c.pass).map((c) => c.detail).join('; ');
    },
  },
  {
    name: '16. Mobile web budget: a too-detailed vase is flagged, then fixed with fewer segments, a hull and a lod',
    run(s, step) {
      step('new-object', { name: 'Vase', type: 'vase', material: 'glazed-ceramic', color: '#3f6f8a' });
      step('set-profile', { profile: 'web-mobile' });
      step('set-params', { values: { h: 0.3, t: 0.006, rBase: 0.065, rBelly: 0.105, rNeck: 0.04, rLip: 0.052 } });
      const r = step('add-op', { id: 'body', op: 'revolve', args: { curve: true, profile: [[0, 0], ['$rBase', 0], ['$rBelly', '$h*0.38'], ['$rNeck', '$h*0.84'], ['$rLip', '$h'], ['$rLip - $t', '$h'], ['$rNeck - $t', '$h*0.84'], ['$rBelly - $t', '$h*0.38'], ['$rBase - $t', '$t'], [0, '$t']] } });
      if (!r.checks.vase.failures.some((f: any) => f.id === 'budget-triangles')) throw new Error('triangle budget was not flagged');
      step('set-op', { id: 'body', args: { segments: 24 } });
      step('add-op', { id: 'col', op: 'collision', inputs: ['body'], args: { shape: 'hull' } });
      step('add-op', { id: 'lod1', op: 'lod', inputs: ['body'], args: { ratio: 0.4 } });
    },
    async expect(s) {
      const fail = allPass(s);
      if (fail) return fail;
      const out = await gameExport(s, 'web');
      const v = await validateGlb(out.glb);
      if (!v.ok) return `validator: ${JSON.stringify(v.messages)}`;
      const j = gltfJson(out.glb);
      const main = j.nodes.find((n: any) => n.name === 'Vase');
      if (!main?.extensions?.MSFT_lod?.ids?.length) return 'no distance version (MSFT_lod)';
      const glaze = j.materials.find((m: any) => m.extensions?.KHR_materials_clearcoat);
      return glaze?.pbrMetallicRoughness?.baseColorTexture ? null : 'glazed material lost its clearcoat or texture';
    },
  },
  {
    name: '17. Over budget mid-build is pending, finished is failing; a capsule that misses the mesh is caught',
    run(s, step) {
      step('new-object', { name: 'Crate', type: 'prop', material: 'oak' });
      step('set-profile', { profile: 'web-mobile', triangles: 100 });
      step('add-op', { id: 'box', op: 'roundedBox', args: { size: [0.4, 0.4, 0.4], r: 0.03, at: [0, 0.2, 0] } });
      step('add-op', { id: 'spare', op: 'box', output: false, args: { size: [0.1, 0.1, 0.1] } });
    },
    expect(s) {
      const pend = s.checks('crate').find((c) => c.id === 'budget-triangles');
      if (!pend || pend.pass || !pend.pending) return `mid-build budget should be pending: ${JSON.stringify(pend)}`;
      s.call('remove-op', { id: 'spare' });
      const done = s.checks('crate').find((c) => c.id === 'budget-triangles');
      if (!done || done.pass || done.pending) return `finished over-budget should fail: ${JSON.stringify(done)}`;
      s.call('add-op', { id: 'col', op: 'collision', inputs: ['box'], args: { shape: 'capsule', axis: 'x' } });
      const col = s.checks('crate').find((c) => c.id === 'collision-col');
      return col && !col.pass ? null : `a capsule around a cube should not cover it: ${JSON.stringify(col)}`;
    },
  },
];

let failed = 0;
for (const t of tasks) {
  const s = new Studio();
  let calls = 0, errors = 0;
  const t0 = performance.now();
  const step = (tool: string, a: object = {}) => {
    calls++;
    const r = s.call(tool, a);
    if (!r.ok) { errors++; throw new Error(`${tool}: ${r.error}`); }
    return r;
  };
  let problem: string | null;
  try { await t.run(s, step); problem = await t.expect(s); } catch (e: any) { problem = e.message; }
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${problem ? 'FAIL' : 'pass'}  ${t.name}  (${calls} calls, ${errors} errors, ${ms} ms)${problem ? `\n      ${problem}` : ''}`);
  if (problem) failed++;
}
console.log(failed ? `\n${failed} task(s) failed` : '\nall reference solutions pass');
process.exitCode = failed ? 1 : 0;
