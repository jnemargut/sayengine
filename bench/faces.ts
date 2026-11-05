// Face appeal round (Phase 7): the cast's face close-ups and full-body sheets, in the faceted style and
// the smooth style, as stills of the live view (Phase 10: the cast player is retired). Writes
// checkpoint-faces/<label>/<style>/.
//   node bench/faces.ts [label]          (label defaults to "after"; needs Chrome)
//   FACES_STYLES=faceted node bench/faces.ts before
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, Studio } from '../packages/core/src/index.ts';
import { openView } from './viewbench.ts';
import { CAST } from './cast.ts';

const label = process.argv[2] ?? 'after';
const OUT = path.resolve(process.env.FACES_OUT ?? path.join(import.meta.dirname, '..', 'checkpoint-faces'), label);
const styles = (process.env.FACES_STYLES ?? 'faceted,smooth').split(',');
await initKernel();
const byStyle = new Map<string, any[]>();
for (const style of styles) {
  const studio = new Studio();
  for (const c of CAST) {
    const r = studio.call('new-character', { name: c.name, ...c.args, ...(style === 'smooth' ? { style: 'smooth' } : style === 'faceted' && (c.args as any).preset === 'elder' ? { style: 'faceted' } : {}) });
    if (!r.ok) throw new Error(`${c.name}: ${r.error}`);
  }
  const doc = studio.doc();
  const cast = [];
  const report: string[] = [];
  for (const id of doc.objectOrder) {
    const o = doc.objects[id];
    const checks = studio.checks(id);
    const bad = checks.filter((c) => !c.pass && !c.pending);
    const res = studio.evaluate(o);
    const sp = res.rig!.rig.spec;
    report.push(`${o.name} (${style}): ${checks.length - bad.length}/${checks.length} checks pass, ${res.triangles} triangles${bad.length ? ` — FAIL: ${bad.map((c) => `${c.label}: ${c.detail}`).join(' | ')}` : ''}`);
    cast.push({ id, name: o.name });
  }
  byStyle.set(style, cast);
  const dir = path.join(OUT, style);
  fs.rmSync(dir, { recursive: true, force: true });
  const view = await openView(studio);
  // a full-body sheet of the whole cast, then a face close-up of each
  await view.stills(dir, [
    { id: 'cast', seconds: 0, t: 0.5, name: 'cast', dir: [0, 0.2, 1], fill: 0.5 } as any,
    ...cast.map((c: any) => ({ id: c.id, seconds: 0, t: 0.5, name: `face-${c.id}`, focus: c.id, close: 'face', solo: true } as any)),
  ], { width: Number(process.env.FACES_W ?? 1600), height: Number(process.env.FACES_H ?? 1000) });
  view.close();
  fs.writeFileSync(path.join(dir, 'checks.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  console.log(`${style}: ${dir}`);
}
// (the faceted ↔ smooth toggle page went with the cast player: compare the two folders' stills)
