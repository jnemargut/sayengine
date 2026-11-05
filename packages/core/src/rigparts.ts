// Rig parts (Decision 52 A): any shape gets a skeleton assembled from parts, and every part brings
// its own procedural motion, style settings and the checks that say what "right" means for it
// (Decision 54 A). Parts: legs ×N, chains (spines, tails, tentacles, snakes), wheels with springy
// suspension, hinges and sliders with limits, spring bones, and swaying blades (grass, flags).
// The skeleton is plain bones in object space (rest orientation = identity, like the character kit):
// each piece of the body rides one bone rigidly, so a creature exports as a node hierarchy with
// TRS animation that Godot and three.js both play natively.
// Faces +Z, Y up, ground at y = 0. DOM-free.
import { qAxisAngle, qIdentity, qMul, qRot, type BoneDef, type Q, type V3 } from './rig.ts';
import { qAngle, qArc, qInv, qSlerp } from './motion.ts';

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (u: number) => { const t = clamp(u); return t * t * (3 - 2 * t); };
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const mod1 = (x: number) => x - Math.floor(x);

// ── shapes and pieces ───────────────────────────────────────────────────────────────────────────

/** A body shape in object space (rest pose). */
export type PartShape =
  | { kind: 'box'; c: V3; size: V3 }
  | { kind: 'seg'; a: V3; b: V3; r1: number; r2: number; sides?: number }
  | { kind: 'ball'; c: V3; r: number; sides?: number; scale?: V3 }
  | { kind: 'wheel'; c: V3; r: number; w: number; spokes?: number }        // axle along X
  | { kind: 'blade'; a: V3; b: V3; w: number; normal?: V3; taper?: number };   // a thin slab (grass, sails); taper = tip width ÷ base width

/** One rigid piece of the body, riding one bone. */
export interface PartPiece { bone: string; shape: PartShape; color: string; part: string }

/** What a contact point is allowed to do while it carries weight. */
export interface ContactDecl {
  bone: string;
  at: V3;                          // rest object-space point (moves with the bone)
  kind: 'foot' | 'wheel' | 'belly';
  part: string;
  slideAxis?: V3;                  // bone-local direction it may slide along (a snake's belly slides along its body)
}

/** A joint limit: a cone (maxDeg away from rest), or a hinge (rotation about one axis within [min, max]). */
export type JointLimit = { kind: 'cone'; maxDeg: number } | { kind: 'hinge'; axis: V3; min: number; max: number; offAxis?: number };

// ── part specs ───────────────────────────────────────────────────────────────────────────────────

export interface BodyPartSpec { kind: 'body'; id?: string; shape: 'box' | 'ball' | 'capsule'; size: V3; height: number; color: string; style?: { bob?: number; sway?: number; eyes?: string } }
export interface LegsPartSpec {
  kind: 'legs'; id: string; count: number;            // 2, 4, 6 or 8 (pairs on the body's sides)
  upper: number; lower: number;                        // segment lengths (m)
  spread: number;                                      // foot distance outward from the body side (m)
  span?: number;                                       // fraction of the body length the hips spread over (0..1)
  kneeUp?: number;                                     // how high the knee sits above the hip (m)
  radius: number; color: string;
  lift?: number;                                       // swing foot height (× upper)
  duty?: number;                                       // fraction of a cycle each foot carries weight
}
export interface ChainPartSpec {
  kind: 'chain'; id: string; parent?: string;          // attach bone (default Body)
  at: V3; dir: V3; length: number; segments: number;
  r0: number; r1: number; color: string;
  motion?: 'wave' | 'whip' | 'coil' | 'reach' | 'serpent' | 'follow';
  plane?: 'yaw' | 'pitch';                             // which way it bends (yaw: side to side; pitch: up and down)
  amp?: number; freq?: number;                         // degrees at the tip; cycles per second (wave/whip)
  target?: V3;                                         // reach: object-space point the tip reaches for
  ground?: boolean;                                    // serpent: the chain lies on the ground and carries the body
  wavelength?: number;                                 // serpent: path wavelength (m)
}
export interface WheelsPartSpec {
  kind: 'wheels'; id: string;
  axles: Array<{ z: number; track: number; r: number; w: number }>;   // axle z, wheel-to-wheel width, radius, tyre width
  ride: number;                                        // body height above the wheel hubs at rest (m)
  travel: number;                                      // suspension travel each way (m)
  hz?: number; damp?: number;                          // body bounce frequency and damping
  color: string; hub?: string;
}
export interface HingePartSpec {
  kind: 'hinge'; id: string; parent?: string; at: V3; axis: V3;
  shapes: Array<{ shape: PartShape; color: string }>;  // what turns (object space, rest)
  motion: { kind: 'spin'; rpm: number } | { kind: 'swing'; min: number; max: number; period: number } | { kind: 'still' };
  limit?: { min: number; max: number };                // degrees (spinners have none)
}
export interface SliderPartSpec {
  kind: 'slider'; id: string; parent?: string; at: V3; axis: V3; range: [number, number]; period: number;
  shapes: Array<{ shape: PartShape; color: string }>;
}
export interface SpringPartSpec {
  kind: 'spring'; id: string; parent?: string; at: V3; dir: V3; length: number; r: number; color: string;
  hz?: number; damp?: number;
}
export interface SwayPartSpec {
  kind: 'sway'; id: string; area: [number, number, number, number];  // x0, z0, x1, z1
  count: number; height: number; width?: number; wind?: V3; strength?: number; color: string; seed?: number;
  mode?: 'bones' | 'shader';      // bones: a bone per blade, baked (default); shader: one static mesh, a vertex shader bends it (engines get the shader)
}

/** The sway the shader applies (and the bones bake): bend angle (deg) of a blade at time t, with its root at (x, z). */
export function swayDeg(p: SwayPartSpec, t: number, x: number, z: number, i = 0, per = 1 / 2.2, energy = 0.5): number {
  const w = norm(p.wind ?? [1, 0, 0.3]);
  const str = (p.strength ?? 14) * (0.6 + energy * 0.8);
  const ph = (TAU / 2.5) * (x * w[0] + z * w[2]);
  return str * (0.55 + 0.45 * Math.sin(TAU * per * t - ph)) + 3 * Math.sin(TAU * per * 3 * t + i);
}
export type PartSpec = BodyPartSpec | LegsPartSpec | ChainPartSpec | WheelsPartSpec | HingePartSpec | SliderPartSpec | SpringPartSpec | SwayPartSpec;

/** Uneven ground: sums of sines, periodic along Z with `period` so a driving loop closes. */
export interface TerrainSpec { period: number; bumps: Array<{ amp: number; k: number; phase?: number; kx?: number }>; color?: string }
export function terrainHeight(t: TerrainSpec | undefined, x: number, z: number): number {
  if (!t) return 0;
  let h = 0;
  for (const b of t.bumps) h += b.amp * Math.sin((TAU * b.k * z) / t.period + (b.phase ?? 0)) * (b.kx ? 0.5 + 0.5 * Math.cos(b.kx * x) : 1);
  return h;
}

export interface CreatureDef { name: string; parts: PartSpec[]; terrain?: TerrainSpec }

// ── the built creature ─────────────────────────────────────────────────────────────────────────

export interface BuiltPart { spec: PartSpec; bones: string[]; contacts: number[]; checks: string[] }
export interface Creature {
  def: CreatureDef;
  bones: BoneDef[];
  parents: number[];
  index: Map<string, number>;
  pieces: PartPiece[];
  contacts: ContactDecl[];
  limits: Record<string, JointLimit>;
  spinners: Set<string>;           // bones that turn continuously (wheels, sails): no pop or loop-angle limits
  parts: BuiltPart[];
  size: number;                    // the body's longest dimension (checks scale with it)
  legs: Array<{ part: string; hip: string; knee: string; foot: V3; side: 1 | -1; pair: number }>;
}

function addBone(c: { bones: BoneDef[] }, name: string, parent: string | null, head: V3, tail: V3) {
  if (c.bones.some((b) => b.name === name)) throw new Error(`two bones named ${name}`);
  c.bones.push({ name, parent, head, tail });
}

