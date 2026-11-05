// Looks with sliders (Phase 10 step 3): when a look is active the view shows the knobs that matter
// (exposure, white balance, contrast, saturation, fog, the sun, night lamps and glow). Dragging
// previews live in the viewport (the record is re-graded here, nothing is sent); releasing becomes
// one labelled step through look-set ("warmer: white balance 6200 K → 5600 K"). "Point" pins a note
// on a spot of the picture; "Show me three" asks for three distinct grades and lays them side by side.
import * as THREE from 'three';
import { knobsFor, knob, knobStep, turnKnob, lookTakes, type Knob } from '../../../../packages/core/src/look/knobs.ts';
import { parseLook, engineLight, buildLut, type Look } from '../../../../packages/core/src/look/look.ts';
import { lutTexture, installGradePass } from '../../../../packages/game/templates/web/studio/look.ts';
import type { ViewHost } from './host.ts';

const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const GROUPS: Record<Knob['group'], string> = { grade: 'Grade', fog: 'Fog', sun: 'Sun', night: 'Night lights' };
const CHIPS = ['too dark here', 'too bright here', 'too orange', 'muddy', 'lost in the fog'];

export class LookPanel {
  host: ViewHost;
  look: Look | null = null;              // the active look on main, as the engine has it
  preview: Look | null = null;           // the look while a slider is held
  dragging: string | null = null;
  pointing = false;
  pending: { point: THREE.Vector3; screen: [number, number]; thing: string; words: string } | null = null;
  fullLook = true;                       // sky, fog, sun and lamps as well as the grade
  private sun = new THREE.DirectionalLight('#ffffff', 1);
  private amb = new THREE.AmbientLight('#ffffff', 0.5);
  private saved: { bg: any; env: number; lights: Array<[THREE.Light, number]> } | null = null;
  private applied = '';
  threeShots: Record<string, string> = {};   // take label → thumbnail (data URL)
  private shotKey = '';

  constructor(host: ViewHost) {
    this.host = host;
    this.sun.userData.studioLook = true; this.amb.userData.studioLook = true;
    this.sun.castShadow = true; this.sun.shadow.mapSize.set(2048, 2048); this.sun.shadow.bias = -0.0004;
  }

  /** The look being shown (the held slider's preview, or main's). */
  shown(): Look | null { return this.preview ?? this.look; }

  onState(rec: any | null) {
    try { this.look = rec ? parseLook(rec) : null; } catch { this.look = null; }
    if (!this.dragging) this.preview = null;
  }

  // ── the panel ─────────────────────────────────────────────────────────────────────────────────
  html(takes: any[], proposals: any[]): string {
    const L = this.shown();
    if (!L) return '';
    const ks = knobsFor(L);
    const groups = [...new Set(ks.map((k) => k.group))];
    const row = (k: Knob) => {
      const v = k.get(L);
      return `<div class="lk-row" title="${esc(k.words.join(' / '))}"><div class="lk-top"><span>${esc(k.label)}</span><b data-knob-val="${k.id}">${esc(k.fmt(v))}</b></div>
        <input type="range" data-knob="${k.id}" min="${k.min}" max="${k.max}" step="${k.step}" value="${v}"${k.id === 'white-balance' || k.id === 'sun-colour' ? ' class="kelvin"' : ''}></div>`;
    };
    const three = this.threeHtml(takes, proposals);
    return `<div class="lk"><div class="lk-head"><span class="label">Look · <b>${esc(L.name)}</b></span>
      <span class="lk-btns"><button data-act="look-point" class="${this.pointing ? 'on' : ''}" title="Click a spot in the picture to pin a note on what's there">Point</button><button data-act="look-three" title="Three deliberately different grades, side by side">Show me three</button></span></div>
      <label class="lk-full"><input type="checkbox" data-act="look-full"${this.fullLook ? ' checked' : ''}> sky, fog, sun and lamps too (not only the grade)</label>
      ${this.pointing ? '<div class="lk-hint">Click the picture where it looks wrong. The note pins on the thing under it.</div>' : ''}
      ${groups.map((g) => `<div class="lk-group"><div class="lk-g">${GROUPS[g]}</div>${ks.filter((k) => k.group === g).map(row).join('')}</div>`).join('')}
      <div class="lk-foot">Drag to preview · release = one step</div>${three}</div>`;
  }

