// Scene level: linked copies and placement relations ("on top of", "next to", "around").
// Relations are stored on the object (obj.place) and re-solved every time a document is read, so
// changing the stool's height keeps the vase on it. Stored positions of placed objects are ignored.
import type { BBox, EvalResult } from './kernel.ts';
import type { Placement, SceneDoc, SceneObject } from './types.ts';

type V3 = [number, number, number];
const GEOMETRY_FIELDS = ['params', 'ops', 'opOrder', 'output', 'material', 'partMaterials', 'rules', 'semanticType'] as const;

/** Copy geometry from the source of a linked copy (follows chains, stops on cycles). */
export function fillInstances(doc: SceneDoc, errors: Record<string, string>) {
  for (const id of doc.objectOrder) {
    const o = doc.objects[id];
    if (!o?.instanceOf) continue;
    let src = doc.objects[o.instanceOf];
    const seen = new Set([id]);
    while (src?.instanceOf && !seen.has(src.id)) { seen.add(src.id); src = doc.objects[src.instanceOf]; }
    if (!src || src.instanceOf) { errors[id] = `linked copy of "${o.instanceOf}", which no longer exists`; continue; }
    for (const k of GEOMETRY_FIELDS) (o as any)[k] = structuredClone((src as any)[k]);
  }
}

const centre = (b: BBox) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];

export function facingAngle(face: string | undefined, toTargetDeg: number): number {
  return face === 'away' ? toTargetDeg + 180 : face === 'none' ? 0 : toTargetDeg;
}

/**
 * Solve every placed object's position (and rotation for around/along) in dependency order.
 * evalAt(obj) must evaluate an object with its current position/rotation.
 */
