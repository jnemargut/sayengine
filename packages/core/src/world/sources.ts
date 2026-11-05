// Plan sources (Decision 27): real (Overture + USGS 3DEP + OSM, from the cache), invented (a style plus
// a street sketch or a short description) and remix (real streets, invented buildings). Each returns a
// raw TownPlan; applyRules + applyFixes do the rest, the same for all three.
import { area, bboxCenter, bboxSize, centroid, clipLine, clipPoly, convexOverlap, distToPolyline, hash32, polylineLength, pointInPoly, project, rng, simplifyLine, type Bbox, type P2 } from './geo.ts';
import { CREDITS, flatGround, type Area, type Building, type BuildingUse, type Ground, type RoofType, type Street, type StreetKind, type TownPlan } from './plan.ts';
import { STREET_WIDTH, along } from './rules.ts';
import { stable, styleFor } from './styles.ts';

/** What `studio world-fetch` caches for an area (.studio/cache/world/<area>/). */
export interface RawArea {
  meta: { area: string; bbox: Bbox; fetchedAt: string; overtureRelease?: string; demResolution?: string };
  buildings: { type: 'FeatureCollection'; features: any[] };    // Overture buildings (GeoJSON)
  osm: { elements: any[] };                                    // Overpass JSON with geometry
  dem: { nx: number; nz: number; bbox: Bbox; heights: number[] }; // rows north → south, columns west → east (m above sea level)
}

const ROOF_MAP: Record<string, RoofType> = { flat: 'flat', gabled: 'gable', gable: 'gable', hipped: 'hip', hip: 'hip', pyramidal: 'pyramid', skillion: 'shed', dome: 'dome', onion: 'dome', round: 'dome', half_hipped: 'hip', mansard: 'hip', gambrel: 'gable', saltbox: 'gable' };
const HIGHWAY: Record<string, StreetKind> = { motorway: 'primary', trunk: 'primary', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary', unclassified: 'residential', residential: 'residential', living_street: 'residential', service: 'service', pedestrian: 'pedestrian', footway: 'footway', path: 'footway' };

function useOf(p: any, a: number): BuildingUse {
  const c = `${p.subtype ?? ''} ${p.class ?? ''}`.toLowerCase();
  if (/parking|garage/.test(c)) return 'parking';
  if (/church|chapel|religious|cathedral|temple|mosque|synagogue/.test(c)) return 'church';
  if (/hotel/.test(c)) return 'hotel';
  if (/civic|government|public|courthouse|town_hall|school|education|library|museum/.test(c)) return 'civic';
  if (/residential|apartments|house|detached/.test(c)) return 'home';
  if (/industrial|warehouse/.test(c)) return 'industrial';
  if (/retail|commercial|shop/.test(c)) return a < 900 ? 'shop' : 'office';
  return a < 700 ? 'shop' : 'office';
}

function groundFromDem(dem: RawArea['dem'], size: { w: number; d: number }): { ground: Ground; ref: number } {
  const mid = dem.heights[Math.floor(dem.nz / 2) * dem.nx + Math.floor(dem.nx / 2)];
  const ref = Math.round(mid * 10) / 10;
  return {
    ground: { nx: dem.nx, nz: dem.nz, x0: -size.w / 2, z0: -size.d / 2, dx: size.w / (dem.nx - 1), dz: size.d / (dem.nz - 1), heights: dem.heights.map((h) => +(h - ref).toFixed(3)), source: `USGS 3DEP (${dem.nx}×${dem.nz} samples)` },
    ref,
  };
}

function streetsFromOsm(osm: RawArea['osm'], frame: { lat0: number; lon0: number }, size: { w: number; d: number }): { streets: Street[]; skipped: number } {
  const streets: Street[] = [];
  let skipped = 0;
  const min: P2 = [-size.w / 2, -size.d / 2], max: P2 = [size.w / 2, size.d / 2];
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry || !e.tags?.highway) continue;
    const t = e.tags;
    const kind = HIGHWAY[String(t.highway).replace(/_link$/, '')];
    if (!kind || t.area === 'yes' || t.tunnel === 'yes' || Number(t.layer ?? 0) < 0) { skipped++; continue; }
    // sidewalks and crossings are drawn by the rules, not from the data
    if (kind === 'footway' && (t.footway === 'sidewalk' || t.footway === 'crossing' || !t.name)) { skipped++; continue; }
    if (kind === 'service' && /parking_aisle|drive-through/.test(t.service ?? '')) { skipped++; continue; }
    const line = e.geometry.map((g: any) => project(frame, g.lon, g.lat));
    const w = STREET_WIDTH[kind];
    const lanes = Number(t.lanes);
    const width = Number.isFinite(lanes) && lanes > 0 && kind !== 'pedestrian' ? Math.max(w.width * 0.7, Math.min(lanes * 3.3 + (t.parking ? 2 : 1), 20)) : w.width;
    clipLine(line, min, max).forEach((piece, k) => {
      const pts = simplifyLine(piece, 0.4);
      if (polylineLength(pts) < 4) return;
      streets.push({ id: `osm:w${e.id}${k ? `#${k}` : ''}`, ...(t.name ? { name: t.name } : {}), kind, width: +width.toFixed(1), sidewalk: t.sidewalk === 'no' ? 0 : w.sidewalk, points: pts.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)] as P2) });
    });
  }
  return { streets, skipped };
}

function areasFromOsm(osm: RawArea['osm'], frame: { lat0: number; lon0: number }, size: { w: number; d: number }): Area[] {
  const out: Area[] = [];
  const min: P2 = [-size.w / 2, -size.d / 2], max: P2 = [size.w / 2, size.d / 2];
  for (const e of osm.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const t = e.tags ?? {};
    let kind: Area['kind'] | null = null;
    if (t.natural === 'water' || t.water || t.landuse === 'reservoir') kind = 'water';
    else if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'recreation_ground') kind = 'park';
    else if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) kind = 'plaza';
    if (!kind) continue;
    // roof gardens and decks aren't on the ground
    if (Number(t.layer ?? 0) > 0 || t.location === 'roof' || /roof/i.test(t.name ?? '') || t.building) continue;
    const ring = e.geometry.map((g: any) => project(frame, g.lon, g.lat));
    const poly = clipPoly(ring, min, max);
    if (poly.length < 3 || area(poly) < 30) continue;
    out.push({ id: `osm:w${e.id}`, kind, ...(t.name ? { name: t.name } : {}), polygon: poly.map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)] as P2) });
  }
  return out;
}

