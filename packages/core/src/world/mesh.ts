// Town plan → low-poly meshes (flat-shaded triangle soups, one per material) ready for the GLB writer.
// Ground follows the graded heightfield, roads are draped ribbons with raised sidewalks and curbs,
// buildings get walls, roofs from their roof type, parapets, cornices, shopfronts, windows and rooftop
// clutter from their style. Everything is deterministic for a given plan.
import { area, centroid, inset, minRect, pointInPoly, distToPolyline, triangulate, rng, hash32, type P2 } from './geo.ts';
import { groundAt, type Building, type Street, type TownPlan, type Tree, type Area } from './plan.ts';
import { stable, styleFor, type Style } from './styles.ts';

export type V3 = [number, number, number];
export interface Mat { color: string; roughness: number; metalness?: number; name: string }
export interface Soup { mat: Mat; positions: number[]; normals: number[] }
export interface TownNode {
  name: string;
  semanticType: 'ground' | 'roads' | 'water' | 'parks' | 'trees' | 'building' | 'landmark' | 'street-lights';
  at: V3;                                  // node translation (soups are relative to it)
  soups: Soup[];
  extras: Record<string, unknown>;
}
/** A studio model swapped in for a building (landmark), as triangle soups in its own space (origin on the floor). */
export interface ModelMesh { soups: Soup[]; size: V3 }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/** Collects flat-shaded triangles per material, relative to an origin. */
export class SoupBuilder {
  private soups = new Map<string, Soup>();
  origin: V3;
  constructor(origin: V3 = [0, 0, 0]) { this.origin = origin; }
  private soup(m: Mat): Soup {
    const k = `${m.name}|${m.color}|${m.roughness}|${m.metalness ?? 0}`;
    let s = this.soups.get(k);
    if (!s) { s = { mat: m, positions: [], normals: [] }; this.soups.set(k, s); }
    return s;
  }
  /** A triangle; `face` is the direction it should face (the winding is fixed to match). */
  tri(m: Mat, a: V3, b: V3, c: V3, face?: V3) {
    let n = cross(sub(b, a), sub(c, a));
    if (Math.hypot(...n) < 1e-10) return;
    n = nrm(n);
    if (face && n[0] * face[0] + n[1] * face[1] + n[2] * face[2] < 0) { [b, c] = [c, b]; n = [-n[0], -n[1], -n[2]]; }
    const s = this.soup(m), o = this.origin;
    for (const p of [a, b, c]) { s.positions.push(p[0] - o[0], p[1] - o[1], p[2] - o[2]); s.normals.push(n[0], n[1], n[2]); }
  }
  quad(m: Mat, a: V3, b: V3, c: V3, d: V3, face?: V3) { this.tri(m, a, b, c, face); this.tri(m, a, c, d, face); }
  /** A polygon in a horizontal plane (or draped by y(p)). */
  poly(m: Mat, pts: P2[], y: number | ((p: P2) => number), face: V3 = [0, 1, 0]) {
    const idx = triangulate(pts);
    const Y = typeof y === 'number' ? () => y : y;
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]];
      this.tri(m, [a[0], Y(a), a[1]], [b[0], Y(b), b[1]], [c[0], Y(c), c[1]], face);
    }
  }
  /** A vertical wall strip along an edge from y0 to y1, facing `out` (xz). */
  wall(m: Mat, a: P2, b: P2, y0: number, y1: number, out: P2) {
    this.quad(m, [a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [out[0], 0, out[1]]);
  }
  box(m: Mat, c: V3, size: V3, rotY = 0) {
    const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    const cs = Math.cos(rotY), sn = Math.sin(rotY);
    const P = (x: number, y: number, z: number): V3 => [c[0] + x * cs - z * sn, c[1] + y, c[2] + x * sn + z * cs];
    const corners = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), P(-hx, hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), P(-hx, hy, hz)];
    const faces: Array<[number, number, number, number]> = [[4, 5, 6, 7], [0, 1, 2, 3], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    for (const f of faces) {
      const q = f.map((i) => corners[i]);
      const fc: V3 = [q.reduce((s, p) => s + p[0], 0) / 4 - c[0], q.reduce((s, p) => s + p[1], 0) / 4 - c[1], q.reduce((s, p) => s + p[2], 0) / 4 - c[2]];
      this.quad(m, q[0], q[1], q[2], q[3], fc);
    }
  }
  /** An n-sided prism/frustum around a vertical axis (tree trunks, crowns, poles). */
  frustum(m: Mat, c: V3, r0: number, r1: number, h: number, sides = 6, rot = 0, caps = true) {
    for (let i = 0; i < sides; i++) {
      const a0 = rot + (i / sides) * Math.PI * 2, a1 = rot + ((i + 1) / sides) * Math.PI * 2;
      const p = (r: number, a: number, y: number): V3 => [c[0] + Math.cos(a) * r, c[1] + y, c[2] + Math.sin(a) * r];
      const mid = (a0 + a1) / 2;
      const out: V3 = [Math.cos(mid), (r0 - r1) / Math.max(h, 1e-6), Math.sin(mid)];
      if (r1 > 1e-4) this.quad(m, p(r0, a0, 0), p(r0, a1, 0), p(r1, a1, h), p(r1, a0, h), out);
      else this.tri(m, p(r0, a0, 0), p(r0, a1, 0), [c[0], c[1] + h, c[2]], out);
      if (caps && r1 > 1e-4) this.tri(m, [c[0], c[1] + h, c[2]], p(r1, a0, h), p(r1, a1, h), [0, 1, 0]);
      if (caps) this.tri(m, [c[0], c[1], c[2]], p(r0, a0, 0), p(r0, a1, 0), [0, -1, 0]);
    }
  }
  result(): Soup[] { return [...this.soups.values()].filter((s) => s.positions.length); }
  get triangles() { let n = 0; for (const s of this.soups.values()) n += s.positions.length / 9; return n; }
}

