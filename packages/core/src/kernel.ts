// Geometry kernel adapter (Decision 4: kernel interface; Manifold is engine #1).
// Evaluates an object's typed op graph (Decision 3) into a mesh with per-part triangle ranges.
// DOM-free: runs in Node and in the browser.

import Module from 'manifold-3d';
import { num, vec3, type ParamValues } from './expr.ts';
import { AUX_OPS, type SceneObject, type OpNode } from './types.ts';
import type { RawMesh } from './importers.ts';

type V3 = [number, number, number];
export interface BBox { min: V3; max: V3 }

export interface PartInfo {
  name: string;
  ranges: Array<[number, number]>; // [triStart, triCount]
  bbox: BBox;
  ops: string[];                   // op ids that produced/transformed this part (provenance)
}

export interface EvalResult {
  ok: boolean;
  error?: string;
  errorOp?: string;
  positions: Float32Array;         // xyz per vertex, world space (object position applied)
  indices: Uint32Array;            // 3 per triangle
  parts: PartInfo[];
  bbox: BBox | null;
  status: string;
  components: number;
  volume: number;
  genus: number;
  triangles: number;
  unusedOps: string[];
  manifold?: boolean;              // false for an imported mesh that isn't watertight (shown, not usable in booleans)
  uvs?: Float32Array;              // per-vertex UVs when the shape brings its own (character templates); export unwraps otherwise
  collision?: CollisionInfo;       // set when the root op is a collision op
}

/** What a collision op fitted, in object space before placement (for engines that want primitives). */
export interface CollisionInfo { shape: 'box' | 'hull' | 'capsule' | 'sphere'; center: V3; size?: V3; radius?: number; height?: number; axis?: 'x' | 'y' | 'z' }

/** Imported meshes are resolved through this hook (the Studio wires it to its asset store). */
type MeshLoader = (args: Record<string, unknown>) => RawMesh;
let meshLoader: MeshLoader | null = null;
export function setMeshLoader(fn: MeshLoader | null) { meshLoader = fn; }
class NotManifold extends Error {
  raw: RawMesh; part: string;
  constructor(raw: RawMesh, part: string) { super('imported mesh is not a closed manifold'); this.raw = raw; this.part = part; }
}

let wasm: any = null;
export async function initKernel(): Promise<void> {
  if (!wasm) {
    wasm = await Module();
    wasm.setup();
  }
}
export function kernelReady(): boolean { return wasm !== null; }

const SEGMENTS = 48;

