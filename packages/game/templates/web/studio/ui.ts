// Managed by the studio — overwritten by `studio game init/import`. Don't edit; your code goes in src/.
// The studio UI kit in a web game (Decision 58): an HTML overlay styled by assets/studio/ui/ui.css (the
// kit's tokens), the HUD from the studio layout, speech bubbles that follow a 3D character, and say():
//   const ui = await startUI(game);          ui.setBar('heat', 0.4);   ui.setText('score', 'Blades: 3');
//   await say(game, 'Blacksmith', 'good-lad');   // voice + mouth clip + bubble, in sync
import * as THREE from 'three';
import type { StudioGame } from './harness.ts';

type V3 = [number, number, number];
interface El { id: string; part: string; x: number; y: number; w: number; h: number; text?: string; icon?: string; value?: number; anchor?: string; style?: { size?: number; fill?: string; ink?: string; pad?: number } }
const cssVar = (k: string) => `var(--ui-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)})`;
interface Kit { tokens: any; layout: El[]; icons: string[]; profile: string }
const BASE = 'assets/studio/ui/';
const REF = { w: 1280, h: 720 };

interface Bubble { el: HTMLDivElement; target: THREE.Object3D; height: number; until: number }

export class StudioUI {
  root: HTMLDivElement;
  els: Record<string, HTMLElement> = {};
  bubbles: Bubble[] = [];
  constructor(private g: StudioGame, public kit: Kit | null) {
    this.root = document.createElement('div');
    this.root.className = 'ui-root';
    document.body.appendChild(this.root);
    addEventListener('resize', () => this.layout());
  }
  /** seconds: the game's clock when it keeps one (g.time, advanced by your tick — so stepped captures
   *  and pauses time bubbles right), else the wall clock */
  now() { const t = (this.g as any).time; return typeof t === 'number' ? t : performance.now() / 1000; }
  /** px per reference px: the HUD is laid out at 1280×720 and scales with the screen height */
  get k() { return innerHeight / REF.h; }

  /** Build the HUD from the studio layout (or call the part makers yourself). */
  hud() { for (const e of this.kit?.layout ?? []) this.add(e); this.layout(); return this; }

