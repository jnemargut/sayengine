// The look record (Decision 29): a whole-scene look as data. One record drives the studio view, Godot,
// three.js, bakes and thumbnails (and later reels): a pinned tone curve, a 33³ colour grade, toon and
// outline, a named palette, fog, sky and light, and material tweaks. Engines never choose their own
// tonemapper: both output Reinhard ("transport") and the look's LUT undoes it, applies the pinned curve
// and grades, so Godot and the web get the same numbers by construction.
import { z } from 'zod';
import { TONE_CURVES, clamp01, hexToLinear, hexToRgb, linearToOklab, linearToSrgb, oklabToLinear, srgbToLinear, toneCurve, transport, untransport, type RGB } from './color.ts';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #a85b45');
const Trio = z.tuple([z.number(), z.number(), z.number()]);

export const MaterialTweakZ = z.object({
  emission: Hex.optional().describe('glow colour'),
  emissionEnergy: z.number().min(0).max(20).optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  tint: Hex.optional().describe('multiplies the base colour (also baked by the fallback)'),
});
export const BoardZ = z.object({
  references: z.array(z.string()).default([]).describe('reference pictures (paths relative to the studio folder)'),
  colourfulness: z.tuple([z.number(), z.number()]).optional().describe('Hasler–Süsstrunk M range, e.g. [38, 52]'),
  paletteMatch: z.number().min(0).max(1).optional().describe('lowest palette match (0..1)'),
  styleMin: z.number().min(-1).max(1).optional().describe('lowest local style score (cosine, DINOv2-small)'),
  notes: z.string().optional(),
});

export const LookZ = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  label: z.string().optional(),
  tonemap: z.object({ curve: z.enum(TONE_CURVES), exposure: z.number().min(-4).max(4).default(0) }).describe('pinned tone curve + exposure (stops)'),
  grade: z.object({
    temperature: z.number().min(-1).max(1).default(0), tint: z.number().min(-1).max(1).default(0),
    contrast: z.number().min(0.5).max(2).default(1), saturation: z.number().min(0).max(2).default(1), vibrance: z.number().min(-1).max(1).default(0),
    lift: Trio.default([0, 0, 0]), gamma: Trio.default([1, 1, 1]), gain: Trio.default([1, 1, 1]),
    shadows: z.object({ color: Hex, amount: z.number().min(0).max(1) }).optional(),
    highlights: z.object({ color: Hex, amount: z.number().min(0).max(1) }).optional(),
  }),
  lutSize: z.number().int().min(8).max(65).default(33),
  toon: z.object({ enabled: z.boolean().default(false), bands: z.number().int().min(2).max(6).default(3), softness: z.number().min(0).max(1).default(0.1) }).default({ enabled: false, bands: 3, softness: 0.1 }),
  outline: z.object({ enabled: z.boolean().default(false), width: z.number().min(0.5).max(4).default(1), color: Hex.default('#1d1b22'), threshold: z.number().min(0.001).max(1).default(0.06) }).default({ enabled: false, width: 1, color: '#1d1b22', threshold: 0.06 }),
  palette: z.record(z.string(), Hex).default({}),
  sky: z.object({ color: Hex }),
  fog: z.object({ enabled: z.boolean().default(true), color: Hex, begin: z.number().min(0), end: z.number().min(1) }),
  light: z.object({
    sun: z.object({ color: Hex, energy: z.number().min(0).max(8), elevation: z.number().min(-10).max(90), azimuth: z.number(), shadows: z.boolean().default(true) }),
    ambient: z.object({ color: Hex, energy: z.number().min(0).max(4) }),
  }),
  materials: z.record(z.string(), MaterialTweakZ).default({}).describe('tweaks by shading class (matte, glossy, metal, water, lit, lamp, led, neon, sign, flood, shop, pool) or material name; pool (light pools on the ground) is additive and only drawn when a look gives it emissionEnergy'),
  bloom: z.object({
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(16).default(1).describe('HDR level where glow starts (Godot glow_hdr_threshold)'),
    softness: z.number().min(0).max(8).default(2).describe('how far above the threshold glow reaches full strength (Godot glow_hdr_scale)'),
    intensity: z.number().min(0).max(8).default(0.8),
    levels: z.array(z.number().min(0).max(4)).length(7).default([0, 0, 1, 0, 1, 0, 0]).describe('weights of the 7 glow levels (half, quarter, … resolution)'),
  }).optional().describe('glow around bright lights: Godot Environment glow (additive) and a matched mip-chain pass on the web'),
  fallback: z.enum(['auto', 'grade', 'bake']).default('auto').describe('auto: grade where the renderer can, bake into colours where it cannot'),
  board: BoardZ.optional(),
});
export type Look = z.infer<typeof LookZ>;
export type MaterialTweak = z.infer<typeof MaterialTweakZ>;
export type Board = z.infer<typeof BoardZ>;

