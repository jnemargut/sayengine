// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// The play-test harness for web games: `studio game run|screenshot|walk-to|test` load the page in
// headless Chrome and call window.__studio.run(cmd). Same commands and JSON as the Godot runner.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type RAPIER_NS from '@dimforge/rapier3d-compat';

type Rapier = typeof RAPIER_NS;
export interface StudioGame {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** the imported studio scene (assets/studio/scene.glb), or null before the first import */
  studio: THREE.Object3D | null;
  world: RAPIER_NS.World;
  RAPIER: Rapier;
  /** advance the game one fixed step (physics + your logic). The harness calls it while paused. */
  step(dt: number): void;
  /** the harness sets this while it drives the game; your render loop should skip work when true */
  paused: boolean;
  /** the studio scene's clips (gltf.animations) — characters play their idle from these */
  animations?: THREE.AnimationClip[];
  /** studio characters: idles, the player model (set by startCharacters) */
  characters?: StudioCharacters;
}

// ── studio characters: NPCs play idle; the player (studio game import --player) walks ──
interface ClipInfo { motion?: string; loop?: boolean; speed?: number; duration?: number; travel?: V3; then?: string; phase?: number }
interface CharInfo { name: string; prefix: string; height: number; clips: Record<string, ClipInfo>; play: string | null }
interface Manifest { player: (CharInfo & { start: V3; rotation: number; walkSpeed: number }) | null; characters: CharInfo[] }
export interface StudioCharacters {
  manifest: Manifest;
  mixers: THREE.AnimationMixer[];
  avatar: { scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null;
  keyboard: Player | null;
  update(dt: number): void;
}

/** Start the studio's characters: idles for everyone in the scene, the player model ready to spawn.
 *  With controls, the player stands where it stood in the studio and arrow keys / WASD walk it. */
export async function startCharacters(g: StudioGame, opts: { controls?: boolean } = {}): Promise<StudioCharacters> {
  const empty: Manifest = { player: null, characters: [] };
  const res = await fetch('assets/studio/characters.json').catch(() => null);
  const manifest: Manifest = res?.ok ? await res.json().catch(() => empty) : empty;
  const mixers: THREE.AnimationMixer[] = [];
  manifest.characters.forEach((c, i) => {
    if (!g.studio || !c.play) return;
    const clip = g.animations?.find((a) => a.name === c.prefix + c.play);
    if (!clip) return;
    // characters share bone names (Hips, Head…): each one's mesh and skeleton go under their own
    // group so its mixer can only reach its own bones
    const node = g.studio.getObjectByName(c.name);
    const skinned: any = node && ((node as any).isSkinnedMesh ? node : node.getObjectByProperty('isSkinnedMesh', true));
    let root: THREE.Object3D = g.studio;
    if (node && skinned) {
      const group = new THREE.Group();
      group.name = `${c.name} (character)`;
      g.studio.add(group);
      group.attach(node);
      group.attach(skinned.skeleton.bones[0]);
      root = group;
    }
    const m = new THREE.AnimationMixer(root);
    const a = m.clipAction(clip);
    a.play();
    a.time = (i * 1.37) % Math.max(0.1, clip.duration);
    mixers.push(m);
  });
  let avatar: StudioCharacters['avatar'] = null;
  if (manifest.player) {
    const gltf = await new GLTFLoader().loadAsync('assets/studio/player.glb').catch(() => null);
    if (gltf) avatar = { scene: gltf.scene, animations: gltf.animations };
  }
  const sc: StudioCharacters = {
    manifest, mixers, avatar, keyboard: null,
    update(dt: number) { for (const m of mixers) m.update(dt); },
  };
  g.characters = sc;
  if (opts.controls && avatar && manifest.player) {
    const p = new Player(g, manifest.player.start, ((manifest.player.rotation ?? 0) * Math.PI) / 180);
    sc.keyboard = p;
    const keys = new Set<string>();
    addEventListener('keydown', (e) => keys.add(e.code));
    addEventListener('keyup', (e) => keys.delete(e.code));
    const base = sc.update;
    sc.update = (dt: number) => {
      base(dt);
      if (sc.keyboard !== p) return;
      const x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      const z = (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0);
      const l = Math.hypot(x, z) || 1;
      p.move([x / l, z / l], x || z ? p.walkSpeed : 0, dt);
      p.sync(dt);
      const f = p.feet();
      g.camera.position.lerp(new THREE.Vector3(f[0], f[1] + 2.6, f[2] + 4.2), Math.min(1, dt * 3));
      g.camera.lookAt(f[0], f[1] + 1, f[2]);
    };
  }
  return sc;
}

type V3 = [number, number, number];
interface Box { min: V3; max: V3 }
const tests: Array<{ name: string; run: (g: StudioGame) => { pass: boolean; detail?: string } | Promise<{ pass: boolean; detail?: string }> }> = [];

/** Register a game-specific test for `studio game test` (runs after the built-in assertions). */
export function registerTest(name: string, run: (g: StudioGame) => { pass: boolean; detail?: string } | Promise<{ pass: boolean; detail?: string }>) { tests.push({ name, run }); }

/** Fixed trimesh colliders for every mesh under `root` (world space), so players collide with studio objects. */
export function addStaticColliders(world: RAPIER_NS.World, R: Rapier, root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  let n = 0;
  const onBone = (o: THREE.Object3D) => { for (let p = o.parent; p; p = p.parent) if ((p as any).isBone) return true; return false; };
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    if (o.isSkinnedMesh) {
      // a standing character blocks the way like a person: a capsule at its feet, its height
      const feet = new THREE.Vector3();
      o.skeleton.bones[0].getWorldPosition(feet);
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox!, h = Math.max(0.5, bb.max.y - bb.min.y), r = Math.min(0.32, Math.max(0.15, Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2));
      world.createCollider(R.ColliderDesc.capsule(Math.max(0.01, h / 2 - r), r).setTranslation(feet.x, h / 2, feet.z));
      n++;
      return;
    }
    if (onBone(o)) return;
    const g: THREE.BufferGeometry = o.geometry;
    const pos = g.getAttribute('position');
    const verts = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); verts.set([v.x, v.y, v.z], i * 3); }
    const idx = g.index ? new Uint32Array(g.index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    world.createCollider(R.ColliderDesc.trimesh(verts, idx));
    n++;
  });
  return n;
}

