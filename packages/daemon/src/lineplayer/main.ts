// Line preview player (Decision 21 checkpoint): the exported character (glTF: skin, face shapes,
// "pose" + "line:<id>" clips) in three.js, playing each spoken line in sync with its audio.
// ?capture=1 exposes window.__frame(lineId, t) → PNG data URL for frame-by-frame video export.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

interface LineInfo { id: string; text: string; audio: string; duration: number; emotion: string }
interface Config { name: string; glb: string; lines: LineInfo[] }

const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const W = Number(params.get('w') ?? 1280), H = Number(params.get('h') ?? 720);

const cfg: Config = await (await fetch('lines.json')).json();
const stage = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(capture ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#ebe6de');
scene.add(new THREE.HemisphereLight('#fffaf2', '#8a7a68', 1.4));
const key = new THREE.DirectionalLight('#fff4e6', 2.2);
key.position.set(1.2, 2.4, 2.2);
scene.add(key);
const rim = new THREE.DirectionalLight('#dfe8ff', 0.8);
rim.position.set(-2, 1.6, -1.5);
scene.add(rim);

const gltf = await new GLTFLoader().loadAsync(cfg.glb);
scene.add(gltf.scene);
gltf.scene.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
const mixer = new THREE.AnimationMixer(gltf.scene);

// "pose": bones from it always; its face weights only between lines (a line's clip owns the face)
const poseClip = gltf.animations.find((c) => c.name === 'pose');
const poseBones = poseClip ? new THREE.AnimationClip('pose-bones', 0, poseClip.tracks.filter((t) => !t.name.endsWith('.morphTargetInfluences'))) : null;
const poseFace = poseClip ? new THREE.AnimationClip('pose-face', 0, poseClip.tracks.filter((t) => t.name.endsWith('.morphTargetInfluences'))) : null;
if (poseBones) mixer.clipAction(poseBones).play();
const faceAction = poseFace ? mixer.clipAction(poseFace) : null;
faceAction?.play();
const lineActions = new Map<string, THREE.AnimationAction>();
for (const l of cfg.lines) {
  const clip = gltf.animations.find((c) => c.name === `line:${l.id}`);
  if (!clip) continue;
  const a = mixer.clipAction(clip);
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;
  lineActions.set(l.id, a);
}
mixer.update(0);
gltf.scene.updateMatrixWorld(true);

// camera: a close-up on the face, three-quarter, from the Head bone
let head: THREE.Object3D | undefined;
gltf.scene.traverse((o) => { if (o.name === 'Head') head = o; });
const target = new THREE.Vector3();
(head ?? gltf.scene).getWorldPosition(target);
// aim between the head's centre and the face (the face is what a 3/4 close-up is about)
target.y += 0.11;
target.z += 0.06;
const camera = new THREE.PerspectiveCamera(22, W / H, 0.05, 50);
const dir = new THREE.Vector3(0.42, 0.08, 1).normalize();
camera.position.copy(target).addScaledVector(dir, 1.3);
camera.lookAt(target);

function setLine(id: string | null, t: number) {
  for (const [lid, a] of lineActions) {
    if (lid === id) { a.enabled = true; a.play(); a.paused = true; a.time = Math.min(t, a.getClip().duration); a.setEffectiveWeight(1); }
    else { a.enabled = false; }
  }
  if (faceAction) faceAction.enabled = !id;
  mixer.update(0);
}

function render() { renderer.render(scene, camera); }
setLine(null, 0);
render();

if (capture) {
  (window as any).__frame = (id: string, t: number) => { setLine(id, t); render(); return renderer.domElement.toDataURL('image/png'); };
  (window as any).__ready = true;
} else {
  // interactive: one button per line; the clip time follows the audio clock
  const list = document.getElementById('lines')!;
  let playing: { id: string; audio: HTMLAudioElement } | null = null;
  for (const l of cfg.lines) {
    const b = document.createElement('button');
    b.className = 'line';
    b.innerHTML = `<span class="say">“${l.text}”</span><span class="meta">${l.duration.toFixed(1)} s · ${l.emotion}</span>`;
    b.onclick = () => {
      playing?.audio.pause();
      const audio = new Audio(l.audio);
      playing = { id: l.id, audio };
      audio.onended = () => { playing = null; setLine(null, 0); };
      void audio.play();
    };
    list.appendChild(b);
  }
  const tick = () => {
    if (playing) setLine(playing.id, playing.audio.currentTime);
    render();
    requestAnimationFrame(tick);
  };
  tick();
  (window as any).__ready = true;
}
