// The world rules every source shares (Decision 27): square up outlines, roofs from the roof type,
// clamp silly values, grade roads, per-region style, street trees. Pure and deterministic.
import { area, centroid, ccw, cleanRing, distToPolyline, minRect, pointInPoly, polylineLength, squareUp, rng, hash32, type P2 } from './geo.ts';
import { groundAt, type Building, type Street, type TownPlan, type Tree, type StreetKind } from './plan.ts';
import { paletteFor, stable, styleFor, type Style } from './styles.ts';

export const LIMITS = { minArea: 12, minHeight: 2.6, maxHeight: 260, maxFloors: 70, maxRoofPitch: 0.6 };

export const STREET_WIDTH: Record<StreetKind, { width: number; sidewalk: number }> = {
  primary: { width: 13, sidewalk: 3.5 }, secondary: { width: 11, sidewalk: 3.2 }, tertiary: { width: 9.5, sidewalk: 3 },
  residential: { width: 7, sidewalk: 1.8 }, service: { width: 4.5, sidewalk: 0 }, pedestrian: { width: 9, sidewalk: 0 }, footway: { width: 2.4, sidewalk: 0 },
};

/** Run every rule over a raw plan (in place) and return it. */
export function applyRules(plan: TownPlan): TownPlan {
  const style = styleFor(plan.style);
  const kept: Building[] = [];
  let squared = 0, clamped = 0, dropped = 0;
  for (const b of plan.buildings) {
    const notes: string[] = [];
    const ring = cleanRing(b.footprint, 0.2);
    if (ring.length < 3 || area(ring) < LIMITS.minArea) { dropped++; continue; }
    const sq = squareUp(ring);
    if (sq.how !== 'kept') { squared++; notes.push(`squared (${sq.how})`); }
    b.footprint = sq.poly.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)] as P2);
    clampBuilding(b, style, notes) && clamped++;
    b.palette ??= paletteFor(style, b);
    b.storefront ??= style.storefront(b);
    b.notes = [...(b.notes ?? []), ...notes];
    kept.push(b);
  }
  plan.buildings = kept;
  gradeRoads(plan);
  seatBuildings(plan);
  if (!plan.trees.length) plan.trees = streetTrees(plan, style);
  plan.stats = { ...plan.stats, buildings: kept.length, squared, clamped, droppedTiny: dropped, streets: plan.streets.length, trees: plan.trees.length };
  return plan;
}

/** Fill missing heights/floors/roofs from the style and clamp silly values. Returns true when something was clamped. */
export function clampBuilding(b: Building, style: Style, notes: string[] = []): boolean {
  let clamped = false;
  const a = area(b.footprint);
  if (!(b.floors > 0) && !(b.height > 0)) b.floors = style.defaultFloors(b.use, a, stable(b.id, 'floors'));
  if (!(b.height > 0)) b.height = style.groundFloor + Math.max(0, b.floors - 1) * style.floorHeight;
  if (!(b.floors > 0)) b.floors = Math.max(1, Math.round((b.height - style.groundFloor) / style.floorHeight) + 1);
  if (b.height > LIMITS.maxHeight) { notes.push(`height ${b.height.toFixed(0)} m clamped to ${LIMITS.maxHeight}`); b.height = LIMITS.maxHeight; clamped = true; }
  if (b.height < LIMITS.minHeight) { notes.push(`height ${b.height.toFixed(1)} m raised to ${LIMITS.minHeight}`); b.height = LIMITS.minHeight; clamped = true; }
  // a 2 m² kiosk can't be 40 storeys: cap slenderness at 12:1 (height : short side)
  const short = minRect(b.footprint).short;
  if (b.height > short * 12 && b.height > 20) { notes.push(`height ${b.height.toFixed(0)} m clamped to 12× its width`); b.height = +(short * 12).toFixed(1); clamped = true; }
  const maxFloors = Math.min(LIMITS.maxFloors, Math.max(1, Math.floor(b.height / 2.6)));
  if (b.floors > maxFloors) { notes.push(`floors ${b.floors} clamped to ${maxFloors}`); b.floors = maxFloors; clamped = true; }
  b.floors = Math.max(1, Math.round(b.floors));
  if (b.height >= style.glassTowerAbove && b.use !== 'parking' && b.use !== 'civic') b.use = 'tower';
  if (!b.roof) b.roof = style.roof(b, stable(b.id, 'roof'));
  // pitched roofs only on simple outlines; their height follows the short side (no 20 m attics)
  if (b.roof !== 'flat' && b.footprint.length !== 4 && b.roof !== 'pyramid' && b.roof !== 'dome') { notes.push(`${b.roof} roof on a ${b.footprint.length}-corner outline: flat instead`); b.roof = 'flat'; }
  if (b.roof !== 'flat') {
    const want = b.roof === 'shed' ? short * 0.25 : short * 0.38;
    const max = short * LIMITS.maxRoofPitch;
    b.roofHeight = +Math.min(b.roofHeight ?? want, max, 9).toFixed(2);
  } else delete b.roofHeight;
  return clamped;
}

/**
 * Grade roads: densify to ≤ 6 m, sample the ground, smooth, limit the slope to 8%, then pull the ground
 * under every road (and its sidewalks) to the road so nothing pokes through or floats.
 */
