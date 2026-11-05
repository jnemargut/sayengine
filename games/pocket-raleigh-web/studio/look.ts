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
  c = max(c, vec3(0.0));
  c = c / (vec3(1.0) + c);
  c = toSrgb(c);
  if (useLut > 0.5) c = texture(tLut, c).rgb;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Apply a look record (look.json) to a game: sky, fog, lights, material tweaks, outline and grade. */
export async function applyLook(game: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; studio?: THREE.Object3D | null }, record?: any, dir = LOOK_DIR): Promise<StudioLook | null> {
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
  // material tweaks: by shading class ("world lit" → lit) or by material name
  const tweaks: Record<string, any> = L.materials ?? {};
  const root = game.studio ?? scene;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material]) as any[]) {
      const key = String(m.name ?? '');
      const t = tweaks[key] ?? tweaks[key.replace(/^world /, '')];
      if (!t) continue;
      if (t.emission) { m.emissive = new THREE.Color(t.emission); m.emissiveIntensity = t.emissionEnergy ?? 1; }
      if (t.roughness !== undefined) m.roughness = t.roughness;
      if (t.metalness !== undefined) m.metalness = t.metalness;
      if (t.tint && m.color) m.color.multiply(new THREE.Color(t.tint));
      m.needsUpdate = true;
    }
  });
  // the grade pass
  const lut = await loadStrip(dir + (D.lut?.strip ?? 'lut.png'), L.lutSize ?? 33);
  const pass = installGradePass(renderer, lut, { useLut: !L.baked, outline: L.outline });
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
export function installGradePass(renderer: THREE.WebGLRenderer, lut: THREE.Data3DTexture | null, opts: { useLut?: boolean; outline?: any } = {}): GradePass {
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
    },
  });
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
    dispose() { rt.dispose(); depth.dispose(); mat.dispose(); (renderer as any).render = orig; renderer.toneMapping = prevTone; },
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
      renderer.setRenderTarget(null);
      orig(post, postCam);
    } finally { inside = false; }
  };
  return pass;
}

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