const r3 = (v: THREE.Vector3): V3 => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
const norm = (s: string) => s.toLowerCase().replace(/[_-]/g, ' ').trim();

export function installHarness(gamePromise: Promise<StudioGame>) {
  const ready = gamePromise.then(async (g) => {
    (window as any).__game = g;
    if (!g.characters) await startCharacters(g);
    return g;
  });
  (window as any).__studio = {
    ready: ready.then(() => true),
    async run(cmd: any) {
      const g = await ready;
      g.paused = true;
      // the game's own keyboard player steps aside: play-tests spawn their own
      if (g.characters?.keyboard) { g.characters.keyboard.remove(); g.characters.keyboard = null; }
      try {
        const fn = (commands as any)[cmd.cmd];
        if (!fn) return { ok: false, error: `unknown command ${cmd.cmd}` };
        return await fn(g, cmd);
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      } finally {
        g.paused = false;
      }
    },
  };
}

function objects(g: StudioGame): THREE.Object3D[] {
  if (!g.studio) return [];
  // GLTFLoader wraps the glTF scene; studio objects are its direct children (one node per object)
  return g.studio.children.length === 1 && !(g.studio.children[0] as any).isMesh && g.studio.children[0].children.length > 1
    ? g.studio.children[0].children : g.studio.children;
}

function find(g: StudioGame, name: string): THREE.Object3D | null {
  const list = objects(g);
  return list.find((o) => norm(o.name) === norm(name)) ?? list.find((o) => norm(o.name).includes(norm(name))) ?? g.scene.getObjectByName(name) ?? null;
}