function rotationAbout(point: V3, axis: V3, deg: number): number[] {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const [x, y, z] = [axis[0] / len, axis[1] / len, axis[2] / len];
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const R = [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
  const [px, py, pz] = point;
  const tx = px - (R[0][0] * px + R[0][1] * py + R[0][2] * pz);
  const ty = py - (R[1][0] * px + R[1][1] * py + R[1][2] * pz);
  const tz = pz - (R[2][0] * px + R[2][1] * py + R[2][2] * pz);
  // column-major 4x4
  return [R[0][0], R[1][0], R[2][0], 0, R[0][1], R[1][1], R[2][1], 0, R[0][2], R[1][2], R[2][2], 0, tx, ty, tz, 1];
}

export const ANCHORS = ['corners:bottom', 'corners:top', 'center:bottom', 'center:top', 'center', 'edges:bottom', 'edges:top'] as const;

function anchorPoints(b: BBox, anchor: string, inset: number): V3[] {
  const [x0, y0, z0] = b.min, [x1, y1, z1] = b.max;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const [side, face] = anchor.split(':');
  const y = face === 'top' ? y1 : face === 'bottom' ? y0 : cy;
  const a = x0 + inset, bX = x1 - inset, c = z0 + inset, d = z1 - inset;
  switch (side) {
    case 'corners': return [[a, y, c], [bX, y, c], [bX, y, d], [a, y, d]];
    case 'edges': return [[cx, y, c], [bX, y, cz], [cx, y, d], [a, y, cz]];
    case 'center': return [[cx, y, cz]];
    default: throw new Error(`unknown anchor "${anchor}" (use one of ${ANCHORS.join(', ')})`);
  }
}

type Part = { name: string; ops: Set<string> };
type Val = { m: any; parts: Map<number, Part> };

/**
 * Evaluate an object's op graph. `root` defaults to the output; pass a collision or lod op id to
 * evaluate that side product instead (same parts, placement and caching rules).
 */
export function evaluateObject(obj: SceneObject, root: string | null = obj.output): EvalResult {
  if (!wasm) throw new Error('kernel not initialised — call initKernel() first');
  const { Manifold } = wasm;
  const params: ParamValues = Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value]));
  const made: any[] = [];
  const keep = <T>(m: T): T => { made.push(m); return m; };
  const cache = new Map<string, Val>();
  const visiting = new Set<string>();
  const reached = new Set<string>();

  const empty = (extra: Partial<EvalResult>): EvalResult => ({
    ok: false, positions: new Float32Array(), indices: new Uint32Array(), parts: [], bbox: null,
    status: 'Empty', components: 0, volume: 0, genus: 0, triangles: 0,
    unusedOps: unused(), ...extra,
  });
  // collision/lod ops are side products, never "unused"
  const unused = () => obj.opOrder.filter((id) => !reached.has(id) && !AUX_OPS.includes(obj.ops[id]?.op));
  let collisionInfo: CollisionInfo | undefined;

  const boxOf = (m: any): BBox => {
    const b = m.boundingBox();
    return { min: [...b.min] as V3, max: [...b.max] as V3 };
  };

  const original = (m: any, name: string, opId: string): Val => {
    const o = keep(m.asOriginal());
    return { m: o, parts: new Map([[o.originalID(), { name, ops: new Set([opId]) }]]) };
  };

  const withOp = (parts: Map<number, Part>, opId: string) => {
    const out = new Map<number, Part>();
    for (const [k, p] of parts) out.set(k, { name: p.name, ops: new Set([...p.ops, opId]) });
    return out;
  };

  const firstPartName = (v: Val, fallback: string) => {
    const names = [...new Set([...v.parts.values()].map((p) => p.name.replace(/#\d+$/, '')))];
    return names.length === 1 ? names[0] : fallback;
  };

  const ev = (id: string): Val => {
    const hit = cache.get(id);
    if (hit) return hit;
    const node: OpNode | undefined = obj.ops[id];
    if (!node) throw Object.assign(new Error(`op "${id}" does not exist`), { op: id });
    if (visiting.has(id)) throw Object.assign(new Error(`cycle through op "${id}"`), { op: id });
    visiting.add(id);
    reached.add(id);
    const A = node.args ?? {};
    const missing = (k: string): never => { throw new Error(`${node.op} "${id}" needs args.${k} (see \`studio ops\`)`); };
    const P = (k: string, d?: number) => (A[k] === undefined || A[k] === null ? (d === undefined ? missing(k) : d) : num(A[k], params, `${id}.${k}`));
    const V = (k: string, d?: V3) => (A[k] === undefined || A[k] === null ? (d === undefined ? missing(k) : d) : vec3(A[k], params, `${id}.${k}`));
    const ins = (node.inputs ?? []).map(ev);
    const profile = (k: string, min: number): Array<[number, number]> => {
      const raw = A[k];
      if (!Array.isArray(raw) || raw.length < min) throw new Error(`${node.op} needs ${k}: at least ${min} [a,b] points`);
      const pts = raw.map((pt: any, i: number) => {
        if (!Array.isArray(pt) || pt.length !== 2) throw new Error(`${k}[${i}] must be a [a,b] pair`);
        return [num(pt[0], params, `${id}.${k}[${i}][0]`), num(pt[1], params, `${id}.${k}[${i}][1]`)] as [number, number];
      });
      return A.curve ? curveProfile(pts, A.curve === true ? 55 : Number(A.curve), 10, node.op === 'revolve') : pts;
    };
    const need = (n: number) => { if (ins.length < n) throw new Error(`${node.op} needs ${n} input(s)`); };
    let out: Val;
    try {
      switch (node.op) {
        case 'box': {
          const size = V('size');
          if (size.some((s) => s <= 0)) throw new Error('box size must be positive');
          const m = keep(Manifold.cube(size, true)).translate(V('at', [0, 0, 0]));
          out = original(keep(m), node.part ?? id, id);
          break;
        }
        case 'cylinder': {
          const r = P('r', NaN), h = P('h');
          const r1 = A.r1 !== undefined ? P('r1') : r, r2 = A.r2 !== undefined ? P('r2') : r1;
          if (!(r1 > 0) || !(h > 0) || r2 < 0) throw new Error('cylinder needs r (or r1/r2) > 0 and h > 0');
          const m = keep(keep(Manifold.cylinder(h, r1, r2, P('segments', SEGMENTS))).rotate([-90, 0, 0])).translate(V('at', [0, 0, 0]));
          out = original(keep(m), node.part ?? id, id);
          break;
        }
        case 'sphere': {
          const r = P('r');
          if (!(r > 0)) throw new Error('sphere needs r > 0');
          const m = keep(Manifold.sphere(r, P('segments', SEGMENTS))).translate(V('at', [0, 0, 0]));
          out = original(keep(m), node.part ?? id, id);
          break;
        }
        case 'mesh': {
          // An imported mesh (studio import): args.asset + units/up/scale/center.
          if (!meshLoader) throw new Error('no asset store available for mesh ops');
          if (!A.asset) missing('asset');
          const raw = meshLoader(A);
          const mesh = new wasm.Mesh({ numProp: 3, vertProperties: raw.positions, triVerts: raw.indices });
          let m: any;
          try { m = keep(new Manifold(mesh)); } catch { m = null; }
          if (!m || m.status() !== 'NoError' || m.isEmpty()) {
            if (obj.output === id) throw new NotManifold(raw, node.part ?? id);
            throw new Error(`mesh "${id}" (${A.asset}) is not a closed, watertight solid, so it can't be used in booleans — use it as a reference only`);
          }
          const at = V('at', [0, 0, 0]);
          out = original(keep(m.translate(at)), node.part ?? id, id);
          break;
        }
        case 'roundedBox': {
          const size = V('size'), r = P('r', 0.01);
          if (size.some((s) => s <= 0)) throw new Error('roundedBox size must be positive');
          if (!(r > 0) || r * 2 > Math.min(...size)) throw new Error('roundedBox r must be > 0 and ≤ half the smallest size');
          const at = V('at', [0, 0, 0]);
          const seg = Math.max(8, Math.round(P('segments', 24) / 4) * 4);
          const corners: any[] = [];
          for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
            corners.push(keep(keep(Manifold.sphere(r, seg)).translate([at[0] + sx * (size[0] / 2 - r), at[1] + sy * (size[1] / 2 - r), at[2] + sz * (size[2] / 2 - r)])));
          }
          out = original(keep(Manifold.hull(corners)), node.part ?? id, id);
          break;
        }
        case 'extrude': {
          // axis "y" (default): profile [[x,z],…] in the floor plane, pushed up +Y by h from "at".
          // axis "z": profile [[x,y],…] (a front-view outline, e.g. a gable), pushed along +Z.
          // axis "x": profile [[z,y],…] (a side-view outline), pushed along +X.
          // center: true centres the extrusion on "at" along the axis.
          const prof = profile('profile', 3);
          const h = P('h');
          if (!(h > 0)) throw new Error('extrude needs h > 0');
          const axis = String(A.axis ?? 'y');
          if (!['x', 'y', 'z'].includes(axis)) throw new Error('extrude axis must be "x", "y" or "z"');
          // Always a pair: the JS binding turns a bare number n into [n, 0] (collapses the top).
          const stRaw = A.scaleTop === undefined ? [1, 1] : Array.isArray(A.scaleTop) ? (A.scaleTop as unknown[]).map((v, i) => num(v as any, params, `${id}.scaleTop[${i}]`)) : [P('scaleTop'), P('scaleTop')];
          if (stRaw.length !== 2 || stRaw.some((v) => !(v >= 0))) throw new Error('extrude scaleTop must be n ≥ 0 or [a, b]');
          const st = stRaw as [number, number];
          const twist = P('twist', 0);
          let poly: number[][] = prof.map(([u, v]) => [u, v]);
          let area = 0;
          for (let i = 0; i < poly.length; i++) { const [a, b] = poly[i], [c, d] = poly[(i + 1) % poly.length]; area += a * d - c * b; }
          if (Math.abs(area) < 1e-12) throw new Error('extrude profile has zero area');
          if (area < 0) poly = poly.reverse(); // accept either winding
          const m0 = keep(Manifold.extrude([poly], h, twist ? 16 : 0, twist, st, A.center === true));
          // Manifold extrudes (u, v) along +w. Map (u, v, w) → world:
          //   y: (u, w, v)   z: (u, v, w)   x: (w, v, u)
          const M: Record<string, number[]> = {
            y: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
            z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            x: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
          };
          const m = keep(keep(m0.transform(M[axis])).translate(V('at', [0, 0, 0])));
          out = original(m, node.part ?? id, id);
          break;
        }
        case 'revolve': {
          // profile: [[radius,y],…] — a lathe around the vertical axis through "at".
          let prof = profile('profile', 3);
          if (prof.some(([r]) => r < 0)) throw new Error('revolve profile radii must be ≥ 0');
          let area = 0;
          for (let i = 0; i < prof.length; i++) { const [a, b] = prof[i], [c, d] = prof[(i + 1) % prof.length]; area += a * d - c * b; }
          if (Math.abs(area) < 1e-12) throw new Error('revolve profile has zero area');
          if (area < 0) prof = prof.reverse();
          // lathe surfaces are big, smooth and often glossy: twice the usual segments so glaze doesn't show facets
          const m0 = keep(Manifold.revolve([prof], P('segments', SEGMENTS * 2), P('degrees', 360)));
          const m = keep(keep(m0.rotate([-90, 0, 0])).translate(V('at', [0, 0, 0])));
          out = original(m, node.part ?? id, id);
          break;
        }
        case 'round': {
          // Minkowski sum with a sphere: rounds every convex edge by r (and grows the shape by r).
          need(1);
          const r = P('r');
          if (!(r > 0)) throw new Error('round needs r > 0');
          if (ins[0].m.numTri() > 20000) throw new Error('round input is too dense (> 20k triangles) — round the primitive before combining');
          const sph = keep(Manifold.sphere(r, P('segments', 16)));
          out = original(keep(ins[0].m.minkowskiSum(sph)), node.part ?? firstPartName(ins[0], id), id);
          break;
        }
        case 'smooth': {
          // Subdivision-style smoothing: tangents from sharp-angle detection, then refine.
          need(1);
          const levels = Math.round(P('levels', 2));
          if (levels < 1 || levels > 4) throw new Error('smooth levels must be 1..4');
          const sm = keep(ins[0].m.smoothOut(P('sharpAngle', 60), P('smoothness', 0)));
          out = original(keep(sm.refine(2 ** levels)), node.part ?? firstPartName(ins[0], id), id);
          break;
        }
        case 'trim': {
          // Keep everything on the positive side of a plane. Default: cut flat at the floor (y = at).
          need(1);
          const n = V('normal', [0, 1, 0]);
          const L = Math.hypot(n[0], n[1], n[2]);
          if (!(L > 0)) throw new Error('trim normal must be non-zero');
          out = { m: keep(ins[0].m.trimByPlane([n[0] / L, n[1] / L, n[2] / L], P('offset', 0))), parts: withOp(ins[0].parts, id) };
          break;
        }
        case 'translate': need(1); out = { m: keep(ins[0].m.translate(V('by'))), parts: withOp(ins[0].parts, id) }; break;
        case 'rotate': {
          need(1);
          const deg = V('deg');
          let m = ins[0].m;
          if (A.about !== undefined) {
            const p = V('about');
            m = keep(m.translate([-p[0], -p[1], -p[2]]));
            m = keep(m.rotate(deg));
            m = keep(m.translate(p));
          } else m = keep(m.rotate(deg));
          out = { m, parts: withOp(ins[0].parts, id) };
          break;
        }
        case 'scale': {
          need(1);
          const by = Array.isArray(A.by) ? V('by') : P('by');
          out = { m: keep(ins[0].m.scale(by)), parts: withOp(ins[0].parts, id) };
          break;
        }
        case 'mirror': {
          need(1);
          const mirrored = keep(keep(ins[0].m.mirror(V('normal'))).asOriginal());
          const base = firstPartName(ins[0], id);
          const parts = new Map(withOp(ins[0].parts, id));
          parts.set(mirrored.originalID(), { name: `${node.part ?? base}#mirror`, ops: new Set([id]) });
          out = A.keep === false
            ? { m: mirrored, parts: new Map([[mirrored.originalID(), parts.get(mirrored.originalID())!]]) }
            : { m: keep(Manifold.union([ins[0].m, mirrored])), parts };
          break;
        }
        case 'union': {
          need(1);
          const parts = new Map<number, Part>();
          ins.forEach((v) => v.parts.forEach((p, k) => parts.set(k, p)));
          out = { m: ins.length === 1 ? ins[0].m : keep(Manifold.union(ins.map((v) => v.m))), parts };
          break;
        }
        case 'difference':
        case 'intersect': {
          need(2);
          const parts = new Map<number, Part>();
          // Faces left by cutters are named "~cutter" so views/legends can hide them.
          ins.forEach((v, i) => v.parts.forEach((p, k) => parts.set(k, node.op === 'difference' && i > 0 && !p.name.startsWith('~') ? { name: `~${p.name}`, ops: p.ops } : p)));
          const fn = node.op === 'difference' ? Manifold.difference : Manifold.intersection;
          out = { m: keep(fn(ins.map((v) => v.m))), parts };
          break;
        }
        case 'hull': {
          need(1);
          out = original(keep(Manifold.hull(ins.map((v) => v.m))), node.part ?? id, id);
          break;
        }
        case 'placeAt': {
          need(1);
          const target = String(A.target ?? '');
          if (!target) throw new Error('placeAt needs args.target (an op id)');
          const tb = boxOf(ev(target).m);
          const anchor = String(A.anchor ?? 'corners:bottom');
          const pts = anchorPoints(tb, anchor, P('inset', 0));
          const align = String(A.align ?? (anchor.endsWith(':bottom') ? 'top' : 'bottom'));
          const ib = boxOf(ins[0].m);
          const ay = align === 'top' ? ib.max[1] : align === 'bottom' ? ib.min[1] : (ib.min[1] + ib.max[1]) / 2;
          const ac: V3 = [(ib.min[0] + ib.max[0]) / 2, ay, (ib.min[2] + ib.max[2]) / 2];
          const splay = P('splay', 0);
          const tc: V3 = [(tb.min[0] + tb.max[0]) / 2, 0, (tb.min[2] + tb.max[2]) / 2];
          const base = node.part ?? firstPartName(ins[0], id);
          const parts = new Map<number, Part>();
          const inst = pts.map((p, i) => {
            let m = keep(ins[0].m.translate([p[0] - ac[0], p[1] - ac[1], p[2] - ac[2]]));
            if (splay !== 0) {
              const dx = p[0] - tc[0], dz = p[2] - tc[2];
              const L = Math.hypot(dx, dz);
              if (L > 1e-9) m = keep(m.transform(rotationAbout(p, [-dz / L, 0, dx / L], splay)));
            }
            const o = keep(m.asOriginal());
            parts.set(o.originalID(), { name: `${base}#${i + 1}`, ops: new Set([id, ...[...ins[0].parts.values()].flatMap((q) => [...q.ops])]) });
            return o;
          });
          out = { m: inst.length === 1 ? inst[0] : keep(Manifold.union(inst)), parts };
          break;
        }
        case 'array': {
          need(1);
          const count = Math.round(P('count'));
          if (count < 1 || count > 500) throw new Error('array count must be 1..500');
          const step = V('step');
          const base = node.part ?? firstPartName(ins[0], id);
          const parts = new Map<number, Part>();
          const inst = Array.from({ length: count }, (_, i) => {
            const o = keep(keep(ins[0].m.translate([step[0] * i, step[1] * i, step[2] * i])).asOriginal());
            parts.set(o.originalID(), { name: `${base}#${i + 1}`, ops: new Set([id, ...[...ins[0].parts.values()].flatMap((q) => [...q.ops])]) });
            return o;
          });
          out = { m: inst.length === 1 ? inst[0] : keep(Manifold.union(inst)), parts };
          break;
        }
        case 'collision': {
          // A simple physics shape fitted to its input: box | hull | capsule | sphere (object space).
          need(1);
          const shape = String(A.shape ?? 'hull');
          const b = boxOf(ins[0].m);
          const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
          const size: V3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
          const pad = P('padding', 0);
          let m: any;
          if (shape === 'box') {
            const sz = size.map((v) => v + 2 * pad) as V3;
            m = keep(Manifold.cube(sz, true)).translate(c);
            collisionInfo = { shape: 'box', center: c, size: sz };
          } else if (shape === 'hull') {
            m = Manifold.hull([ins[0].m]);
            collisionInfo = { shape: 'hull', center: c, size };
          } else if (shape === 'sphere' || shape === 'capsule') {
            const verts = ins[0].m.getMesh();
            const np = verts.numProp, vp: Float32Array = verts.vertProperties;
            const ax = shape === 'capsule' ? String(A.axis ?? (['x', 'y', 'z'][size.indexOf(Math.max(...size))])) as 'x' | 'y' | 'z' : 'y';
            const k = ax === 'x' ? 0 : ax === 'y' ? 1 : 2;
            let r = 0;
            for (let i = 0; i < vp.length; i += np) {
              const d = shape === 'sphere'
                ? Math.hypot(vp[i] - c[0], vp[i + 1] - c[1], vp[i + 2] - c[2])
                : Math.hypot(...[0, 1, 2].filter((j) => j !== k).map((j) => vp[i + j] - c[j]));
              if (d > r) r = d;
            }
            r += pad;
            const seg = P('segments', 24);
            if (shape === 'sphere') {
              m = keep(Manifold.sphere(r, seg)).translate(c);
              collisionInfo = { shape: 'sphere', center: c, radius: r };
            } else {
              // capsule: end caps sit so the whole input fits between them
              const half = Math.max(0, size[k] / 2 + pad - r);
              const a = [...c] as V3, z = [...c] as V3;
              a[k] -= half; z[k] += half;
              m = half > 0 ? Manifold.hull([keep(keep(Manifold.sphere(r, seg)).translate(a)), keep(keep(Manifold.sphere(r, seg)).translate(z))]) : keep(Manifold.sphere(r, seg)).translate(c);
              collisionInfo = { shape: 'capsule', center: c, radius: r, height: 2 * (half + r), axis: ax };
            }
          } else throw new Error('collision shape must be box | hull | capsule | sphere');
          out = original(keep(m), node.part ?? 'collision', id);
          break;
        }
        case 'lod': {
          // A simplified copy for distance: ratio = target share of the input's triangles (0.05–0.95).
          need(1);
          const ratio = P('ratio', 0.5);
          if (!(ratio > 0 && ratio < 1)) throw new Error('lod ratio must be between 0 and 1 (e.g. 0.5 = half the triangles)');
          const src = ins[0].m;
          const target = Math.max(4, Math.floor(src.numTri() * ratio));
          const b = boxOf(src);
          const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
          // binary search the smallest tolerance that reaches the target triangle count
          let lo = 0, hi = diag * 0.2, best: any = null;
          for (let i = 0; i < 14; i++) {
            const mid = (lo + hi) / 2;
            const cand = keep(src.simplify(mid));
            if (cand.numTri() <= target) { best = cand; hi = mid; } else lo = mid;
          }
          if (!best) best = keep(src.simplify(hi));
          out = { m: best, parts: withOp(ins[0].parts, id) };
          break;
        }
        default:
          throw new Error(`unknown op "${(node as OpNode).op}"`);
      }
    } catch (e: any) {
      if (!e.op) e.op = id;
      throw e;
    } finally {
      visiting.delete(id);
    }
    cache.set(id, out);
    return out;
  };

  try {
    if (!root) return empty({ ok: true, status: 'NoOutput' });
    const res = ev(root);
    const status: string = res.m.status();
    const mesh = res.m.getMesh();
    const np = mesh.numProp;
    const nv = mesh.vertProperties.length / np;
    const positions = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = mesh.vertProperties[i * np + k];
    placeVerts(positions, obj);
    const indices = new Uint32Array(mesh.triVerts);
    const partMap = new Map<string, PartInfo>();
    const runIndex: Uint32Array = mesh.runIndex, runId: Uint32Array = mesh.runOriginalID;
    // Label every triangle with its part. Faces a cut creates (trim caps, the flat feet of trimmed
    // legs) belong to no input part; give each to the part it touches, so a metal leg keeps a metal
    // foot instead of taking the object's main material. Only faces touching nothing stay "~cut".
    const nTri = indices.length / 3;
    const infos: Array<{ name: string; ops: Set<string> }> = [];
    const triLabel = new Int32Array(nTri).fill(-1);
    for (let r = 0; r < runId.length; r++) {
      const info = res.parts.get(runId[r]);
      if (!info) continue;
      let li = infos.indexOf(info);
      if (li < 0) { infos.push(info); li = infos.length - 1; }
      for (let t = runIndex[r] / 3; t < runIndex[r + 1] / 3; t++) triLabel[t] = li;
    }
    const vertLabel = new Int32Array(nv).fill(-1);
    for (let t = 0; t < nTri; t++) if (triLabel[t] >= 0) for (let k = 0; k < 3; k++) if (vertLabel[indices[t * 3 + k]] < 0) vertLabel[indices[t * 3 + k]] = triLabel[t];
    for (let pass = 0, changed = true; changed && pass < 64; pass++) {
      changed = false;
      for (let t = 0; t < nTri; t++) {
        if (triLabel[t] >= 0) continue;
        for (let k = 0; k < 3; k++) {
          const l = vertLabel[indices[t * 3 + k]];
          if (l >= 0) { triLabel[t] = l; changed = true; break; }
        }
        if (triLabel[t] >= 0) for (let k = 0; k < 3; k++) if (vertLabel[indices[t * 3 + k]] < 0) vertLabel[indices[t * 3 + k]] = triLabel[t];
      }
    }
    const cut = { name: '~cut', ops: new Set<string>() };
    for (let t = 0; t < nTri; ) {
      let e = t + 1;
      while (e < nTri && triLabel[e] === triLabel[t]) e++;
      const info = triLabel[t] >= 0 ? infos[triLabel[t]] : cut;
      let p = partMap.get(info.name);
      if (!p) {
        p = { name: info.name, ranges: [], bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, ops: [...info.ops] };
        partMap.set(info.name, p);
      }
      p.ranges.push([t, e - t]);
      for (let i = t * 3; i < e * 3; i++) {
        const v = indices[i];
        for (let k = 0; k < 3; k++) {
          const c = positions[v * 3 + k];
          if (c < p.bbox.min[k]) p.bbox.min[k] = c;
          if (c > p.bbox.max[k]) p.bbox.max[k] = c;
        }
      }
      t = e;
    }
    const comps = res.m.decompose();
    const components = comps.length;
    comps.forEach((c: any) => c.delete());
    const b = res.m.isEmpty() ? null : boundsOf(positions);
    return {
      ok: status === 'NoError' && !res.m.isEmpty(),
      error: res.m.isEmpty() ? 'result is empty (did a difference remove everything?)' : status !== 'NoError' ? status : undefined,
      positions, indices,
      parts: [...partMap.values()].sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true })),
      bbox: b, status, components,
      volume: res.m.volume(), genus: res.m.genus(), triangles: indices.length / 3,
      unusedOps: unused(),
      ...(collisionInfo ? { collision: collisionInfo } : {}),
    };
  } catch (e: any) {
    if (e instanceof NotManifold) {
      const positions = new Float32Array(e.raw.positions);
      placeVerts(positions, obj);
      const b = boundsOf(positions);
      const n = e.raw.indices.length / 3;
      return {
        ok: true, positions, indices: e.raw.indices, bbox: b, status: 'NotManifold', components: 0, volume: 0, genus: 0,
        triangles: n, parts: [{ name: e.part, ranges: [[0, n]], bbox: b, ops: [obj.output!] }], unusedOps: [], manifold: false,
      };
    }
    return empty({ error: e.message ?? String(e), errorOp: e.op, status: 'Error' });
  } finally {
    for (const m of made) { try { m.delete(); } catch { /* already freed */ } }
  }
}