const M = (name: string, color: string, roughness = 0.9, metalness = 0): Mat => ({ name, color, roughness, metalness });

/** Outward normal (xz) of the edge a→b of a polygon. */
function outward(poly: P2[], a: P2, b: P2): P2 {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  let n: P2 = [dz / l, -dx / l];
  const mid: P2 = [(a[0] + b[0]) / 2 + n[0] * 0.05, (a[1] + b[1]) / 2 + n[1] * 0.05];
  if (pointInPoly(mid, poly)) n = [-n[0], -n[1]];
  return n;
}

export interface BuildOpts { models?: Record<string, ModelMesh>; detail?: 'full' | 'low' }

/** The whole town as nodes: ground, parks/plazas, water, roads, trees, street lights and one node per building. */
export function townNodes(plan: TownPlan, opts: BuildOpts = {}): TownNode[] {
  const style = styleFor(plan.style);
  const nodes: TownNode[] = [];
  const g = plan.ground;
  const C = style.colors;
  // ground
  {
    const sb = new SoupBuilder();
    const m = M('ground', C.ground, 0.97);
    const P = (i: number, j: number): V3 => [g.x0 + i * g.dx, g.heights[j * g.nx + i], g.z0 + j * g.dz];
    for (let j = 0; j + 1 < g.nz; j++) for (let i = 0; i + 1 < g.nx; i++) sb.quad(m, P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1), [0, 1, 0]);
    // a skirt down the edges so the town reads as a diorama, not a sheet
    const skirt = M('ground edge', shade(C.ground, -0.25), 0.97);
    const low = Math.min(...g.heights) - 3;
    for (let i = 0; i + 1 < g.nx; i++) { sb.quad(skirt, P(i, 0), P(i + 1, 0), [P(i + 1, 0)[0], low, P(i + 1, 0)[2]], [P(i, 0)[0], low, P(i, 0)[2]], [0, 0, -1]); const a = P(i, g.nz - 1), b = P(i + 1, g.nz - 1); sb.quad(skirt, a, b, [b[0], low, b[2]], [a[0], low, a[2]], [0, 0, 1]); }
    for (let j = 0; j + 1 < g.nz; j++) { const a = P(0, j), b = P(0, j + 1); sb.quad(skirt, a, b, [b[0], low, b[2]], [a[0], low, a[2]], [-1, 0, 0]); const c = P(g.nx - 1, j), d = P(g.nx - 1, j + 1); sb.quad(skirt, c, d, [d[0], low, d[2]], [c[0], low, c[2]], [1, 0, 0]); }
    nodes.push({ name: 'Ground', semanticType: 'ground', at: [0, 0, 0], soups: sb.result(), extras: { source: g.source, grid: [g.nx, g.nz] } });
  }
  // parks, plazas, water
  {
    const sb = new SoupBuilder();
    const water = new SoupBuilder();
    for (const a of plan.areas) {
      const poly = a.polygon;
      if (a.kind === 'water' || a.kind === 'river') {
        const level = poly.reduce((s, p) => s + groundAt(g, p[0], p[1]), 0) / poly.length - 0.12;
        water.poly(M('water', C.water, 0.12, 0), poly, level);
      } else {
        const m = a.kind === 'park' ? M('grass', C.park, 0.95) : M('plaza', C.plaza, 0.9);
        sb.poly(m, poly, (p) => groundAt(g, p[0], p[1]) + (a.kind === 'park' ? 0.04 : 0.05));
      }
    }
    if (sb.triangles) nodes.push({ name: 'Parks and plazas', semanticType: 'parks', at: [0, 0, 0], soups: sb.result(), extras: { areas: plan.areas.filter((a) => a.kind !== 'water' && a.kind !== 'river').map((a) => a.id) } });
    if (water.triangles) nodes.push({ name: 'Water', semanticType: 'water', at: [0, 0, 0], soups: water.result(), extras: { areas: plan.areas.filter((a) => a.kind === 'water' || a.kind === 'river').map((a) => a.id) } });
  }
  nodes.push({ name: 'Streets', semanticType: 'roads', at: [0, 0, 0], soups: roads(plan, style).result(), extras: { streets: plan.streets.map((s) => s.id) } });
  if (plan.trees.length) nodes.push({ name: 'Trees', semanticType: 'trees', at: [0, 0, 0], soups: trees(plan, style).result(), extras: { count: plan.trees.length } });
  const lights = streetLights(plan, style);
  if (lights.triangles) nodes.push({ name: 'Street lights', semanticType: 'street-lights', at: [0, 0, 0], soups: lights.result(), extras: {} });
  const names = new Set<string>();
  for (const b of plan.buildings) {
    if (b.hidden) continue;
    const c = centroid(b.footprint);
    const base = b.base ?? groundAt(g, c[0], c[1]);
    let name = `${cap(b.use)} ${b.id.replace(/^[a-z]+:/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`;
    while (names.has(name)) name += 'x';
    names.add(name);
    const extras = { worldId: b.id, ...(b.sourceId ? { sourceId: b.sourceId } : {}), ...(b.lot ? { lot: b.lot } : {}), use: b.use, height: +b.height.toFixed(2), floors: b.floors, roof: b.roof, ...(b.fixes?.length ? { fixes: b.fixes } : {}) };
    if (b.model && opts.models?.[b.model]) {
      const mm = opts.models[b.model];
      const sb = new SoupBuilder([c[0], base, c[1]]);
      const rot = ((b.modelRotation ?? 0) * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
      const y0 = (b.top ?? base) - 0.05;
      for (const s of mm.soups) for (let i = 0; i < s.positions.length; i += 9) {
        const P = (k: number): V3 => { const x = s.positions[i + k], y = s.positions[i + k + 1], z = s.positions[i + k + 2]; return [c[0] + x * cs - z * sn, y0 + y, c[1] + x * sn + z * cs]; };
        const n: V3 = [s.normals[i] * cs - s.normals[i + 2] * sn, s.normals[i + 1], s.normals[i] * sn + s.normals[i + 2] * cs];
        sb.tri(s.mat, P(0), P(3), P(6), n);
      }
      nodes.push({ name: `Landmark ${b.model}`, semanticType: 'landmark', at: [c[0], base, c[1]], soups: sb.result(), extras: { ...extras, model: b.model } });
      continue;
    }
    const sb = new SoupBuilder([c[0], base, c[1]]);
    building(sb, b, plan, style, opts.detail ?? 'full');
    nodes.push({ name, semanticType: 'building', at: [c[0], base, c[1]], soups: sb.result(), extras });
  }
  return nodes;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)));
  return '#' + ch.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
}

