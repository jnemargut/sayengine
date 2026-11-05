// Towns: click to fix (Phase 10 step 3). The view loads one chunk of a town (never the whole town:
// an 8 GB Mac), one mesh per building. A click selects the building by its stable id, the inspector
// shows its data, and edits (from the inspector or as word notes: "flat roof", "two storeys taller",
// "brick") become fix-layer entries through world-fix, one step each. Landmarks swap from here too.
// Nobody types an id.
import * as THREE from 'three';
import { esc, type ViewHost } from './host.ts';

interface Prim { mat: { name: string; roughness: number; metalness: number }; positions: string; normals: string; colors: string; indices: string; triangles: number }
interface Node { name: string; kind: string; worldId?: string; at: [number, number, number]; prims: Prim[] }
export interface Bld { id: string; label: string; name?: string; use: string; height: number; floors: number; roof: string; roofHeight?: number; storefront?: boolean; wall?: string; model?: string; hidden?: boolean; fixes: number[]; at: [number, number]; source: string; notes?: string[] }
interface TownView { ok: boolean; error?: string; town: string; key: string; offset: [number, number, number]; source: string; style: string; chunk: { center: [number, number]; radius: number; buildings: number; ofBuildings: number; clipped: boolean }; buildings: Bld[]; nodes: Node[]; triangles: number; credits: string[] }
export interface TownState { name: string; stamp: string; source: string; fixes: number; landmarks: string[] }

const ROOFS = ['flat', 'gable', 'hip', 'shed', 'pyramid', 'dome'];
const USES = ['shop', 'office', 'home', 'civic', 'church', 'parking', 'hotel', 'industrial', 'tower'];
const CHIPS = ['flat roof', 'two storeys taller', 'one storey shorter', 'brick', 'limestone', 'a shop', 'hide it'];
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

function f32(b64: string) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }

export class TownPanel {
  host: ViewHost;
  group = new THREE.Group();
  view: TownView | null = null;
  selected: string | null = null;           // the building's stable id
  loadKey = '';
  loading = false;
  error = '';
  draft = '';
  fixes: any[] = [];                        // the town's fix layer (for "back to the data")
  private framed = '';

  constructor(host: ViewHost) {
    this.host = host;
    this.group.name = 'town';
    host.scene.add(this.group);
  }

  get town(): string | null { return this.view?.town ?? null; }

  /** Fetch the chunk again whenever the town's recipe or the branch shown changes. */
  async sync(towns: TownState[], branchKey: string, fixLayer: any[] = []) {
    this.fixes = fixLayer;
    const t = towns[0];
    if (!t) { this.clear(); return; }
    const key = `${t.name}|${t.stamp}|${branchKey}`;
    if (key === this.loadKey || this.loading) return;
    this.loading = true;
    try {
      const r: TownView = await (await fetch(`/api/town?name=${encodeURIComponent(t.name)}`)).json();
      if (!r.ok) throw new Error(r.error ?? 'town failed');
      this.view = r; this.loadKey = key; this.error = '';
      this.build();
      if (this.framed !== t.name) { this.framed = t.name; this.host.frameBox(new THREE.Box3().setFromObject(this.group), [0.9, 0.85, 1.25]); }
    } catch (e: any) { this.error = e.message ?? String(e); }
    finally { this.loading = false; this.host.rerender(); }
    if (this.loadKey !== key) return;
  }

  clear() {
    this.dispose();
    this.view = null; this.selected = null; this.loadKey = ''; this.framed = '';
  }