/**
 * Smooth a closed polygon profile with a centripetal Catmull-Rom spline through its points.
 * Points where the outline turns more than `cornerDeg` stay sharp (a vase's lip and base), and
 * segments lying on the axis (both ends at a = 0) stay straight.
 */
export function curveProfile(pts: Array<[number, number]>, cornerDeg = 55, sub = 10, lathe = false): Array<[number, number]> {
  const n = pts.length;
  if (n < 3) return pts;
  const turn = (i: number) => {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
    if (!lu || !lv) return 180;
    return (Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)))) * 180) / Math.PI;
  };
  const corner = pts.map((p, i) => turn(i) > cornerDeg || (lathe && p[0] === 0));
  if (!corner.some(Boolean)) corner[0] = true;
  const start = corner.indexOf(true);
  const out: Array<[number, number]> = [];
  // walk chains corner → corner
  let i = start;
  do {
    let j = (i + 1) % n;
    const chain = [pts[i]];
    while (!corner[j]) { chain.push(pts[j]); j = (j + 1) % n; }
    chain.push(pts[j]);
    const onAxis = lathe && chain.length === 2 && chain[0][0] === 0 && chain[1][0] === 0;
    if (chain.length === 2 || onAxis) out.push(chain[0]);
    else {
      const P = [[2 * chain[0][0] - chain[1][0], 2 * chain[0][1] - chain[1][1]], ...chain, [2 * chain[chain.length - 1][0] - chain[chain.length - 2][0], 2 * chain[chain.length - 1][1] - chain[chain.length - 2][1]]];
      for (let s = 1; s < P.length - 2; s++) {
        const [p0, p1, p2, p3] = [P[s - 1], P[s], P[s + 1], P[s + 2]];
        const d = (a: number[], b: number[]) => Math.max(1e-9, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
        const t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
        for (let q = 0; q < sub; q++) {
          const t = t1 + ((t2 - t1) * q) / sub;
          const L = (a: number[], b: number[], ta: number, tb: number) => [((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta), ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)];
          const A1 = L(p0, p1, 0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
          const B1 = L(A1, A2, 0, t2), B2 = L(A2, A3, t1, t3);
          const C = L(B1, B2, t1, t2);
          out.push([lathe ? Math.max(0, C[0]) : C[0], C[1]]);
        }
      }
    }
    i = j;
  } while (i !== start);
  return out;
}

/** Object transform: rotate about Y (degrees) around the object's origin, then move to its position. */
function placeVerts(p: Float32Array, obj: Pick<SceneObject, 'position' | 'rotation'>) {
  const [ox, oy, oz] = obj.position;
  const t = ((obj.rotation ?? 0) * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], z = p[i + 2];
    p[i] = (t ? c * x + s * z : x) + ox;
    p[i + 1] += oy;
    p[i + 2] = (t ? -s * x + c * z : z) + oz;
  }
}

