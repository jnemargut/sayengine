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
  'collision', 'lod',
  'character',
] as const;
/** Ops that make a side product (a physics shape, a distance version) instead of feeding the output. */
export const AUX_OPS: readonly string[] = ['collision', 'lod'];
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
  | { kind: 'along'; target: string; index: number; count: number; side: 'left' | 'right' | 'front' | 'back'; spacing?: number; gap?: number; face?: Facing; rotate?: number; offset?: [number, number] }
  | { kind: 'held'; target: string; hand: 'left' | 'right' };   // a prop in a character's hand (grip socket → hand)
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
  profile?: GameProfile;         // game export profile: adds budget checks, drives export --target
  orientation?: [number, number, number, number]; // full 3D rotation (quaternion x,y,z,w); set by "held" placement, overrides rotation
  grip?: GripSocket;             // where a hand holds this object (props)
  character?: CharacterState;    // pose, expression, hands and dialogue lines (characters)
  rules: Rule[];
}

/**
 * Where and how a hand holds a prop, in the prop's object space (Decision 22).
 * axis points from the grip toward the working end (a hammer's head); side is perpendicular to it.
 */
export interface GripSocket {
  kind: 'power' | 'pinch';
  center: [number, number, number];
  axis: [number, number, number];
  side: [number, number, number];
  radius: number;                // handle radius (power) or half the pinched thickness (pinch)
  curl?: number;                 // finger curl that wraps the handle without passing through (0..1)
  thumb?: number;
  auto?: boolean;                // generated from the shape (studio set-grip overrides)
}

/** A hand pose as settings (Decision 22): curl per finger 0 (straight) … 1 (fist), spread, thumb. */
export interface HandPose {
  thumb: number; index: number; middle: number; ring: number; little: number;
  spread: number;
  name?: string;                 // the named pose it started from (relaxed, fist, point, pinch, open-palm)
}

/** A spoken line (Decision 21): audio + script aligned into speech-shape curves, reviewable. */
export interface LineClip {
  text: string;
  audio: string;                 // asset name (wav)
  voice?: string;                // local text-to-speech voice, when generated
  voiceLicence?: string;         // e.g. "Kokoro-82M, Apache-2.0" (THIRD_PARTY.md); absent for the user's own recordings
  emotion: string;
  duration: number;              // s
  fps: number;
  cues: Array<{ start: number; end: number; shape: string }>;   // aligner output (Rhubarb A–H, X), rests in pauses
  curves: Record<string, number[]>;                            // speech shape → weight per frame (0..1)
  aligner: string;
  sync?: number;                 // ms the mouth trails the voice (negative = leads), measured at record time
  phonemes?: Array<{ start: number; end: number; ph: string; viseme: string; stress: number; word: number }>; // when the text was phonemized: what drives the 15 shapes
  life?: LineLife;               // blinks, eye darts and brow lifts while speaking (seeded; see life.ts)
}

/** The face's life during a line (the start of week 5's life layer): extra shape-key curves and the gaze, per frame. */
export interface LineLife {
  seed: number;
  curves: Record<string, number[]>;        // e.g. eyeBlinkLeft/Right, browInnerUp (0..1)
  gaze: { yaw: number[]; pitch: number[] }; // degrees, added to the eyes' pose (+yaw = character's left, +pitch = up)
  blinks: number[];                         // blink start times (s)
}

export interface CharacterState {
  pose?: Record<string, [number, number, number]>;  // bone → local rotation (degrees, XYZ)
  expression?: Record<string, number>;              // shape key → weight 0..1
  hands?: { left?: HandPose; right?: HandPose };
  holds?: { left?: string; right?: string };        // object ids held in each hand
  lines?: Record<string, LineClip>;
}

/** A game export profile (Decision 17): budgets shown as checks after every step. */
export interface GameProfile {
  name: 'godot-desktop' | 'web' | 'web-mobile';
  triangles?: number;            // overrides of the profile's budgets
  texture?: number;              // baked texture size in px (square)
  textureMax?: number;
  materials?: number;
  bones?: number;
  weights?: number;
  shapes?: number;               // face shape keys (morph targets) per character
  fingers?: boolean;             // keep finger bones (web-mobile drops them by default)
  collision?: boolean;           // require a collision shape
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
  character: [{ kind: 'aboveFloor' }],
  reference: [],
  default: [{ kind: 'connected' }],
};
