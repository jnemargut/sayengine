// The look: physically based materials with procedural wood grain (no UVs), image-based
// environment light, soft contact shadows. Shared by the viewport, thumbnails, AI renders and
// presentation renders so they all agree on what "walnut" looks like.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export interface Mat {
  name: string; color: string; roughness?: number; metalness?: number;
  clearcoat?: number; clearcoatRoughness?: number; transmission?: number; ior?: number; thickness?: number; opacity?: number;
  grain?: { color2: string; scale: number; contrast: number } | null;
}
type V3 = [number, number, number];

const GRAIN_VERT_DECL = 'varying vec3 vGrainPos;\n';
const GRAIN_FRAG_DECL = /* glsl */ `
uniform vec3 grainColor; uniform float grainScale; uniform float grainContrast; uniform vec3 grainAxis; uniform vec3 grainCenter; uniform vec3 grainSide;
varying vec3 vGrainPos;
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float gFbm(vec3 p) { return 0.55 * gNoise(p) + 0.3 * gNoise(p * 2.03) + 0.15 * gNoise(p * 4.1); }
`;
// Flat-sawn boards: growth rings around a "log" axis that runs along the part's longest side and
// sits off to one side of it, so rings read as long stripes and cathedral arches; fibres on top.
const GRAIN_FRAG = /* glsl */ `
{
  vec3 p = vGrainPos - grainCenter;
  float along = dot(p, grainAxis);
  vec3 radial = p - along * grainAxis;
  vec3 side = grainSide;
  // the log's pith runs just under the board's face, so the face cuts the rings at a shallow angle (flat-sawn arches)
  // and tilts slightly along the board (real logs taper), which turns the cut rings into long arches
  vec3 q = radial + side * (0.03 + along * 0.22) + normalize(cross(grainAxis, side)) * 0.02;
  // slow, large wobble of the rings along the board plus a little local wander
  float warp = (gFbm(vec3(along * 1.3, q.x * 3.0, q.z * 3.0) * grainScale) - 0.5) * 0.06
             + (gFbm(vec3(along * 6.0, q.x * 14.0, q.z * 14.0) * grainScale) - 0.5) * 0.012;
  float rr = (length(q) + warp) * 38.0 * grainScale;
  float ring = fract(rr);
  float id = floor(rr);
  // each ring has its own width and darkness: earlywood fades into a darker latewood band
  float amp = 0.45 + 0.55 * gHash(vec3(id, 3.1, 7.7));
  float late = smoothstep(0.35, 0.92, ring) * (1.0 - smoothstep(0.93, 1.0, ring)) * amp;
  float fibre = gNoise(vec3(along * 3.0, dot(radial, side) * 520.0, length(radial) * 520.0) * grainScale);
  float tone = (gFbm(vec3(along * 2.0, q.x * 5.0, q.z * 5.0)) - 0.5) * 0.5;
  float t = clamp(late * 0.75 + (fibre - 0.5) * 0.22 + tone, 0.0, 1.0) * grainContrast;
  diffuseColor.rgb = mix(diffuseColor.rgb, grainColor, t);
}
`;

export function longestAxis(min: V3, max: V3): THREE.Vector3 {
  const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const k = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
  return new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
}

/** The part's thinnest direction other than the grain axis (a board's face normal). */
export function thinnestAxis(min: V3, max: V3, axis: THREE.Vector3): THREE.Vector3 {
  const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let k = -1;
  for (let i = 0; i < 3; i++) if (axis.getComponent(i) === 0 && (k < 0 || d[i] < d[k])) k = i;
  return new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
}

/** A three.js material for a resolved studio material. `override` replaces the colour (highlights, failures). */
export function makeMaterial(m: Mat, opts: { bbox?: { min: V3; max: V3 }; override?: string; wireframe?: boolean; polygonOffset?: boolean } = {}): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: opts.override ?? m.color,
    roughness: m.roughness ?? 0.6,
    metalness: opts.override ? 0 : m.metalness ?? 0,
    clearcoat: m.clearcoat ?? 0,
    clearcoatRoughness: m.clearcoatRoughness ?? 0.1,
    transmission: opts.override ? 0 : m.transmission ?? 0,
    ior: m.ior ?? 1.5,
    thickness: m.thickness ?? 0,
    transparent: (m.opacity ?? 1) < 1,
    opacity: m.opacity ?? 1,
    wireframe: !!opts.wireframe,
    polygonOffset: opts.polygonOffset !== false, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });
  if (m.grain && !opts.override && !opts.wireframe) {
    const b = opts.bbox;
    const axis = b ? longestAxis(b.min, b.max) : new THREE.Vector3(1, 0, 0);
    const centre = b ? new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2) : new THREE.Vector3();
    const uniforms = {
      grainColor: { value: new THREE.Color(m.grain.color2) },
      grainScale: { value: m.grain.scale },
      grainContrast: { value: m.grain.contrast },
      grainAxis: { value: axis },
      grainCenter: { value: centre },
      grainSide: { value: b ? thinnestAxis(b.min, b.max, axis) : new THREE.Vector3(0, 1, 0) },
    };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = GRAIN_VERT_DECL + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainPos = position;');
      sh.fragmentShader = GRAIN_FRAG_DECL + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n' + GRAIN_FRAG);
    };
    mat.customProgramCacheKey = () => 'studio-grain';
  }
  return mat;
}

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
/** Soft studio lighting from a room environment (one per renderer: textures don't cross GL contexts). */
export function envFor(r: THREE.WebGLRenderer): THREE.Texture {
  let t = envCache.get(r);
  if (!t) {
    const pm = new THREE.PMREMGenerator(r);
    t = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    envCache.set(r, t);
  }
  return t;
}

export function setupRenderer(r: THREE.WebGLRenderer) {
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  r.toneMappingExposure = 1.0;
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.VSMShadowMap;
}

/** Key light with a soft shadow, a low fill, and a floor that only shows shadows. */
export function addStage(s: THREE.Scene, r: THREE.WebGLRenderer, opts: { shadowOpacity?: number; envIntensity?: number } = {}) {
  s.environment = envFor(r);
  s.environmentIntensity = opts.envIntensity ?? 0.85;
  s.add(new THREE.HemisphereLight('#ffffff', '#cfc9c2', 0.35));
  const key = new THREE.DirectionalLight('#fff7ee', 1.6);
  key.name = 'key';
  key.position.set(2.2, 4, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 9;
  key.shadow.blurSamples = 20;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  s.add(key, key.target);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: opts.shadowOpacity ?? 0.22, color: '#2a2016' }));
  floor.name = 'floor';
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.0005;
  floor.receiveShadow = true;
  floor.raycast = () => {};
  s.add(floor);
  return key;
}

/** Point the key light's shadow camera at a box so shadows stay crisp at any scene size. */
export function fitShadow(key: THREE.DirectionalLight, box: THREE.Box3) {
  const c = box.getCenter(new THREE.Vector3());
  const size = Math.max(0.5, box.getSize(new THREE.Vector3()).length());
  key.target.position.copy(c);
  key.position.copy(c).add(new THREE.Vector3(0.55, 1, 0.65).normalize().multiplyScalar(size * 2));
  const cam = key.shadow.camera as THREE.OrthographicCamera;
  cam.left = -size; cam.right = size; cam.top = size; cam.bottom = -size;
  cam.near = 0.01; cam.far = size * 5;
  cam.updateProjectionMatrix();
  key.target.updateMatrixWorld();
}
