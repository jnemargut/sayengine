// Creature preview player (Decisions 52–54 review): the exported creature (glTF: a node per bone, a
// clip per motion) in three.js over its own ground. Baked clips travel at their speed over half-metre
// squares so a sliding foot or a skidding tyre shows; live segments run the TS runtime (legs that step
// when out of reach, wheels on springs) steered over uneven ground. Each frame carries the check
// timeline: one row per check, red where it fails, with a playhead.
// ?capture=1 exposes window.__frame(segmentId, t) → PNG data URL for video export.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildCreature, bakeCreature, terrainHeight, type CreatureDef, type CreatureMotion, type TerrainSpec } from '../../../core/src/rigparts.ts';
import { CreatureRuntime } from '../../../core/src/creatureruntime.ts';

interface CheckRow { name: string; pass: boolean; frames: Array<[number, number]>; worst: number; limit: number; unit: string }
interface Segment {
  id: string; label: string; show: number;
  motion?: string; duration?: number; frames?: number; loop?: boolean; speed?: number; dir?: [number, number, number]; travelScale?: number;
  cam?: Array<[number, number, number]>; fps?: number; keys?: Array<{ t: number; label: string }>;
  live?: { input: { speed: number; turn?: number; strafe?: [number, number, number]; turnWave?: number }; layer?: string; terrain?: TerrainSpec };
  checks: CheckRow[];
}
interface Config { name: string; glb: string; def: CreatureDef; motions: Record<string, CreatureMotion>; terrain?: TerrainSpec; segments: Segment[]; view?: { dist?: number; height?: number; side?: number } }

const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const W = Number(params.get('w') ?? 1280), H = Number(params.get('h') ?? 720);

const cfg: Config = await (await fetch('creature.json')).json();
const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
const out = document.createElement('canvas'); out.width = W; out.height = H;
const ctx2d = out.getContext('2d')!;
stage.appendChild(out);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e4db');
scene.fog = new THREE.Fog('#e9e4db', 14, 40);
scene.add(new THREE.HemisphereLight('#fffaf2', '#8a7a68', 1.3));
const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);

// the creature
const gltf = await new GLTFLoader().loadAsync(cfg.glb);
const holder = new THREE.Group();
holder.add(gltf.scene);
scene.add(holder);
gltf.scene.getObjectByName('ground')?.removeFromParent();
gltf.scene.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
const box = new THREE.Box3().setFromObject(gltf.scene);
const size = box.getSize(new THREE.Vector3());
const reach = Math.max(size.x, size.y, size.z);
const mixer = new THREE.AnimationMixer(gltf.scene);
const actions = new Map<string, THREE.AnimationAction>();
for (const clip of gltf.animations) { const a = mixer.clipAction(clip); a.setLoop(THREE.LoopRepeat, Infinity); actions.set(clip.name, a); }

// shader sway (grass, flags): nodes whose extras carry `sway` bend in the vertex shader, the same
// formula the engines get (Godot: sway.gdshader beside the GLB)
const swayTime = { value: 0 };
gltf.scene.traverse((o: any) => {
  const sw = o.userData?.sway;
  if (!sw) return;
  o.traverse((m: any) => {
    if (!m.isMesh) return;
    m.material = m.material.clone();
    m.material.side = THREE.DoubleSide;
    m.material.onBeforeCompile = (sh: any) => {
      sh.uniforms.uSwayTime = swayTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
uniform float uSwayTime;`).replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec2 wind = vec2(${sw.wind[0].toFixed(4)}, ${sw.wind[2].toFixed(4)});
  float k = clamp(position.y / (${sw.height.toFixed(4)} * 1.3), 0.0, 1.0);
  float ph = ${sw.gustK.toFixed(4)} * dot(position.xz, wind);
  float deg = ${sw.strength.toFixed(3)} * (0.6 + ${sw.energy.toFixed(2)} * 0.8) * (0.55 + 0.45 * sin(6.2831853 * ${sw.per.toFixed(4)} * uSwayTime - ph)) + 3.0 * sin(6.2831853 * ${sw.per.toFixed(4)} * 3.0 * uSwayTime + position.x * 7.0 + position.z * 5.0);
  float a = radians(deg) * k;
  float h = position.y;
  transformed.xz += wind * sin(a) * h;
  transformed.y = h * cos(a);
}`);
    };
  });
});

// bones by name (three sanitizes node names the same way for its tracks), with their rest offsets
const c = buildCreature(cfg.def);
const boneObj = c.bones.map((b) => gltf.scene.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(b.name))!);
const restPos = boneObj.map((o) => o.position.clone());

