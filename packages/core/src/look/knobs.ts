// Look knobs (Phase 10 step 3, Decision 62): the handful of look settings people actually reach for,
// as sliders in the live view. A knob reads its value from a look record and writes a partial record
// back (for `look-set`), in the units people say out loud: Kelvin for white balance and sun colour,
// stops for exposure, a 0–100 % fog density, degrees for the sun. Dragging previews in the view;
// releasing becomes ONE step with a word note: "warmer: white balance 6200 K → 5600 K".
// Also "show me three" for a look: three deliberately different grades of the current one.
import { mergeLook } from './tools.ts';
import { parseLook, type Look } from './look.ts';
import { hexToRgb, rgbToHex, type RGB } from './color.ts';

export interface Knob {
  id: string;
  label: string;                  // "white balance"
  group: 'grade' | 'fog' | 'sun' | 'night';
  min: number; max: number; step: number;
  /** words for the direction of a change: [value went up, value went down] */
  words: [string, string];
  get(look: Look): number;
  /** the partial record for look-set */
  set(look: Look, v: number): Record<string, unknown>;
  fmt(v: number): string;
  /** only for looks that have it (night lamps) */
  applies?(look: Look): boolean;
}

// ── white balance in Kelvin ────────────────────────────────────────────────────────────────────────
// The record keeps a gentle Kelvin-free temperature (−1 cool … +1 warm). People say Kelvin: the grade's
// white point reads as a colour temperature, 6500 K neutral, lower = warmer light. 0.1 ↔ 6200 K, 0.3 ↔ 5600 K.
export const KELVIN_NEUTRAL = 6500, KELVIN_PER_UNIT = 3000;
export const tempToKelvin = (t: number) => Math.round((KELVIN_NEUTRAL - KELVIN_PER_UNIT * t) / 50) * 50;
export const kelvinToTemp = (k: number) => +((KELVIN_NEUTRAL - k) / KELVIN_PER_UNIT).toFixed(4);

