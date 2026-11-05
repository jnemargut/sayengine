// Effects as studio assets (Decisions 56–57): one effect description, compiled to Godot (GPU particles with
// a generated CPU fallback, shape effects as meshes with a scrolling-noise shader) and to three.js
// (three.quarks particles + the same shader; packages/game/src/effects.ts). Shape effects come first:
// twisting flame meshes, rings and arcs with scrolling noise suit low-poly and cost little to draw.
// Checks (D57): peak particles and overdraw against the game profile's budget, a fallback for every
// emitter, colours inside the palette, warm-up at load, and Godot-vs-web parity from the last review.
import { z } from 'zod';
import type { CheckResult } from './checks.ts';
import type { ToolDef, ToolCtx } from './tools.ts';

type V3 = [number, number, number];

export interface ParticleLayer {
  id: string; kind: 'particles';
  shape: { type: 'point' | 'sphere' | 'cone' | 'box' | 'disc'; radius?: number; angle?: number; size?: V3 };
  rate: number;                          // particles per second (0: bursts only)
  bursts?: Array<{ at: number; count: number }>;
  life: [number, number];                // seconds
  speed: [number, number];               // m/s along the direction (cone/point) or outward (sphere)
  size: [number, number];                // start size, m
  sizeEnd?: number;                      // size multiplier at the end of life (1 = unchanged)
  colour: [string, string];              // start → end; hex or a palette name
  alpha?: [number, number];              // start → end opacity
  direction?: V3; spread?: number;       // degrees around the direction
  gravity?: number;                      // m/s², positive pulls down
  drag?: number; turbulence?: number;    // 0..1-ish
  blend: 'add' | 'alpha';
  stretch?: number;                      // > 0: stretched along velocity (sparks, rain), length = speed × stretch
  offset?: V3;
}
export interface ShapeLayer {
  id: string; kind: 'shape';
  mesh: 'flame' | 'ring' | 'arc' | 'puff';
  size: V3;                              // width, height, depth (m)
  count?: number;                        // flames / puffs arranged in a cluster
  colour: [string, string];              // bottom/inner → top/outer
  alpha?: number;
  scroll?: number;                       // noise scroll speed (cycles/s)
  noise?: number;                        // how much the noise eats the shape (0..1)
  flicker?: number;                      // height flicker (0..1)
  blend: 'add' | 'alpha';
  offset?: V3;
}
export type EffectLayer = ParticleLayer | ShapeLayer;
export interface EffectTrigger { on: string; layer: string; character?: string; clip?: string; fraction?: number }
export interface EffectDef {
  id: string; name: string; preset?: string;
  at?: V3; object?: string;              // where it plays: a position, or on an object (its largest flat top)
  loop: boolean;
  layers: EffectLayer[];
  value?: { name: string; default: number };   // a 0..1 game value scales rates and shape heights (a fire's size)
  triggers?: EffectTrigger[];            // "Blacksmith:hammer-strike@impact" → burst a layer; or a game event "fed"
  palette?: Record<string, string>;
  warmup?: boolean;                      // played once at load so it never stutters on first play (default true)
  profile?: 'godot-desktop' | 'web' | 'web-mobile';
  review?: { parity?: { score: number; detail: string }; at?: string };
}

/** Per-effect budgets by game profile: peak live particles, and overdraw (screen covered in see-through
 *  layers, measured at the review camera, which frames the effect at about 60% of the screen). */
export const EFFECT_BUDGETS: Record<string, { particles: number; overdraw: number }> = {
  'godot-desktop': { particles: 2000, overdraw: 6 },
  web: { particles: 800, overdraw: 4 },
  'web-mobile': { particles: 250, overdraw: 3 },
};

export const DEFAULT_FIRE_PALETTE: Record<string, string> = {
  ember: '#ffcf6a', flame: '#ff8a2a', deep: '#d4421c', smoke: '#5f5852', haze: '#a39c95', ash: '#3b3632', spark: '#ffe2a0', rain: '#8fb0cc',
};

/** Named moments inside library actions, as a fraction of the action: impact = the first accelerating key. */
export const ACTION_EVENTS: Record<string, Record<string, number>> = {
  'hammer-strike': { impact: 0.6, windup: 0.38, end: 1 },
  'pick-up': { reach: 0.45, end: 1 },
  wave: { peak: 0.35, end: 1 },
};

const P = (o: Partial<ParticleLayer> & Pick<ParticleLayer, 'id' | 'colour' | 'life' | 'speed' | 'size' | 'rate'>): ParticleLayer => ({ kind: 'particles', shape: { type: 'point' }, blend: 'add', ...o });

