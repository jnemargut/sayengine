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

export interface Material { name: string; color: string; roughness?: number }

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
  position: [number, number, number];
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
  default: [{ kind: 'connected' }],
};
