// Creatures from rig parts (Decision 52 A): ready-made part combos, their low-poly meshes, and a
// glTF export where every piece rides its bone as a node — TRS animation that Godot's importer and
// three.js's GLTFLoader both play without skinning. DOM-free.
import { GlbBuilder } from './glb.ts';
import { qAxisAngle, qIdentity, qMul, qRot, type Q, type V3 } from './rig.ts';
import { qArc } from './motion.ts';
import { bakeCreature, buildCreature, creatureChecks, terrainHeight, type Creature, type CreatureClip, type CreatureDef, type CreatureMotion, type MotionCheck, type PartShape, type PartSpec, type SwayPartSpec } from './rigparts.ts';

const TAU = Math.PI * 2;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ── presets: part combos ─────────────────────────────────────────────────────────────────────────

export interface CreaturePreset { def: CreatureDef; motions: Record<string, CreatureMotion>; describe: string }

export const CREATURE_PRESETS: Record<string, () => CreaturePreset> = {
  /** Six legs, two claws and a whip tail: a crab that walks sideways on alternating tripods. */
  crab: () => {
    const shell = '#d0623a', leg = '#bb5431', dark = '#5a2618';
    const claw = (side: 1 | -1): PartSpec[] => {
      const tag = side > 0 ? 'L' : 'R';
      const at: V3 = [side * 0.15, 0.225, 0.13], d = norm([side * 0.55, 0.15, 1]);
      const tip = add(at, mul(d, 0.2));
      const palm = add(tip, mul(d, 0.05));
      return [
        { kind: 'chain', id: `claw.${tag}`, at, dir: d, length: 0.2, segments: 2, r0: 0.026, r1: 0.032, color: leg, motion: 'wave', plane: 'yaw', amp: 12, freq: 0.4, phase: side > 0 ? 0 : 0.5, limit: 40,
          tip: [
            { shape: { kind: 'ball', c: palm, r: 0.06, scale: [0.85, 0.62, 1], sides: 16 }, color: shell },
            { shape: { kind: 'seg', a: add(palm, [side * 0.012, -0.01, 0.04]), b: add(palm, [side * 0.006, -0.012, 0.115]), r1: 0.022, r2: 0.004, sides: 10, round: true, squash: [1, 0.7] }, color: dark },
          ] },
        { kind: 'hinge', id: `pincer.${tag}`, parent: `claw.${tag}.2`, at: add(palm, [0, 0.02, 0.035]), axis: [1, 0, 0],
          shapes: [{ shape: { kind: 'seg', a: add(palm, [-side * 0.012, 0.02, 0.035]), b: add(palm, [-side * 0.004, 0.012, 0.11]), r1: 0.017, r2: 0.004, sides: 10, round: true, squash: [1, 0.7] }, color: dark }],
          motion: { kind: 'swing', min: -22, max: 0, period: 1.3 }, limit: { min: -25, max: 2 } },
      ];
    };
    return {
      describe: 'a crab: a rounded shell, six tapered legs on alternating tripods, two claws with pinching pincers, eyes on stalks, spring antennae and a whip tail',
      def: {
        name: 'Robot Crab',
        parts: [
          { kind: 'body', shape: 'ball', size: [0.5, 0.15, 0.36], height: 0.24, color: shell, style: { bob: 0.01 },
            extras: [
              { shape: { kind: 'ball', c: [0, 0.262, -0.015], r: 0.225, scale: [1, 0.3, 0.7], sides: 28 }, color: '#df7448' },
              { shape: { kind: 'ball', c: [0, 0.205, 0.0], r: 0.22, scale: [1, 0.22, 0.72], sides: 24 }, color: '#efc79a' },
              { shape: { kind: 'seg', a: [-0.12, 0.27, 0.135], b: [0.12, 0.27, 0.135], r1: 0.018, r2: 0.018, sides: 10, round: true }, color: shell },
            ] },
          { kind: 'legs', id: 'legs', count: 6, upper: 0.2, lower: 0.28, spread: 0.22, span: 0.68, kneeUp: 0.12, radius: 0.022, taper: 0.22, squash: [1, 0.72], color: leg, footColor: dark, lift: 0.32, hipX: 0.8 },
          ...claw(1), ...claw(-1),
          { kind: 'chain', id: 'tail', at: [0, 0.25, -0.16], dir: [0, 0.35, -1], length: 0.6, segments: 7, r0: 0.026, r1: 0.007, color: leg, motion: 'whip', plane: 'yaw', amp: 70, freq: 0.9 },
          { kind: 'spring', id: 'antenna.L', at: [0.035, 0.27, 0.15], dir: [0.3, 1, 0.9], length: 0.15, r: 0.005, color: '#e7a86a', hz: 2.4, damp: 0.18 },
          { kind: 'spring', id: 'antenna.R', at: [-0.035, 0.27, 0.15], dir: [-0.3, 1, 0.9], length: 0.15, r: 0.005, color: '#e7a86a', hz: 2.4, damp: 0.18 },
          { kind: 'hinge', id: 'eyes', at: [0, 0.28, 0.14], axis: [0, 1, 0], shapes: [
            { shape: { kind: 'seg', a: [0.06, 0.265, 0.14], b: [0.075, 0.345, 0.155], r1: 0.011, r2: 0.009, sides: 10, round: true }, color: shell },
            { shape: { kind: 'seg', a: [-0.06, 0.265, 0.14], b: [-0.075, 0.345, 0.155], r1: 0.011, r2: 0.009, sides: 10, round: true }, color: shell },
            { shape: { kind: 'ball', c: [0.076, 0.355, 0.158], r: 0.022, sides: 14 }, color: '#1d1a16' },
            { shape: { kind: 'ball', c: [-0.076, 0.355, 0.158], r: 0.022, sides: 14 }, color: '#1d1a16' },
            { shape: { kind: 'ball', c: [0.083, 0.364, 0.174], r: 0.006, sides: 8 }, color: '#f4efe6' },
            { shape: { kind: 'ball', c: [-0.069, 0.364, 0.174], r: 0.006, sides: 8 }, color: '#f4efe6' },
          ], motion: { kind: 'swing', min: -20, max: 20, period: 2.6 }, limit: { min: -25, max: 25 } },
        ],
      },
      motions: { walk: { kind: 'walk', speed: 0.32, dir: [1, 0, 0] }, idle: { kind: 'idle', duration: 2.6 } },
    };
  },
  /** Eight legs, a round abdomen: a spider on alternating tetrapods. */
  spider: () => ({
    describe: 'a spider: cephalothorax and abdomen, eight long tapered legs (alternating tetrapods), pedipalps',
    def: {
      name: 'Spider',
      parts: [
        { kind: 'body', shape: 'ball', size: [0.15, 0.09, 0.17], height: 0.17, color: '#3a2b22', style: { bob: 0.006 },
          extras: [
            { shape: { kind: 'ball', c: [0, 0.205, -0.175], r: 0.115, scale: [0.82, 0.72, 1], sides: 24 }, color: '#4a3528' },
            // the abdomen's pattern: a pale leaf-shaped band down the back, chevrons either side
            { shape: { kind: 'ball', c: [0, 0.26, -0.185], r: 0.052, scale: [0.6, 0.35, 1.3], sides: 16 }, color: '#c89a62' },
            ...[0, 1, 2].flatMap((k) => [1, -1].map((sd) => ({ shape: { kind: 'seg' as const, a: [sd * 0.03, 0.272 - 0.004 * k, -0.14 - 0.035 * k] as V3, b: [sd * 0.062, 0.25 - 0.006 * k, -0.155 - 0.035 * k] as V3, r1: 0.008, r2: 0.005, sides: 8, round: true }, color: '#d9b685' }))),
            // the cephalothorax: a darker radiating groove pattern and a pale rim
            { shape: { kind: 'ball', c: [0, 0.207, 0.01], r: 0.06, scale: [1, 0.32, 1.1], sides: 18 }, color: '#5b4331' },
            { shape: { kind: 'seg', a: [0, 0.18, -0.06], b: [0, 0.19, -0.1], r1: 0.03, r2: 0.035, sides: 10 }, color: '#2e2420' },
            ...[[0.025, 0.215, 0.08, 0.014], [-0.025, 0.215, 0.08, 0.014], [0.052, 0.207, 0.068, 0.009], [-0.052, 0.207, 0.068, 0.009]].map(([x, y, z, r]) => ({ shape: { kind: 'ball' as const, c: [x, y, z] as V3, r, sides: 10 }, color: '#0d0a09' })),
          ] },
        // legs: banded brown (lighter than the body, darker than the floor), knees high above the body
        { kind: 'legs', id: 'legs', count: 8, upper: 0.21, lower: 0.29, spread: 0.24, span: 1.1, fan: 2.1, kneeUp: 0.19, radius: 0.0135, taper: 0.4, color: '#7a5537', footColor: '#2b1d15', bands: '#d6b483', hair: '#2a1d16', arch: 0.13, pole: [0.45, 1.7, 0], hipX: 0.75, lift: 0.3 },
        { kind: 'chain', id: 'palp.L', at: [0.025, 0.15, 0.085], dir: [0.3, -0.5, 1], length: 0.08, segments: 2, r0: 0.011, r1: 0.008, color: '#7a5537', motion: 'wave', plane: 'pitch', amp: 18, freq: 1.1, tip: [{ shape: { kind: 'ball', c: [0.046, 0.115, 0.154], r: 0.011, sides: 10 }, color: '#2b1d15' }] },
        { kind: 'chain', id: 'palp.R', at: [-0.025, 0.15, 0.085], dir: [-0.3, -0.5, 1], length: 0.08, segments: 2, r0: 0.011, r1: 0.008, color: '#7a5537', motion: 'wave', plane: 'pitch', amp: 18, freq: 1.1, phase: 0.5, tip: [{ shape: { kind: 'ball', c: [-0.046, 0.115, 0.154], r: 0.011, sides: 10 }, color: '#2b1d15' }] },
      ],
    },
    motions: { walk: { kind: 'walk', speed: 0.3 }, idle: { kind: 'idle', duration: 3 } },
  }),
  /** An octopus at a low table with a teapot and a cup (props for its actions). */
  octopus: () => {
    const skin = '#c7563f', under = '#efb79a';
    const arms: PartSpec[] = Array.from({ length: 8 }, (_, i) => {
      const a = ((i + 0.5) * 45 * Math.PI) / 180;
      return { kind: 'chain', id: `arm${i + 1}`, at: [0.1 * Math.sin(a), 0.072, 0.1 * Math.cos(a)], dir: [Math.sin(a), -0.085, Math.cos(a)], length: 0.6, segments: 10, r0: 0.04, r1: 0.007, color: skin, under, motion: 'curl', plane: 'pitch', amp: 62, freq: 0.32, phase: i / 8, limit: 80 } as PartSpec;
    });
    const potC: V3 = [0.13, 0.2 + 0.052, 0.71];
    const grip: V3 = [0.13, 0.255, 0.635];
    const spout: V3 = [0.045, 0.3, 0.71];
    return {
      describe: 'an octopus (mantle, eyes, eight curling arms with suckers) beside a low table with a teapot and a cup (props it can pick up)',
      def: {
        name: 'Octopus',
        parts: [
          { kind: 'body', shape: 'ball', size: [0.26, 0.2, 0.26], height: 0.2, color: skin, style: { bob: 0.01 },
            extras: [
              { shape: { kind: 'ball', c: [0, 0.33, -0.05], r: 0.15, scale: [0.95, 1.05, 1.15], sides: 28 }, color: skin },
              { shape: { kind: 'ball', c: [0, 0.11, 0], r: 0.14, scale: [1.05, 0.42, 1.05], sides: 24 }, color: skin },
              ...[1, -1].flatMap((sd) => [
                { shape: { kind: 'ball' as const, c: [sd * 0.085, 0.235, 0.085] as V3, r: 0.048, sides: 18 }, color: '#f2d9b8' },
                { shape: { kind: 'ball' as const, c: [sd * 0.098, 0.238, 0.118] as V3, r: 0.022, scale: [1, 0.55, 0.7] as V3, sides: 14 }, color: '#18120f' },
                { shape: { kind: 'seg' as const, a: [sd * 0.05, 0.285, 0.1] as V3, b: [sd * 0.12, 0.28, 0.09] as V3, r1: 0.014, r2: 0.01, sides: 10, round: true }, color: '#b14a35' },
              ]),
            ] },
          ...arms,
          { kind: 'prop', id: 'table', at: [0, 0.2, 0.75], surface: 0.2, shapes: [
            { shape: { kind: 'box', c: [0, 0.185, 0.75], size: [0.6, 0.03, 0.34] }, color: '#8a6a4a' },
            ...[[0.15, 0.62], [-0.15, 0.62], [0.15, 0.88], [-0.15, 0.88]].map(([x, z]) => ({ shape: { kind: 'seg' as const, a: [x, 0, z] as V3, b: [x, 0.172, z] as V3, r1: 0.016, r2: 0.016, sides: 10 }, color: '#6f533a' })),
          ] },
          { kind: 'prop', id: 'teapot', at: grip, shapes: [
            { shape: { kind: 'ball', c: potC, r: 0.062, scale: [1, 0.84, 1], sides: 22 }, color: '#4f8a8b' },
            { shape: { kind: 'ball', c: add(potC, [0, 0.05, 0]), r: 0.03, scale: [1, 0.45, 1], sides: 16 }, color: '#4f8a8b' },
            { shape: { kind: 'ball', c: add(potC, [0, 0.068, 0]), r: 0.009, sides: 10 }, color: '#e9dfc9' },
            { shape: { kind: 'seg', a: add(potC, [-0.045, -0.005, 0]), b: spout, r1: 0.016, r2: 0.007, sides: 12 }, color: '#4f8a8b' },
            { shape: { kind: 'seg', a: add(potC, [0, 0.03, -0.045]), b: add(grip, [0, 0.012, 0]), r1: 0.008, r2: 0.008, sides: 8 }, color: '#e9dfc9' },
            { shape: { kind: 'seg', a: add(grip, [0, 0.012, 0]), b: add(grip, [0, -0.025, 0.005]), r1: 0.008, r2: 0.008, sides: 8 }, color: '#e9dfc9' },
            { shape: { kind: 'seg', a: add(grip, [0, -0.025, 0.005]), b: add(potC, [0, -0.02, -0.05]), r1: 0.008, r2: 0.008, sides: 8 }, color: '#e9dfc9' },
          ] },
          { kind: 'prop', id: 'tea', parent: 'teapot', at: spout, fx: { hide: [0, -3, 0] }, shapes: [{ shape: { kind: 'seg', a: add(spout, [0, 0.002, 0]), b: add(spout, [0, -0.1, 0]), r1: 0.006, r2: 0.0045, sides: 8 }, color: '#9a6232' }] },
          { kind: 'prop', id: 'cup', at: [-0.1, 0.2, 0.69], shapes: [
            { shape: { kind: 'seg', a: [-0.1, 0.2, 0.69], b: [-0.1, 0.262, 0.69], r1: 0.028, r2: 0.036, sides: 18 }, color: '#f1ebe0' },
            { shape: { kind: 'seg', a: [-0.1, 0.255, 0.69], b: [-0.1, 0.2635, 0.69], r1: 0.031, r2: 0.033, sides: 18 }, color: '#7a4a24' },
            { shape: { kind: 'seg', a: [-0.137, 0.25, 0.69], b: [-0.146, 0.222, 0.69], r1: 0.006, r2: 0.006, sides: 8 }, color: '#f1ebe0' },
            { shape: { kind: 'ball', c: [-0.1, 0.2, 0.69], r: 0.046, scale: [1, 0.08, 1], sides: 18 }, color: '#f1ebe0' },
          ] },
        ],
      },
      motions: { idle: { kind: 'idle', duration: 4 } },
    };
  },
  /** A bird: wings that fold, flap, glide and hover; legs that tuck in flight. */
  bird: () => ({
    describe: 'a bird: body, head and beak, a fan tail, two legs (knees back, toes), and wings (flap, glide, fold, hover; a flight cycle from their proportions)',
    def: {
      name: 'Bird',
      parts: [
        { kind: 'body', shape: 'ball', size: [0.15, 0.15, 0.3], height: 0.25, color: '#5b6f8a', style: { bob: 0.008 },
          extras: [
            { shape: { kind: 'ball', c: [0, 0.235, 0.06], r: 0.08, scale: [0.9, 1.0, 1.05], sides: 22 }, color: '#d9c7ad' },
            { shape: { kind: 'seg', a: [0, 0.28, 0.09], b: [0, 0.35, 0.135], r1: 0.05, r2: 0.045, sides: 16 }, color: '#5b6f8a' },
            { shape: { kind: 'ball', c: [0, 0.365, 0.145], r: 0.062, scale: [0.95, 1, 1.05], sides: 22 }, color: '#4f6380' },
            { shape: { kind: 'seg', a: [0, 0.358, 0.192], b: [0, 0.35, 0.262], r1: 0.019, r2: 0.003, sides: 12, round: true, squash: [0.9, 0.75] }, color: '#e3a234' },
            { shape: { kind: 'ball', c: [0.042, 0.38, 0.172], r: 0.012, sides: 10 }, color: '#16120f' },
            { shape: { kind: 'ball', c: [-0.042, 0.38, 0.172], r: 0.012, sides: 10 }, color: '#16120f' },
            { shape: { kind: 'ball', c: [0.046, 0.384, 0.179], r: 0.0035, sides: 6 }, color: '#f4efe6' },
            { shape: { kind: 'ball', c: [-0.046, 0.384, 0.179], r: 0.0035, sides: 6 }, color: '#f4efe6' },
            // scapulars: soft feathers over the shoulders, covering where the wings join
            ...[1, -1].flatMap((sd) => [0, 1, 2].flatMap((k) => [0, 1].map((band) => ({
              shape: { kind: 'feather' as const, a: [sd * (0.03 + 0.012 * k), 0.33 - 0.006 * k, 0.085 - 0.02 * k] as V3, b: [sd * (0.05 + 0.014 * k), 0.305 - 0.012 * k, -0.04 - 0.025 * k] as V3, w: 0.05, normal: [sd * 0.45, 1, 0] as V3, curve: 0.08, camber: 0.12, from: band ? 0.55 : 0, to: band ? 1 : 0.55 },
              color: band ? '#4a5c78' : '#5b6f8a',
            })))),
          ] },
        { kind: 'fin', id: 'tail', at: [0, 0.27, -0.12], dir: [0, 0.15, -1], length: 0.16, width: 0.06, taper: 1.6, normal: [0, 1, 0.15], color: '#46597a', tipColor: '#232c3a', feathers: 7, motion: 'still' },
        { kind: 'legs', id: 'legs', count: 2, upper: 0.12, lower: 0.15, spread: -0.025, span: 0, radius: 0.011, taper: 0.7, color: '#c9893a', toes: '#b07a33', knee: [0.004, -0.085, -0.06], pole: [0, -0.2, -1], foot: 0.03, hipX: 0.6, lift: 0.4, bend: 100 },
        { kind: 'wing', id: 'wings', at: [0.068, 0.312, 0.05], length: 0.36, chord: 0.15, color: '#4d6080', tipColor: '#26303f', edgeColor: '#5b6f8a' },
      ],
    },
    motions: { idle: { kind: 'idle', duration: 3 }, walk: { kind: 'walk', speed: 0.22 }, fly: { kind: 'fly', altitude: 1.4 }, glide: { kind: 'glide', altitude: 1.4 }, hover: { kind: 'hover', altitude: 0.8 } },
  }),
  /** A fish: the tail does the swimming (carangiform), fins flutter. */
  fish: () => ({
    describe: 'a fish: a deep body, a tail that carries a travelling wave (carangiform), a fan tail fin, a dorsal fin and fluttering pectorals',
    def: {
      name: 'Fish',
      parts: [
        { kind: 'body', shape: 'ball', size: [0.1, 0.16, 0.26], height: 0.45, color: '#e58a38', style: { eyes: '#15120f', eyeSize: 0.85, bob: 0.006 },
          extras: [
            { shape: { kind: 'ball', c: [0, 0.425, 0.01], r: 0.12, scale: [0.4, 0.5, 1], sides: 24 }, color: '#f6d9a8' },
            { shape: { kind: 'seg', a: [0.0, 0.43, 0.125], b: [0, 0.432, 0.135], r1: 0.014, r2: 0.008, sides: 10, round: true }, color: '#b55c2a' },
          ] },
        { kind: 'chain', id: 'spine', at: [0, 0.45, -0.07], dir: [0, 0, -1], length: 0.26, segments: 6, r0: 0.07, r1: 0.014, squash: [0.6, 1.0], color: '#e58a38', motion: 'swim', swim: 'fish', limit: 45 },
        { kind: 'fin', id: 'tailfin', parent: 'spine.6', at: [0, 0.45, -0.325], dir: [0, 0, -1], length: 0.1, width: 0.06, taper: 2.3, normal: [1, 0, 0], color: '#f2a150', motion: 'flutter', amp: 7 },
        { kind: 'fin', id: 'dorsal', at: [0, 0.515, 0.0], dir: [0, 0.55, -1], length: 0.13, width: 0.045, taper: 0.25, normal: [1, 0, 0], color: '#f2a150', motion: 'still' },
        { kind: 'fin', id: 'pectoral', mirror: true, at: [0.04, 0.42, 0.04], dir: [0.8, -0.35, -0.7], length: 0.065, width: 0.035, taper: 0.6, normal: [0.3, 1, 0], color: '#f2a150', motion: 'flutter', amp: 22 },
      ],
    },
    motions: { swim: { kind: 'swim' }, idle: { kind: 'idle', duration: 3 } },
  }),
  /** An eel: the whole body waves (anguilliform). */
  eel: () => ({
    describe: 'an eel: a small head and a long body that waves along its whole length (anguilliform)',
    def: {
      name: 'Eel',
      parts: [
        { kind: 'body', shape: 'ball', size: [0.06, 0.065, 0.13], height: 0.3, color: '#5f6a3c', style: { eyes: '#15120f', bob: 0.004 } },
        { kind: 'chain', id: 'spine', at: [0, 0.3, -0.04], dir: [0, 0, -1], length: 1.0, segments: 16, r0: 0.03, r1: 0.006, squash: [0.75, 1.15], color: '#66713f', under: '#c9c08a', motion: 'swim', swim: 'eel', limit: 40 },
        { kind: 'fin', id: 'tailfin', parent: 'spine.16', at: [0, 0.3, -1.04], dir: [0, 0, -1], length: 0.07, width: 0.035, taper: 0.4, normal: [1, 0, 0], color: '#4e5832', motion: 'still' },
      ],
    },
    motions: { swim: { kind: 'swim' }, idle: { kind: 'idle', duration: 3 } },
  }),
  /** A snake: a small head and a long ground chain that carries it in serpentine waves. */
  snake: () => ({
    describe: 'a snake (head + a 16-segment ground chain, serpentine)',
    def: {
      name: 'Snake',
      parts: [
        { kind: 'body', shape: 'capsule', size: [0.075, 0.05, 0.13], height: 0.035, color: '#5d8a3f', style: { eyes: '#1d1a16' } },
        { kind: 'chain', id: 'spine', at: [0, 0.035, -0.06], dir: [0, 0, -1], length: 1.45, segments: 16, r0: 0.036, r1: 0.008, color: '#6f9c48', motion: 'serpent', ground: true, wavelength: 0.75, amp: 0.16 },
      ],
    },
    motions: { slither: { kind: 'slither', speed: 0.32 } },
  }),
  /** A little car on springy suspension, driving a bumpy road. */
  car: () => ({
    describe: 'a small car: body + four wheels on springy suspension (wheels part) over a bumpy road',
    def: {
      name: 'Little Car',
      parts: [
        { kind: 'body', shape: 'box', size: [0.9, 0.32, 1.7], height: 0.46, color: '#2f6f9f' },
        { kind: 'wheels', id: 'wheels', axles: [{ z: 0.56, track: 0.98, r: 0.19, w: 0.14 }, { z: -0.56, track: 0.98, r: 0.19, w: 0.14 }], ride: 0.27, travel: 0.07, hz: 1.7, damp: 0.5, color: '#24262a', hub: '#c9c2b4' },
        { kind: 'hinge', id: 'cabin', at: [0, 0.62, -0.1], axis: [1, 0, 0], shapes: [{ shape: { kind: 'box', c: [0, 0.74, -0.12], size: [0.78, 0.26, 0.82] }, color: '#e9e2d4' }, { shape: { kind: 'box', c: [0, 0.75, 0.25], size: [0.7, 0.18, 0.04] }, color: '#9ec7dd' }, { shape: { kind: 'box', c: [0, 0.76, -0.52], size: [0.66, 0.16, 0.03] }, color: '#9ec7dd' }, { shape: { kind: 'box', c: [0.39, 0.76, -0.1], size: [0.02, 0.15, 0.6] }, color: '#9ec7dd' }, { shape: { kind: 'box', c: [-0.39, 0.76, -0.1], size: [0.02, 0.15, 0.6] }, color: '#9ec7dd' }, { shape: { kind: 'box', c: [0.3, 0.53, 0.855], size: [0.16, 0.08, 0.02] }, color: '#f4e7b2' }, { shape: { kind: 'box', c: [-0.3, 0.53, 0.855], size: [0.16, 0.08, 0.02] }, color: '#f4e7b2' }, { shape: { kind: 'box', c: [0, 0.4, 0.855], size: [0.36, 0.07, 0.02] }, color: '#1f2a33' }, { shape: { kind: 'box', c: [0.32, 0.53, -0.855], size: [0.14, 0.07, 0.02] }, color: '#b8382c' }, { shape: { kind: 'box', c: [-0.32, 0.53, -0.855], size: [0.14, 0.07, 0.02] }, color: '#b8382c' }, { shape: { kind: 'box', c: [0, 0.33, 0.87], size: [0.94, 0.06, 0.06] }, color: '#cfc8ba' }, { shape: { kind: 'box', c: [0, 0.33, -0.87], size: [0.94, 0.06, 0.06] }, color: '#cfc8ba' }], motion: { kind: 'still' }, limit: { min: -2, max: 2 } },
        { kind: 'spring', id: 'aerial', at: [0.32, 0.86, -0.42], dir: [0, 1, -0.15], length: 0.34, r: 0.006, color: '#d9d4c8', hz: 2.1, damp: 0.16 },
      ],
      terrain: { period: 9.55, bumps: [{ amp: 0.035, k: 3, kx: 2.2 }, { amp: 0.022, k: 7, phase: 1.3 }, { amp: 0.012, k: 13, phase: 0.4, kx: 5 }], color: '#9a8f78' },
    },
    motions: { drive: { kind: 'drive', speed: 1.6 } },
  }),
  /** A windmill: four sails on a spinning hub, a cap that turns into the wind, grass swaying around it. */
  windmill: () => ({
    describe: 'a windmill: a spinning sail hinge, a cap hinge that turns within limits, and swaying grass',
    def: {
      name: 'Windmill',
      parts: [
        { kind: 'body', shape: 'box', size: [0.9, 2.2, 0.9], height: 1.1, color: '#d9cdb4' },
        { kind: 'hinge', id: 'cap', at: [0, 2.2, 0], axis: [0, 1, 0], shapes: [{ shape: { kind: 'box', c: [0, 2.42, 0.05], size: [1.0, 0.44, 1.1] }, color: '#7b4b33' }], motion: { kind: 'swing', min: -12, max: 12, period: 8 }, limit: { min: -15, max: 15 } },
        { kind: 'hinge', id: 'sails', parent: 'cap', at: [0, 2.42, 0.62], axis: [0, 0, 1], shapes: [
          { shape: { kind: 'ball', c: [0, 2.42, 0.64], r: 0.09, sides: 10 }, color: '#4a3528' },
          // sails: cloth on a lattice, trailing each spar (facing the wind, +Z)
          ...[0, 90, 180, 270].flatMap((deg) => {
            const a = (deg * Math.PI) / 180, d: V3 = [Math.cos(a), Math.sin(a), 0], side: V3 = [-Math.sin(a), Math.cos(a), 0];
            const at = (r: number, s: number, z = 0.66): V3 => add(add([0, 2.42, z], mul(d, r)), mul(side, s));
            return [
              { shape: { kind: 'blade' as const, a: at(0.3, 0.17), b: at(1.25, 0.17), w: 0.3, normal: [0, 0, 1] as V3, taper: 1 }, color: '#efe6d2' },
              ...[0.3, 0.62, 0.94, 1.25].map((r) => ({ shape: { kind: 'seg' as const, a: at(r, 0, 0.68), b: at(r, 0.33, 0.68), r1: 0.011, r2: 0.011, sides: 4 }, color: '#6b4a33' })),
              { shape: { kind: 'seg' as const, a: at(0.3, 0.33, 0.68), b: at(1.25, 0.33, 0.68), r1: 0.011, r2: 0.011, sides: 4 }, color: '#6b4a33' },
            ];
          }),
          ...[0, 90, 180, 270].map((deg) => {
            const a = (deg * Math.PI) / 180, d: V3 = [Math.cos(a), Math.sin(a), 0];
            return { shape: { kind: 'seg' as const, a: add([0, 2.42, 0.67], mul(d, 0.05)), b: add([0, 2.42, 0.67], mul(d, 1.3)), r1: 0.02, r2: 0.014, sides: 5 }, color: '#5b3b29' };
          }),
        ], motion: { kind: 'spin', rpm: 15 } },
        // a door and a window (still hinges: they ride the tower)
        { kind: 'hinge', id: 'door', at: [0, 0, 0.45], axis: [1, 0, 0], shapes: [{ shape: { kind: 'box', c: [0, 0.38, 0.455], size: [0.34, 0.76, 0.03] }, color: '#5b3b29' }, { shape: { kind: 'box', c: [0, 1.45, 0.455], size: [0.24, 0.26, 0.03] }, color: '#3c4a55' }, { shape: { kind: 'box', c: [0, 1.45, 0.47], size: [0.3, 0.04, 0.02] }, color: '#efe6d2' }], motion: { kind: 'still' } },
        // grass: shader sway (one mesh each; the engines bend it in a vertex shader, live)
        { kind: 'sway', id: 'grass', mode: 'shader', area: [-2.2, -2.2, 2.2, 2.2], count: 520, height: 0.3, width: 0.04, wind: [1, 0, 0.3], strength: 16, color: '#6f9a43', seed: 11 },
        { kind: 'sway', id: 'grass2', mode: 'shader', area: [-2.2, -2.2, 2.2, 2.2], count: 380, height: 0.22, width: 0.035, wind: [1, 0, 0.3], strength: 18, color: '#8fb35a', seed: 29 },
      ],
    },
    motions: { turn: { kind: 'idle', duration: 4 } },
  }),
};

