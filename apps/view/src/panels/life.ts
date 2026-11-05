// Town life in the view (Phase 10 step 3b): the life module's day for the town chunk, played by the
// same runtime the web games use (studio/life.ts, a byte copy of core's runtime.ts), with a day clock on
// the timeline dock (scrub 00:00–24:00, play at ×1–×600). Folk and cars are drawn as light stand-ins
// (a capped cast, one chunk: an 8 GB Mac). Click a person: the inspector says who they are and their
// plan for the day; "go to the café at 9 instead" is one step (life-redirect), after which the
// headless day checks re-run and show here. A selected person is a moment address on the day clock.
import * as THREE from 'three';
import { LifeRuntime, LIFE_DT } from '../../../../packages/core/src/life/runtime.ts';
import { esc, type ViewHost } from './host.ts';

interface Stop { name: string; from: number; to: number; words: string; place?: string; kind: 'out' | 'stop' | 'home' }
interface Person { i: number; id: string; name: string; kind: 'person' | 'dog'; model: string; colours: Record<string, string>; height: number; scale: number; info: any; stops: Stop[] }
interface LifeView { ok: boolean; error?: string; key: string; settings: any; data: any; people: Person[]; vehicles: Array<{ i: number; id: string; kind: string; len: number; wid: number; colour: string }>; places: Array<{ id: string; kind: string; words: string; at: [number, number, number]; use?: string }>; redirects: any[]; stats: any }
export interface LifeState { stamp: string; settings: any; redirects: number }

