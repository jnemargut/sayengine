// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// The studio look (Decision 29) on the web: assets/studio/look/look.json drives the sky, fog, sun and
// ambient light, material tweaks, the outline and the colour grade. The pinned tonemapper: the scene
// renders to a linear HDR target, then one full-screen pass does exactly what Godot's tonemap pass does
// (Reinhard "transport" x/(1+x) → sRGB → the look's 3D LUT, sampled the same way), so both engines
// agree. The LUT carries the real tone curve and grade. Works with any code that calls
// renderer.render(scene, camera): the renderer's render is wrapped once.
import * as THREE from 'three';

export interface StudioLook {
  name: string;
  record: any;
  sun: THREE.DirectionalLight;
  ambient: THREE.AmbientLight;
  /** switch the grade pass off (A/B against the plain render) */
  enabled: boolean;
  dispose(): void;
}

const LOOK_DIR = 'assets/studio/look/';

export async function loadLookRecord(dir = LOOK_DIR): Promise<any | null> {
  try { const r = await fetch(dir + 'look.json'); if (!r.ok) return null; return await r.json(); } catch { return null; }
}

async function loadStrip(url: string, N: number): Promise<THREE.Data3DTexture> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' } as any)!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const data = new Uint8Array(N * N * N * 4);
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const s = (g * N * N + b * N + r) * 4, d = (r + g * N + b * N * N) * 4;
    data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = 255;
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// Mirrors Godot's tonemap pass (Reinhard with a huge white = x/(1+x); linear_to_srgb; textureLod(lut, color))
const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler3D tLut;
uniform float useLut;
uniform float outline;
uniform vec3 outlineColor;
uniform float outlineWidth;
uniform float outlineThreshold;
uniform vec2 texel;
uniform float near;
uniform float far;
uniform float useGlow;
uniform float glowIntensity;
uniform float glowLevels[7];
uniform sampler2D tGlow0; uniform sampler2D tGlow1; uniform sampler2D tGlow2; uniform sampler2D tGlow3; uniform sampler2D tGlow4; uniform sampler2D tGlow5; uniform sampler2D tGlow6;
varying vec2 vUv;
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, 12.92 * c, vec3(lessThan(c, vec3(0.0031308)))); }
float invDepth(vec2 uv) { float d = texture2D(tDepth, uv).r; float z = (near * far) / (far - d * (far - near)); return 1.0 / z; }
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  if (outline > 0.5) {
    vec2 px = texel * outlineWidth;
    float i0 = invDepth(vUv);
    float lap = abs(invDepth(vUv + vec2(px.x, 0.0)) + invDepth(vUv - vec2(px.x, 0.0)) - 2.0 * i0) + abs(invDepth(vUv + vec2(0.0, px.y)) + invDepth(vUv - vec2(0.0, px.y)) - 2.0 * i0);
    float e = step(outlineThreshold, lap / max(i0, 1e-6));
    c = mix(c, outlineColor, e);
  }
  if (useGlow > 0.5) {
    // Godot 4.7 (additive mode): the glow levels gathered from the mip chain, × intensity, added in linear
    // HDR before the tonemapper
    vec3 g = texture2D(tGlow0, vUv).rgb * glowLevels[0] + texture2D(tGlow1, vUv).rgb * glowLevels[1] + texture2D(tGlow2, vUv).rgb * glowLevels[2]
      + texture2D(tGlow3, vUv).rgb * glowLevels[3] + texture2D(tGlow4, vUv).rgb * glowLevels[4] + texture2D(tGlow5, vUv).rgb * glowLevels[5] + texture2D(tGlow6, vUv).rgb * glowLevels[6];
    c += max(g, vec3(0.0)) * glowIntensity;
  }
  c = max(c, vec3(0.0));
  c = c / (vec3(1.0) + c);
  c = toSrgb(c);
  if (useLut > 0.5) c = texture(tLut, c).rgb;
  gl_FragColor = vec4(c, 1.0);
}`;

// The glow chain, after Godot's gaussian glow: each level halves the resolution; a horizontal 7-tap pass
// reads the level above at even texels (the first pass also applies the HDR threshold curve), then a
// vertical 7-tap pass blurs at the new size. Weights are Godot's (0.174938, 0.165569, 0.140367, 0.106595).
// Fitted against Godot 4.7.2 renders of the same views (Pocket Raleigh night): its level 0 sits at
// 1/2^GLOW_SHIFT of the screen and its glow comes out GLOW_GAIN × brighter than this chain's.
export const GLOW_SHIFT = 1, GLOW_GAIN = 0.6;   // sweep: gain 0 → 0.150, 0.3 → 0.126, 0.6 → 0.114, 1 → 0.120, 1.6 → 0.142 (mean FLIP, 3 night views)
const GLOW_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform float horizontal;
uniform float down;
uniform float first;
uniform float threshold;
uniform float softness;
uniform float cap;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(tSrc, 0);
  ivec2 bp = horizontal > 0.5 && down > 0.5 ? p * 2 : p;
  ivec2 dir = horizontal > 0.5 ? ivec2(1, 0) : ivec2(0, 1);
  float w[4] = float[4](0.174938, 0.165569, 0.140367, 0.106595);
  vec4 c = texelFetch(tSrc, clamp(bp, ivec2(0), sz - 1), 0) * w[0];
  for (int k = 1; k < 4; k++) {
    ivec2 a = bp + dir * k, b = bp - dir * k;
    if (all(lessThan(a, sz))) c += texelFetch(tSrc, a, 0) * w[k];
    if (all(greaterThanEqual(b, ivec2(0)))) c += texelFetch(tSrc, b, 0) * w[k];
  }
  if (first > 0.5) {
    float lum = max(c.r, max(c.g, c.b));
    float fb = smoothstep(threshold, threshold + softness, lum);
    c = min(c * fb, vec4(cap));
  }
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

/** Apply a look record (look.json) to a game: sky, fog, lights, material tweaks, outline and grade. */
export async function applyLook(game: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera?: THREE.Camera; studio?: THREE.Object3D | null }, record?: any, dir = LOOK_DIR): Promise<StudioLook | null> {
  const L = record ?? await loadLookRecord(dir);
  if (!L) return null;
  const { renderer, scene } = game;
  const D = L.derived ?? {};
  // sky and fog (Godot: BG_COLOR, depth fog with the same smoothstep)
  scene.background = new THREE.Color(L.sky.color);
  scene.fog = L.fog?.enabled ? new THREE.Fog(L.fog.color, L.fog.begin, L.fog.end) : null;
  // lights: drop the game's own, add the look's (Godot energy × π = three.js intensity)
  const old: THREE.Object3D[] = [];
  scene.traverse((o: any) => { if (o.isLight && !o.userData.studioLook) old.push(o); });
  for (const o of old) o.parent?.remove(o);
  const ambient = new THREE.AmbientLight(L.light.ambient.color, D.threeAmbientIntensity ?? L.light.ambient.energy * Math.PI);
  ambient.userData.studioLook = true;
  const sun = new THREE.DirectionalLight(L.light.sun.color, D.threeSunIntensity ?? L.light.sun.energy * Math.PI);
  sun.userData.studioLook = true;
  const to = D.toSun ?? [0.38, 0.79, 0.49];
  sun.position.set(to[0] * 300, to[1] * 300, to[2] * 300);
  sun.castShadow = !!L.light.sun.shadows;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 900 });
  sun.shadow.bias = -0.0004;
  scene.add(ambient, sun, sun.target);
  // flat town layers never cast shadows (shadow acne on the road just above them); same rule as Godot
  (game.studio ?? scene).traverse((o: any) => { if (o.isMesh && (/(Ground|Streets|Parks[ _]and[ _]plazas|Water|Light[ _]pools)$/.test(o.name) || /(Ground|Streets|Parks[ _]and[ _]plazas|Water|Light[ _]pools)$/.test(o.parent?.name ?? ''))) o.castShadow = false; });
  // material tweaks: by shading class ("world lit" → lit) or by material name
  const tweaks: Record<string, any> = L.materials ?? {};
  const root = game.studio ?? scene;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]) as any[];
    for (const [mi, m] of mats.entries()) {
      const key = String(m.name ?? '');
      const t = tweaks[key] ?? tweaks[key.replace(/^world /, '')] ?? tweaks[key.split(' ').pop() ?? ''];
      if (!t) continue;
      if (key.endsWith('pool')) {
        // light pools on the ground: unlit, additive, vertex colour × emissionEnergy × tint, no fog (as Godot)
        const k = t.emissionEnergy ?? 0, tint = new THREE.Color(t.emission ?? '#ffffff');
        const pm = new THREE.MeshBasicMaterial({ name: key, vertexColors: true, color: new THREE.Color(tint.r * k, tint.g * k, tint.b * k), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });
        if (Array.isArray(o.material)) o.material[mi] = pm; else o.material = pm;
        o.castShadow = false; o.receiveShadow = false;
        continue;
      }
      if (t.emission) { m.emissive = new THREE.Color(t.emission); m.emissiveIntensity = t.emissionEnergy ?? 1; }
      if (t.roughness !== undefined) m.roughness = t.roughness;
      if (t.metalness !== undefined) m.metalness = t.metalness;
      if (t.tint && m.color) m.color.multiply(new THREE.Color(t.tint));
      m.needsUpdate = true;
    }
  });
  // the grade pass, or the soft-cartoon preset in its place (it grades with the same LUT and draws its own ink)
  const lut = await loadStrip(dir + (D.lut?.strip ?? 'lut.png'), L.lutSize ?? 33);
  const soft = L.style?.preset === 'soft-cartoon';
  const pass = soft ? installSoftCartoonPass(renderer, lut, { ...L.style, useLut: !L.baked }) : installGradePass(renderer, lut, { useLut: !L.baked, outline: L.outline, bloom: L.bloom });
  if (soft && L.style.precompile !== false && game.camera) (pass as SoftCartoonPass).precompile(scene, game.camera);
  const look: StudioLook = {
    name: L.name, record: L, sun, ambient,
    get enabled() { return pass.enabled; }, set enabled(v: boolean) { pass.enabled = v; },
    dispose() { pass.dispose(); lut.dispose(); },
  };
  (game as any).look = look;
  return look;
}

export interface GradePass { enabled: boolean; setLut(t: THREE.Data3DTexture | null): void; setOutline(o: any): void; dispose(): void }
/**
 * Wrap renderer.render: scenes drawn to the screen go to a linear HDR target first, then one pass does
 * the outline, the transport tonemapper and the LUT. Shared by the games and the studio view.
 */
export function installGradePass(renderer: THREE.WebGLRenderer, lut: THREE.Data3DTexture | null, opts: { useLut?: boolean; outline?: any; bloom?: any } = {}): GradePass {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const depth = new THREE.DepthTexture(Math.max(1, size.x), Math.max(1, size.y));
  depth.type = THREE.FloatType;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 4, depthTexture: depth, colorSpace: THREE.LinearSRGBColorSpace });
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      tColor: { value: rt.texture }, tDepth: { value: depth }, tLut: { value: lut }, useLut: { value: lut && opts.useLut !== false ? 1 : 0 },
      outline: { value: 0 }, outlineColor: { value: new THREE.Color('#000000') }, outlineWidth: { value: 1 }, outlineThreshold: { value: 0.06 },
      texel: { value: new THREE.Vector2(1 / Math.max(1, size.x), 1 / Math.max(1, size.y)) }, near: { value: 0.1 }, far: { value: 2500 },
      useGlow: { value: 0 }, glowIntensity: { value: 0.8 }, glowLevels: { value: [0, 0, 1, 0, 1, 0, 0] },
      tGlow0: { value: null }, tGlow1: { value: null }, tGlow2: { value: null }, tGlow3: { value: null }, tGlow4: { value: null }, tGlow5: { value: null }, tGlow6: { value: null },
    },
  });
  // glow targets: level i is 1/2^(i+1) of the screen; h = after the horizontal pass, v = the level
  const B = opts.bloom && opts.bloom.enabled !== false ? opts.bloom : null;
  const levels: number[] = B ? (B.levels ?? [0, 0, 1, 0, 1, 0, 0]) : [];
  const maxLevel = levels.reduce((m, v, i) => (v > 0 ? i : m), -1);
  const glowMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: GLOW_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { tSrc: { value: null }, horizontal: { value: 1 }, down: { value: 1 }, first: { value: 0 }, threshold: { value: B?.threshold ?? 1 }, softness: { value: B?.softness ?? 2 }, cap: { value: 12 } } });
  const glowQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glowMat); glowQuad.frustumCulled = false;
  const glowScene = new THREE.Scene(); glowScene.add(glowQuad);
  const mk = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace });
  const hT: THREE.WebGLRenderTarget[] = [], vT: THREE.WebGLRenderTarget[] = [];
  for (let i = 0; i <= maxLevel; i++) { hT.push(mk()); vT.push(mk()); (mat.uniforms as any)['tGlow' + i].value = vT[i].texture; }
  for (let i = maxLevel + 1; i < 7; i++) (mat.uniforms as any)['tGlow' + i].value = rt.texture;
  if (B && maxLevel >= 0) { mat.uniforms.useGlow.value = 1; mat.uniforms.glowIntensity.value = (B.intensity ?? 0.8) * GLOW_GAIN; mat.uniforms.glowLevels.value = [0, 1, 2, 3, 4, 5, 6].map((i) => levels[i] ?? 0); }
  const runGlow = () => {
    let src: THREE.Texture = rt.texture, w = size.x, h = size.y;
    for (let i = 0; i <= maxLevel; i++) {
      const down = i > 0 || GLOW_SHIFT > 0 ? 1 : 0;
      if (down) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); }
      glowMat.uniforms.down.value = down;
      if (hT[i].width !== w || hT[i].height !== h) { hT[i].setSize(w, h); vT[i].setSize(w, h); }
      glowMat.uniforms.tSrc.value = src; glowMat.uniforms.horizontal.value = 1; glowMat.uniforms.first.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(hT[i]); orig(glowScene, postCam);
      glowMat.uniforms.tSrc.value = hT[i].texture; glowMat.uniforms.horizontal.value = 0; glowMat.uniforms.first.value = 0;
      renderer.setRenderTarget(vT[i]); orig(glowScene, postCam);
      src = vT[i].texture;
    }
  };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const post = new THREE.Scene(); post.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;   // the pass tonemaps
  const orig = renderer.render.bind(renderer);
  let inside = false;
  const pass: GradePass = {
    enabled: true,
    setLut(t) { mat.uniforms.tLut.value = t; mat.uniforms.useLut.value = t ? 1 : 0; },
    setOutline(o) { mat.uniforms.outline.value = o?.enabled ? 1 : 0; if (o) { mat.uniforms.outlineColor.value.set(o.color ?? '#000000'); mat.uniforms.outlineWidth.value = o.width ?? 1; mat.uniforms.outlineThreshold.value = o.threshold ?? 0.06; } },
    dispose() { rt.dispose(); depth.dispose(); mat.dispose(); glowMat.dispose(); for (const t of [...hT, ...vT]) t.dispose(); (renderer as any).render = orig; renderer.toneMapping = prevTone; },
  };
  pass.setOutline(opts.outline);
  (renderer as any).render = (s: THREE.Object3D, cam: THREE.Camera) => {
    if (inside || !pass.enabled || renderer.getRenderTarget() !== null || s === post) return orig(s, cam);
    inside = true;
    try {
      renderer.getDrawingBufferSize(size);
      if (rt.width !== size.x || rt.height !== size.y) { rt.setSize(size.x, size.y); mat.uniforms.texel.value.set(1 / size.x, 1 / size.y); }
      const pc = cam as THREE.PerspectiveCamera;
      if (pc.isPerspectiveCamera) { mat.uniforms.near.value = pc.near; mat.uniforms.far.value = pc.far; }
      renderer.setRenderTarget(rt);
      orig(s, cam);
      if (mat.uniforms.useGlow.value > 0.5) runGlow();
      renderer.setRenderTarget(null);
      orig(post, postCam);
    } finally { inside = false; }
  };
  return pass;
}

// ── the soft-cartoon preset ────────────────────────────────────────────────
// Each frame the scene is drawn three times: lit (HDR, as now), albedo (unlit base colours) and normal + id
// (the view normal in rgb, a per-mesh id in alpha). One compose pass then calms the albedo (blurred), turns
// the light into two soft bands plus a highlight (the lit colour over the albedo is the light ratio),
// saturates, and inks the id and normal edges by darkening the pixel itself (coloured outlines, never
// black). Meshes it can't stylise (additive or depthWrite-false meshes such as light pools and glows,
// shader-material fur shells and particles, anything named like a whisker) pass through: drawn once more
// without them, and the difference added back on top.

export interface SoftCartoonExclude {
  /** additive meshes (light pools, glows) */
  additive?: boolean;
  /** meshes that don't write depth (decals, soft overlays) */
  noDepthWrite?: boolean;
  /** ShaderMaterial / RawShaderMaterial meshes (fur shells, particles, custom effects) */
  shaderMaterials?: boolean;
  /** mesh (or parent) names, case-insensitive: strings are regex sources */
  names?: Array<string | RegExp>;
}
export interface SoftCartoonOptions {
  /** saturation after banding (1 = none) */
  saturation?: number;
  /** brightness of the shadow band (the lit band is 1) */
  shadow?: number;
  /** light ratio where the shadow band softly turns into the lit band */
  band?: [number, number];
  /** light ratio range and strength of the highlight band */
  highlight?: [number, number, number];
  /** how much of the albedo is blurred (textures calmed): 0..1 */
  calm?: number;
  /** ink: an edge pixel is the pixel × ink (0 = black, 1 = no outline) */
  ink?: number;
  /** ink width in pixels at 720 p (scales with the screen height) */
  inkWidth?: number;
  exclude?: SoftCartoonExclude;
  /** compile every pass's materials up front (no first-use stutter); applyLook does it when it has a camera */
  precompile?: boolean;
}
export const SOFT_CARTOON_DEFAULTS = {
  saturation: 1.35, shadow: 0.5, band: [0.45, 0.6] as [number, number], highlight: [1.6, 1.8, 0.35] as [number, number, number],
  calm: 0.8, ink: 0.32, inkWidth: 1.4,
  exclude: { additive: true, noDepthWrite: true, shaderMaterials: true, names: ['whisker'] as Array<string | RegExp> },
  precompile: true,
};

/**
 * Does the soft-cartoon pass leave this object as it is? Pure: reads only names, userData and material flags.
 * userData.softCartoon = false always excludes, = true always includes. Points, lines and sprites pass through.
 */
export function softCartoonExcluded(o: { name?: string; parent?: { name?: string } | null; userData?: any; isMesh?: boolean; material?: any }, rules: SoftCartoonExclude = SOFT_CARTOON_DEFAULTS.exclude): boolean {
  const flag = o.userData?.softCartoon;
  if (flag === false) return true;
  if (flag === true) return false;
  if (!o.isMesh) return true;
  const names = (rules.names ?? []).map((n) => (typeof n === 'string' ? new RegExp(n, 'i') : n));
  if (names.some((re) => re.test(o.name ?? '') || re.test(o.parent?.name ?? ''))) return true;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  return mats.some((m) => !m
    || (rules.additive !== false && m.blending === THREE.AdditiveBlending)
    || (rules.noDepthWrite !== false && m.depthWrite === false)
    || (rules.shaderMaterials !== false && (m.isShaderMaterial || m.isRawShaderMaterial)));
}

export const SOFT_CARTOON_VERT = /* glsl */ `in vec3 position; in vec2 uv; out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
/** GLSL ES 3.00 without the #version line (three's RawShaderMaterial adds it). */
export const SOFT_CARTOON_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tLit;
uniform sampler2D tBase;
uniform sampler2D tAlb;
uniform sampler2D tNid;
uniform sampler3D tLut;
uniform float useLut;
uniform float useDelta;
uniform vec2 texel;
uniform float px;
uniform float saturation;
uniform float shadow;
uniform vec2 band;
uniform vec3 highlight;
uniform float calm;
uniform float ink;
uniform float inkWidth;
in vec2 vUv;
out vec4 fragColor;
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sat(vec3 c, float s) { return max(vec3(0.0), mix(vec3(lum(c)), c, s)); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, 12.92 * c, vec3(lessThan(c, vec3(0.0031308)))); }
vec3 blurA(vec2 uv) {
  vec3 a = vec3(0.0);
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) a += texture(tAlb, uv + vec2(float(i), float(j)) * texel * px * 1.6).rgb;
  return a / 25.0;
}
float edge(vec2 uv) {
  vec2 o = texel * inkWidth * px;
  vec4 c0 = texture(tNid, uv);
  vec3 n0 = normalize(c0.rgb * 2.0 - 1.0 + 1e-4);
  float e = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    vec4 c1 = texture(tNid, uv + vec2(cos(a), sin(a)) * o);
    e = max(e, step(0.002, abs(c1.a - c0.a)));
    e = max(e, smoothstep(0.35, 0.6, 1.0 - dot(n0, normalize(c1.rgb * 2.0 - 1.0 + 1e-4))));
  }
  return e;
}
void main() {
  vec3 lit = texture(tLit, vUv).rgb;
  vec3 base = useDelta > 0.5 ? texture(tBase, vUv).rgb : lit;
  vec3 a = texture(tAlb, vUv).rgb;
  vec3 af = mix(a, blurA(vUv), calm);
  float sh = lum(base) / max(lum(a), 0.02);
  float b = shadow + (1.0 - shadow) * smoothstep(band.x, band.y, sh) + highlight.z * smoothstep(highlight.x, highlight.y, sh);
  vec3 c = sat(af * b, saturation);
  c = mix(c, c * ink, edge(vUv));
  c += lit - base;
  c = max(c, vec3(0.0));
  c = c / (vec3(1.0) + c);
  c = toSrgb(c);
  if (useLut > 0.5) c = texture(tLut, c).rgb;
  fragColor = vec4(c, 1.0);
}`;

export interface SoftCartoonPass extends GradePass {
  /** compile the albedo, normal-id and compose materials for this scene now */
  precompile(scene: THREE.Object3D, camera: THREE.Camera): void;
  /** the exclusion rule this pass uses */
  excluded(o: THREE.Object3D): boolean;
}

/** Wrap renderer.render with the soft-cartoon look (instead of the grade pass, not on top of it). */
export function installSoftCartoonPass(renderer: THREE.WebGLRenderer, lut: THREE.Data3DTexture | null, options: SoftCartoonOptions & { useLut?: boolean } = {}): SoftCartoonPass {
  const o = { ...SOFT_CARTOON_DEFAULTS, ...options, exclude: { ...SOFT_CARTOON_DEFAULTS.exclude, ...(options.exclude ?? {}) } };
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const W = Math.max(1, size.x), H = Math.max(1, size.y);
  const hdr = () => new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4, colorSpace: THREE.LinearSRGBColorSpace });
  const rtLit = hdr(), rtBase = hdr(), rtAlb = hdr();
  const rtNid = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const targets = [rtLit, rtBase, rtAlb, rtNid];
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: SOFT_CARTOON_VERT, fragmentShader: SOFT_CARTOON_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      tLit: { value: rtLit.texture }, tBase: { value: rtBase.texture }, tAlb: { value: rtAlb.texture }, tNid: { value: rtNid.texture },
      tLut: { value: lut }, useLut: { value: lut && o.useLut !== false ? 1 : 0 }, useDelta: { value: 0 },
      texel: { value: new THREE.Vector2(1 / W, 1 / H) }, px: { value: H / 720 },
      saturation: { value: o.saturation }, shadow: { value: o.shadow }, band: { value: new THREE.Vector2(...o.band) },
      highlight: { value: new THREE.Vector3(...o.highlight) }, calm: { value: o.calm }, ink: { value: o.ink }, inkWidth: { value: o.inkWidth },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const post = new THREE.Scene(); post.add(quad);
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const excluded = (x: THREE.Object3D) => softCartoonExcluded(x as any, o.exclude);

  // the swapped materials, made once per material (albedo) or per mesh (normal + id)
  const albedo = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
  const nid = new WeakMap<THREE.Object3D, THREE.MeshNormalMaterial[]>();
  const made: THREE.Material[] = [];
  let nextId = 0;
  const albedoOf = (m: any): THREE.MeshBasicMaterial => {
    let a = albedo.get(m);
    if (!a) {
      a = new THREE.MeshBasicMaterial({ toneMapped: false });
      albedo.set(m, a); made.push(a);
    }
    // follow the original's colour, texture and cut-outs (a texture appearing changes the program)
    if (a.map !== (m.map ?? null) || a.vertexColors !== !!m.vertexColors || a.alphaMap !== (m.alphaMap ?? null)) a.needsUpdate = true;
    a.color.copy(m.color ?? WHITE); a.map = m.map ?? null; a.alphaMap = m.alphaMap ?? null; a.vertexColors = !!m.vertexColors;
    a.alphaTest = m.alphaTest ?? 0; a.side = m.side ?? THREE.FrontSide; a.transparent = !!m.transparent; a.opacity = m.opacity ?? 1;
    a.clippingPlanes = m.clippingPlanes ?? null; a.fog = m.fog ?? true;
    return a;
  };
  const nidOf = (mesh: THREE.Mesh): THREE.MeshNormalMaterial[] => {
    const src = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as any[];
    let list = nid.get(mesh);
    if (!list || list.length !== src.length) {
      const id = ((nextId++ * 37) % 254 + 1) / 255;
      list = src.map(() => {
        const n = new THREE.MeshNormalMaterial();
        const uId = { value: id };
        n.onBeforeCompile = (sh) => { sh.uniforms.uId = uId; sh.fragmentShader = 'uniform float uId;\n' + sh.fragmentShader.replace(/}\s*$/, '\tgl_FragColor.a = uId;\n}'); };
        n.customProgramCacheKey = () => 'studio-soft-cartoon-nid';
        made.push(n);
        return n;
      });
      nid.set(mesh, list);
    }
    list.forEach((n, i) => { n.side = src[i]?.side ?? THREE.FrontSide; n.clippingPlanes = src[i]?.clippingPlanes ?? null; n.alphaTest = src[i]?.alphaTest ?? 0; });
    return list;
  };
  // sort the scene once per frame: what the pass draws, and what passes through
  const sort = (s: THREE.Object3D) => {
    const meshes: THREE.Mesh[] = [], through: THREE.Object3D[] = [];
    s.traverseVisible((x: any) => {
      if (!(x.isMesh || x.isPoints || x.isLine || x.isSprite)) return;
      if (excluded(x)) through.push(x); else meshes.push(x);
    });
    return { meshes, through };
  };
  const swap = (meshes: THREE.Mesh[], kind: 'albedo' | 'nid') => {
    const back = meshes.map((m) => m.material);
    for (const m of meshes) {
      if (kind === 'nid') { const l = nidOf(m); m.material = Array.isArray(m.material) ? l : l[0]; }
      else m.material = Array.isArray(m.material) ? m.material.map(albedoOf) : albedoOf(m.material);
    }
    return () => meshes.forEach((m, i) => { m.material = back[i]; });
  };
  const clear = new THREE.Color();
  const passes = (s: THREE.Object3D, cam: THREE.Camera, draw: (s: THREE.Object3D, c: THREE.Camera) => void) => {
    const { meshes, through } = sort(s);
    renderer.setRenderTarget(rtLit); draw(s, cam);
    for (const x of through) x.visible = false;
    try {
      mat.uniforms.useDelta.value = through.length ? 1 : 0;
      if (through.length) { renderer.setRenderTarget(rtBase); draw(s, cam); }
      let undo = swap(meshes, 'albedo');
      try { renderer.setRenderTarget(rtAlb); draw(s, cam); } finally { undo(); }
      const sc = s as THREE.Scene, bg = sc.background, alpha = renderer.getClearAlpha();
      renderer.getClearColor(clear);
      sc.background = null; renderer.setClearColor(0x000000, 0);
      undo = swap(meshes, 'nid');
      try { renderer.setRenderTarget(rtNid); draw(s, cam); } finally { undo(); sc.background = bg; renderer.setClearColor(clear, alpha); }
    } finally { for (const x of through) x.visible = true; }
  };

  const prevTone = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;   // the pass tonemaps
  const orig = renderer.render.bind(renderer);
  let inside = false;
  const pass: SoftCartoonPass = {
    enabled: true,
    setLut(t) { mat.uniforms.tLut.value = t; mat.uniforms.useLut.value = t ? 1 : 0; },
    setOutline() { /* the preset draws its own ink */ },
    excluded,
    precompile(s, cam) {
      // programs depend on the target (its colour space, no tone mapping), so compile into the real ones
      const { meshes } = sort(s), prev = renderer.getRenderTarget();
      try {
        renderer.setRenderTarget(rtLit); renderer.compile(s, cam);
        for (const [kind, rt] of [['albedo', rtAlb], ['nid', rtNid]] as const) { const undo = swap(meshes, kind); try { renderer.setRenderTarget(rt); renderer.compile(s, cam); } finally { undo(); } }
        renderer.setRenderTarget(null); renderer.compile(post, postCam);
      } finally { renderer.setRenderTarget(prev); }
    },
    dispose() { for (const t of targets) t.dispose(); mat.dispose(); for (const m of made) m.dispose(); (renderer as any).render = orig; renderer.toneMapping = prevTone; },
  };
  (renderer as any).render = (s: THREE.Object3D, cam: THREE.Camera) => {
    if (inside || !pass.enabled || renderer.getRenderTarget() !== null || s === post) return orig(s, cam);
    inside = true;
    try {
      renderer.getDrawingBufferSize(size);
      if (rtLit.width !== size.x || rtLit.height !== size.y) {
        for (const t of targets) t.setSize(size.x, size.y);
        mat.uniforms.texel.value.set(1 / size.x, 1 / size.y); mat.uniforms.px.value = size.y / 720;
      }
      passes(s, cam, orig);
      renderer.setRenderTarget(null);
      orig(post, postCam);
    } finally { inside = false; }
  };
  return pass;
}
const WHITE = new THREE.Color(1, 1, 1);

/** A LUT from raw data (r fastest, 3 floats per entry, texel-centre convention): the studio view builds it from the record. */
export function lutTexture(data: Float32Array, N: number): THREE.Data3DTexture {
  const u8 = new Uint8Array(N * N * N * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) { u8[j] = Math.round(Math.min(1, Math.max(0, data[i])) * 255); u8[j + 1] = Math.round(Math.min(1, Math.max(0, data[i + 1])) * 255); u8[j + 2] = Math.round(Math.min(1, Math.max(0, data[i + 2])) * 255); u8[j + 3] = 255; }
  const t = new THREE.Data3DTexture(u8, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}