// ── buildings ──────────────────────────────────────────────────────────────

function building(sb: SoupBuilder, b: Building, plan: TownPlan, style: Style, detail: 'full' | 'low') {
  const pal = b.palette ?? { wall: '#bdb8ae', trim: '#e5e0d5', roof: '#5a5853', glass: '#2f3b45' };
  const wallM = M('wall', pal.wall, 0.88), trimM = M('trim', pal.trim, 0.8), roofM = M('roof', pal.roof, 0.85);
  const glassM = M('glass', pal.glass, 0.25, 0.1), darkM = M('shadow', shade(pal.wall, -0.55), 0.95);
  const fp = b.footprint, n = fp.length;
  const floor0 = (b.top ?? 0), y0 = (b.base ?? 0) - 0.6, eave = floor0 + b.height;
  const parapet = b.roof === 'flat' && b.use !== 'parking' ? (b.height > 30 ? 1.4 : 0.9) : 0;
  const gf = Math.min(style.groundFloor, b.height * 0.6);
  const fh = b.floors > 1 ? (b.height - gf) / (b.floors - 1) : b.height;
  const tower = b.use === 'tower';
  const r = rng(hash32(b.id));
  // the street side: edges whose middle is closest to a street get the shopfront and the door
  const nearStreet = (a: P2, c: P2) => {
    const m: P2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
    return plan.streets.reduce((d, s) => Math.min(d, distToPolyline(m, s.points) - s.width / 2 - s.sidewalk), Infinity);
  };
  const streetDist = fp.map((a, i) => nearStreet(a, fp[(i + 1) % n]));
  const frontD = Math.min(...streetDist);
  for (let i = 0; i < n; i++) {
    const a = fp[i], c = fp[(i + 1) % n], out = outward(fp, a, c);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    sb.wall(wallM, a, c, y0, eave + parapet, out);
    if (detail === 'low' || len < 2.4) continue;
    const isFront = streetDist[i] < frontD + 6 && streetDist[i] < 18;
    const off = (t: number, o: number, y: number): V3 => [a[0] + (c[0] - a[0]) * t + out[0] * o, y, a[1] + (c[1] - a[1]) * t + out[1] * o];
    const pane = (t0: number, t1: number, yb: number, yt: number, m: Mat, o = 0.06) => sb.quad(m, off(t0, o, yb), off(t1, o, yb), off(t1, o, yt), off(t0, o, yt), [out[0], 0, out[1]]);
    // ground floor: shopfront glass between piers, a sign band and awnings, or a plinth and a door
    if (b.storefront && isFront && b.height > 4) {
      const bays = Math.max(1, Math.round(len / 4.2));
      const awn = M('awning', pal.accent ?? style.colors.awning[Math.floor(stable(b.id, 'awning') * style.colors.awning.length)], 0.8);
      for (let k = 0; k < bays; k++) {
        const t0 = (k + 0.12) / bays, t1 = (k + 0.88) / bays;
        pane(t0, t1, floor0 + 0.45, floor0 + gf * 0.68, glassM);
        if (b.use === 'shop' || b.use === 'hotel' || stable(b.id + k, 'awn') < 0.35) {
          const yA = floor0 + gf * 0.74, depth = 1.25;
          sb.quad(awn, off(t0, 0.08, yA + 0.5), off(t1, 0.08, yA + 0.5), off(t1, depth, yA), off(t0, depth, yA), [out[0], 1, out[1]]);
          sb.quad(awn, off(t0, depth, yA), off(t1, depth, yA), off(t1, depth, yA - 0.3), off(t0, depth, yA - 0.3), [out[0], 0, out[1]]);
        }
      }
      pane(0, 1, floor0 + gf * 0.8, floor0 + gf - 0.15, trimM, 0.12);   // sign band / string course
    } else if (isFront && b.use !== 'parking') {
      const d = 0.5 + r() * 0.0;
      const doorW = Math.min(1.8, len * 0.3) / len;
      pane(d - doorW / 2, d + doorW / 2, floor0, floor0 + Math.min(2.6, gf * 0.7), darkM, 0.05);
      pane(0, 1, floor0 - 0.6, floor0 + 0.5, trimM, 0.05);   // plinth
    }
    // upper floors: windows in bays, curtain-wall bands on towers, open decks on parking garages
    const bayW = tower ? 2.8 : b.use === 'home' || b.use === 'church' ? 3.4 : 3.1;
    const bays = Math.max(1, Math.floor(len / bayW));
    for (let f = 1; f < b.floors; f++) {
      const yb = floor0 + gf + (f - 1) * fh;
      if (b.use === 'parking') { pane(0.02, 0.98, yb + 0.9, yb + fh - 0.35, darkM, 0.04); continue; }
      if (tower) { pane(0.03, 0.97, yb + 0.55, yb + fh - 0.35, glassM, 0.05); continue; }
      const wFrac = b.use === 'office' ? 0.62 : 0.42;
      for (let k = 0; k < bays; k++) {
        const t0 = (k + (1 - wFrac) / 2) / bays, t1 = (k + (1 + wFrac) / 2) / bays;
        pane(t0, t1, yb + 0.85, yb + Math.min(fh - 0.55, 2.4), glassM);
        if (b.use !== 'office') pane(t0 - 0.02 / bays, t1 + 0.02 / bays, yb + 0.7, yb + 0.85, trimM, 0.1);   // sill
      }
    }
    if (b.floors === 1 && !b.storefront && b.use !== 'parking' && len > 5) {
      const k = Math.max(1, Math.floor(len / 4));
      for (let j = 0; j < k; j++) { const t0 = (j + 0.3) / k, t1 = (j + 0.7) / k; if (isFront && Math.abs((t0 + t1) / 2 - 0.5) < 0.15) continue; pane(t0, t1, floor0 + 1.0, floor0 + Math.min(b.height - 0.6, 2.6), glassM); }
    }
  }
  // cornice: a ledge just under the eave (and a crown on towers)
  if (style.cornice && detail === 'full' && b.height > 3.5) {
    const ring = inset(fp, -0.35);
    const yTop = eave + (parapet ? parapet : 0), yBot = yTop - (b.height > 30 ? 0.9 : 0.45);
    for (let i = 0; i < n; i++) { const a = ring[i], c = ring[(i + 1) % n]; sb.wall(trimM, a, c, yBot, yTop, outward(ring, a, c)); }
    // underside and top of the ledge
    for (let i = 0; i < n; i++) {
      const a = ring[i], c = ring[(i + 1) % n], a2 = fp[i], c2 = fp[(i + 1) % n];
      sb.quad(trimM, [a[0], yBot, a[1]], [c[0], yBot, c[1]], [c2[0], yBot, c2[1]], [a2[0], yBot, a2[1]], [0, -1, 0]);
      sb.quad(trimM, [a[0], yTop, a[1]], [c[0], yTop, c[1]], [c2[0], yTop, c2[1]], [a2[0], yTop, a2[1]], [0, 1, 0]);
    }
  }
  roof(sb, b, eave, parapet, roofM, wallM, trimM, darkM, r, detail);
}

