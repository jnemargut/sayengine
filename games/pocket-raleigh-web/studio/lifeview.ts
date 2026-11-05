// Managed by the studio — overwritten by `studio game import`. Town life on the web (Decision 30): the
// baked day in assets/studio/life.json played by the life runtime (studio/life.ts, the same rules as
// Godot's studio/life.gd), drawn with the studio's cast GLBs (assets/studio/life/*.glb) and the smart
// places' props (assets/studio/life-props.glb). The runtime ticks at a fixed 0.1 s; drawing interpolates
// between ticks. Folk and vehicles carry kinematic colliders, so the player bumps into them, and the
// player's position goes back into the runtime: folk step aside, cars brake.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { LifeRuntime, LIFE_DT, GREEN, AMBER, type LifeData } from './life.ts';
import type { StudioGame } from './harness.ts';

interface Actor { root: THREE.Object3D; mixer: THREE.AnimationMixer | null; actions: Record<string, THREE.AnimationAction>; cur: string; clipSpeed: number; body: any; kind: string; scale: number }
export interface StudioLife {
  rt: LifeRuntime; data: LifeData & Record<string, any>;
  /** advance by dt seconds of game time (the runtime steps in 0.1 s ticks) */
  update(dt: number): void;
  /** jump to a time of day (seconds) and settle for `warm` seconds */
  seek(t: number, warm?: number): void;
  /** the walk mesh polygons as a translucent overlay (debug) */
  showWalk(on: boolean): void;
  speed: number;
}

const POSE_CLIP: Record<string, string[]> = { walk: ['walk'], idle: ['idle'], sit: ['sit', 'idle'], fish: ['fish', 'idle'], browse: ['browse', 'idle'], tend: ['browse', 'idle'], wait: ['idle'], trot: ['trot', 'walk'] };