  /** The open "show me three" for a look: three thumbnails of the same view, per-section compare, a pick card. */
  threeHtml(takes: any[], proposals: any[]): string {
    const g = takes.find((t) => t.status === 'open' && t.takes.every((x: any) => proposals.find((p) => p.id === x.proposal)?.look));
    if (!g) return '';
    const sec = (g.sections ?? []).slice(0, 6);
    return `<div class="lk-three" data-group="${esc(g.id)}"><div class="lk-g">Show me three · ${esc(g.title)}</div><div class="lk-takes">${g.takes.map((t: any) => `<div class="lk-take"><img alt="${esc(t.label)}" src="${this.threeShots[t.label] ?? ''}"><div class="lk-tl">${esc(t.label)}</div><div class="lk-tr">${esc((t.traits ?? []).join(' · '))}</div><button data-act="look-pick" data-group="${esc(g.id)}" data-take="${esc(t.label)}">Pick this</button></div>`).join('')}</div>
      <table class="lk-cmp">${sec.map((s: any) => `<tr><th>${esc(s.section)}</th>${g.takes.map((t: any) => `<td>${(s.takes[t.label] ?? []).slice(0, 3).map((l: string) => esc(l.replace(/^[^:]*?(\w+): /, '$1: '))).join('<br>')}</td>`).join('')}</tr>`).join('')}</table>
      <div class="lk-foot">The pick is committed whole; the other two are dropped. <button class="ghost" data-act="look-drop" data-group="${esc(g.id)}">None of these</button></div></div>`;
  }

  /** Render the current viewport once per take, each under its own grade (for the side-by-side). */
  shootThree(takes: any[], proposals: any[], shoot: (look: Look) => string) {
    const g = takes.find((t) => t.status === 'open' && t.takes.every((x: any) => proposals.find((p) => p.id === x.proposal)?.look));
    if (!g) { this.threeShots = {}; this.shotKey = ''; return false; }
    const key = g.id + g.takes.map((t: any) => t.proposal).join();
    if (key === this.shotKey) return false;
    this.shotKey = key;
    for (const t of g.takes) this.threeShots[t.label] = shoot(parseLook(proposals.find((p) => p.id === t.proposal).look));
    return true;
  }

  // ── events ────────────────────────────────────────────────────────────────────────────────────
  onInput(el: HTMLInputElement): boolean {
    const id = el.dataset.knob;
    if (!id || !this.look) return false;
    this.dragging = id;
    const v = Number(el.value);
    this.preview = turnKnob(this.look, id, v);
    const lab = document.querySelector(`[data-knob-val="${id}"]`);
    if (lab) lab.textContent = knob(id).fmt(v);
    this.host.setLookPreview(this.preview);
    return true;
  }

  onChange(el: HTMLInputElement): boolean {
    const id = el.dataset.knob;
    if (!id || !this.look) return false;
    this.dragging = null;
    const st = knobStep(this.look, id, Number(el.value));
    if (!st) { this.preview = null; this.host.setLookPreview(null); return true; }
    // keep the preview up until the engine's state comes back with the step in it
    this.host.call('look-set', { look: this.look.name, set: st.set }, st.why);
    this.host.toast(st.why);
    return true;
  }

  onAct(t: HTMLElement): boolean {
    const d = t.dataset;
    switch (d.act) {
      case 'look-point': this.pointing = !this.pointing; this.pending = null; this.host.rerender(); return true;
      case 'look-full': this.fullLook = (t as HTMLInputElement).checked; this.applied = ''; this.host.rerender(); return true;
      case 'look-three': if (this.look) { this.host.call('show-three', { title: `${this.look.name} grade`, topic: 'look-grade', takes: lookTakes(this.look) }); this.host.toast('Three grades coming…'); } return true;
      case 'look-pick': this.host.call('pick-take', { group: d.group, take: d.take, opened: undefined }); this.threeShots = {}; return true;
      case 'look-drop': this.host.call('pick-take', { group: d.group, drop: true }); this.threeShots = {}; return true;
      case 'look-note': this.sendNote(d.words ?? ''); return true;
      case 'look-note-cancel': this.pending = null; this.host.rerender(); return true;
    }
    return false;
  }

  /** In point mode a click pins a note there: on the thing under it, with the spot and the look. */
  onPick(hit: { point: THREE.Vector3; thing: string } | null, screen: [number, number]): boolean {
    if (!this.pointing || !this.look) return false;
    this.pending = { point: hit?.point ?? new THREE.Vector3(), screen, thing: hit?.thing ?? `look:${this.look.name}`, words: '' };
    this.host.rerender();
    return true;
  }

  /** The little "what's wrong here?" bubble at the spot. */
  bubbleHtml(vp: DOMRect): string {
    if (!this.pending) return '';
    const [x, y] = this.pending.screen;
    return `<div class="lk-bubble" style="left:${(x * vp.width).toFixed(0)}px;top:${(y * vp.height).toFixed(0)}px"><div class="lk-bq">What's wrong here? <span>on ${esc(this.host.thingWords(this.pending.thing))}</span></div>
      <div class="lk-chips">${CHIPS.map((c) => `<button data-act="look-note" data-words="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <input type="text" id="lookNoteDraft" placeholder="or in your words…"><button data-act="look-note-cancel" class="ghost">Cancel</button></div>`;
  }