/** The parts every existing body plan is made of (re-expressed; the character kit still builds them). */
export const BODY_PLAN_PARTS: Record<string, Array<{ kind: PartSpec['kind'] | 'arm' | 'face'; id: string; note: string }>> = {
  human: [
    { kind: 'legs', id: 'legs', note: '×2, knees forward; the walk/run gait planner (motion.ts) plants the feet' },
    { kind: 'chain', id: 'spine', note: 'Hips → Spine → Chest → UpperChest → Neck → Head (lean, breathing, look)' },
    { kind: 'arm', id: 'arms', note: '×2 two-bone limbs with full fingers (hands as settings, grips)' },
    { kind: 'face', id: 'face', note: 'face parts with their own 15 speech shapes + expressions' },
    { kind: 'spring', id: 'apron', note: 'apron bones (spring bones), when the character wears one' },
  ],
  chibi: [{ kind: 'legs', id: 'legs', note: '×2 (bounce gait)' }, { kind: 'chain', id: 'spine', note: 'short spine, big head' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }],
  lanky: [{ kind: 'legs', id: 'legs', note: '×2 (long stride)' }, { kind: 'chain', id: 'spine', note: 'long spine' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }],
  stocky: [{ kind: 'legs', id: 'legs', note: '×2 (swagger gait)' }, { kind: 'chain', id: 'spine', note: 'barrel spine' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'face parts' }, { kind: 'spring', id: 'apron', note: 'apron bones' }],
  beaked: [{ kind: 'legs', id: 'legs', note: '×2 (waddle; bird legs optional)' }, { kind: 'chain', id: 'spine', note: 'spine + long neck' }, { kind: 'arm', id: 'arms', note: '×2' }, { kind: 'face', id: 'face', note: 'beak mouth part' }, { kind: 'chain', id: 'wings', note: 'wings: folded/flap pose set (optional)' }, { kind: 'chain', id: 'tail', note: 'tail chain (optional, spring-driven)' }],
  quadruped: [{ kind: 'legs', id: 'legs', note: '×4, walk/trot/gallop footfall order (quadruped.ts)' }, { kind: 'chain', id: 'spine', note: 'spine + neck + head' }, { kind: 'chain', id: 'tail', note: 'tail chain: lags and wags' }, { kind: 'face', id: 'face', note: 'muzzle mouth part' }],
};