/** Assemble a creature from its parts: skeleton, pieces, contacts, limits. */
export function buildCreature(def: CreatureDef): Creature {
  const bones: BoneDef[] = [];
  const pieces: PartPiece[] = [];
  const contacts: ContactDecl[] = [];
  const limits: Record<string, JointLimit> = {};
  const spinners = new Set<string>();
  const parts: BuiltPart[] = [];
  const legs: Creature['legs'] = [];
  const C = { bones };
  const body = def.parts.find((p): p is BodyPartSpec => p.kind === 'body');
  if (!body) throw new Error(`${def.name}: a creature needs one body part`);
  const [bw, bh, bl] = body.size;
  const bodyY = body.height;
  for (const spec of def.parts) {
    const before = bones.length, cBefore = contacts.length;
    const checks: string[] = [];
    switch (spec.kind) {
      case 'body': {
        addBone(C, 'Body', null, [0, bodyY, 0], [0, bodyY, bl / 2]);
        const shape: PartShape = spec.shape === 'box' ? { kind: 'box', c: [0, bodyY, 0], size: spec.size }
          : spec.shape === 'ball' ? { kind: 'ball', c: [0, bodyY, 0], r: Math.max(bw, bh, bl) / 2, scale: [bw / Math.max(bw, bh, bl), bh / Math.max(bw, bh, bl), bl / Math.max(bw, bh, bl)], sides: 14 }
            : { kind: 'seg', a: [0, bodyY, -bl / 2 + bw / 2], b: [0, bodyY, bl / 2 - bw / 2], r1: bw / 2, r2: bw / 2, sides: 12 };
        pieces.push({ bone: 'Body', shape, color: spec.color, part: 'body' });
        if (spec.shape === 'capsule' && shape.kind === 'seg') for (const e of [shape.a, shape.b]) pieces.push({ bone: 'Body', shape: { kind: 'ball', c: e, r: bw / 2, sides: 12, scale: [1, bh / bw, 1] }, color: spec.color, part: 'body' });
        if (spec.style?.eyes) for (const side of [1, -1]) pieces.push({ bone: 'Body', shape: { kind: 'ball', c: [side * bw * 0.32, bodyY + bh * 0.32, bl / 2 - bw * 0.3], r: Math.max(0.006, bw * 0.12), sides: 8 }, color: spec.style.eyes, part: 'body' });
        break;
      }
      case 'legs': {
        if (spec.count % 2 || spec.count < 2 || spec.count > 8) throw new Error(`legs ${spec.id}: count must be 2, 4, 6 or 8`);
        const pairs = spec.count / 2;
        const span = (spec.span ?? 0.75) * bl;
        for (let i = 0; i < pairs; i++) {
          const z = pairs === 1 ? 0 : span / 2 - (span * i) / (pairs - 1);
          for (const side of [1, -1] as const) {
            const tag = `${side > 0 ? 'L' : 'R'}${i + 1}`;
            const hip: V3 = [side * bw / 2 * 0.9, bodyY - bh * 0.1, z];
            const foot: V3 = [side * (bw / 2 + spec.spread), 0, z * 1.15];
            // the knee: up and out, so the lower segment reaches down to the foot
            const out = norm([foot[0] - hip[0], 0, foot[2] - hip[2]]);
            const dHoriz = Math.hypot(foot[0] - hip[0], foot[2] - hip[2]);
            const kneeUp = spec.kneeUp ?? spec.upper * 0.45;
            const kh = Math.min(spec.upper * 0.95, Math.sqrt(Math.max(0, spec.upper * spec.upper - kneeUp * kneeUp)));
            const knee: V3 = [hip[0] + out[0] * Math.min(kh, dHoriz * 0.6), hip[1] + kneeUp, hip[2] + out[2] * Math.min(kh, dHoriz * 0.6)];
            const upper = `${spec.id}.${tag}.upper`, lower = `${spec.id}.${tag}.lower`;
            addBone(C, upper, 'Body', hip, knee);
            addBone(C, lower, upper, knee, foot);
            pieces.push({ bone: upper, shape: { kind: 'seg', a: hip, b: knee, r1: spec.radius, r2: spec.radius * 0.85, sides: 6 }, color: spec.color, part: spec.id });
            pieces.push({ bone: lower, shape: { kind: 'seg', a: knee, b: [foot[0], foot[1] + spec.radius * 0.6, foot[2]], r1: spec.radius * 0.85, r2: spec.radius * 0.45, sides: 6 }, color: spec.color, part: spec.id });
            pieces.push({ bone: lower, shape: { kind: 'ball', c: knee, r: spec.radius * 1.05, sides: 8 }, color: spec.color, part: spec.id });
            contacts.push({ bone: lower, at: [foot[0], foot[1] + spec.radius * 0.45, foot[2]], kind: 'foot', part: spec.id });
            limits[upper] = { kind: 'cone', maxDeg: 70 };
            limits[lower] = { kind: 'cone', maxDeg: 85 };
            legs.push({ part: spec.id, hip: upper, knee: lower, foot, side, pair: i });
          }
        }
        checks.push('feet planted (no sliding)', 'feet on the ground', 'balance over the feet', 'leg reach');
        break;
      }
      case 'chain': {
        const parent = spec.parent ?? 'Body';
        const dir = norm(spec.dir);
        const seg = spec.length / spec.segments;
        let prev = parent;
        for (let i = 0; i < spec.segments; i++) {
          const a = add(spec.at, mul(dir, seg * i)), b = add(spec.at, mul(dir, seg * (i + 1)));
          const name = `${spec.id}.${i + 1}`;
          addBone(C, name, prev, a, b);
          const r1 = lerp(spec.r0, spec.r1, i / spec.segments), r2 = lerp(spec.r0, spec.r1, (i + 1) / spec.segments);
          // each segment overlaps the next a little, so bends don't open gaps
          pieces.push({ bone: name, shape: { kind: 'seg', a, b: add(b, mul(dir, Math.min(r2, seg * 0.35))), r1, r2, sides: 10 }, color: spec.color, part: spec.id });
          if (i > 0) pieces.push({ bone: name, shape: { kind: 'ball', c: a, r: r1 * 1.02, sides: 10 }, color: spec.color, part: spec.id });   // a rounded joint: bends stay closed
          limits[name] = { kind: 'cone', maxDeg: spec.motion === 'coil' ? 70 : 55 };
          if (spec.ground) contacts.push({ bone: name, at: [(a[0] + b[0]) / 2, Math.max(0, (a[1] + b[1]) / 2 - r1), (a[2] + b[2]) / 2], kind: 'belly', part: spec.id, slideAxis: dir });
          prev = name;
        }
        checks.push(spec.ground ? 'belly slides only along the body' : 'chain stays within its bend limits');
        break;
      }
      case 'wheels': {
        spec.axles.forEach((ax, ai) => {
          for (const side of [1, -1] as const) {
            const tag = `${ai === 0 ? 'F' : ai === spec.axles.length - 1 ? 'R' : `M${ai}`}${side > 0 ? 'L' : 'R'}`;
            const hub: V3 = [side * ax.track / 2, ax.r, ax.z];
            const strut = `${spec.id}.${tag}.strut`, wheel = `${spec.id}.${tag}`;
            addBone(C, strut, 'Body', hub, add(hub, [0, spec.ride, 0]));
            addBone(C, wheel, strut, hub, add(hub, [side * ax.w / 2, 0, 0]));
            pieces.push({ bone: wheel, shape: { kind: 'wheel', c: hub, r: ax.r, w: ax.w, spokes: 5 }, color: spec.color, part: spec.id });
            pieces.push({ bone: wheel, shape: { kind: 'box', c: add(hub, [side * ax.w * 0.52, 0, 0]), size: [ax.w * 0.08, ax.r * 0.9, ax.r * 0.22] }, color: spec.hub ?? '#c9c2b4', part: spec.id });
            contacts.push({ bone: wheel, at: [hub[0], 0, hub[2]], kind: 'wheel', part: spec.id });
            spinners.add(wheel);
            limits[strut] = { kind: 'cone', maxDeg: 10 };
          }
        });
        checks.push('wheels roll at ground speed', 'suspension within its travel', 'tyres touch the ground');
        break;
      }
      case 'hinge': {
        const name = spec.id;
        addBone(C, name, spec.parent ?? 'Body', spec.at, add(spec.at, mul(norm(spec.axis), 0.1)));
        for (const s of spec.shapes) pieces.push({ bone: name, shape: s.shape, color: s.color, part: spec.id });
        if (spec.motion.kind === 'spin') spinners.add(name);
        if (spec.limit) limits[name] = { kind: 'hinge', axis: norm(spec.axis), min: spec.limit.min, max: spec.limit.max };
        checks.push(spec.motion.kind === 'spin' ? 'turns smoothly' : 'stays within its limits');
        break;
      }
      case 'slider': {
        addBone(C, spec.id, spec.parent ?? 'Body', spec.at, add(spec.at, mul(norm(spec.axis), 0.1)));
        for (const s of spec.shapes) pieces.push({ bone: spec.id, shape: s.shape, color: s.color, part: spec.id });
        limits[spec.id] = { kind: 'cone', maxDeg: 0.5 };
        checks.push('slides within its range');
        break;
      }
      case 'spring': {
        const b = add(spec.at, mul(norm(spec.dir), spec.length));
        addBone(C, spec.id, spec.parent ?? 'Body', spec.at, b);
        pieces.push({ bone: spec.id, shape: { kind: 'seg', a: spec.at, b, r1: spec.r, r2: spec.r * 0.5, sides: 6 }, color: spec.color, part: spec.id });
        pieces.push({ bone: spec.id, shape: { kind: 'ball', c: b, r: spec.r * 1.6, sides: 8 }, color: spec.color, part: spec.id });
        limits[spec.id] = { kind: 'cone', maxDeg: 45 };
        checks.push('settles (springs come to rest)');
        break;
      }
      case 'sway': {
        let s = spec.seed ?? 7;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const [x0, z0, x1, z1] = spec.area;
        for (let i = 0; i < spec.count; i++) {
          const x = lerp(x0, x1, rnd()), z = lerp(z0, z1, rnd());
          const h = spec.height * (0.7 + 0.6 * rnd());
          const lean = (rnd() - 0.5) * 0.3;
          const a: V3 = [x, 0, z], b: V3 = [x + lean * h, h, z + (rnd() - 0.5) * 0.2 * h];
          if (spec.mode === 'shader') {
            if (i === 0) addBone(C, spec.id, null, [0, 0, 0], [0, spec.height, 0]);
            pieces.push({ bone: spec.id, shape: { kind: 'blade', a, b, w: spec.width ?? 0.05 }, color: spec.color, part: spec.id });
            continue;
          }
          const name = `${spec.id}.${i + 1}`;
          addBone(C, name, null, a, b);
          pieces.push({ bone: name, shape: { kind: 'blade', a, b, w: spec.width ?? 0.05 }, color: spec.color, part: spec.id });
          limits[name] = { kind: 'cone', maxDeg: 40 };
        }
        checks.push(spec.mode === 'shader' ? 'shader sway within the bend limit' : 'sways without popping');
        break;
      }
    }
    parts.push({ spec, bones: bones.slice(before).map((b) => b.name), contacts: contacts.slice(cBefore).map((_, i) => cBefore + i), checks });
  }
  const index = new Map(bones.map((b, i) => [b.name, i]));
  for (const b of bones) if (b.parent && !index.has(b.parent)) throw new Error(`${b.name}: parent ${b.parent} doesn't exist`);
  // parents before children (stable): sort topologically
  const order: BoneDef[] = [];
  const placed = new Set<string>();
  while (order.length < bones.length) {
    let moved = false;
    for (const b of bones) if (!placed.has(b.name) && (!b.parent || placed.has(b.parent))) { order.push(b); placed.add(b.name); moved = true; }
    if (!moved) throw new Error('bone parents form a loop');
  }
  const idx = new Map(order.map((b, i) => [b.name, i]));
  const ext = order.flatMap((b) => [b.head, b.tail]);
  const span3 = [0, 1, 2].map((k) => Math.max(...ext.map((p) => p[k])) - Math.min(...ext.map((p) => p[k])));
  return {
    def, bones: order, parents: order.map((b) => (b.parent ? idx.get(b.parent)! : -1)), index: idx,
    pieces, contacts, limits, spinners, parts, size: Math.max(bw, bh, bl, def.parts.some((p) => p.kind === 'sway') ? 0 : Math.max(span3[0], span3[2])), legs,
  };
}