export async function startLife(g: StudioGame, opts: { start?: number; warm?: number } = {}): Promise<StudioLife | null> {
  const res = await fetch('assets/studio/life.json').catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json()) as LifeData & Record<string, any>;
  const rt = new LifeRuntime(data);
  const loader = new GLTFLoader();
  const R = g.RAPIER;
  // the props: stalls, piers, bus stops, signal heads (lit lamps toggled from the signals)
  const lamps: Array<{ o: THREE.Object3D; sig: number; group: number; colour: string }> = [];
  const props = await loader.loadAsync('assets/studio/life-props.glb').catch(() => null);
  if (props) {
    props.scene.traverse((o: any) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      const m = /^lit:(\d+):(\d+):(red|amber|green)/.exec(o.name);
      if (m) lamps.push({ o, sig: +m[1], group: +m[2], colour: m[3] });
    });
    g.scene.add(props.scene);
  }
  // the cast: one load per model, a skinned clone per agent
  const models: Record<string, { scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null> = {};
  for (const id of Object.keys(data.models ?? {})) {
    const gl = await loader.loadAsync(`assets/studio/${data.models[id].file}`).catch(() => null);
    models[id] = gl ? { scene: gl.scene, animations: gl.animations } : null;
  }
  const make = (model: string, kind: string, scale: number, collider: () => any): Actor => {
    const M = models[model];
    const root = M ? SkeletonUtils.clone(M.scene) : new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 1.1, 4, 8), new THREE.MeshStandardMaterial({ color: '#c9a37a' }));
    root.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; } });
    root.scale.setScalar(scale);
    root.visible = false;
    g.scene.add(root);
    const mixer = M?.animations.length ? new THREE.AnimationMixer(root) : null;
    const actions: Record<string, THREE.AnimationAction> = {};
    if (mixer) for (const c of M!.animations) actions[c.name] = mixer.clipAction(c);
    const walk = M?.animations.find((c) => c.name === 'walk' || c.name === 'drive');
    return { root, mixer, actions, cur: '', clipSpeed: kind === 'person' ? 1.3 : kind === 'dog' ? 1.2 : 8, body: collider(), kind, scale };
    void walk;
  };
  const kinBody = (shape: any) => { const b = g.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0)); g.world.createCollider(shape, b); return b; };
  const agents: Actor[] = data.agents.map((a) => make(a.model, a.kind, a.scale ?? 1, () => kinBody(a.kind === 'dog' ? R.ColliderDesc.ball(0.22) : R.ColliderDesc.capsule(0.55, a.r))));
  const vehicles: Actor[] = data.vehicles.map((v) => make(v.model, v.kind, 1, () => kinBody(R.ColliderDesc.cuboid(v.wid / 2, v.kind === 'bus' ? 1.5 : 0.75, v.len / 2))));
  // agents and vehicles stagger their walk cycles (no two in step)
  [...agents, ...vehicles].forEach((a, i) => { for (const act of Object.values(a.actions)) act.time = (i * 0.37) % 1; });

  let walkOverlay: THREE.Object3D | null = null;
  const prev = { ax: new Float64Array(agents.length), az: new Float64Array(agents.length), ay: new Float64Array(agents.length), ayaw: new Float64Array(agents.length), vx: new Float64Array(vehicles.length), vz: new Float64Array(vehicles.length), vy: new Float64Array(vehicles.length), vyaw: new Float64Array(vehicles.length) };
  const snap = () => {
    rt.agents.forEach((a, i) => { prev.ax[i] = a.x; prev.az[i] = a.z; prev.ay[i] = a.y; prev.ayaw[i] = a.yaw; });
    rt.vehicles.forEach((v, i) => { prev.vx[i] = v.x; prev.vz[i] = v.z; prev.vy[i] = v.y; prev.vyaw[i] = v.yaw; });
  };
  let acc = 0;
  const lerpAng = (a: number, b: number, t: number) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };
  const play = (A: Actor, pose: string, speed: number) => {
    if (!A.mixer) return;
    const want = (POSE_CLIP[pose] ?? ['idle']).find((n) => A.actions[n]) ?? (A.actions.drive ? 'drive' : A.actions.idle ? 'idle' : Object.keys(A.actions)[0]);
    if (!want) return;
    if (A.cur !== want) {
      const next = A.actions[want];
      next.reset().play();
      if (A.cur && A.actions[A.cur]) A.actions[A.cur].crossFadeTo(next, 0.35, false);
      A.cur = want;
    }
    const a = A.actions[A.cur];
    if (A.cur === 'walk' || A.cur === 'trot' || A.cur === 'drive') a.timeScale = Math.max(0.15, speed / (A.clipSpeed * A.scale));
  };
  const life: StudioLife = {
    rt, data, speed: 1,
    update(dt: number) {
      // the player's position into the runtime (folk step aside, cars brake)
      const p = g.characters?.player as any;
      if (p?.body) { const t = p.body.translation(); rt.setPlayer(t.x, t.z, 0.35, true); } else rt.setPlayer(0, 0, 0.35, false);
      acc += dt * life.speed;
      let steps = 0;
      while (acc >= LIFE_DT && steps < 50) { snap(); rt.step(); acc -= LIFE_DT; steps++; }
      if (steps === 50) acc = 0;
      const k = acc / LIFE_DT;
      rt.agents.forEach((s, i) => {
        const A = agents[i];
        A.root.visible = s.visible;
        if (!s.visible) { A.body.setNextKinematicTranslation({ x: 0, y: -500, z: 0 }); return; }
        const x = prev.ax[i] + (s.x - prev.ax[i]) * k, z = prev.az[i] + (s.z - prev.az[i]) * k, y = prev.ay[i] + (s.y - prev.ay[i]) * k;
        A.root.position.set(x, y, z);
        A.root.rotation.y = lerpAng(prev.ayaw[i], s.yaw, k);
        A.body.setNextKinematicTranslation({ x, y: y + 0.85, z });
        play(A, s.pose, s.v);
        A.mixer?.update(dt * life.speed);
      });
      rt.vehicles.forEach((s, i) => {
        const A = vehicles[i];
        A.root.visible = s.visible;
        if (!s.visible) { A.body.setNextKinematicTranslation({ x: 0, y: -500, z: 0 }); return; }
        const x = prev.vx[i] + (s.x - prev.vx[i]) * k, z = prev.vz[i] + (s.z - prev.vz[i]) * k, y = prev.vy[i] + (s.y - prev.vy[i]) * k, yaw = lerpAng(prev.vyaw[i], s.yaw, k);
        A.root.position.set(x, y, z);
        A.root.rotation.y = yaw;
        A.body.setNextKinematicTranslation({ x, y: y + (A.kind === 'bus' ? 1.6 : 0.8), z });
        A.body.setNextKinematicRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });
        play(A, s.v > 0.1 ? 'walk' : 'idle', s.v);
        if (A.actions.drive) { A.actions.drive.paused = s.v < 0.05; }
        A.mixer?.update(dt * life.speed);
      });
      for (const L of lamps) {
        const c = rt.signal(L.sig, L.group, rt.t);
        L.o.visible = (c === GREEN && L.colour === 'green') || (c === AMBER && L.colour === 'amber') || (c !== GREEN && c !== AMBER && L.colour === 'red');
      }
    },
    seek(t: number, warm = 60) { rt.init(t, warm); snap(); acc = 0; },
    showWalk(on: boolean) {
      if (on && !walkOverlay) {
        const pos: number[] = [];
        for (const w of data.walk ?? []) {
          const p = w.poly as number[];
          for (let i = 1; i + 1 < p.length / 3; i++) pos.push(p[0], p[1] + 0.03, p[2], p[i * 3], p[i * 3 + 1] + 0.03, p[i * 3 + 2], p[i * 3 + 3], p[i * 3 + 4] + 0.03, p[i * 3 + 5]);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        walkOverlay = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#35c4ff', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
        walkOverlay.name = 'Walk mesh';
        g.scene.add(walkOverlay);
      }
      if (walkOverlay) walkOverlay.visible = on;
    },
  };
  life.seek(opts.start ?? data.start, opts.warm ?? 60);
  return life;
}
