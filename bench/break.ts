// Set up AI benchmark task 4: a stool with deliberately broken legs, written to .studio/repo.json.
// Usage: ./studio stop && node bench/break.ts && open http://localhost:4517 (any ./studio command restarts the daemon)
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, Studio } from '../packages/core/src/index.ts';

await initKernel();
const s = new Studio();
const step = (t: string, a: object) => { const r = s.call(t, a); if (!r.ok) throw new Error(`${t}: ${r.error}`); };
step('new-object', { name: 'Walnut stool', type: 'stool', color: '#6b4a33', material: 'walnut' });
step('set-params', { values: { seatH: 0.45, seatT: 0.03, seatW: 0.36, legR: 0.016, legSplay: 0 } });
step('add-op', { id: 'seat', op: 'box', part: 'seat', args: { size: ['$seatW', '$seatT', '$seatW'], at: [0, '$seatH - $seatT/2', 0] } });
step('add-op', { id: 'leg', op: 'cylinder', part: 'leg', output: false, args: { r: '$legR', h: '$seatH - $seatT - 0.006' } });
step('add-op', { id: 'legs', op: 'placeAt', inputs: ['leg'], output: false, args: { target: 'seat', anchor: 'corners:bottom', inset: -0.05 } });
step('add-op', { id: 'stool', op: 'union', inputs: ['seat', 'legs'], output: true });
const dir = path.join(process.cwd(), '.studio');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'repo.json'), JSON.stringify(s.history.data));
fs.rmSync(path.join(dir, 'activity.jsonl'), { force: true });
console.log('Broken stool written to .studio/repo.json. Failing checks:');
for (const c of s.checks('walnut-stool').filter((c) => !c.pass)) console.log(`  ✗ ${c.label}: ${c.detail}`);