export function creatureFromPreset(name: string): CreaturePreset {
  const p = CREATURE_PRESETS[name];
  if (!p) throw new Error(`no creature preset "${name}" (presets: ${Object.keys(CREATURE_PRESETS).join(', ')})`);
  return p();
}

// ── low-poly meshes (flat-shaded triangles, object space) ───────────────────────────────────────

export interface TriMesh { pos: number[]; idx: number[]; nrm?: number[] }   // nrm: smooth per-vertex normals (else faceted)

function basis(z: V3): [V3, V3, V3] {
  const zz = norm(z);
  const helper: V3 = Math.abs(zz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = norm(cross(helper, zz));
  const y = cross(zz, x);
  return [x, y, zz];
}

/** A smooth tapered segment: elliptical cross-section (squash), side normals that follow the taper,
 *  domed (round) or flat ends. */
function smoothSeg(s: Extract<PartShape, { kind: 'seg' }>): TriMesh {
  const pos: number[] = [], idx: number[] = [], nrm: number[] = [];
  const v = (p: V3, nn: V3) => { pos.push(p[0], p[1], p[2]); nrm.push(nn[0], nn[1], nn[2]); return pos.length / 3 - 1; };
  const n = Math.max(6, s.sides ?? 12);
  const [x, y, z] = basis(sub(s.b, s.a));
  const L = len(sub(s.b, s.a)) || 1e-6;
  const [sx, sy] = s.squash ?? [1, 1];
  const phiSide = Math.atan2(s.r1 - s.r2, L);
  // a ring: centre c, radius r, latitude phi (normal tilts toward ±z)
  const ring = (c: V3, r: number, phi: number) => Array.from({ length: n }, (_, i) => {
    const a = (TAU * i) / n, ca = Math.cos(a), sa = Math.sin(a);
    const p = add(c, add(mul(x, ca * r * sx), mul(y, sa * r * sy)));
    const radial = norm(add(mul(x, ca / sx), mul(y, sa / sy)));
    return v(p, norm(add(mul(radial, Math.cos(phi)), mul(z, Math.sin(phi)))));
  });
  const strip: Array<number[] | number> = [];
  const m = Math.max(2, Math.round(n / 4));
  const k = Math.min(sx, sy);
  if (s.round) {
    strip.push(v(add(s.a, mul(z, -s.r1 * k)), mul(z, -1)));
    for (let j = m - 1; j >= 1; j--) { const ph = (Math.PI / 2) * (j / m); strip.push(ring(add(s.a, mul(z, -s.r1 * k * Math.sin(ph))), s.r1 * Math.cos(ph), -ph)); }
  } else {
    strip.push(v(s.a, mul(z, -1)));
    strip.push(Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n; return v(add(s.a, add(mul(x, Math.cos(a) * s.r1 * sx), mul(y, Math.sin(a) * s.r1 * sy))), mul(z, -1)); }));
  }
  strip.push(ring(s.a, s.r1, phiSide), ring(s.b, s.r2, phiSide));
  if (s.round) {
    for (let j = 1; j < m; j++) { const ph = (Math.PI / 2) * (j / m); strip.push(ring(add(s.b, mul(z, s.r2 * k * Math.sin(ph))), s.r2 * Math.cos(ph), ph)); }
    strip.push(v(add(s.b, mul(z, s.r2 * k)), z));
  } else {
    strip.push(Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n; return v(add(s.b, add(mul(x, Math.cos(a) * s.r2 * sx), mul(y, Math.sin(a) * s.r2 * sy))), z); }));
    strip.push(v(s.b, z));
  }
  for (let r = 0; r + 1 < strip.length; r++) {
    const P = strip[r], Q = strip[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (typeof P === 'number' && Array.isArray(Q)) idx.push(P, Q[j], Q[i]);
      else if (Array.isArray(P) && typeof Q === 'number') idx.push(P[i], P[j], Q);
      else if (Array.isArray(P) && Array.isArray(Q)) idx.push(P[i], P[j], Q[j], P[i], Q[j], Q[i]);
    }
  }
  return { pos, idx, nrm };
}