/** Real data → raw plan (rules not yet applied). */
export function realPlan(name: string, raw: RawArea, style = 'raleigh-downtown'): TownPlan {
  const bbox = raw.meta.bbox, frame = bboxCenter(bbox), size = bboxSize(bbox);
  const { ground, ref } = groundFromDem(raw.dem, size);
  const buildings: Building[] = [];
  let underground = 0, outside = 0;
  const min: P2 = [-size.w / 2, -size.d / 2], max: P2 = [size.w / 2, size.d / 2];
  for (const f of raw.buildings.features) {
    const p = f.properties ?? {};
    if (p.is_underground) { underground++; continue; }
    const polys: number[][][][] = f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates : [];
    const gers = String(f.id ?? p.id);
    polys.forEach((rings, k) => {
      const ring = rings[0].map(([lon, lat]) => project(frame, lon, lat));
      const c = centroid(ring);
      if (c[0] < min[0] || c[0] > max[0] || c[1] < min[1] || c[1] > max[1]) { outside++; return; }
      const a = area(ring);
      buildings.push({
        id: `ov:${gers}${k ? `#${k}` : ''}`, sourceId: gers,
        ...(p.names?.primary ? { name: p.names.primary } : {}),
        footprint: ring, height: Number(p.height) || 0, floors: Number(p.num_floors) || 0,
        roof: (p.roof_shape && ROOF_MAP[p.roof_shape]) || (undefined as any),
        ...(p.roof_height ? { roofHeight: Number(p.roof_height) } : {}),
        use: useOf(p, a),
      });
    });
  }
  const { streets, skipped } = streetsFromOsm(raw.osm, frame, size);
  return {
    version: 1, name, source: 'real', style, frame, bbox, size, ground, streets, buildings,
    areas: areasFromOsm(raw.osm, frame, size), trees: [],
    credits: [CREDITS.overture, CREDITS.osm, CREDITS.usgs],
    stats: { elevationRef: ref, underground, outside, osmSkipped: skipped, sourceBuildings: raw.buildings.features.length },
  };
}

// ── invented towns ──────────────────────────────────────────────────────────

export interface SketchStreet { name?: string; kind?: StreetKind; points: P2[] }
export interface Sketch {
  streets: SketchStreet[];
  river?: { points: P2[]; width: number };   // a river's centre line
  green?: P2[];                              // a town green / square
  size?: { w: number; d: number };
}
export interface InventOpts { style?: string; seed?: number; description?: string; sketch?: Sketch; blocks?: number }

