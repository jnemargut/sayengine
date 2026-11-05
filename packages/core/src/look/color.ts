// Colour maths shared by the look module: sRGB transfer, the pinned tone curves, Oklab/CIELAB,
// hex parsing. Pure functions, no engine, so the LUT, the bake fallback and the gates agree exactly.
export type RGB = [number, number, number];

export const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (v: number) => { v = Math.min(1, Math.max(0, v)); return v < 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; };
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`"${hex}" is not a colour like #a85b45`);
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
}
export const hexToLinear = (hex: string): RGB => hexToRgb(hex).map(srgbToLinear) as RGB;
export const linearToHex = (c: RGB): string => rgbToHex(c.map(linearToSrgb) as RGB);
export const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ── tone curves (scene-linear in → display-linear 0..1 out) ───────────────
// The engines never pick their own: both output the "transport" Reinhard x/(1+x), and the look's LUT
// undoes it and applies the curve below. So the curve is pinned by construction, identical in Godot
// and three.js, and changing it is a data change.
export const TONE_CURVES = ['neutral', 'aces', 'filmic', 'reinhard', 'linear'] as const;
export type ToneCurve = typeof TONE_CURVES[number];

/** Khronos PBR Neutral: keeps base colours faithful (a toy look's friend). */
function neutral(c: RGB): RGB {
  const start = 0.8 - 0.04, desat = 0.15;
  const x = Math.min(c[0], c[1], c[2]);
  const off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  let r: RGB = [c[0] - off, c[1] - off, c[2] - off];
  const peak = Math.max(r[0], r[1], r[2]);
  if (peak < start) return r;
  const d = 1 - start, np = 1 - (d * d) / (peak + d - start);
  r = r.map((v) => (v * np) / peak) as RGB;
  const g = 1 - 1 / (desat * (peak - np) + 1);
  return r.map((v) => v + (np - v) * g) as RGB;
}
const aces1 = (x: number) => (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
const hable = (x: number) => { const A = 0.15, B = 0.5, C = 0.1, D = 0.2, E = 0.02, F = 0.3; return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F; };

export function toneCurve(curve: ToneCurve, c: RGB): RGB {
  switch (curve) {
    case 'neutral': return neutral(c).map(clamp01) as RGB;
    case 'aces': return c.map((v) => clamp01(aces1(v))) as RGB;
    case 'filmic': { const w = hable(11.2); return c.map((v) => clamp01(hable(v * 2) / w)) as RGB; }
    case 'reinhard': return c.map((v) => v / (1 + v)) as RGB;
    case 'linear': return c.map(clamp01) as RGB;
  }
}

/** The transport curve both engines run: x/(1+x), then sRGB. Its inverse feeds the LUT. */
export const transport = (x: number) => linearToSrgb(Math.max(0, x) / (1 + Math.max(0, x)));
export const untransport = (s: number) => { const v = Math.min(srgbToLinear(clamp01(s)), 0.9995); return v / (1 - v); };

// ── perceptual spaces ─────────────────────────────────────────────────────
export function linearToOklab(c: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToLinear(L: RGB): RGB {
  const l = (L[0] + 0.3963377774 * L[1] + 0.2158037573 * L[2]) ** 3;
  const m = (L[0] - 0.1055613458 * L[1] - 0.0638541728 * L[2]) ** 3;
  const s = (L[0] - 0.0894841775 * L[1] - 1.291485548 * L[2]) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** sRGB (0..1) → CIELAB (D65), for palette distances (ΔE76). */
export function srgbToLab(c: RGB): RGB {
  const [r, g, b] = c.map(srgbToLinear);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const deltaE = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
