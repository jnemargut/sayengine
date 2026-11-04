// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// The three.js cutscene player (Decision 24): reads a cutscene timeline (cutscene.json, written by the
// studio) and plays it on the studio scene's GLB — each character idles until a cue, eases into its
// line (the whole performed body) or action, and eases back; the camera follows the shots (cuts between
// shots, moves within one). `setTime(t)` is deterministic (frame-by-frame capture); `play()` is real time
// with the line audio. Web games use it as studio/cutscene.ts (and the studio's cutscene preview too).
// In your game: const p = new CutscenePlayer(game.studio, game.animations, await (await fetch(
// 'assets/studio/cutscenes/<id>.json')).json(), camera, 'assets/studio/cutscenes/audio/'); p.play();
// then p.update(dt) each frame and render with that camera until p.done.
import * as THREE from 'three';

type V3 = [number, number, number];
interface CamKey { position: V3; target: V3; fov: number }
export interface CutsceneTimeline {
  id: string; title?: string; duration: number;
  shots: Array<{ id: string; start: number; end: number; from: CamKey; to: CamKey; framing: string }>;
  cues: Array<{ t: number; end: number; character: string; name: string; clip: string; kind: 'line' | 'motion'; audio?: string; text?: string; shot: string }>;
  characters: Array<{ id: string; name: string; idle: string | null }>;
  events?: Array<{ t: number; name: string; shot: string }>;
}

/** Seconds of cross-fade into and out of a cue. */
export const FADE = { in: 0.22, out: 0.3 };
const ease = (u: number) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };

export class CutscenePlayer {
  mixer: THREE.AnimationMixer;
  private chars = new Map<string, { idle: THREE.AnimationAction | null; clips: Map<string, THREE.AnimationAction>; cues: CutsceneTimeline['cues'] }>();
  private audio = new Map<string, HTMLAudioElement>();
  private clock = 0; private playing = false; private started = new Set<number>(); private last = 0;
  onEvent: ((name: string) => void) | null = null;

  constructor(public root: THREE.Object3D, clips: THREE.AnimationClip[], public tl: CutsceneTimeline, public camera: THREE.PerspectiveCamera, public audioBase = 'audio/') {
    this.mixer = new THREE.AnimationMixer(root);
    for (const c of tl.characters) {
      const prefix = clips.some((k) => k.name.startsWith(`${c.id}:`)) ? `${c.id}:` : '';
      const get = (n: string) => clips.find((k) => k.name === prefix + n);
      const idleClip = get('idle');
      const idle = idleClip ? this.mixer.clipAction(idleClip) : null;
      const cues = tl.cues.filter((q) => q.character === c.id);
      const map = new Map<string, THREE.AnimationAction>();
      for (const q of cues) {
        const k = get(q.clip);
        if (!k || map.has(q.clip)) continue;
        const a = this.mixer.clipAction(k);
        a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true;
        map.set(q.clip, a);
      }
      this.chars.set(c.id, { idle, clips: map, cues });
    }
  }

  /** Pose every character and the camera at time t (s), deterministically. */
  setTime(t: number) {
    for (const [, c] of this.chars) {
      // the cue that owns this moment (with its fades); the idle fills the rest
      let w = 0, cur: CutsceneTimeline['cues'][number] | null = null;
      for (const q of c.cues) {
        const a = q.t, b = q.end;
        if (t < a || t > b + FADE.out) continue;
        const wq = Math.min(ease((t - a) / FADE.in), t > b ? 1 - ease((t - b) / FADE.out) : 1);
        if (wq >= w) { w = wq; cur = q; }
      }
      for (const [clip, act] of c.clips) {
        const on = !!cur && cur.clip === clip;
        act.enabled = on;
        if (on) { act.play(); act.paused = true; act.time = Math.min(act.getClip().duration, Math.max(0, t - cur!.t)); act.setEffectiveWeight(w); }
      }
      if (c.idle) {
        c.idle.enabled = w < 0.999;
        if (c.idle.enabled) { c.idle.play(); c.idle.paused = true; c.idle.time = t % c.idle.getClip().duration; c.idle.setEffectiveWeight(1 - w); }
      }
    }
    this.mixer.update(0);
    // camera: cut at shot boundaries, ease along the shot's move
    const sh = this.tl.shots.find((s) => t >= s.start && t < s.end) ?? this.tl.shots[this.tl.shots.length - 1];
    if (sh) {
      const k = ease((t - sh.start) / Math.max(1e-6, sh.end - sh.start));
      const lerp = (a: V3, b: V3) => new THREE.Vector3(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
      this.camera.position.copy(lerp(sh.from.position, sh.to.position));
      this.camera.fov = sh.from.fov + (sh.to.fov - sh.from.fov) * k;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(lerp(sh.from.target, sh.to.target));
    }
  }

  /** Real-time playback with the voices; call update(dt) every frame. */
  play(from = 0) { this.clock = from; this.playing = true; this.started.clear(); this.last = from; }
  stop() { this.playing = false; for (const a of this.audio.values()) a.pause(); }
  get time() { return this.clock; }
  get done() { return this.clock >= this.tl.duration; }
  update(dt: number) {
    if (!this.playing) return;
    this.clock = Math.min(this.tl.duration, this.clock + dt);
    this.tl.cues.forEach((q, i) => {
      if (q.audio && !this.started.has(i) && this.clock >= q.t) {
        this.started.add(i);
        let a = this.audio.get(q.audio);
        if (!a) { a = new Audio(`${this.audioBase}${q.audio}`); this.audio.set(q.audio, a); }
        a.currentTime = Math.max(0, this.clock - q.t); void a.play().catch(() => {});
      }
    });
    for (const e of this.tl.events ?? []) if (e.t > this.last && e.t <= this.clock) this.onEvent?.(e.name);
    this.last = this.clock;
    this.setTime(this.clock);
    if (this.done) this.playing = false;
  }
}