/** Smooth vertex normals: the area-weighted face normals around each vertex. */
function vertexNormals(pos: number[], idx: number[]): number[] {
  const n = new Array(pos.length).fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const P = [0, 1, 2].map((k) => [pos[idx[t + k] * 3], pos[idx[t + k] * 3 + 1], pos[idx[t + k] * 3 + 2]] as V3);
    const f = cross(sub(P[1], P[0]), sub(P[2], P[0]));
    for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) n[idx[t + k] * 3 + d] += f[d];
  }
  for (let i = 0; i < n.length; i += 3) { const v = norm([n[i], n[i + 1], n[i + 2]]); n[i] = v[0]; n[i + 1] = v[1]; n[i + 2] = v[2]; }
  return n;
}

/** The outline of a feather at u (0 root … 1 tip): half width as a fraction of w/2. */
export function featherWidth(u: number, point = false): number {
  const base = 0.42 + 0.58 * Math.sin((Math.PI / 2) * Math.min(1, u / 0.3));
  const tip = u < 0.55 ? 1 : point ? Math.max(0, (1 - u) / 0.45) ** 0.8 : Math.sqrt(Math.max(0, 1 - ((u - 0.55) / 0.45) ** 2));
  return base * tip;
}

/** A feather (or a band of one): two smooth surfaces (top and underside) a shaft's thickness apart,
 *  stitched round the outline. */