export const parseLook = (x: unknown): Look => LookZ.parse(x);

// ── presets ───────────────────────────────────────────────────────────────
const base = {
  lutSize: 33, toon: { enabled: false, bands: 3, softness: 0.1 }, fallback: 'auto' as const,
};
export const PRESETS: Record<string, Look> = {
  'day-toy': parseLook({
    ...base, name: 'day-toy', label: 'Day toy: a bright, clean model-railway morning; colours faithful, shadows a little cool, a thin ink line',
    tonemap: { curve: 'neutral', exposure: 0.1 },
    grade: { temperature: 0.06, tint: 0, contrast: 1.06, saturation: 1.0, vibrance: 0.05, lift: [0.01, 0.01, 0.018], gamma: [1, 1, 1], gain: [1.02, 1.0, 0.97], shadows: { color: '#4a6688', amount: 0.05 }, highlights: { color: '#ffe8c2', amount: 0.08 } },
    outline: { enabled: true, width: 1, color: '#2a2630', threshold: 0.08 },
    palette: { sky: '#bcd6ea', brick: '#a8503c', limestone: '#e2d8c3', glass: '#3f6f8a', leaf: '#5f8f3e', awning: '#2f6d5a', accent: '#e0a43a', asphalt: '#575a63' },
    sky: { color: '#bcd6ea' },
    fog: { enabled: true, color: '#c9dcea', begin: 380, end: 2200 },
    light: { sun: { color: '#fff3df', energy: 1.1, elevation: 63, azimuth: 28, shadows: true }, ambient: { color: '#d2d8e2', energy: 0.85 } },
    materials: { lamp: { emission: '#fff2cc', emissionEnergy: 0.3 }, led: { emission: '#f6f7f8', emissionEnergy: 0.3 } },
    board: { references: [], colourfulness: [30, 55], paletteMatch: 0.55 },
  }),
  // v3.1 (A/B picks 2026-11-05, checkpoint-pocket-raleigh/craft/ab): a real night instead of v2's blue-violet wash
  'neon-night': parseLook({
    ...base, name: 'neon-night', label: 'Neon night: a real night — near-black navy sky, neutral dark shadows; warm sodium and white LED street light pooling on the ground, lit shops spilling onto the sidewalk, a floodlit Capitol, glow around every light',
    tonemap: { curve: 'aces', exposure: 0.3 },
    grade: { temperature: 0, tint: 0, contrast: 1.08, saturation: 1.0, vibrance: 0.05, lift: [0.004, 0.004, 0.006], gamma: [1, 1, 1], gain: [1, 1, 1], shadows: { color: '#2a3340', amount: 0.08 }, highlights: { color: '#ffc88a', amount: 0.12 } },
    outline: { enabled: false, width: 1, color: '#0d0b1a', threshold: 0.08 },
    palette: { sky: '#0a1019', sodium: '#ffa04a', led: '#fff0dc', window: '#ffc073', magenta: '#ff4fb0', cyan: '#3fe0ff', asphalt: '#1a1c20', brick: '#5a3a30' },
    sky: { color: '#0a1019' },
    fog: { enabled: true, color: '#111822', begin: 140, end: 1200 },
    light: { sun: { color: '#aebbd0', energy: 0.14, elevation: 40, azimuth: 210, shadows: true }, ambient: { color: '#8f97a6', energy: 0.15 } },
    materials: {
      lit: { emission: '#ffc073', emissionEnergy: 1.6 },
      lamp: { emission: '#ffa04a', emissionEnergy: 7 },
      led: { emission: '#fff0dc', emissionEnergy: 7 },
      neon: { emission: '#ff4fb0', emissionEnergy: 4 },
      sign: { emission: '#3fe0ff', emissionEnergy: 2 },
      shop: { emission: '#ffd29a', emissionEnergy: 1.0 },
      flood: { emission: '#ffd7a3', emissionEnergy: 0.16 },
      pool: { emission: '#ffffff', emissionEnergy: 0.6 },
      water: { tint: '#3a4a5a', roughness: 0.08 },
    },
    bloom: { enabled: true, threshold: 1.2, softness: 2.0, intensity: 0.45, levels: [0, 0.8, 1, 0.6, 0.3, 0, 0] },
    board: { references: [], colourfulness: [20, 55], paletteMatch: 0.5 },
  }),
  'studio-neutral': parseLook({
    ...base, name: 'studio-neutral', label: 'Studio neutral: no grade, the pinned Neutral curve only (the studio view\'s default)',
    tonemap: { curve: 'neutral', exposure: 0 },
    grade: {},
    palette: {}, sky: { color: '#cddbe5' }, fog: { enabled: true, color: '#cddbe5', begin: 450, end: 2400 },
    light: { sun: { color: '#ffffff', energy: 1.05, elevation: 52, azimuth: 38, shadows: true }, ambient: { color: '#ccd1db', energy: 0.55 } },
  }),
};

