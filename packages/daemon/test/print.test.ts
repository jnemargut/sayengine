// `studio print` against the real Bambu Studio on this Mac (Decision 43): flattened presets, a
// project with the A1 mini preset and one object per piece, a background slice for the estimate,
// and the STL fallback. Skipped where Bambu Studio isn't installed. Never opens the app.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initKernel, Studio } from '../../core/src/index.ts';
import { findBambu, flattenPreset, read3mfEntry } from '../src/bambu.ts';
import { printTool } from '../src/print.ts';

process.env.STUDIO_NO_OPEN = '1';
const app = findBambu();
before(async () => { await initKernel(); });

function boxAndLid() {
  const s = new Studio();
  const ok = (t: string, a: object) => { const r = s.call(t, a); assert.ok(r.ok, `${t}: ${r.error}`); return r; };
  ok('new-object', { name: 'Box', type: 'box' });
  ok('set-print-profile', { printer: 'a1-mini' });
  ok('add-op', { id: 'outer', op: 'box', part: 'box', args: { size: [0.04, 0.02, 0.03], at: [0, 0.01, 0] } });
  ok('add-op', { id: 'inner', op: 'box', output: false, args: { size: [0.036, 0.02, 0.026], at: [0, 0.012, 0] } });
  ok('add-op', { id: 'body', op: 'difference', inputs: ['outer', 'inner'], output: false });
  ok('add-op', { id: 'lid', op: 'box', part: 'lid', output: false, args: { size: [0.04, 0.002, 0.03], at: [0.05, 0.001, 0] } });
  ok('add-op', { id: 'kit', op: 'union', inputs: ['body', 'lid'], output: true });
  return s;
}

test('presets flatten their whole "inherits" chain', { skip: !app && 'Bambu Studio not installed' }, () => {
  const m = flattenPreset('machine', 'Bambu Lab A1 mini 0.4 nozzle');
  assert.equal(m.inherits, undefined);
  assert.equal(m.printer_model, 'Bambu Lab A1 mini');
  assert.deepEqual(m.printable_area, ['0x0', '180x0', '180x180', '0x180']);
  const p = flattenPreset('process', '0.20mm Standard @BBL A1M');
  assert.equal(p.layer_height, '0.2');
});

test('studio print builds an A1 mini project with one object per piece and an estimate', { skip: !app && 'Bambu Studio not installed', timeout: 400000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-print-'));
  const s = boxAndLid();
  const r = await printTool(s, dir, path.join(dir, '.studio'), { object: 'box' });
  assert.ok(r.ok, r.error);
  const out = r.result;
  assert.equal(out.fallback, undefined, out.fallback);
  assert.ok(fs.existsSync(out.file));
  assert.equal(out.pieces, 2);
  assert.equal(out.opened, false);
  const proj = JSON.parse(read3mfEntry(out.file, 'Metadata/project_settings.config')!);
  assert.equal(proj.printer_model, 'Bambu Lab A1 mini');
  assert.equal(proj.printer_settings_id, 'Bambu Lab A1 mini 0.4 nozzle');
  const names = [...(read3mfEntry(out.file, 'Metadata/model_settings.config') ?? '').matchAll(/key="name" value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.includes('Box box.stl') && names.includes('Box lid.stl'), names.join(', '));
  assert.ok(out.estimate?.time, 'a time estimate from the background slice');
  assert.ok(out.estimate.grams > 0);
});

test('studio print refuses an object whose print checks fail, unless --force', { skip: !app && 'Bambu Studio not installed', timeout: 400000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-print-'));
  const s = new Studio();
  s.call('new-object', { name: 'Plank', type: 'plank' });
  s.call('set-print-profile', { printer: 'a1-mini' });
  s.call('add-op', { id: 'p', op: 'box', args: { size: [0.25, 0.01, 0.03], at: [0, 0.005, 0] } });
  const r = await printTool(s, dir, path.join(dir, '.studio'), { object: 'plank' });
  assert.equal(r.ok, false);
  assert.match(r.error, /too wide/);
  assert.match(r.hint, /print-fix --fix lay-flat\|chamfer\|split/);
});

test('without Bambu Studio, a checked STL is written instead and the result says why', { timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-print-'));
  const was = process.env.BAMBU_STUDIO_APP;
  process.env.BAMBU_STUDIO_APP = path.join(dir, 'NoSuch.app');
  try {
    const r = await printTool(boxAndLid(), dir, path.join(dir, '.studio'), { object: 'box' });
    assert.ok(r.ok, r.error);
    assert.match(r.result.fallback, /not installed/);
    assert.ok(r.result.files.every((f: string) => fs.existsSync(f) && f.endsWith('.stl')));
  } finally {
    if (was === undefined) delete process.env.BAMBU_STUDIO_APP; else process.env.BAMBU_STUDIO_APP = was;
  }
});
