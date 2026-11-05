// The town plan (Decision 27): the one format every source (real, invented, remix) produces and every
// rule, fix, check and exporter reads. Metres, [x, z] with x east and z south; y up, 0 = the town's
// reference ground height. Every feature has a stable ID:
//   real buildings   "ov:<Overture GERS id>"      real streets / water / parks   "osm:w<way id>"
//   invented          "inv:<seed>:<block>-<lot>"   (seed + lot, so a regenerate keeps fixes)
import type { P2, Bbox } from './geo.ts';

export type RoofType = 'flat' | 'gable' | 'hip' | 'shed' | 'pyramid' | 'dome';
export const ROOF_TYPES: RoofType[] = ['flat', 'gable', 'hip', 'shed', 'pyramid', 'dome'];
export type BuildingUse = 'shop' | 'office' | 'home' | 'civic' | 'church' | 'parking' | 'hotel' | 'industrial' | 'tower';
export const BUILDING_USES: BuildingUse[] = ['shop', 'office', 'home', 'civic', 'church', 'parking', 'hotel', 'industrial', 'tower'];
export type StreetKind = 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service' | 'pedestrian' | 'footway';

export interface Palette { wall: string; trim: string; roof: string; glass: string; accent?: string }

export interface Building {
  id: string;
  sourceId?: string;             // the raw source ID (GERS id for Overture)
  lot?: string;                  // invented towns: "<block>-<lot>"
  name?: string;                 // kept as data only; names never go on signs (release checks)
  footprint: P2[];               // counter-clockwise seen from above, squared up by the rules
  height: number;                // eave height above the highest ground under it (m)
  floors: number;
  roof: RoofType;
  roofHeight?: number;           // m above the eave (pitched roofs)
  use: BuildingUse;
  palette?: Palette;             // set by the style rules (or a fix)
  storefront?: boolean;          // ground floor shopfronts (style rules)
  base?: number;                 // y of the lowest ground under the footprint (filled when built)
  top?: number;                  // y of the highest ground under the footprint
  hidden?: boolean;              // a fix hid it
  model?: string;                // a fix swapped in this studio object (landmark)
  modelRotation?: number;        // degrees about y for the swapped-in model
  fixes?: number[];              // indices of the fixes that touched it
  notes?: string[];              // what the rules did (squared, clamped…)
}

export interface Street {
  id: string;
  name?: string;
  kind: StreetKind;
  width: number;                 // carriageway width (m)
  sidewalk: number;              // each side (m); 0 = none
  points: P2[];
  heights?: number[];            // graded y per point (rules.gradeRoads)
}

export interface Area { id: string; kind: 'water' | 'park' | 'plaza' | 'river'; name?: string; polygon: P2[] }
export interface Tree { id: string; at: P2; size: number; kind: 'round' | 'cone' }

export interface Ground {
  /** heights on a regular grid: heights[j * nx + i] at x = x0 + i * dx, z = z0 + j * dz */
  nx: number; nz: number; x0: number; z0: number; dx: number; dz: number;
  heights: number[];
  source: string;                // "USGS 3DEP 1/3 arc-second" or "invented"
}

export interface Credit { name: string; licence: string; url: string; text: string; shareAlike?: boolean }

export interface TownPlan {
  version: 1;
  name: string;
  source: 'real' | 'invented' | 'remix';
  style: string;
  seed?: number;
  frame?: { lat0: number; lon0: number };   // real and remix towns: where (0,0) is on Earth
  bbox?: Bbox;
  size: { w: number; d: number };            // metres across (x) and deep (z)
  ground: Ground;
  streets: Street[];
  buildings: Building[];
  areas: Area[];
  trees: Tree[];
  credits: Credit[];
  stats: Record<string, number>;
}

/** Bilinear ground height at a point (clamped to the grid). */
export function groundAt(g: Ground, x: number, z: number): number {
  const fx = Math.min(Math.max((x - g.x0) / g.dx, 0), g.nx - 1.0001), fz = Math.min(Math.max((z - g.z0) / g.dz, 0), g.nz - 1.0001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const h = (a: number, b: number) => g.heights[b * g.nx + a];
  return h(i, j) * (1 - u) * (1 - v) + h(i + 1, j) * u * (1 - v) + h(i, j + 1) * (1 - u) * v + h(i + 1, j + 1) * u * v;
}

export function flatGround(w: number, d: number, step = 8, y = 0, source = 'invented'): Ground {
  const nx = Math.max(2, Math.ceil(w / step) + 1), nz = Math.max(2, Math.ceil(d / step) + 1);
  return { nx, nz, x0: -w / 2, z0: -d / 2, dx: w / (nx - 1), dz: d / (nz - 1), heights: new Array(nx * nz).fill(y), source };
}

/** The credits the open-data licences require, by source. */
export const CREDITS: Record<string, Credit> = {
  osm: { name: 'OpenStreetMap contributors', licence: 'ODbL-1.0', url: 'https://www.openstreetmap.org/copyright', text: '© OpenStreetMap contributors. Street, water and park data under the Open Database License (ODbL 1.0); the derived town data is shared under the same licence.', shareAlike: true },
  overture: { name: 'Overture Maps Foundation', licence: 'ODbL-1.0', url: 'https://docs.overturemaps.org/attribution/', text: '© Overture Maps Foundation, building footprints and heights (sources include OpenStreetMap and Microsoft ML Buildings), under the Open Database License (ODbL 1.0).', shareAlike: true },
  usgs: { name: 'U.S. Geological Survey, 3D Elevation Program', licence: 'Public domain (US Government work)', url: 'https://www.usgs.gov/3d-elevation-program', text: 'Ground heights: USGS 3D Elevation Program (3DEP), public domain. Courtesy of the U.S. Geological Survey.' },
};