function roof(sb: SoupBuilder, b: Building, eave: number, parapet: number, roofM: Mat, wallM: Mat, trimM: Mat, darkM: Mat, r: () => number, detail: 'full' | 'low') {
  const fp = b.footprint;
  const rh = b.roofHeight ?? 0;
  if (b.roof === 'flat' || rh <= 0.05) {
    if (parapet > 0) {
      const inner = inset(fp, 0.35);
      sb.poly(roofM, inner, eave + 0.05);
      for (let i = 0; i < fp.length; i++) {
        const a = inner[i], c = inner[(i + 1) % fp.length], o = outward(inner, a, c);
        sb.wall(wallM, a, c, eave + 0.05, eave + parapet, [-o[0], -o[1]]);
        const A = fp[i], Cc = fp[(i + 1) % fp.length];
        sb.quad(trimM, [A[0], eave + parapet, A[1]], [Cc[0], eave + parapet, Cc[1]], [c[0], eave + parapet, c[1]], [a[0], eave + parapet, a[1]], [0, 1, 0]);
      }
    } else sb.poly(roofM, fp, eave + 0.02);
    // rooftop clutter on bigger flat roofs: plant boxes, a stair tower, vents
    const A = area(fp);
    if (detail === 'full' && A > 180 && b.use !== 'parking') {
      const rect = minRect(inset(fp, 2.2));
      const k = Math.min(4, 1 + Math.floor(A / 700));
      for (let i = 0; i < k; i++) {
        const u = (r() - 0.5) * rect.long * 0.6, v = (r() - 0.5) * rect.short * 0.6;
        const cx = rect.center[0] + Math.cos(rect.angle) * u - Math.sin(rect.angle) * v, cz = rect.center[1] + Math.sin(rect.angle) * u + Math.cos(rect.angle) * v;
        if (!pointInPoly([cx, cz], fp)) continue;
        const w = 2 + r() * Math.min(5, rect.short * 0.25), d = 2 + r() * 3, h = 1.2 + r() * (i === 0 ? 2.4 : 1.2);
        sb.box(i === 0 ? trimM : M('roof unit', '#9a9a96', 0.7, 0.3), [cx, eave + 0.05 + h / 2, cz], [w, h, d], rect.angle);
      }
    }
    return;
  }
  if (b.roof === 'pyramid' || b.roof === 'dome' || fp.length !== 4) {
    const c = centroid(fp);
    const over = inset(fp, -0.4);
    if (b.roof === 'dome') {
      const rings = 4;
      let prev = over.map((p) => [p[0], eave, p[1]] as V3);
      for (let k = 1; k <= rings; k++) {
        const t = k / rings, s = Math.cos((t * Math.PI) / 2), y = eave + Math.sin((t * Math.PI) / 2) * rh;
        const cur = over.map((p) => [c[0] + (p[0] - c[0]) * s, y, c[1] + (p[1] - c[1]) * s] as V3);
        for (let i = 0; i < over.length; i++) { const j = (i + 1) % over.length; const mid: V3 = [(prev[i][0] + prev[j][0]) / 2 - c[0], 0.5, (prev[i][2] + prev[j][2]) / 2 - c[1]]; if (k === rings) sb.tri(roofM, prev[i], prev[j], [c[0], y, c[1]], mid); else sb.quad(roofM, prev[i], prev[j], cur[j], cur[i], mid); }
        prev = cur;
      }
      return;
    }
    for (let i = 0; i < over.length; i++) {
      const a = over[i], d = over[(i + 1) % over.length], o = outward(over, a, d);
      sb.tri(roofM, [a[0], eave, a[1]], [d[0], eave, d[1]], [c[0], eave + rh, c[1]], [o[0], 0.6, o[1]]);
      sb.tri(darkM, [a[0], eave, a[1]], [d[0], eave, d[1]], [c[0], eave, c[1]], [0, -1, 0]);
    }
    return;
  }
  // four corners: gable, hip, shed along the long side
  let [p0, p1, p2, p3] = fp;
  if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < Math.hypot(p2[0] - p1[0], p2[1] - p1[1])) [p0, p1, p2, p3] = [p1, p2, p3, p0];
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), W = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const u: P2 = [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L], v: P2 = [(p3[0] - p0[0]) / W, (p3[1] - p0[1]) / W];
  const ov = 0.45;
  const E = (p: P2, du: number, dv: number): P2 => [p[0] + u[0] * du + v[0] * dv, p[1] + u[1] * du + v[1] * dv];
  // eave corners with overhang, ridge ends
  const q0 = E(p0, -ov, -ov), q1 = E(p1, ov, -ov), q2 = E(p2, ov, ov), q3 = E(p3, -ov, ov);
  const ye = eave - ov * (rh / (W / 2));
  const Y = (p: P2, y: number): V3 => [p[0], y, p[1]];
  if (b.roof === 'shed') {
    sb.quad(roofM, Y(q0, ye), Y(q1, ye), Y(q2, eave + rh + 0.2), Y(q3, eave + rh + 0.2), [-v[0], 2, -v[1]]);
    sb.quad(darkM, Y(q0, ye), Y(q1, ye), Y(q2, eave + rh + 0.2), Y(q3, eave + rh + 0.2), [v[0], -2, v[1]]);
    sb.wall(wallM, p2, p3, eave, eave + rh, v);
    sb.tri(wallM, Y(p0, eave), Y(p3, eave), Y(p3, eave + rh), [-u[0], 0, -u[1]]);
    sb.tri(wallM, Y(p1, eave), Y(p2, eave), Y(p2, eave + rh), [u[0], 0, u[1]]);
    return;
  }
  const hip = b.roof === 'hip' ? Math.min(W / 2, L / 2 - 0.01) : 0;
  const m0 = E(p0, hip - (hip ? 0 : ov), W / 2), m1 = E(p1, -hip + (hip ? 0 : ov), W / 2);
  const top = eave + rh;
  sb.quad(roofM, Y(q0, ye), Y(q1, ye), Y(m1, top), Y(m0, top), [-v[0], 1.5, -v[1]]);
  sb.quad(roofM, Y(q3, ye), Y(q2, ye), Y(m1, top), Y(m0, top), [v[0], 1.5, v[1]]);
  sb.quad(darkM, Y(q0, ye), Y(q1, ye), Y(q2, ye), Y(q3, ye), [0, -1, 0]);   // soffit
  if (hip) {
    sb.tri(roofM, Y(q1, ye), Y(q2, ye), Y(m1, top), [u[0], 1.5, u[1]]);
    sb.tri(roofM, Y(q3, ye), Y(q0, ye), Y(m0, top), [-u[0], 1.5, -u[1]]);
  } else {
    const g0 = E(p0, 0, W / 2), g1 = E(p1, 0, W / 2);
    sb.tri(wallM, Y(p0, eave), Y(p3, eave), Y(g0, top), [-u[0], 0, -u[1]]);
    sb.tri(wallM, Y(p1, eave), Y(p2, eave), Y(g1, top), [u[0], 0, u[1]]);
    // a round window in the gable on bigger houses
    if (W > 6 && detail === 'full') { const gc = E(p0, -0.07, W / 2); sb.frustum(trimM, [gc[0], eave + rh * 0.4, gc[1]], 0.0, 0.0, 0); }
  }
  // chimney on homes, steeple on churches
  if (detail === 'full' && b.use === 'home' && W > 5) {
    const cpt = E(p0, L * (0.2 + r() * 0.6), W * 0.3);
    sb.box(M('chimney', '#8a4a3a', 0.9), [cpt[0], top - 0.3 + 0.9, cpt[1]], [0.7, 2.2, 0.7], Math.atan2(u[1], u[0]));
  }
  if (detail === 'full' && b.use === 'church') {
    const s = Math.min(W * 0.55, 4.2);
    const tc = E(p0, s / 2 + 0.2, W / 2);
    const th = b.height + rh + 6;
    sb.box(wallM, [tc[0], eave - b.height + th / 2, tc[1]], [s, th, s], Math.atan2(u[1], u[0]));
    sb.box(trimM, [tc[0], eave - b.height + th - 1.2, tc[1]], [s + 0.3, 0.4, s + 0.3], Math.atan2(u[1], u[0]));
    sb.frustum(roofM, [tc[0], eave - b.height + th, tc[1]], s * 0.72, 0, s * 2.4, 4, Math.atan2(u[1], u[0]) + Math.PI / 4);
  }
}

