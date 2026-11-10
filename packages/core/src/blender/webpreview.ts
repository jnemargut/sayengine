// three.js stills of a rigged GLB (the way a web game will see it): a tiny local page loads the GLB
// with three's GLTFLoader, poses each clip at a time, and headless Chrome saves the frames.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');

export interface WebShot { name: string; clip?: string; time?: number; camera: [number, number, number]; target: [number, number, number]; fov?: number; morphs?: Record<string, number> }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#6b6b70}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script></head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const W = 960, H = 720;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0; renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x6b6b70);
scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x5a5048, 1.3));
const key = new THREE.DirectionalLight(0xfff2e0, 2.6); key.position.set(1.4, 2.2, 1.8); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -1.5, right: 1.5, top: 2, bottom: -0.5, near: 0.1, far: 8 });
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 1.2); rim.position.set(-1.2, 1.6, -1.8); scene.add(rim);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshStandardMaterial({ color: 0x4a4440, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
const camera = new THREE.PerspectiveCamera(30, W / H, 0.01, 50);
window.shoot = async (url, shot) => {
  if (!window.model) {
    const g = await new GLTFLoader().loadAsync(url);
    window.model = g; scene.add(g.scene);
    g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    window.mixer = new THREE.AnimationMixer(g.scene);
  }
  const g = window.model;
  window.mixer.stopAllAction();
  if (shot.clip) {
    const clip = g.animations.find((a) => a.name === shot.clip);
    if (clip) { const a = window.mixer.clipAction(clip); a.play(); window.mixer.setTime(shot.time || 0); }
  } else {
    g.scene.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  }
  g.scene.traverse((o) => { if (o.morphTargetDictionary) { for (const [k, i] of Object.entries(o.morphTargetDictionary)) o.morphTargetInfluences[i] = (shot.morphs || {})[k] || 0; } });
  camera.fov = shot.fov || 30; camera.position.set(...shot.camera); camera.lookAt(...shot.target); camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  return true;
};
window.ready = true;
</script></body></html>`;

/** Render each shot of a GLB with three.js in headless Chrome; returns the PNG paths. */
export async function webStills(glbFile: string, shots: WebShot[], outDir: string): Promise<string[]> {
  const threeDir = path.resolve(path.dirname(createRequire(import.meta.url).resolve('three')), '..');
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file: string | null = null;
    if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    if (u === '/model.glb') file = glbFile;
    else if (u.startsWith('/three/')) file = path.join(threeDir, u.slice(7));
    if (!file || !fs.existsSync(file) || (u.startsWith('/three/') && !path.resolve(file).startsWith(threeDir))) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  const pw: any = await import('playwright-core');
  const { findChrome } = await import(path.join(ROOT, 'packages/game/src/chrome.ts'));
  const browser = await pw.chromium.launch({ executablePath: findChrome() ?? undefined, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const out: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction('window.ready === true');
    fs.mkdirSync(outDir, { recursive: true });
    for (const s of shots) {
      await page.evaluate(([u, shot]: any) => (window as any).shoot(u, shot), [`http://127.0.0.1:${port}/model.glb`, s]);
      const f = path.join(outDir, `${s.name}.png`);
      await page.locator('canvas').screenshot({ path: f });
      out.push(f);
    }
  } finally {
    await browser.close();
    server.close();
  }
  return out;
}
