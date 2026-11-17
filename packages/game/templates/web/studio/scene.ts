// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// Scripted scenes (an intro, an ending, a cutscene the game drives itself): two small things they all need.
//
// 1. One owner per body. While a script moves a character, everything else that writes to it (the play
//    controller, idle life, foot planting, look-at, landing shake) must be off, or the body shakes: two writers
//    take turns every frame. The script takes the body; every other writer asks `mine()` before it writes.
//      take(hero, 'intro');  …  give(hero, 'intro');
//      if (mine(hero, 'controller')) controller.update(hero, dt);
//    Props and the camera are bodies too.
//
// 2. The probe `studio game scene-check` reads: where each body is, the way it faces, its clip, a few bones,
//    the camera, every fixed step. installSceneProbe() puts it on window.__scene.
// No imports: bodies are anything with a three.js world matrix.

interface Node3 { matrixWorld: { elements: ArrayLike<number> }; updateWorldMatrix(parents: boolean, children: boolean): void }
interface Cam3 extends Node3 { projectionMatrix: { elements: ArrayLike<number> }; matrixWorldInverse: { elements: ArrayLike<number> } }

// ── one owner per body ───────────────────────────────────────────────────
const owners = new WeakMap<object, string>();
/** `who` takes the body: until it gives it back, mine() is false for everyone else. Taking a body someone else holds throws. */
export function take(body: object, who: string): void {
  const cur = owners.get(body);
  if (cur && cur !== who) throw new Error(`${who} takes a body that ${cur} still owns: give it back first`);
  owners.set(body, who);
}
/** Give the body back (only its owner can). */
export function give(body: object, who: string): void {
  const cur = owners.get(body);
  if (cur && cur !== who) throw new Error(`${who} gives back a body that ${cur} owns`);
  owners.delete(body);
}
export const ownerOf = (body: object): string | null => owners.get(body) ?? null;
/** May `who` write to this body now? True when nobody owns it or `who` does. */
export const mine = (body: object, who: string): boolean => { const cur = owners.get(body); return !cur || cur === who; };

// ── the probe ────────────────────────────────────────────────────────────
export interface ProbeBody {
  root: Node3;
  /** the clip that plays now (the base clip, not a part clip laid over it) */
  clip?: () => string;
  /** bones to watch, by any name: head, hips, hands, feet */
  bones?: Record<string, Node3 | null | undefined>;
  /** which of them are feet (default: names with foot, toe or paw) */
  feet?: string[];
  /** radius for "bodies inside each other"; null where overlap is meant (a lap, a carried thing) */
  r?: number | (() => number | null);
  scale?: () => number;
  floor?: () => number;
  /** true when this clip may travel although its name does not say so */
  gait?: () => boolean | undefined;
  /** the heading in radians, if the root's own +Z is not the way it faces */
  heading?: () => number;
}
export interface SceneProbe {
  /** the beat that plays now; null or '' when the scene is not running */
  beat: () => string | null;
  /** advance the game by dt seconds of game time (never real time) and draw when asked */
  step: (dt: number, draw: boolean) => void;
  start?: () => void | Promise<void>;
  bodies: Record<string, ProbeBody>;
  camera?: Cam3 | (() => Cam3);
  /** contacts the script claims now: the distance from the hand to what it touches */
  contacts?: () => Array<{ name: string; d: number; max?: number }>;
  /** true on a step the script cuts */
  cut?: () => boolean;
}

const pos = (o: Node3): number[] => { o.updateWorldMatrix(true, false); const e = o.matrixWorld.elements; return [e[12], e[13], e[14]]; };
const xform = (m: ArrayLike<number>, v: number[]) => { const [x, y, z] = v, w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1; return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, (m[2] * x + m[6] * y + m[10] * z + m[14]) / w]; };
const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));

/** What the probe says now (also on its own, for a test or a still). */
export function probeScene(o: SceneProbe, view: { width: number; height: number } = { width: globalThis.innerWidth ?? 960, height: globalThis.innerHeight ?? 540 }) {
  const beat = o.beat();
  if (!beat) return null;
  const cam = typeof o.camera === 'function' ? o.camera() : o.camera;
  const screen: number[][] = [];
  const see = (p: number[]) => { if (!cam) return; const n = xform(cam.projectionMatrix.elements, xform(cam.matrixWorldInverse.elements, p)); if (Math.abs(n[2]) <= 1) screen.push([Math.round((n[0] + 1) / 2 * view.width), Math.round((1 - n[1]) / 2 * view.height)]); };
  const bodies: Record<string, any> = {};
  for (const [name, b] of Object.entries(o.bodies)) {
    const p = pos(b.root), e = b.root.matrixWorld.elements, r = typeof b.r === 'function' ? b.r() : b.r;
    const bones: Record<string, number[] | null> = {};
    for (const [k, n] of Object.entries(b.bones ?? {})) { bones[k] = n ? r4(pos(n)) : null; if (n) see(pos(n)); }
    see(p);
    const gait = b.gait?.();
    bodies[name] = { p: r4(p), h: +(b.heading ? b.heading() : Math.atan2(e[8], e[10])).toFixed(4), ...(b.clip ? { clip: b.clip() } : {}), ...(b.scale ? { scale: b.scale() } : {}), ...(b.floor ? { floor: b.floor() } : {}), ...(gait !== undefined ? { gait } : {}), ...(r !== undefined ? { r } : {}), ...(b.bones ? { bones } : {}), ...(b.feet ? { feet: b.feet } : {}) };
  }
  let camOut: { p: number[]; f: number[] } | undefined;
  if (cam) { cam.updateWorldMatrix(true, false); const e = cam.matrixWorld.elements, l = Math.hypot(e[8], e[9], e[10]) || 1; camOut = { p: r4([e[12], e[13], e[14]]), f: r4([-e[8] / l, -e[9] / l, -e[10] / l]) }; }
  const contacts = o.contacts?.() ?? [];
  return { beat, bodies, ...(camOut ? { cam: camOut } : {}), ...(o.cut?.() ? { cut: true } : {}), ...(contacts.length ? { contacts } : {}), ...(screen.length ? { screen } : {}) };
}

/** Put the probe on window.__scene for `studio game scene-check`. */
export function installSceneProbe(o: SceneProbe): void {
  (globalThis as any).__scene = {
    start: () => o.start?.(),
    step(dt: number, draw: boolean) { o.step(dt, draw); return probeScene(o); },
  };
}
