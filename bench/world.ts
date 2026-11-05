// Bench: the world module (Decisions 26–28). Builds a real town from the offline Raleigh fixture and an
// invented river town through the studio's own tools, regenerates both, refreshes the data under a fix,
// and scores: build time, fixes surviving, rules applied, checks green, the GLB valid and cheap to draw.
// `node bench/world.ts` (offline; no daemon, no network).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initKernel, Studio, GlbBuilder, validateGlb } from '../packages/core/src/index.ts';
import { setWorldCacheDir, buildTown, worldNodes, addTownsToGlb } from '../packages/core/src/world/index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await initKernel();
setWorldCacheDir(path.join(ROOT, 'packages/core/test/fixtures/world'));
const s = new Studio();
const rows: Array<{ task: string; pass: boolean; detail: string }> = [];
const row = (task: string, pass: boolean, detail: string) => { rows.push({ task, pass, detail }); };
const call = (t: string, a: object) => { const r = s.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); return r; };

let t0 = Date.now();
call('world-town', { name: 'Mini Raleigh', source: 'real', area: 'raleigh-mini' });
call('world-town', { name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', offset: [300, 0, 0] });
const build = Date.now() - t0;
row('both towns build', build < 5000, `${build} ms`);
const real = buildTown(s.doc().world!.towns['Mini Raleigh']).plan;
const inv = buildTown(s.doc().world!.towns['River Twin']).plan;
row('real buildings squared', real.stats.squared >= real.buildings.length * 0.8, `${real.stats.squared}/${real.buildings.length}`);
row('invented town has its landmarks', inv.buildings.some((b) => b.use === 'church') && inv.buildings.some((b) => b.use === 'industrial') && inv.buildings.some((b) => b.use === 'civic'), `${inv.buildings.length} buildings`);

const big = real.buildings.slice().sort((a, b) => b.height - a.height)[0];
call('world-fix', { town: 'Mini Raleigh', id: big.id, set: { roof: 'flat', height: big.height + 6 }, note: 'bench' });
const inside = inv.buildings[3];
call('world-fix', { town: 'River Twin', id: inside.id, set: { wall: '#7a9cc6' } });
call('world-town', { name: 'River Twin', source: 'invented', seed: 7, description: 'mill town on a river, 1920s, 3 blocks', offset: [300, 0, 0] });
const after = buildTown(s.doc().world!.towns['River Twin']);
row('invented fix survives a regenerate', after.fixes.applied.length === 1 && after.plan.buildings.find((b) => b.id === inside.id)?.palette?.wall === '#7a9cc6', JSON.stringify(after.fixes.applied));

const checks = s.call('check', {}).result as Record<string, any[]>;
const townRows = Object.entries(checks).filter(([k]) => k.startsWith('town:')).flatMap(([, v]) => v);
row('world checks green', townRows.every((c) => c.pass), townRows.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`).join('; ') || `${townRows.length} rows`);

t0 = Date.now();
const B = new GlbBuilder();
const rep = addTownsToGlb(B, worldNodes(s.doc().world));
const glb = B.build();
const v = await validateGlb(glb);
row('GLB valid', v.errors === 0, `${(glb.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms`);
const prims = rep.reduce((n, r) => n + r.primitives, 0);
row('few draw calls', prims <= 80, `${prims} primitives, ${rep[0].materials} materials, ${rep.reduce((n, r) => n + r.triangles, 0)} triangles`);

const passed = rows.filter((r) => r.pass).length;
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.task.padEnd(38)} ${r.detail}`);
console.log(`\nworld bench: ${passed}/${rows.length}`);
if (passed < rows.length) process.exitCode = 1;