/** "mill town on a river, 1920s, 3 blocks" → a street sketch (deterministic; Claude can also write the sketch itself). */
export function sketchFromDescription(desc: string, seed: number, blocksOpt?: number): Sketch {
  const d = desc.toLowerCase();
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const m = d.match(/(\d+|one|two|three|four|five|six)\s+blocks?/);
  const blocks = Math.max(1, Math.min(6, blocksOpt ?? (m ? Number(words[m[1]] ?? m[1]) : 3)));
  const river = /river|creek|canal|water|harbou?r|wharf|mill/.test(d);
  const green = /green|square|plaza|common|park/.test(d) || blocks >= 3;
  const r = rng(seed);
  const blockLen = 78 + Math.floor(r() * 14);
  const w = blocks * blockLen + 70, dz = river ? 230 : 190;
  const x0 = -(blocks * blockLen) / 2;
  const riverZ = dz / 2 - 38;
  const mainZ = river ? riverZ - 58 : 0;
  const backZ = mainZ - 72;
  const bend = (x: number) => Math.sin((x / w) * Math.PI * 1.3 + r() * 0.0001) * 6;   // a gentle curve to the main street
  const main: P2[] = []; for (let x = -w / 2 + 6; x <= w / 2 - 6 + 0.01; x += 12) main.push([+x.toFixed(2), +(mainZ + bend(x)).toFixed(2)]);
  const streets: SketchStreet[] = [{ name: 'Main Street', kind: 'tertiary', points: main }];
  streets.push({ name: 'Back Street', kind: 'residential', points: [[-w / 2 + 6, backZ], [w / 2 - 6, backZ - 4]] });
  const crossNames = ['Mill Street', 'Church Street', 'Bridge Street', 'Market Street', 'Elm Street', 'Water Street', 'Oak Street'];
  for (let k = 0; k <= blocks; k++) {
    const x = x0 + k * blockLen;
    const toRiver = river && k === Math.floor(blocks / 2);
    const z1 = toRiver ? dz / 2 - 4 : river ? riverZ - 22 : dz / 2 - 6;
    streets.push({ name: toRiver ? 'Bridge Street' : crossNames[k % crossNames.length], kind: toRiver ? 'tertiary' : 'residential', points: [[x, -dz / 2 + 6], [x, +(mainZ + bend(x)).toFixed(2)], [x + (toRiver ? 0 : 2), z1]] });
  }
  if (river) streets.push({ name: 'River Walk', kind: 'pedestrian', points: [[-w / 2 + 6, riverZ - 20], [w / 2 - 6, riverZ - 20]] });
  const sk: Sketch = { streets, size: { w, d: dz } };
  if (river) sk.river = { points: [[-w / 2 - 10, riverZ + 2], [0, riverZ - 3], [w / 2 + 10, riverZ + 4]], width: 28 };
  if (green) {
    const k = Math.floor(blocks / 2) - (blocks % 2 ? 0 : 1);
    const gx = x0 + Math.max(0, k) * blockLen;
    sk.green = [[gx + 12, backZ + 12], [gx + blockLen - 12, backZ + 12], [gx + blockLen - 12, mainZ - 14], [gx + 12, mainZ - 14]];
  }
  return sk;
}

/**
 * Lots along every street, both sides, seeded widths and depths, oriented to the street. IDs come from
 * the seed, the street and the lot's place along it, so a regenerate with the same sketch keeps them.
 */
