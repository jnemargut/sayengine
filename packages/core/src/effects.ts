// Effects as studio assets (Decisions 56–57): one effect description, compiled to Godot (GPU particles with
// a generated CPU fallback, shape effects as meshes with a scrolling-noise shader) and to three.js
// (three.quarks particles + the same shader; packages/game/src/effects.ts). Shape effects come first:
// twisting flame meshes, rings and arcs with scrolling noise suit low-poly and cost little to draw.
// Checks (D57): peak particles and overdraw against the game profile's budget, a fallback for every
// emitter, colours inside the palette, warm-up at load, and Godot-vs-web parity from the last review.
import type { CheckResult } from './checks.ts';

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
  ember: '#ffcf6a', flame: '#ff8a2a', deep: '#d4421c', smoke: '#7d746b', ash: '#3b3632', spark: '#ffe2a0', rain: '#a9c3d8',
};

/** Named moments inside library actions, as a fraction of the action: impact = the first accelerating key. */
export const ACTION_EVENTS: Record<string, Record<string, number>> = {
  'hammer-strike': { impact: 0.54, windup: 0.38, end: 1 },
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
    label: 'Spark burst off an anvil strike: 40 fast stretched sparks with gravity, triggered by an event',
    make: () => ({
      loop: false,
      layers: [P({ id: 'burst', shape: { type: 'cone', radius: 0.02, angle: 70 }, rate: 0, bursts: [{ at: 0, count: 40 }], life: [0.25, 0.6], speed: [1.6, 3.4], size: [0.012, 0.018], sizeEnd: 0.4, colour: ['spark', 'flame'], alpha: [1, 0], direction: [0, 1, 0], spread: 70, gravity: 6, drag: 0.4, stretch: 0.035 })],
    }),
  },
  'chimney-smoke': {
    label: 'Slow grey smoke puffs rising and spreading from a chimney',
    make: () => ({
      loop: true,
      layers: [P({ id: 'puffs', shape: { type: 'disc', radius: 0.08 }, rate: 2.5, life: [3, 4.5], speed: [0.25, 0.4], size: [0.18, 0.26], sizeEnd: 3, colour: ['smoke', 'ash'], alpha: [0.55, 0], direction: [0, 1, 0], spread: 12, gravity: -0.05, turbulence: 0.35, blend: 'alpha' })],
    }),
  },
  embers: {
    label: 'A puff of embers when charcoal is tipped in: a short upward burst that drifts and fades',
    make: () => ({
      loop: false,
      layers: [P({ id: 'puff', shape: { type: 'disc', radius: 0.12 }, rate: 0, bursts: [{ at: 0, count: 24 }], life: [0.7, 1.4], speed: [0.6, 1.2], size: [0.02, 0.035], sizeEnd: 0.3, colour: ['ember', 'deep'], alpha: [1, 0], direction: [0, 1, 0], spread: 35, gravity: 0.6, turbulence: 0.6 })],
    }),
  },
  rain: {
    label: 'Light rain over a 6 m square: thin stretched drops falling fast',
    make: () => ({
      loop: true,
      layers: [P({ id: 'drops', shape: { type: 'box', size: [6, 0.1, 6] }, rate: 260, life: [0.7, 0.9], speed: [6, 7], size: [0.008, 0.01], colour: ['rain', 'rain'], alpha: [0.55, 0.4], direction: [0, -1, 0], spread: 3, gravity: 0, stretch: 0.05, blend: 'alpha', offset: [0, 4.5, 0] })],
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
${NOISE_GLSL.replace(/vec2\(/g, 'vec2(')}
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
  ALPHA = a;
}
`;
}

// ── Godot scene (.tscn): GPU particles + a hidden CPU twin per layer, shape layers as crossed cards ───
const gv = (v: V3) => `Vector3(${v.map((n) => +n.toFixed(4)).join(', ')})`;
const gc = (h: string, a = 1) => { const c = hex(h); return `Color(${c.map((n) => +n.toFixed(4)).join(', ')}, ${+a.toFixed(3)})`; };

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
    const curve = add('Curve', `_data = [Vector2(0, 1), 0.0, 0.0, 0, 0, Vector2(1, ${l.sizeEnd ?? 1}), 0.0, 0.0, 0, 0]\npoint_count = 2`);
    const curveTex = add('CurveTexture', `curve = SubResource("${curve}")`);
    const dir = l.direction ?? [0, 1, 0];
    const shapeType = { point: 0, sphere: 1, cone: 0, box: 3, disc: 6 }[l.shape.type];
    const shapeProps = l.shape.type === 'sphere' ? `\nemission_sphere_radius = ${l.shape.radius ?? 0.1}` : l.shape.type === 'box' ? `\nemission_box_extents = ${gv((l.shape.size ?? [1, 1, 1]).map((v) => v / 2) as V3)}` : l.shape.type === 'disc' ? `\nemission_ring_axis = Vector3(0, 1, 0)\nemission_ring_height = 0.0\nemission_ring_radius = ${l.shape.radius ?? 0.1}\nemission_ring_inner_radius = 0.0` : '';
    const pm = add('ParticleProcessMaterial', `emission_shape = ${shapeType}${shapeProps}\ndirection = ${gv(dir)}\nspread = ${l.spread ?? 0}\ninitial_velocity_min = ${l.speed[0]}\ninitial_velocity_max = ${l.speed[1]}\ngravity = Vector3(0, ${-(l.gravity ?? 0)}, 0)\ndamping_min = ${(l.drag ?? 0) * 3}\ndamping_max = ${(l.drag ?? 0) * 3}\nscale_min = 1.0\nscale_max = ${+(l.size[1] / l.size[0]).toFixed(3)}\nscale_curve = SubResource("${curveTex}")\ncolor_ramp = SubResource("${gradTex}")${(l.turbulence ?? 0) > 0 ? `\nturbulence_enabled = true\nturbulence_noise_strength = ${(l.turbulence! * 2).toFixed(2)}\nturbulence_noise_scale = 4.0` : ''}${l.stretch ? '\nparticle_flag_align_y = true' : ''}`);
    const mat = add('StandardMaterial3D', `transparency = 1\nblend_mode = ${l.blend === 'add' ? 1 : 0}\nshading_mode = 0\nvertex_color_use_as_albedo = true\nbillboard_mode = ${l.stretch ? 2 : 3}\nbillboard_keep_scale = true\nparticles_anim_h_frames = 1\nparticles_anim_v_frames = 1`);
    const len = l.stretch ? Math.max(l.size[0], avg(l.speed) * l.stretch) : l.size[0];
    const quad = add('QuadMesh', `material = SubResource("${mat}")\nsize = Vector2(${l.size[0]}, ${+len.toFixed(4)})`);
    const amount = Math.max(1, Math.ceil(l.rate * l.life[1] + (l.bursts ?? []).reduce((s, b) => s + b.count, 0)));
    const oneShot = l.rate === 0;
    nodes.push(`[node name="${l.id}" type="GPUParticles3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${off.join(', ')})\namount = ${amount}\nlifetime = ${l.life[1]}\none_shot = ${oneShot}\nemitting = ${!oneShot}\nexplosiveness = ${oneShot ? 1 : 0}\nrandomness = ${+(1 - l.life[0] / l.life[1]).toFixed(3)}\nprocess_material = SubResource("${pm}")\ndraw_pass_1 = SubResource("${quad}")\ncast_shadow = 0\nmetadata/layer = "${l.id}"\nmetadata/rate = ${l.rate}`);
    // the CPU twin: the same emitter for renderers without GPU particles; studio/effects.gd swaps it in
    const cpuCurve = add('Curve', `_data = [Vector2(0, 1), 0.0, 0.0, 0, 0, Vector2(1, ${l.sizeEnd ?? 1}), 0.0, 0.0, 0, 0]\npoint_count = 2`);
    nodes.push(`[node name="${l.id}_cpu" type="CPUParticles3D" parent="."]\ntransform = Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, ${off.join(', ')})\nvisible = false\nemitting = false\namount = ${amount}\nlifetime = ${l.life[1]}\none_shot = ${oneShot}\nexplosiveness = ${oneShot ? 1 : 0}\nmesh = SubResource("${quad}")\nemission_shape = ${l.shape.type === 'box' ? 3 : l.shape.type === 'sphere' ? 1 : 0}${l.shape.type === 'box' ? `\nemission_box_extents = ${gv((l.shape.size ?? [1, 1, 1]).map((v) => v / 2) as V3)}` : l.shape.type === 'sphere' ? `\nemission_sphere_radius = ${l.shape.radius ?? 0.1}` : ''}\ndirection = ${gv(dir)}\nspread = ${l.spread ?? 0}\ninitial_velocity_min = ${l.speed[0]}\ninitial_velocity_max = ${l.speed[1]}\ngravity = Vector3(0, ${-(l.gravity ?? 0)}, 0)\nscale_amount_min = 1.0\nscale_amount_max = ${+(l.size[1] / l.size[0]).toFixed(3)}\nscale_amount_curve = SubResource("${cpuCurve}")\ncolor_ramp = SubResource("${grad}")\nmetadata/layer = "${l.id}"\nmetadata/fallback = true`);
  }
  return `[gd_scene load_steps=${sub.length + 2} format=3]\n\n${ext}\n\n${sub.join('\n\n')}\n\n${nodes.join('\n\n')}\n`;
}
const safe = (s: string) => s.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Effect';

/** Resolve a trigger spec: "Blacksmith:hammer-strike@impact" → a clip and the fraction where it fires;
 *  anything else is a game event the code raises (effects.event("fed")). */
export function parseTrigger(on: string, layer: string): EffectTrigger {
  const m = /^([^:@]+):([^@]+)@([\w.]+)$/.exec(on.trim());
  if (!m) return { on, layer };
  const [, character, clip, moment] = m;
  const action = clip.replace(/^.*:/, '');
  const frac = /^[\d.]+$/.test(moment) ? Number(moment) : ACTION_EVENTS[action]?.[moment];
  if (frac === undefined || !(frac >= 0 && frac <= 1)) throw new Error(`no moment "${moment}" in ${action} (known: ${Object.entries(ACTION_EVENTS).map(([k, v]) => `${k}@${Object.keys(v).join('|')}`).join(', ')}; or a fraction 0..1)`);
  return { on, layer, character, clip, fraction: frac };
}
