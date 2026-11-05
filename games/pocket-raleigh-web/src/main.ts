// Pocket Raleigh (web): three real blocks of downtown Raleigh around City Plaza and an invented river
// town next door, built by the studio's world module and imported as one scene. Walk with WASD / the
// arrow keys; the camera follows. three.js renders, Rapier simulates. This file is the game's own code.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { addStaticColliders, installHarness, startCharacters, type StudioGame } from '../studio/harness.ts';
import { startEffects } from '../studio/effects.ts';
import { startUI } from '../studio/ui.ts';
import { applyLook } from '../studio/look.ts';
import { startLife } from '../studio/lifeview.ts';

const STUDIO_SCENE = 'assets/studio/scene.glb';
const SKY = '#cddbe5';

async function start(): Promise<StudioGame> {
  await RAPIER.init();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.style.margin = '0';
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, 450, 2400);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 2500);
  camera.position.set(-220, 160, 260);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight('#ffffff', '#b8b2a7', 1.1));
  const sun = new THREE.DirectionalLight('#ffffff', 2.3);
  sun.position.set(0.38 * 300, 0.79 * 300, 0.49 * 300);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -420, right: 420, top: 420, bottom: -420, near: 10, far: 900 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  let studio: THREE.Object3D | null = null;
  let animations: THREE.AnimationClip[] = [];
  const res = await fetch(STUDIO_SCENE, { method: 'HEAD' }).catch(() => null);
  if (res?.ok) {
    const gltf = await new GLTFLoader().loadAsync(STUDIO_SCENE);
    studio = gltf.scene;
    animations = gltf.animations;
    studio.name = 'Studio';
    studio.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(studio);
    addStaticColliders(world, RAPIER, studio);
  }

  const game: StudioGame = {
    renderer, scene, camera, studio, world, RAPIER, animations, paused: false,
    step(dt: number) {
      world.timestep = dt;
      world.step();
    },
  };

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  world.step();   // colliders into the query pipeline, so the player can find the street under its start
  await startCharacters(game, { controls: true });
  await applyLook(game);   // the studio look (look.json): sky, fog, light, grade — or keep the lights above
  await startEffects(game);
  await startUI(game);
  // town life (studio life-bake): a seeded Saturday of folk, a dog walker, cars and a bus
  const life = await startLife(game);
  (window as any).life = life;
  renderer.setAnimationLoop(() => {
    if (game.paused) return;
    game.step(1 / 60);
    game.characters?.update(1 / 60);
    life?.update(1 / 60);
    renderer.render(scene, camera);
  });
  return game;
}

installHarness(start());