// grounds: a checker of half-metre squares draped over the terrain (one per terrain in use)
const checker = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#d8d0c3'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#cbc1b2'; g.fillRect(0, 0, 128, 128); g.fillRect(128, 128, 128, 128);
  g.strokeStyle = '#b3a795'; g.lineWidth = 2; g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
})();
const grounds = new Map<string, THREE.Mesh>();
function groundFor(t: TerrainSpec | undefined, centre: [number, number], extent: number): THREE.Mesh {
  const key = JSON.stringify([t ?? null, centre, extent]);
  if (grounds.has(key)) return grounds.get(key)!;
  const nx = t ? Math.min(500, Math.max(2, Math.round((extent * 2) / 0.08))) : 1;
  const geo = new THREE.PlaneGeometry(extent * 2, extent * 2, nx, nx);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position as THREE.BufferAttribute, uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + centre[0], z = p.getZ(i) + centre[1];
    p.setXYZ(i, x, terrainHeight(t, x, z), z);
    uv.setXY(i, x, z);                         // 1 uv = 1 m: the texture is a 2×2 checker of half-metre squares
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: checker, roughness: 0.95 }));
  m.receiveShadow = true;
  m.visible = false;
  scene.add(m);
  grounds.set(key, m);
  return m;
}

const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 120);
const live = new Map<string, { rt: CreatureRuntime; t: number }>();
const liveDir = new THREE.Vector3(0, 0, 1);
function runtimeFor(s: Segment): CreatureRuntime {
  const ground = (x: number, z: number) => terrainHeight(s.live!.terrain, x, z);
  const layer = s.live!.layer && cfg.motions[s.live!.layer] ? bakeCreature(c, s.live!.layer, cfg.motions[s.live!.layer]) : undefined;
  return new CreatureRuntime(c, { ground, layer });
}

function place(s: Segment, t: number): THREE.Vector3 {
  swayTime.value = t;
  for (const g of grounds.values()) g.visible = false;
  if (s.live) {
    // live: step the runtime from 0 to t at 120 Hz (deterministic for capture), then pose the nodes
    let st = live.get(s.id);
    if (!st || st.t > t) { st = { rt: runtimeFor(s), t: 0 }; live.set(s.id, st); }
    let pose: ReturnType<CreatureRuntime['step']> | null = null;
    const dt = 1 / 120;
    const inp = s.live.input;
    while (st.t < t || !pose) {
      const turn = (inp.turn ?? 0) * (inp.turnWave ? Math.sin((2 * Math.PI * st.t) / inp.turnWave) : 1);
      pose = st.rt.step(dt, { speed: inp.speed, turn, strafe: inp.strafe });
      st.t += dt;
    }
    for (const a of actions.values()) a.enabled = false;
    boneObj.forEach((o, i) => { o.quaternion.set(...pose!.rot[i]); o.position.copy(restPos[i]).add(new THREE.Vector3(...pose!.off[i])); });
    holder.position.set(pose.pos[0], 0, pose.pos[2]);
    holder.rotation.set(0, pose.yaw, 0);
    const sd = inp.strafe ?? [0, 0, 1];
    liveDir.set(sd[0], 0, sd[2]).applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw).normalize();
    groundFor(s.live.terrain, [0, 0], 16).visible = true;
    return holder.position.clone();
  }
  for (const [id, a] of actions) {
    if (id === s.motion) { a.enabled = true; a.play(); a.paused = true; a.time = s.loop === false ? Math.min(t, s.duration! - 1e-4) : t % s.duration!; a.setEffectiveWeight(1); }
    else a.enabled = false;
  }
  mixer.update(0);
  const d = s.dir ?? [0, 0, 1];
  const k = (s.speed ?? 0) * (s.travelScale ?? 1) * t;
  holder.position.set(d[0] * k, 0, d[2] * k);
  holder.rotation.set(0, 0, 0);
  const travel = (s.speed ?? 0) * (s.travelScale ?? 1) * s.show;
  const cam = camAt(s, t);
  const span = cam ? Math.max(...s.cam!.map((p) => Math.hypot(p[0], p[2]))) : 0;
  groundFor(cfg.terrain, [d[0] * travel / 2, d[2] * travel / 2], travel / 2 + reach * 3 + 4 + span).visible = true;
  return cam ? holder.position.clone().add(new THREE.Vector3(cam[0], 0, cam[2])) : holder.position.clone();
}
// the smoothed body position at t (in place, before travel)
function camAt(s: Segment, t: number): [number, number, number] | null {
  if (!s.cam?.length || s.live) return null;
  const F = s.cam.length - 1, ft = s.loop === false ? Math.min(F, t * (s.fps ?? 30)) : ((t * (s.fps ?? 30)) % F);
  const f0 = Math.floor(ft), f1 = Math.min(F, f0 + 1), u = ft - f0;
  return [0, 1, 2].map((k) => s.cam![f0][k] + (s.cam![f1][k] - s.cam![f0][k]) * u) as [number, number, number];
}