// ── the grade ─────────────────────────────────────────────────────────────

/** White balance as linear gains (a gentle, Kelvin-free model: + warm, − cool; tint + magenta). */
function wb(t: number, tint: number): RGB { return [1 + 0.18 * t + 0.04 * tint, 1 - 0.1 * tint, 1 - 0.22 * t + 0.04 * tint]; }

/** The whole look from scene-linear light to a display sRGB value (0..1): exposure, white balance,
 *  the pinned curve, contrast, lift/gamma/gain, split toning, saturation and vibrance. */
export function gradeSceneLinear(look: Look, x: RGB): RGB {
  const g = look.grade;
  const e = 2 ** look.tonemap.exposure, w = wb(g.temperature, g.tint);
  let c = toneCurve(look.tonemap.curve, [x[0] * e * w[0], x[1] * e * w[1], x[2] * e * w[2]]);
  // display-referred grading on the encoded value
  let s = c.map(linearToSrgb) as RGB;
  s = s.map((v) => clamp01(0.5 + (v - 0.5) * g.contrast)) as RGB;
  s = s.map((v, i) => { const lifted = v * g.gain[i] + g.lift[i] * (1 - v); return clamp01(Math.max(0, lifted) ** (1 / g.gamma[i])); }) as RGB;
  c = s.map(srgbToLinear) as RGB;
  const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const tone = (hex: string, amount: number, weight: number) => {
    if (!amount || weight <= 0) return;
    const t = hexToLinear(hex), ty = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2] || 1;
    for (let i = 0; i < 3; i++) c[i] = c[i] * (1 - amount * weight) + (t[i] / ty) * Y * amount * weight;
  };
  if (g.shadows) tone(g.shadows.color, g.shadows.amount, (1 - Math.min(1, Y / 0.35)) ** 2);
  if (g.highlights) tone(g.highlights.color, g.highlights.amount, Math.max(0, (Y - 0.35) / 0.65) ** 1.5);
  // saturation and vibrance in Oklab (vibrance lifts the duller colours more)
  if (g.saturation !== 1 || g.vibrance) {
    const L = linearToOklab(c.map((v) => Math.max(0, v)) as RGB);
    const ch = Math.hypot(L[1], L[2]);
    const k = g.saturation * (1 + g.vibrance * (1 - Math.min(1, ch / 0.2)));
    c = oklabToLinear([L[0], L[1] * k, L[2] * k]);
  }
  return c.map((v) => linearToSrgb(Math.max(0, v))) as RGB;
}

/** The LUT's job for one input: the engines' transport value (sRGB-encoded Reinhard) → the graded output. */
export const gradeTransport = (look: Look, s: RGB): RGB => gradeSceneLinear(look, s.map(untransport) as RGB);

export interface Lut { size: number; data: Float32Array; convention: 'texel-centre' | 'cube' }
/**
 * The 33³ grade. `texel-centre` (what Godot's color correction and our three.js pass sample: texel i
 * holds input (i + 0.5) / N, sampled with plain hardware filtering) or `cube` (the .cube file's i / (N - 1)).
 * Index = r + g·N + b·N² (red fastest), 3 floats per entry.
 */
export function buildLut(look: Look, convention: Lut['convention'] = 'texel-centre'): Lut {
  const N = look.lutSize, data = new Float32Array(N * N * N * 3);
  const at = (i: number) => (convention === 'cube' ? i / (N - 1) : (i + 0.5) / N);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = gradeTransport(look, [at(r), at(g), at(b)]);
    const k = (r + g * N + b * N * N) * 3;
    data[k] = o[0]; data[k + 1] = o[1]; data[k + 2] = o[2];
  }
  return { size: N, data, convention };
}

