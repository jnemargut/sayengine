// Add (or replace) a look from a JSON record file: node look-record.ts <record.json> [--activate]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const file = process.argv[2];
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const env = { ...process.env, STUDIO_PORT: process.env.STUDIO_PORT ?? '4660' };
const run = (args: string[]) => { const r = spawnSync('./studio', args, { encoding: 'utf8', env }); const j = JSON.parse(r.stdout || '{}'); console.log(args[0], j.ok ? (j.summary ?? 'ok') : j.error); return j; };
const info = run(['look-info']);
if ((info.result?.looks ?? []).some((l: any) => l.name === rec.name)) {
  // replace the whole record: set every top-level key (look-set deep-merges)
  run(['look-set', '--look', rec.name, '--set', JSON.stringify({ ...rec, materials: null, bloom: null })]);
  run(['look-set', '--look', rec.name, '--set', JSON.stringify({ materials: rec.materials, bloom: rec.bloom })]);
} else run(['look-new', '--record', JSON.stringify(rec), '--activate', 'false']);
if (process.argv.includes('--activate')) run(['look-use', '--look', rec.name]);
