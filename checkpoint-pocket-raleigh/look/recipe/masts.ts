// The City Plaza light masts as fix-layer props (one studio model placed four times).
import { spawnSync } from 'node:child_process';
const run = (args: string[]) => { const r = spawnSync('./studio', args, { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: '4620' } }); const j = JSON.parse(r.stdout || '{}'); console.log(j.summary ?? j.error ?? r.stderr.slice(0, 200)); return j; };
for (const o of ['City Plaza light mast 2', 'City Plaza light mast 3', 'City Plaza light mast 4']) run(['delete-object', '--object', o]);
const spots: Array<[number, number, number, string]> = [[-4.4, -50, 0.55, 'NW'], [15.6, -50, 0.55, 'NE'], [-7.9, 30, -0.15, 'SW'], [12.1, 30, -0.15, 'SE']];
for (const [x, z, base, n] of spots) run(['world-fix', '--town', 'Pocket Raleigh', '--place', 'true', '--model', 'City Plaza light mast', '--at', JSON.stringify([x, z]), '--base', String(base), '--note', `City Plaza light mast (${n})`]);
const c = run(['check']);
console.log(JSON.stringify(c.result ?? c, null, 0).slice(0, 1500));