function featherMesh(s: Extract<PartShape, { kind: 'feather' }>): TriMesh {
  const d = sub(s.b, s.a), L = len(d) || 1e-6;
  const z = norm(d);
  const n0 = s.normal ? norm(s.normal) : basis(d)[1];
  const y = norm(sub(n0, mul(z, n0[0] * z[0] + n0[1] * z[1] + n0[2] * z[2])));
  const x = cross(y, z);
  const u0 = s.from ?? 0, u1 = s.to ?? 1;
  const rows = Math.max(2, Math.round(10 * (u1 - u0)) + 1), cols = 7;
  const curve = s.curve ?? 0.08, camber = s.camber ?? 0.12, asym = s.asym ?? 0;
  const th = Math.max(0.0012, s.w * 0.035);
  const pos: number[] = [], idx: number[] = [];
  const grid = (side: 1 | -1) => {
    const g: number[][] = [];
    for (let r = 0; r < rows; r++) {
      const u = u0 + ((u1 - u0) * r) / (rows - 1);
      const hw = (s.w / 2) * Math.max(0.03, featherWidth(Math.min(u, 0.985), s.point));
      const c = add(add(s.a, mul(z, L * u)), mul(y, -curve * L * u * u));
      const row: number[] = [];
      for (let k = 0; k < cols; k++) {
        const t = -1 + (2 * k) / (cols - 1);
        const wv = hw * t * (t < 0 ? 1 - asym : 1 + asym);
        // the shaft stands proud; the vanes fall away from it and thin toward their edges
        const lift = camber * hw * (1 - t * t) + side * (th / 2) * (0.35 + 0.65 * (1 - Math.abs(t))) * (1 - 0.6 * u);
        const p = add(add(c, mul(x, wv)), mul(y, lift));
        pos.push(p[0], p[1], p[2]);
        row.push(pos.length / 3 - 1);
      }
      g.push(row);
    }
    return g;
  };
  const T = grid(1), B = grid(-1);
  for (let r = 0; r + 1 < rows; r++) for (let k = 0; k + 1 < cols; k++) {
    // top faces +y, the underside faces −y
    idx.push(T[r][k], T[r + 1][k], T[r + 1][k + 1], T[r][k], T[r + 1][k + 1], T[r][k + 1]);
    idx.push(B[r][k], B[r + 1][k + 1], B[r + 1][k], B[r][k], B[r][k + 1], B[r + 1][k + 1]);
  }
  const nrm = vertexNormals(pos, idx);
  // the rim: its own vertices (flat-ish edge normals), so the surfaces stay smooth
  const rim = (a1: number, a2: number, b1: number, b2: number) => {
    const P = [a1, a2, b2, b1].map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as V3);
    const f = norm(cross(sub(P[1], P[0]), sub(P[2], P[0])));
    const base = pos.length / 3;
    for (const p of P) { pos.push(...p); nrm.push(...f); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let r = 0; r + 1 < rows; r++) { rim(T[r + 1][0], T[r][0], B[r + 1][0], B[r][0]); rim(T[r][cols - 1], T[r + 1][cols - 1], B[r][cols - 1], B[r + 1][cols - 1]); }
  for (let k = 0; k + 1 < cols; k++) { rim(T[0][k], T[0][k + 1], B[0][k], B[0][k + 1]); rim(T[rows - 1][k + 1], T[rows - 1][k], B[rows - 1][k + 1], B[rows - 1][k]); }
  return { pos, idx, nrm };
}

