// Which objects an export takes (shared by the daemon's `export` and in-process callers): a character
// brings the props in its hands; --exclude leaves objects (and what they hold) out; --at-origin moves
// the chosen object, with its held props, so it stands at the origin facing +Z (a game player model).
import type { SceneDoc, SceneObject } from './types.ts';
import type { EvalResult } from './kernel.ts';

interface StudioLike { findObject(doc: SceneDoc, ref: string): SceneObject; evaluate(o: SceneObject): EvalResult }

export function selectForExport(studio: StudioLike, doc: SceneDoc, opts: { object?: string; exclude?: string | string[]; atOrigin?: boolean } = {}): Array<{ obj: SceneObject; res: EvalResult }> {
  const heldBy = (id: string) => doc.objectOrder.filter((k) => doc.objects[k]?.place?.kind === 'held' && (doc.objects[k].place as any).target === id);
  const excluded = new Set<string>();
  const ex = Array.isArray(opts.exclude) ? opts.exclude : String(opts.exclude ?? '').split(',');
  for (const x of ex.map((v) => v.trim()).filter(Boolean)) { const id = studio.findObject(doc, x).id; excluded.add(id); for (const h of heldBy(id)) excluded.add(h); }
  if (opts.atOrigin && !opts.object) throw new Error('--at-origin needs --object');
  const ids = (opts.object ? (() => { const id = studio.findObject(doc, opts.object!).id; return [id, ...heldBy(id)]; })() : doc.objectOrder).filter((id) => !excluded.has(id));
  const anchor = opts.atOrigin ? doc.objects[ids[0]] : null;
  const relocate = (o: SceneObject): SceneObject => {
    if (!anchor) return o;
    if (o === anchor) return { ...o, position: [0, o.position[1], 0], rotation: 0 };
    const a = (-(anchor.rotation ?? 0) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    const dx = o.position[0] - anchor.position[0], dz = o.position[2] - anchor.position[2];
    const position: [number, number, number] = [+(dx * c + dz * sn).toFixed(6), o.position[1], +(-dx * sn + dz * c).toFixed(6)];
    if (!o.orientation) return { ...o, position, rotation: (o.rotation ?? 0) - (anchor.rotation ?? 0) };
    const h = a / 2, p = [0, Math.sin(h), 0, Math.cos(h)], q = o.orientation;
    const orientation = [p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1], p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0], p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3], p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2]] as [number, number, number, number];
    return { ...o, position, orientation };
  };
  return ids.map((id) => { const obj = relocate(doc.objects[id]); return { obj, res: studio.evaluate(obj) }; });
}
