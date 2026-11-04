// Game export (Decisions 12, 15, 17): `studio export --target godot|web`.
//   1. unwrap every textured part with xatlas (skipped when a shape brings its own UVs)
//   2. ask a Baker (the browser view) to paint each part's material — colour, wood grain,
//      roughness, metalness — into ONE texture pair per asset, lighting-free, islands dilated
//   3. measure the unwrap (texel density evenness, island padding, stretch)
//   4. write GLB: baked material(s), creased normals, collision nodes, distance versions
//   5. validate with the Khronos glTF validator (errors fail the export)
// Node-only (xatlas and the validator load lazily through createRequire).
import { createRequire } from 'node:module';
import type { EvalResult, CollisionInfo } from './kernel.ts';
import type { Material, SceneObject } from './types.ts';
import { materialForPart } from './materials.ts';
import { budgetFor, materialGroups, type MaterialGroup } from './profiles.ts';
import { gltfMaterial } from './export.ts';
import { GlbBuilder } from './glb.ts';
import { addCharacterNodes, addSkin, attachHeldProps, cornerVerts, rigAttributes, type SkinInfo } from './skinexport.ts';

type V3 = [number, number, number];
export type Target = 'godot' | 'web';

export interface BakePart {
  name: string;
  material: Material;
  bbox: { min: V3; max: V3 };      // the part's world bbox (drives the grain direction, as in the view)
  positions: Float32Array;         // world space, 3 floats per triangle corner (non-indexed)
  uvs: Float32Array;               // 2 floats per corner, 0..1, v down (glTF convention)
}
export interface BakeRequest { size: number; padding: number; parts: BakePart[] }
export interface BakeResult { baseColor: Uint8Array; metallicRoughness: Uint8Array }
/** Paints parts into textures. The daemon's baker asks the open browser view. */
export type Baker = (req: BakeRequest) => Promise<BakeResult>;

export interface UvReport {
  texture: number;                 // px
  texelsPerMetre: number;          // area-weighted mean
  densitySpread: number;           // p90 / p10 of per-triangle density (1 = perfectly even)
  stretchP95: number;              // per-triangle max/min singular value, 95th percentile (1 = none)
  stretchP99: number;
  padding: number;                 // requested px between islands
  paddingViolations: number;       // pixels closer than that to another island
  islands: number;
  utilisation: number;             // share of the texture covered by islands
  checks: Array<{ label: string; pass: boolean; detail: string }>;
}

export interface GameExportItem { obj: SceneObject; res: EvalResult }
export interface GameExportOpts {
  target: Target;
  baker: Baker | null;             // null = no bake (flat per-part materials, no textures)
  evaluateOp: (obj: SceneObject, opId: string) => EvalResult;
  texture?: number;                // px; default from the object's profile (else 1024)
}
export interface ObjectReport {
  object: string; name: string; triangles: number; materials: string[];
  uv?: UvReport; collision: Array<{ op: string; shape: string; node: string }>; lods: Array<{ op: string; triangles: number }>;
  baked: boolean;
  rig?: { bones: number; shapes: number; clips: number };
}
export interface GameExportResult { glb: Uint8Array; objects: ObjectReport[] }

// ── xatlas ─────────────────────────────────────────────────────────────
let xatlasApi: any = null;
async function xatlas(): Promise<any> {
  if (xatlasApi) return xatlasApi;
  const require = createRequire(import.meta.url);
  const create = require('xatlasjs/dist/node/xatlas.js');
  const { Api } = await import('xatlasjs/dist/node/api.mjs' as string);
  const A = Api(create.default ?? create);
  xatlasApi = await new Promise((res) => { const a = new A(() => res(a)); });
  return xatlasApi;
}

interface Chunk { name: string; obj: SceneObject; tris: number[]; res: EvalResult; lod?: string }
interface Unwrapped { chunk: Chunk; corners: Float32Array; uvs: Float32Array; normals: Float32Array; chartOf: Int32Array }