// ── motion ───────────────────────────────────────────────────────────────────────────────────────

export interface CreatureMotion {
  kind: 'idle' | 'walk' | 'drive' | 'slither' | 'still';
  speed?: number;                  // m/s
  dir?: V3;                        // travel direction (object space; a crab walks sideways: [1,0,0])
  duration?: number;               // s (idle/still loops)
  energy?: number;                 // 0..1: bigger bob, faster waves
}

export interface CreatureClip {
  id: string;
  kind: CreatureMotion['kind'];
  fps: number;
  frames: number;                  // frames in [0, duration); frame `frames` closes the loop
  duration: number;
  loop: boolean;
  speed: number;
  dir: V3;
  rot: Q[][];                      // [frame][bone] local rotation (rest orientation is identity)
  off: V3[][];                     // [frame][bone] local translation added to the rest offset
  contacts: boolean[][];           // [frame][contact] carrying weight
  notes: string[];
  reachMiss: number;               // worst distance a foot target was beyond reach (m)
  seam?: { rot: Q[]; off: V3[] };  // the pose computed at t = duration, before the loop is closed onto frame 0
}

export interface FK { rot: Q[]; pos: V3[] }            // world rotation and world head position per bone

/** World transforms from local rotations and translation offsets (in place; add travel for world). */
export function creatureFK(c: Pick<Creature, 'bones' | 'parents'>, rot: Q[], off: V3[]): FK {
  const n = c.bones.length;
  const wr: Q[] = new Array(n), wp: V3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = c.bones[i], p = c.parents[i];
    if (p < 0) { wr[i] = rot[i]; wp[i] = add(b.head, off[i]); continue; }
    const rel = add(sub(b.head, c.bones[p].head), off[i]);
    wr[i] = qMul(wr[p], rot[i]);
    wp[i] = add(wp[p], qRot(wr[p], rel));
  }
  return { rot: wr, pos: wp };
}

/** Where a rest point on a bone is, given world transforms. */
export const bonePoint = (c: Pick<Creature, 'bones'>, fk: FK, b: number, rest: V3): V3 => add(fk.pos[b], qRot(fk.rot[b], sub(rest, c.bones[b].head)));

/** Gait phases per leg (fraction of a cycle each foot lifts at): alternating tripods for six legs,
 *  alternating tetrapods for eight, a lateral sequence for four, alternate for two. */
export function gaitPhase(count: number, pair: number, side: 1 | -1): number {
  const left = side > 0;
  if (count === 2) return left ? 0 : 0.5;
  if (count === 4) return pair === 0 ? (left ? 0.25 : 0.75) : (left ? 0 : 0.5);   // LH 0, LF .25, RH .5, RF .75
  // six/eight: legs alternate down the body and across it (tripods / tetrapods)
  return ((pair % 2 === 0) === left) ? 0 : 0.5;
}

/** Analytic two-bone IK: the knee position for a hip, foot target and segment lengths, bending toward `pole`. */
export function twoBoneKnee(hip: V3, target: V3, l1: number, l2: number, pole: V3): { knee: V3; foot: V3; miss: number } {
  let d = sub(target, hip);
  let dist = len(d);
  const maxR = (l1 + l2) * 0.999, minR = Math.abs(l1 - l2) * 1.001 + 1e-4;
  const miss = Math.max(0, dist - maxR);
  const reach = clamp(dist, minR, maxR);
  const dirN = norm(d);
  const foot = add(hip, mul(dirN, reach));
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let bend = sub(pole, mul(dirN, dot(pole, dirN)));
  if (len(bend) < 1e-6) bend = Math.abs(dirN[1]) < 0.9 ? cross(dirN, [0, 1, 0]) : cross(dirN, [1, 0, 0]);
  const knee = add(add(hip, mul(dirN, a)), mul(norm(bend), h));
  return { knee, foot, miss };
}

