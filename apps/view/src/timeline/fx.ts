// Effects on the view's timeline (Phase 10 step 2): the same effect recipes the games compile, drawn
// so that any moment can be scrubbed to and looks the same every time. Particles are a pure function of
// time (seeded per particle: born at a burst or at its emission slot, then moved by speed, gravity and
// drag), so scrubbing back shows the sparks exactly where they were. Shape layers (flames, rings, puffs)
// are crossed cards with the studio's scrolling-noise shader, the one Godot and the web games run.
import * as THREE from 'three';
import { webShapeShader, type EffectDef, type ParticleLayer, type ShapeLayer } from '../../../../packages/core/src/effects.ts';

type V3 = [number, number, number];
const MAX = 1600;

/** A hash in [0, 1) for particle i of a layer, channel k. */
function rnd(seed: number, i: number, k: number): number {
  let h = (seed * 374761393 + i * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const strSeed = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

const POINT_VS = `attribute float aSize; attribute vec4 aCol; varying vec4 vCol; uniform float uScale;
void main() { vCol = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = max(1.0, aSize * uScale / -mv.z); gl_Position = projectionMatrix * mv; }`;
const POINT_FS = `varying vec4 vCol; void main() { vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(vCol.rgb, vCol.a * (1.0 - r)); }`;

interface LayerDraw { layer: ParticleLayer; obj: THREE.Points | THREE.LineSegments; pos: Float32Array; col: Float32Array; size?: Float32Array; seed: number; c0: THREE.Color; c1: THREE.Color }
interface Live { id: string; root: THREE.Group; layers: LayerDraw[]; shapes: THREE.ShaderMaterial[]; def: EffectDef; bursts: number[]; loop: boolean }

export class TimelineFx {
  root = new THREE.Group();
  private live = new Map<string, Live>();
  private shader = webShapeShader();
  constructor(scene: THREE.Scene) { this.root.name = 'timeline-fx'; scene.add(this.root); }

  /** Rebuild from the timeline's effect tracks (only when their recipes changed). */
  sync(tracks: Array<{ id: string; version: string; fx?: { def: EffectDef; at: V3; colours: Record<string, string> }; markers: Array<{ at: number; kind: string }>; loop: boolean }>) {
    const want = new Set(tracks.map((t) => `${t.id}#${t.version}#${t.markers.filter((m) => m.kind === 'burst').map((m) => m.at).join(',')}`));
    for (const [k, l] of this.live) if (!want.has(k)) { this.root.remove(l.root); l.root.traverse((o: any) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.live.delete(k); }
    for (const t of tracks) {
      const key = `${t.id}#${t.version}#${t.markers.filter((m) => m.kind === 'burst').map((m) => m.at).join(',')}`;
      if (this.live.has(key) || !t.fx) continue;
      this.live.set(key, this.make(t.fx.def, t.fx.at, t.fx.colours, t.markers.filter((m) => m.kind === 'burst').map((m) => m.at / 24000), t.loop));
    }
  }

  private make(def: EffectDef, at: V3, colours: Record<string, string>, bursts: number[], loop: boolean): Live {
    const root = new THREE.Group();
    root.position.set(...at);
    this.root.add(root);
    const layers: LayerDraw[] = [], shapes: THREE.ShaderMaterial[] = [];
    for (const l of def.layers) {
      if (l.kind === 'shape') { shapes.push(...this.shape(root, l, colours)); continue; }
      const p = l as ParticleLayer;
      const add = p.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending;
      const c0 = new THREE.Color(colours[p.colour[0]] ?? '#ffffff'), c1 = new THREE.Color(colours[p.colour[1]] ?? '#ffffff');
      const seed = strSeed(`${def.id}:${p.id}`);
      const geo = new THREE.BufferGeometry();
      if (p.stretch) {
        const pos = new Float32Array(MAX * 6), col = new Float32Array(MAX * 8);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
        const obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: add }));
        obj.frustumCulled = false; obj.renderOrder = 3;
        root.add(obj);
        layers.push({ layer: p, obj, pos, col, seed, c0, c1 });
      } else {
        const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 4), size = new Float32Array(MAX);
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('aCol', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
        const mat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, transparent: true, depthWrite: false, blending: add, uniforms: { uScale: { value: 600 } } });
        const obj = new THREE.Points(geo, mat);
        obj.frustumCulled = false; obj.renderOrder = 3;
        root.add(obj);
        layers.push({ layer: p, obj, pos, col, size, seed, c0, c1 });
      }
    }
    return { id: def.id, root, layers, shapes, def, bursts, loop };
  }

  private shape(root: THREE.Group, l: ShapeLayer, colours: Record<string, string>): THREE.ShaderMaterial[] {
    const out: THREE.ShaderMaterial[] = [];
    const form = { flame: 0, ring: 1, arc: 2, puff: 3 }[l.mesh] ?? 0;
    const n = l.count ?? 1, off = l.offset ?? [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: this.shader.vertex, fragmentShader: this.shader.fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: l.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
        uniforms: { col_a: { value: new THREE.Color(colours[l.colour[0]] ?? '#ff8a2a') }, col_b: { value: new THREE.Color(colours[l.colour[1]] ?? '#ffcf6a') }, time: { value: 0 }, scroll: { value: l.scroll ?? 1 }, noise_amt: { value: l.noise ?? 0.5 }, flicker: { value: l.flicker ?? 0 }, alpha_mul: { value: l.alpha ?? 1 }, seed: { value: +(i * 3.17).toFixed(2) }, value: { value: 1 }, form: { value: form } },
      });
      out.push(mat);
      const geo = new THREE.PlaneGeometry(l.size[0], l.size[1]);
      geo.translate(0, l.size[1] / 2, 0);
      const ang = n > 1 ? (i / n) * Math.PI * 2 : 0, r = n > 1 ? l.size[0] * 0.3 : 0;
      for (const rot of [0, Math.PI / 2]) {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(off[0] + Math.sin(ang) * r, off[1], off[2] + Math.cos(ang) * r);
        m.rotation.y = rot + ang; m.renderOrder = 2; m.frustumCulled = false; m.raycast = () => {};
        root.add(m);
      }
    }
    return out;
  }

  /** Every effect at scene time t (s). Returns the live particle count (for the budget readout). */
  setTime(t: number, pixelScale: number): number {
    let total = 0;
    for (const fx of this.live.values()) {
      for (const m of fx.shapes) m.uniforms.time.value = t;
      for (const d of fx.layers) total += this.layerAt(d, fx, t, pixelScale);
    }
    return total;
  }

  private layerAt(d: LayerDraw, fx: Live, t: number, pixelScale: number): number {
    const l = d.layer, lifeMax = l.life[1];
    // who is alive: burst particles from each firing, plus emission slots over the last life
    const born: Array<[number, number]> = [];           // [birth time, particle index]
    const count = (l.bursts ?? []).reduce((s, b) => s + b.count, 0);
    if (count) for (let k = 0; k < fx.bursts.length; k++) { const b = fx.bursts[k]; if (t >= b && t - b < lifeMax) for (let i = 0; i < count && born.length < MAX; i++) born.push([b, k * 1000 + i]); }
    if (l.rate > 0) { const from = Math.max(0, Math.floor((t - lifeMax) * l.rate)), to = Math.floor(t * l.rate); for (let i = from; i <= to && born.length < MAX; i++) born.push([i / l.rate, 100000 + i]); }
    const dir = new THREE.Vector3(...(l.direction ?? [0, 1, 0])).normalize();
    const tmp = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
    side.set(1, 0, 0); if (Math.abs(dir.x) > 0.9) side.set(0, 0, 1);
    up.crossVectors(dir, side).normalize(); side.crossVectors(up, dir).normalize();
    const off = l.offset ?? [0, 0, 0], g = l.gravity ?? 0, drag = l.drag ?? 0, spread = THREE.MathUtils.degToRad(l.spread ?? (l.shape.angle ?? 0));
    let n = 0;
    for (const [b, i] of born) {
      const life = lerp(l.life[0], l.life[1], rnd(d.seed, i, 1)), age = t - b;
      if (age < 0 || age >= life) continue;
      const u = age / life, sp = lerp(l.speed[0], l.speed[1], rnd(d.seed, i, 2));
      const th = spread * Math.sqrt(rnd(d.seed, i, 3)), ph = 6.2831853 * rnd(d.seed, i, 4);
      tmp.copy(dir).multiplyScalar(Math.cos(th)).addScaledVector(side, Math.sin(th) * Math.cos(ph)).addScaledVector(up, Math.sin(th) * Math.sin(ph));
      const rad = (l.shape.radius ?? 0) * Math.sqrt(rnd(d.seed, i, 5)), ang = 6.2831853 * rnd(d.seed, i, 6);
      const box = l.shape.type === 'box' && l.shape.size ? [(rnd(d.seed, i, 7) - 0.5) * l.shape.size[0], (rnd(d.seed, i, 8) - 0.5) * l.shape.size[1], (rnd(d.seed, i, 9) - 0.5) * l.shape.size[2]] : [Math.cos(ang) * rad, 0, Math.sin(ang) * rad];
      // travel with drag (v decays as e^-k·age), gravity pulls down, turbulence wobbles a little
      const k = drag * 3, travel = k > 0 ? (1 - Math.exp(-k * age)) / k : age;
      const wob = (l.turbulence ?? 0) * 0.08 * Math.sin(age * 3 + i);
      const x = off[0] + box[0] + tmp.x * sp * travel + wob, y = off[1] + box[1] + tmp.y * sp * travel - 0.5 * g * age * age, z = off[2] + box[2] + tmp.z * sp * travel + wob * 0.7;
      const a = lerp(l.alpha?.[0] ?? 1, l.alpha?.[1] ?? 0, u);
      const cr = lerp(d.c0.r, d.c1.r, u), cg = lerp(d.c0.g, d.c1.g, u), cb = lerp(d.c0.b, d.c1.b, u);
      if (d.size) {
        d.pos.set([x, y, z], n * 3); d.col.set([cr, cg, cb, a], n * 4);
        d.size[n] = lerp(l.size[0], l.size[1], rnd(d.seed, i, 10)) * lerp(1, l.sizeEnd ?? 1, u) * 2.2;
      } else {
        // a streak along the velocity: length = speed × stretch
        const vx = tmp.x * sp * Math.exp(-k * age), vy = tmp.y * sp * Math.exp(-k * age) - g * age, vz = tmp.z * sp * Math.exp(-k * age);
        const s = l.stretch! * 1.6;
        d.pos.set([x, y, z, x - vx * s, y - vy * s, z - vz * s], n * 6);
        d.col.set([cr, cg, cb, a, cr, cg, cb, a * 0.15], n * 8);
      }
      n++;
    }
    const geo = d.obj.geometry;
    geo.setDrawRange(0, d.size ? n : n * 2);
    for (const name of Object.keys(geo.attributes)) (geo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
    if (d.size) ((d.obj as THREE.Points).material as THREE.ShaderMaterial).uniforms.uScale.value = pixelScale;
    return n;
  }
}
