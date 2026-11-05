// Face appeal round (Phase 7): the cast's face close-ups and full-body sheets, in the faceted style and
// the smooth style, at the same cameras as the craft pass. Writes checkpoint-faces/<label>/<style>/.
//   node bench/faces.ts [label]          (label defaults to "after"; needs Chrome)
//   FACES_STYLES=faceted node bench/faces.ts before
import fs from 'node:fs';
import path from 'node:path';
import { initKernel, Studio, selectForExport, toGLB, validateGlb } from '../packages/core/src/index.ts';
import { buildCastLineup, captureCast } from '../packages/daemon/src/castplayer/make.ts';
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
    const glb = toGLB(selectForExport(studio, doc, { object: id, atOrigin: true }), {});
    const v = await validateGlb(glb);
    if (!v.ok) throw new Error(`${id}: GLB does not validate: ${JSON.stringify(v).slice(0, 400)}`);
    cast.push({ id, name: o.name, label: `${sp.plan} · ${sp.face.kind} mouth`, glb, height: sp.params.height, idle: 'idle', headH: sp.face.headH, headY: sp.face.headBase[1], headZ: sp.face.headBase[2] });
  }
  byStyle.set(style, cast);
  const dir = path.join(OUT, style);
  fs.rmSync(dir, { recursive: true, force: true });
  await buildCastLineup(dir, `The cast (${style})`, cast);
  process.env.CAST_STILLS_ONLY = '1';
  await captureCast(dir, { width: Number(process.env.FACES_W ?? 2400), height: Number(process.env.FACES_H ?? 1200) });
  fs.writeFileSync(path.join(dir, 'checks.txt'), report.join('\n') + '\n');
  console.log(report.join('\n'));
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.glb') || f === 'frames') fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  console.log(`${style}: ${dir}`);
}
// both styles: one lineup page that keeps the GLBs and toggles faceted ↔ smooth (open player/index.html over http)
if (byStyle.has('faceted') && byStyle.has('smooth')) {
  const smooth = byStyle.get('smooth')!;
  const dir = path.join(OUT, 'player');
  fs.rmSync(dir, { recursive: true, force: true });
  await buildCastLineup(dir, 'The cast (faceted ↔ smooth)', byStyle.get('faceted')!.map((m, i) => ({ ...m, alt: smooth[i].glb })), ['faceted', 'smooth']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '*.glb\n');   // ~100 MB of models: kept locally to view, not committed
  console.log(`style toggle player: ${dir}`);
}