  sendNote(words: string) {
    if (!this.pending || !this.look) return;
    const text = words.trim() || (document.getElementById('lookNoteDraft') as HTMLInputElement | null)?.value.trim() || '';
    if (!text) return;
    const p = this.pending.point;
    this.host.call('notes', { action: 'add', text, at: { thing: this.pending.thing, clock: 'none' }, region: { look: this.look.name, point: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)], screen: this.pending.screen.map((v) => +v.toFixed(3)) } });
    this.host.toast(`Pinned "${text}"`);
    this.pending = null; this.pointing = false;
    this.host.rerender();
  }

  // ── the full look in the viewport: sky, fog, sun, ambient, lamps, glow ───────────────────────────
  /** Apply (or remove) the look's sky, fog and light to the view's scene. `stage` = the view's own lights. */
  applyScene(scene: THREE.Scene, stage: THREE.Light[], town: THREE.Object3D | null, themeBg: () => THREE.Color) {
    const L = this.fullLook ? this.shown() : null;
    const key = L ? JSON.stringify([L.sky, L.fog, L.light, L.materials, !!town]) : '';
    if (key === this.applied) return;
    this.applied = key;
    if (!L) {
      if (this.saved) {
        scene.background = this.saved.bg; scene.environmentIntensity = this.saved.env;
        for (const [l, i] of this.saved.lights) l.intensity = i;
        this.saved = null;
      }
      scene.fog = null; scene.remove(this.sun, this.amb, this.sun.target);
      if (!town) scene.background = themeBg();
      tweakMaterials(town, {});
      return;
    }
    if (!this.saved) this.saved = { bg: scene.background, env: scene.environmentIntensity, lights: stage.map((l) => [l, l.intensity]) };
    for (const l of stage) l.intensity = 0;
    scene.environmentIntensity = 0.12;   // a little room light keeps models readable; the look's light does the rest
    scene.background = new THREE.Color(L.sky.color);
    scene.fog = L.fog.enabled ? new THREE.Fog(L.fog.color, L.fog.begin, L.fog.end) : null;
    const D = engineLight(L);
    this.sun.color.set(L.light.sun.color); this.sun.intensity = D.threeSunIntensity;
    this.amb.color.set(L.light.ambient.color); this.amb.intensity = D.threeAmbientIntensity;
    const R = town ? 400 : 6;
    this.sun.position.set(D.toSun[0] * R, D.toSun[1] * R, D.toSun[2] * R);
    Object.assign(this.sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: R * 0.02, far: R * 3 });
    (this.sun.shadow.camera as THREE.OrthographicCamera).updateProjectionMatrix();
    if (town) { const c = new THREE.Box3().setFromObject(town).getCenter(new THREE.Vector3()); this.sun.target.position.copy(c); this.sun.position.add(c); }
    if (!this.sun.parent) scene.add(this.sun, this.amb, this.sun.target);
    tweakMaterials(town, L.materials ?? {});
  }
}

/** Material tweaks by shading class (lit windows, lamps, LEDs, neon, signs, light pools), as the games do. */
export function tweakMaterials(root: THREE.Object3D | null, tweaks: Record<string, any>) {
  root?.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial & { userData: any };
    const cls = m.userData?.cls as string | undefined;
    if (!cls) return;
    const t = tweaks[cls];
    if (cls === 'pool') {
      const k = t?.emissionEnergy ?? 0, c = new THREE.Color(t?.emission ?? '#ffffff');
      (m as any).color.setRGB(c.r * k, c.g * k, c.b * k);
      o.visible = k > 0;
      return;
    }
    if (m.userData.picked) return;   // the selected building keeps its highlight
    if (t?.emission) { m.emissive.set(t.emission); m.emissiveIntensity = t.emissionEnergy ?? 1; } else { m.emissive.set('#000000'); m.emissiveIntensity = 0; }
  });
}

/** A grade-only render of the shown scene under one look (for the three thumbnails). */
export function shootUnder(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, look: Look, w = 240, h = 150): string {
  r.setSize(w, h, false);
  const L = { ...look, lutSize: 17 };
  const lut = buildLut(L);
  const tex = lutTexture(lut.data, lut.size);
  const pass = installGradePass(r, tex, { outline: look.outline });
  const bg = scene.background;
  scene.background = new THREE.Color(look.sky.color);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  scene.background = bg;
  pass.dispose(); tex.dispose();
  return url;
}