function boxOf(o: THREE.Object3D | null): Box {
  const b = new THREE.Box3();
  if (o) b.setFromObject(o);
  if (b.isEmpty()) return { min: [-1, 0, -1], max: [1, 2, 1] };
  return { min: r3(b.min), max: r3(b.max) };
}

function triangles(o: THREE.Object3D | null): number {
  let t = 0;
  o?.traverse((m: any) => { if (m.isMesh) t += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3; });
  return t;
}

function materials(o: THREE.Object3D | null) {
  const seen = new Map<string, any>();
  o?.traverse((m: any) => {
    if (!m.isMesh) return;
    for (const mat of [m.material].flat()) {
      if (seen.has(mat.uuid)) continue;
      seen.set(mat.uuid, { name: mat.name, type: mat.type, color: mat.color ? '#' + mat.color.getHexString() : undefined, roughness: mat.roughness, metalness: mat.metalness, clearcoat: mat.clearcoat || undefined, transmission: mat.transmission || undefined, textures: !!mat.map, transparent: mat.transparent || undefined });
    }
  });
  return [...seen.values()];
}

function xzDist(p: V3, b: Box) {
  const dx = Math.max(b.min[0] - p[0], 0, p[0] - b.max[0]);
  const dz = Math.max(b.min[2] - p[2], 0, p[2] - b.max[2]);
  return Math.hypot(dx, dz);
}

const DIRS: Record<string, V3> = { front: [0, 0.18, 1], back: [0, 0.18, -1], side: [1, 0.18, 0], top: [0.001, 1, 0.001], low: [0.9, 0.12, 1.1], iso: [1, 0.75, 1.15] };