/** FABRIK: joint positions of a chain from `base` reaching `target` (keeps segment lengths). */
export function fabrik(points: V3[], target: V3, iters = 12): V3[] {
  const p = points.map((x) => [...x] as V3);
  const L = p.slice(1).map((x, i) => len(sub(x, p[i])));
  const base = p[0];
  const total = L.reduce((a, b) => a + b, 0);
  if (len(sub(target, base)) >= total) {
    const d = norm(sub(target, base));
    for (let i = 1; i < p.length; i++) p[i] = add(p[i - 1], mul(d, L[i - 1]));
    return p;
  }
  for (let it = 0; it < iters; it++) {
    p[p.length - 1] = target;
    for (let i = p.length - 2; i >= 0; i--) p[i] = add(p[i + 1], mul(norm(sub(p[i], p[i + 1])), L[i]));
    p[0] = base;
    for (let i = 1; i < p.length; i++) p[i] = add(p[i - 1], mul(norm(sub(p[i], p[i - 1])), L[i - 1]));
    if (len(sub(p[p.length - 1], target)) < 1e-4) break;
  }
  return p;
}

/** Turn world joint positions of a bone chain into local rotations (shortest arc per segment). */
export function chainLocals(c: Creature, names: string[], joints: V3[], parentWorld: Q): Q[] {
  const out: Q[] = [];
  let pw = parentWorld;
  names.forEach((n, i) => {
    const b = c.bones[c.index.get(n)!];
    const rest = norm(sub(b.tail, b.head));
    const want = norm(sub(joints[i + 1], joints[i]));
    const world = qArc(rest, want);
    const local = qMul(qInv(pw), world);
    out.push(local);
    pw = world;
  });
  return out;
}