  add(e: El): HTMLElement {
    const d = document.createElement(e.part === 'button' ? 'button' : 'div');
    d.className = `ui-${e.part}`;
    d.dataset.id = e.id;
    if (e.part === 'bar') { d.innerHTML = '<div class="fill"></div><div class="text"></div>'; (d.querySelector('.text') as HTMLElement).textContent = e.text ?? ''; }
    else if (e.part === 'slot') { if (e.icon) { const img = document.createElement('img'); img.src = `${BASE}icons/${e.icon}.svg`; img.alt = e.icon.replace(/-/g, ' '); d.appendChild(img); } }
    else if (e.part === 'card') { const h = document.createElement('h1'); h.textContent = e.text ?? ''; d.appendChild(h); }
    else d.textContent = e.text ?? '';
    (d as any).__el = e;
    this.root.appendChild(d);
    this.els[e.id] = d;
    if (e.part === 'bar') this.setBar(e.id, e.value ?? 1);
    return d;
  }
  layout() {
    const k = this.k;
    for (const d of Object.values(this.els)) {
      const e: El = (d as any).__el;
      const s = d.style, a = e.anchor ?? 'tl';
      s.width = `${e.w * k}px`; s.height = `${e.h * k}px`; s.fontSize = `${k * (e.part === 'bar' || e.part === 'tooltip' ? 0.85 : 1)}em`;   // as the review sheet draws it
      s.left = s.right = s.top = s.bottom = '';
      if (a === 'center') { s.left = `calc(50% + ${(e.x + e.w / 2 - REF.w / 2 - e.w / 2) * k}px)`; s.top = `calc(50% + ${(e.y + e.h / 2 - REF.h / 2 - e.h / 2) * k}px)`; }
      else {
        if (a.includes('r')) s.right = `${(REF.w - e.x - e.w) * k}px`; else s.left = `${e.x * k}px`;
        if (a.includes('b')) s.bottom = `${(REF.h - e.y - e.h) * k}px`; else s.top = `${e.y * k}px`;
      }
      if (e.part === 'bar' || e.part === 'label' || e.part === 'tooltip') s.lineHeight = `${e.h * k - 6}px`;
      // the element's own tokens (picked in the studio view): text size, palette fill and ink, padding
      const st = e.style;
      if (st?.size) s.fontSize = `${st.size * k}px`;
      if (st?.fill) { if (e.part === 'bar') (d.querySelector('.fill') as HTMLElement | null)?.style.setProperty('background', cssVar(st.fill)); else s.background = cssVar(st.fill); }
      if (st?.ink) { s.color = cssVar(st.ink); const tx = d.querySelector('.text, h1') as HTMLElement | null; if (tx) tx.style.color = cssVar(st.ink); }
      if (st?.pad !== undefined) s.padding = e.part === 'slot' || e.part === 'card' ? `${st.pad * k}px` : `0 ${st.pad * k}px`;
    }
  }
  setBar(id: string, v: number) { const f = this.els[id]?.querySelector('.fill') as HTMLElement | null; if (f) f.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`; }
  setText(id: string, t: string) { const d = this.els[id]; if (!d) return; const x = d.querySelector('.text') ?? d.querySelector('h1') ?? d; x.textContent = t; }
  /** A title or end card in the middle of the screen. */
  card(title: string, sub = ''): HTMLElement {
    const d = this.add({ id: `card-${title}`, part: 'card', x: 340, y: 230, w: 600, h: 220, text: title, anchor: 'center' });
    if (sub) { const p = document.createElement('p'); p.textContent = sub; d.appendChild(p); }
    this.layout();
    return d;
  }
  /** A speech bubble over a 3D object (a character), following it every frame until `seconds` pass. */
  bubble(target: THREE.Object3D, text: string, seconds = 3): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'ui-bubble';
    el.textContent = text;
    this.root.appendChild(el);
    const box = new THREE.Box3().setFromObject(target);
    const wp = target.getWorldPosition(new THREE.Vector3());
    this.bubbles.push({ el, target, height: (box.isEmpty() ? 1.8 : box.max.y - wp.y) + 0.12, until: this.now() + seconds });
    this.update();
    return el;
  }
  /** Bubbles follow their character: call every frame (startUI hooks it into the render loop). */
  update(cam: THREE.Camera = this.g.camera) {
    const now = this.now();
    const w = this.g.renderer.domElement.clientWidth || innerWidth, h = this.g.renderer.domElement.clientHeight || innerHeight;
    this.bubbles = this.bubbles.filter((b) => {
      if (now > b.until) { b.el.remove(); return false; }
      const p = b.target.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, b.height, 0)).project(cam);
      const vis = p.z < 1 && p.z > -1;
      b.el.style.display = vis ? '' : 'none';
      // keep the bubble on screen (inside a 16 px margin) even when the head is near an edge
      const x = Math.min(w - 16 - b.el.offsetWidth / 2, Math.max(16 + b.el.offsetWidth / 2, (p.x * 0.5 + 0.5) * w));
      const y = Math.max(16 + b.el.offsetHeight, (-p.y * 0.5 + 0.5) * h);
      b.el.style.left = `${x}px`; b.el.style.top = `${y}px`;
      return true;
    });
  }
}

/** Load the studio UI kit (ui.css, font, icons) and build the HUD. Bubbles track their characters. */
export async function startUI(g: StudioGame, opts: { hud?: boolean } = {}): Promise<StudioUI> {
  if ((g as any).ui) return (g as any).ui;
  const res = await fetch(`${BASE}ui.json`).catch(() => null);
  const kit: Kit | null = res?.ok ? await res.json().catch(() => null) : null;
  if (kit && !document.querySelector('link[data-studio-ui]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = `${BASE}ui.css`; l.dataset.studioUi = '1';
    document.head.appendChild(l);
    await new Promise((r) => { l.onload = l.onerror = r; });
    await (document as any).fonts?.ready;
  }
  const ui = new StudioUI(g, kit);
  (g as any).ui = ui;
  if (opts.hud !== false) ui.hud();
  const tick = () => { ui.update(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return ui;
}

let lines: Record<string, Record<string, { text: string; clip: string; duration: number; sync: number; file: string | null }>> | null = null;

/** A character says one of its studio lines: the voice, the mouth and body clip (line:<id>), and a
 *  bubble with the words over their head — kept in sync with the line's measured lip-sync offset.
 *  Resolves when the line ends. Fire's Dying pains #8 (say by hand) and #13 (mouth early). */
export async function say(g: StudioGame, character: string, lineId: string, opts: { bubble?: boolean; audio?: boolean } = {}): Promise<void> {
  if (!lines) { const r = await fetch('assets/studio/lines/lines.json').catch(() => null); lines = r?.ok ? await r.json() : {}; }
  const all = lines!;
  const who = all[character] ?? Object.entries(all).find(([k]) => k.toLowerCase() === character.toLowerCase())?.[1];
  const l = who?.[lineId];
  if (!l) throw new Error(`${character} has no line "${lineId}" (have: ${Object.keys(who ?? {}).join(', ') || 'none'}; studio game import exports every recorded line)`);
  // sync: ms the mouth trails the voice (negative: the mouth leads) — delay whichever is early
  const mouthDelay = Math.max(0, -l.sync) / 1000, voiceDelay = Math.max(0, l.sync) / 1000;
  const actor = g.characters?.actors[character] ?? Object.values(g.characters?.actors ?? {}).find((a) => a.name.toLowerCase() === character.toLowerCase());
  actor?.play(l.clip, { once: true, fade: 0.12, delay: mouthDelay });
  if (opts.audio !== false && l.file) {
    const a = new Audio(`assets/studio/lines/${l.file}`);
    setTimeout(() => { a.play().catch(() => { /* autoplay blocked until the player clicks */ }); }, voiceDelay * 1000);
  }
  if (opts.bubble !== false) {
    const ui = (g as any).ui as StudioUI | undefined;
    if (ui && actor) ui.bubble(actor.root.getObjectByProperty('isSkinnedMesh', true) ?? actor.root, l.text, l.duration + 0.6);
  }
  await new Promise((r) => setTimeout(r, (l.duration + Math.max(mouthDelay, voiceDelay)) * 1000));
}