// ── play-test player: a kinematic capsule with Rapier's character controller ──
class Player {
  body: RAPIER_NS.RigidBody; collider: RAPIER_NS.Collider; ctrl: RAPIER_NS.KinematicCharacterController; mesh: THREE.Object3D;
  vy = 0; radius = 0.3; half = 0.55; // capsule: 2*0.55 + 2*0.3 = 1.7 m
  walkSpeed = 1.4; clipSpeed = 1.4; heading = 0; hs = 0;
  mixer: THREE.AnimationMixer | null = null; walk: THREE.AnimationAction | null = null; idle: THREE.AnimationAction | null = null;
  // walk ↔ idle with real steps: "start" steps off into the walk, "stop" brings the feet together; the
  // body waits while one plays (the clip carries the hips) and jumps by the clip's travel when it ends
  start: THREE.AnimationAction | null = null; stop: THREE.AnimationAction | null = null;
  clips: Record<string, ClipInfo> = {}; state: 'idle' | 'starting' | 'walk' | 'stopping' = 'idle'; stateT = 0; want = false;
  name = 'capsule';
  constructor(private g: StudioGame, at: V3, heading = 0) {
    const R = g.RAPIER;
    const info = g.characters?.manifest.player, av = g.characters?.avatar;
    if (info && av) {
      this.radius = Math.min(0.3, Math.max(0.18, info.height * 0.15));
      this.half = Math.max(0.05, info.height / 2 - this.radius);
      this.walkSpeed = this.clipSpeed = info.walkSpeed ?? 1.4;
      this.name = info.name;
    }
    this.heading = heading;
    this.body = g.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(at[0], at[1] + this.half + this.radius + 0.02, at[2]));
    this.collider = g.world.createCollider(R.ColliderDesc.capsule(this.half, this.radius), this.body);
    this.ctrl = g.world.createCharacterController(0.01);
    this.ctrl.enableSnapToGround(0.3);
    this.ctrl.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    if (info && av) {
      // the studio character: a skinned copy of player.glb, walk at the clip's speed, idle when still
      this.mesh = SkeletonUtils.clone(av.scene);
      this.mesh.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
      this.mixer = new THREE.AnimationMixer(this.mesh);
      const clip = (n: string) => av.animations.find((a) => a.name === n);
      const w = clip('walk'), i = clip('idle'), st = clip('start'), sp = clip('stop');
      if (w) this.walk = this.mixer.clipAction(w);
      if (i) { this.idle = this.mixer.clipAction(i); this.idle.play(); }
      this.clips = (info?.clips ?? {}) as Record<string, ClipInfo>;
      for (const [a, c] of [['start', st], ['stop', sp]] as const) if (c) { const act = this.mixer.clipAction(c); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; this[a] = act; }
    } else this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(this.radius, this.half * 2, 6, 16), new THREE.MeshStandardMaterial({ color: '#d9613a', roughness: 0.6 }));
    this.mesh.name = 'StudioPlayer';
    g.scene.add(this.mesh);
    this.sync();
  }
  feet(): V3 { const t = this.body.translation(); return [t.x, t.y - this.half - this.radius, t.z]; }
  move(dir: [number, number], speed: number, dt: number) {
    this.want = speed > 0 && !!(dir[0] || dir[1]);
    // a step clip is playing: the body waits (only gravity), the clip moves the hips
    if (this.state === 'starting' || this.state === 'stopping') { speed = 0; dir = [0, 0]; }
    const grounded = this.ctrl.computedGrounded();
    this.vy = grounded ? 0 : this.vy - 9.81 * dt;
    this.ctrl.computeColliderMovement(this.collider, { x: dir[0] * speed * dt, y: this.vy * dt, z: dir[1] * speed * dt });
    const m = this.ctrl.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
    this.hs = Math.hypot(m.x, m.z) / Math.max(1e-6, dt);
    if (speed > 0 && (dir[0] || dir[1])) this.heading = Math.atan2(dir[0], dir[1]);
  }
  sync(dt = 0) {
    const t = this.body.translation();
    if (this.mixer) {
      // feet at the bottom of the capsule; studio characters face +Z
      this.mesh.position.set(t.x, t.y - this.half - this.radius, t.z);
      this.mesh.rotation.y = this.heading;
      this.steps(dt);
      this.mixer.update(dt);
    } else this.mesh.position.set(t.x, t.y, t.z);
  }
  /** idle → start → walk → stop → idle; without start/stop clips, a cross-fade as before. */
  private steps(dt: number) {
    const only = (a: THREE.AnimationAction | null, fade: number) => {
      if (!a) return;
      for (const o of [this.idle, this.walk, this.start, this.stop]) if (o && o !== a && o.isRunning()) o.fadeOut(fade);
      a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(fade).play();
    };
    if (this.state === 'starting' || this.state === 'stopping') {
      this.stateT += dt;
      const key = this.state === 'starting' ? 'start' : 'stop', info = this.clips[key];
      const act = this.state === 'starting' ? this.start! : this.stop!;
      if (this.stateT >= act.getClip().duration) {
        // jump the body to where the clip left the hips (travel is in the character's own frame, +Z forward)
        const tr = info?.travel ?? [0, 0, 0], h = this.heading;
        const t = this.body.translation();
        const dx = tr[0] * Math.cos(h) + tr[2] * Math.sin(h), dz = -tr[0] * Math.sin(h) + tr[2] * Math.cos(h);
        this.body.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true);
        this.mesh.position.x += dx; this.mesh.position.z += dz;
        if (this.state === 'starting') {
          this.state = 'walk'; only(this.walk, 0);
          this.walk!.time = (info?.phase ?? 0.5) * this.walk!.getClip().duration;
        } else { this.state = 'idle'; only(this.idle, 0); }
      }
      return;
    }
    if (this.want && this.state === 'idle' && this.start && this.walk) { this.state = 'starting'; this.stateT = 0; only(this.start, 0.12); return; }
    if (!this.want && this.state === 'walk' && this.stop) { this.state = 'stopping'; this.stateT = 0; only(this.stop, 0.1); return; }
    const moving = this.hs > 0.15 && this.walk;
    if (moving && this.state !== 'walk') { this.state = 'walk'; only(this.walk, 0.15); }
    if (!moving && this.state !== 'idle' && this.idle && !this.start) { this.state = 'idle'; only(this.idle, 0.25); }
    if (!moving && this.state === 'walk' && !this.stop && this.idle) { this.state = 'idle'; only(this.idle, 0.25); }
    // the clip plays at the speed the body actually moves, so feet stay planted
    if (this.walk) this.walk.timeScale = this.state === 'walk' && moving ? Math.min(2.5, Math.max(0.3, this.hs / this.clipSpeed)) : 1;
  }
  remove() { this.g.world.removeCharacterController(this.ctrl); this.g.world.removeRigidBody(this.body); this.g.scene.remove(this.mesh); }
}

