// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// Studio effects in a web game (Decisions 56–57): particle layers are three.quarks systems (MIT, loaded
// from assets/studio/effects/<id>.json), shape layers (flames, rings, puffs) are crossed cards with the
// studio's scrolling-noise shader — the same shader Godot runs. Use:
//   const fx = await startEffects(game);   fx.setValue('fire', 0.4);   fx.event('fed');
// and call fx.update(dt) every frame (startEffects hooks game.characters.update for you).
import * as THREE from 'three';
import { BatchedRenderer, QuarksLoader, ConstantValue } from 'three.quarks';
import type { StudioGame } from './harness.ts';

type V3 = [number, number, number];
interface Trigger { on: string; layer: string; character?: string; clip?: string; fraction?: number }
interface FxFile { def: any; at: V3; colours: Record<string, string>; quarks: any; shader: { vertex: string; fragment: string } }
interface Live { id: string; root: THREE.Object3D; file: FxFile; emitters: Record<string, any>; shapes: THREE.ShaderMaterial[]; triggers: Trigger[]; last: Record<string, number> }

let dot: THREE.Texture | null = null;
const dots = new Map<number, THREE.Texture>();
/** Godot's particle dot (alpha falling linearly from the centre to the rim), alpha raised to `g`: the
 *  compiler's per-layer exponent, so the web's sRGB blend reads like Godot's linear-light one. */
