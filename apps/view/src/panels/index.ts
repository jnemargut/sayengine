// The step-3 panels in one place (looks with sliders, towns you click to fix, the UI kit over the
// scene). main.ts calls a handful of hooks: onState, html, inspector, click, frame, pins, note target.
import * as THREE from 'three';
import { LookPanel } from './look.ts';
import { TownPanel, type TownState } from './town.ts';
import { UiPanel } from './ui.ts';
import { LifePanel, LIFE_CSS } from './life.ts';
import { esc, type ViewHost } from './host.ts';

export type { ViewHost } from './host.ts';

export class Panels {
  host: ViewHost;
  look: LookPanel; town: TownPanel; ui: UiPanel; life: LifePanel;
  private state: any = null;
  private bubble: HTMLDivElement;

  constructor(host: ViewHost) {
    this.host = host;
    this.look = new LookPanel(host);
    this.town = new TownPanel(host);
    this.ui = new UiPanel(host);
    this.life = new LifePanel(host);
    const st = document.createElement('style'); st.textContent = LIFE_CSS; document.head.appendChild(st);
    this.bubble = document.createElement('div');
    this.bubble.className = 'lk-bubble-layer';
    host.vpEl.appendChild(this.bubble);
    // sliders: input = preview, change = one step
    document.addEventListener('input', (e) => { const t = e.target as HTMLInputElement; if (t.dataset.knob) this.look.onInput(t); else if (t.dataset.uk) this.ui.onInput(t); else if (t.id === 'townWords') this.town.draft = t.value; else if (t.id === 'lifeWords') this.life.draft = t.value; });
    document.addEventListener('change', (e) => { const t = e.target as HTMLElement; if (t.dataset.knob) this.look.onChange(t as HTMLInputElement); else if (t.dataset.uk) this.ui.onChange(t as HTMLInputElement); else if (t.dataset.townSet) this.town.onSelectChange(t as HTMLSelectElement); });
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key !== 'Enter') return;
      if (t.id === 'townWords') { e.stopPropagation(); this.town.onAct(Object.assign(document.createElement('button'), { dataset: { act: 'town-words' } }) as any); }
      else if (t.id === 'lookNoteDraft') { e.stopPropagation(); this.look.sendNote(''); }
      else if (t.id === 'lifeWords') { e.stopPropagation(); this.life.onAct(Object.assign(document.createElement('button'), { dataset: { act: 'life-words' } }) as any); }
    }, true);
  }

  /** Who is selected in a panel (a building, a UI element), as an address for notes. */
  noteTarget(): { at: { thing: string; clock: string; at?: number; near?: string }; words: string } | null {
    const person = this.life.noteTarget();
    if (person) return person;
    if (this.town.selected && this.town.town) { const b = this.town.building(); return { at: { thing: `town:${this.town.town}/${this.town.selected}`, clock: 'none' }, words: `${this.town.town} / ${b?.label ?? this.town.selected}` }; }
    if (this.ui.selected) return { at: { thing: `ui/${this.ui.selected}`, clock: 'none' }, words: `UI kit / ${this.ui.selected}` };
    return null;
  }

  clearSelection() { if (this.life.selected !== null) { this.life.select(null); this.host.rerender(); } if (this.town.selected) this.town.select(null); if (this.ui.selected) { this.ui.selected = null; this.ui.draw(); } }

  onState(state: any) {
    this.state = state;
    this.look.onState(state.look ?? null);
    this.ui.onState(state.ui ?? null);
    const towns: TownState[] = state.towns ?? [];
    const branch = `${state.active}|${state.mainHead}|${(state.proposals ?? []).map((p: any) => p.id + ':' + p.steps.length).join(',')}`;
    void this.town.sync(towns, branch, (towns[0] as any)?.fixLayer ?? []);
    void this.life.sync(state.life ?? null);
    // three grades side by side: shoot the current view under each take's look
    if (this.look.shootThree(state.takes ?? [], state.proposals ?? [], (L) => this.shoot(L))) this.host.rerender();
  }

  private shoot(L: any): string { return this.host.shootUnder(L, 320, 200); }

  /** The panel above the inspector: the look's sliders, the town's chunk line, the UI kit's screens and checks. */
  html(): string {
    if (!this.state) return '';
    return [this.look.html(this.state.takes ?? [], this.state.proposals ?? []), this.town.chunkLine(), this.life.line(), this.ui.panelHtml()].filter(Boolean).join('<div class="pn-sep"></div>');
  }

  /** The inspector when a building or a UI element is selected (instead of a model's). */
  inspector(): { label: string; html: string } | null {
    if (this.life.person()) return { label: `Inspector · ${this.life.person()!.name}`, html: this.life.inspectorHtml() };
    if (this.town.selected && this.town.building()) {
      const models = (this.state?.main ?? []).filter((o: any) => o.role !== 'reference').map((o: any) => ({ id: o.id, name: o.name }));
      return { label: `Inspector · ${this.town.building()!.label}`, html: this.town.inspectorHtml(models) };
    }
    if (this.ui.selected && this.ui.element()) return { label: `Inspector · UI ${this.ui.selected}`, html: this.ui.inspectorHtml() };
    return null;
  }

  onAct(t: HTMLElement): boolean { return this.look.onAct(t) || this.town.onAct(t) || this.ui.onAct(t) || this.life.onAct(t); }

  /**
   * A click in the viewport. Point mode pins a note on what's under it; otherwise a building (closer
   * than any model) is selected. Returns true when the click was the panels'.
   */
  onClick(ray: THREE.Raycaster, objectHit: { obj: string; part: string | null; distance: number; point: THREE.Vector3 } | null, screen: [number, number]): boolean {
    const th = this.town.pick(ray);
    // a person in town (Phase 10 step 3b): in front of the building or model behind them
    const ph = this.look.pointing ? null : this.life.pick(ray);
    if (ph && (!th || ph.distance < th.distance + 0.5) && (!objectHit || ph.distance < objectHit.distance)) {
      this.ui.selected = null; if (this.town.selected) this.town.select(null);
      this.life.select(ph.i === this.life.selected ? null : ph.i);
      this.host.rerender();
      return true;
    }
    const townFirst = th && (!objectHit || th.distance < objectHit.distance);
    if (this.look.pointing) {
      const thing = townFirst ? (th!.worldId ? `town:${th!.town}/${th!.worldId}` : `town:${th!.town}`) : objectHit ? (objectHit.part ? `${objectHit.obj}/${objectHit.part}` : objectHit.obj) : `look:${this.look.look?.name ?? ''}`;
      return this.look.onPick({ point: (townFirst ? th!.point : objectHit?.point) ?? new THREE.Vector3(), thing }, screen);
    }
    if (townFirst && th!.worldId) { this.ui.selected = null; if (this.life.selected !== null) this.life.select(null); this.town.select(th!.worldId === this.town.selected ? null : th!.worldId); this.host.rerender(); return true; }
    if (objectHit) this.clearSelection();
    return false;
  }

  /** Every frame: the look's sky, fog and light, the UI overlay, the point bubble. */
  frame(themeBg: () => THREE.Color) {
    const stage = this.host.scene.children.filter((o: any) => o.isLight && !o.userData.studioLook) as THREE.Light[];
    this.look.applyScene(this.host.scene, stage, this.town.view ? this.town.group : null, themeBg);
    const grid = this.host.scene.children.find((o) => (o as any).isGridHelper);
    if (grid) grid.visible = !this.town.view;
    this.ui.draw();
    this.life.frame();
    const b = this.look.bubbleHtml(this.host.vpEl.getBoundingClientRect());
    if (this.bubble.dataset.html !== b) { this.bubble.innerHTML = b; this.bubble.dataset.html = b; }
  }

  /** Where a note's pin goes (px in the viewport), for notes on buildings, UI elements and spots of the picture; undefined = not ours. */
  pinXY(n: { address: { thing: string }; region?: { point?: [number, number, number] } }, project: (v: THREE.Vector3) => [number, number] | null): [number, number] | null | undefined {
    const th = n.address.thing;
    if (n.region?.point && !(th.startsWith('ui/'))) return project(new THREE.Vector3(...n.region.point));
    if (th.startsWith('town:')) {
      const id = th.slice(th.indexOf('/') + 1);
      if (!th.includes('/')) return null;
      const p = this.town.pinPoint(id);
      return p ? project(p) : null;
    }
    if (th.startsWith('ui/')) return this.ui.pinXY(th.slice(3));
    if (th.startsWith('person:')) { const p = this.life.pinPoint(th.slice(7)); return p ? project(p) : null; }
    return undefined;
  }

  /** The words for something selected in a panel, for the notes composer. */
  pointing(): string | null { return this.noteTarget()?.words ?? null; }
}

export { esc };
