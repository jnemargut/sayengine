// Reference-solution benchmark: proves the engine can express each benchmark task and that
// checks behave. (The AI benchmark — Claude Code driving /studio — is described in bench/TASKS.md.)
// Run: npm run bench
import { initKernel, Studio, toGLB, toSTL } from '../packages/core/src/index.ts';

await initKernel();

type Task = { name: string; run(s: Studio, step: (t: string, a?: object) => any): void; expect(s: Studio): string | null };

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
  try { t.run(s, step); problem = t.expect(s); } catch (e: any) { problem = e.message; }
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${problem ? 'FAIL' : 'pass'}  ${t.name}  (${calls} calls, ${errors} errors, ${ms} ms)${problem ? `\n      ${problem}` : ''}`);
  if (problem) failed++;
}
console.log(failed ? `\n${failed} task(s) failed` : '\nall reference solutions pass');
process.exitCode = failed ? 1 : 0;