export const EFFECT_PRESETS: Record<string, { label: string; make(): Omit<EffectDef, 'id' | 'name'> }> = {
  'forge-fire': {
    label: 'A cosy forge fire: three twisting flame shapes with scrolling noise, a few embers drifting up; its size follows a 0–1 value',
    make: () => ({
      loop: true, value: { name: 'fire', default: 0.8 },
      layers: [
        { id: 'flames', kind: 'shape', mesh: 'flame', size: [0.34, 0.5, 0.34], count: 3, colour: ['deep', 'ember'], alpha: 0.95, scroll: 1.4, noise: 0.55, flicker: 0.25, blend: 'add' },
        P({ id: 'embers', shape: { type: 'disc', radius: 0.14 }, rate: 7, life: [1.2, 2.2], speed: [0.35, 0.7], size: [0.018, 0.03], sizeEnd: 0.3, colour: ['spark', 'deep'], alpha: [1, 0], direction: [0, 1, 0], spread: 18, gravity: -0.15, turbulence: 0.5, offset: [0, 0.12, 0] }),
      ],
    }),
  },
  sparks: {
    label: 'Spark burst off an anvil strike: 60 fast stretched sparks with gravity, triggered by an event',
    make: () => ({
      loop: false,
      layers: [P({ id: 'burst', shape: { type: 'cone', radius: 0.02, angle: 70 }, rate: 0, bursts: [{ at: 0, count: 60 }], life: [0.3, 0.7], speed: [1.6, 3.4], size: [0.03, 0.042], sizeEnd: 0.5, colour: ['spark', 'flame'], alpha: [1, 0], direction: [0, 1, 0], spread: 70, gravity: 6, drag: 0.4, stretch: 0.05 })],
    }),
  },
  'chimney-smoke': {
    label: 'Slow grey smoke puffs rising and spreading from a chimney',
    make: () => ({
      loop: true,
      layers: [P({ id: 'puffs', shape: { type: 'disc', radius: 0.08 }, rate: 3, life: [3, 4.5], speed: [0.3, 0.45], size: [0.22, 0.3], sizeEnd: 3.2, colour: ['smoke', 'haze'], alpha: [0.8, 0], direction: [0, 1, 0], spread: 12, gravity: -0.05, turbulence: 0.35, blend: 'alpha' })],
    }),
  },
  embers: {
    label: 'A puff of embers when charcoal is tipped in: a short upward burst that drifts and fades',
    make: () => ({
      loop: false,
      layers: [P({ id: 'puff', shape: { type: 'disc', radius: 0.12 }, rate: 0, bursts: [{ at: 0, count: 30 }], life: [0.8, 1.5], speed: [0.6, 1.2], size: [0.04, 0.06], sizeEnd: 0.4, colour: ['ember', 'deep'], alpha: [1, 0], direction: [0, 1, 0], spread: 35, gravity: 0.6, turbulence: 0.6 })],
    }),
  },
  rain: {
    label: 'Light rain over a 6 m square: thin stretched drops falling fast',
    make: () => ({
      loop: true,
      layers: [P({ id: 'drops', shape: { type: 'box', size: [6, 0.1, 6] }, rate: 260, life: [0.7, 0.9], speed: [6, 7], size: [0.018, 0.024], colour: ['rain', 'rain'], alpha: [0.85, 0.6], direction: [0, -1, 0], spread: 3, gravity: 0, stretch: 0.05, blend: 'alpha', offset: [0, 4.5, 0] })],
    }),
  },
};

