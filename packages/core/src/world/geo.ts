// Plane geometry for the world module (Decision 27): projection from lat/lon to local metres,
// polygon measures, ear-clipping, minimum-area rectangles, orthogonal squaring and insets.
// Coordinates are [x, z] in metres: x east, z south (so -z is north, the engines' "forward").

export type P2 = [number, number];
export interface Bbox { west: number; south: number; east: number; north: number }

export const M_PER_DEG_LAT = 110_540;
export const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** A local frame centred on (lat0, lon0). */
export interface Frame { lat0: number; lon0: number }
export function project(f: Frame, lon: number, lat: number): P2 {
  return [+((lon - f.lon0) * mPerDegLon(f.lat0)).toFixed(3), +(-(lat - f.lat0) * M_PER_DEG_LAT).toFixed(3)];
}
export function unproject(f: Frame, p: P2): { lon: number; lat: number } {
  return { lon: f.lon0 + p[0] / mPerDegLon(f.lat0), lat: f.lat0 - p[1] / M_PER_DEG_LAT };
}
export function bboxCenter(b: Bbox): Frame { return { lat0: (b.south + b.north) / 2, lon0: (b.west + b.east) / 2 }; }
export function bboxSize(b: Bbox): { w: number; d: number } {
  const c = bboxCenter(b);
  return { w: (b.east - b.west) * mPerDegLon(c.lat0), d: (b.north - b.south) * M_PER_DEG_LAT };
}
export function parseBbox(s: string | number[]): Bbox {
  const a = (Array.isArray(s) ? s : String(s).split(',')).map(Number);
  if (a.length !== 4 || a.some((v) => !Number.isFinite(v))) throw new Error('bbox must be "west,south,east,north" in degrees');
  const [west, south, east, north] = a;
  if (!(west < east && south < north)) throw new Error('bbox must be west < east and south < north');
  if (east - west > 0.05 || north - south > 0.05) throw new Error('bbox is larger than about 5 km: pick a few blocks (the world module builds neighbourhoods, not cities)');
  return { west, south, east, north };
}

/** Signed area (positive = counter-clockwise when x right, z down… i.e. clockwise seen from above). */
export function signedArea(poly: P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}
export const area = (poly: P2[]) => Math.abs(signedArea(poly));
export function centroid(poly: P2[]): P2 {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) { const n = poly.length || 1; return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n]; }
  return [cx / (3 * a), cz / (3 * a)];
}
export function pointInPoly(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function distToSegment(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}
export function distToPolyline(p: P2, line: P2[]): number {
  let d = Infinity;
  for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSegment(p, line[i], line[i + 1]));
  return d;
}
export function polylineLength(line: P2[]): number {
  let s = 0;
  for (let i = 0; i + 1 < line.length; i++) s += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
  return s;
}

/** Drop the closing duplicate, near-duplicate and collinear points. */
export function cleanRing(poly: P2[], eps = 0.05): P2[] {
  let r = poly.slice();
  if (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < eps) r.pop();
  r = r.filter((p, i) => { const q = r[(i + 1) % r.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) >= eps; });
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
      if (Math.abs(cross) / len < eps) { r.splice(i, 1); changed = true; break; }
    }
  }
  return r;
}
/** Counter-clockwise seen from above (+y): with z pointing south that is a negative signed area here. */
export function ccw(poly: P2[]): P2[] { return signedArea(poly) > 0 ? poly.slice().reverse() : poly.slice(); }

/** Ear-clipping triangulation of a simple polygon (no holes). Returns index triples. */
export function triangulate(poly: P2[]): number[] {
  const n = poly.length;
  if (n < 3) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  const s = signedArea(poly) > 0 ? 1 : -1;
  const out: number[] = [];
  const cross = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: P2, a: P2, b: P2, c: P2) => {
    const d1 = cross(a, b, p) * s, d2 = cross(b, c, p) * s, d3 = cross(c, a, p) * s;
    return d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9;
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) * s <= 1e-12) continue;
      let ear = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inTri(poly[j], a, b, c)) { ear = false; break; } }
      if (!ear) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) { // degenerate leftovers: fan the rest
      for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
      return out;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

export function convexHull(pts: P2[]): P2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], hi: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}