/** A closed triangle mesh for a shape (object space). */
export function shapeMesh(s: PartShape): TriMesh {
  if (s.kind === 'feather') return featherMesh(s);
  const pos: number[] = [], idx: number[] = [];
  const v = (p: V3) => { pos.push(p[0], p[1], p[2]); return pos.length / 3 - 1; };
  const tri = (a: number, b: number, c: number) => idx.push(a, b, c);
  const ring = (c: V3, x: V3, y: V3, r: number, n: number, rot = 0) => Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n + rot; return v(add(c, add(mul(x, Math.cos(a) * r), mul(y, Math.sin(a) * r)))); });
  switch (s.kind) {
    case 'box': {
      const [hx, hy, hz] = s.size.map((x) => x / 2);
      const c = s.c;
      const P = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(([a, b, d]) => v([c[0] + a * hx, c[1] + b * hy, c[2] + d * hz]));
      const F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
      for (const [a, b, c2, d] of F) { tri(P[a], P[b], P[c2]); tri(P[a], P[c2], P[d]); }
      break;
    }
    case 'seg': {
      if (!s.flat) return smoothSeg(s);
      const n = s.sides ?? 8;
      const [x, y, z] = basis(sub(s.b, s.a));
      const A = ring(s.a, x, y, s.r1, n), B = ring(s.b, x, y, s.r2, n);
      const ca = v(s.a), cb = v(s.b);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(A[i], A[j], B[j]); tri(A[i], B[j], B[i]);
        tri(ca, A[j], A[i]); tri(cb, B[i], B[j]);
      }
      void z;
      break;
    }
    case 'ball': {
      const n = s.sides ?? 10, rings = Math.max(3, Math.round(n / 2));
      const k = s.scale ?? [1, 1, 1];
      const nrm: number[] = [];
      const smooth = !s.flat;
      const vn = (p: V3) => { const i = v(p); if (smooth) { const d = sub(p, s.c); const nn = norm([d[0] / (k[0] * k[0]), d[1] / (k[1] * k[1]), d[2] / (k[2] * k[2])]); nrm.push(...nn); } return i; };
      const top = vn([s.c[0], s.c[1] + s.r * k[1], s.c[2]]), bot = vn([s.c[0], s.c[1] - s.r * k[1], s.c[2]]);
      const R: number[][] = [];
      for (let j = 1; j < rings; j++) {
        const th = (Math.PI * j) / rings;
        R.push(Array.from({ length: n }, (_, i) => { const a = (TAU * i) / n; return vn([s.c[0] + Math.sin(th) * Math.cos(a) * s.r * k[0], s.c[1] + Math.cos(th) * s.r * k[1], s.c[2] + Math.sin(th) * Math.sin(a) * s.r * k[2]]); }));
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(top, R[0][j], R[0][i]);
        for (let r = 0; r < R.length - 1; r++) { tri(R[r][i], R[r][j], R[r + 1][j]); tri(R[r][i], R[r + 1][j], R[r + 1][i]); }
        tri(bot, R[R.length - 1][i], R[R.length - 1][j]);
      }
      if (smooth) return { pos, idx, nrm };
      break;
    }
    case 'wheel': {
      const n = 14;
      const x: V3 = [0, 0, 1], y: V3 = [0, 1, 0];
      const a = add(s.c, [-s.w / 2, 0, 0]), b = add(s.c, [s.w / 2, 0, 0]);
      // a tyre with a slightly smaller rim face, so the turning shows
      const A = ring(a, x, y, s.r, n), B = ring(b, x, y, s.r, n);
      const Ai = ring(add(a, [-0.002, 0, 0]), x, y, s.r * 0.62, n), Bi = ring(add(b, [0.002, 0, 0]), x, y, s.r * 0.62, n);
      const ca = v(add(a, [-0.004, 0, 0])), cb = v(add(b, [0.004, 0, 0]));
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tri(A[i], B[j], A[j]); tri(A[i], B[i], B[j]);
        tri(A[i], A[j], Ai[j]); tri(A[i], Ai[j], Ai[i]);
        tri(B[i], Bi[j], B[j]); tri(B[i], Bi[i], Bi[j]);
        tri(ca, Ai[j], Ai[i]); tri(cb, Bi[i], Bi[j]);
      }
      break;
    }
    case 'blade': {
      // a thin tapered slab (closed), widest at the base
      const d = sub(s.b, s.a);
      const [x, y] = s.normal ? [norm(cross(s.normal, d)), norm(s.normal)] : basis(d);
      const t = Math.max(0.004, s.w * 0.06);
      const w0 = s.w / 2, w1 = (s.w / 2) * (s.taper ?? 0.24);
      const q = (p: V3, w: number, side: number) => v(add(add(p, mul(x, w)), mul(y, t * side)));
      const a0 = q(s.a, -w0, 1), a1 = q(s.a, w0, 1), b0 = q(s.b, -w1, 1), b1 = q(s.b, w1, 1);
      const c0 = q(s.a, -w0, -1), c1 = q(s.a, w0, -1), d0 = q(s.b, -w1, -1), d1 = q(s.b, w1, -1);
      const F = [[a0, a1, b1, b0], [c1, c0, d0, d1], [a0, b0, d0, c0], [a1, c1, d1, b1], [b0, b1, d1, d0], [a0, c0, c1, a1]];
      for (const [p1, p2, p3, p4] of F) { tri(p1, p2, p3); tri(p1, p3, p4); }
      break;
    }
  }
  return { pos, idx };
}