/** Sample a LUT the way the GPU does (trilinear, clamped). */
export function sampleLut(lut: Lut, s: RGB): RGB {
  const N = lut.size;
  const pos = s.map((v) => (lut.convention === 'cube' ? clamp01(v) * (N - 1) : Math.min(N - 1, Math.max(0, clamp01(v) * N - 0.5))));
  const i0 = pos.map((p) => Math.min(N - 2, Math.floor(p))), f = pos.map((p, k) => p - i0[k]);
  const out: RGB = [0, 0, 0];
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    const k = ((i0[0] + dx) + (i0[1] + dy) * N + (i0[2] + dz) * N * N) * 3;
    out[0] += lut.data[k] * w; out[1] += lut.data[k + 1] * w; out[2] += lut.data[k + 2] * w;
  }
  return out;
}

/** Adobe/Resolve .cube text (three.js LUTCubeLoader, Resolve, Photoshop read it). */
export function cubeText(look: Look): string {
  const lut = buildLut(look, 'cube');
  const lines = [`TITLE "${look.name}"`, `# AI3DModel look ${look.name}: input is the engines' transport (sRGB-encoded Reinhard x/(1+x))`, `LUT_3D_SIZE ${lut.size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

/** The LUT as an 8-bit RGBA strip N²×N (slice b at x = b·N; x = r, y = g): Godot slices it into a Texture3D. */
export function lutStrip(lut: Lut): { rgba: Uint8Array; width: number; height: number } {
  const N = lut.size, W = N * N, rgba = new Uint8Array(W * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const k = (r + g * N + b * N * N) * 3, p = (g * W + b * N + r) * 4;
    rgba[p] = Math.round(clamp01(lut.data[k]) * 255); rgba[p + 1] = Math.round(clamp01(lut.data[k + 1]) * 255); rgba[p + 2] = Math.round(clamp01(lut.data[k + 2]) * 255); rgba[p + 3] = 255;
  }
  return { rgba, width: W, height: N };
}

// ── the bake fallback ─────────────────────────────────────────────────────

/** Typical light a surface gets under the look (ambient + the sun at an average 45° to the surface). */
export function referenceLight(look: Look): RGB {
  const a = hexToLinear(look.light.ambient.color), s = hexToLinear(look.light.sun.color);
  const ae = look.light.ambient.energy, se = look.light.sun.energy * 0.55;
  return [a[0] * ae + s[0] * se, a[1] * ae + s[1] * se, a[2] * ae + s[2] * se];
}

/**
 * Bake the grade into a base colour (linear in, linear out), for renderers without colour grading
 * (Godot's Compatibility renderer, old phones): under the look's reference light, the baked colour
 * through the plain transport tonemapper lands where the graded colour would. Exact at the reference
 * light, close nearby; far from it (deep shadow, glare) the grade's curve is lost.
 */
export function bakeLinear(look: Look, albedo: RGB, tweak?: MaterialTweak): RGB {
  const E = referenceLight(look);
  const t = tweak?.tint ? hexToLinear(tweak.tint) : [1, 1, 1];
  const lit: RGB = [albedo[0] * t[0] * E[0], albedo[1] * t[1] * E[1], albedo[2] * t[2] * E[2]];
  const graded = gradeSceneLinear(look, lit);
  return graded.map((v, i) => { const x = untransport(v); return Math.min(1, x / Math.max(1e-4, E[i])); }) as RGB;
}
export const bakeHex = (look: Look, hex: string, tweak?: MaterialTweak): string => {
  const c = bakeLinear(look, hexToRgb(hex).map(srgbToLinear) as RGB, tweak);
  return '#' + c.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('');
};

/** The light and sky as engines want them: sun direction (towards the sun), Godot's rotation, three.js intensities (×π). */
export function engineLight(look: Look) {
  const el = (look.light.sun.elevation * Math.PI) / 180, az = (look.light.sun.azimuth * Math.PI) / 180;
  const toSun: [number, number, number] = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  return {
    toSun, godotRotationDegrees: [-look.light.sun.elevation, look.light.sun.azimuth, 0],
    // Godot multiplies light energy by π internally (and ambient energy is radiance): three.js needs the π
    threeSunIntensity: look.light.sun.energy * Math.PI, threeAmbientIntensity: look.light.ambient.energy * Math.PI,
  };
}

/** What a game runtime reads (assets/studio/look/look.json): the record plus derived numbers. */
export function runtimeLook(look: Look) {
  return { version: 1, ...look, derived: { ...engineLight(look), lut: { size: look.lutSize, strip: 'lut.png', cube: 'look.cube', convention: 'texel-centre', transport: 'reinhard x/(1+x), sRGB-encoded' } } };
}

/** Pick the transport's value of a linear colour (handy in tests: what the LUT sees). */
export const transportOf = (c: RGB): RGB => c.map(transport) as RGB;