/** Bake a motion into a clip: every part runs its own procedural motion. */
export function bakeCreature(c: Creature, id: string, m: CreatureMotion, fps = 30): CreatureClip {
  const n = c.bones.length;
  const energy = m.energy ?? 0.5;
  const legsParts = c.def.parts.filter((p): p is LegsPartSpec => p.kind === 'legs');
  const wheels = c.def.parts.find((p): p is WheelsPartSpec => p.kind === 'wheels');
  const serpent = c.def.parts.find((p): p is ChainPartSpec => p.kind === 'chain' && p.motion === 'serpent');
  const body = c.def.parts.find((p): p is BodyPartSpec => p.kind === 'body')!;
  const notes: string[] = [];
  let speed = m.kind === 'walk' || m.kind === 'drive' || m.kind === 'slither' ? (m.speed ?? 0.6) : 0;
  const dir = norm(m.dir ?? [0, 0, 1]);
  // cycle length: a gait cycle (legs), a road loop (wheels: whole wheel turns), a body wave (snake)
  let duration = m.duration ?? 3;
  let legCycle = 1, stride = 0;
  if (m.kind === 'walk' && legsParts.length) {
    const lp = legsParts[0];
    const reach = lp.upper + lp.lower;
    // stride: how far a foot sweeps while it carries weight; the cycle is set so stance feet stay put
    const duty0 = lp.duty ?? (lp.count >= 6 ? 0.62 : lp.count === 4 ? 0.7 : 0.6);
    stride = Math.min(reach * 0.55, Math.max(0.08, speed * 0.6)) * (lp.count >= 6 ? 0.8 : 1);
    legCycle = stride / (speed * duty0);
    duration = legCycle * Math.max(1, Math.round(2 / legCycle));
  } else if (m.kind === 'drive' && wheels) {
    const r = wheels.axles[0].r;
    const period = c.def.terrain?.period ?? 8;
    // the loop is one road period; the wheels must turn a whole number of times over it
    const turns = Math.max(1, Math.round(period / (TAU * r)));
    const fixedR = period / (TAU * turns);
    if (Math.abs(fixedR - r) > 1e-6) notes.push(`wheel radius ${r3(r)} m → loop of ${turns} turns over the ${period} m road (rolls at ${r3(fixedR)} m)`);
    duration = period / speed;
  } else if (m.kind === 'slither' && serpent) {
    const lambda = serpent.wavelength ?? serpent.length * 0.6;
    duration = lambda / speed;
  } else if (m.kind === 'walk' && !legsParts.length) {
    throw new Error(`${c.def.name} has no legs to walk with`);
  }
  // spinners: whole turns over the loop
  for (const p of c.def.parts) if (p.kind === 'hinge' && p.motion.kind === 'spin') {
    const turns = (p.motion.rpm / 60) * duration;
    if (Math.abs(turns - Math.round(turns)) > 1e-3 && m.kind !== 'drive' && m.kind !== 'walk' && m.kind !== 'slither') duration = Math.max(1, Math.round(turns)) / (p.motion.rpm / 60);
  }
  const frames = Math.max(2, Math.round(duration * fps));
  // whole frames: rescale the cycle (and the speed that goes with it) so the loop still closes exactly
  const scale = frames / fps / duration;
  duration = frames / fps;
  if (Math.abs(scale - 1) > 1e-9) {
    if (m.kind === 'walk' && legsParts.length) { legCycle *= scale; speed /= scale; }
    else if (m.kind === 'drive' || m.kind === 'slither') speed /= scale;
  }
  // swings and slides: a whole number of periods over the loop
  const fitPeriod = (per: number) => duration / Math.max(1, Math.round(duration / per));
  const rot: Q[][] = [], off: V3[][] = [];
  const contactsOut: boolean[][] = [];
  let reachMiss = 0;
  const bi = (name: string) => c.index.get(name)!;
  // springs: integrated over two cycles so the loop closes on a settled state
  const springState = new Map<string, { a: V3; v: V3 }>();
  const prevWorld: Array<FK | null> = [null, null];
  const wheelState = { y: 0, vy: 0, pitch: 0, vp: 0, roll: 0, vr: 0 };
  const warm = wheels || c.def.parts.some((p) => p.kind === 'spring') ? 2 : 1;
  for (let pass = 0; pass < warm; pass++) {
    for (let f = 0; f <= frames; f++) {
      const t = f / fps;
      const R: Q[] = new Array(n).fill(null).map(() => qIdentity());
      const O: V3[] = new Array(n).fill(null).map(() => [0, 0, 0] as V3);
      const down: boolean[] = new Array(c.contacts.length).fill(false);
      const travel = mul(dir, speed * t);
      const ground = (p: V3) => terrainHeight(c.def.terrain, p[0] + travel[0], p[2] + travel[2]);
      // ── the body: bob and sway (idle), carried by legs or wheels ──
      const bob = (body.style?.bob ?? 0.012) * (0.5 + energy);
      let bodyOff: V3 = [0, 0, 0];
      let bodyRot = qIdentity();
      if (m.kind === 'idle' || m.kind === 'still') {
        const breathe = m.kind === 'still' ? 0 : Math.sin((TAU * t) / duration);
        bodyOff = [0, bob * 0.5 * breathe, 0];
        bodyRot = qAxisAngle([0, 0, 1], (body.style?.sway ?? 1) * 0.8 * Math.sin((TAU * t) / duration + 1));
      }
      // ── legs: stance feet stay put in the world; swing feet arc forward; the body rides on them ──
      if (legsParts.length) {
        const feet: Array<{ leg: Creature['legs'][number]; target: V3; down: boolean; lp: LegsPartSpec }> = [];
        for (const leg of c.legs) {
          const lp = legsParts.find((p) => p.id === leg.part)!;
          const duty = lp.duty ?? (lp.count >= 6 ? 0.62 : lp.count === 4 ? 0.7 : 0.6);
          let target: V3 = [...leg.foot] as V3;
          let isDown = true;
          if (m.kind === 'walk') {
            const u = mod1(t / legCycle - gaitPhase(lp.count, leg.pair, leg.side));
            // u in [0, duty): stance, the foot moves back (in place) as the body moves forward
            let along: number, lift = 0;
            if (u < duty) { along = stride / 2 - (stride * u) / duty; }  // = speed × time in stance (stride = speed·duty·cycle)
            else { const s = (u - duty) / (1 - duty); along = -stride / 2 + stride * smooth(s); lift = Math.sin(Math.PI * s) * (lp.lift ?? 0.35) * lp.upper; isDown = false; }
            target = add(target, mul(dir, along));
            target[1] = lift;
          }
          target[1] += ground(target);
          feet.push({ leg, target, down: isDown, lp });
        }
        // the body: average height of planted feet, tilted to their plane (pitch along, roll across)
        const planted = feet.filter((f) => f.down);
        const avg = planted.reduce((s, f) => s + f.target[1], 0) / Math.max(1, planted.length);
        const front = planted.filter((f) => f.leg.foot[2] > 0), back = planted.filter((f) => f.leg.foot[2] < 0);
        const left = planted.filter((f) => f.leg.side > 0), right = planted.filter((f) => f.leg.side < 0);
        const meanY = (xs: typeof feet) => xs.reduce((s, f) => s + f.target[1], 0) / Math.max(1, xs.length);
        const meanZ = (xs: typeof feet) => xs.reduce((s, f) => s + f.leg.foot[2], 0) / Math.max(1, xs.length);
        const meanX = (xs: typeof feet) => xs.reduce((s, f) => s + f.leg.foot[0], 0) / Math.max(1, xs.length);
        const pitch = front.length && back.length ? -Math.atan2(meanY(front) - meanY(back), meanZ(front) - meanZ(back)) / D2R : 0;
        const roll = left.length && right.length ? Math.atan2(meanY(left) - meanY(right), meanX(left) - meanX(right)) / D2R : 0;
        const gait = m.kind === 'walk' ? Math.cos((TAU * 2 * t) / legCycle) : 0;
        bodyOff = add(bodyOff, [0, avg + bob * gait, 0]);
        bodyRot = qMul(bodyRot, qMul(qAxisAngle([1, 0, 0], pitch * 0.8), qAxisAngle([0, 0, 1], roll * 0.8)));
        O[bi('Body')] = bodyOff;
        R[bi('Body')] = bodyRot;
        const bodyHead = add(c.bones[bi('Body')].head, bodyOff);
        for (const ft of feet) {
          const hipB = c.bones[bi(ft.leg.hip)], kneeB = c.bones[bi(ft.leg.knee)];
          const hipW = add(bodyHead, qRot(bodyRot, sub(hipB.head, c.bones[bi('Body')].head)));
          const l1 = len(sub(hipB.tail, hipB.head)), l2 = len(sub(kneeB.tail, kneeB.head));
          const pole = add(qRot(bodyRot, [ft.leg.side, 0, 0]), [0, 1.2, 0]);
          const ik = twoBoneKnee(hipW, ft.target, l1, l2, pole);
          reachMiss = Math.max(reachMiss, ik.miss);
          const locals = chainLocals(c, [ft.leg.hip, ft.leg.knee], [hipW, ik.knee, ik.foot], bodyRot);
          R[bi(ft.leg.hip)] = locals[0];
          R[bi(ft.leg.knee)] = locals[1];
          c.contacts.forEach((cd, ci) => { if (cd.bone === ft.leg.knee) down[ci] = ft.down; });
        }
      }
      // ── wheels: hubs follow the road, the body floats on springs above them ──
      if (wheels) {
        const hubs: Array<{ strut: number; wheel: number; ground: number; at: V3 }> = [];
        for (const cd of c.contacts) if (cd.kind === 'wheel') {
          const wi = bi(cd.bone), si = c.parents[wi];
          hubs.push({ strut: si, wheel: wi, ground: ground(cd.at), at: c.bones[wi].head });
        }
        const targetY = hubs.reduce((s, h) => s + h.ground, 0) / hubs.length;
        const fz = hubs.filter((h) => h.at[2] > 0), bz = hubs.filter((h) => h.at[2] <= 0);
        const lx = hubs.filter((h) => h.at[0] > 0), rx = hubs.filter((h) => h.at[0] <= 0);
        const mean = (xs: typeof hubs, k: 'ground') => xs.reduce((s, h) => s + h[k], 0) / Math.max(1, xs.length);
        const wb = Math.max(0.1, (fz[0]?.at[2] ?? 0) - (bz[0]?.at[2] ?? 0));
        const tr = Math.max(0.1, (lx[0]?.at[0] ?? 0) - (rx[0]?.at[0] ?? 0));
        const targetPitch = -Math.atan2(mean(fz, 'ground') - mean(bz, 'ground'), wb) / D2R;
        const targetRoll = Math.atan2(mean(lx, 'ground') - mean(rx, 'ground'), tr) / D2R;
        // damped springs (critically-ish damped); integrated frame to frame
        const w0 = TAU * (wheels.hz ?? 1.6), z0 = wheels.damp ?? 0.55, dt = 1 / fps;
        const step = (x: number, v: number, target: number) => { const a = -w0 * w0 * (x - target) - 2 * z0 * w0 * v; const nv = v + a * dt; return [x + nv * dt, nv]; };
        if (f === 0 && pass === 0) { wheelState.y = targetY; wheelState.pitch = targetPitch; wheelState.roll = targetRoll; }
        else if (f > 0) {
          [wheelState.y, wheelState.vy] = step(wheelState.y, wheelState.vy, targetY);
          [wheelState.pitch, wheelState.vp] = step(wheelState.pitch, wheelState.vp, targetPitch);
          [wheelState.roll, wheelState.vr] = step(wheelState.roll, wheelState.vr, targetRoll);
        }
        const bRot = qMul(qAxisAngle([1, 0, 0], wheelState.pitch), qAxisAngle([0, 0, 1], wheelState.roll));
        O[bi('Body')] = [0, wheelState.y, 0];
        R[bi('Body')] = bRot;
        const bHead = add(c.bones[bi('Body')].head, O[bi('Body')]);
        const r = wheels.axles[0].r;
        const turns = Math.max(1, Math.round((c.def.terrain?.period ?? 8) / (TAU * r)));
        const rollR = (c.def.terrain?.period ?? 8) / (TAU * turns);
        const spin = m.kind === 'drive' ? (speed * t) / rollR / D2R : 0;
        for (const h of hubs) {
          // where the strut's top is with the body as it is; the hub sits on the road below it
          const restRel = sub(c.bones[h.strut].head, c.bones[bi('Body')].head);
          const top = add(bHead, qRot(bRot, restRel));
          const want = h.ground + h.at[1];
          // the strut slides along the body's up axis by the difference (local, body space)
          const upW = qRot(bRot, [0, 1, 0]);
          const slide = (want - top[1]) / Math.max(0.2, upW[1]);
          O[h.strut] = [0, clamp(slide, -wheels.travel * 1.5, wheels.travel * 1.5), 0];
          R[h.strut] = qInv(bRot);                       // the strut stays upright in the world
          R[h.wheel] = qAxisAngle([1, 0, 0], spin);
        }
        c.contacts.forEach((cd, ci) => { if (cd.kind === 'wheel') down[ci] = true; });
      }
      // ── chains ──
      for (const p of c.def.parts) {
        if (p.kind !== 'chain') continue;
        const names = Array.from({ length: p.segments }, (_, i) => `${p.id}.${i + 1}`);
        const amp = p.amp ?? 25, freq = p.freq ?? 0.8 * (0.6 + energy);
        if (p.motion === 'serpent') {
          // the body follows its own path: a sine along the travel direction; every segment sits on the
          // path at its arc length behind the head (follow-the-leader), so the belly slides only along itself
          const lambda = p.wavelength ?? p.length * 0.6;
          const A = (p.amp ?? 0.14) * lambda;
          const side = norm(cross([0, 1, 0], dir));
          const s0 = speed * t;
          const pathAt = (s: number): V3 => add(mul(dir, s - s0), mul(side, A * Math.sin((TAU * s) / lambda)));
          // arc-length walk back from the head
          const segLen = p.length / p.segments;
          const headS = s0 + 0.0;
          const joints: V3[] = [];
          let s = headS;
          const headPt = pathAt(s);
          // the head (Body) points along the path tangent at the head
          const tangent = norm(sub(pathAt(headS + 0.01), headPt));
          const headRot = qArc(dir, tangent);
          const bodyRest = c.bones[bi('Body')].head;
          O[bi('Body')] = [headPt[0] - bodyRest[0] * 0, 0, headPt[2]];
          R[bi('Body')] = headRot;
          // the chain's root joint, attached to the head
          const attachW = add(add(bodyRest, O[bi('Body')]), qRot(headRot, sub(p.at, bodyRest)));
          joints.push(attachW);
          // find the arc length on the path whose point is closest to the attach point (just behind the head)
          s = headS - len(sub(p.at, bodyRest));
          for (let i = 0; i < p.segments; i++) {
            // step back along the path until one segment length away from the previous joint
            let lo = s - segLen * 2, hi = s;
            const from = joints[joints.length - 1];
            for (let it = 0; it < 30; it++) {
              const mid = (lo + hi) / 2;
              const d = len(sub(pathAt(mid), from));
              if (d > segLen) lo = mid; else hi = mid;
            }
            s = (lo + hi) / 2;
            const pt = pathAt(s);
            joints.push([pt[0], from[1], pt[2]]);
          }
          const locals = chainLocals(c, names, joints, headRot);
          names.forEach((nm, i) => { R[bi(nm)] = locals[i]; });
          c.contacts.forEach((cd, ci) => { if (cd.part === p.id) down[ci] = true; });
          continue;
        }
        if (p.motion === 'reach' && p.target) {
          const pi = bi(names[0]);
          const fkNow = creatureFK(c, R, O);
          const baseW = fkNow.pos[pi];
          const parentRot = c.parents[pi] >= 0 ? fkNow.rot[c.parents[pi]] : qIdentity();
          const rest = [c.bones[pi].head, ...names.map((nm) => c.bones[bi(nm)].tail)];
          const restW = rest.map((x) => add(baseW, qRot(parentRot, sub(x, rest[0]))));
          const sway = mul([Math.sin(TAU * 0.3 * t), Math.sin(TAU * 0.23 * t + 1), 0] as V3, 0.03 * p.length);
          const tgtW = add(add(add(c.bones[bi('Body')].head, O[bi('Body')]), qRot(R[bi('Body')], sub(p.target, c.bones[bi('Body')].head))), sway);
          const solved = fabrik(restW, tgtW);
          const locals = chainLocals(c, names, solved, parentRot);
          names.forEach((nm, i) => { R[bi(nm)] = locals[i]; });
          continue;
        }
        // wave / whip / coil / follow: bend each joint in the chain's plane
        const restDir = norm(p.dir);
        const axis: V3 = p.plane === 'pitch' ? norm(cross(restDir, [0, 1, 0])) : [0, 1, 0];
        names.forEach((nm, i) => {
          const k = (i + 1) / p.segments;
          let deg = 0;
          const phase = (TAU * freq * duration) > 0 ? TAU * Math.round(freq * duration) / duration : TAU * freq;
          if (p.motion === 'coil') deg = (amp / p.segments) * 2.2 * (0.85 + 0.15 * Math.sin(phase * t));
          else if (p.motion === 'whip') deg = (amp / p.segments) * 2 * Math.sin(phase * t - 2.6 * k) * (0.4 + k);
          else deg = (amp / p.segments) * 2 * Math.sin(phase * t - 1.6 * k) * (0.3 + 0.7 * k);
          R[bi(nm)] = qAxisAngle(axis, deg);
        });
      }
      // ── hinges, sliders ──
      for (const p of c.def.parts) {
        if (p.kind === 'hinge') {
          const ax = norm(p.axis);
          let deg = 0;
          if (p.motion.kind === 'spin') deg = (p.motion.rpm / 60) * 360 * t;
          else if (p.motion.kind === 'swing') { const s = 0.5 - 0.5 * Math.cos((TAU * t) / fitPeriod(p.motion.period)); deg = lerp(p.motion.min, p.motion.max, s); }
          R[bi(p.id)] = qAxisAngle(ax, deg);
        } else if (p.kind === 'slider') {
          const s = 0.5 - 0.5 * Math.cos((TAU * t) / fitPeriod(p.period));
          O[bi(p.id)] = mul(norm(p.axis), lerp(p.range[0], p.range[1], s));
        }
      }
      // ── sway: blades bend with the wind (a travelling gust), never past their limit ──
      for (const p of c.def.parts) {
        if (p.kind !== 'sway' || p.mode === 'shader') continue;
        const axis = norm(cross([0, 1, 0], norm(p.wind ?? [1, 0, 0.3])));
        const per = Math.max(1, Math.round(duration / 2.2)) / duration;
        for (let i = 1; i <= p.count; i++) {
          const b = c.bones[bi(`${p.id}.${i}`)];
          R[bi(`${p.id}.${i}`)] = qAxisAngle(axis, swayDeg(p, t, b.head[0], b.head[2], i, per, energy));
        }
      }
      // ── springs: lag behind their parent's motion, then settle ──
      const fkNow = creatureFK(c, R, O);
      for (const p of c.def.parts) {
        if (p.kind !== 'spring') continue;
        const i = bi(p.id), pi = c.parents[i];
        const st = springState.get(p.id) ?? { a: [0, 0, 0], v: [0, 0, 0] };
        const prev = prevWorld[1];
        const w0 = TAU * (p.hz ?? 2.2), z0 = p.damp ?? 0.25, dt = 1 / fps;
        // the parent's acceleration at the spring root drives it (inertia), in the parent's frame
        let acc: V3 = [0, 0, 0];
        if (prev && prevWorld[0]) {
          const p0 = prevWorld[0].pos[i], p1 = prev.pos[i], p2 = fkNow.pos[i];
          acc = mul(add(sub(p2, mul(p1, 2)), p0), fps * fps);
        }
        const localAcc = qRot(qInv(fkNow.rot[pi]), acc);
        const dirL = norm(sub(c.bones[i].tail, c.bones[i].head));
        // torque axis: perpendicular to the spring; inertia swings it opposite to the acceleration
        const drive = cross(dirL, mul(localAcc, -1));
        for (let k = 0; k < 3; k++) {
          const a = -w0 * w0 * st.a[k] - 2 * z0 * w0 * st.v[k] + drive[k] * 9;
          st.v[k] += a * dt; st.a[k] += st.v[k] * dt;
        }
        springState.set(p.id, st);
        const ang = Math.min(40, len(st.a));
        if (ang > 1e-3) R[i] = qAxisAngle(norm(st.a), ang);
      }
      prevWorld[0] = prevWorld[1];
      prevWorld[1] = creatureFK(c, R, O);
      if (pass === warm - 1) { rot.push(R); off.push(O); contactsOut.push(down); }
    }
  }
  // a loop's last frame repeats the first exactly (springs and suspension have settled into the cycle)
  // (the frame computed at t = duration is kept as `seam`, so the loop check measures the real gap)
  const loop = true;
  const seam = { rot: rot[frames], off: off[frames] };
  rot[frames] = rot[0]; off[frames] = off[0]; contactsOut[frames] = contactsOut[0];
  return { id, kind: m.kind, fps, frames, duration, loop, speed, dir, rot, off, contacts: contactsOut, notes, reachMiss, seam };
}