/** Minimum-area enclosing rectangle (rotating the hull's edges). angle = direction of the long side. */
export interface Rect { center: P2; angle: number; long: number; short: number; corners: P2[] }
export function minRect(poly: P2[]): Rect {
  const hull = convexHull(poly);
  let best: Rect | null = null, bestA = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) { const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c; minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
    const ar = (maxU - minU) * (maxV - minV);
    if (ar < bestA - 1e-9) {
      bestA = ar;
      const corner = (u: number, v: number): P2 => [u * c - v * s, u * s + v * c];
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const du = maxU - minU, dv = maxV - minV;
      best = { center: corner(cu, cv), angle: du >= dv ? ang : ang + Math.PI / 2, long: Math.max(du, dv), short: Math.min(du, dv), corners: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)] };
    }
  }
  return best ?? { center: centroid(poly), angle: 0, long: 0, short: 0, corners: poly.slice(0, 4) };
}

/** The dominant wall direction: edge angles folded to [0, 90°), weighted by length. Radians. */
export function dominantAngle(poly: P2[]): number {
  const bins = new Array(90).fill(0);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90;
    for (let k = -3; k <= 3; k++) bins[(Math.round(deg) + k + 90) % 90] += len * (1 - Math.abs(k) / 4);
  }
  const best = bins.indexOf(Math.max(...bins));
  // refine: length-weighted mean of edges near the best bin
  let sum = 0, w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90;
    let d = deg - best; if (d > 45) d -= 90; if (d < -45) d += 90;
    if (Math.abs(d) <= 6) { sum += (best + d) * len; w += len; }
  }
  return ((w ? sum / w : best) * Math.PI) / 180;
}

export function rotate(poly: P2[], ang: number, about: P2 = [0, 0]): P2[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  return poly.map(([x, z]) => { const dx = x - about[0], dz = z - about[1]; return [about[0] + dx * c - dz * s, about[1] + dx * s + dz * c] as P2; });
}

/**
 * Square up an outline: snap every edge to the dominant direction or its perpendicular and rebuild
 * the corners from the snapped lines. Nearly-rectangular outlines become their minimum rectangle.
 * Returns null when the outline isn't building-like enough to square (keep it as is).
 */
export function squareUp(poly: P2[], opts: { rectFill?: number; tolDeg?: number } = {}): { poly: P2[]; how: 'rect' | 'ortho' | 'kept' } {
  const ring = cleanRing(poly, 0.3);
  if (ring.length < 3) return { poly, how: 'kept' };
  const a = area(ring);
  const r = minRect(ring);
  if (a / Math.max(r.long * r.short, 1e-6) >= (opts.rectFill ?? 0.9)) return { poly: ccw(r.corners), how: 'rect' };
  const ang = dominantAngle(ring), tol = ((opts.tolDeg ?? 18) * Math.PI) / 180;
  const c = centroid(ring);
  const local = rotate(ring, -ang, c);
  // classify edges horizontal (along x) or vertical (along z); any edge far from both: give up
  const kinds: Array<'h' | 'v'> = [];
  for (let i = 0; i < local.length; i++) {
    const p = local[i], q = local[(i + 1) % local.length];
    const e = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const fold = Math.abs(((e % Math.PI) + Math.PI) % Math.PI);
    const dh = Math.min(fold, Math.PI - fold), dv = Math.abs(fold - Math.PI / 2);
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (Math.min(dh, dv) > tol && len > 2) return { poly: ccw(ring), how: 'kept' };
    kinds.push(dh <= dv ? 'h' : 'v');
  }
  // merge runs of the same kind into one line (length-weighted coordinate)
  const lines: Array<{ k: 'h' | 'v'; c: number }> = [];
  let i0 = kinds.findIndex((k, i) => k !== kinds[(i + kinds.length - 1) % kinds.length]);
  if (i0 < 0) return { poly: ccw(r.corners), how: 'rect' };
  for (let n = 0; n < kinds.length;) {
    const k = kinds[(i0 + n) % kinds.length];
    let sum = 0, w = 0;
    while (n < kinds.length && kinds[(i0 + n) % kinds.length] === k) {
      const p = local[(i0 + n) % local.length], q = local[(i0 + n + 1) % local.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) + 1e-6;
      sum += (k === 'h' ? (p[1] + q[1]) / 2 : (p[0] + q[0]) / 2) * len; w += len;
      n++;
    }
    lines.push({ k, c: sum / w });
  }
  if (lines.length < 4 || lines.length % 2) return { poly: ccw(r.corners), how: 'rect' };
  const pts: P2[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i], M = lines[(i + 1) % lines.length];
    pts.push(L.k === 'h' ? [M.c, L.c] : [L.c, M.c]);
  }
  const out = cleanRing(rotate(pts, ang, c), 0.3);
  if (out.length < 4 || Math.abs(area(out) - a) / a > 0.25) return { poly: ccw(ring), how: 'kept' };
  return { poly: ccw(out), how: 'ortho' };
}

