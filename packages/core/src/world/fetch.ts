// `studio world-fetch`: download the open data for an area once and cache it (Decision 27).
//   Overture buildings  — the free `overturemaps` command line (Python), GeoJSON for the bbox
//   USGS 3DEP ground    — the National Map's public ImageServer, raw float32 heights (no GIS tools needed)
//   OSM streets/water/parks — the public Overpass API
// Everything lands in .studio/cache/world/<name>/ so rebuilds never touch the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bboxSize, parseBbox, type Bbox } from './geo.ts';
import { worldCacheDir } from './town.ts';

const UA = 'ai-3d-studio/0.1 (local, non-commercial town builder)';

export function findOverture(): string | null {
  const c = [process.env.OVERTUREMAPS_BIN, path.join(os.homedir(), '.studio-tools', 'venv', 'bin', 'overturemaps'), 'overturemaps'].filter(Boolean) as string[];
  for (const b of c) {
    if (b.includes('/')) { if (fs.existsSync(b)) return b; continue; }
    const r = spawnSync('which', [b], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

export async function fetchOverture(b: Bbox, out: string): Promise<{ features: number; release?: string }> {
  const bin = findOverture();
  if (!bin) throw Object.assign(new Error('the overturemaps command line is not installed'), { hint: 'python3 -m venv ~/.studio-tools/venv && ~/.studio-tools/venv/bin/pip install overturemaps (free, local)' });
  const r = spawnSync(bin, ['download', `--bbox=${b.west},${b.south},${b.east},${b.north}`, '-f', 'geojson', '-t', 'building', '-o', out], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(`overturemaps failed: ${(r.stderr || r.stdout).slice(-400)}`);
  fs.rmSync(out + '.state', { force: true });
  const fc = JSON.parse(fs.readFileSync(out, 'utf8'));
  const release = fc.features?.[0]?.properties?.sources?.find((s: any) => s.version)?.version;
  return { features: fc.features?.length ?? 0, release };
}

export async function fetchOsm(b: Bbox): Promise<any> {
  const bb = `${b.south},${b.west},${b.north},${b.east}`;
  const q = `[out:json][timeout:60];(way["highway"](${bb});way["natural"="water"](${bb});way["waterway"="riverbank"](${bb});way["water"](${bb});way["leisure"~"^(park|garden)$"](${bb});way["landuse"~"^(grass|recreation_ground|reservoir)$"](${bb});way["place"="square"](${bb}););out geom;`;
  const hosts = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let last = '';
  for (const h of hosts) {
    try {
      const res = await fetch(h, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(90000) });
      if (res.ok) return await res.json();
      last = `${h}: HTTP ${res.status}`;
    } catch (e: any) { last = `${h}: ${e.message}`; }
  }
  throw new Error(`Overpass (OpenStreetMap) failed: ${last}`);
}

/** USGS 3DEP heights on an nx × nz grid over the bbox (rows north → south). */
export async function fetchDem(b: Bbox, nx: number, nz: number): Promise<{ nx: number; nz: number; bbox: Bbox; heights: number[] }> {
  const url = `https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=${b.west},${b.south},${b.east},${b.north}&bboxSR=4326&imageSR=4326&size=${nx},${nz}&format=bip&pixelType=F32&interpolation=RSP_BilinearInterpolant&f=image`;
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error(`USGS 3DEP: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < nx * nz * 4) throw new Error(`USGS 3DEP returned ${buf.length} bytes, expected ${nx * nz * 4}`);
  const dv = new DataView(buf.buffer, buf.byteOffset, nx * nz * 4);
  const heights: number[] = [];
  for (let i = 0; i < nx * nz; i++) {
    const v = dv.getFloat32(i * 4, true);
    if (!Number.isFinite(v) || v < -500 || v > 9000) throw new Error('USGS 3DEP returned no data for part of this area (outside the US?)');
    heights.push(+v.toFixed(2));
  }
  return { nx, nz, bbox: b, heights };
}

export async function fetchArea(name: string, bboxArg: string | number[], opts: { spacing?: number; force?: boolean } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('--name must be lowercase letters, digits and dashes (e.g. raleigh-fayetteville)');
  const b = parseBbox(bboxArg);
  const dir = path.join(worldCacheDir(), name);
  if (fs.existsSync(path.join(dir, 'meta.json')) && !opts.force) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    return { area: name, dir, cached: true, meta };
  }
  fs.mkdirSync(dir, { recursive: true });
  const size = bboxSize(b), spacing = opts.spacing ?? 6;
  const nx = Math.min(257, Math.max(9, Math.round(size.w / spacing) + 1)), nz = Math.min(257, Math.max(9, Math.round(size.d / spacing) + 1));
  const t0 = Date.now();
  const [ov, osm, dem] = await Promise.all([fetchOverture(b, path.join(dir, 'buildings.geojson')), fetchOsm(b), fetchDem(b, nx, nz)]);
  fs.writeFileSync(path.join(dir, 'osm.json'), JSON.stringify(osm));
  fs.writeFileSync(path.join(dir, 'dem.json'), JSON.stringify(dem));
  const meta = { area: name, bbox: b, fetchedAt: new Date().toISOString(), overtureRelease: ov.release, demResolution: `${(size.w / (nx - 1)).toFixed(1)} m`, counts: { buildings: ov.features, osmWays: osm.elements?.length ?? 0, demSamples: nx * nz }, licences: ['Overture: ODbL-1.0', 'OpenStreetMap: ODbL-1.0', 'USGS 3DEP: public domain'] };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { area: name, dir, cached: false, seconds: (Date.now() - t0) / 1000, meta };
}