// ── checks (Decision 54 A): from the parts, plus universal ones, with a failure timeline ──────────

export interface MotionCheck {
  name: string;                    // what was checked
  part?: string;                   // the part that declared it (universal checks have none)
  pass: boolean;
  worst: number;                   // the measured worst value
  limit: number;
  unit: string;
  frames: Array<[number, number]>; // failing frame ranges (inclusive)
  detail: string;
}

const ranges = (bad: boolean[]): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  let s = -1;
  bad.forEach((b, i) => { if (b && s < 0) s = i; if (!b && s >= 0) { out.push([s, i - 1]); s = -1; } });
  if (s >= 0) out.push([s, bad.length - 1]);
  return out;
};

/** Thresholds, relative to body size where it matters. */
export const CHECK_LIMITS = { slide: 0.03, sink: 0.02, float: 0.04, penetrate: 0.25, popDegPerS: 900, jerkMs2: 60, loopDeg: 1.5, loopMm: 2, idleDeg: 3, balanceMargin: -0.08 };

/** Every check for one clip: each part's declared checks, then the universal ones. */
export function creatureChecks(c: Creature, clip: CreatureClip): MotionCheck[] {
  const F = clip.frames + 1;
  const fks = clip.rot.map((r, f) => creatureFK(c, r, clip.off[f]));
  const travel = (f: number) => mul(clip.dir, clip.speed * (f / clip.fps));
  const world = (f: number, p: V3) => add(p, travel(f));
  const ground = (p: V3) => terrainHeight(c.def.terrain, p[0], p[2]);
  const size = c.size;
  const out: MotionCheck[] = [];
  const mk = (name: string, bad: boolean[], worst: number, limit: number, unit: string, detail: string, part?: string): MotionCheck =>
    ({ name, ...(part ? { part } : {}), pass: !bad.some(Boolean), worst: r3(worst), limit: r3(limit), unit, frames: ranges(bad), detail });
  // contact points per frame (world)
  const cp = c.contacts.map((cd) => fks.map((fk, f) => world(f, bonePoint(c, fk, c.index.get(cd.bone)!, cd.at))));
  // ── contact sliding: a planted foot doesn't move; a belly moves only along its body; a wheel rolls ──
  for (const part of c.parts) {
    const decl = part.contacts.map((ci) => ({ ci, cd: c.contacts[ci] }));
    if (!decl.length) continue;
    const kind = decl[0].cd.kind;
    if (kind === 'foot' || kind === 'belly') {
      const bad = new Array(F).fill(false);
      let worst = 0;
      const slideLim = kind === 'foot' ? CHECK_LIMITS.slide : CHECK_LIMITS.slide * 2;
      for (const { ci, cd } of decl) for (let f = 1; f < F; f++) {
        if (!clip.contacts[f][ci] || !clip.contacts[f - 1][ci]) continue;
        let d = sub(cp[ci][f], cp[ci][f - 1]);
        if (cd.slideAxis) {
          const ax = norm(qRot(fks[f].rot[c.index.get(cd.bone)!], cd.slideAxis));
          d = sub(d, mul(ax, dot(d, ax)));
        }
        d[1] = 0;
        // m/s across the ground, in body lengths per second: a foot may creep 3 % of the body a second,
        // a belly 6 % sideways (a snake's segments ride a curve, not a perfect rail)
        const rel = (len(d) * clip.fps) / size;
        if (rel > slideLim) bad[f] = true;
        worst = Math.max(worst, len(d) * clip.fps);
      }
      out.push(mk(kind === 'foot' ? 'feet planted (no sliding)' : 'belly slides only along the body', bad, worst, slideLim * size, 'm/s', kind === 'foot' ? 'planted feet stay where they landed' : 'segments on the ground move along their own length, not sideways', part.spec.kind === 'chain' || part.spec.kind === 'legs' ? (part.spec as any).id : undefined));
      // on the ground: planted contacts touch it (not sunk, not floating)
      const gbad = new Array(F).fill(false);
      let gworst = 0;
      for (const { ci } of decl) for (let f = 0; f < F; f++) {
        if (!clip.contacts[f][ci]) continue;
        const h = cp[ci][f][1] - ground(cp[ci][f]);
        const lim = kind === 'belly' ? size * 0.25 : size * CHECK_LIMITS.float;
        if (h < -size * CHECK_LIMITS.sink || h > lim) gbad[f] = true;
        gworst = Math.max(gworst, Math.abs(h));
      }
      out.push(mk(kind === 'foot' ? 'feet on the ground' : 'belly on the ground', gbad, gworst, size * CHECK_LIMITS.float, 'm', 'planted contacts touch the ground (not sunk, not floating)', (part.spec as any).id));
    } else if (kind === 'wheel') {
      const w = part.spec as WheelsPartSpec;
      // rolling: the hub's speed equals the tyre's surface speed (ω r)
      const bad = new Array(F).fill(false);
      let worst = 0;
      const turns = Math.max(1, Math.round((c.def.terrain?.period ?? 8) / (TAU * w.axles[0].r)));
      const rollR = (c.def.terrain?.period ?? 8) / (TAU * turns);
      for (const { cd } of decl) {
        const wi = c.index.get(cd.bone)!;
        for (let f = 1; f < F; f++) {
          const hub0 = world(f - 1, fks[f - 1].pos[wi]), hub1 = world(f, fks[f].pos[wi]);
          const v = Math.hypot(hub1[0] - hub0[0], hub1[2] - hub0[2]) * clip.fps;
          const a0 = qAngle(clip.rot[f - 1][wi], clip.rot[f][wi]);
          const surf = (a0 * D2R) * clip.fps * rollR;
          const slip = Math.abs(v - surf) / Math.max(0.1, v);
          if (clip.speed > 0 && slip > 0.12) bad[f] = true;
          worst = Math.max(worst, slip);
        }
      }
      out.push(mk('wheels roll at ground speed', bad, worst, 0.12, 'slip', 'tyre surface speed matches the hub speed (no skidding)', w.id));
      // tyres touch the road; suspension within travel
      const tbad = new Array(F).fill(false), sbad = new Array(F).fill(false);
      let tw = 0, sw = 0;
      for (const { cd } of decl) {
        const wi = c.index.get(cd.bone)!, si = c.parents[wi];
        for (let f = 0; f < F; f++) {
          const hub = world(f, fks[f].pos[wi]);
          const gap = hub[1] - w.axles[0].r - ground(hub);
          if (Math.abs(gap) > 0.015) tbad[f] = true;
          tw = Math.max(tw, Math.abs(gap));
          const sl = Math.abs(clip.off[f][si][1]);
          if (sl > w.travel) sbad[f] = true;
          sw = Math.max(sw, sl);
        }
      }
      out.push(mk('tyres touch the ground', tbad, tw, 0.015, 'm', 'each tyre sits on the road surface', w.id));
      out.push(mk('suspension within its travel', sbad, sw, w.travel, 'm', 'struts compress and extend no further than they can', w.id));
    }
  }
  // ── leg reach ──
  if (c.legs.length) out.push(mk('leg reach', new Array(F).fill(clip.reachMiss > size * 0.01), clip.reachMiss, size * 0.01, 'm', 'every foot target is within its leg\'s reach'));
  // ── penetration: world (pieces below the ground) and self (pieces of non-neighbouring bones) ──
  {
    const spheres = c.pieces.filter((pc) => pc.shape.kind !== 'blade').map((pc) => ({ pc, b: c.index.get(pc.bone)!, ...pieceSphere(pc.shape) }));
    const near = (a: number, b: number) => a === b || c.parents[a] === b || c.parents[b] === a || (c.parents[a] >= 0 && c.parents[a] === c.parents[b]) || (c.parents[a] >= 0 && c.parents[c.parents[a]] === b) || (c.parents[b] >= 0 && c.parents[c.parents[b]] === a);
    const wbad = new Array(F).fill(false), sbad = new Array(F).fill(false);
    let ww = 0, sw = 0;
    const isContactBone = new Set(c.contacts.map((cd) => c.index.get(cd.bone)!));
    for (let f = 0; f < F; f += Math.max(1, Math.floor(F / 60))) {
      const centres = spheres.map((s) => world(f, bonePoint(c, fks[f], s.b, s.c)));
      spheres.forEach((s, i) => {
        if (isContactBone.has(s.b) && s.pc.shape.kind !== 'box') return;   // feet/wheels are judged by their own checks
        const depth = ground(centres[i]) - (centres[i][1] - s.r);
        if (depth > s.r * CHECK_LIMITS.penetrate) { wbad[f] = true; ww = Math.max(ww, depth); }
      });
      for (let i = 0; i < spheres.length; i++) for (let j = i + 1; j < spheres.length; j++) {
        if (near(spheres[i].b, spheres[j].b)) continue;
        if (spheres[i].pc.part === spheres[j].pc.part && spheres[i].pc.part.startsWith('sway')) continue;
        const d = len(sub(centres[i], centres[j]));
        const overlap = spheres[i].r + spheres[j].r - d;
        const lim = Math.min(spheres[i].r, spheres[j].r) * CHECK_LIMITS.penetrate * 2;
        // only pieces that don't overlap at rest can collide (rest overlaps are how the body is built)
        const restD = len(sub(spheres[i].c, spheres[j].c));
        const restOverlap = spheres[i].r + spheres[j].r - restD;
        if (overlap > Math.max(lim, restOverlap + lim)) { sbad[f] = true; sw = Math.max(sw, overlap); }
      }
    }
    out.push(mk('nothing sinks into the ground', wbad, ww, CHECK_LIMITS.penetrate, '× piece radius', 'body pieces stay above the ground'));
    out.push(mk('nothing passes through itself', sbad, sw, CHECK_LIMITS.penetrate * 2, '× piece radius', 'parts that don\'t touch at rest don\'t collide in motion'));
  }
  // ── balance: with three or more feet down, the centre of mass is over them ──
  if (c.legs.length >= 4) {
    const bad = new Array(F).fill(false);
    let worst = 0;
    const footIdx = c.contacts.map((cd, i) => (cd.kind === 'foot' ? i : -1)).filter((i) => i >= 0);
    for (let f = 0; f < F; f++) {
      const downPts = footIdx.filter((ci) => clip.contacts[f][ci]).map((ci) => cp[ci][f]);
      if (downPts.length < 3) continue;   // two feet down: a dynamic moment (judged by the gait, not statics)
      const com = centreOfMass(c, fks[f], (p) => world(f, p));
      const d = insideMargin(downPts.map((p) => [p[0], p[2]] as [number, number]), [com[0], com[2]]);
      if (d < CHECK_LIMITS.balanceMargin * size) bad[f] = true;
      worst = Math.min(worst, d);
    }
    out.push(mk('balance over the feet', bad, worst, CHECK_LIMITS.balanceMargin * size, 'm inside', 'the centre of mass stays over the planted feet (three or more down)'));
  }
  // ── joint and hinge limits ──
  {
    const bad = new Array(F).fill(false);
    let worst = 0, who = '';
    for (const [name, lim] of Object.entries(c.limits)) {
      const bI = c.index.get(name)!;
      if (c.spinners.has(name)) continue;
      for (let f = 0; f < F; f++) {
        const q = clip.rot[f][bI];
        let over = 0;
        if (lim.kind === 'cone') over = qAngle(q, qIdentity()) - lim.maxDeg;
        else {
          const tw = twistAbout(q, lim.axis);
          over = Math.max(lim.min - tw, tw - lim.max, qAngle(q, qAxisAngle(lim.axis, tw)) - (lim.offAxis ?? 3));
        }
        if (over > 0.5) { bad[f] = true; if (over > worst) { worst = over; who = name; } }
      }
    }
    out.push(mk('joints within their limits', bad, worst, 0, '° over', who ? `worst: ${who}` : 'every joint stays inside its range'));
  }
  // ── pops: angular speed and body jerk ──
  {
    const bad = new Array(F).fill(false);
    let worst = 0, who = '';
    for (let b = 0; b < c.bones.length; b++) {
      if (c.spinners.has(c.bones[b].name)) continue;
      for (let f = 1; f < F; f++) {
        const w = qAngle(clip.rot[f - 1][b], clip.rot[f][b]) * clip.fps;
        if (w > CHECK_LIMITS.popDegPerS) { bad[f] = true; if (w > worst) { worst = w; who = c.bones[b].name; } }
      }
    }
    out.push(mk('no pops (joint speed)', bad, worst, CHECK_LIMITS.popDegPerS, '°/s', who ? `fastest: ${who}` : 'no joint turns faster than it can'));
    const jb = new Array(F).fill(false);
    let jw = 0;
    const bi = c.index.get('Body')!;
    for (let f = 2; f < F; f++) {
      const a = mul(add(sub(fks[f].pos[bi], mul(fks[f - 1].pos[bi], 2)), fks[f - 2].pos[bi]), clip.fps * clip.fps);
      const am = len(a);
      if (am > CHECK_LIMITS.jerkMs2) jb[f] = true;
      jw = Math.max(jw, am);
    }
    out.push(mk('no jolts (body acceleration)', jb, jw, CHECK_LIMITS.jerkMs2, 'm/s²', 'the body doesn\'t jump between frames'));
  }
  // ── shader sway: the bend the shader will apply stays within the blade's limit (engines run it live) ──
  for (const p of c.def.parts) if (p.kind === 'sway' && p.mode === 'shader') {
    const worst = (p.strength ?? 14) * 1.4 + 3;           // the formula's peak at full energy
    out.push({ name: `shader sway within the bend limit (${p.id})`, part: p.id, pass: worst <= 40, worst: r3(worst), limit: 40, unit: '°', frames: [], detail: `peak bend of the sway shader (${p.count} blades, one mesh)` });
  }
  // ── loop closure ──
  if (clip.loop) {
    let worstDeg = 0, worstMm = 0;
    const last = clip.seam ?? { rot: clip.rot[clip.frames], off: clip.off[clip.frames] };
    for (let b = 0; b < c.bones.length; b++) {
      worstDeg = Math.max(worstDeg, qAngle(clip.rot[0][b], last.rot[b]));
      worstMm = Math.max(worstMm, len(sub(clip.off[0][b], last.off[b])) * 1000);
    }
    // and the step into the loop is no bigger than a normal frame step
    const pass = worstDeg <= CHECK_LIMITS.loopDeg && worstMm <= CHECK_LIMITS.loopMm;
    out.push({ name: 'loop closes', pass, worst: r3(Math.max(worstDeg, worstMm / 10)), limit: CHECK_LIMITS.loopDeg, unit: '°', frames: pass ? [] : [[clip.frames, clip.frames]], detail: `last frame vs first: ${r3(worstDeg)}°, ${r3(worstMm)} mm` });
  } else {
    // a one-off ends in its rest/idle pose
    let worst = 0;
    for (let b = 0; b < c.bones.length; b++) worst = Math.max(worst, qAngle(clip.rot[clip.frames][b], qIdentity()));
    out.push({ name: 'ends in idle', pass: worst <= CHECK_LIMITS.idleDeg, worst: r3(worst), limit: CHECK_LIMITS.idleDeg, unit: '°', frames: worst <= CHECK_LIMITS.idleDeg ? [] : [[clip.frames, clip.frames]], detail: 'the last frame matches the rest pose' });
  }
  // ── springs settle: a still clip's springs come to rest ──
  return out;
}