function boundsOf(p: Float32Array): BBox {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}

/** Volume shared by two evaluated objects (world space), in m³. 0 when they only touch. */
export function overlapVolume(a: EvalResult, b: EvalResult): number {
  if (!wasm || !a.ok || !b.ok || a.manifold === false || b.manifold === false || !a.bbox || !b.bbox) return 0;
  for (let k = 0; k < 3; k++) if (a.bbox.max[k] <= b.bbox.min[k] || b.bbox.max[k] <= a.bbox.min[k]) return 0;
  const made: any[] = [];
  try {
    const mk = (r: EvalResult) => { const m = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: r.positions, triVerts: r.indices })); made.push(m); return m; };
    const i = wasm.Manifold.intersection(mk(a), mk(b));
    made.push(i);
    return Math.max(0, i.volume());
  } catch { return 0; } finally { for (const m of made) { try { m.delete(); } catch { /* freed */ } } }
}

/**
 * How well `top` rests on `base`: the share of top's lowest vertices that sit over an upward-facing
 * triangle of base at the same height (within tol), plus the vertical gap between them.
 */
export function supportOf(top: EvalResult, base: EvalResult, tol = 0.002): { fraction: number; gap: number; samples: number } {
  if (!top.bbox || !base.bbox) return { fraction: 0, gap: Infinity, samples: 0 };
  const y0 = top.bbox.min[1];
  const bottom: number[] = [];
  for (let i = 0; i < top.positions.length; i += 3) if (top.positions[i + 1] - y0 < 0.001) bottom.push(i);
  const step = Math.max(1, Math.floor(bottom.length / 400));
  const pts = bottom.filter((_, k) => k % step === 0).map((i) => [top.positions[i], top.positions[i + 2]]);
  const P = base.positions, I = base.indices;
  const tris: number[][] = [];
  let bestGap = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ny = (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]);
    if (ny <= 0) continue; // must face up
    const ymax = Math.max(P[a + 1], P[b + 1], P[c + 1]), ymin = Math.min(P[a + 1], P[b + 1], P[c + 1]);
    const g = y0 - ymax;
    if (Math.abs(g) < Math.abs(bestGap)) bestGap = g;
    if (ymin > y0 + tol || ymax < y0 - tol) continue;
    tris.push([P[a], P[a + 2], P[b], P[b + 2], P[c], P[c + 2]]);
  }
  const inside = (x: number, z: number, t: number[]) => {
    const d = (x1: number, z1: number, x2: number, z2: number) => (x - x2) * (z1 - z2) - (x1 - x2) * (z - z2);
    const d1 = d(t[0], t[1], t[2], t[3]), d2 = d(t[2], t[3], t[4], t[5]), d3 = d(t[4], t[5], t[0], t[1]);
    const eps = 1e-9;
    return !((d1 < -eps || d2 < -eps || d3 < -eps) && (d1 > eps || d2 > eps || d3 > eps));
  };
  let ok = 0;
  for (const [x, z] of pts) if (tris.some((t) => inside(x, z, t))) ok++;
  return { fraction: pts.length ? ok / pts.length : 0, gap: bestGap, samples: pts.length };
}