// ── roads ──────────────────────────────────────────────────────────────────

function ribbon(sb: SoupBuilder, m: Mat, pts: P2[], hs: number[], from: number, to: number, lift: number, keep?: (p: P2) => boolean) {
  // offsets from the centre line: from..to (negative = left)
  for (let i = 0; i + 1 < pts.length; i++) {
    const nAt = (k: number): P2 => {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    };
    const n0 = nAt(i), n1 = nAt(i + 1);
    const mid: P2 = [(pts[i][0] + pts[i + 1][0]) / 2 + (n0[0] * (from + to)) / 2, (pts[i][1] + pts[i + 1][1]) / 2 + (n0[1] * (from + to)) / 2];
    if (keep && !keep(mid)) continue;
    const P = (k: number, nn: P2, o: number): V3 => [pts[k][0] + nn[0] * o, hs[k] + lift, pts[k][1] + nn[1] * o];
    sb.quad(m, P(i, n0, from), P(i + 1, n1, from), P(i + 1, n1, to), P(i, n0, to), [0, 1, 0]);
  }
}

function roads(plan: TownPlan, style: Style): SoupBuilder {
  const sb = new SoupBuilder();
  const C = style.colors;
  const roadM = M('asphalt', C.road, 0.92), walkM = M('sidewalk', C.sidewalk, 0.9), curbM = M('curb', shade(C.sidewalk, -0.12), 0.9), lineM = M('road paint', C.marking, 0.7), pedM = M('paving', C.plaza, 0.88);
  const order: Record<string, number> = { primary: 5, secondary: 4, tertiary: 3, residential: 2, pedestrian: 1.5, service: 1, footway: 0.5 };
  const sorted = plan.streets.slice().sort((a, b) => (order[a.kind] ?? 0) - (order[b.kind] ?? 0));
  // is a point on some other street's carriageway? (sidewalks and lines stop at junctions)
  const onOther = (s: Street, p: P2, pad: number) => plan.streets.some((o) => o !== s && o.kind !== 'footway' && distToPolyline(p, o.points) < o.width / 2 + pad);
  for (const s of sorted) {
    const hs = s.heights ?? s.points.map((p) => groundAt(plan.ground, p[0], p[1]));
    const w = s.width / 2;
    const lift = 0.05 + (order[s.kind] ?? 0) * 0.004;
    if (s.kind === 'pedestrian' || s.kind === 'footway') { ribbon(sb, pedM, s.points, hs, -w, w, lift + 0.02); continue; }
    ribbon(sb, roadM, s.points, hs, -w, w, lift);
    if (s.sidewalk > 0) {
      for (const side of [-1, 1]) {
        const a = side < 0 ? -w - s.sidewalk : w, b = side < 0 ? -w : w + s.sidewalk;
        const keep = (p: P2) => !onOther(s, p, 0.8);
        ribbon(sb, walkM, s.points, hs, a, b, 0.17, keep);
        // curb face along the road edge
        const edge = side < 0 ? -w : w;
        for (let i = 0; i + 1 < s.points.length; i++) {
          const p0 = s.points[i], p1 = s.points[i + 1], l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
          const nn: P2 = [-(p1[1] - p0[1]) / l, (p1[0] - p0[0]) / l];
          const A: P2 = [p0[0] + nn[0] * edge, p0[1] + nn[1] * edge], B: P2 = [p1[0] + nn[0] * edge, p1[1] + nn[1] * edge];
          if (!keep([(A[0] + B[0]) / 2 + nn[0] * side * s.sidewalk / 2, (A[1] + B[1]) / 2 + nn[1] * side * s.sidewalk / 2])) continue;
          sb.quad(curbM, [A[0], hs[i] + lift, A[1]], [B[0], hs[i + 1] + lift, B[1]], [B[0], hs[i + 1] + 0.17, B[1]], [A[0], hs[i] + 0.17, A[1]], [-nn[0] * side, 0, -nn[1] * side]);
        }
      }
    }
    // a dashed centre line on two-way streets wide enough for it
    if (s.width >= 8 && s.kind !== 'service') {
      let acc = 0;
      for (let i = 0; i + 1 < s.points.length; i++) {
        const p0 = s.points[i], p1 = s.points[i + 1], l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        for (let d = 0; d < l; d += 0.5) {
          const on = (acc + d) % 9 < 3;
          if (!on) continue;
          const t0 = d / l, t1 = Math.min((d + 0.5) / l, 1);
          const a: P2 = [p0[0] + (p1[0] - p0[0]) * t0, p0[1] + (p1[1] - p0[1]) * t0], b: P2 = [p0[0] + (p1[0] - p0[0]) * t1, p0[1] + (p1[1] - p0[1]) * t1];
          if (onOther(s, a, 1.5)) continue;
          const nn: P2 = [-(p1[1] - p0[1]) / l * 0.08, (p1[0] - p0[0]) / l * 0.08];
          const y0 = hs[i] + (hs[i + 1] - hs[i]) * t0 + lift + 0.012, y1 = hs[i] + (hs[i + 1] - hs[i]) * t1 + lift + 0.012;
          sb.quad(lineM, [a[0] - nn[0], y0, a[1] - nn[1]], [b[0] - nn[0], y1, b[1] - nn[1]], [b[0] + nn[0], y1, b[1] + nn[1]], [a[0] + nn[0], y0, a[1] + nn[1]], [0, 1, 0]);
        }
        acc += l;
      }
    }
  }
  return sb;
}