export function solvePlacements(doc: SceneDoc, evalAt: (o: SceneObject) => EvalResult, errors: Record<string, string>) {
  const state = new Map<string, 'busy' | 'done'>();
  const solve = (id: string) => {
    const o = doc.objects[id];
    if (!o || state.get(id) === 'done') return;
    if (state.get(id) === 'busy') { errors[id] = 'placement cycle (objects placed relative to each other)'; return; }
    const p = o.place;
    if (!p) { state.set(id, 'done'); return; }
    state.set(id, 'busy');
    const t = doc.objects[p.target];
    if (!t) { errors[id] = `placed relative to "${p.target}", which doesn't exist`; state.set(id, 'done'); return; }
    solve(t.id);
    if (errors[id]) { state.set(id, 'done'); return; }
    const tr = evalAt(t);
    if (!tr.bbox) { errors[id] = `"${t.name}" has no geometry yet to place against`; state.set(id, 'done'); return; }
    const tb = tr.bbox, tc = centre(tb);
    const [dx, dz] = p.offset ?? [0, 0];
    // rotation first (around/along face the target), then the local bounds at that rotation
    let rot = o.rotation ?? 0;
    let ax = 0, az = 0; // desired footprint centre
    if (p.kind === 'around') {
      const n = Math.max(1, p.count);
      const theta = (p.start ?? 0) + (p.index * 360) / n;
      const lr = evalAt({ ...o, position: [0, 0, 0], rotation: 0 });
      const own = lr.bbox ? Math.max(lr.bbox.max[0] - lr.bbox.min[0], lr.bbox.max[2] - lr.bbox.min[2]) / 2 : 0;
      const r = p.radius ?? Math.max(tb.max[0] - tb.min[0], tb.max[2] - tb.min[2]) / 2 + own * 0.4;
      const th = (theta * Math.PI) / 180;
      ax = tc[0] + r * Math.sin(th); az = tc[2] + r * Math.cos(th);
      rot = facingAngle(p.face ?? 'target', theta + 180) + (p.rotate ?? 0);
    } else if (p.kind === 'along') {
      const facing = { front: 180, back: 0, right: -90, left: 90 }[p.side];
      rot = facingAngle(p.face ?? 'target', facing) + (p.rotate ?? 0);
    }
    const lr = evalAt({ ...o, position: [0, 0, 0], rotation: rot });
    if (!lr.bbox) { errors[id] = 'no geometry yet'; state.set(id, 'done'); return; }
    const lb = lr.bbox, lc = centre(lb);
    const w = lb.max[0] - lb.min[0], d = lb.max[2] - lb.min[2];
    let y = tb.min[1];
    let pos: V3;
    switch (p.kind) {
      case 'on': ax = tc[0]; az = tc[2]; y = tb.max[1]; break;
      case 'under': ax = tc[0]; az = tc[2]; y = 0; break;
      case 'nextTo':
        ax = p.side === 'right' ? tb.max[0] + p.gap + w / 2 : p.side === 'left' ? tb.min[0] - p.gap - w / 2 : tc[0];
        az = p.side === 'front' ? tb.max[2] + p.gap + d / 2 : p.side === 'back' ? tb.min[2] - p.gap - d / 2 : tc[2];
        break;
      case 'align': {
        const k = p.axis === 'x' ? 0 : 2;
        const cur = evalAt({ ...o, rotation: rot });
        const cb = cur.bbox!;
        const want = p.edge === 'min' ? tb.min[k] : p.edge === 'max' ? tb.max[k] : tc[k];
        const have = p.edge === 'min' ? cb.min[k] : p.edge === 'max' ? cb.max[k] : (cb.min[k] + cb.max[k]) / 2;
        pos = [...o.position] as V3;
        pos[k] += want - have;
        pos[0] += dx; pos[2] += dz;
        o.position = pos; o.rotation = rot;
        state.set(id, 'done');
        return;
      }
      case 'along': {
        const n = Math.max(1, p.count);
        const alongX = p.side === 'front' || p.side === 'back';
        const len = alongX ? tb.max[0] - tb.min[0] : tb.max[2] - tb.min[2];
        const spacing = p.spacing ?? len / n;
        const s = (p.index - (n - 1) / 2) * spacing;
        const gap = p.gap ?? 0.05;
        if (alongX) { ax = tc[0] + s; az = p.side === 'front' ? tb.max[2] + gap + d / 2 : tb.min[2] - gap - d / 2; }
        else { az = tc[2] + s; ax = p.side === 'right' ? tb.max[0] + gap + w / 2 : tb.min[0] - gap - w / 2; }
        break;
      }
      case 'around': break;
    }
    pos = [ax - lc[0] + dx, y - lb.min[1], az - lc[2] + dz];
    o.position = pos.map((v) => +v.toFixed(6)) as V3;
    o.rotation = rot;
    state.set(id, 'done');
  };
  for (const id of doc.objectOrder) solve(id);
}

const fmtM = (m: number) => (Math.abs(m) >= 1 ? `${+m.toFixed(2)} m` : `${Math.round(m * 1000) / 10} cm`);

/** Plain-English description of a placement, used in step summaries and inspect. */
export function describePlacement(p: Placement, name: (id: string) => string): string {
  const off = p.offset && (p.offset[0] || p.offset[1]) ? `, offset ${fmtM(p.offset[0])} in x and ${fmtM(p.offset[1])} in z` : '';
  switch (p.kind) {
    case 'on': return `on top of ${name(p.target)}${off || ', centred'}`;
    case 'under': return `centred under ${name(p.target)}${off}`;
    case 'nextTo': return `${fmtM(p.gap)} to the ${p.side === 'front' || p.side === 'back' ? `${p.side} of` : `${p.side} of`} ${name(p.target)}${off}`;
    case 'align': return `aligned with ${name(p.target)} (${p.edge === 'center' ? 'centres' : `${p.edge} edges`} in ${p.axis})${off}`;
    case 'around': return `${p.index + 1} of ${p.count} around ${name(p.target)}${p.radius !== undefined ? ` at ${fmtM(p.radius)}` : ''}${p.face === 'away' ? ', facing out' : p.face === 'none' ? '' : ', facing it'}${off}`;
    case 'along': return `${p.index + 1} of ${p.count} along the ${p.side} of ${name(p.target)}${off}`;
  }
}
