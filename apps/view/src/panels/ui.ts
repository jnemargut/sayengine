// The UI kit live in the view (Phase 10 step 3): the kit's HUD, cards and bubbles drawn over the scene
// in a phone (844×390) or desktop (1280×720) frame, styled by the same CSS the web games get. Clicking
// an element selects it with an address ("ui/pump"); its tokens are sliders (text size, padding,
// width, height) and palette chips (fill, ink). Dragging previews and re-runs the contrast, overflow
// and tap checks here, for both screens; releasing is one step through ui-style.
import { uiCss, uiChecks, fontPx, padPx, elementColours, UI_PROFILES, REF, type UiKit, type UiElement } from '../../../../packages/core/src/uikit.ts';
import { setFontLoader } from '../../../../packages/core/src/glyphs.ts';
import { esc, type ViewHost } from './host.ts';

type Profile = 'mobile' | 'desktop';
interface UiState { kit: UiKit; checks: Record<Profile, any[]>; profile: Profile }
const SLIDERS: Array<{ k: 'size' | 'pad' | 'w' | 'h'; label: string; min: number; max: number; step: number; up: string; down: string }> = [
  { k: 'size', label: 'text size', min: 10, max: 72, step: 1, up: 'bigger text', down: 'smaller text' },
  { k: 'pad', label: 'padding', min: 0, max: 48, step: 1, up: 'more padding', down: 'less padding' },
  { k: 'w', label: 'width', min: 24, max: 700, step: 2, up: 'wider', down: 'narrower' },
  { k: 'h', label: 'height', min: 24, max: 400, step: 2, up: 'taller', down: 'shorter' },
];

let fontReady = false;
async function loadFont() {
  if (fontReady) return;
  fontReady = true;
  try { const b = await (await fetch('/font/ui.woff')).arrayBuffer(); setFontLoader(() => b); } catch { /* the checks fall back to an estimate */ }
}

export class UiPanel {
  host: ViewHost;
  state: UiState | null = null;
  shownProfile: Profile = 'mobile';
  selected: string | null = null;
  preview: UiElement | null = null;          // the selected element while a slider is held
  visible = true;
  overlay: HTMLDivElement;
  private styleEl: HTMLStyleElement;
  private cssKey = '';

