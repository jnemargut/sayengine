// Models three Raleigh landmarks in the studio (shapes from memory of the skyline, not a survey):
// PNC Plaza (164 m, glass shaft with white fins, a stepped lantern crown that glows at night),
// Wells Fargo Capitol Center (122 m, rose granite, banded windows, setbacks and a copper-green hipped top),
// and the City Plaza light masts on Fayetteville St (four ~17 m masts with glowing glass lanterns).
import { spawnSync } from 'node:child_process';
const run = (cmd: string, args: Record<string, unknown>) => {
  const argv = [cmd];
  for (const [k, v] of Object.entries(args)) argv.push(`--${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  const r = spawnSync('./studio', argv, { encoding: 'utf8', env: { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4620' } });
  let j: any; try { j = JSON.parse(r.stdout); } catch { j = { ok: false, error: r.stdout + r.stderr }; }
  if (!j.ok) { console.error(cmd, JSON.stringify(args), '→', j.error, j.hint ?? ''); process.exit(1); }
  return j;
};
const op = (object: string, id: string, o: string, args: any, extra: Record<string, unknown> = {}) => run('add-op', { object, id, op: o, args, ...extra });

// ── PNC Plaza ──
run('new-object', { name: 'PNC Plaza', type: 'building', description: 'PNC Plaza, 301 Fayetteville St: 164 m glass tower with a lit stepped crown (landmark for Pocket Raleigh)' });
const P = 'PNC Plaza';
op(P, 'podium', 'box', { size: [60, 16, 47], at: [0, 8, 0] }, { part: 'podium' });
op(P, 'storefront', 'box', { size: [60.4, 5, 47.4], at: [0, 2.8, 0] }, { part: 'storefront', output: false });
op(P, 'shaft', 'box', { size: [42, 132, 30], at: [0, 16 + 66, 0] }, { part: 'shaft', output: false });
op(P, 'fin', 'box', { size: [0.7, 132, 30.8], at: [-21, 16 + 66, 0] }, { part: 'fins', output: false });
op(P, 'fins', 'array', { count: 15, step: [3, 0, 0] }, { inputs: ['fin'], part: 'fins', output: false });
op(P, 'band', 'box', { size: [42.8, 0.9, 30.8], at: [0, 20, 0] }, { part: 'bands', output: false });
op(P, 'bands', 'array', { count: 33, step: [0, 3.95, 0] }, { inputs: ['band'], part: 'bands', output: false });
op(P, 'step1', 'box', { size: [36, 6, 25], at: [0, 151, 0] }, { part: 'crown glass', output: false });
op(P, 'crownBase', 'box', { size: [30, 0.4, 20], at: [0, 154.2, 0] }, { part: 'crown', output: false });
op(P, 'crownTop', 'box', { size: [7, 0.4, 5], at: [0, 163.6, 0] }, { part: 'crown', output: false });
op(P, 'crown', 'hull', {}, { inputs: ['crownBase', 'crownTop'], part: 'crown', output: false });
op(P, 'spire', 'cylinder', { r1: 0.9, r2: 0.15, h: 12, at: [0, 163.8, 0] }, { part: 'spire', output: false });
op(P, 'all', 'union', {}, { inputs: ['podium', 'storefront', 'shaft', 'fins', 'bands', 'step1', 'crown', 'spire'], output: true });
run('set-material', { object: P, part: 'podium', name: 'limestone', color: '#d8cdb7', roughness: 0.85 });
run('set-material', { object: P, part: 'storefront', name: 'storefront glass', color: '#2c3d48', roughness: 0.3 });
run('set-material', { object: P, part: 'shaft', name: 'tower glass', color: '#3f6f86', roughness: 0.3 });
run('set-material', { object: P, part: 'fins', name: 'mullions', color: '#e9ecea', roughness: 0.6 });
run('set-material', { object: P, part: 'bands', name: 'spandrel', color: '#5f8a9c', roughness: 0.5 });
run('set-material', { object: P, part: 'crown glass', name: 'crown glass lit', color: '#6fa3b8', roughness: 0.3 });
run('set-material', { object: P, part: 'crown', name: 'crown lamp', color: '#eef3f2', roughness: 0.5 });
run('set-material', { object: P, part: 'spire', name: 'spire', color: '#c9cdd0', roughness: 0.4, metalness: 0.6 });
run('move-object', { object: P, position: [-400, 0, -400] });

// ── Wells Fargo Capitol Center ──
const W = 'Wells Fargo Capitol Center';
run('new-object', { name: W, type: 'building', description: 'Wells Fargo Capitol Center, 150 Fayetteville St: 122 m rose-granite tower with setbacks and a copper-green hipped top (landmark)' });
op(W, 'base', 'box', { size: [52, 22, 39], at: [0, 11, 0] }, { part: 'granite' });
op(W, 'shaft', 'box', { size: [40, 84, 30], at: [0, 22 + 42, 0] }, { part: 'granite', output: false });
op(W, 'corner', 'box', { size: [44, 84, 6], at: [0, 22 + 42, 0] }, { part: 'granite', output: false });
op(W, 'band', 'box', { size: [40.6, 1.7, 30.6], at: [0, 25, 0] }, { part: 'windows', output: false });
op(W, 'bands', 'array', { count: 21, step: [0, 3.9, 0] }, { inputs: ['band'], part: 'windows', output: false });
op(W, 'setback', 'box', { size: [34, 8, 25], at: [0, 110, 0] }, { part: 'granite', output: false });
op(W, 'eave', 'box', { size: [36, 0.8, 27], at: [0, 114.4, 0] }, { part: 'trim', output: false });
op(W, 'roofBase', 'box', { size: [34, 0.4, 25], at: [0, 115, 0] }, { part: 'copper', output: false });
op(W, 'roofTop', 'box', { size: [8, 0.4, 2], at: [0, 124, 0] }, { part: 'copper', output: false });
op(W, 'roof', 'hull', {}, { inputs: ['roofBase', 'roofTop'], part: 'copper', output: false });
op(W, 'lantern', 'box', { size: [3, 3, 3], at: [0, 125.5, 0] }, { part: 'lantern', output: false });
op(W, 'all', 'union', {}, { inputs: ['base', 'shaft', 'corner', 'bands', 'setback', 'eave', 'roof', 'lantern'], output: true });
run('set-material', { object: W, part: 'granite', name: 'rose granite', color: '#b98c78', roughness: 0.8 });
run('set-material', { object: W, part: 'windows', name: 'window band', color: '#2b3a44', roughness: 0.3 });
run('set-material', { object: W, part: 'trim', name: 'granite trim', color: '#e0cfc0', roughness: 0.7 });
run('set-material', { object: W, part: 'copper', name: 'copper roof', color: '#5d9483', roughness: 0.6 });
run('set-material', { object: W, part: 'lantern', name: 'lantern lamp', color: '#f3ead2', roughness: 0.5 });
run('move-object', { object: W, position: [-460, 0, -400] });

// ── City Plaza light masts ──
const L = 'City Plaza light mast';
run('new-object', { name: L, type: 'lamp', description: 'One of the four City Plaza light masts on Fayetteville St: a tapered steel mast topped with a glowing glass lantern' });
op(L, 'foot', 'cylinder', { r1: 0.8, r2: 0.6, h: 1.2, at: [0, 0, 0] }, { part: 'foot' });
op(L, 'mast', 'cylinder', { r1: 0.42, r2: 0.22, h: 12.5, at: [0, 1.2, 0] }, { part: 'steel', output: false });
op(L, 'collar', 'cylinder', { r: 0.75, h: 0.35, at: [0, 13.5, 0] }, { part: 'steel', output: false });
op(L, 'lantern', 'box', { size: [1.1, 3.6, 1.1], at: [0, 15.7, 0] }, { part: 'lantern', output: false });
op(L, 'cap', 'box', { size: [1.5, 0.3, 1.5], at: [0, 17.65, 0] }, { part: 'steel', output: false });
op(L, 'arm', 'box', { size: [2.6, 0.18, 0.18], at: [0, 12.2, 0] }, { part: 'steel', output: false });
op(L, 'all', 'union', {}, { inputs: ['foot', 'mast', 'collar', 'lantern', 'cap', 'arm'], output: true });
run('set-material', { object: L, part: 'foot', name: 'granite', color: '#8d8a83', roughness: 0.8 });
run('set-material', { object: L, part: 'steel', name: 'mast steel', color: '#59616a', roughness: 0.45, metalness: 0.6 });
run('set-material', { object: L, part: 'lantern', name: 'lantern lamp', color: '#e8f1f4', roughness: 0.4 });
console.log('landmarks modelled');