// ── trees and lights ───────────────────────────────────────────────────────

function trees(plan: TownPlan, style: Style): SoupBuilder {
  const sb = new SoupBuilder();
  const trunk = M('bark', style.colors.trunk, 0.95);
  for (const t of plan.trees) {
    const y = groundAt(plan.ground, t.at[0], t.at[1]) + 0.17;
    const s = t.size, r = rng(hash32(t.id));
    const leaf = M('leaves', style.colors.leaves[Math.floor(r() * style.colors.leaves.length)], 0.9);
    const rot = r() * Math.PI;
    sb.frustum(trunk, [t.at[0], y - 0.2, t.at[1]], 0.16 * s, 0.11 * s, 2.4 * s, 5, rot);
    if (t.kind === 'cone') {
      sb.frustum(leaf, [t.at[0], y + 1.6 * s, t.at[1]], 1.6 * s, 0, 3.2 * s, 6, rot);
      sb.frustum(leaf, [t.at[0], y + 3.2 * s, t.at[1]], 1.1 * s, 0, 2.4 * s, 6, rot + 0.5);
    } else {
      const R = (1.7 + r() * 0.5) * s, H = (2.2 + r() * 0.6) * s, cy = y + 2.0 * s;
      sb.frustum(leaf, [t.at[0], cy, t.at[1]], R * 0.55, R, H * 0.45, 7, rot, true);
      sb.frustum(leaf, [t.at[0], cy + H * 0.45, t.at[1]], R, R * 0.45, H * 0.55, 7, rot, true);
    }
  }
  return sb;
}

