// Scene IR — the single source of truth (Decision 2: normalized records with stable IDs).
// Units: meters, degrees. Y is up. The floor is y = 0.

export type Num = number | string; // string = expression over params, e.g. "$seatH - $seatT"
export type Vec = [Num, Num, Num];

export interface Param {
  value: number;
  unit?: 'm' | 'deg' | '';
  min?: number;
  max?: number;
  description?: string;
}

export const OP_NAMES = [
  'box', 'cylinder', 'sphere', 'roundedBox', 'extrude', 'revolve',
  'translate', 'rotate', 'scale', 'mirror',
  'union', 'difference', 'intersect', 'hull',
  'placeAt', 'array',
  'round', 'smooth', 'trim',
  'mesh',
] as const;
export type OpName = (typeof OP_NAMES)[number];

export interface OpNode {
  id: string;            // stable id inside the object, e.g. "seat", "leg", "legs"
  op: OpName;
  args: Record<string, unknown>;
  inputs?: string[];     // ids of other op nodes in the same object
  part?: string;         // semantic part name for primitives / instancers ("leg")
}

export type Rule =
  | { kind: 'grounded'; parts: string; label?: string }          // glob, e.g. "leg*"
  | { kind: 'connected'; label?: string }
  | { kind: 'range'; expr: string; min: number; max: number; label?: string }
  | { kind: 'aboveFloor'; label?: string };

/** PBR material. `name` is a preset (see materials.ts) or a custom label; explicit fields override the preset. */
export interface Material {
  name: string;
  color: string;
  roughness?: number;
  metalness?: number;
  clearcoat?: number;            // glaze / lacquer layer 0..1
  clearcoatRoughness?: number;
  transmission?: number;         // glass 0..1
  ior?: number;
  thickness?: number;            // m, for transmission
  opacity?: number;
  grain?: WoodGrain | null;      // procedural wood grain (no UVs needed)
}
export interface WoodGrain { color2: string; scale: number; contrast: number }

/** Where an object sits, relative to another object. Re-solved whenever either one changes. */
export type Placement =
  | { kind: 'on'; target: string; offset?: [number, number] }
  | { kind: 'under'; target: string; offset?: [number, number] }
  | { kind: 'nextTo'; target: string; side: 'left' | 'right' | 'front' | 'back'; gap: number; offset?: [number, number] }
  | { kind: 'align'; target: string; axis: 'x' | 'z'; edge: 'min' | 'center' | 'max'; offset?: [number, number] }
  | { kind: 'around'; target: string; index: number; count: number; radius?: number; start?: number; face?: Facing; rotate?: number; offset?: [number, number] }
  | { kind: 'along'; target: string; index: number; count: number; side: 'left' | 'right' | 'front' | 'back'; spacing?: number; gap?: number; face?: Facing; rotate?: number; offset?: [number, number] };
export type Facing = 'target' | 'away' | 'none';

/** Imported reference: a mesh to model around, or an image backdrop to model to match. */
export type Reference =
  | { kind: 'mesh'; asset: string; file: string; format: string; manifold?: boolean }
  | { kind: 'image'; asset: string; file: string; plane: 'front' | 'side' | 'top'; width: number; height: number; at: [number, number, number]; opacity: number };

export interface SceneObject {
  id: string;
  name: string;
  semanticType: string;          // "stool", "chair", "table", "wall"… (level 1: semantic)
  description?: string;
  params: Record<string, Param>; // level 2: parametric
  ops: Record<string, OpNode>;   // level 3: construction
  opOrder: string[];
  output: string | null;
  material: Material;
  partMaterials?: Array<{ parts: string; material: Material }>; // glob → material; later entries win
  position: [number, number, number];
  rotation?: number;             // degrees about Y, around the object's origin
  place?: Placement;             // relation to another object (position is then derived)
  instanceOf?: string;           // linked copy: geometry, params and materials come from this object
  role?: 'model' | 'reference';  // references are shown translucent and excluded from export/overlap checks
  reference?: Reference;
  rules: Rule[];
}

export interface SceneDoc {
  version: 1;
  units: 'm';
  objects: Record<string, SceneObject>;
  objectOrder: string[];
}

export function emptyDoc(): SceneDoc {
  return { version: 1, units: 'm', objects: {}, objectOrder: [] };
}

// Default rules by semantic type — grow these from benchmark failures (Decision 6 assumption).
export const DEFAULT_RULES: Record<string, Rule[]> = {
  stool: [{ kind: 'grounded', parts: 'leg*' }, { kind: 'connected' }, { kind: 'aboveFloor' }],
  chair: [{ kind: 'grounded', parts: 'leg*' }, { kind: 'connected' }, { kind: 'aboveFloor' }],
  table: [{ kind: 'grounded', parts: 'leg*' }, { kind: 'connected' }, { kind: 'aboveFloor' }],
  bench: [{ kind: 'grounded', parts: 'leg*' }, { kind: 'connected' }, { kind: 'aboveFloor' }],
  shelf: [{ kind: 'connected' }, { kind: 'aboveFloor' }],
  reference: [],
  default: [{ kind: 'connected' }],
};