  private dispose() {
    this.group.traverse((o: any) => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m.dispose()); } });
    this.group.clear();
  }

  private build() {
    this.dispose();
    const v = this.view!;
    this.group.position.set(...v.offset);
    const mats = new Map<string, THREE.Material>();
    const matFor = (m: Prim['mat']) => {
      let x = mats.get(m.name);
      if (!x) {
        x = m.name === 'pool'
          ? new THREE.MeshBasicMaterial({ vertexColors: true, color: '#000000', blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false })
          : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: m.roughness, metalness: m.metalness, side: m.name === 'water' ? THREE.DoubleSide : THREE.FrontSide });
        x.userData.cls = m.name;
        mats.set(m.name, x);
      }
      return x;
    };
    for (const n of v.nodes) {
      const g = new THREE.Group();
      g.name = n.name;
      g.position.set(...n.at);
      for (const p of n.prims) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(f32(p.positions)), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(f32(p.normals)), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(f32(p.colors)), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(f32(p.indices)), 1));
        // the selected building gets its own copy of the material, lit up in sage
        const base = matFor(p.mat);
        const mat = n.worldId && n.worldId === this.selected && p.mat.name !== 'pool' ? (base as THREE.MeshStandardMaterial).clone() : base;
        if (mat !== base) { (mat as THREE.MeshStandardMaterial).emissive.set('#5b8c7a'); (mat as THREE.MeshStandardMaterial).emissiveIntensity = 0.9; mat.userData = { ...base.userData, picked: true }; }
        const m = new THREE.Mesh(geo, mat);
        m.userData = { town: v.town, worldId: n.worldId ?? null, kind: n.kind };
        const flat = /ground|roads|parks|water/.test(n.kind) || p.mat.name === 'pool';
        m.castShadow = !flat; m.receiveShadow = p.mat.name !== 'pool';
        if (p.mat.name === 'pool') { m.raycast = () => {}; m.renderOrder = 2; }
        g.add(m);
      }
      this.group.add(g);
    }
  }

  /** What's under the pointer: a building (by its stable id), or the town's ground. */
  pick(ray: THREE.Raycaster): { town: string; worldId: string | null; point: THREE.Vector3; distance: number } | null {
    if (!this.view) return null;
    const hit = ray.intersectObject(this.group, true).find((h) => h.object.visible);
    if (!hit) return null;
    return { town: this.view.town, worldId: hit.object.userData.worldId ?? null, point: hit.point, distance: hit.distance };
  }

  select(id: string | null) {
    if (id === this.selected) return;
    this.selected = id;
    if (this.view) this.build();
    this.host.sendSelect(id && this.view ? `town:${this.view.town}` : null, id);
  }

  building(id = this.selected): Bld | null { return this.view?.buildings.find((b) => b.id === id) ?? null; }

  /** Where a building's pin goes: on its roof. */
  pinPoint(id: string): THREE.Vector3 | null {
    const g = this.group.children.find((c) => c.children[0]?.userData.worldId === id);
    if (!g) return null;
    const box = new THREE.Box3().setFromObject(g);
    return new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
  }

  // ── the inspector ─────────────────────────────────────────────────────────────────────────────
  chunkLine(): string {
    if (this.error) return `<div class="tw-err">Town: ${esc(this.error)}</div>`;
    if (!this.view) return this.loading ? '<div class="muted">Loading the town…</div>' : '';
    const c = this.view.chunk;
    return `<div class="tw-chunk">${esc(this.view.town)} · ${c.buildings} of ${c.ofBuildings} buildings shown${c.clipped ? ` (a chunk ±${c.radius} m, to keep the Mac light)` : ''} · ${(this.view.triangles / 1000).toFixed(0)}k triangles · click a building to fix it</div>`;
  }

  inspectorHtml(models: Array<{ id: string; name: string }>): string {
    const b = this.building();
    if (!b) return '';
    const fixIdx = this.fixes.map((f, i) => [f, i] as const).filter(([f]) => f.id === b.id);
    const row = (k: string, v: string) => `<div class="tw-row"><span>${esc(k)}</span><b>${v}</b></div>`;
    const sel = (name: string, list: string[], cur: string) => `<select data-town-set="${name}">${list.map((x) => `<option${x === cur ? ' selected' : ''}>${x}</option>`).join('')}</select>`;
    const swap = models.length ? `<div class="tw-swap"><select id="townModel">${models.map((m) => `<option value="${esc(m.id)}"${m.id === b.model ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select><button data-act="town-swap">Swap in this landmark</button></div>` : '<div class="muted">Model a landmark in the studio to swap it in here.</div>';
    const modelFix = fixIdx.filter(([f]) => f.model).at(-1);
    return `<div class="tw"><div class="tw-title">${esc(b.label)}${b.name ? ` <span>${esc(b.name)}</span>` : ''}</div>
      ${row('Height', `${b.height} m`)}${row('Floors', `<button class="tw-step" data-act="town-floors" data-by="-1" title="one storey shorter">−</button> ${b.floors} <button class="tw-step" data-act="town-floors" data-by="1" title="one storey taller">+</button>`)}
      ${row('Roof', sel('roof', ROOFS, b.roof) + (b.roofHeight ? ` <em>${b.roofHeight} m</em>` : ''))}${row('Use', sel('use', USES, b.use))}
      ${b.wall ? row('Walls', `<i class="tw-sw" style="background:${esc(b.wall)}"></i>${esc(b.wall)}`) : ''}${b.model ? row('Landmark', esc(models.find((m) => m.id === b.model)?.name ?? b.model)) : ''}
      <div class="tw-src">${esc(b.source)}</div>
      ${fixIdx.length ? `<div class="tw-fixes">${fixIdx.length} fix${fixIdx.length === 1 ? '' : 'es'} on it, kept apart from the data: ${fixIdx.map(([f]) => esc(f.note ?? Object.entries(f.set ?? {}).map(([k, v]) => `${k} ${v}`).join(', ') ?? (f.model ? 'landmark' : ''))).join(' · ')}</div>` : ''}
      ${b.notes?.length ? `<div class="tw-rules">The rules: ${esc(b.notes.slice(0, 3).join('; '))}</div>` : ''}
      <div class="tw-say"><input id="townWords" type="text" placeholder="Say what's wrong: flat roof, two storeys taller…" value="${esc(this.draft)}"><button data-act="town-words">Fix</button></div>
      <div class="tw-chips">${CHIPS.map((c) => `<button data-act="town-words" data-words="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="lk-g">Landmark</div>${swap}${modelFix ? `<button class="ghost" data-act="town-unswap" data-index="${modelFix[1]}">Back to the data building</button>` : ''}
      <div class="tw-addr">Claude sees this as <code>town:${esc(this.view!.town)}/${esc(b.id.slice(0, 14))}…</code> (no ids to type)</div></div>`;
  }

  onAct(t: HTMLElement): boolean {
    const d = t.dataset, b = this.building(), town = this.view?.town;
    if (!d.act?.startsWith('town-') || !b || !town) return false;
    const fix = (args: object, why: string) => this.host.call('world-fix', { town, id: b.id, ...args }, why);
    switch (d.act) {
      case 'town-words': {
        const words = (d.words ?? (document.getElementById('townWords') as HTMLInputElement | null)?.value ?? '').trim();
        if (!words) return true;
        this.host.call('world-fix', { town, id: b.id, words });
        this.draft = '';
        this.host.toast(`${b.label}: “${words}”`);
        return true;
      }
      case 'town-floors': {
        const by = Number(d.by), to = Math.max(1, b.floors + by);
        fix({ set: { floors: to } }, `${NUM[Math.abs(by)] ?? Math.abs(by)} storey ${by > 0 ? 'taller' : 'shorter'}: floors ${b.floors} → ${to}`);
        return true;
      }
      case 'town-swap': {
        const m = (document.getElementById('townModel') as HTMLSelectElement | null)?.value;
        if (m) fix({ model: m }, `swap in the ${(document.getElementById('townModel') as HTMLSelectElement).selectedOptions[0]?.text ?? m}`);
        return true;
      }
      case 'town-unswap': this.host.call('world-unfix', { town, index: Number(d.index) }, `back to the data building for ${b.label}`); return true;
    }
    return false;
  }

  onSelectChange(el: HTMLSelectElement): boolean {
    const k = el.dataset.townSet, b = this.building(), town = this.view?.town;
    if (!k || !b || !town) return false;
    const from = (b as any)[k];
    if (from === el.value) return true;
    this.host.call('world-fix', { town, id: b.id, set: { [k]: el.value } }, `${k === 'roof' ? `${el.value} roof` : `a ${el.value}`}: ${k} ${from} → ${el.value}`);
    return true;
  }
}