function streetLights(plan: TownPlan, style: Style): SoupBuilder {
  const sb = new SoupBuilder();
  const pole = M('lamp post', '#2c3030', 0.6, 0.6), lamp = M('lamp', '#f3e6c2', 0.4);
  const spacing = 26;
  for (const s of plan.streets) {
    if (!['primary', 'secondary', 'tertiary'].includes(s.kind) || !s.sidewalk) continue;
    let d = spacing / 2 + 4;
    const pts = s.points; let acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (d < acc + l) {
        const t = (d - acc) / l, p: P2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const side = Math.round(d / spacing) % 2 ? 1 : -1;
        const nn: P2 = [-(b[1] - a[1]) / l * side, (b[0] - a[0]) / l * side];
        const q: P2 = [p[0] + nn[0] * (s.width / 2 + 0.6), p[1] + nn[1] * (s.width / 2 + 0.6)];
        const y = (s.heights?.[i] ?? groundAt(plan.ground, q[0], q[1])) + 0.17;
        const clear = plan.buildings.every((bb) => !pointInPoly(q, bb.footprint)) && plan.streets.every((o) => o === s || o.kind === 'footway' || distToPolyline(q, o.points) > o.width / 2 + 0.5);
        if (clear) {
          sb.frustum(pole, [q[0], y, q[1]], 0.09, 0.07, 4.6, 5);
          sb.box(lamp, [q[0] - nn[0] * 0.5, y + 4.6, q[1] - nn[1] * 0.5], [0.45, 0.22, 0.45]);
        }
        d += spacing;
      }
      acc += l;
    }
  }
  void style;
  return sb;
}

export function nodeTriangles(nodes: TownNode[]): number {
  return nodes.reduce((s, n) => s + n.soups.reduce((t, x) => t + x.positions.length / 9, 0), 0);
}
export type { Tree, Area };
