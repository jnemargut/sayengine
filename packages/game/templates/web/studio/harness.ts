// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// The play-test harness for web games: `studio game run|screenshot|walk-to|test` load the page in
// headless Chrome and call window.__studio.run(cmd). Same commands and JSON as the Godot runner.
import * as THREE from 'three';
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
  root.traverse((o: any) => {
    if (!o.isMesh) return;
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
  const ready = gamePromise.then((g) => { (window as any).__game = g; return g; });
  (window as any).__studio = {
    ready: ready.then(() => true),
    async run(cmd: any) {
      const g = await ready;
      g.paused = true;
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
  body: RAPIER_NS.RigidBody; collider: RAPIER_NS.Collider; ctrl: RAPIER_NS.KinematicCharacterController; mesh: THREE.Mesh;
  vy = 0; radius = 0.3; half = 0.55; // capsule: 2*0.55 + 2*0.3 = 1.7 m
  constructor(private g: StudioGame, at: V3) {
    const R = g.RAPIER;
    this.body = g.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(at[0], at[1] + this.half + this.radius + 0.02, at[2]));
    this.collider = g.world.createCollider(R.ColliderDesc.capsule(this.half, this.radius), this.body);
    this.ctrl = g.world.createCharacterController(0.01);
    this.ctrl.enableSnapToGround(0.3);
    this.ctrl.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(this.radius, this.half * 2, 6, 16), new THREE.MeshStandardMaterial({ color: '#d9613a', roughness: 0.6 }));
    this.mesh.name = 'StudioPlayer';
    g.scene.add(this.mesh);
    this.sync();
  }
  feet(): V3 { const t = this.body.translation(); return [t.x, t.y - this.half - this.radius, t.z]; }
  move(dir: [number, number], speed: number, dt: number) {
    const grounded = this.ctrl.computedGrounded();
    this.vy = grounded ? 0 : this.vy - 9.81 * dt;
    this.ctrl.computeColliderMovement(this.collider, { x: dir[0] * speed * dt, y: this.vy * dt, z: dir[1] * speed * dt });
    const m = this.ctrl.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
  }
  sync() { const t = this.body.translation(); this.mesh.position.set(t.x, t.y, t.z); }
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
    const reach = c.reach ?? 0.45, speed = c.speed ?? 1.4, timeout = c.timeout ?? 20, dt = 1 / 60;
    let start: V3 = [0, 0, 0];
    if (Array.isArray(c.from)) start = c.from.length === 2 ? [c.from[0], 0, c.from[1]] : c.from;
    else {
      const cx = (target.min[0] + target.max[0]) / 2, cz = (target.min[2] + target.max[2]) / 2;
      const ext = Math.max(target.max[0] - target.min[0], target.max[2] - target.min[2]) / 2;
      for (const [x, z] of [[0, 1], [1, 0], [-1, 0], [0, -1], [Math.SQRT1_2, Math.SQRT1_2]]) {
        const s: V3 = [cx + x * (ext + (c.distance ?? 3)), 0, cz + z * (ext + (c.distance ?? 3))];
        if (clearSpot(g, s)) { start = s; break; }
      }
    }
    const p = new Player(g, start);
    g.step(dt); g.step(dt);
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
      p.sync();
      t += dt;
      if (Math.floor(t / 0.5) !== Math.floor((t - dt) / 0.5)) path.push(p.feet().map((v) => +v.toFixed(3)) as V3);
    }
    const end = p.feet().map((v) => +v.toFixed(3)) as V3;
    path.push(end);
    const result: any = {
      ok: true, reached, blocked: !reached && t < timeout, timedOut: t >= timeout, seconds: +t.toFixed(2), from: start, final: end,
      distanceToTarget: +xzDist(end, target).toFixed(3), reach, target: targetName || target.min, path, fellThroughFloor: end[1] < -0.5,
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