// ── colour ─────────────────────────────────────────────────────────────────────────────────────────
export function resolveColour(c: string, palette: Record<string, string> = {}): string {
  if (c.startsWith('#')) return c;
  return palette[c] ?? DEFAULT_FIRE_PALETTE[c] ?? (() => { throw new Error(`unknown colour "${c}" (hex, or a palette name: ${Object.keys({ ...DEFAULT_FIRE_PALETTE, ...palette }).join(', ')})`); })();
}
const hex = (h: string): [number, number, number] => { const n = parseInt(h.slice(1).padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
function lab(h: string): [number, number, number] {
  const lin = hex(h).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const X = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / 0.95047, Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2], Z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export const deltaE = (a: string, b: string) => { const x = lab(a), y = lab(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

// ── measures ───────────────────────────────────────────────────────────────────────────────────────
const avg = (r: [number, number]) => (r[0] + r[1]) / 2;
/** Peak live particles: steady state of rate × the longest life, plus bursts that overlap it. */
export function peakParticles(def: EffectDef): number {
  const v = def.value ? 1 : 1;
  let n = 0;
  for (const l of def.layers) if (l.kind === 'particles') n += l.rate * v * l.life[1] + (l.bursts ?? []).reduce((s, b) => s + b.count, 0);
  return Math.round(n);
}
/** Rough extent of the effect (m): where particles and shapes reach. */
export function effectExtent(def: EffectDef): { w: number; h: number } {
  let w = 0.3, h = 0.3;
  for (const l of def.layers) {
    if (l.kind === 'shape') { w = Math.max(w, l.size[0] * (l.count && l.count > 1 ? 1.6 : 1)); h = Math.max(h, l.size[1] * (1 + (l.flicker ?? 0))); continue; }
    const travel = l.speed[1] * l.life[1] - (l.gravity ?? 0) * l.life[1] ** 2 / 2;
    const base = l.shape.size ? Math.max(l.shape.size[0], l.shape.size[2]) : 2 * (l.shape.radius ?? 0.05);
    const sideways = Math.abs(travel) * Math.sin((Math.min(80, l.spread ?? 0) * Math.PI) / 180);
    w = Math.max(w, base + 2 * sideways);
    h = Math.max(h, Math.abs(travel) + Math.abs(l.offset?.[1] ?? 0) * (l.direction?.[1] === -1 ? 1 : 0));
  }
  return { w, h };
}
/** The review camera for an effect (both engines use it): what it looks at, how much it shows (half the
 *  view height at the effect, m) so the effect fills ~60% of the screen, and where it looks from. */
export function effectFrame(def: EffectDef, at: V3, dir: V3 = [0.35, 0.3, 1]): { center: V3; radius: number; dir: V3 } {
  let lo = Infinity, hi = -Infinity, w = 0.3;
  for (const l of def.layers) {
    const oy = l.offset?.[1] ?? 0;
    if (l.kind === 'shape') { lo = Math.min(lo, oy); hi = Math.max(hi, oy + l.size[1] * (1 + (l.flicker ?? 0) / 2)); w = Math.max(w, l.size[0] * ((l.count ?? 1) > 1 ? 1.6 : 1)); continue; }
    const t = l.life[1] * 0.8, dy = (l.direction?.[1] ?? 1) * avg(l.speed) * t - ((l.gravity ?? 0) * t * t) / 2;
    lo = Math.min(lo, oy, oy + dy); hi = Math.max(hi, oy, oy + dy);
    const base = l.shape.size ? Math.max(l.shape.size[0], l.shape.size[2]) : 2 * (l.shape.radius ?? 0.05);
    w = Math.max(w, base + 2 * avg(l.speed) * t * Math.sin((Math.min(80, l.spread ?? 0) * Math.PI) / 180));
  }
  if (!Number.isFinite(lo)) { lo = 0; hi = 0.5; }
  const h = Math.max(0.3, hi - lo);
  return { center: [at[0], at[1] + (lo + hi) / 2, at[2]], radius: +Math.max(h / 1.2, w / 1.92, 0.3).toFixed(3), dir };
}

/** Overdraw: see-through area drawn per frame ÷ screen area, at a review camera that frames the effect at
 *  ~60% of a 16:10 screen. The cost on phones and the web is coverage, not particle count (D57 research). */
export function overdraw(def: EffectDef): { screens: number; perLayer: Record<string, number> } {
  const { w, h } = effectExtent(def);
  const screenW = Math.max(w / 0.6, (h / 0.6) * 1.6), screenH = screenW / 1.6;   // metres visible at the effect
  const screen = screenW * screenH;
  const perLayer: Record<string, number> = {};
  let total = 0;
  for (const l of def.layers) {
    let a: number;
    if (l.kind === 'shape') a = (l.count ?? 1) * l.size[0] * l.size[1] * 0.75 * 1.5;  // two crossed cards per flame, ~75% filled
    else {
      const alive = l.rate * avg(l.life) + (l.bursts ?? []).reduce((s, b) => s + b.count, 0) * 0.5;
      const s = avg(l.size) * (1 + (l.sizeEnd ?? 1)) / 2;
      const len = l.stretch ? Math.max(s, avg(l.speed) * l.stretch) : s;
      a = alive * s * len;
    }
    perLayer[l.id] = +(a / screen).toFixed(3);
    total += a / screen;
  }
  return { screens: +total.toFixed(2), perLayer };
}

/** What the CPU fallback (Godot CPUParticles3D, frozen since 4.2) can't do for each layer. */
export function fallbackGaps(def: EffectDef): string[] {
  const gaps: string[] = [];
  for (const l of def.layers) if (l.kind === 'particles' && (l.turbulence ?? 0) > 0) gaps.push(`${l.id}: turbulence (the fallback drifts without noise)`);
  return gaps;
}

export function effectChecks(def: EffectDef, palette?: Record<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  const prof = def.profile ?? 'web';
  const b = EFFECT_BUDGETS[prof];
  const peak = peakParticles(def);
  out.push({ id: 'fx-particles', label: 'Peak particles', pass: peak <= b.particles, detail: `${peak} alive at peak, budget ${b.particles} (${prof})` });
  const od = overdraw(def);
  out.push({ id: 'fx-overdraw', label: 'Screen covered in see-through layers', pass: od.screens <= b.overdraw, detail: `${od.screens}× the screen at the review camera, budget ${b.overdraw}× (${prof}); ${Object.entries(od.perLayer).map(([k, v]) => `${k} ${v}×`).join(', ')}` });
  const gaps = fallbackGaps(def);
  out.push({ id: 'fx-fallback', label: 'Low-end fallback exists', pass: true, detail: `every particle layer has a CPU twin${gaps.length ? `; it loses ${gaps.join('; ')}` : ''}; shape layers are plain meshes` });
  const pal = { ...DEFAULT_FIRE_PALETTE, ...(palette ?? {}), ...(def.palette ?? {}) };
  const userPal = { ...(palette ?? {}), ...(def.palette ?? {}) };
  const colours = def.layers.flatMap((l) => l.colour);
  const bad: string[] = [];
  for (const c of colours) {
    try {
      const h = resolveColour(c, pal);
      if (Object.keys(userPal).length && c.startsWith('#')) {
        const near = Math.min(...Object.values(userPal).map((p) => deltaE(h, p)));
        if (near > 18) bad.push(`${c} (ΔE ${near.toFixed(0)} from the nearest palette colour)`);
      }
    } catch (e: any) { bad.push(e.message); }
  }
  out.push({ id: 'fx-palette', label: 'Colours inside the palette', pass: !bad.length, detail: bad.length ? bad.join('; ') : Object.keys(userPal).length ? 'every colour is a palette colour or within ΔE 18 of one' : 'named colours from the effect palette (no look palette set)' });
  out.push({ id: 'fx-warmup', label: 'No first-play stutter', pass: def.warmup !== false, detail: def.warmup !== false ? 'played once at load (shaders compile before play)' : 'warm-up is off: on the web it stutters the first time it plays' });
  for (const t of def.triggers ?? []) {
    const ok = def.layers.some((l) => l.id === t.layer);
    if (!ok) out.push({ id: `fx-trigger-${t.on}`, label: `Trigger ${t.on}`, pass: false, detail: `no layer "${t.layer}" (layers: ${def.layers.map((l) => l.id).join(', ')})` });
  }
  const par = def.review?.parity;
  out.push(par ? { id: 'fx-parity', label: 'Godot and web match', pass: par.score <= 0.25, detail: par.detail } : { id: 'fx-parity', label: 'Godot and web match', pass: false, pending: true, detail: 'not reviewed yet: studio effect-preview renders both engines side by side' });
  return out;
}

// ── shader (the same noise in Godot and three.js, so shape effects match) ──────────────────────────
export const NOISE_GLSL = `
float fxHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxNoise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fxFbm(vec2 p) { return 0.55 * fxNoise(p) + 0.3 * fxNoise(p * 2.1) + 0.15 * fxNoise(p * 4.3); }`;

/** Godot shader for shape layers: a card whose alpha is a teardrop eaten by scrolling noise. */
export function godotShapeShader(): string {
  return `// generated by the studio (effects): shape layers — scrolling noise on a flame / puff card
shader_type spatial;
render_mode unshaded, cull_disabled, depth_draw_never, blend_add;
uniform vec4 col_a : source_color = vec4(1.0, 0.4, 0.1, 1.0);
uniform vec4 col_b : source_color = vec4(1.0, 0.85, 0.4, 1.0);
uniform float scroll = 1.4;
uniform float noise_amt = 0.55;
uniform float flicker = 0.25;
uniform float alpha_mul = 1.0;
uniform float seed = 0.0;
uniform float value = 1.0;
uniform int form = 0; // 0 flame, 1 ring, 2 arc, 3 puff
${NOISE_GLSL}
void vertex() {
  float h = 1.0 + flicker * (fxNoise(vec2(TIME * 3.0 + seed, seed)) - 0.5);
  VERTEX.y *= h * mix(0.35, 1.0, value);
}
void fragment() {
  vec2 uv = UV; float y = 1.0 - uv.y; float x = abs(uv.x - 0.5) * 2.0;
  float body;
  if (form == 1) { float r = length(uv - 0.5) * 2.0; body = smoothstep(0.55, 0.75, r) * (1.0 - smoothstep(0.85, 1.0, r)); }
  else if (form == 3) { body = 1.0 - smoothstep(0.4, 1.0, length(uv - 0.5) * 2.0); }
  else { float width = (1.0 - y) * 0.9 + 0.1; body = 1.0 - smoothstep(width * 0.55, width, x); body *= smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.7, 1.0, y)); }
  float n = fxFbm(vec2(uv.x * 3.0 + seed, y * 2.5 - TIME * scroll));
  float a = clamp(body - noise_amt * (1.0 - n) * (0.3 + y), 0.0, 1.0) * alpha_mul;
  ALBEDO = mix(col_a.rgb, col_b.rgb, clamp(y * 1.3 + n * 0.3, 0.0, 1.0));
  ALPHA = a * smoothstep(0.0, 0.12, value);
}
`;
}

/** The same shape shader for three.js (ShaderMaterial): identical noise, body and colour ramp. */
export function webShapeShader(): { vertex: string; fragment: string } {
  return {
    vertex: `uniform float time; uniform float flicker; uniform float seed; uniform float value; varying vec2 vUv;
${NOISE_GLSL}
void main() { vUv = uv; vec3 p = position; float h = 1.0 + flicker * (fxNoise(vec2(time * 3.0 + seed, seed)) - 0.5); p.y *= h * mix(0.35, 1.0, value);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragment: `uniform vec3 col_a; uniform vec3 col_b; uniform float time; uniform float scroll; uniform float noise_amt; uniform float alpha_mul; uniform float seed; uniform float value; uniform int form; varying vec2 vUv;
${NOISE_GLSL}
void main() { vec2 uv = vec2(vUv.x, 1.0 - vUv.y); float y = 1.0 - uv.y; float x = abs(uv.x - 0.5) * 2.0; float body;
  if (form == 1) { float r = length(uv - 0.5) * 2.0; body = smoothstep(0.55, 0.75, r) * (1.0 - smoothstep(0.85, 1.0, r)); }
  else if (form == 3) { body = 1.0 - smoothstep(0.4, 1.0, length(uv - 0.5) * 2.0); }
  else { float width = (1.0 - y) * 0.9 + 0.1; body = 1.0 - smoothstep(width * 0.55, width, x); body *= smoothstep(0.0, 0.08, y) * (1.0 - smoothstep(0.7, 1.0, y)); }
  float n = fxFbm(vec2(uv.x * 3.0 + seed, y * 2.5 - time * scroll));
  float a = clamp(body - noise_amt * (1.0 - n) * (0.3 + y), 0.0, 1.0) * alpha_mul * smoothstep(0.0, 0.12, value);
  gl_FragColor = vec4(mix(col_a, col_b, clamp(y * 1.3 + n * 0.3, 0.0, 1.0)), a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  };
}

// ── Godot scene (.tscn): GPU particles + a hidden CPU twin per layer, shape layers as crossed cards ───
const gv = (v: V3) => `Vector3(${v.map((n) => +n.toFixed(4)).join(', ')})`;
const gc = (h: string, a = 1) => { const c = hex(h); return `Color(${c.map((n) => +n.toFixed(4)).join(', ')}, ${+a.toFixed(3)})`; };

/** Godot's turbulence turns a particle's velocity toward a noise direction by `influence` every process
 *  step (GPU particles step at 30 fps), keeping its speed; three.quarks' Noise (the web) wobbles the
 *  position around its path by at most `turbulence × 0.6` m. At the old influence (0.04–0.06 × turbulence)
 *  a 4 s smoke puff had its direction scrambled within about a second and stopped rising, so the
 *  Godot column stood a third as tall as the web's. Here the influence is sized so that over a whole
 *  life the drift off course is about the web's wobble: the share of velocity turned ≈ wobble ÷ travel
 *  (at most 35 %), spread over the life's steps. */
export function turbulenceInfluence(l: ParticleLayer): number {
  const life = avg(l.life), travel = Math.max(0.05, avg(l.speed) * life);
  const share = Math.min(0.35, ((l.turbulence ?? 0) * 0.6) / travel);
  return share / Math.max(1, life * 30);
}

/** The effect as a Godot scene. Root carries metadata the runtime (studio/effects.gd) reads: the value it
 *  follows, triggers, warm-up. */
export function godotEffectScene(def: EffectDef, palette?: Record<string, string>, shaderPath = 'res://assets/studio/effects/shape.gdshader'): string {
  const pal = { ...DEFAULT_FIRE_PALETTE, ...(palette ?? {}), ...(def.palette ?? {}) };
  const sub: string[] = [], nodes: string[] = [];
  let sid = 0;
  const add = (type: string, body: string) => { const id = `${type}_${++sid}`; sub.push(`[sub_resource type="${type}" id="${id}"]\n${body}`); return id; };
  const ext = `[ext_resource type="Shader" path="${shaderPath}" id="shader"]`;
  nodes.push(`[node name="${safe(def.name)}" type="Node3D"]\nmetadata/studio_effect = "${def.id}"\nmetadata/loop = ${def.loop}\nmetadata/value = ${def.value ? `"${def.value.name}"` : '""'}\nmetadata/value_default = ${def.value?.default ?? 1}\nmetadata/warmup = ${def.warmup !== false}\nmetadata/triggers = ${JSON.stringify(JSON.stringify(def.triggers ?? []))}`);
  for (const l of def.layers) {
    const off = l.offset ?? [0, 0, 0];
    if (l.kind === 'shape') {
      const form = { flame: 0, ring: 1, arc: 2, puff: 3 }[l.mesh];
      const n = l.count ?? 1;
      for (let i = 0; i < n; i++) {
        const mat = add('ShaderMaterial', `render_priority = 0\nshader = ExtResource("shader")\nshader_parameter/col_a = ${gc(resolveColour(l.colour[0], pal))}\nshader_parameter/col_b = ${gc(resolveColour(l.colour[1], pal))}\nshader_parameter/scroll = ${l.scroll ?? 1}\nshader_parameter/noise_amt = ${l.noise ?? 0.5}\nshader_parameter/flicker = ${l.flicker ?? 0}\nshader_parameter/alpha_mul = ${l.alpha ?? 1}\nshader_parameter/seed = ${(i * 3.17).toFixed(2)}\nshader_parameter/form = ${form}`);
        const quad = add('QuadMesh', `material = SubResource("${mat}")\nsize = Vector2(${l.size[0]}, ${l.size[1]})\ncenter_offset = Vector3(0, ${l.size[1] / 2}, 0)`);
        const ang = n > 1 ? (i / n) * Math.PI * 2 : 0, r = n > 1 ? l.size[0] * 0.3 : 0;
        const pos: V3 = [off[0] + Math.sin(ang) * r, off[1], off[2] + Math.cos(ang) * r];
        for (const [k, rot] of [[0, 0], [1, Math.PI / 2]] as const) {
          const c = Math.cos(rot + ang), s = Math.sin(rot + ang);
          nodes.push(`[node name="${l.id}_${i}_${k}" type="MeshInstance3D" parent="."]\ntransform = Transform3D(${c}, 0, ${-s}, 0, 1, 0, ${s}, 0, ${c}, ${pos.join(', ')})\nmesh = SubResource("${quad}")\ncast_shadow = 0\nmetadata/layer = "${l.id}"\nmetadata/shape = true`);
        }
      }
      continue;
    }
    const c0 = resolveColour(l.colour[0], pal), c1 = resolveColour(l.colour[1], pal);
    const a = l.alpha ?? [1, 1];
    const grad = add('Gradient', `colors = PackedColorArray(${[...hex(c0), a[0], ...hex(c1), a[1]].map((n) => +n.toFixed(4)).join(', ')})`);
    const gradTex = add('GradientTexture1D', `gradient = SubResource("${grad}")`);
    const curveBody = `max_value = ${Math.max(1, l.sizeEnd ?? 1)}\n_data = [Vector2(0, 1), 0.0, 0.0, 0, 0, Vector2(1, ${l.sizeEnd ?? 1}), 0.0, 0.0, 0, 0]\npoint_count = 2`;
    const curve = add('Curve', curveBody);
    const curveTex = add('CurveTexture', `curve = SubResource("${curve}")`);
    const dir = l.direction ?? [0, 1, 0];
    const shapeType = { point: 0, sphere: 1, cone: 0, box: 3, disc: 6 }[l.shape.type];
    const shapeProps = l.shape.type === 'sphere' ? `\nemission_sphere_radius = ${l.shape.radius ?? 0.1}` : l.shape.type === 'box' ? `\nemission_box_extents = ${gv((l.shape.size ?? [1, 1, 1]).map((v) => v / 2) as V3)}` : l.shape.type === 'disc' ? `\nemission_ring_axis = Vector3(0, 1, 0)\nemission_ring_height = 0.0\nemission_ring_radius = ${l.shape.radius ?? 0.1}\nemission_ring_inner_radius = 0.0` : '';
    const pm = add('ParticleProcessMaterial', `emission_shape = ${shapeType}${shapeProps}\ndirection = ${gv(dir)}\nspread = ${l.spread ?? 0}\ninitial_velocity_min = ${l.speed[0]}\ninitial_velocity_max = ${l.speed[1]}\nlifetime_randomness = ${+(1 - l.life[0] / l.life[1]).toFixed(3)}\ngravity = Vector3(0, ${-(l.gravity ?? 0)}, 0)\ndamping_min = ${(l.drag ?? 0) * 3}\ndamping_max = ${(l.drag ?? 0) * 3}\nscale_min = 1.0\nscale_max = ${+(l.size[1] / l.size[0]).toFixed(3)}\nscale_curve = SubResource("${curveTex}")\ncolor_ramp = SubResource("${gradTex}")${(l.turbulence ?? 0) > 0 ? `\nturbulence_enabled = true\nturbulence_noise_strength = 1.0\nturbulence_noise_scale = 4.0\nturbulence_influence_min = ${(turbulenceInfluence(l) * 0.8).toFixed(4)}\nturbulence_influence_max = ${(turbulenceInfluence(l) * 1.2).toFixed(4)}` : ''}${l.stretch ? '\nparticle_flag_align_y = true' : ''}`);
    const dotGrad = add('Gradient', `colors = PackedColorArray(1, 1, 1, 1, 1, 1, 1, 0)`);
    const dot = add('GradientTexture2D', `gradient = SubResource("${dotGrad}")\nwidth = 32\nheight = 32\nfill = 1\nfill_from = Vector2(0.5, 0.5)\nfill_to = Vector2(1, 0.5)`);
    const mat = add('StandardMaterial3D', `transparency = 1\nalbedo_texture = SubResource("${dot}")\nblend_mode = ${l.blend === 'add' ? 1 : 0}\nshading_mode = 0\nvertex_color_use_as_albedo = true\nvertex_color_is_srgb = true\nbillboard_mode = ${l.stretch ? 2 : 3}\nbillboard_keep_scale = true\nparticles_anim_h_frames = 1\nparticles_anim_v_frames = 1`);
    const len = l.stretch ? Math.max(l.size[0], avg(l.speed) * l.stretch) : l.size[0];
    const quad = add('QuadMesh', `material = SubResource("${mat}")\nsize = Vector2(${l.size[0]}, ${+len.toFixed(4)})`);
    const amount = Math.max(1, Math.ceil(l.rate * l.life[1] + (l.bursts ?? []).reduce((s, b) => s + b.count, 0)));
    const oneShot = l.rate === 0;
    nodes.push(`[node name="${l.id}" type="GPUParticles3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${off.join(', ')})\namount = ${amount}\nlifetime = ${l.life[1]}\none_shot = ${oneShot}\nemitting = ${!oneShot}\nexplosiveness = ${oneShot ? 1 : 0}\nrandomness = ${+(1 - l.life[0] / l.life[1]).toFixed(3)}\nprocess_material = SubResource("${pm}")\ndraw_pass_1 = SubResource("${quad}")\ncast_shadow = 0\nmetadata/layer = "${l.id}"\nmetadata/rate = ${l.rate}`);
    // the CPU twin: the same emitter for renderers without GPU particles; studio/effects.gd swaps it in
    const cpuCurve = add('Curve', curveBody);
    nodes.push(`[node name="${l.id}_cpu" type="CPUParticles3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${off.join(', ')})\nvisible = false\nemitting = false\namount = ${amount}\nlifetime = ${l.life[1]}\none_shot = ${oneShot}\nexplosiveness = ${oneShot ? 1 : 0}\nmesh = SubResource("${quad}")\nemission_shape = ${l.shape.type === 'box' ? 3 : l.shape.type === 'sphere' ? 1 : 0}${l.shape.type === 'box' ? `\nemission_box_extents = ${gv((l.shape.size ?? [1, 1, 1]).map((v) => v / 2) as V3)}` : l.shape.type === 'sphere' ? `\nemission_sphere_radius = ${l.shape.radius ?? 0.1}` : ''}\ndirection = ${gv(dir)}\nspread = ${l.spread ?? 0}\ninitial_velocity_min = ${l.speed[0]}\ninitial_velocity_max = ${l.speed[1]}\ngravity = Vector3(0, ${-(l.gravity ?? 0)}, 0)\nscale_amount_min = 1.0\nscale_amount_max = ${+(l.size[1] / l.size[0]).toFixed(3)}\nscale_amount_curve = SubResource("${cpuCurve}")\ncolor_ramp = SubResource("${grad}")\nmetadata/layer = "${l.id}"\nmetadata/fallback = true`);
  }
  return `[gd_scene load_steps=${sub.length + 2} format=3]\n\n${ext}\n\n${sub.join('\n\n')}\n\n${nodes.join('\n\n')}\n`;
}
const safe = (s: string) => s.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Effect';

/** Resolve a trigger spec: "Blacksmith:hammer-strike@impact" → a clip and the fraction where it fires;
 *  anything else is a game event the code raises (effects.event("fed")). */
export function parseTrigger(on: string, layer: string, actionOf?: (character: string, clip: string) => string | undefined): EffectTrigger {
  const m = /^([^:@]+):([^@]+)@([\w.]+)$/.exec(on.trim());
  if (!m) return { on, layer };
  const [, character, clip, moment] = m;
  const action = actionOf?.(character, clip) ?? clip.replace(/^.*:/, '');
  const frac = /^[\d.]+$/.test(moment) ? Number(moment) : ACTION_EVENTS[action]?.[moment];
  if (frac === undefined || !(frac >= 0 && frac <= 1)) throw new Error(`no moment "${moment}" in ${action} (known: ${Object.entries(ACTION_EVENTS).map(([k, v]) => `${k}@${Object.keys(v).join('|')}`).join(', ')}; or a fraction 0..1)`);
  return { on, layer, character, clip, fraction: frac };
}

// ── tools ──────────────────────────────────────────────────────────────────────────────────────────
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const V = z.tuple([z.number(), z.number(), z.number()]);
const getFx = (ctx: ToolCtx, id: string): EffectDef => {
  const fx = (ctx.doc as any).effects?.[id];
  if (!fx) throw new Error(`no effect "${id}" (effects: ${Object.keys((ctx.doc as any).effects ?? {}).join(', ') || 'none'}; studio add-effect)`);
  return fx;
};
/** A character's motion id → the library action it plays ("strike" → "hammer-strike"). */
const actionOf = (ctx: ToolCtx) => (character: string, clip: string): string | undefined => {
  const o = Object.values(ctx.doc.objects).find((x) => x.name.toLowerCase() === character.toLowerCase() || x.id === character);
  if (!o?.character) throw new Error(`no character "${character}"`);
  const m: any = o.character.motions?.[clip];
  if (!m) throw new Error(`${o.name} has no motion "${clip}" (have: ${Object.keys(o.character.motions ?? {}).join(', ')})`);
  return m.action ?? clip;
};
const objByName = (ctx: ToolCtx, name: string) => {
  const o = Object.values(ctx.doc.objects).find((x) => x.id === name || x.name.toLowerCase() === name.toLowerCase());
  if (!o) throw new Error(`no object "${name}"`);
  return o;
};
export function describeFx(fx: EffectDef): string {
  const parts = fx.layers.map((l) => (l.kind === 'shape' ? `${l.count ?? 1} ${l.mesh}${(l.count ?? 1) > 1 ? 's' : ''}` : `${l.id} (${l.rate ? `${l.rate}/s` : `burst ${(l.bursts ?? []).reduce((s, b) => s + b.count, 0)}`})`));
  return `${fx.name}: ${parts.join(' + ')}${fx.value ? `, size follows "${fx.value.name}"` : ''}${fx.triggers?.length ? `, fires on ${fx.triggers.map((t) => t.on).join(', ')}` : ''}`;
}
const Profile = z.enum(['godot-desktop', 'web', 'web-mobile']);
const Trig = z.array(z.object({ on: z.string(), layer: z.string() }));

export const EFFECT_TOOLS: ToolDef[] = [
  {
    name: 'add-effect', mode: 'create', mutates: true,
    description: `Add an effect (Decisions 56–57): particles and shape effects (twisting flame meshes, rings, puffs with scrolling noise) compiled to Godot (GPU particles + a CPU fallback) and three.js (three.quarks). Presets: ${Object.entries(EFFECT_PRESETS).map(([k, v]) => `${k} — ${v.label}`).join('; ')}. --at [x,y,z] or --on <object> (sits on its largest flat top). --value <name> makes rates and flame height follow a 0–1 game value; --triggers [{on, layer}] fires a burst layer on a motion moment ("Blacksmith:hammer-strike@impact") or a game event ("fed"). --palette {name: hex} (the look palette when there is one).`,
    input: z.object({
      id: Id, preset: z.enum(Object.keys(EFFECT_PRESETS) as [string, ...string[]]).optional(), name: z.string().optional(),
      at: V.optional(), on: z.string().optional(),
      layers: z.array(z.any()).optional(), value: z.string().optional(), triggers: Trig.optional(),
      palette: z.record(z.string(), z.string()).optional(), profile: Profile.optional(), warmup: z.boolean().optional(),
    }),
    example: `studio add-effect --id forge-fire --preset forge-fire --on hearth --value fire`,
    run(ctx, a) {
      if ((ctx.doc as any).effects?.[a.id]) throw new Error(`effect "${a.id}" exists (studio set-effect changes it)`);
      if (!a.preset && !a.layers) throw new Error(`pass --preset (${Object.keys(EFFECT_PRESETS).join(', ')}) or --layers`);
      const base = a.preset ? EFFECT_PRESETS[a.preset].make() : { loop: true, layers: [] as EffectLayer[] };
      const fx: EffectDef = { id: a.id, name: a.name ?? a.id.replace(/-/g, ' ').replace(/^./, (c: string) => c.toUpperCase()), ...(a.preset ? { preset: a.preset } : {}), ...base };
      if (a.layers) fx.layers = a.layers as EffectLayer[];
      if (a.at) fx.at = a.at as V3;
      if (a.on) fx.object = objByName(ctx, a.on).id;
      if (a.value) fx.value = { name: a.value, default: fx.value?.default ?? 1 };
      if (a.triggers) fx.triggers = a.triggers.map((t: any) => parseTrigger(t.on, t.layer, actionOf(ctx)));
      if (a.palette) fx.palette = a.palette;
      if (a.profile) fx.profile = a.profile;
      if (a.warmup !== undefined) fx.warmup = a.warmup;
      for (const c of fx.layers.flatMap((l) => l.colour)) resolveColour(c, { ...(fx.palette ?? {}) });
      ctx.set(['effects'], { ...((ctx.doc as any).effects ?? {}), [a.id]: fx });
      ctx.summary(`New effect — ${describeFx(fx)}`);
      return { id: a.id, peak: peakParticles(fx), overdraw: overdraw(fx).screens, checks: effectChecks(fx) };
    },
  },
  {
    name: 'set-effect', mode: 'modify', mutates: true,
    description: 'Change an effect: --layer <id> --set {field: value} edits one layer (rate, life, speed, size, colour, spread, gravity, turbulence, scroll, noise, flicker…); --value, --valueDefault, --triggers, --at/--on, --palette, --profile, --warmup as in add-effect. Any change clears the last parity review.',
    input: z.object({
      id: z.string(), layer: z.string().optional(), set: z.record(z.string(), z.any()).optional(),
      at: V.optional(), on: z.string().optional(), value: z.string().optional(), valueDefault: z.number().min(0).max(1).optional(),
      triggers: Trig.optional(), palette: z.record(z.string(), z.string()).optional(), profile: Profile.optional(), warmup: z.boolean().optional(),
    }),
    run(ctx, a) {
      const fx: EffectDef = structuredClone(getFx(ctx, a.id));
      const changed: string[] = [];
      if (a.layer || a.set) {
        const l = fx.layers.find((x) => x.id === a.layer);
        if (!l) throw new Error(`no layer "${a.layer}" (layers: ${fx.layers.map((x) => x.id).join(', ')})`);
        Object.assign(l, a.set ?? {});
        changed.push(`${l.id} ${Object.keys(a.set ?? {}).join(', ')}`);
      }
      if (a.at) { fx.at = a.at as V3; delete fx.object; changed.push('position'); }
      if (a.on) { fx.object = objByName(ctx, a.on).id; delete fx.at; changed.push(`on ${a.on}`); }
      if (a.value) { fx.value = { name: a.value, default: fx.value?.default ?? 1 }; changed.push(`follows ${a.value}`); }
      if (a.valueDefault !== undefined && fx.value) { fx.value.default = a.valueDefault; changed.push(`default ${a.valueDefault}`); }
      if (a.triggers) { fx.triggers = a.triggers.map((t: any) => parseTrigger(t.on, t.layer, actionOf(ctx))); changed.push('triggers'); }
      if (a.palette) { fx.palette = a.palette; changed.push('palette'); }
      if (a.profile) { fx.profile = a.profile; changed.push(`profile ${a.profile}`); }
      if (a.warmup !== undefined) { fx.warmup = a.warmup; changed.push(`warm-up ${a.warmup ? 'on' : 'off'}`); }
      delete fx.review;
      ctx.set(['effects', fx.id], fx);
      ctx.summary(`${fx.name}: ${changed.join('; ') || 'no change'}`);
      return { id: fx.id, peak: peakParticles(fx), overdraw: overdraw(fx).screens, checks: effectChecks(fx) };
    },
  },
  {
    name: 'remove-effect', mode: 'modify', mutates: true,
    description: 'Remove an effect.',
    input: z.object({ id: z.string() }),
    run(ctx, a) {
      const fx = getFx(ctx, a.id);
      const rest = { ...((ctx.doc as any).effects ?? {}) }; delete rest[a.id];
      ctx.set(['effects'], rest);
      ctx.summary(`Removed effect ${fx.name}`);
      return { removed: a.id };
    },
  },
  {
    name: 'effect-review', mode: 'review', mutates: true,
    description: 'Store the Godot-vs-web parity of an effect (`studio game effect --against` measures it and calls this): score 0 = the same, ≤ 0.25 passes the fx-parity check.',
    input: z.object({ id: z.string(), score: z.number().min(0), detail: z.string() }),
    run(ctx, a) {
      const fx: EffectDef = structuredClone(getFx(ctx, a.id));
      fx.review = { parity: { score: a.score, detail: a.detail }, at: new Date().toISOString() };
      ctx.set(['effects', fx.id], fx);
      ctx.summary(`${fx.name}: Godot vs web ${a.score <= 0.25 ? 'match' : 'differ'} (${a.score})`);
      return { id: fx.id, parity: fx.review.parity };
    },
  },
  {
    name: 'effect-info', mode: 'inspect', mutates: false,
    description: 'Describe an effect (or list effects and presets): layers, the value it follows, triggers, peak particles, overdraw by layer, what the CPU fallback loses, and checks.',
    input: z.object({ id: z.string().optional() }),
    run(ctx, a) {
      const all = Object.values((ctx.doc as any).effects ?? {}) as EffectDef[];
      if (!a.id) return { effects: all.map((fx) => ({ id: fx.id, describe: describeFx(fx) })), presets: Object.fromEntries(Object.entries(EFFECT_PRESETS).map(([k, v]) => [k, v.label])) };
      const fx = getFx(ctx, a.id);
      return { ...fx, describe: describeFx(fx), peak: peakParticles(fx), overdraw: overdraw(fx), fallbackLoses: fallbackGaps(fx), checks: effectChecks(fx) };
    },
  },
];