function godotDot(g: number): THREE.Texture {
  const k = Math.round(g * 1000) / 1000;
  if (dots.has(k)) return dots.get(k)!;
  const n = 64, c = document.createElement('canvas'); c.width = c.height = n;
  const x = c.getContext('2d')!, img = x.createImageData(n, n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const r = Math.hypot((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) * 2;
    const o = (j * n + i) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = Math.round(255 * Math.pow(Math.max(0, 1 - r), k));
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  dots.set(k, t);
  return t;
}
/** A soft round particle (white → clear), drawn once. */
function softDot(): THREE.Texture {
  if (dot) return dot;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!, g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.5, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  dot = new THREE.CanvasTexture(c);
  return dot;
}

export class StudioEffects {
  batch = new BatchedRenderer();
  live: Record<string, Live> = {};
  values: Record<string, number> = {};
  /** bursts fired so far, by "effect:layer" (play-tests read it) */
  fired: Record<string, number> = {};
  time = 0;
  constructor(private g: StudioGame) { g.scene.add(this.batch); }

  add(file: FxFile): Live {
    const root = new THREE.Group();
    root.name = `effect:${file.def.id}`;
    root.position.set(...file.at);
    this.g.scene.add(root);
    const emitters: Record<string, any> = {};
    if (file.quarks) {
      const obj = new QuarksLoader().parse(file.quarks, () => {}) as THREE.Object3D;
      const list: any[] = [];
      obj.traverse((o: any) => { if (o.type === 'ParticleEmitter') list.push(o); });
      root.add(obj);
      for (const e of list) {
        const sys = e.system;
        sys.material.map = typeof e.userData?.dot === 'number' ? godotDot(e.userData.dot) : softDot();
        sys.material.needsUpdate = true;
        this.batch.addSystem(sys);
        emitters[e.userData?.layer ?? e.name] = e;
        if (e.userData?.oneShot) sys.pause();
      }
    }
    const shapes: THREE.ShaderMaterial[] = [];
    for (const l of file.def.layers) {
      if (l.kind !== 'shape') continue;
      const form = { flame: 0, ring: 1, arc: 2, puff: 3 }[l.mesh as string] ?? 0;
      const n = l.count ?? 1, off: V3 = l.offset ?? [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const mat = new THREE.ShaderMaterial({
          vertexShader: file.shader.vertex, fragmentShader: file.shader.fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
          blending: l.blend === 'add' ? THREE.AdditiveBlending : THREE.NormalBlending,
          uniforms: {
            col_a: { value: new THREE.Color(file.colours[l.colour[0]]) }, col_b: { value: new THREE.Color(file.colours[l.colour[1]]) },
            time: { value: 0 }, scroll: { value: l.scroll ?? 1 }, noise_amt: { value: l.noise ?? 0.5 }, flicker: { value: l.flicker ?? 0 },
            alpha_mul: { value: l.alpha ?? 1 }, seed: { value: +(i * 3.17).toFixed(2) }, value: { value: 1 }, form: { value: form },
          },
        });
        shapes.push(mat);
        const geo = new THREE.PlaneGeometry(l.size[0], l.size[1]);
        geo.translate(0, l.size[1] / 2, 0);
        const ang = n > 1 ? (i / n) * Math.PI * 2 : 0, r = n > 1 ? l.size[0] * 0.3 : 0;
        for (const rot of [0, Math.PI / 2]) {
          const m = new THREE.Mesh(geo, mat);
          m.name = `${l.id}_${i}`;
          m.position.set(off[0] + Math.sin(ang) * r, off[1], off[2] + Math.cos(ang) * r);
          m.rotation.y = rot + ang;
          m.renderOrder = 2;
          m.frustumCulled = false;
          root.add(m);
        }
      }
    }
    const fx: Live = { id: file.def.id, root, file, emitters, shapes, triggers: file.def.triggers ?? [], last: {} };
    this.live[fx.id] = fx;
    if (file.def.value) this.applyValue(fx, this.values[file.def.value.name] ?? file.def.value.default ?? 1);
    return fx;
  }

  /** A game value (0..1) that effects follow: a fire's size, rain's strength. */
  setValue(name: string, v: number) {
    this.values[name] = Math.max(0, Math.min(1, v));
    for (const fx of Object.values(this.live)) if (fx.file.def.value?.name === name) this.applyValue(fx, this.values[name]);
  }
  private applyValue(fx: Live, v: number) {
    for (const e of Object.values(fx.emitters)) if (e.userData?.rate) e.system.emissionOverTime = new ConstantValue(e.userData.rate * v);
    for (const m of fx.shapes) m.uniforms.value.value = v;
  }

  /** Fire a burst layer now (sparks, embers). */
  burst(id: string, layer?: string) {
    const fx = this.live[id];
    if (!fx) return;
    for (const [k, e] of Object.entries(fx.emitters)) if (!layer || k === layer) { e.system.restart(); e.system.play(); this.fired[`${id}:${k}`] = (this.fired[`${id}:${k}`] ?? 0) + 1; }
  }
  /** A game event: every trigger listening for it fires ("fed" → the ember puff). */
  event(name: string) {
    for (const fx of Object.values(this.live)) for (const t of fx.triggers) if (t.on === name) this.burst(fx.id, t.layer);
  }
  /** Show or hide an effect. Hidden particle systems leave the batch (the batch draws every system it holds). */
  show(id: string, on: boolean) {
    const fx = this.live[id];
    if (!fx || fx.root.visible === on) return;
    fx.root.visible = on;
    for (const e of Object.values(fx.emitters)) { if (on) this.batch.addSystem(e.system); else this.batch.deleteSystem(e.system); }
  }

  update(dt: number) {
    this.time += dt;
    for (const fx of Object.values(this.live)) for (const m of fx.shapes) m.uniforms.time.value = this.time;
    this.motionTriggers();
    this.batch.update(dt);
  }

  /** "Blacksmith:hammer-strike@impact": fire when that character's clip crosses the moment. */
  private motionTriggers() {
    const actors = this.g.characters?.actors ?? {};
    for (const fx of Object.values(this.live)) for (const t of fx.triggers) {
      if (!t.character || !t.clip || t.fraction === undefined) continue;
      const a = actors[t.character] ?? Object.entries(actors).find(([k]) => k.toLowerCase() === t.character!.toLowerCase())?.[1];
      const act = a?.action(t.clip);
      if (!act || !act.isRunning()) { fx.last[t.on] = -1; continue; }
      const d = act.getClip().duration, at = t.fraction * d, now = act.time, prev = fx.last[t.on] ?? -1;
      if (prev >= 0 && ((prev < at && now >= at) || (now < prev && (at > prev || at <= now)))) this.burst(fx.id, t.layer);
      fx.last[t.on] = now;
    }
  }
}

/** Load every studio effect (assets/studio/effects/), warm it up (shaders compiled before play), and
 *  hook its update into the game's character update. */
export async function startEffects(g: StudioGame): Promise<StudioEffects> {
  if ((g as any).effects) return (g as any).effects;
  const fx = new StudioEffects(g);
  (g as any).effects = fx;
  const res = await fetch('assets/studio/effects/effects.json').catch(() => null);
  const list: any[] = res?.ok ? await res.json().catch(() => []) : [];
  for (const m of list) {
    const r = await fetch(`assets/studio/effects/${m.file}`).catch(() => null);
    if (r?.ok) fx.add(await r.json());
  }
  // warm-up: compile every material now and run one frame, so the first fire or burst never stutters
  if (list.some((m) => m.warmup !== false)) {
    for (const l of Object.values(fx.live)) for (const e of Object.values(l.emitters)) if (e.userData?.oneShot) e.system.play();
    fx.update(1 / 60);
    g.renderer.compile(g.scene, g.camera);
    for (const l of Object.values(fx.live)) for (const e of Object.values(l.emitters)) if (e.userData?.oneShot) { e.system.restart(); e.system.pause(); }
  }
  const sc = g.characters;
  if (sc) { const base = sc.update; sc.update = (dt: number) => { base(dt); fx.update(dt); }; }
  return fx;
}