/** Creased normals (35°, area-weighted) per triangle corner, from the indexed result. */
export function creasedNormals(res: EvalResult, tris: number[], creaseDeg = 35): Float32Array {
  const P = res.positions, I = res.indices;
  const nt = I.length / 3;
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    fn[t * 3] = uy * vz - uz * vy; fn[t * 3 + 1] = uz * vx - ux * vz; fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  // faces around each vertex (manifold output shares vertices between faces)
  const nv = P.length / 3;
  const count = new Uint32Array(nv + 1);
  for (let i = 0; i < I.length; i++) count[I[i] + 1]++;
  for (let v = 0; v < nv; v++) count[v + 1] += count[v];
  const faces = new Uint32Array(I.length);
  const fill = count.slice(0, nv);
  for (let i = 0; i < I.length; i++) faces[fill[I[i]]++] = (i / 3) | 0;
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  const unit = (t: number) => { const x = fn[t * 3], y = fn[t * 3 + 1], z = fn[t * 3 + 2]; const l = Math.hypot(x, y, z); return l > 1e-20 ? [x / l, y / l, z / l] : [0, 1, 0]; };
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, k) => {
    const nT = unit(t);
    for (let corner = 0; corner < 3; corner++) {
      const v = I[t * 3 + corner];
      let x = 0, y = 0, z = 0;
      for (let j = count[v]; j < count[v + 1]; j++) {
        const f = faces[j];
        const nF = unit(f);
        if (nF[0] * nT[0] + nF[1] * nT[1] + nF[2] * nT[2] >= cos) { x += fn[f * 3]; y += fn[f * 3 + 1]; z += fn[f * 3 + 2]; }
      }
      const l = Math.hypot(x, y, z);
      out.set(l > 1e-20 ? [x / l, y / l, z / l] : nT, (k * 3 + corner) * 3);
    }
  });
  return out;
}

/** Unwrap chunks into one square atlas. Chunks whose result carries UVs keep them. */
async function unwrap(chunks: Chunk[], size: number, padding: number): Promise<Unwrapped[]> {
  const out: Unwrapped[] = new Array(chunks.length);
  const todo: number[] = [];
  chunks.forEach((ch, i) => {
    const uv = ch.res.uvs;
    if (uv) {
      const n = ch.tris.length * 3;
      const corners = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
      ch.tris.forEach((t, k) => { for (let c = 0; c < 3; c++) { const v = ch.res.indices[t * 3 + c]; corners.set(ch.res.positions.subarray(v * 3, v * 3 + 3), (k * 3 + c) * 3); uvs.set(uv.subarray(v * 2, v * 2 + 2), (k * 3 + c) * 2); } });
      out[i] = { chunk: ch, corners, uvs, normals: creasedNormals(ch.res, ch.tris), chartOf: chartsFromUvs(uvs) };
    } else todo.push(i);
  });
  if (!todo.length) return out;
  const api = await xatlas();
  let texelsPerUnit = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    api.createAtlas();
    const locals: Array<{ map: number[] }> = [];
    for (const i of todo) {
      const ch = chunks[i];
      const map: number[] = [], back = new Map<number, number>();
      const idx = new Uint16Array(ch.tris.length * 3);
      ch.tris.forEach((t, k) => {
        for (let c = 0; c < 3; c++) {
          const v = ch.res.indices[t * 3 + c];
          let l = back.get(v);
          if (l === undefined) { l = map.length; back.set(v, l); map.push(v); }
          idx[k * 3 + c] = l;
        }
      });
      if (map.length > 65000) { api.destroyAtlas(); throw new Error(`part "${ch.name}" has ${map.length} vertices; the unwrapper takes up to 65,000 per part — lower its segments or add a lod`); }
      const verts = new Float32Array(map.length * 3);
      map.forEach((v, l) => verts.set(ch.res.positions.subarray(v * 3, v * 3 + 3), l * 3));
      if (!api.addMesh(idx, verts)) { api.destroyAtlas(); throw new Error(`unwrap failed for part "${ch.name}"`); }
      locals.push({ map });
    }
    const at = api.generateAtlas({}, { padding, resolution: size, texelsPerUnit, bilinear: true, blockAlign: false, rotateCharts: true });
    if (at.atlasCount > 1) { texelsPerUnit = (at.texelsPerUnit || texelsPerUnit || 1) * 0.85; api.destroyAtlas(); continue; }
    const S = Math.max(at.width, at.height);
    at.meshes.forEach((m: any, j: number) => {
      const i = todo[j], ch = chunks[i];
      const n = m.index.length;
      if (n !== ch.tris.length * 3) throw new Error(`unwrap changed the triangle count of "${ch.name}"`);
      const corners = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
      for (let k = 0; k < n; k++) {
        const nvx = m.index[k];
        corners.set(m.vertex.vertices.subarray(nvx * 3, nvx * 3 + 3), k * 3);
        // xatlas normalises u by atlas width and v by height: rescale to a square texture
        uvs[k * 2] = (m.vertex.coords1[nvx * 2] * at.width) / S;
        uvs[k * 2 + 1] = (m.vertex.coords1[nvx * 2 + 1] * at.height) / S;
      }
      out[i] = { chunk: ch, corners, uvs, normals: creasedNormals(ch.res, ch.tris), chartOf: chartsFromIndex(m.index, n) };
    });
    api.destroyAtlas();
    return out;
  }
  throw new Error('could not fit the unwrap into one texture — raise --texture or simplify the shape');
}