/** A light's colour at a colour temperature (Tanner Helland's fit of the blackbody curve, sRGB). */
export function kelvinToHex(k: number): string {
  const t = Math.min(40000, Math.max(1000, k)) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307; }
  else { r = 329.698727446 * (t - 60) ** -0.1332047592; g = 288.1221695283 * (t - 60) ** -0.0755148492; b = 255; }
  return rgbToHex([r, g, b].map((v) => Math.min(255, Math.max(0, v)) / 255) as RGB);
}
/** The colour temperature nearest a light colour (by its blue/red balance), to the nearest 100 K. */
export function hexToKelvin(hex: string): number {
  const [r, , b] = hexToRgb(hex);
  const want = b / Math.max(1e-3, r);
  let best = 6500, bd = Infinity;
  for (let k = 1500; k <= 12000; k += 100) {
    const [kr, , kb] = hexToRgb(kelvinToHex(k));
    const d = Math.abs(kb / Math.max(1e-3, kr) - want);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

// ── fog density ────────────────────────────────────────────────────────────────────────────────────
// The record has fog begin/end distances; a density reads better on a slider: 0 % = 3 km of clear air,
// 100 % = 120 m. Changing it keeps the begin/end ratio.
const FOG_FAR = 3000, FOG_NEAR = 120;
export const fogDensity = (look: Look) => (look.fog.enabled === false ? 0 : +Math.min(1, Math.max(0, 1 - Math.sqrt(Math.max(0, look.fog.end - FOG_NEAR) / (FOG_FAR - FOG_NEAR)))).toFixed(3));
const fogEnd = (d: number) => Math.round(FOG_NEAR + (FOG_FAR - FOG_NEAR) * (1 - d) ** 2);

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number, unit: string) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(+v.toFixed(2))}${unit}`;
const lampEnergy = (look: Look) => look.materials?.lamp?.emissionEnergy ?? look.materials?.led?.emissionEnergy ?? 0;

export const LOOK_KNOBS: Knob[] = [
  { id: 'exposure', label: 'exposure', group: 'grade', min: -2, max: 2, step: 0.05, words: ['brighter', 'darker'],
    get: (l) => l.tonemap.exposure, set: (_l, v) => ({ tonemap: { exposure: +v.toFixed(2) } }), fmt: (v) => signed(v, ' EV') },
  { id: 'white-balance', label: 'white balance', group: 'grade', min: 3500, max: 9500, step: 50, words: ['cooler', 'warmer'],
    get: (l) => tempToKelvin(l.grade.temperature), set: (_l, v) => ({ grade: { temperature: kelvinToTemp(v) } }), fmt: (v) => `${Math.round(v)} K` },
  { id: 'contrast', label: 'contrast', group: 'grade', min: 0.5, max: 2, step: 0.01, words: ['more contrast', 'less contrast'],
    get: (l) => l.grade.contrast, set: (_l, v) => ({ grade: { contrast: +v.toFixed(3) } }), fmt: (v) => `×${+v.toFixed(2)}` },
  { id: 'saturation', label: 'saturation', group: 'grade', min: 0, max: 2, step: 0.01, words: ['more colour', 'less colour'],
    get: (l) => l.grade.saturation, set: (_l, v) => ({ grade: { saturation: +v.toFixed(3) } }), fmt: pct },
  { id: 'fog', label: 'fog density', group: 'fog', min: 0, max: 1, step: 0.01, words: ['thicker fog', 'thinner fog'],
    get: fogDensity,
    set: (l, v) => {
      if (v <= 0.001) return { fog: { enabled: false } };
      const end = fogEnd(v), ratio = l.fog.end > 0 ? Math.min(0.95, l.fog.begin / l.fog.end) : 0.2;
      return { fog: { enabled: true, end, begin: Math.round(end * ratio) } };
    },
    fmt: pct },
  { id: 'sun-elevation', label: 'sun height', group: 'sun', min: -10, max: 90, step: 1, words: ['sun higher', 'sun lower'],
    get: (l) => l.light.sun.elevation, set: (_l, v) => ({ light: { sun: { elevation: Math.round(v) } } }), fmt: (v) => `${Math.round(v)}°` },
  { id: 'sun-azimuth', label: 'sun direction', group: 'sun', min: 0, max: 359, step: 1, words: ['sun turned', 'sun turned'],
    get: (l) => ((l.light.sun.azimuth % 360) + 360) % 360, set: (_l, v) => ({ light: { sun: { azimuth: Math.round(v) } } }), fmt: (v) => `${Math.round(v)}° ${compass(v)}` },
  { id: 'sun-colour', label: 'sun colour', group: 'sun', min: 1800, max: 10000, step: 100, words: ['cooler sun', 'warmer sun'],
    get: (l) => hexToKelvin(l.light.sun.color), set: (_l, v) => ({ light: { sun: { color: kelvinToHex(v) } } }), fmt: (v) => `${Math.round(v)} K` },
  { id: 'sun-strength', label: 'sun strength', group: 'sun', min: 0, max: 4, step: 0.02, words: ['stronger sun', 'softer sun'],
    get: (l) => l.light.sun.energy, set: (_l, v) => ({ light: { sun: { energy: +v.toFixed(2) } } }), fmt: (v) => `${+v.toFixed(2)}` },
  { id: 'lamps', label: 'lamp strength', group: 'night', min: 0, max: 12, step: 0.1, words: ['lamps brighter', 'lamps dimmer'],
    applies: (l) => !!(l.materials?.lamp || l.materials?.led),
    get: lampEnergy,
    set: (l, v) => {
      const was = lampEnergy(l) || 1, out: Record<string, unknown> = {};
      for (const k of ['lamp', 'led'] as const) if (l.materials?.[k]) out[k] = { emissionEnergy: +((l.materials[k].emissionEnergy ?? was) * (v / was)).toFixed(2) };
      if (!Object.keys(out).length) out.lamp = { emission: '#ffa04a', emissionEnergy: +v.toFixed(2) };
      return { materials: out };
    },
    fmt: (v) => `${+v.toFixed(1)}` },
  { id: 'glow', label: 'glow', group: 'night', min: 0, max: 3, step: 0.02, words: ['more glow', 'less glow'],
    get: (l) => (l.bloom && l.bloom.enabled !== false ? l.bloom.intensity : 0),
    set: (l, v) => ({ bloom: l.bloom ? { enabled: v > 0, intensity: +v.toFixed(2) } : { enabled: v > 0, threshold: 1, softness: 2, intensity: +v.toFixed(2), levels: [0, 0.8, 1, 0.6, 0.3, 0, 0] } }),
    fmt: (v) => `${+v.toFixed(2)}` },
];

function compass(deg: number) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8]; }

export const knob = (id: string): Knob => {
  const k = LOOK_KNOBS.find((x) => x.id === id);
  if (!k) throw new Error(`no look knob "${id}" (have: ${LOOK_KNOBS.map((x) => x.id).join(', ')})`);
  return k;
};

/** The knobs that matter for this look (lamps and glow only where there are lamps or glow). */
export const knobsFor = (look: Look) => LOOK_KNOBS.filter((k) => !k.applies || k.applies(look) || k.get(look) > 0);

/** The look with one knob turned (what the view previews while you drag). */
export function turnKnob(look: Look, id: string, v: number): Look {
  const k = knob(id);
  return parseLook(mergeLook(look, k.set(look, Math.min(k.max, Math.max(k.min, v)))));
}

/** Releasing a knob: the look-set partial record and the step's word note ("warmer: white balance 6200 K → 5600 K"). */
export function knobStep(look: Look, id: string, to: number): { set: Record<string, unknown>; why: string; from: number; to: number } | null {
  const k = knob(id);
  const from = k.get(look);
  const v = +Math.min(k.max, Math.max(k.min, Math.round((to - k.min) / k.step) * k.step + k.min)).toFixed(4);   // on the slider's own steps
  if (k.fmt(from) === k.fmt(v)) return null;         // no visible change: no step
  const word = v > from ? k.words[0] : k.words[1];
  return { set: k.set(look, v), why: `${word}: ${k.label} ${k.fmt(from)} → ${k.fmt(v)}`, from, to: v };
}

// ── "show me three" for a look ─────────────────────────────────────────────────────────────────────
/** Three deliberately different grades of a look (a different idea each, not three nudges of one
 *  number), as show-three takes of look-set calls. */
export function lookTakes(look: Look) {
  const g = look.grade, e = look.tonemap.exposure;
  const clampN = (v: number, lo: number, hi: number) => +Math.min(hi, Math.max(lo, v)).toFixed(3);
  const take = (label: string, traits: string[], grade: Record<string, unknown>, exposure: number, extra: Record<string, unknown> = {}) =>
    ({ label, traits, calls: [{ tool: 'look-set', args: { look: look.name, set: { grade, tonemap: { exposure: clampN(exposure, -4, 4) }, ...extra } } }] });
  return [
    take('warm and soft', ['warm', 'soft', 'low-contrast'], { temperature: clampN(g.temperature + 0.28, -1, 1), contrast: clampN(g.contrast * 0.86, 0.5, 2), saturation: clampN(g.saturation * 0.92, 0, 2), highlights: { color: '#ffd9a8', amount: 0.16 } }, e + 0.15),
    take('cool and crisp', ['cool', 'crisp', 'high-contrast'], { temperature: clampN(g.temperature - 0.3, -1, 1), contrast: clampN(g.contrast * 1.2, 0.5, 2), saturation: clampN(g.saturation * 1.0, 0, 2), shadows: { color: '#3a5a80', amount: 0.14 } }, e - 0.05),
    take('rich and punchy', ['saturated', 'deep', 'punchy'], { temperature: clampN(g.temperature + 0.05, -1, 1), contrast: clampN(g.contrast * 1.1, 0.5, 2), saturation: clampN(g.saturation * 1.35, 0, 2), vibrance: clampN(g.vibrance + 0.2, -1, 1) }, e - 0.25),
  ];
}