/** Inset a polygon by d (miter joins; fine for squared-up outlines). */
export function inset(poly: P2[], d: number): P2[] {
  const p = ccw(poly), n = p.length, out: P2[] = [];
  // ccw seen from above with z south: interior is to the left of each edge in (x, -z)… compute via sign
  const s = signedArea(p) < 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const n1 = norm([-(b[1] - a[1]) * s, (b[0] - a[0]) * s]), n2 = norm([-(c[1] - b[1]) * s, (c[0] - b[0]) * s]);
    const m = norm([n1[0] + n2[0], n1[1] + n2[1]]);
    const cos = m[0] * n1[0] + m[1] * n1[1];
    const k = d / Math.max(cos, 0.3);
    out.push([b[0] + m[0] * k, b[1] + m[1] * k]);
  }
  return out;
}
function norm(v: P2): P2 { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; }

/** Douglas–Peucker simplification of a polyline. */
export function simplifyLine(line: P2[], eps: number): P2[] {
  if (line.length < 3) return line.slice();
  let dmax = 0, idx = 0;
  for (let i = 1; i < line.length - 1; i++) { const d = distToSegment(line[i], line[0], line[line.length - 1]); if (d > dmax) { dmax = d; idx = i; } }
  if (dmax <= eps) return [line[0], line[line.length - 1]];
  return [...simplifyLine(line.slice(0, idx + 1), eps).slice(0, -1), ...simplifyLine(line.slice(idx), eps)];
}

/** Clip a polyline to an axis-aligned box (keeps the pieces inside). */
export function clipLine(line: P2[], min: P2, max: P2): P2[][] {
  const inside = (p: P2) => p[0] >= min[0] && p[0] <= max[0] && p[1] >= min[1] && p[1] <= max[1];
  const out: P2[][] = [];
  let cur: P2[] = [];
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (inside(p)) {
      if (!cur.length && i > 0) cur.push(edgeHit(line[i - 1], p, min, max));
      cur.push(p);
    } else if (cur.length) { cur.push(edgeHit(p, line[i - 1], min, max)); out.push(cur); cur = []; }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
function edgeHit(outP: P2, inP: P2, min: P2, max: P2): P2 {
  let t = 1;
  for (let k = 0; k < 2; k++) {
    const d = outP[k] - inP[k];
    if (outP[k] < min[k]) t = Math.min(t, (min[k] - inP[k]) / d);
    if (outP[k] > max[k]) t = Math.min(t, (max[k] - inP[k]) / d);
  }
  return [inP[0] + (outP[0] - inP[0]) * t, inP[1] + (outP[1] - inP[1]) * t];
}

/** Clip a polygon to an axis-aligned box (Sutherland–Hodgman). */
export function clipPoly(poly: P2[], min: P2, max: P2): P2[] {
  let out = poly.slice();
  const planes: Array<[number, number, 1 | -1]> = [[0, min[0], 1], [0, max[0], -1], [1, min[1], 1], [1, max[1], -1]];
  for (const [k, v, s] of planes) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length];
      const ia = (a[k] - v) * s >= 0, ib = (b[k] - v) * s >= 0;
      if (ia) out.push(a);
      if (ia !== ib) { const t = (v - a[k]) / (b[k] - a[k]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    if (!out.length) break;
  }
  return out;
}

/** Do two convex polygons overlap (separating axis test)? A small margin shrinks the test. */
export function convexOverlap(a: P2[], b: P2[], margin = 0): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const nx = -(q[1] - p[1]), nz = q[0] - p[0], l = Math.hypot(nx, nz) || 1;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const v of a) { const d = (v[0] * nx + v[1] * nz) / l; amin = Math.min(amin, d); amax = Math.max(amax, d); }
      for (const v of b) { const d = (v[0] * nx + v[1] * nz) / l; bmin = Math.min(bmin, d); bmax = Math.max(bmax, d); }
      if (amax - margin <= bmin || bmax - margin <= amin) return false;
    }
  }
  return true;
}

/** A small seeded random generator (mulberry32) and a string hash, for stable invented towns and styles. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