/** Every piece's mesh at rest, grouped by part (for the studio view and print/plain exports). */
export function creatureRestMeshes(c: Creature): Array<{ part: string; bone: string; color: string; mesh: TriMesh }> {
  return c.pieces.map((pc) => ({ part: pc.part, bone: pc.bone, color: pc.color, mesh: shapeMesh(pc.shape) }));
}

/** A ground patch for the terrain (periodic bumps) under a creature, `size` metres square. */
export function terrainMesh(c: Creature, size: number, along = size, step = 0.12): TriMesh {
  const pos: number[] = [], idx: number[] = [];
  const nx = Math.max(2, Math.round(size / step)), nz = Math.max(2, Math.round(along / step));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const x = -size / 2 + (size * i) / nx, z = -along / 2 + (along * j) / nz;
    pos.push(x, terrainHeight(c.def.terrain, x, z), z);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, cc = a + nx + 1, d = cc + 1;
    idx.push(a, cc, d, a, d, b);
  }
  return { pos, idx };
}

// ── glTF: one node per bone, pieces as meshes on their bone, TRS animation per clip ──────────────

function flat(m: TriMesh, origin: V3): { p: Float32Array; n: Float32Array } {
  const p = new Float32Array(m.idx.length * 3), n = new Float32Array(m.idx.length * 3);
  for (let t = 0; t < m.idx.length; t += 3) {
    const vs = [0, 1, 2].map((k) => { const i = m.idx[t + k]; return [m.pos[i * 3] - origin[0], m.pos[i * 3 + 1] - origin[1], m.pos[i * 3 + 2] - origin[2]] as V3; });
    const nn = norm(cross(sub(vs[1], vs[0]), sub(vs[2], vs[0])));
    vs.forEach((vv, k) => {
      p.set(vv, (t + k) * 3);
      const i = m.idx[t + k];
      n.set(m.nrm ? [m.nrm[i * 3], m.nrm[i * 3 + 1], m.nrm[i * 3 + 2]] : nn, (t + k) * 3);
    });
  }
  return { p, n };
}

const hexRGB = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const lin = (x: number) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return [lin(parseInt(h.slice(0, 2), 16)), lin(parseInt(h.slice(2, 4), 16)), lin(parseInt(h.slice(4, 6), 16))];
};

export interface CreatureGlbOpts { terrain?: { size: number; along?: number }; checks?: Record<string, MotionCheck[]> }