function frame(s: Segment, t: number) {
  const at = place(s, t);
  // a three-quarter view from the side the creature passes, following along
  const v = cfg.view ?? {};
  const flat = size.y < reach * 0.25;                // snakes, lizards: closer, from higher up
  const dist = v.dist ?? (flat ? Math.max(1.2, reach * 1.45) : Math.max(2.4, reach * 2.6));
  const cam = camAt(s, t), cam0 = s.cam?.[0];
  const tgt = new THREE.Vector3(at.x, (v.height ?? size.y * 0.42) + (cam && cam0 ? cam[1] - cam0[1] : 0) + (cam && s.motion && cfg.motions[s.motion] && ['fly', 'glide', 'hover'].includes(cfg.motions[s.motion].kind) ? cam[1] - size.y * 0.5 : 0), at.z);
  const side = v.side ?? 1;
  const dir = s.live ? liveDir.clone() : new THREE.Vector3(...(s.dir ?? [0, 0, 1]));
  const across = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize().multiplyScalar(side);
  camera.position.copy(tgt).addScaledVector(across, -dist * 0.82).addScaledVector(dir, dist * 0.55).add(new THREE.Vector3(0, dist * (flat ? 0.6 : 0.32), 0));
  camera.lookAt(tgt);
  sun.position.set(at.x + 3, 7, at.z + 2); sun.target.position.copy(at);
  Object.assign(sun.shadow.camera, { left: -reach * 2, right: reach * 2, top: reach * 2, bottom: -reach * 2, near: 0.5, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  ctx2d.drawImage(renderer.domElement, 0, 0, W, H);
  ctx2d.font = '600 26px system-ui, sans-serif';
  ctx2d.fillStyle = 'rgba(28,25,23,0.85)';
  ctx2d.fillText(s.label, 32, 52);
  timeline(s, t);
  return out;
}

// the check timeline: one row per check across the clip's frames; red spans fail; a playhead
function timeline(s: Segment, t: number) {
  if (!s.checks.length) return;
  const rowH = 15, pad = 10, labelW = 230, barW = 300;
  const x0 = W - labelW - barW - pad * 3, y0 = H - pad * 2 - rowH * s.checks.length - 18;
  ctx2d.fillStyle = 'rgba(255,253,249,0.82)';
  ctx2d.fillRect(x0, y0, labelW + barW + pad * 2, rowH * s.checks.length + pad * 2 + 18);
  ctx2d.font = '600 12px system-ui, sans-serif';
  ctx2d.fillStyle = '#1c1917';
  const bad = s.checks.filter((k) => !k.pass).length;
  ctx2d.fillText(bad ? `checks: ${bad} failing (red = frames where it breaks)` : `checks: all ${s.checks.length} pass`, x0 + pad, y0 + pad + 8);
  const F = Math.max(1, s.frames ?? 1) + 1;          // frames 0..frames (the last closes the loop)
  s.checks.forEach((k, i) => {
    const y = y0 + pad + 18 + i * rowH;
    ctx2d.font = '12px system-ui, sans-serif';
    ctx2d.fillStyle = k.pass ? '#3f3a35' : '#a3241a';
    ctx2d.fillText(k.name.length > 34 ? k.name.slice(0, 33) + '…' : k.name, x0 + pad, y + 10);
    const bx = x0 + pad + labelW;
    ctx2d.fillStyle = '#7aa46a';
    ctx2d.fillRect(bx, y + 2, barW, rowH - 5);
    ctx2d.fillStyle = '#c8392b';
    for (const [a, b] of k.frames) ctx2d.fillRect(bx + (a / F) * barW, y + 2, Math.max(2, ((b - a + 1) / F) * barW), rowH - 5);
  });
  if (s.duration && !s.live) {
    const px = x0 + pad + labelW + ((s.loop === false ? Math.min(t, s.duration) : t % s.duration) / s.duration) * barW;
    ctx2d.fillStyle = '#1c1917';
    ctx2d.fillRect(px - 1, y0 + pad + 16, 2, rowH * s.checks.length + 2);
  }
}

if (capture) {
  (window as any).__frame = (id: string, t: number) => frame(cfg.segments.find((x) => x.id === id)!, t).toDataURL('image/png');
  (window as any).__ready = true;
} else {
  const list = document.getElementById('motions')!;
  let cur = cfg.segments[0], start = performance.now();
  for (const s of cfg.segments) {
    const b = document.createElement('button');
    b.className = 'line';
    const bad = s.checks.filter((k) => !k.pass).length;
    b.innerHTML = `<span class="say">${s.label}</span><span class="meta">${s.live ? 'live runtime' : `${s.duration!.toFixed(2)} s loop`}${s.checks.length ? ` · ${bad ? `${bad} check(s) fail` : 'checks pass'}` : ''}</span>`;
    b.onclick = () => { cur = s; start = performance.now(); live.delete(s.id); };
    list.appendChild(b);
  }
  const tick = () => { frame(cur, ((performance.now() - start) / 1000) % 60); requestAnimationFrame(tick); };
  tick();
  (window as any).__ready = true;
}
