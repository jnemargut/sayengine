// Motion preview player (Decision 16 review): the exported character (glTF: skin, motion clips) in
// three.js, travelling over a checker floor at each clip's own speed, so sliding feet would show.
// ?capture=1 exposes window.__frame(motionId, t) → PNG data URL (with a caption) for video export.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

interface MotionInfo { id: string; kind: string; label: string; duration: number; loop: boolean; speed: number; show: number }
interface Config { name: string; glb: string; motions: MotionInfo[] }

const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const W = Number(params.get('w') ?? 1280), H = Number(params.get('h') ?? 720);

const cfg: Config = await (await fetch('motions.json')).json();
const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(capture ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e4db');
scene.fog = new THREE.Fog('#e9e4db', 9, 22);
scene.add(new THREE.HemisphereLight('#fffaf2', '#8a7a68', 1.3));
const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
sun.position.set(3, 6, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
scene.add(sun, sun.target);

// a checker floor: half-metre squares, so a sliding foot is easy to see against the lines
const tex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d8d0c3'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#cbc1b2'; g.fillRect(0, 0, 128, 128); g.fillRect(128, 128, 128, 128);
  g.strokeStyle = '#b3a795'; g.lineWidth = 2; g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 60); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2; floor.position.z = 20; floor.receiveShadow = true;
scene.add(floor);

const gltf = await new GLTFLoader().loadAsync(cfg.glb);
const holder = new THREE.Group();
holder.add(gltf.scene);
scene.add(holder);
gltf.scene.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
const mixer = new THREE.AnimationMixer(gltf.scene);
const actions = new Map<string, THREE.AnimationAction>();
for (const m of cfg.motions) {
  const clip = gltf.animations.find((c) => c.name === m.id);
  if (!clip) continue;
  const a = mixer.clipAction(clip);
  a.setLoop(m.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  a.clampWhenFinished = true;
  actions.set(m.id, a);
}

const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 80);
const out = document.createElement('canvas'); out.width = W; out.height = H;
const ctx2d = out.getContext('2d')!;

function setMotion(id: string, t: number) {
  const m = cfg.motions.find((x) => x.id === id)!;
  for (const [mid, a] of actions) {
    if (mid === id) { a.enabled = true; a.play(); a.paused = true; a.time = m.loop ? t % m.duration : Math.min(t, m.duration); a.setEffectiveWeight(1); }
    else a.enabled = false;
  }
  mixer.update(0);
  const z = m.speed * t;
  holder.position.set(0, 0, z);
  // three-quarter side view from the character's left, a little ahead, following along
  const target = new THREE.Vector3(0, 0.95, z + 0.1);
  camera.position.set(3.4, 1.35, z + 2.3);
  camera.lookAt(target);
  sun.position.set(3, 6, z + 2); sun.target.position.set(0, 0, z);
}

function frame(id: string, t: number, caption: string) {
  setMotion(id, t);
  renderer.render(scene, camera);
  ctx2d.drawImage(renderer.domElement, 0, 0, W, H);
  ctx2d.font = '600 26px system-ui, sans-serif';
  ctx2d.fillStyle = 'rgba(28,25,23,0.82)';
  ctx2d.fillText(caption, 32, 52);
  return out.toDataURL('image/png');
}

if (capture) {
  (window as any).__frame = (id: string, t: number) => { const m = cfg.motions.find((x) => x.id === id)!; return frame(id, t, m.label); };
  (window as any).__ready = true;
} else {
  const list = document.getElementById('motions')!;
  let cur = cfg.motions[0]?.id, start = performance.now();
  for (const m of cfg.motions) {
    const b = document.createElement('button');
    b.className = 'line';
    b.innerHTML = `<span class="say">${m.label}</span><span class="meta">${m.duration.toFixed(2)} s${m.loop ? ' loop' : ''}${m.speed ? ` · ${m.speed.toFixed(2)} m/s` : ''}</span>`;
    b.onclick = () => { cur = m.id; start = performance.now(); };
    list.appendChild(b);
  }
  const tick = () => {
    if (cur) { setMotion(cur, ((performance.now() - start) / 1000) % 12); renderer.render(scene, camera); }
    requestAnimationFrame(tick);
  };
  tick();
  (window as any).__ready = true;
}
