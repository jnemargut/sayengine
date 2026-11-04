// Cast lineup (Decision 47 review): every character in the scene standing side by side, idling, with
// its name and body plan underneath, so you can see at a glance whether the cast reads as different
// people. ?capture=1 exposes window.__frame(t, yawDeg) → PNG data URL (a turntable when yaw changes).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

interface Member { id: string; name: string; label: string; glb: string; height: number; idle: string | null; headH?: number; headY?: number; headZ?: number }
interface Config { title: string; cast: Member[] }

const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const W = Number(params.get('w') ?? 1600), H = Number(params.get('h') ?? 800);
const cfg: Config = await (await fetch('cast.json')).json();

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(capture ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.getElementById('stage')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#ece6dc');
scene.add(new THREE.HemisphereLight('#fffaf2', '#8a7a68', 1.25));
const sun = new THREE.DirectionalLight('#fff4e6', 2.3);
sun.position.set(2.5, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: '#d9d1c4', roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
scene.add(floor);

const loader = new GLTFLoader();
const members: Array<{ m: Member; root: THREE.Object3D; mixer: THREE.AnimationMixer; action?: THREE.AnimationAction; x: number; width: number }> = [];
let x = 0;
for (const m of cfg.cast) {
  const g = await loader.loadAsync(m.glb);
  g.scene.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
  const box = new THREE.Box3().setFromObject(g.scene);
  const width = Math.max(0.5, Math.min(box.max.x - box.min.x, 1.2)) + 0.35;
  const holder = new THREE.Group(); holder.add(g.scene); scene.add(holder);
  const mixer = new THREE.AnimationMixer(g.scene);
  const clip = m.idle ? g.animations.find((c) => c.name === m.idle) : undefined;
  const action = clip ? mixer.clipAction(clip) : undefined;
  if (action) { action.play(); action.paused = true; }
  members.push({ m, root: holder, mixer, action, x: 0, width });
  x += width;
}
// lay them out left to right, centred
let at = -x / 2;
for (const mb of members) { mb.x = at + mb.width / 2; at += mb.width; mb.root.position.x = mb.x; }
const tallest = Math.max(...cfg.cast.map((m) => m.height));
const camera = new THREE.PerspectiveCamera(24, W / H, 0.05, 80);
// frame the whole line: fit its width (horizontal field of view) and the tallest character's height
const hfov = 2 * Math.atan(Math.tan((24 * Math.PI) / 360) * (W / H));
const dist = Math.max((x * 0.56) / Math.tan(hfov / 2), (tallest * 0.72) / Math.tan((24 * Math.PI) / 360));
camera.position.set(0, tallest * 0.55, dist);
camera.lookAt(0, tallest * 0.43, 0);
Object.assign(sun.shadow.camera, { left: -x, right: x, top: tallest * 2, bottom: -2, near: 0.5, far: 30 });
sun.shadow.camera.updateProjectionMatrix();

const out = document.createElement('canvas'); out.width = W; out.height = H;
const ctx2d = out.getContext('2d')!;
function frame(t: number, yaw: number) {
  for (const mb of members) {
    if (mb.action) { mb.action.time = t % mb.action.getClip().duration; mb.mixer.update(0); }
    mb.root.rotation.y = (yaw * Math.PI) / 180;
  }
  renderer.render(scene, camera);
  ctx2d.drawImage(renderer.domElement, 0, 0, W, H);
  ctx2d.textAlign = 'center';
  for (const mb of members) {
    const p = new THREE.Vector3(mb.x, 0, 0).project(camera);
    const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H + 28;
    ctx2d.font = '600 18px system-ui, sans-serif'; ctx2d.fillStyle = 'rgba(28,25,23,0.9)'; ctx2d.fillText(mb.m.name, sx, sy);
    ctx2d.font = '13px system-ui, sans-serif'; ctx2d.fillStyle = 'rgba(28,25,23,0.65)';
    mb.m.label.split(' · ').forEach((ln, i) => ctx2d.fillText(ln, sx, sy + 19 + i * 16));
  }
  ctx2d.textAlign = 'left';
  ctx2d.font = '600 24px system-ui, sans-serif'; ctx2d.fillStyle = 'rgba(28,25,23,0.82)'; ctx2d.fillText(cfg.title, 28, 44);
  return out.toDataURL('image/png');
}
(window as any).__frame = frame;
/** A sheet of head-and-shoulders close-ups, one per character, three-quarter view, all idling at time t. */
(window as any).__faces = (t: number) => {
  const cols = Math.min(members.length, 4), rows = Math.ceil(members.length / cols);
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  const cam = new THREE.PerspectiveCamera(22, cw / ch, 0.02, 40);
  ctx2d.fillStyle = '#ece6dc'; ctx2d.fillRect(0, 0, W, H);
  renderer.setScissorTest(true);
  members.forEach((mb, i) => {
    if (mb.action) { mb.action.time = t % mb.action.getClip().duration; mb.mixer.update(0); }
    mb.root.rotation.y = 0;
    const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
    const hh = mb.m.headH ?? mb.m.height * 0.17, hy = (mb.m.headY ?? mb.m.height - hh) + hh * 0.45;
    const d = (hh * 1.5) / Math.tan((22 * Math.PI) / 360);
    const hz = mb.m.headZ ?? 0;   // a four-legged body's head is well forward of its feet
    cam.position.set(mb.x + d * 0.42, hy + hh * 0.12, hz + d * 0.9);
    cam.lookAt(mb.x, hy - hh * 0.05, hz);
    renderer.setViewport(cx, H - cy - ch, cw, ch);
    renderer.setScissor(cx, H - cy - ch, cw, ch);
    renderer.render(scene, cam);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  ctx2d.drawImage(renderer.domElement, 0, 0, W, H);
  ctx2d.font = '600 18px system-ui, sans-serif'; ctx2d.fillStyle = 'rgba(28,25,23,0.85)';
  for (let i = members.length; i < cols * rows; i++) { ctx2d.fillStyle = '#ece6dc'; ctx2d.fillRect((i % cols) * cw, Math.floor(i / cols) * ch, cw, ch); }
  ctx2d.fillStyle = 'rgba(28,25,23,0.85)';
  members.forEach((mb, i) => ctx2d.fillText(`${mb.m.name}`, (i % cols) * cw + 16, Math.floor(i / cols) * ch + 30));
  return out.toDataURL('image/png');
};
if (!capture) {
  const start = performance.now();
  const tick = () => { const t = (performance.now() - start) / 1000; frame(t, 25 + 20 * Math.sin(t * 0.4)); requestAnimationFrame(tick); };
  tick();
}
(window as any).__ready = true;