/** A bounding sphere for a piece (rest, object space). */
export function pieceSphere(s: PartShape): { c: V3; r: number } {
  switch (s.kind) {
    case 'box': return { c: s.c, r: Math.min(...s.size) / 2 };
    case 'ball': return { c: s.c, r: s.r * Math.min(...(s.scale ?? [1, 1, 1])) };
    case 'seg': return { c: lerp3(s.a, s.b, 0.5), r: Math.max(s.r1, s.r2) };
    case 'wheel': return { c: s.c, r: s.r };
    case 'blade': return { c: lerp3(s.a, s.b, 0.5), r: s.w / 2 };
  }
}

function pieceVolume(s: PartShape): number {
  switch (s.kind) {
    case 'box': return s.size[0] * s.size[1] * s.size[2];
    case 'ball': { const k = s.scale ?? [1, 1, 1]; return (4 / 3) * Math.PI * s.r ** 3 * k[0] * k[1] * k[2]; }
    case 'seg': return Math.PI * ((s.r1 + s.r2) / 2) ** 2 * len(sub(s.b, s.a));
    case 'wheel': return Math.PI * s.r * s.r * s.w;
    case 'blade': return 0;
  }
}

function centreOfMass(c: Creature, fk: FK, toWorld: (p: V3) => V3): V3 {
  let m = 0, acc: V3 = [0, 0, 0];
  for (const pc of c.pieces) {
    const v = pieceVolume(pc.shape);
    if (!v) continue;
    const s = pieceSphere(pc.shape);
    const p = toWorld(bonePoint(c, fk, c.index.get(pc.bone)!, s.c));
    acc = add(acc, mul(p, v)); m += v;
  }
  return mul(acc, 1 / (m || 1));
}