/** A creature as GLB: a node per bone (rest offsets), its pieces as meshes, and an animation per clip. */
export function creatureGLB(c: Creature, clips: CreatureClip[], opts: CreatureGlbOpts = {}): Uint8Array {
  const B = new GlbBuilder();
  const g = B.gltf;
  const mats = new Map<string, number>();
  const matOf = (color: string) => {
    if (!mats.has(color)) { g.materials.push({ name: color, pbrMetallicRoughness: { baseColorFactor: [...hexRGB(color), 1], metallicFactor: 0, roughnessFactor: 0.75 } }); mats.set(color, g.materials.length - 1); }
    return mats.get(color)!;
  };
  const root = g.nodes.length;
  g.nodes.push({ name: c.def.name, children: [], extras: { creature: true, parts: c.parts.map((p) => ({ kind: p.spec.kind, id: (p.spec as any).id ?? 'body', checks: p.checks })), ...(opts.checks ? { checks: opts.checks } : {}) } });
  g.scenes[0].nodes.push(root);
  const nodeOf: number[] = [];
  c.bones.forEach((b, i) => {
    const p = c.parents[i];
    const t = p < 0 ? b.head : sub(b.head, c.bones[p].head);
    const node = g.nodes.length;
    const sw = c.def.parts.find((p) => p.kind === 'sway' && p.mode === 'shader' && p.id === b.name) as SwayPartSpec | undefined;
    g.nodes.push({ name: b.name, translation: t.map((x) => +x.toFixed(6)), children: [], ...(sw ? { extras: { sway: swayParams(sw) } } : {}) });
    nodeOf.push(node);
    if (p < 0) g.nodes[root].children.push(node); else g.nodes[nodeOf[p]].children.push(node);
  });
  // pieces: one mesh per bone, one primitive per colour (vertices relative to the bone's head)
  const byBone = new Map<number, Map<string, TriMesh[]>>();
  for (const pc of c.pieces) {
    const bi = c.index.get(pc.bone)!;
    if (!byBone.has(bi)) byBone.set(bi, new Map());
    const m = byBone.get(bi)!;
    if (!m.has(pc.color)) m.set(pc.color, []);
    m.get(pc.color)!.push(shapeMesh(pc.shape));
  }
  for (const [bi, byColor] of byBone) {
    const prims: any[] = [];
    for (const [color, meshes] of byColor) {
      const parts = meshes.map((m) => flat(m, c.bones[bi].head));
      const total = parts.reduce((s2, x) => s2 + x.p.length, 0);
      const p = new Float32Array(total), n = new Float32Array(total);
      let o = 0;
      for (const x of parts) { p.set(x.p, o); n.set(x.n, o); o += x.p.length; }
      prims.push({ attributes: { POSITION: B.accessor(p, 'VEC3', true), NORMAL: B.accessor(n, 'VEC3') }, material: matOf(color) });
    }
    g.meshes.push({ name: `${c.bones[bi].name}.mesh`, primitives: prims });
    g.nodes[nodeOf[bi]].mesh = g.meshes.length - 1;
  }
  // the ground (terrain), as its own node beside the creature
  if (opts.terrain) {
    const tm = terrainMesh(c, opts.terrain.size, opts.terrain.along ?? opts.terrain.size);
    const { p, n } = flat(tm, [0, 0, 0]);
    g.meshes.push({ name: 'ground', primitives: [{ attributes: { POSITION: B.accessor(p, 'VEC3', true), NORMAL: B.accessor(n, 'VEC3') }, material: matOf(c.def.terrain?.color ?? '#a99f8a') }] });
    g.nodes.push({ name: 'ground', mesh: g.meshes.length - 1, extras: { terrain: c.def.terrain ?? null } });
    g.scenes[0].nodes.push(g.nodes.length - 1);
  }
  // animations: rotation for every bone, translation where it moves (struts, sliders, the body)
  g.animations = [];
  for (const clip of clips) {
    const F = clip.frames + 1;
    const times = new Float32Array(F);
    for (let f = 0; f < F; f++) times[f] = f / clip.fps;
    const input = B.typed(times, 'SCALAR', { minmax: true });
    const samplers: any[] = [], channels: any[] = [];
    c.bones.forEach((b, bi) => {
      const moves = clip.rot.some((r) => Math.abs(r[bi][3]) < 0.99999);
      const slides = clip.off.some((o) => Math.hypot(...o[bi]) > 1e-6);
      if (moves) {
        const q = new Float32Array(F * 4);
        let prev: Q | null = null;
        for (let f = 0; f < F; f++) {
          let r = clip.rot[f][bi];
          // keep consecutive keys on the same hemisphere so the engine interpolates the short way
          if (prev && prev[0] * r[0] + prev[1] * r[1] + prev[2] * r[2] + prev[3] * r[3] < 0) r = [-r[0], -r[1], -r[2], -r[3]];
          q.set(r, f * 4); prev = r;
        }
        samplers.push({ input, output: B.typed(q, 'VEC4'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[bi], path: 'rotation' } });
      }
      if (slides) {
        const p = c.parents[bi];
        const rest = p < 0 ? b.head : sub(b.head, c.bones[p].head);
        const tr = new Float32Array(F * 3);
        for (let f = 0; f < F; f++) tr.set(add(rest, clip.off[f][bi]), f * 3);
        samplers.push({ input, output: B.typed(tr, 'VEC3'), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeOf[bi], path: 'translation' } });
      }
    });
    g.animations.push({ name: clip.id, samplers, channels, extras: { loop: clip.loop, speed: clip.speed, dir: clip.dir, duration: clip.duration } });
  }
  for (const nd of g.nodes) if (Array.isArray(nd.children) && !nd.children.length) delete nd.children;
  return finishGlb(B);
}

function finishGlb(B: GlbBuilder): Uint8Array {
  // GlbBuilder.finish may not exist in every version: assemble the GLB container here
  const anyB = B as any;
  if (typeof anyB.finish === 'function') return anyB.finish();
  if (typeof anyB.build === 'function') return anyB.build();
  throw new Error('GlbBuilder has no finish/build');
}

/** What a sway shader needs (three.js and Godot use the same formula as swayDeg). */
export function swayParams(p: SwayPartSpec) {
  const w = p.wind ?? [1, 0, 0.3], l = Math.hypot(w[0], w[1], w[2]) || 1;
  return { wind: [w[0] / l, 0, w[2] / l], strength: p.strength ?? 14, height: p.height, gustK: (2 * Math.PI) / 2.5, per: 1 / 2.2, energy: 0.5 };
}

/** The sway as a Godot 4 spatial shader (set it on the grass mesh; parameters from the node's extras.sway). */
export function swayGodotShader(p: SwayPartSpec): string {
  const s = swayParams(p);
  return `// sway shader for "${p.id}" (studio, Decision 52): blades bend with a travelling gust, root fixed
shader_type spatial;
render_mode cull_disabled;
uniform vec4 albedo : source_color = vec4(${[1, 3, 5].map((i) => (parseInt(p.color.slice(i, i + 2), 16) / 255).toFixed(4)).join(', ')}, 1.0);
uniform vec3 wind = vec3(${s.wind.map((x) => x.toFixed(4)).join(', ')});
uniform float strength = ${s.strength.toFixed(2)};
uniform float blade_height = ${s.height.toFixed(3)};
uniform float gust_k = ${s.gustK.toFixed(4)};
uniform float per = ${s.per.toFixed(4)};
uniform float energy = ${s.energy.toFixed(2)};
void vertex() {
  float k = clamp(VERTEX.y / (blade_height * 1.3), 0.0, 1.0);
  float ph = gust_k * dot(VERTEX.xz, wind.xz);
  float deg = strength * (0.6 + energy * 0.8) * (0.55 + 0.45 * sin(TAU * per * TIME - ph)) + 3.0 * sin(TAU * per * 3.0 * TIME + VERTEX.x * 7.0 + VERTEX.z * 5.0);
  float a = radians(deg) * k;
  float h = VERTEX.y;
  VERTEX.xz += wind.xz * sin(a) * h;
  VERTEX.y = h * cos(a);
}
void fragment() { ALBEDO = albedo.rgb; ROUGHNESS = 0.9; }
`;
}

/** Build a preset creature and bake every motion with its checks. */
export function creatureWithClips(name: string, fps = 30): { c: Creature; preset: CreaturePreset; clips: CreatureClip[]; checks: Record<string, MotionCheck[]> } {
  const preset = creatureFromPreset(name);
  const c = buildCreature(preset.def);
  const clips = Object.entries(preset.motions).map(([id, m]) => bakeCreature(c, id, m, fps));
  const checks = Object.fromEntries(clips.map((cl) => [cl.id, creatureChecks(c, cl)]));
  return { c, preset, clips, checks };
}

export { qIdentity, qMul, qRot, qAxisAngle, qArc };
