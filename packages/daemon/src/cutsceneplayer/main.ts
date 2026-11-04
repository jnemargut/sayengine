// Cutscene preview page: the studio scene (GLB) + cutscene.json + line audio, played by the same
// player web games use. ?capture=1 exposes window.__frame(t) → PNG data URL for frame-by-frame video.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CutscenePlayer, type CutsceneTimeline } from '../../../game/templates/web/studio/cutscene.ts';

const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const W = Number(params.get('w') ?? 1280), H = Number(params.get('h') ?? 720);
const tl: CutsceneTimeline = await (await fetch('cutscene.json')).json();
const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(capture ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9cdbd');
scene.fog = new THREE.Fog('#d9cdbd', 12, 30);
scene.add(new THREE.HemisphereLight('#fff4e4', '#6e5a48', 1.25));
const sun = new THREE.DirectionalLight('#ffe8cc', 2.4);
sun.position.set(4, 7, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 25 });
sun.shadow.bias = -0.0004;
scene.add(sun);
// the forge's glow
const glow = new THREE.PointLight('#ff8a3c', 4, 6, 1.6);
glow.position.set(0, 1.0, 0);
scene.add(glow);
const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.MeshStandardMaterial({ color: '#a89580', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.002; ground.receiveShadow = true;
scene.add(ground);

const gltf = await new GLTFLoader().loadAsync('scene.glb');
scene.add(gltf.scene);
gltf.scene.traverse((o: any) => {
  if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; }
  if (/forge/i.test(o.name) && o.isMesh) { const b = new THREE.Box3().setFromObject(o); b.getCenter(glow.position); glow.position.y = b.max.y + 0.15; }
});
const camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 80);
const player = new CutscenePlayer(gltf.scene, gltf.animations, tl, camera, 'audio/');
player.setTime(0);
const render = () => renderer.render(scene, camera);
render();

if (capture) {
  (window as any).__frame = (t: number) => { player.setTime(t); render(); return renderer.domElement.toDataURL('image/png'); };
  (window as any).__ready = true;
} else {
  const btn = document.getElementById('play') as HTMLButtonElement;
  const cap = document.getElementById('caption')!;
  btn.onclick = () => { player.play(0); };
  let prev = performance.now();
  const tick = (now: number) => {
    player.update((now - prev) / 1000); prev = now;
    const q = tl.cues.find((c) => c.kind === 'line' && player.time >= c.t && player.time < c.end);
    cap.textContent = q ? `${q.name}: “${q.text}”` : '';
    render();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  (window as any).__ready = true;
}