  constructor(host: ViewHost) {
    this.host = host;
    this.overlay = document.createElement('div');
    this.overlay.className = 'uk-overlay';
    host.vpEl.appendChild(this.overlay);
    this.styleEl = document.createElement('style');
    document.head.appendChild(this.styleEl);
    this.overlay.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-ui-el]') as HTMLElement | null;
      if (!el) return;
      e.stopPropagation(); e.preventDefault();
      this.select(el.dataset.uiEl!);
    });
    void loadFont();
  }

  onState(ui: UiState | null) {
    this.state = ui;
    this.preview = null;   // the released step is in the engine's state now
    if (this.selected && !ui?.kit.layout.some((e) => e.id === this.selected)) this.selected = null;
  }

  select(id: string | null) {
    this.selected = id; this.preview = null;
    this.host.sendSelect(id ? 'ui' : null, id);
    this.host.rerender();
  }

  /** The kit as shown: the held slider's element swapped in. */
  kit(): UiKit | null {
    if (!this.state) return null;
    const k = this.state.kit;
    if (!this.preview) return k;
    return { ...k, layout: k.layout.map((e) => (e.id === this.preview!.id ? this.preview! : e)) };
  }
  element(): UiElement | null { return this.kit()?.layout.find((e) => e.id === this.selected) ?? null; }

  // ── the overlay ───────────────────────────────────────────────────────────────────────────────
  draw() {
    const kit = this.kit();
    if (!kit || !this.visible) { this.overlay.innerHTML = ''; this.overlay.style.display = 'none'; return; }
    this.overlay.style.display = '';
    const css = uiCss(kit.tokens, '/font/ui.woff').replace(/\.ui-root \{ position: absolute; inset: 0;/, '.ui-root { position: absolute;');
    if (css !== this.cssKey) { this.styleEl.textContent = css; this.cssKey = css; }
    const prof = UI_PROFILES[this.shownProfile];
    const vr = this.host.vpEl.getBoundingClientRect();
    // the screen, fitted inside the viewport (16 px margin), the HUD scaled by its height as the games do
    const s = Math.min((vr.width - 32) / prof.w, (vr.height - 96) / prof.h, 1);
    const W = prof.w * s, H = prof.h * s, k = (prof.h / REF.h) * s;
    const left = (vr.width - W) / 2, top = Math.max(48, (vr.height - H) / 2);
    const ins = prof.inset;
    const items = kit.layout.map((e) => this.elHtml(e, kit, k, prof, s)).join('');
    const html = `<div class="uk-frame ${this.shownProfile}" style="left:${left}px;top:${top}px;width:${W}px;height:${H}px">
      <div class="uk-safe" style="left:${ins.l * s}px;right:${ins.r * s}px;top:${ins.t * s}px;bottom:${ins.b * s}px"></div>
      <div class="ui-root" style="inset:0;font-size:${kit.tokens.font.size * k}px">${items}</div>
      <div class="uk-cap">${this.shownProfile === 'mobile' ? `phone ${prof.w}×${prof.h}` : `desktop ${prof.w}×${prof.h}`} · click an element</div></div>`;
    if (this.overlay.dataset.html !== html) { this.overlay.innerHTML = html; this.overlay.dataset.html = html; }
  }

  private elHtml(e: UiElement, kit: UiKit, k: number, prof: { w: number; h: number }, s: number): string {
    // anchored to its corner (a wider screen keeps its distance to that corner)
    const a = e.anchor ?? 'tl', W = prof.w * s, H = prof.h * s;
    const w = e.w * k, h = e.h * k;
    let x = e.x * k, y = e.y * k;
    if (a === 'center') { x = W / 2 + (e.x + e.w / 2 - REF.w / 2) * k - w / 2; y = H / 2 + (e.y + e.h / 2 - REF.h / 2) * k - h / 2; }
    else { if (a.includes('r')) x = W - (REF.w - e.x - e.w) * k - w; if (a.includes('b')) y = H - (REF.h - e.y - e.h) * k - h; }
    const col = elementColours(e), P = kit.tokens.palette as any;
    const st: string[] = [`left:${x}px`, `top:${y}px`, `width:${w}px`, `height:${h}px`, `font-size:${fontPx(e, kit.tokens) * k}px`];
    if (e.style?.fill && e.part !== 'bar') st.push(`background:${P[col.fill]}`);
    if (e.style?.ink) st.push(`color:${P[col.ink]}`);
    if (e.style?.pad !== undefined) st.push(e.part === 'slot' || e.part === 'card' ? `padding:${padPx(e) * k}px` : `padding:0 ${padPx(e) * k}px`);
    if (e.part === 'bar' || e.part === 'label' || e.part === 'tooltip') st.push(`line-height:${h - 6 * k}px`);
    if (e.part === 'bubble') st.push('transform:none');
    const sel = e.id === this.selected ? ' uk-sel' : '';
    let inner = esc(e.text ?? '');
    if (e.part === 'bar') inner = `<div class="fill" style="width:${(e.value ?? 1) * 100}%${e.style?.fill ? `;background:${P[col.fill]}` : ''}"></div><div class="text"${e.style?.ink ? ` style="color:${P[col.ink]}"` : ''}>${esc(e.text ?? '')}</div>`;
    else if (e.part === 'slot') { const svg = e.icon ? kit.icons[e.icon]?.svg : null; inner = svg ? `<img alt="${esc(e.icon!)}" src="data:image/svg+xml;utf8,${encodeURIComponent(svg)}">` : `<span class="uk-noicon">${esc(e.icon ?? '')}</span>`; }
    else if (e.part === 'card') inner = `<h1>${esc(e.text ?? '')}</h1>`;
    return `<div class="ui-${e.part}${sel}" data-ui-el="${esc(e.id)}" title="${esc(e.id)}" style="${st.join(';')}">${inner}</div>`;
  }

  // ── the inspector: tokens and live checks ─────────────────────────────────────────────────────
  checksNow(): Record<Profile, any[]> | null {
    const kit = this.kit();
    if (!kit) return null;
    // local while a slider is held (the same check code, the same font); the engine's otherwise
    if (!this.preview && this.state) return this.state.checks;
    return { mobile: uiChecks({ ...kit, profile: 'mobile' }), desktop: uiChecks({ ...kit, profile: 'desktop' }) };
  }

  checksHtml(): string {
    const c = this.checksNow();
    if (!c) return '';
    const ids = ['ui-contrast', 'ui-overflow', 'ui-tap', 'ui-text-size', 'ui-safe'];
    const cell = (x: any) => x ? `<span class="uk-ck ${x.pass ? 'ok' : 'bad'}" title="${esc(x.detail)}">${x.pass ? '✓' : '✗'}</span>` : '';
    const rows = ids.map((id) => { const m = c.mobile.find((x) => x.id === id), d = c.desktop.find((x) => x.id === id); return m ? `<tr><th>${esc(m.label.replace(/ \(.*\)/, ''))}</th><td>${cell(m)}</td><td>${cell(d)}</td></tr>` : ''; }).join('');
    const fails = [...c.mobile.filter((x) => !x.pass && !x.pending && ids.includes(x.id)).map((x) => `phone: ${x.detail}`), ...c.desktop.filter((x) => !x.pass && !x.pending && ['ui-tap', 'ui-safe', 'ui-text-size'].includes(x.id)).map((x) => `desktop: ${x.detail}`)];
    return `<table class="uk-checks"><tr><th></th><th>phone</th><th>desktop</th></tr>${rows}</table>${fails.length ? `<div class="uk-fails">${fails.slice(0, 4).map(esc).join('<br>')}</div>` : ''}`;
  }

  panelHtml(): string {
    if (!this.state) return '';
    return `<div class="uk"><div class="lk-head"><span class="label">UI kit · ${this.state.kit.layout.length} HUD parts</span><span class="lk-btns">
      <button data-act="ui-profile" data-p="mobile" class="${this.shownProfile === 'mobile' ? 'on' : ''}">Phone</button><button data-act="ui-profile" data-p="desktop" class="${this.shownProfile === 'desktop' ? 'on' : ''}">Desktop</button><button data-act="ui-toggle" class="${this.visible ? 'on' : ''}">Show</button></span></div>
      ${this.checksHtml()}</div>`;
  }

  inspectorHtml(): string {
    const e = this.element(), kit = this.kit();
    if (!e || !kit) return '';
    const P = kit.tokens.palette as Record<string, string>, col = elementColours(e);
    const val = (k: string) => (k === 'size' ? fontPx(e, kit.tokens) : k === 'pad' ? padPx(e) : (e as any)[k]);
    const slider = (s: typeof SLIDERS[number]) => `<div class="lk-row"><div class="lk-top"><span>${s.label}${(s.k === 'size' || s.k === 'pad') && e.style?.[s.k] === undefined ? ' <em>(kit default)</em>' : ''}</span><b data-uk-val="${s.k}">${Math.round(val(s.k))} px</b></div><input type="range" data-uk="${s.k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${val(s.k)}"></div>`;
    const chips = (which: 'fill' | 'ink') => `<div class="uk-chips">${Object.entries(P).map(([k, v]) => `<button class="uk-chip${col[which] === k ? ' on' : ''}" data-act="ui-colour" data-which="${which}" data-key="${k}" title="${k} ${v}" style="background:${v}"></button>`).join('')}${e.style?.[which] ? `<button class="ghost" data-act="ui-colour" data-which="${which}" data-key="">default</button>` : ''}</div>`;
    return `<div class="uk-insp"><div class="tw-title">${esc(e.id)} <span>${esc(e.part)}${e.text ? ` · “${esc(e.text)}”` : ''}</span></div>
      ${SLIDERS.map(slider).join('')}
      <div class="lk-g">Fill <em>${esc(col.fill)}</em></div>${chips('fill')}<div class="lk-g">Text <em>${esc(col.ink)}</em></div>${chips('ink')}
      <div class="lk-g">Checks, live</div>${this.checksHtml()}
      <div class="tw-addr">Claude sees this as <code>ui/${esc(e.id)}</code></div></div>`;
  }

  onInput(el: HTMLInputElement): boolean {
    const k = el.dataset.uk as any;
    const e = this.state?.kit.layout.find((x) => x.id === this.selected);
    if (!k || !e) return false;
    const v = Number(el.value);
    const base = this.preview ?? structuredClone(e);
    if (k === 'w' || k === 'h') base[k as 'w'] = v; else base.style = { ...(base.style ?? {}), [k]: v };
    this.preview = base;
    const lab = document.querySelector(`[data-uk-val="${k}"]`);
    if (lab) lab.textContent = `${v} px`;
    this.draw();
    const box = document.querySelector('.uk-insp .uk-checks')?.parentElement;
    const ck = document.querySelector('.uk-insp .uk-checks');
    if (ck && box) { const tmp = document.createElement('div'); tmp.innerHTML = this.checksHtml(); ck.replaceWith(tmp.querySelector('table')!); const f = box.querySelector('.uk-fails'); f?.remove(); const nf = tmp.querySelector('.uk-fails'); if (nf) box.querySelector('.uk-checks')!.after(nf); }
    return true;
  }

  onChange(el: HTMLInputElement): boolean {
    const k = el.dataset.uk as 'size' | 'pad' | 'w' | 'h' | undefined;
    const e = this.state?.kit.layout.find((x) => x.id === this.selected);
    if (!k || !e || !this.state) return false;
    const v = Number(el.value), from = k === 'size' ? fontPx(e, this.state.kit.tokens) : k === 'pad' ? padPx(e) : e[k];
    if (Math.round(v) === Math.round(from)) { this.preview = null; this.host.rerender(); return true; }
    const s = SLIDERS.find((x) => x.k === k)!;
    this.host.call('ui-style', { element: e.id, set: { [k]: v } }, `${v > from ? s.up : s.down}: ${e.id} ${s.label} ${Math.round(from)} → ${Math.round(v)} px`);
    return true;
  }

  onAct(t: HTMLElement): boolean {
    const d = t.dataset;
    switch (d.act) {
      case 'ui-profile': this.shownProfile = d.p as Profile; this.host.rerender(); return true;
      case 'ui-toggle': this.visible = !this.visible; this.host.rerender(); return true;
      case 'ui-colour': {
        const e = this.element();
        if (!e) return true;
        const which = d.which as 'fill' | 'ink', from = elementColours(e)[which];
        this.host.call('ui-style', { element: e.id, set: { [which]: d.key || null } }, `${which === 'fill' ? 'fill' : 'text colour'}: ${e.id} ${from} → ${d.key || 'default'}`);
        return true;
      }
    }
    return false;
  }

  /** Where an element's pin goes (screen px inside the viewport). */
  pinXY(id: string): [number, number] | null {
    const el = this.overlay.querySelector(`[data-ui-el="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!el || this.overlay.style.display === 'none') return null;
    const r = el.getBoundingClientRect(), v = this.host.vpEl.getBoundingClientRect();
    return [r.right - v.left, r.top - v.top];
  }
}