/** Chart (island) id per triangle: triangles sharing an unwrapped vertex belong to one chart. */
function chartsFromIndex(index: ArrayLike<number>, n: number): Int32Array {
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r)! !== r) r = parent.get(r)!; let y = x; while (parent.get(y)! !== r) { const nx = parent.get(y)!; parent.set(y, r); y = nx; } return r; };
  for (let k = 0; k < n; k++) if (!parent.has(index[k])) parent.set(index[k], index[k]);
  for (let t = 0; t < n / 3; t++) { const a = find(index[t * 3]); for (let c = 1; c < 3; c++) { const b = find(index[t * 3 + c]); if (a !== b) parent.set(b, a); } }
  const ids = new Int32Array(n / 3);
  for (let t = 0; t < n / 3; t++) ids[t] = find(index[t * 3]);
  return ids;
}
function chartsFromUvs(uvs: Float32Array): Int32Array {
  const key = new Map<string, number>(); const idx: number[] = [];
  for (let k = 0; k < uvs.length / 2; k++) { const s = `${uvs[k * 2].toFixed(5)},${uvs[k * 2 + 1].toFixed(5)}`; let v = key.get(s); if (v === undefined) { v = key.size; key.set(s, v); } idx.push(v); }
  return chartsFromIndex(idx, idx.length);
}