function clearSpot(g: StudioGame, at: V3): boolean {
  const R = g.RAPIER;
  const shape = new R.Capsule(0.5, 0.3);
  let hit = false;
  g.world.intersectionsWithShape({ x: at[0], y: at[1] + 0.9, z: at[2] }, { x: 0, y: 0, z: 0, w: 1 }, shape, () => { hit = true; return false; });
  return !hit;
}

const commands = {
  info(g: StudioGame) {
    return { ok: true, studio: !!g.studio, objects: objects(g).map((o) => ({ name: o.name, box: boxOf(o), triangles: triangles(o) })), triangles: triangles(g.studio), scene: boxOf(g.studio), materials: materials(g.studio) };
  },

  run(g: StudioGame, c: any) {
    const seconds = c.seconds ?? 3;
    let frames = 0;
    for (let t = 0; t < seconds; t += 1 / 60) { g.step(1 / 60); frames++; }
    return { ...commands.info(g), seconds, frames };
  },

  screenshot(g: StudioGame, c: any) {
    const w = Math.round(c.size ?? 960), h = Math.round(w * 0.625);
    let player: Player | null = null;
    let b = c.object ? boxOf(find(g, c.object)) : boxOf(g.studio);
    if (Array.isArray(c.player)) {
      const at: V3 = c.player.length === 2 ? [c.player[0], 0, c.player[1]] : c.player;
      player = new Player(g, at);
      b = { min: b.min.map((v, k) => Math.min(v, k === 1 ? at[1] : at[k] - 0.3)) as V3, max: b.max.map((v, k) => Math.max(v, k === 1 ? at[1] + 1.7 : at[k] + 0.3)) as V3 };
    }
    if (c.includePlayer && c.playerAt) {
      const at: V3 = c.playerAt;
      b = { min: b.min.map((v, k) => Math.min(v, k === 1 ? at[1] : at[k] - 0.3)) as V3, max: b.max.map((v, k) => Math.max(v, k === 1 ? at[1] + 1.7 : at[k] + 0.3)) as V3 };
    }
    const cam = new THREE.PerspectiveCamera(40, w / h, 0.02, 500);
    const prev = new THREE.Vector2();
    g.renderer.getSize(prev);
    g.renderer.setSize(w, h, false);
    const images: any[] = [];
    for (const view of c.views ?? ['iso']) {
      const d = new THREE.Vector3(...((c.dir as V3) ?? DIRS[view] ?? DIRS.iso)).normalize();
      const center = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      const r = Math.max(new THREE.Vector3(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]).length() / 2, 0.4);
      const dist = (r / Math.tan((cam.fov * Math.PI) / 360)) * 1.1;
      cam.position.copy(center).addScaledVector(d, dist);
      cam.up.set(0, 1, 0);
      if (view === 'top') cam.up.set(0, 0, -1);
      cam.lookAt(center);
      cam.near = Math.max(dist - r * 3, 0.02);
      cam.far = dist + r * 6;
      cam.updateProjectionMatrix();
      g.renderer.render(g.scene, cam);
      images.push({ view, dataUrl: g.renderer.domElement.toDataURL('image/png') });
    }
    g.renderer.setSize(prev.x, prev.y, false);
    player?.remove();
    return { ok: true, images, box: b };
  },

  walk(g: StudioGame, c: any) {
    let target: Box, targetName = '';
    if (typeof c.target === 'string') {
      const o = find(g, c.target);
      if (!o) return { ok: false, error: `no object named ${c.target}`, objects: objects(g).map((x) => x.name) };
      target = boxOf(o); targetName = o.name;
    } else {
      const p: V3 = c.target.length === 2 ? [c.target[0], 0, c.target[1]] : c.target;
      target = { min: p, max: p };
    }
    const info = g.characters?.avatar ? g.characters.manifest.player : null;
    const reach = c.reach ?? 0.45, speed = c.speed ?? info?.walkSpeed ?? 1.4, timeout = c.timeout ?? 20, dt = 1 / 60;
    let start: V3 = [0, 0, 0], facing = 0;
    if (Array.isArray(c.from)) start = c.from.length === 2 ? [c.from[0], 0, c.from[1]] : c.from;
    else if (info?.start) { start = [info.start[0], 0, info.start[2]]; facing = ((info.rotation ?? 0) * Math.PI) / 180; }
    else {
      const cx = (target.min[0] + target.max[0]) / 2, cz = (target.min[2] + target.max[2]) / 2;
      const ext = Math.max(target.max[0] - target.min[0], target.max[2] - target.min[2]) / 2;
      for (const [x, z] of [[0, 1], [1, 0], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]]) {
        const s: V3 = [cx + x * (ext + (c.distance ?? 3)), 0, cz + z * (ext + (c.distance ?? 3))];
        if (clearSpot(g, s)) { start = s; break; }
      }
    }
    const p = new Player(g, start, facing);
    g.step(dt); g.step(dt);
    // video: a following camera from the side of the walk, every frameEvery steps (JPEG data URLs)
    const frames: string[] = [];
    const tc: V3 = [(target.min[0] + target.max[0]) / 2, 0, (target.min[2] + target.max[2]) / 2];
    const fw = new THREE.Vector3(tc[0] - start[0], 0, tc[2] - start[2]).normalize();
    const side = new THREE.Vector3(-fw.z, 0, fw.x);
    const rcam = new THREE.PerspectiveCamera(38, 1.6, 0.05, 200);
    let stepN = 0;
    const record = () => {
      if (!c.frames || stepN++ % (c.frameEvery ?? 2)) return;
      const f = p.feet();
      const look = new THREE.Vector3(f[0], 0, f[2]).lerp(new THREE.Vector3(tc[0], 0, tc[2]), 0.3).add(new THREE.Vector3(0, 0.95, 0));
      rcam.position.copy(look).addScaledVector(side, 3.6).addScaledVector(fw, -1.2).add(new THREE.Vector3(0, 1.0, 0));
      rcam.lookAt(look);
      const sz = new THREE.Vector2(); g.renderer.getSize(sz); rcam.aspect = sz.x / sz.y; rcam.updateProjectionMatrix();
      g.renderer.render(g.scene, rcam);
      frames.push(g.renderer.domElement.toDataURL('image/jpeg', 0.88));
    };
    const path: V3[] = [p.feet().map((v) => +v.toFixed(3)) as V3];
    let t = 0, best = Infinity, lastProgress = 0, reached = false;
    while (t < timeout) {
      const pos = p.feet();
      const d = xzDist(pos, target);
      if (d <= reach) { reached = true; break; }
      if (d < best - 0.02) { best = d; lastProgress = t; }
      if (t - lastProgress > 1.5) break;
      const gx = Math.min(Math.max(pos[0], target.min[0]), target.max[0]), gz = Math.min(Math.max(pos[2], target.min[2]), target.max[2]);
      const dx = gx - pos[0], dz = gz - pos[2], l = Math.hypot(dx, dz) || 1;
      p.move([dx / l, dz / l], speed, dt);
      g.step(dt);
      g.characters?.update(dt);
      p.sync(dt);
      record();
      t += dt;
      if (Math.floor(t / 0.5) !== Math.floor((t - dt) / 0.5)) path.push(p.feet().map((v) => +v.toFixed(3)) as V3);
    }
    if (c.frames) for (let i = 0; i < 50; i++) { p.move([0, 0], 0, dt); g.step(dt); g.characters?.update(dt); p.sync(dt); record(); }
    const end = p.feet().map((v) => +v.toFixed(3)) as V3;
    path.push(end);
    const result: any = {
      ok: true, reached, blocked: !reached && t < timeout, timedOut: t >= timeout, seconds: +t.toFixed(2), from: start, final: end,
      distanceToTarget: +xzDist(end, target).toFixed(3), reach, target: targetName || target.min, path, fellThroughFloor: end[1] < -0.5,
      player: p.name, speed: +speed.toFixed(2), ...(c.frames ? { frames } : {}),
    };
    if (c.shot) {
      // look across the walk, from the side, so neither the player nor the target hides the other
      const wx = end[0] - start[0], wz = end[2] - start[2], wl = Math.hypot(wx, wz) || 1;
      const dir: V3 = wl > 0.01 ? [(-wz / wl) * 1.2 - (wx / wl) * 0.35, 0.7, (wx / wl) * 1.2 - (wz / wl) * 0.35] : [1, 0.7, 0];
      p.sync();
      result.images = (commands.screenshot(g, { views: ['walk'], dir, size: c.size, object: targetName || undefined, includePlayer: true, playerAt: end }) as any).images;
    }
    p.remove();
    return result;
  },

  async test(g: StudioGame, c: any) {
    const results: any[] = [];
    for (const a of c.assertions ?? []) results.push(assertion(g, a));
    if (c.scripts !== false) {
      for (const t of tests) {
        try { const r = await t.run(g); results.push({ kind: 'script', name: t.name, pass: !!r.pass, detail: r.detail ?? '' }); }
        catch (e: any) { results.push({ kind: 'script', name: t.name, pass: false, detail: e?.message ?? String(e) }); }
      }
    }
    const failed = results.filter((r) => !r.pass).length;
    return { ok: true, passed: results.length - failed, failed, results };
  },
};