export function gradeRoads(plan: TownPlan, maxSlope = 0.08) {
  const g = plan.ground;
  for (const s of plan.streets) {
    const pts: P2[] = [];
    for (let i = 0; i + 1 < s.points.length; i++) {
      const a = s.points[i], b = s.points[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 6));
      for (let k = 0; k < n; k++) pts.push([+(a[0] + ((b[0] - a[0]) * k) / n).toFixed(3), +(a[1] + ((b[1] - a[1]) * k) / n).toFixed(3)]);
    }
    pts.push(s.points[s.points.length - 1]);
    let h = pts.map((p) => groundAt(g, p[0], p[1]));
    for (let pass = 0; pass < 3; pass++) h = h.map((v, i) => (i === 0 || i === h.length - 1 ? v : (h[i - 1] + v * 2 + h[i + 1]) / 4));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < h.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); h[i] = Math.min(Math.max(h[i], h[i - 1] - d * maxSlope), h[i - 1] + d * maxSlope); }
      for (let i = h.length - 2; i >= 0; i--) { const d = Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]); h[i] = Math.min(Math.max(h[i], h[i + 1] - d * maxSlope), h[i + 1] + d * maxSlope); }
    }
    s.points = pts;
    s.heights = h.map((v) => +v.toFixed(3));
  }
  // ground follows the roads: each grid point within a road's reach blends toward the road's height
  const out = g.heights.slice();
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
    const p: P2 = [g.x0 + i * g.dx, g.z0 + j * g.dz];
    let best = Infinity, bh = 0;
    for (const s of plan.streets) {
      if (s.kind === 'footway') continue;
      const reach = s.width / 2 + s.sidewalk + Math.max(g.dx, g.dz);
      for (let k = 0; k + 1 < s.points.length; k++) {
        const a = s.points[k], b = s.points[k + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
        const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
        const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
        if (d < reach && d / reach < best) { best = d / reach; bh = s.heights![k] + (s.heights![k + 1] - s.heights![k]) * t; }
      }
    }
    if (best < 1) { const w = best < 0.6 ? 1 : 1 - (best - 0.6) / 0.4; out[j * g.nx + i] = +(out[j * g.nx + i] * (1 - w) + bh * w).toFixed(3); }
  }
  g.heights = out;
}

/** Each building's lowest and highest ground (walls go from below the lowest to the eave above the highest). */
export function seatBuildings(plan: TownPlan) {
  for (const b of plan.buildings) {
    const hs = [...b.footprint, centroid(b.footprint)].map((p) => groundAt(plan.ground, p[0], p[1]));
    b.base = +Math.min(...hs).toFixed(3);
    b.top = +Math.max(...hs).toFixed(3);
  }
}

/** Street trees along the bigger streets (both sides, on the sidewalk) and scattered in parks, seeded by the town. */
export function streetTrees(plan: TownPlan, style: Style): Tree[] {
  const trees: Tree[] = [];
  if (!style.streetTrees) return trees;
  const r = rng(hash32(plan.name + '|trees'));
  const clearOfBuildings = (p: P2, gap: number) => plan.buildings.every((b) => !pointInPoly(p, b.footprint) && distToPolyline(p, [...b.footprint, b.footprint[0]]) > gap);
  const clearOfRoads = (p: P2) => plan.streets.every((s) => s.kind === 'footway' || distToPolyline(p, s.points) > s.width / 2 + 0.6);
  const inWater = (p: P2) => plan.areas.some((a) => (a.kind === 'water' || a.kind === 'river') && pointInPoly(p, a.polygon));
  for (const s of plan.streets) {
    if (!['primary', 'secondary', 'tertiary', 'residential', 'pedestrian'].includes(s.kind) || !s.sidewalk && s.kind !== 'pedestrian') continue;
    const L = polylineLength(s.points);
    const off = s.kind === 'pedestrian' ? s.width / 2 - 1.2 : s.width / 2 + s.sidewalk * 0.55;
    for (let d = style.streetTrees / 2; d < L; d += style.streetTrees) {
      const { p, dir } = along(s.points, d);
      for (const side of [-1, 1]) {
        const q: P2 = [p[0] - dir[1] * off * side, p[1] + dir[0] * off * side];
        if (Math.abs(q[0]) > plan.size.w / 2 - 2 || Math.abs(q[1]) > plan.size.d / 2 - 2) continue;
        if (!clearOfBuildings(q, 1.6) || !clearOfRoads(q) || inWater(q)) continue;
        if (trees.some((t) => Math.hypot(t.at[0] - q[0], t.at[1] - q[1]) < 6)) continue;
        trees.push({ id: `tree:${s.id}:${Math.round(d)}:${side}`, at: [+q[0].toFixed(2), +q[1].toFixed(2)], size: +(0.85 + r() * 0.35).toFixed(2), kind: 'round' });
      }
    }
  }
  for (const a of plan.areas) {
    if (a.kind !== 'park') continue;
    const n = Math.min(40, Math.floor(area(a.polygon) / 160));
    const xs = a.polygon.map((p) => p[0]), zs = a.polygon.map((p) => p[1]);
    for (let k = 0, tries = 0; k < n && tries < n * 20; tries++) {
      const q: P2 = [Math.min(...xs) + r() * (Math.max(...xs) - Math.min(...xs)), Math.min(...zs) + r() * (Math.max(...zs) - Math.min(...zs))];
      if (!pointInPoly(q, a.polygon) || !clearOfRoads(q) || !clearOfBuildings(q, 2) || trees.some((t) => Math.hypot(t.at[0] - q[0], t.at[1] - q[1]) < 5)) continue;
      trees.push({ id: `tree:${a.id}:${k}`, at: [+q[0].toFixed(2), +q[1].toFixed(2)], size: +(0.9 + r() * 0.5).toFixed(2), kind: r() < 0.25 ? 'cone' : 'round' });
      k++;
    }
  }
  return trees;
}

export function along(line: P2[], d: number): { p: P2; dir: P2 } {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d <= l || i + 2 === line.length) { const t = l ? Math.min(d / l, 1) : 0; return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], dir: l ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0] }; }
    d -= l;
  }
  return { p: line[0], dir: [1, 0] };
}

export { ccw };