export function lotsAlongStreets(streets: Street[], opts: { seed: number; size: { w: number; d: number }; avoid?: P2[][]; water?: Area[]; style: string; keep?: (p: P2[]) => boolean }): Building[] {
  const out: Building[] = [];
  const style = styleFor(opts.style);
  const front = (s: Street) => s.width / 2 + s.sidewalk + 0.6;
  for (const s of streets) {
    if (s.kind === 'footway' || s.kind === 'service' || s.kind === 'pedestrian') continue;
    const L = polylineLength(s.points);
    for (const side of [-1, 1] as const) {
      const r = rng(hash32(`${opts.seed}|${s.id}|${side}`));
      let d = 6 + r() * 4, n = 0;
      while (d < L - 6) {
        const isMain = s.kind === 'tertiary' || s.kind === 'secondary' || s.kind === 'primary';
        const w = isMain ? 8 + r() * 7 : 11 + r() * 8;
        const depth = isMain ? 16 + r() * 12 : 9 + r() * 6;
        const setback = isMain ? 0 : 3 + r() * 3;
        const mid = along(s.points, d + w / 2);
        const nrm: P2 = [-mid.dir[1] * side, mid.dir[0] * side];
        const f0 = front(s) + setback;
        const c: P2 = [mid.p[0] + nrm[0] * (f0 + depth / 2), mid.p[1] + nrm[1] * (f0 + depth / 2)];
        const hx: P2 = [mid.dir[0] * (w / 2 - 0.35), mid.dir[1] * (w / 2 - 0.35)], hz: P2 = [nrm[0] * depth / 2, nrm[1] * depth / 2];
        const rect: P2[] = [[c[0] - hx[0] - hz[0], c[1] - hx[1] - hz[1]], [c[0] + hx[0] - hz[0], c[1] + hx[1] - hz[1]], [c[0] + hx[0] + hz[0], c[1] + hx[1] + hz[1]], [c[0] - hx[0] + hz[0], c[1] - hx[1] + hz[1]]];
        const lot = `${s.id.replace(/^[a-z]+:(\d+:)?/, '')}:${side < 0 ? 'L' : 'R'}${n}`;
        n++;
        d += w + (r() < 0.12 ? 4 + r() * 6 : 0);
        const inside = rect.every((p) => Math.abs(p[0]) < opts.size.w / 2 - 1 && Math.abs(p[1]) < opts.size.d / 2 - 1);
        const clearStreets = streets.every((o) => o.kind === 'footway' || rect.every((p) => distToPolyline(p, o.points) > front(o) - 0.3) && distToPolyline(c, o.points) > front(o) + 1);
        const clearAreas = (opts.avoid ?? []).every((a) => !convexOverlap(rect, a, 0.2) && !a.some((p) => pointInPoly(p, rect)));
        const clearWater = (opts.water ?? []).every((a) => rect.every((p) => !pointInPoly(p, a.polygon)) && distToPolyline(c, [...a.polygon, a.polygon[0]]) > 4);
        const clearLots = out.every((b) => !convexOverlap(rect, b.footprint, 0.3));
        if (!inside || !clearStreets || !clearAreas || !clearWater || !clearLots || (opts.keep && !opts.keep(rect))) continue;
        const id = `inv:${opts.seed}:${lot}`;
        const use: BuildingUse = isMain ? (stable(id, 'use') < 0.85 ? 'shop' : 'hotel') : 'home';
        out.push({ id, lot, footprint: rect.map(([x, z]) => [+x.toFixed(3), +z.toFixed(3)] as P2), height: 0, floors: 0, roof: undefined as any, use });
        void style;
      }
    }
  }
  return out;
}