function assertion(g: StudioGame, a: any) {
  const tol = a.tolerance ?? 0.02;
  const r = { kind: a.kind, pass: false, detail: '' };
  switch (a.kind) {
    case 'exists': { const o = find(g, a.node ?? ''); r.pass = !!o; r.detail = o ? `found ${o.name}` : `no node ${a.node}`; break; }
    case 'grounded': { const o = find(g, a.node ?? ''); if (!o) { r.detail = `no node ${a.node}`; break; } const b = boxOf(o); r.pass = Math.abs(b.min[1]) <= tol; r.detail = `min y ${b.min[1].toFixed(3)}`; break; }
    case 'on': {
      const o = find(g, a.node ?? ''), t = find(g, a.target ?? '');
      if (!o || !t) { r.detail = 'missing node'; break; }
      const b = boxOf(o), tb = boxOf(t);
      const gap = b.min[1] - tb.max[1];
      const overlap = b.min[0] < tb.max[0] && b.max[0] > tb.min[0] && b.min[2] < tb.max[2] && b.max[2] > tb.min[2];
      r.pass = Math.abs(gap) <= tol && overlap; r.detail = `gap ${gap.toFixed(3)} m, footprint ${overlap ? 'overlaps' : 'misses'}`; break;
    }
    case 'count': {
      const re = new RegExp('^' + String(a.pattern ?? '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const n = objects(g).filter((o) => re.test(o.name) || re.test(o.name.replace(/_/g, ' '))).length;
      r.pass = n >= (a.min ?? 1) && n <= (a.max ?? Infinity); r.detail = `${n} match ${a.pattern}`; break;
    }
    case 'reachable': {
      const w: any = commands.walk(g, { target: a.target, from: a.from, reach: a.reach, timeout: a.timeout });
      r.pass = !!w.reached; r.detail = w.error ?? (w.reached ? `reached in ${w.seconds}s` : `stopped ${w.distanceToTarget} m short at ${JSON.stringify(w.final)}`); break;
    }
    default: r.detail = 'unknown assertion kind (exists, grounded, on, count, reachable)';
  }
  return r;
}