/** Texel density, stretch and island padding for the unwrapped chunks at the final texture size. */
export function measureUv(list: Unwrapped[], size: number, padding: number): UvReport {
  const dens: Array<[number, number]> = [], stretch: number[] = [];
  let covered = 0, worldArea = 0, texArea = 0;
  for (const u of list) {
    const n = u.corners.length / 9;
    for (let t = 0; t < n; t++) {
      const p = (c: number) => [u.corners[(t * 3 + c) * 3], u.corners[(t * 3 + c) * 3 + 1], u.corners[(t * 3 + c) * 3 + 2]];
      const q = (c: number) => [u.uvs[(t * 3 + c) * 2] * size, u.uvs[(t * 3 + c) * 2 + 1] * size];
      const [a, b, c] = [p(0), p(1), p(2)], [A, B, C] = [q(0), q(1), q(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const wa = Math.hypot(cr[0], cr[1], cr[2]) / 2;
      const ta = Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
      if (wa < 1e-12) continue;
      worldArea += wa; texArea += ta;
      dens.push([Math.sqrt(ta / wa), wa]);
      // Jacobian of uv(px) w.r.t. the triangle's own 2D frame → singular value ratio
      const l1 = Math.hypot(e1[0], e1[1], e1[2]);
      const x2 = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1, y2 = (2 * wa) / l1;
      const d1 = [B[0] - A[0], B[1] - A[1]], d2 = [C[0] - A[0], C[1] - A[1]];
      // J * [l1,0]^T = d1, J * [x2,y2]^T = d2
      const j00 = d1[0] / l1, j10 = d1[1] / l1;
      const j01 = (d2[0] - j00 * x2) / y2, j11 = (d2[1] - j10 * x2) / y2;
      const ssq = j00 * j00 + j01 * j01 + j10 * j10 + j11 * j11, det = Math.abs(j00 * j11 - j01 * j10);
      const disc = Math.sqrt(Math.max(0, ssq * ssq / 4 - det * det));
      const smax = Math.sqrt(ssq / 2 + disc), smin = Math.sqrt(Math.max(1e-18, ssq / 2 - disc));
      stretch.push(smin > 1e-9 ? smax / smin : 99);
    }
  }
  const sortedD = dens.map((d) => d[0]).sort((x, y) => x - y);
  const pct = (arr: number[], f: number) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0;
  const spread = sortedD.length ? pct(sortedD, 0.9) / Math.max(1e-9, pct(sortedD, 0.1)) : 1;
  stretch.sort((x, y) => x - y);
  // island padding: rasterise chart ids, then look for another chart within padding-1 px
  const grid = new Int32Array(size * size).fill(-1);
  let chartBase = 0, islands = 0;
  for (const u of list) {
    const ids = u.chartOf;
    const remap = new Map<number, number>();
    const n = u.corners.length / 9;
    for (let t = 0; t < n; t++) {
      let id = remap.get(ids[t]);
      if (id === undefined) { id = chartBase + remap.size; remap.set(ids[t], id); }
      const xs = [0, 1, 2].map((c) => u.uvs[(t * 3 + c) * 2] * size), ys = [0, 1, 2].map((c) => u.uvs[(t * 3 + c) * 2 + 1] * size);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(size - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
      const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
      if (Math.abs(area) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area;
        const w1 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) grid[y * size + x] = id;
      }
    }
    chartBase += remap.size;
    islands += remap.size;
  }
  let violations = 0;
  const r = Math.max(1, padding - 1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const id = grid[y * size + x];
    if (id < 0) continue;
    covered++;
    let bad = false;
    for (let dy = -r; dy <= r && !bad; dy++) for (let dx = -r; dx <= r; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
      const o = grid[Y * size + X];
      if (o >= 0 && o !== id) { bad = true; break; }
    }
    if (bad) violations++;
  }
  const texelsPerMetre = worldArea > 0 ? Math.sqrt(texArea / worldArea) : 0;
  const p95 = pct(stretch, 0.95), p99 = pct(stretch, 0.99);
  const report: UvReport = {
    texture: size, texelsPerMetre: Math.round(texelsPerMetre), densitySpread: +spread.toFixed(2), stretchP95: +p95.toFixed(2), stretchP99: +p99.toFixed(2),
    padding, paddingViolations: violations, islands, utilisation: +(covered / (size * size)).toFixed(3), checks: [],
  };
  report.checks.push({ label: 'Even texel density', pass: spread <= 2, detail: `${report.texelsPerMetre} px/m on average; p90/p10 = ${report.densitySpread}${spread > 2 ? ' — some parts get far fewer pixels than others' : ''}` });
  report.checks.push({ label: 'Islands padded', pass: violations === 0, detail: violations ? `${violations} px closer than ${padding} px to another island (colours would bleed): raise --texture` : `${islands} islands, ≥ ${padding} px apart` });
  report.checks.push({ label: 'No stretched areas', pass: p95 <= 2, detail: `stretch p95 ${report.stretchP95}, p99 ${report.stretchP99} (1 = none)${p95 > 2 ? ' — grain would smear' : ''}` });
  return report;
}

// ── GLB assembly ───────────────────────────────────────────────────────

const concatU = (list: Uint32Array[]) => { const out = new Uint32Array(list.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of list) { out.set(a, o); o += a.length; } return out; };
/** A character's bind pose placed at its position (no rotation: the node carries that), so sub(origin) gives object space. */
function restWorld(res: EvalResult, obj: SceneObject): EvalResult {
  const rest = res.rig!.rest, [ox, oy, oz] = obj.position;
  const positions = new Float32Array(rest.length);
  for (let i = 0; i < rest.length; i += 3) { positions[i] = rest[i] + ox; positions[i + 1] = rest[i + 1] + oy; positions[i + 2] = rest[i + 2] + oz; }
  const parts = res.parts.map((p) => {
    const bbox = { min: [Infinity, Infinity, Infinity] as V3, max: [-Infinity, -Infinity, -Infinity] as V3 };
    for (const [s, n] of p.ranges) for (let i = s * 3; i < (s + n) * 3; i++) { const v = res.indices[i]; for (let k = 0; k < 3; k++) { bbox.min[k] = Math.min(bbox.min[k], positions[v * 3 + k]); bbox.max[k] = Math.max(bbox.max[k], positions[v * 3 + k]); } }
    return { ...p, bbox };
  });
  return { ...res, positions, parts };
}
const sub = (a: Float32Array, [ox, oy, oz]: number[]) => { const r = new Float32Array(a.length); for (let i = 0; i < a.length; i += 3) { r[i] = a[i] - ox; r[i + 1] = a[i + 1] - oy; r[i + 2] = a[i + 2] - oz; } return r; };

function flatCorners(res: EvalResult, tris: number[]): Float32Array {
  const out = new Float32Array(tris.length * 9);
  tris.forEach((t, k) => { for (let c = 0; c < 3; c++) { const v = res.indices[t * 3 + c]; out.set(res.positions.subarray(v * 3, v * 3 + 3), (k * 3 + c) * 3); } });
  return out;
}
const trisOf = (res: EvalResult, parts: string[]) => {
  const set = new Set(parts), tris: number[] = [];
  for (const p of res.parts) if (set.has(p.name)) for (const [s, n] of p.ranges) for (let t = s; t < s + n; t++) tris.push(t);
  return tris;
};

/** Export objects as one game-ready GLB. Throws with a readable message when something can't be made game-ready. */
export async function exportGame(items: GameExportItem[], opts: GameExportOpts): Promise<GameExportResult> {
  const B = new GlbBuilder();
  const reports: ObjectReport[] = [];
  // several characters in one file: their clips are prefixed "<id>:" so names stay unique
  const characterCount = items.filter((i) => i.obj.role !== 'reference' && i.res.ok && i.res.rig).length;
  const charNodes = new Map<string, { obj: SceneObject; res: EvalResult; info: SkinInfo }>();
  const propNodes = new Map<string, number>();
  for (const { obj, res: posedRes } of items) {
    if (obj.role === 'reference' || !posedRes.ok) continue;
    // characters export in their bind pose (T-pose, neutral face); the current pose/face become the "pose" clip
    const res: EvalResult = posedRes.rig ? restWorld(posedRes, obj) : posedRes;
    const budget = obj.profile ? budgetFor(obj.profile) : null;
    const skin = res.rig ? addSkin(B, res, budget ? !budget.fingers : false) : null;
    const size = opts.texture ?? (obj.profile ? budgetFor(obj.profile).texture : 1024);
    const padding = Math.max(2, Math.round(size / 256));
    const origin = obj.position;
    const lodOps = opts.target === 'web' && !res.rig ? obj.opOrder.filter((id) => obj.ops[id]?.op === 'lod') : [];
    const lodRes = lodOps.map((id) => ({ id, res: opts.evaluateOp(obj, id) })).filter((l) => l.res.ok);
    const groups: MaterialGroup[] = opts.baker ? materialGroups(obj, res) : plainGroups(obj, res);
    const report: ObjectReport = { object: obj.id, name: obj.name, triangles: res.triangles, materials: [], collision: [], lods: [], baked: !!opts.baker };

    // 1–2: unwrap textured parts (main mesh + its distance versions share one atlas), bake
    const textured = groups.filter((g) => g.textured && opts.baker);
    const chunks: Chunk[] = [];
    for (const g of textured) for (const name of g.parts) {
      chunks.push({ name, obj, res, tris: trisOf(res, [name]) });
      for (const l of lodRes) if (l.res.parts.some((p) => p.name === name)) chunks.push({ name, obj, res: l.res, tris: trisOf(l.res, [name]), lod: l.id });
    }
    const unwrapped = chunks.length ? await unwrap(chunks.filter((c) => c.tris.length), size, padding) : [];
    let tex: { base: number; mr: number } | null = null;
    if (unwrapped.length && opts.baker) {
      const bboxOf = (name: string) => res.parts.find((p) => p.name === name)!.bbox;
      const baked = await opts.baker({
        size, padding,
        parts: unwrapped.map((u) => ({ name: u.chunk.name, material: materialForPart(obj, u.chunk.name.startsWith('~') ? obj.output ?? '' : u.chunk.name), bbox: bboxOf(u.chunk.name), positions: u.corners, uvs: u.uvs })),
      });
      tex = { base: B.image(baked.baseColor, `${obj.name} base colour`), mr: B.image(baked.metallicRoughness, `${obj.name} roughness-metalness`) };
      report.uv = measureUv(unwrapped.filter((u) => !u.chunk.lod), size, padding);
    }

    // 3–4: primitives per material group, for the main mesh and each distance version
    const matIndex = new Map<string, number>();
    const materialFor = (g: MaterialGroup) => {
      let i = matIndex.get(g.key);
      if (i !== undefined) return i;
      let m: any;
      if (g.textured && tex) {
        m = { name: `${obj.name}${textured.length > 1 ? ` ${g.material.clearcoat ? 'glazed' : 'baked'}` : ''}`, pbrMetallicRoughness: { baseColorTexture: { index: tex.base }, metallicRoughnessTexture: { index: tex.mr }, metallicFactor: 1, roughnessFactor: 1 }, extras: { baked: true, parts: g.parts } };
        if (g.material.clearcoat) { m.extensions = { KHR_materials_clearcoat: { clearcoatFactor: g.material.clearcoat, clearcoatRoughnessFactor: g.material.clearcoatRoughness ?? 0.1 } }; B.used.add('KHR_materials_clearcoat'); }
      } else m = gltfMaterial(g.material, B.used);
      B.gltf.materials.push(m);
      i = B.gltf.materials.length - 1;
      matIndex.set(g.key, i);
      report.materials.push(m.name);
      return i;
    };
    const meshFor = (r: EvalResult, lod?: string) => {
      const prims: any[] = [];
      for (const g of groups) {
        const parts = g.parts.filter((n) => r.parts.some((p) => p.name === n));
        if (!parts.length) continue;
        if (g.textured && tex) {
          const us = unwrapped.filter((u) => u.chunk.lod === lod && parts.includes(u.chunk.name));
          const pos = concat(us.map((u) => sub(u.corners, origin))), nor = concat(us.map((u) => u.normals)), uv = concat(us.map((u) => u.uvs));
          const prim: any = { attributes: { POSITION: B.accessor(pos, 'VEC3', true), NORMAL: B.accessor(nor, 'VEC3'), TEXCOORD_0: B.accessor(uv, 'VEC2') }, material: materialFor(g) };
          if (skin && !lod) { const rg = rigAttributes(B, r, concatU(us.map((u) => cornerVerts(u.chunk.res, u.chunk.tris))), skin, opts.target === 'web'); Object.assign(prim.attributes, rg.attributes); prim.targets = rg.targets; }
          prims.push(prim);
        } else {
          const tris = trisOf(r, parts);
          if (!tris.length) continue;
          const prim: any = { attributes: { POSITION: B.accessor(sub(flatCorners(r, tris), origin), 'VEC3', true), NORMAL: B.accessor(creasedNormals(r, tris), 'VEC3') }, material: materialFor(g) };
          if (skin && !lod) { const rg = rigAttributes(B, r, cornerVerts(r, tris), skin, opts.target === 'web'); Object.assign(prim.attributes, rg.attributes); prim.targets = rg.targets; }
          prims.push(prim);
        }
      }
      B.gltf.meshes.push({ name: lod ? `${obj.name} ${lod}` : obj.name, primitives: prims });
      return B.gltf.meshes.length - 1;
    };
    const extras: any = { semanticType: obj.semanticType, params: Object.fromEntries(Object.entries(obj.params).map(([k, p]) => [k, p.value])), ...(obj.profile ? { profile: obj.profile.name } : {}) };
    let node: any;
    if (skin) {
      const roots = addCharacterNodes(B, obj, res, meshFor(res), skin, { ...extras, character: { bones: skin.kept.length, shapes: skin.shapeNames.length, lines: Object.keys(obj.character?.lines ?? {}), motions: Object.keys(obj.character?.motions ?? {}), ...(characterCount > 1 ? { clipPrefix: `${obj.id}:` } : {}) } }, { clipPrefix: characterCount > 1 ? `${obj.id}:` : '' });
      charNodes.set(obj.id, { obj, res, info: skin });
      node = B.gltf.nodes[roots[0]];
      B.gltf.scenes[0].nodes.push(...roots);
      report.rig = { bones: skin.kept.length, shapes: skin.shapeNames.length, clips: B.gltf.animations?.length ?? 0 };
    } else {
      node = { name: obj.name, mesh: meshFor(res), translation: [...origin], extras };
      propNodes.set(obj.id, B.gltf.nodes.length);
      B.gltf.nodes.push(node);
      B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1);
    }
    // distance versions: MSFT_lod (loaders without it just show the full mesh); not for Godot, which makes its own
    if (lodRes.length) {
      const ids: number[] = [];
      const sorted = [...lodRes].sort((a, b) => b.res.triangles - a.res.triangles);
      for (const l of sorted) {
        B.gltf.nodes.push({ name: `${obj.name}_${l.id}`, mesh: meshFor(l.res, l.id), extras: { lod: { op: l.id, of: obj.name, triangles: l.res.triangles } } });
        ids.push(B.gltf.nodes.length - 1);
        report.lods.push({ op: l.id, triangles: l.res.triangles });
      }
      node.extensions = { MSFT_lod: { ids } };
      node.extras.MSFT_screencoverage = [0.25, ...sorted.map((_, i) => +(0.25 / (2 ** (i + 1))).toFixed(4))].slice(0, ids.length + 1);
      B.used.add('MSFT_lod');
    }
    // collision nodes: Godot reads the -convcolonly suffix (a static body with a convex shape, no visible mesh);
    // three.js loaders see extras.collision (hide the node, build a Rapier collider from it)
    for (const id of obj.opOrder.filter((k) => obj.ops[k]?.op === 'collision')) {
      const cr = opts.evaluateOp(obj, id);
      if (!cr.ok) throw new Error(`collision op "${id}" fails: ${cr.error}`);
      const all = Array.from({ length: cr.indices.length / 3 }, (_, t) => t);
      const pos = sub(flatCorners(cr, all), origin);
      const info: CollisionInfo | undefined = cr.collision;
      const name = opts.target === 'godot' ? `${obj.name}_${id}-convcolonly` : `${obj.name}_${id}`;
      const mesh: any = { name, primitives: [{ attributes: { POSITION: B.accessor(pos, 'VEC3', true) } }] };
      if (opts.target === 'web') {
        B.gltf.materials.push({ name: 'collision (hidden)', pbrMetallicRoughness: { baseColorFactor: [1, 0, 1, 0] }, alphaMode: 'BLEND', extras: { collision: true } });
        mesh.primitives[0].material = B.gltf.materials.length - 1;
      }
      B.gltf.meshes.push(mesh);
      B.gltf.nodes.push({ name, mesh: B.gltf.meshes.length - 1, translation: [...origin], extras: { collision: { op: id, ...(info ?? { shape: 'hull' }), rotationY: obj.rotation ?? 0 } } });
      B.gltf.scenes[0].nodes.push(B.gltf.nodes.length - 1);
      report.collision.push({ op: id, shape: info?.shape ?? 'hull', node: name });
    }
    reports.push(report);
  }
  if (!reports.length) throw new Error('nothing to export (no evaluated, non-reference objects)');
  attachHeldProps(B, items.map((i) => i.obj), charNodes, propNodes);
  return { glb: B.build(), objects: reports };
}

/** Without a bake: one material per distinct part material (like the plain GLB export). */
function plainGroups(obj: SceneObject, res: EvalResult): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();
  for (const p of res.parts) {
    const m = materialForPart(obj, p.name.startsWith('~') ? obj.output ?? '' : p.name);
    const key = 'P' + JSON.stringify(m);
    const g = groups.get(key) ?? { key, textured: false, material: m, parts: [] };
    g.parts.push(p.name);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function concat(arrs: Float32Array[]): Float32Array {
  const out = new Float32Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────
export interface Validation { ok: boolean; errors: number; warnings: number; messages: Array<{ severity: string; code: string; message: string; pointer?: string }> }
let validator: any = null;
/** Khronos glTF validator. Errors fail an export; warnings are reported. */
export async function validateGlb(glb: Uint8Array): Promise<Validation> {
  if (!validator) validator = createRequire(import.meta.url)('gltf-validator');
  const rep = await validator.validateBytes(glb, { maxIssues: 50, ignoredIssues: ['UNSUPPORTED_EXTENSION'] });
  const sev = ['error', 'warning', 'info', 'hint'];
  return {
    ok: rep.issues.numErrors === 0, errors: rep.issues.numErrors, warnings: rep.issues.numWarnings,
    messages: rep.issues.messages.filter((m: any) => m.severity <= 1).map((m: any) => ({ severity: sev[m.severity], code: m.code, message: m.message, ...(m.pointer ? { pointer: m.pointer } : {}) })),
  };
}

// ── after-export hooks (week 2 plugs the engine round-trip in here) ─────
export interface AfterExportCtx { file: string; target: Target | null; glb: Uint8Array; objects: string[] }
export type AfterExportHook = (ctx: AfterExportCtx) => Promise<{ name: string; ok: boolean; detail: string } | null>;
export const afterExport: AfterExportHook[] = [];
/** Register a check that runs after every export (e.g. "import it in Godot"). A failing hook fails the export. */
export function onAfterExport(hook: AfterExportHook) { afterExport.push(hook); return () => { const i = afterExport.indexOf(hook); if (i >= 0) afterExport.splice(i, 1); }; }