const SPEEDS = [1, 10, 60, 600];
const hhmm = (s: number) => { const m = Math.floor((((s % 86400) + 86400) % 86400) / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const CHIPS = ['go to the café at 9 instead', 'sit on a bench at 10:30', 'go to a shop at 15:00 for an hour'];

export class LifePanel {
  host: ViewHost;
  group = new THREE.Group();
  view: LifeView | null = null;
  rt: LifeRuntime | null = null;
  t = 9 * 3600;                     // the day clock: seconds since midnight
  playing = false;
  speed = 60;
  selected: number | null = null;
  draft = '';
  checks: { ok: boolean; checks: any[]; ms: number } | null = null;
  checking = false;
  error = '';
  private key = '';
  private loading = false;
  private queued: LifeState | null = null;
  private people: THREE.Object3D[] = [];
  private cars: THREE.Object3D[] = [];
  private ring: THREE.Mesh;
  private route = new THREE.Group();
  private strip: HTMLDivElement | null = null;
  private last = 0;
  private acc = 0;
  private mats = new Map<string, THREE.MeshStandardMaterial>();

  constructor(host: ViewHost) {
    this.host = host;
    this.group.name = 'life';
    host.scene.add(this.group);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 6, 28), new THREE.MeshBasicMaterial({ color: '#5b8c7a', depthTest: false, transparent: true }));
    this.ring.rotation.x = Math.PI / 2; this.ring.renderOrder = 5; this.ring.visible = false;
    this.group.add(this.ring, this.route);
  }

  get on() { return !!this.view; }
  person(i = this.selected): Person | null { return i === null ? null : this.view?.people[i] ?? null; }

  /** Fetch the day again whenever life's recipe (towns, cast, settings, redirects) changes. */
  async sync(s: LifeState | null) {
    if (!s) { if (this.view) this.clear(); return; }
    if (s.stamp === this.key) return;
    if (this.loading) { this.queued = s; return; }
    this.loading = true;
    const first = !this.view;
    try {
      const r: LifeView = await (await fetch('/api/life')).json();
      if (!r.ok) throw new Error(r.error ?? 'life failed');
      this.view = r; this.key = s.stamp; this.error = '';
      this.rt = new LifeRuntime(r.data);
      if (first) this.t = (r.settings?.start ?? 9) * 3600;
      this.build();
      this.seek(this.t);
      this.ensureStrip();
      void this.loadChecks();
    } catch (e: any) { this.error = e.message ?? String(e); }
    finally { this.loading = false; this.host.rerender(); }
    const q = this.queued; this.queued = null;
    if (q) await this.sync(q);
  }

  async loadChecks() {
    this.checking = true; this.host.rerender();
    const key = this.key;
    try { const r = await (await fetch('/api/life/checks')).json(); if (key === this.key) this.checks = r; } catch { /* the checks come next time */ }
    finally { this.checking = false; this.host.rerender(); }
  }

  clear() {
    for (const o of [...this.people, ...this.cars]) this.group.remove(o);
    this.people = []; this.cars = [];
    this.view = null; this.rt = null; this.key = ''; this.selected = null; this.checks = null;
    this.strip?.remove(); this.strip = null;
  }

  private mat(c: string) { let m = this.mats.get(c); if (!m) { m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }); this.mats.set(c, m); } return m; }

  /** Light stand-ins: a body in the shirt colour, legs, head and hair; dogs and cars as boxes. */
  private build() {
    for (const o of [...this.people, ...this.cars]) this.group.remove(o);
    const v = this.view!;
    const body = new THREE.CapsuleGeometry(0.2, 0.5, 3, 8), legs = new THREE.BoxGeometry(0.3, 0.75, 0.2), head = new THREE.SphereGeometry(0.14, 10, 8), hair = new THREE.SphereGeometry(0.145, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    const dogG = new THREE.BoxGeometry(0.28, 0.32, 0.7);
    this.people = v.people.map((p) => {
      const g = new THREE.Group();
      g.name = `person:${p.id}`;
      if (p.kind === 'dog') { const m = new THREE.Mesh(dogG, this.mat(p.colours.body)); m.position.y = 0.3; g.add(m); }
      else {
        const k = (p.height / 1.7) * (p.scale ?? 1);
        const L = new THREE.Mesh(legs, this.mat(p.colours.trousers)); L.position.y = 0.375;
        const B = new THREE.Mesh(body, this.mat(p.colours.shirt)); B.position.y = 1.05;
        const H = new THREE.Mesh(head, this.mat(p.colours.skin)); H.position.y = 1.52;
        const R = new THREE.Mesh(hair, this.mat(p.colours.hair)); R.position.y = 1.55;
        const inner = new THREE.Group(); inner.add(L, B, H, R); inner.scale.setScalar(k); inner.name = 'figure';
        g.add(inner);
        // a fat, invisible picking column: a person 1.7 m tall is a few pixels from a diorama camera
        const pickG = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.2, 6), new THREE.MeshBasicMaterial({ visible: false }));
        pickG.position.y = 1.1; pickG.userData.pickOnly = true; g.add(pickG);
      }
      g.traverse((o: any) => { if (o.isMesh) { o.castShadow = !o.userData.pickOnly; o.userData.agent = p.i; } });
      g.visible = false;
      this.group.add(g);
      return g;
    });
    this.cars = v.vehicles.map((c) => {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.BoxGeometry(c.wid, c.kind === 'bus' ? 2.6 : 0.75, c.len), this.mat(c.colour)); b.position.y = c.kind === 'bus' ? 1.6 : 0.65;
      g.add(b);
      if (c.kind !== 'bus') { const cab = new THREE.Mesh(new THREE.BoxGeometry(c.wid * 0.88, 0.5, c.len * 0.5), this.mat('#e9e2d4')); cab.position.set(0, 1.25, -c.len * 0.05); g.add(cab); }
      g.traverse((o: any) => { if (o.isMesh) o.castShadow = true; });
      g.visible = false;
      this.group.add(g);
      return g;
    });
    this.drawRoute();
  }

  // ── the clock ──────────────────────────────────────────────────────────────────────────────────
  seek(t: number) {
    this.t = Math.max(0, Math.min(24 * 3600 - 1, t));
    if (!this.rt) return;
    this.rt.init(this.t, 20);
    this.acc = 0;
    this.place();
  }

  /** Every frame: advance the day while it plays, place everyone, draw the strip. */
  frame(now = performance.now()) {
    const dt = this.last ? Math.min(0.5, (now - this.last) / 1000) : 0;   // a slow frame (software GL) still moves the day on
    this.last = now;
    if (!this.rt) return;
    if (this.playing) {
      const adv = dt * this.speed;
      this.t += adv;
      if (this.t >= 24 * 3600 - 1) { this.t = 24 * 3600 - 1; this.playing = false; }
      this.acc += adv;
      let n = Math.floor(this.acc / LIFE_DT);
      if (n > 1500) { this.rt.init(this.t, 20); n = 0; this.acc = 0; }
      for (let k = 0; k < n; k++) this.rt.step();
      this.acc -= n * LIFE_DT;
      this.place();
    }
    this.drawStrip();
  }

  private place() {
    const rt = this.rt!;
    rt.agents.forEach((a, i) => {
      const g = this.people[i];
      if (!g) return;
      g.visible = a.visible;
      if (!a.visible) return;
      const sit = a.pose === 'sit' || a.pose === 'fish';
      g.position.set(a.x, a.y - (sit ? 0.42 : 0), a.z);
      g.rotation.y = a.yaw;
    });
    rt.vehicles.forEach((v, i) => {
      const g = this.cars[i];
      if (!g) return;
      g.visible = v.visible;
      if (v.visible) { g.position.set(v.x, v.y, v.z); g.rotation.y = v.yaw; }
    });
    const s = this.selected;
    this.ring.visible = s !== null && !!rt.agents[s]?.visible;
    if (this.ring.visible) this.ring.position.set(rt.agents[s!].x, rt.agents[s!].y + 0.05, rt.agents[s!].z);
    const now = document.getElementById('lifeNow');
    if (now && s !== null) now.textContent = `${hhmm(this.t)} · ${this.nowWords(s)}`;
    const addr = document.getElementById('lifeAddr');
    if (addr && s !== null) addr.textContent = this.compact(s);
  }

  // ── pointing at a person ───────────────────────────────────────────────────────────────────────
  pick(ray: THREE.Raycaster): { i: number; distance: number } | null {
    if (!this.view) return null;
    const hit = ray.intersectObjects(this.people.filter((g) => g.visible), true)[0];
    return hit ? { i: hit.object.userData.agent, distance: hit.distance } : null;
  }

  select(i: number | null) {
    this.selected = i;
    this.drawRoute();
    this.place();
    this.sendSelect();
  }

  /** The stop a time of day falls in (the address's named moment), else the nearest start within 10 min. */
  stopAt(i: number, t = this.t): Stop | undefined {
    const stops = this.view!.people[i].stops;
    const inside = stops.find((s) => s.kind === 'stop' && t >= s.from && t < s.to);
    if (inside) return inside;
    let best: Stop | undefined, bd = 600;
    for (const s of stops) { const d = Math.abs(s.from - t); if (d <= bd) { bd = d; best = s; } }
    return best;
  }

  sendSelect() {
    const i = this.selected;
    if (i === null || !this.view) { this.host.sendSelect(null, null); return; }
    const near = this.stopAt(i)?.name;
    this.host.sendSelect(`person:${this.view.people[i].id}`, null, { clock: 'day', seconds: Math.round(this.t), ...(near ? { near } : {}) });
  }

  /** The address a note on this person gets: the person, on the day clock, at the time shown. */
  noteTarget(): { at: any; words: string } | null {
    const i = this.selected;
    if (i === null || !this.view) return null;
    const p = this.view.people[i], near = this.stopAt(i)?.name;
    return { at: { thing: `person:${p.id}`, clock: 'day', at: Math.round(this.t) * 24000, ...(near ? { near } : {}) }, words: `${p.name} at ${hhmm(this.t)}` };
  }

  compact(i: number) {
    const p = this.view!.people[i], near = this.stopAt(i)?.name;
    return `person:${p.id}@day ${hhmm(this.t)}${near ? ` ~${near.replace(/\s/g, '_')}` : ''}`;
  }

  nowWords(i: number): string {
    const st = this.view!.people[i].stops, t = this.t;
    const at = st.find((s) => s.kind === 'stop' && t >= s.from && t < s.to);
    if (at) return at.words.replace(/^sits/, 'sitting').replace(/^browses/, 'browsing').replace(/^goes into/, 'inside').replace(/^keeps/, 'keeping').replace(/^fishes/, 'fishing').replace(/^waits/, 'waiting');
    let out = false;
    for (const s of st) { if (s.from > t) break; out = s.kind !== 'home'; }
    return out ? 'walking' : 'at home';
  }

  pinPoint(id: string): THREE.Vector3 | null {
    const i = this.view?.people.findIndex((p) => p.id === id) ?? -1;
    if (i < 0 || !this.people[i]?.visible) return null;
    return this.people[i].position.clone().add(new THREE.Vector3(0, 2, 0));
  }

  /** Their day's walks as a line, and a pin on each stop. */
  private drawRoute() {
    this.route.clear();
    const i = this.selected;
    if (i === null || !this.view) return;
    const D = this.view.data, a = D.agents[i], lead = a.owner ?? i;
    const line = new THREE.LineBasicMaterial({ color: '#5b8c7a', transparent: true, opacity: 0.9, depthTest: false });
    for (const g of D.agents[lead].plan) {
      if (g.k !== 'move') continue;
      const p = D.paths[g.p], pts: THREE.Vector3[] = [];
      for (let k = 0; k < p.length; k += 4) pts.push(new THREE.Vector3(p[k], p[k + 1] + 0.15, p[k + 2]));
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), line); l.renderOrder = 4;
      this.route.add(l);
    }
    const pin = new THREE.MeshBasicMaterial({ color: '#2f6fd6', depthTest: false });
    for (const s of this.view.people[i].stops) {
      const pl = s.place ? this.view.places.find((x) => x.id === s.place) : null;
      if (!pl) continue;
      const m = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.3, 8), pin); m.rotation.x = Math.PI; m.position.set(pl.at[0], pl.at[1] + 2.6, pl.at[2]); m.renderOrder = 4;
      this.route.add(m);
    }
  }

  /** Point the camera at the selected person (the diorama camera sees them as a dot). */
  frameOn(i = this.selected, size = 26) {
    if (i === null || !this.rt) return;
    const a = this.rt.agents[i];
    const c = new THREE.Vector3(a.x, a.y + 1, a.z);
    // from high up and steep: a street-level person is behind a building from most low angles
    this.host.frameBox(new THREE.Box3().setFromCenterAndSize(c, new THREE.Vector3(size, size * 0.5, size)), [0.3, 1.5, 0.55]);
  }

  // ── the day strip on the timeline dock ─────────────────────────────────────────────────────────
  private ensureStrip() {
    if (this.strip) return;
    const main = document.querySelector('.tl-dock .tl-main');
    if (!main) return;
    const el = document.createElement('div');
    el.className = 'tl-day';
    el.innerHTML = `<div class="tl-day-bar"><button data-day="play" title="Play the day">▶ Day</button><span class="tl-day-speed">${SPEEDS.map((s) => `<button data-day="speed" data-speed="${s}" class="${s === this.speed ? 'on' : ''}">×${s}</button>`).join('')}</span><span class="tl-day-time"></span><span class="tl-day-who"></span></div><canvas></canvas>`;
    main.insertBefore(el, main.firstChild);
    main.closest('.tl-dock')?.classList.remove('empty');
    this.strip = el;
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-day]') as HTMLElement | null;
      if (!b) return;
      if (b.dataset.day === 'play') { this.playing = !this.playing; if (!this.playing) this.sendSelect(); }
      if (b.dataset.day === 'speed') this.speed = Number(b.dataset.speed);
      this.stripBar();
    });
    const cv = el.querySelector('canvas')!;
    let drag = false;
    const to = (cx: number) => { const r = cv.getBoundingClientRect(); this.seek(Math.max(0, Math.min(1, (cx - r.left) / r.width)) * 24 * 3600); };
    cv.addEventListener('pointerdown', (e) => { drag = true; try { cv.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ } this.playing = false; to(e.clientX); this.stripBar(); });
    cv.addEventListener('pointermove', (e) => { if (drag) to(e.clientX); });
    cv.addEventListener('pointerup', () => { if (drag) { drag = false; this.sendSelect(); this.host.rerender(); } });
    this.stripBar();
  }

  private stripBar() {
    if (!this.strip) return;
    const b = this.strip.querySelector('[data-day="play"]')!;
    b.textContent = this.playing ? '❚❚ Day' : '▶ Day'; b.classList.toggle('on', this.playing);
    this.strip.querySelectorAll('[data-day="speed"]').forEach((x) => x.classList.toggle('on', Number((x as HTMLElement).dataset.speed) === this.speed));
  }

  private outIntervals(p: Person): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let s0 = -1;
    for (const s of p.stops) { if (s.kind === 'out') s0 = s.from; else if (s.kind === 'home' && s0 >= 0) { out.push([s0, s.from]); s0 = -1; } }
    if (s0 >= 0) out.push([s0, 24 * 3600]);
    return out;
  }

  private drawStrip() {
    const el = this.strip;
    if (!el || !this.view) return;
    const cv = el.querySelector('canvas')!;
    const w = Math.max(200, cv.clientWidth), h = 40, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = `${h}px`; }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
    const ink = css('--color-900', '#1c1917'), mid = css('--color-500', '#78716c'), faint = css('--color-200', '#e7e5e4');
    const X = (s: number) => (s / 86400) * w;
    // night and day: dusk to dawn shaded
    g.fillStyle = faint; g.globalAlpha = 0.6; g.fillRect(0, 0, X(6.5 * 3600), h); g.fillRect(X(18 * 3600), 0, w - X(18 * 3600), h); g.globalAlpha = 1;
    // how many are out, every 10 minutes
    if (!(this as any)._dens || (this as any)._densKey !== this.key) {
      const bins = new Array(144).fill(0);
      for (const p of this.view.people) for (const [a, b] of this.outIntervals(p)) for (let k = Math.floor(a / 600); k <= Math.min(143, Math.floor(b / 600)); k++) bins[k]++;
      (this as any)._dens = bins; (this as any)._densKey = this.key;
    }
    const bins: number[] = (this as any)._dens, top = Math.max(1, ...bins);
    g.fillStyle = '#7d93ab'; g.globalAlpha = 0.45;
    bins.forEach((n, k) => { const bh = (n / top) * 16; g.fillRect(X(k * 600), 22 - bh, Math.max(1, X(600) - 0.5), bh); });
    g.globalAlpha = 1;
    // hours
    g.font = '9.5px system-ui, sans-serif'; g.fillStyle = mid;
    for (let hr = 0; hr <= 24; hr += 3) { const x = X(hr * 3600); g.fillRect(x, 22, 1, 4); if (hr < 24) g.fillText(`${String(hr).padStart(2, '0')}:00`, x + 2, 34); }
    // the selected person's day: out as a line, stops as blocks
    const p = this.person();
    if (p) {
      g.fillStyle = '#5b8c7a';
      for (const [a, b] of this.outIntervals(p)) g.fillRect(X(a), 25, Math.max(1, X(b) - X(a)), 2);
      for (const s of p.stops) if (s.kind === 'stop') { g.fillRect(X(s.from), 23, Math.max(3, X(s.to) - X(s.from)), 6); }
      const redirected = new Set(this.view.redirects.filter((r: any) => r.who === (p.info.follows ?? p.id)).map((r: any) => r.place));
      g.fillStyle = '#d9822b';
      for (const s of p.stops) if (s.kind === 'stop' && s.place && redirected.has(s.place)) g.fillRect(X(s.from), 22, Math.max(3, X(s.to) - X(s.from)), 8);
    }
    // the playhead
    const px = X(this.t);
    g.fillStyle = ink; g.fillRect(px - 1, 0, 2, h);
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 6); g.closePath(); g.fill();
    const tEl = el.querySelector('.tl-day-time')!, who = el.querySelector('.tl-day-who')!;
    const tt = `${hhmm(this.t)}${this.playing ? ` · ×${this.speed}` : ''}`;
    if (tEl.textContent !== tt) tEl.textContent = tt;
    const out = this.rt ? this.rt.agents.filter((a, i) => a.visible && this.view!.people[i]?.kind === 'person').length : 0;
    const ww = p ? `${p.name}: ${this.nowWords(p.i)}` : `${out} out now · ${this.rt?.vehicles.filter((v) => v.visible).length ?? 0} cars · click a person`;
    if (who.textContent !== ww) who.textContent = ww;
  }

  // ── the inspector ──────────────────────────────────────────────────────────────────────────────
  line(): string {
    if (this.error) return `<div class="tw-err">Town life: ${esc(this.error)}</div>`;
    if (!this.view) return this.loading ? '<div class="muted">Loading town life…</div>' : '';
    const s = this.view.stats;
    return `<div class="tw-chunk">Town life: ${s.folk} folk${s.dogs ? `, ${s.dogs} dog${s.dogs > 1 ? 's' : ''}` : ''}, ${s.cars + (s.buses ?? 0)} vehicle${s.cars + (s.buses ?? 0) === 1 ? '' : 's'} on a ${esc(this.view.settings.day ?? 'saturday')} (capped for the Mac) · the day clock is on the dock · click a person</div>`;
  }

  inspectorHtml(): string {
    const p = this.person();
    if (!p || !this.view) return '';
    const row = (k: string, v: string) => `<div class="tw-row"><span>${esc(k)}</span><b>${v}</b></div>`;
    const lead = p.info.follows ? this.view.people.find((x) => x.id === p.info.follows) : null;
    // one line per outing: out–home, then each stop with its time (the redirected one in orange)
    const moved = (s: Stop) => !!s.place && this.view!.redirects.some((r: any) => r.place === s.place && r.who === (p.info.follows ?? p.id));
    const outings: Stop[][] = [];
    for (const s of p.stops) { if (s.kind === 'out' || !outings.length) outings.push([]); outings[outings.length - 1].push(s); }
    const plan = outings.map((o) => {
      const a = o[0].from, b = o[o.length - 1].kind === 'home' ? o[o.length - 1].from : o[o.length - 1].to;
      const now = this.t >= a && this.t < b;
      const stops = o.filter((s) => s.kind === 'stop').map((s) => `<span class="${moved(s) ? 'moved' : ''}${this.t >= s.from && this.t < s.to ? ' now' : ''}">${hhmm(s.from)} ${esc(s.words)}${s.to - s.from >= 600 ? ` <i>(${Math.round((s.to - s.from) / 60)} min)</i>` : ''}</span>`).join(' · ');
      return `<li class="${now ? 'now' : ''}"><b>${hhmm(a)}–${hhmm(b)}</b> ${stops || 'a walk'}</li>`;
    }).join('');
    const places = this.view.places.filter((x) => x.kind !== 'door' || x.use).map((x) => `<option value="${esc(x.id)}">${esc(x.words)}${x.use ? ` (${esc(x.use)})` : ''}</option>`).join('');
    const ck = this.checks;
    const fails = ck?.checks?.filter((c: any) => !c.pass) ?? [];
    const checks = this.checking ? '<div class="muted">Running the day headless…</div>'
      : ck?.checks ? `<div class="lf-checks ${fails.length ? 'bad' : 'good'}">${fails.length ? `✗ ${fails.length} of ${ck.checks.length} fail` : `✓ all ${ck.checks.length} pass`} <span>(24 h sped up in ${(ck.ms / 1000).toFixed(1)} s)</span></div><div class="lf-cks">${ck.checks.map((c: any) => `<span class="lf-ck ${c.pass ? 'p' : 'f'}" title="${esc(c.detail ?? '')}">${c.pass ? '✓' : '✗'} ${esc(c.name)}${c.pass ? '' : ` <em>${c.count} &gt; ${c.limit}${c.at?.length ? ` at ${c.at.map((t: number) => hhmm(t)).join(', ')}` : ''}</em>`}</span>`).join('')}</div>` : '';
    const redirected = this.view.redirects.filter((r: any) => r.who === (p.info.follows ?? p.id));
    return `<div class="tw lf"><div class="tw-title">${esc(p.name)} <span>${p.kind === 'dog' ? 'a dog' : `looks like ${esc(p.info.looksLike)}`}</span></div>
      ${row('Who', esc(p.info.role))}${p.info.home ? row('Lives at', esc(p.info.home)) : ''}${p.info.with ? row('Out with', esc(p.info.with)) : ''}
      <div class="tw-row"><span>Now</span><b id="lifeNow">${hhmm(this.t)} · ${esc(this.nowWords(p.i))}</b></div>
      <div class="lk-g">Their day${lead ? ` <em>(${esc(lead.name)}'s)</em>` : ''} <em>· out and home again</em></div><ul class="lf-plan">${plan || '<li>Indoors all day</li>'}</ul>
      <div class="lk-g">Day checks <em>(re-run after each redirect)</em></div>${checks}
      <div class="lk-g">Send them somewhere else</div>
      <div class="tw-say"><input id="lifeWords" type="text" placeholder="go to the café at 9 instead" value="${esc(this.draft)}"><button data-act="life-words">Redirect</button></div>
      <div class="tw-chips">${CHIPS.map((c) => `<button data-act="life-words" data-words="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="lf-send"><select id="lifePlace">${places}</select><input id="lifeAt" type="time" value="${hhmm(this.t)}"><button data-act="life-send">Send</button></div>
      ${redirected.length ? `<button class="ghost" data-act="life-undo">Back to their own day</button>` : ''}
      <div class="tw-row"><button class="ghost" data-act="life-frame">Look at ${esc(p.name)}</button></div>
      <div class="tw-addr">Claude sees this as <code id="lifeAddr">${esc(this.compact(p.i))}</code></div></div>`;
  }

  onAct(t: HTMLElement): boolean {
    const d = t.dataset;
    if (!d.act?.startsWith('life-')) return false;
    const p = this.person();
    if (!p) return true;
    const who = p.info.follows ?? p.id;
    switch (d.act) {
      case 'life-words': {
        const words = (d.words ?? (document.getElementById('lifeWords') as HTMLInputElement | null)?.value ?? '').trim();
        if (!words) return true;
        this.host.call('life-redirect', { who, words });
        this.draft = ''; this.checks = null; this.checking = true;
        const inp = document.getElementById('lifeWords') as HTMLInputElement | null; if (inp) { inp.value = ''; inp.blur(); }
        this.host.toast(`${p.name}: “${words}”: re-running the day…`);
        this.host.rerender();
        return true;
      }
      case 'life-send': {
        const place = (document.getElementById('lifePlace') as HTMLSelectElement).value, at = (document.getElementById('lifeAt') as HTMLInputElement).value;
        const [hh, mm] = at.split(':').map(Number);
        const words = this.view!.places.find((x) => x.id === place)?.words ?? place;
        this.host.call('life-redirect', { who, place, at: +(hh + mm / 60).toFixed(3) }, `send ${p.name} to ${words} at ${at}`);
        this.checks = null; this.checking = true; this.host.rerender();
        return true;
      }
      case 'life-undo': this.host.call('life-redirect', { who, undo: true }, `${p.name} back to their own day`); this.checks = null; this.checking = true; this.host.rerender(); return true;
      case 'life-frame': this.frameOn(); return true;
    }
    return false;
  }
}

export const LIFE_CSS = `
.tl-day { border-bottom:1px solid var(--color-200); padding:4px 10px 2px; }
.tl-day-bar { display:flex; align-items:center; gap:8px; white-space:nowrap; overflow:hidden; }
.tl-day-bar button { font:inherit; border:none; border-radius:999px; background:var(--color-100); color:var(--color-800); padding:2px 9px; cursor:pointer; }
.tl-day-bar button.on { background:var(--color-800); color:var(--color-50); }
.tl-day-speed { display:flex; gap:2px; }
.tl-day-speed button { padding:2px 6px; font-size:10px; }
.tl-day-time { font-family:var(--font-mono); color:var(--color-900); min-width:52px; }
.tl-day-who { color:var(--color-600); overflow:hidden; text-overflow:ellipsis; }
.tl-day canvas { display:block; width:100%; cursor:ew-resize; }
.lf-plan { margin:2px 0 4px; padding-left:16px; font-size:var(--text-xs); color:var(--color-700); }
.lf-plan { list-style:none; padding-left:0; }
.lf-plan li { padding:2px 0; line-height:1.35; }
.lf-plan li b { color:var(--color-900); margin-right:2px; }
.lf-plan li.now b { text-decoration:underline; }
.lf-plan span.now { color:var(--color-900); font-weight:600; }
.lf-plan span.moved { color:#b8621b; font-weight:600; }
.lf-plan i { font-style:normal; color:var(--color-500); }
.lf-cks { display:flex; flex-wrap:wrap; gap:1px 8px; }
.lf-send { display:flex; gap:4px; margin:4px 0; }
.lf-send select, .lf-send input { font:inherit; font-size:var(--text-xs); border:1px solid var(--color-200); border-radius:6px; background:var(--color-50); color:var(--color-900); padding:2px 4px; min-width:0; }
.lf-send select { flex:1; }
.lf-send button { font:inherit; font-size:var(--text-xs); border:1px solid var(--color-200); background:var(--color-50); border-radius:999px; padding:2px 9px; cursor:pointer; color:var(--color-800); }
.lf-checks { font-size:var(--text-xs); font-weight:600; margin:2px 0; }
.lf-checks span { font-weight:400; color:var(--color-500); }
.lf-checks.good { color:#3f7a5a; } .lf-checks.bad { color:#a8483a; }
.lf-ck { font-size:10.5px; color:var(--color-600); white-space:nowrap; } .lf-ck.f { color:#a8483a; } .lf-ck em { font-style:normal; color:var(--color-500); }
`;