/** Signed distance of point p inside the convex hull of pts (positive inside, negative outside), 2D. */
function insideMargin(pts: Array<[number, number]>, p: [number, number]): number {
  const h = hull2(pts);
  if (h.length < 3) return -Infinity;
  let best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l = Math.hypot(ex, ez) || 1;
    // hull is counter-clockwise: inside is to the left
    const d = ((p[0] - a[0]) * ez - (p[1] - a[1]) * ex) / l * -1;
    best = Math.min(best, d);
  }
  return best;
}

function hull2(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** The rotation angle (degrees) about an axis (swing-twist decomposition). */
export function twistAbout(q: Q, axis: V3): number {
  const a = norm(axis);
  const p = dot([q[0], q[1], q[2]], a);
  let ang = 2 * Math.atan2(p, q[3]) / D2R;
  if (ang > 180) ang -= 360;
  if (ang < -180) ang += 360;
  return ang;
}

/** Interpolate a clip at time t (s), for live preview without baking every frame. */
export function sampleClip(clip: CreatureClip, t: number): { rot: Q[]; off: V3[] } {
  const ft = clip.loop ? mod1(t / clip.duration) * clip.frames : Math.min(clip.frames, (t / clip.duration) * clip.frames);
  const f0 = Math.floor(ft), f1 = Math.min(clip.frames, f0 + 1), u = ft - f0;
  return { rot: clip.rot[f0].map((q, b) => qSlerp(q, clip.rot[f1][b], u)), off: clip.off[f0].map((o, b) => lerp3(o, clip.off[f1][b], u)) };
}