function streetsFromSketch(sk: Sketch, seed: number): Street[] {
  return sk.streets.map((s, i) => {
    const kind = s.kind ?? (i === 0 ? 'tertiary' : 'residential');
    const slug = (s.name ?? `street ${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { id: `inv:${seed}:${slug}`, ...(s.name ? { name: s.name } : {}), kind, ...STREET_WIDTH[kind], points: s.points.map(([x, z]) => [x, z] as P2) };
  });
}

function riverArea(sk: Sketch, seed: number): Area | null {
  if (!sk.river) return null;
  const pts = sk.river.points, hw = sk.river.width / 2;
  const left: P2[] = [], right: P2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n: P2 = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    left.push([pts[i][0] + n[0] * hw, pts[i][1] + n[1] * hw]); right.push([pts[i][0] - n[0] * hw, pts[i][1] - n[1] * hw]);
  }
  return { id: `inv:${seed}:river`, kind: 'river', name: 'the river', polygon: [...left, ...right.reverse()] };
}

/** Ground for an invented town: rising gently away from the river, with a channel for the water. */
function inventedGround(size: { w: number; d: number }, sk: Sketch, seed: number): Ground {
  const g = flatGround(size.w, size.d, 6, 0, 'invented');
  const r = rng(seed ^ 0x9e3779b9);
  const ph = r() * 6.28;
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) {
    const x = g.x0 + i * g.dx, z = g.z0 + j * g.dz;
    let y = Math.sin(x / 70 + ph) * 0.6 + Math.cos(z / 55 + ph * 0.7) * 0.4;
    if (sk.river) {
      const d = distToPolyline([x, z], sk.river.points);
      y += Math.min(d, 120) * 0.035 - 1.2;           // banks rise from the water
      const hw = sk.river.width / 2;
      if (d < hw + 3) y -= (1 - Math.max(0, d - hw) / 3) * 2.2;   // the channel
    }
    g.heights[j * g.nx + i] = +y.toFixed(3);
  }
  return g;
}

export function inventedPlan(name: string, o: InventOpts): TownPlan {
  const seed = o.seed ?? 1;
  const style = o.style ?? (/1920|river|mill|clapboard|old/.test((o.description ?? '').toLowerCase()) ? 'river-town-1920s' : 'river-town-1920s');
  const sk = o.sketch ?? sketchFromDescription(o.description ?? 'a small river town, 3 blocks', seed, o.blocks);
  const size = sk.size ?? (() => {
    const xs = sk.streets.flatMap((s) => s.points.map((p) => p[0])), zs = sk.streets.flatMap((s) => s.points.map((p) => p[1]));
    return { w: Math.max(...xs.map(Math.abs)) * 2 + 40, d: Math.max(...zs.map(Math.abs)) * 2 + 40 };
  })();
  const streets = streetsFromSketch(sk, seed);
  const areas: Area[] = [];
  const river = riverArea(sk, seed);
  if (river) areas.push(river);
  if (sk.green) areas.push({ id: `inv:${seed}:green`, kind: 'park', name: 'the green', polygon: sk.green });
  const buildings = lotsAlongStreets(streets, { seed, size, avoid: sk.green ? [sk.green] : [], water: river ? [river] : [], style });
  landmarksForInvented(buildings, streets, sk, seed);
  return {
    version: 1, name, source: 'invented', style, seed, size, ground: inventedGround(size, sk, seed), streets, buildings, areas, trees: [],
    credits: [], stats: { lots: buildings.length },
  };
}

/** Give an invented town its few special buildings: a church at a corner, a town hall on the green, a mill by the water. */
function landmarksForInvented(bs: Building[], streets: Street[], sk: Sketch, seed: number) {
  if (!bs.length) return;
  const r = rng(seed ^ 0x51ed);
  const byArea = (list: Building[]) => list.slice().sort((a, b) => area(b.footprint) - area(a.footprint));
  if (sk.green) {
    const gc = centroid(sk.green);
    const near = bs.filter((b) => b.use !== 'home').sort((a, b) => Math.hypot(...sub(centroid(a.footprint), gc)) - Math.hypot(...sub(centroid(b.footprint), gc)));
    if (near[0]) { near[0].use = 'civic'; near[0].roof = 'hip'; }
  }
  const homes = bs.filter((b) => b.use === 'home');
  const church = byArea(homes.slice(0, Math.max(1, Math.floor(homes.length / 2))))[0] ?? homes[0];
  if (church) { church.use = 'church'; church.roof = 'gable'; church.floors = 1; church.height = 7.5 + r() * 2; church.roofHeight = 6; }
  if (sk.river) {
    const riverPts = sk.river.points;
    const nearWater = bs.filter((b) => b.use === 'shop' || b.use === 'hotel').sort((a, b) => distToPolyline(centroid(a.footprint), riverPts) - distToPolyline(centroid(b.footprint), riverPts));
    const mill = byArea(nearWater.slice(0, 6))[0];
    if (mill) { mill.use = 'industrial'; mill.floors = 3 + Math.floor(r() * 2); mill.height = 0; mill.roof = 'gable'; }
  }
  void streets;
}
const sub = (a: P2, b: P2): [number, number] => [a[0] - b[0], a[1] - b[1]];

/** Remix: the real street grid and ground, invented buildings along it in the chosen style. */
export function remixPlan(name: string, raw: RawArea, o: { style?: string; seed?: number }): TownPlan {
  const real = realPlan(name, raw, o.style ?? 'river-town-1920s');
  const seed = o.seed ?? 1;
  const streets = real.streets.filter((s) => s.kind !== 'footway');
  const avoid = real.areas.filter((a) => a.kind !== 'water').map((a) => a.polygon);
  const buildings = lotsAlongStreets(streets, { seed, size: real.size, avoid, water: real.areas.filter((a) => a.kind === 'water'), style: real.style });
  return { ...real, source: 'remix', seed, streets, buildings, credits: [CREDITS.osm, CREDITS.usgs], stats: { ...real.stats, lots: buildings.length } };
}
