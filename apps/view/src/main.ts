// Browser view: a live mirror of the engine daemon (the website is "just the view").
// Watch, inspect, review proposals change-by-change (Decision 9), render images for Claude Code
// (Decision 6), and make quick edits by hand: scrub a param, drag an object or a part. Every hand
// edit is the same typed tool call Claude makes, so it lands as one reviewable step.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { focusOnState, validFocus } from './focus.ts';
import { makeMaterial, addGrain, setupRenderer, addStage, fitShadow, type Mat } from './look.ts';

type V3 = [number, number, number];
interface BBox { min: V3; max: V3 }
interface Check { id: string; label: string; pass: boolean; detail: string; parts?: string[]; pending?: boolean }
interface Param { value: number; unit?: string; min?: number; max?: number; description?: string }
interface Part { name: string; ranges: [number, number][]; bbox: BBox; ops?: string[]; material?: Mat; drag?: 'op' | 'object' }
interface ImageRef { kind: 'image'; asset: string; file: string; plane: 'front' | 'side' | 'top'; width: number; height: number; at: V3; opacity: number }
interface PackedObj {
  id: string; name: string; type: string; material: Mat;
  params: Record<string, Param>; code: string; ok: boolean; error?: string;
  positions: string; indices: string; parts: Part[];
  bbox: BBox | null; checks: Check[];
  position: V3; rotation: number; placement: string | null; linkedCopyOf: string | null;
  role: 'model' | 'reference'; reference: ImageRef | { kind: 'mesh'; asset: string; file: string } | null;
}
interface Step { n: number; id: string; summary: string; author: string; tool: string; undone: boolean; affects: Record<string, string[]> }
interface Prop { id: string; title: string; status: string; author: string; active: boolean; steps: Step[]; checks: Record<string, Check[]>; allPass: boolean; objects: PackedObj[] }
interface State {
  active: string; mainHead: string | null; commitCount: number; main: PackedObj[]; proposals: Prop[];
  history: { id: string; author: string; tool: string; summary: string; time: string }[];
  activity: { time: string; author: string; tool: string; args: string; ok: boolean; summary?: string; error?: string }[];
}

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const who = (a: string) => (a === 'human' ? 'you' : a);

// Renders for Claude Code always use the light palette (stable input for the model);
// the on-screen viewport follows the theme tokens.
const COLORS = { sage: '#5b8c7a', danger: '#a8483a', bg: '#fafaf9', grid1: '#d6d3d1', grid2: '#e7e5e4', ref: '#7d93ab' };
const cssVar = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

let state: State | null = null;
let focus: string = 'main';        // 'main' or a proposal id shown in the viewport/review
let before = false;                // Space held → show main (before)
let hoverStep: Step | null = null;
let selectedObj: string | null = null;
let selectedPart: string | null = null;
let wire = false;
let gizmoMode: 'translate' | 'rotate' = 'translate';
let lastFrameKey = '';
let ws: WebSocket | null = null;
let callSeq = 0;
let preview: { objects: PackedObj[]; obj: string } | null = null; // live slider scrub (not committed)
let previewPending = false, previewQueued: { object: string; params: Record<string, number> } | null = null;

// ── three.js ──────────────────────────────────────────────────────────
const vpEl = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
setupRenderer(renderer);
vpEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
const keyLight = addStage(scene, renderer);
let grid: THREE.GridHelper;
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
camera.position.set(1.3, 0.95, 1.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.25, 0);
controls.enableDamping = true;
function applyTheme() {
  scene.background = new THREE.Color(cssVar('--color-50', COLORS.bg));
  if (grid) { scene.remove(grid); grid.dispose(); }
  grid = new THREE.GridHelper(6, 60, cssVar('--color-300', COLORS.grid1), cssVar('--color-200', COLORS.grid2));
  grid.raycast = () => {};
  scene.add(grid);
}
const THEMES = ['auto', 'light', 'dark'] as const;
function setTheme(t: string) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('studio-theme', t); } catch { /* storage unavailable */ }
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = t === 'auto' ? 'Theme: auto' : t === 'dark' ? 'Theme: dark' : 'Theme: light';
  applyTheme();
}
let themePref = 'auto';
try { themePref = localStorage.getItem('studio-theme') ?? 'auto'; } catch { /* ignore */ }
const urlTheme = new URLSearchParams(location.search).get('theme');
if (urlTheme && (THEMES as readonly string[]).includes(urlTheme)) themePref = urlTheme;
setTheme(themePref);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());
const objGroup = new THREE.Group();
scene.add(objGroup);

// gizmo: drag an object (floor + turn) or a movable part
const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.8);
scene.add(gizmo.getHelper());
let dragging = false;
gizmo.addEventListener('dragging-changed', (e: any) => { controls.enabled = !e.value; dragging = !!e.value; if (e.value) tip.classList.remove('on'); });
gizmo.addEventListener('mouseUp', () => commitDrag());

function resize() {
  const r = vpEl.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(vpEl);
resize();
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

// ── decoding & meshes ─────────────────────────────────────────────────
function b64(s: string): ArrayBuffer {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

const geoCache = new Map<string, THREE.BufferGeometry>(); // creased-normal geometry per mesh payload
function geometryFor(o: PackedObj): THREE.BufferGeometry | null {
  if (!o.positions) return null;
  const key = o.positions.length + ':' + o.positions.slice(0, 64) + o.positions.slice(-64) + o.indices.slice(-32);
  const hit = geoCache.get(key);
  if (hit) return hit.clone();
  const pos = new Float32Array(b64(o.positions));
  const idx = new Uint32Array(b64(o.indices));
  if (!idx.length) return null;
  const flat = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) flat.set(pos.subarray(idx[i] * 3, idx[i] * 3 + 3), i * 3);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  // Smooth shading across gentle angles (cylinders, revolves, smooth), crisp edges above 35°.
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(35));
  geoCache.set(key, g);
  if (geoCache.size > 60) geoCache.delete(geoCache.keys().next().value!);
  return g.clone();
}

interface BuildOpts { highlight?: Set<string> | null; wireframe?: boolean; edges?: { color: string; opacity: number }; hidePart?: string; onlyPart?: string; shadows?: boolean }

/** One mesh per object, one material group per part (picking maps face.materialIndex → part). */
function buildMesh(o: PackedObj, opts: BuildOpts = {}): THREE.Mesh | null {
  const g = geometryFor(o);
  if (!g) return null;
  const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
  const mats: THREE.Material[] = [];
  const isRef = o.role === 'reference';
  o.parts.forEach((p, i) => {
    for (const [start, count] of p.ranges) g.addGroup(start * 3, count * 3, i);
    const hl = opts.highlight && (opts.highlight.has('*') || opts.highlight.has(p.name));
    const override = hl ? COLORS.sage : failing.has(p.name) ? COLORS.danger : undefined;
    let mat: THREE.Material;
    if (isRef) mat = new THREE.MeshStandardMaterial({ color: override ?? COLORS.ref, roughness: 0.7, transparent: true, opacity: 0.35, depthWrite: false, wireframe: !!opts.wireframe, side: THREE.DoubleSide });
    else mat = makeMaterial(p.material ?? o.material, { bbox: p.bbox, override, wireframe: opts.wireframe });
    if ((opts.hidePart && p.name === opts.hidePart) || (opts.onlyPart && p.name !== opts.onlyPart)) mat.visible = false;
    mats.push(mat);
  });
  if (!mats.length) mats.push(makeMaterial(o.material, { wireframe: opts.wireframe }));
  const m = new THREE.Mesh(g, mats);
  m.userData = { id: o.id, parts: o.parts.map((p) => p.name) };
  m.castShadow = !isRef && opts.shadows !== false;
  m.receiveShadow = !isRef && opts.shadows !== false;
  if (opts.edges && !opts.wireframe && !isRef && !opts.onlyPart) {
    const eg = new THREE.EdgesGeometry(g, 28);
    const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: opts.edges.color, transparent: opts.edges.opacity < 1, opacity: opts.edges.opacity }));
    lines.raycast = () => {}; // never pickable
    m.add(lines);
  }
  return m;
}

const texCache = new Map<string, THREE.Texture>();
const texLoading = new Map<string, Promise<THREE.Texture>>();
function textureFor(asset: string): Promise<THREE.Texture> {
  const hit = texCache.get(asset);
  if (hit) return Promise.resolve(hit);
  let p = texLoading.get(asset);
  if (!p) {
    p = new THREE.TextureLoader().loadAsync(`/assets/${asset}`).then((t) => { t.colorSpace = THREE.SRGBColorSpace; texCache.set(asset, t); rebuildScene(); return t; });
    texLoading.set(asset, p);
  }
  return p;
}

/** A reference image as a translucent backdrop plane (front: XY, side: ZY, top: XZ). */
function buildImagePlane(o: PackedObj): THREE.Mesh | null {
  const r = o.reference as ImageRef;
  const tex = texCache.get(r.asset);
  if (!tex) { void textureFor(r.asset); return null; }
  const g = new THREE.PlaneGeometry(r.width, r.height);
  if (r.plane === 'side') g.rotateY(Math.PI / 2);
  if (r.plane === 'top') g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: r.opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  m.position.set(...r.at);
  m.renderOrder = -1;
  m.raycast = () => {};
  m.userData = { id: o.id, parts: [] };
  return m;
}

function imageBox(o: PackedObj): THREE.Box3 | null {
  const r = o.reference;
  if (!r || r.kind !== 'image') return null;
  const [x, y, z] = r.at, w = r.width / 2, h = r.height / 2;
  const half = r.plane === 'front' ? [w, h, 0] : r.plane === 'side' ? [0, h, w] : [w, 0, h];
  return new THREE.Box3(new THREE.Vector3(x - half[0], y - half[1], z - half[2]), new THREE.Vector3(x + half[0], y + half[1], z + half[2]));
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
  });
}

function shownObjects(): PackedObj[] {
  if (!state) return [];
  if (preview && !before) return preview.objects;
  if (focus !== 'main' && !before) {
    const p = state.proposals.find((x) => x.id === focus);
    if (p) return p.objects;
  }
  return state.main;
}

/** Can the human edit what's on screen? Edits go to the shown branch (switching to it first). */
const editable = () => !!state && !before;

// holders: one group per object, pivoting at the object's origin, so the gizmo can move/turn it
const holders = new Map<string, THREE.Group>();
let partHolder: THREE.Group | null = null;

function rebuildScene() {
  gizmo.detach();
  objGroup.children.forEach(disposeTree);
  objGroup.clear();
  holders.clear();
  partHolder = null;
  const edgeStyle = { color: cssVar('--color-900', '#1c1917'), opacity: 0.14 };
  const objs = shownObjects();
  const sel = objs.find((o) => o.id === selectedObj);
  const selPart = sel && selectedPart ? sel.parts.find((p) => p.name === selectedPart) : null;
  const splitPart = selPart?.drag === 'op' && gizmoMode === 'translate' && !wire ? selPart.name : undefined;
  for (const o of objs) {
    let hl: Set<string> | null = null;
    if (hoverStep?.affects[o.id]) hl = new Set(hoverStep.affects[o.id]);
    else if (selectedPart && selectedObj === o.id) hl = new Set([selectedPart]);
    const holder = new THREE.Group();
    holder.position.set(...o.position);
    holder.userData = { id: o.id, pivot: [...o.position] };
    if (o.reference?.kind === 'image') {
      const plane = buildImagePlane(o);
      if (plane) objGroup.add(plane);
      continue;
    }
    const m = buildMesh(o, { highlight: hl, wireframe: wire, edges: edgeStyle, hidePart: o.id === selectedObj ? splitPart : undefined });
    if (!m) continue;
    m.position.set(-o.position[0], -o.position[1], -o.position[2]);
    holder.add(m);
    objGroup.add(holder);
    holders.set(o.id, holder);
    if (o.id === selectedObj && splitPart && selPart) {
      const pm = buildMesh(o, { highlight: hl, onlyPart: splitPart });
      if (pm) {
        const c = [(selPart.bbox.min[0] + selPart.bbox.max[0]) / 2, (selPart.bbox.min[1] + selPart.bbox.max[1]) / 2, (selPart.bbox.min[2] + selPart.bbox.max[2]) / 2] as V3;
        partHolder = new THREE.Group();
        partHolder.position.set(...c);
        partHolder.userData = { id: o.id, part: splitPart, pivot: c };
        pm.position.set(-c[0], -c[1], -c[2]);
        partHolder.add(pm);
        objGroup.add(partHolder);
      }
    }
  }
  const box = unionBox(objs.filter((o) => o.role !== 'reference'));
  fitShadow(keyLight, box);
  $('#empty').classList.toggle('hidden', objs.length > 0);
  const key = objs.map((o) => o.id).join('|');
  if (key && key !== lastFrameKey) { frame(objs, 'iso', camera, controls); lastFrameKey = key; }
  attachGizmo();
  const badge = $('#vpBadge');
  badge.className = 'vp-badge';
  if (preview) { badge.textContent = 'Preview: release to commit'; badge.classList.add('on'); }
  else if (before && focus !== 'main') { badge.textContent = 'Before (main)'; badge.classList.add('on', 'before'); }
  else if (focus !== 'main') { badge.textContent = `Proposal ${focus} · hold Space for before`; badge.classList.add('on'); }
}

function attachGizmo() {
  gizmo.detach();
  if (!editable() || !selectedObj || preview) return;
  const o = shownObjects().find((x) => x.id === selectedObj);
  if (!o || o.reference?.kind === 'image') return;
  gizmo.setMode(gizmoMode);
  if (partHolder && gizmoMode === 'translate') {
    gizmo.attach(partHolder);
    gizmo.showX = gizmo.showY = gizmo.showZ = true;
    return;
  }
  const h = holders.get(selectedObj);
  if (!h) return;
  gizmo.attach(h);
  if (gizmoMode === 'translate') { gizmo.showX = true; gizmo.showZ = true; gizmo.showY = false; }
  else { gizmo.showX = false; gizmo.showZ = false; gizmo.showY = true; }
}

const r4 = (v: number) => +v.toFixed(4);
function commitDrag() {
  const target = gizmo.object as THREE.Group | undefined;
  if (!target) return;
  const pv = target.userData.pivot as V3;
  const d: V3 = [target.position.x - pv[0], target.position.y - pv[1], target.position.z - pv[2]];
  const rot = THREE.MathUtils.radToDeg(target.rotation.y);
  if (Math.hypot(...d) < 0.0005 && Math.abs(rot) < 0.05) return;
  ensureBranch();
  if (target.userData.part) call('drag-part', { object: target.userData.id, part: target.userData.part, by: d.map(r4) });
  else call('drag-object', { object: target.userData.id, ...(Math.hypot(d[0], d[2]) >= 0.0005 ? { by: [r4(d[0]), r4(d[2])] } : {}), ...(Math.abs(rot) >= 0.05 ? { rotate: +rot.toFixed(1) } : {}) });
}

/** Hand edits land on the branch being looked at: switch to it first if Claude is elsewhere. */
function ensureBranch() {
  if (state && focus !== state.active) call('switch', { branch: focus });
}

function unionBox(objs: PackedObj[]): THREE.Box3 {
  const b = new THREE.Box3();
  for (const o of objs) {
    if (o.bbox) { b.expandByPoint(new THREE.Vector3(...o.bbox.min)); b.expandByPoint(new THREE.Vector3(...o.bbox.max)); }
    const ib = imageBox(o);
    if (ib) b.union(ib);
  }
  if (b.isEmpty()) b.set(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 0.5, 0.3));
  return b;
}

const VIEW_DIRS: Record<string, V3> = { front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, 0.0001], iso: [1, 0.75, 1.15], back: [0, 0, -1], hero: [1, 0.5, 1.3], low: [1, 0.18, 1.35] };

function frame(objs: PackedObj[], view: string, cam: THREE.Camera, ctl?: OrbitControls, fill = 0.62) {
  const b = unionBox(objs);
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3()).length();
  const d = new THREE.Vector3(...(VIEW_DIRS[view] ?? VIEW_DIRS.iso)).normalize();
  if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const pc = cam as THREE.PerspectiveCamera;
    const dist = (size * fill) / Math.tan(THREE.MathUtils.degToRad(pc.fov / 2));
    pc.position.copy(c).addScaledVector(d, dist);
    pc.near = dist / 100; pc.far = dist * 20; pc.updateProjectionMatrix();
  } else {
    const oc = cam as THREE.OrthographicCamera;
    const half = size * 0.6;
    oc.left = -half; oc.right = half; oc.top = half; oc.bottom = -half;
    oc.position.copy(c).addScaledVector(d, size * 3);
    oc.near = 0.001; oc.far = size * 10; oc.updateProjectionMatrix();
  }
  cam.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0);
  cam.lookAt(c);
  if (ctl) { ctl.target.copy(c); ctl.update(); }
}

// ── UI rendering ──────────────────────────────────────────────────────
function render() {
  if (!state) return;
  const openIds = state.proposals.map((p) => p.id);
  focus = validFocus(focus, openIds);
  const objs = shownObjects();
  if (!selectedObj || !objs.find((o) => o.id === selectedObj)) { selectedObj = objs.filter((o) => o.role !== 'reference').slice(-1)[0]?.id ?? objs[objs.length - 1]?.id ?? null; selectedPart = null; }
  const obj = objs.find((o) => o.id === selectedObj) ?? null;

  $('#objTitle').textContent = obj ? obj.name : 'No object yet';
  $('#branchChip').innerHTML = state.active === 'main'
    ? `main · <b>${state.mainHead ?? '—'}</b> · ${state.commitCount} commits`
    : `editing proposal <b>${state.active}</b>`;
  $('#navProposals').textContent = state.proposals.length ? `Proposals ${state.proposals.length}` : 'Proposals';

  // scene tree
  $('#tree').innerHTML = objs.length ? objs.map((o) => {
    const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
    const tag = o.role === 'reference' ? '<em class="tag">reference</em>' : o.linkedCopyOf ? '<em class="tag">linked</em>' : '';
    return `<div class="obj${o.role === 'reference' ? ' ref' : ''}${selectedObj === o.id && !selectedPart ? ' sel' : ''}" data-obj="${esc(o.id)}"><i></i>${esc(o.name)}${tag}</div>` +
      (o.role === 'reference' ? '' : o.parts.filter((p) => !p.name.startsWith('~')).map((p) => `<div class="part${selectedObj === o.id && selectedPart === p.name ? ' sel' : ''}${failing.has(p.name) ? ' fail' : ''}" data-obj="${esc(o.id)}" data-part="${esc(p.name)}"><span>${esc(p.name)}</span><span class="swatch" style="background:${esc(p.material?.color ?? o.material.color)}" title="${esc(p.material?.name ?? o.material.name)}"></span></div>`).join(''));
  }).join('') + '<div class="muted">Floor · y = 0</div>' : '<div class="muted">Empty scene</div>';

  // checks
  $('#checks').innerHTML = obj ? obj.checks.map((c) => `<span class="check${c.pass ? '' : c.pending ? ' pend' : ' fail'}" title="${esc(c.detail)}"><i></i>${esc(c.pass ? c.label : c.pending ? `In progress — ${c.detail}` : `${c.label} — ${c.detail}`)}</span>`).join('') : '';

  // inspector
  $('#inspLabel').textContent = obj ? `Inspector · ${obj.name}` : 'Inspector';
  const sp = obj && selectedPart ? obj.parts.find((p) => p.name === selectedPart) : null;
  const placeLine = obj?.placement ? `<br><span>Placed ${esc(obj.placement)} · drag it and it stays placed</span>` : '';
  const dragLine = (p: Part) => p.drag === 'op' ? 'drag the arrows to move just this part' : `dragging moves the whole ${esc(obj!.name)} (this part is a copy or is rotated after it's made)`;
  $('#partInfo').innerHTML = sp ? (() => {
    const d = [0, 1, 2].map((k) => Math.round((sp.bbox.max[k] - sp.bbox.min[k]) * 1000));
    return `<b>${esc(sp.name)}</b> · ${d[0]} × ${d[1]} × ${d[2]} mm · ${esc(sp.material?.name ?? '')}<br><span>made by ${esc((sp.ops ?? []).join(', ') || '—')} · ${dragLine(sp)} · Claude sees this via <code>studio selection</code></span>`;
  })() : obj ? (obj.role === 'reference'
    ? `<b>Reference</b> · ${esc(obj.reference?.file ?? '')}<br><span>Not exported. ${obj.reference?.kind === 'image' ? 'Shown in renders so Claude can model to match it.' : 'Measure it with <code>studio inspect</code>.'}</span>`
    : `<span>${esc(obj.material.name)}${obj.linkedCopyOf ? ` · linked copy of <b>${esc(obj.linkedCopyOf)}</b>` : ''}. Click a part to select it; drag the arrows to move${placeLine ? '' : ' or turn'} the object.</span>${placeLine}`) : '';
  const params = obj && !obj.linkedCopyOf ? Object.entries(obj.params) : [];
  $('#params').innerHTML = obj?.linkedCopyOf ? `<div class="noparams">Linked copy: change <b>${esc(obj.linkedCopyOf)}</b> and every copy follows.</div>`
    : params.length ? params.map(([k, p]) => {
      const isDeg = p.unit === 'deg';
      const lo = p.min ?? (isDeg ? Math.min(-45, p.value) : 0);
      const hi = p.max ?? (isDeg ? Math.max(45, p.value) : Math.max(p.value * 2, 0.1));
      const step = isDeg ? 0.5 : (hi - lo) / 400;
      const v = preview && preview.obj === obj!.id ? scrubValues[k] ?? p.value : p.value;
      return `<div class="param" title="${esc(p.description ?? '')}"><div class="param-row">${esc(k)} <b data-val="${esc(k)}">${fmtParam(v, p.unit)}</b></div>
      <input type="range" data-param="${esc(k)}" data-unit="${esc(p.unit ?? '')}" min="${lo}" max="${hi}" step="${step}" value="${v}"></div>`;
    }).join('') : '<div class="noparams">No parameters yet.</div>';
  $('#code').textContent = obj?.code ?? '';

  // activity feed
  const acts = state.activity.filter((a) => !['scene', 'inspect', 'check', 'log', 'proposals', 'ops', 'status', 'materials'].includes(a.tool)).slice(state.proposals.length ? -4 : -9);
  $('#feed').innerHTML = acts.length ? acts.map((a) => `<div class="fl${a.ok ? '' : ' err'}${a.author === 'human' ? ' you' : ''}" title="${esc(a.args)}"><span class="who">${esc(who(a.author))}</span><span class="tool">${esc(a.tool)}</span><span class="msg">${esc(a.ok ? a.summary ?? '' : a.error ?? 'error')}</span></div>`).join('')
    : '<div class="none">Waiting for Claude Code. Try <code>/studio make a walnut stool</code>.</div>';

  renderReview();
  renderHistory();
  rebuildScene();
}

function fmtParam(v: number, unit?: string) {
  if (unit === 'deg') return `${+v.toFixed(1)}°`;
  if (unit === 'm' || unit === undefined || unit === '') return Math.abs(v) < 10 ? `${+(v * 1000).toFixed(1)} mm` : String(v);
  return String(v);
}

function renderReview() {
  if (!state) return;
  const el = $('#review');
  if (!state.proposals.length) {
    el.innerHTML = '<div class="rv-empty">No open proposals. Ask Claude Code for alternatives, e.g. <code>/studio propose a lower backrest</code> — each change shows up here to keep or undo.</div>';
    return;
  }
  const thumbFor = (key: string, objs: PackedObj[]) => {
    let url = thumbCache.get(key);
    if (!url) { url = thumbnail(objs); thumbCache.set(key, url); if (thumbCache.size > 40) thumbCache.delete(thumbCache.keys().next().value!); }
    return url;
  };
  const mainKey = `main:${state.mainHead}`;
  const tabs = `<div class="thumbs"><button class="thumb${focus === 'main' ? ' on' : ''}" data-focus="main"><img alt="main" src="${thumbFor(mainKey, state.main)}"><span>main</span></button>${state.proposals.map((p) => {
    const key = `${p.id}:${p.steps.map((s) => s.id + (s.undone ? 'u' : '')).join(',')}`;
    return `<button class="thumb${focus === p.id ? ' on' : ''}" data-focus="${p.id}" title="${esc(p.title)}"><img alt="${esc(p.id)}" src="${thumbFor(key, p.objects)}"><span>${esc(p.id)}${p.allPass ? '' : ' · fails'}</span></button>`;
  }).join('')}</div>`;
  const p = state.proposals.find((x) => x.id === focus);
  if (!p) { el.innerHTML = tabs + '<div class="rv-empty">Showing main. Pick a proposal tab to review it.</div>'; return; }
  const kept = p.steps.filter((s) => !s.undone).length;
  const fails = Object.values(p.checks).flat().filter((c) => !c.pass);
  el.innerHTML = tabs +
    `<div class="rv-head"><span>${esc(p.id)} · ${esc(p.title)} · ${p.steps.length} change${p.steps.length === 1 ? '' : 's'}</span>${p.allPass ? '<span class="ok">checks pass</span>' : `<span class="bad">${fails.length} check${fails.length === 1 ? '' : 's'} failing</span>`}</div>` +
    (p.steps.length ? p.steps.map((s) => `<div class="step${s.undone ? ' undone' : ''}${s.author === 'human' ? ' you' : ''}" data-step="${s.id}"><span class="txt">${esc(s.summary)}<span class="who">${esc(who(s.author))} · ${esc(s.tool)}</span></span><span class="btns"><button class="k" data-act="keep" data-step="${s.id}">Keep</button><button class="u" data-act="undo-step" data-step="${s.id}">${s.undone ? 'Undone' : 'Undo'}</button></span></div>`).join('') : '<div class="rv-empty">No changes on this proposal yet.</div>') +
    (fails.length ? `<div class="rv-fails">${fails.map((f) => esc(`${f.label}: ${f.detail}`)).join('<br>')}</div>` : '') +
    `<div class="rv-actions"><button class="primary" data-act="commit-proposal">Commit ${kept} change${kept === 1 ? '' : 's'}</button><button class="ghost" data-act="discard-proposal">Discard</button><span class="hint">Hover a change to see it · hold Space for before</span></div>`;
}

function renderHistory() {
  if (!state) return;
  const commits = state.history.slice(0, 8); // newest first
  $('#history').innerHTML = `<span class="h-label">History</span>` +
    state.proposals.map((p) => `<span class="commit prop" data-focus="${p.id}">${esc(p.id)} · ${esc(p.title)} · in review</span>`).join('') +
    commits.map((c, i) => `<span class="commit${i === 0 ? ' on' : ''}${c.author === 'human' ? ' you' : ''}" title="${esc(c.summary)} — ${esc(who(c.author))} · ${esc(c.tool)}">${esc(c.id)} · ${c.author === 'human' ? 'you: ' : ''}${esc(c.summary.length > 34 ? c.summary.slice(0, 33) + '…' : c.summary)}</span>`).join('');
}

// ── picking (click a part in the viewport) ────────────────────────────
const ray = new THREE.Raycaster();
let downAt: [number, number] | null = null;
function pickAt(cx: number, cy: number): { obj: string; part: string | null } | null {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(objGroup.children, true).find((h) => (h.object as THREE.Mesh).userData?.id && (Array.isArray((h.object as THREE.Mesh).material) ? ((h.object as THREE.Mesh).material as THREE.Material[])[h.face?.materialIndex ?? 0]?.visible !== false : true));
  if (!hit) return null;
  const m = hit.object as THREE.Mesh;
  const gi = hit.face?.materialIndex ?? -1;
  const parts: string[] = m.userData.parts ?? [];
  const part = parts[gi] ?? null;
  return { obj: m.userData.id, part: part && !part.startsWith('~') ? part : null };
}
function select(obj: string | null, part: string | null) {
  selectedObj = obj; selectedPart = part;
  ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'select', object: obj, part }));
  render();
}
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (dragging || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { downAt = null; return; }
  downAt = null;
  if ((gizmo as any).axis) return; // clicked a gizmo handle
  const p = pickAt(e.clientX, e.clientY);
  if (!p) { if (selectedPart) select(selectedObj, null); return; }
  select(p.obj, p.part && p.part === selectedPart && p.obj === selectedObj ? null : p.part);
});
const tip = document.createElement('div');
tip.className = 'pick-tip';
vpEl.appendChild(tip);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || dragging) { tip.classList.remove('on'); return; }
  const p = pickAt(e.clientX, e.clientY);
  renderer.domElement.style.cursor = p?.part ? 'pointer' : '';
  if (p?.part) {
    const r = vpEl.getBoundingClientRect();
    tip.textContent = p.part;
    tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 10}px`;
    tip.classList.add('on');
  } else tip.classList.remove('on');
});
renderer.domElement.addEventListener('pointerleave', () => tip.classList.remove('on'));

// ── interactions ──────────────────────────────────────────────────────
function toast(msg: string) {
  let t = document.querySelector('.toast') as HTMLElement | null;
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  setTimeout(() => t!.classList.remove('on'), 2600);
}

function call(tool: string, args: object) {
  if (!ws || ws.readyState !== 1) { toast('Not connected to the engine'); return; }
  ws.send(JSON.stringify({ type: 'call', id: ++callSeq, tool, args }));
}

function setGizmoMode(m: 'translate' | 'rotate') {
  gizmoMode = m;
  document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.gizmo === m));
  rebuildScene();
}

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-act],[data-focus],[data-obj],[data-mode],[data-cam],[data-theme-toggle],[data-gizmo]') as HTMLElement | null;
  if (!t) return;
  if (t.dataset.themeToggle !== undefined) {
    themePref = THEMES[(THEMES.indexOf(themePref as any) + 1) % THEMES.length];
    setTheme(themePref);
    rebuildScene();
  } else if (t.dataset.act) {
    const args: any = { proposal: focus };
    if (t.dataset.step) args.step = t.dataset.step;
    if (t.dataset.act === 'discard-proposal' && !confirm(`Discard ${focus}? It stays in history.`)) return;
    call(t.dataset.act, args);
  } else if (t.dataset.focus) {
    focus = t.dataset.focus; hoverStep = null; render();
  } else if (t.dataset.obj) {
    select(t.dataset.obj, t.dataset.part && selectedPart !== t.dataset.part ? t.dataset.part : null);
  } else if (t.dataset.mode) {
    wire = t.dataset.mode === 'wire';
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === t));
    rebuildScene();
  } else if (t.dataset.gizmo) {
    setGizmoMode(t.dataset.gizmo as 'translate' | 'rotate');
  } else if (t.dataset.cam) {
    frame(shownObjects(), t.dataset.cam, camera, controls);
  }
});

$('#review').addEventListener('mouseover', (e) => {
  const row = (e.target as HTMLElement).closest('.step') as HTMLElement | null;
  const p = state?.proposals.find((x) => x.id === focus);
  const s = row && p ? p.steps.find((x) => x.id === row.dataset.step) ?? null : null;
  if (s !== hoverStep) { hoverStep = s; rebuildScene(); }
});
$('#review').addEventListener('mouseleave', () => { if (hoverStep) { hoverStep = null; rebuildScene(); } });

// params: scrubbing previews live (evaluated by the engine, not committed); release commits one step
const scrubValues: Record<string, number> = {};
function requestPreview(object: string, params: Record<string, number>) {
  if (previewPending) { previewQueued = { object, params }; return; }
  previewPending = true;
  ws?.send(JSON.stringify({ type: 'preview', id: ++callSeq, branch: focus, object, params }));
}
$('#params').addEventListener('input', (e) => {
  const inp = e.target as HTMLInputElement;
  if (!inp.dataset.param || !selectedObj) return;
  const v = Number(inp.value);
  scrubValues[inp.dataset.param] = v;
  const lab = document.querySelector(`[data-val="${CSS.escape(inp.dataset.param)}"]`);
  if (lab) lab.textContent = fmtParam(v, inp.dataset.unit);
  requestPreview(selectedObj, { ...scrubValues });
});
$('#params').addEventListener('change', (e) => {
  const inp = e.target as HTMLInputElement;
  if (!inp.dataset.param || !selectedObj) return;
  ensureBranch();
  call('set-param', { object: selectedObj, name: inp.dataset.param, value: +Number(inp.value).toFixed(5) });
  for (const k of Object.keys(scrubValues)) delete scrubValues[k];
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space' && focus !== 'main' && !before) { e.preventDefault(); before = true; rebuildScene(); }
  else if (e.key === 'g' || e.key === 'w') setGizmoMode('translate');
  else if (e.key === 'r' || e.key === 'e') setGizmoMode('rotate');
  else if (e.key === 'Escape') select(null, null);
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && before) { before = false; rebuildScene(); } });

// drag and drop a mesh or reference image onto the viewport → import (as you)
vpEl.addEventListener('dragover', (e) => { e.preventDefault(); vpEl.classList.add('drop'); });
vpEl.addEventListener('dragleave', () => vpEl.classList.remove('drop'));
vpEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  vpEl.classList.remove('drop');
  for (const f of Array.from(e.dataTransfer?.files ?? [])) {
    toast(`Importing ${f.name}…`);
    try {
      const res = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const r = await res.json();
      toast(r.ok ? r.summary : r.error ?? 'import failed');
    } catch (err: any) { toast(err.message ?? 'import failed'); }
  }
});

// ── renders for Claude Code (labeled) and for people (presentation) ───
const rr = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
setupRenderer(rr);
const TS = 192;
const tr = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
setupRenderer(tr);
tr.setSize(TS, TS, false);
const thumbCache = new Map<string, string>();
function thumbnail(objs: PackedObj[]): string {
  const s = new THREE.Scene();
  s.background = new THREE.Color(cssVar('--color-100', '#f5f5f4'));
  const key = addStage(s, tr, { shadowOpacity: 0.18 });
  const models = objs.filter((o) => o.role !== 'reference');
  for (const o of models) { const m = buildMesh(o, { edges: { color: '#292524', opacity: 0.25 } }); if (m) s.add(m); }
  fitShadow(key, unionBox(models));
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  frame(models, 'iso', cam);
  tr.render(s, cam);
  disposeTree(s);
  return tr.domElement.toDataURL('image/png');
}

async function handleRender(msg: any) {
  const reply = (body: object) => ws?.send(JSON.stringify({ type: 'render-result', id: msg.id, ...body }));
  try {
    if (!state) return reply({ error: 'view has no state yet' });
    let objs = msg.proposal ? state.proposals.find((p) => p.id === msg.proposal)?.objects : (state.active !== 'main' ? state.proposals.find((p) => p.id === state!.active)?.objects : state.main);
    if (!objs) return reply({ error: `no proposal ${msg.proposal}` });
    if (msg.object) objs = objs.filter((o) => o.id === msg.object || o.name.toLowerCase() === String(msg.object).toLowerCase() || o.role === 'reference');
    const presentation = msg.style === 'presentation';
    if (presentation) objs = objs.filter((o) => o.role !== 'reference');
    if (!objs.filter((o) => o.role !== 'reference').length) return reply({ error: 'nothing to render' });
    await Promise.all(objs.filter((o) => o.reference?.kind === 'image').map((o) => textureFor((o.reference as ImageRef).asset).catch(() => null)));
    const W = msg.size ?? 768, H = presentation ? Math.round(W * 0.75) : W;
    rr.setSize(W, H, false);
    const s = new THREE.Scene();
    if (!presentation) s.background = new THREE.Color(COLORS.bg);
    const key = addStage(s, rr, { shadowOpacity: presentation ? 0.3 : 0.18, envIntensity: presentation ? 0.95 : 0.85 });
    if (!presentation) s.add(new THREE.GridHelper(6, 60, COLORS.grid1, COLORS.grid2));
    for (const o of objs) {
      if (o.reference?.kind === 'image') { const p = buildImagePlane(o); if (p) s.add(p); continue; }
      const m = buildMesh(o, { edges: presentation ? undefined : { color: '#292524', opacity: 0.85 } });
      if (m) s.add(m);
    }
    const models = objs.filter((o) => o.role !== 'reference');
    fitShadow(key, unionBox(models));
    const legend: { n: number; object: string; part: string; failing: boolean }[] = [];
    if (!presentation) for (const o of models) {
      const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
      for (const p of o.parts) if (!p.name.startsWith('~')) legend.push({ n: legend.length + 1, object: o.name, part: p.name, failing: failing.has(p.name) });
    }
    const images = (msg.views as string[]).map((view) => {
      const persp = view === 'iso' || presentation;
      const cam = persp ? new THREE.PerspectiveCamera(presentation ? 28 : 35, W / H, 0.01, 100) : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
      frame(presentation ? models : objs!, presentation && !VIEW_DIRS[view] ? 'hero' : view, cam, undefined, presentation ? 0.5 : 0.62);
      rr.setClearColor(0x000000, 0);
      rr.render(s, cam);
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d')!;
      if (presentation) {
        // seamless studio backdrop: warm light falling off toward the edges
        const grad = g.createRadialGradient(W * 0.5, H * 0.42, W * 0.05, W * 0.5, H * 0.55, W * 0.75);
        grad.addColorStop(0, '#f7f4ef'); grad.addColorStop(0.6, '#ebe6de'); grad.addColorStop(1, '#d9d2c8');
        g.fillStyle = grad; g.fillRect(0, 0, W, H);
      }
      g.drawImage(rr.domElement, 0, 0);
      if (msg.labels && !presentation) {
        let k = 0;
        for (const o of models) for (const p of o.parts) {
          if (p.name.startsWith('~')) continue;
          const L = legend[k++];
          const ctr = new THREE.Vector3((p.bbox.min[0] + p.bbox.max[0]) / 2, (p.bbox.min[1] + p.bbox.max[1]) / 2, (p.bbox.min[2] + p.bbox.max[2]) / 2).project(cam);
          const x = (ctr.x * 0.5 + 0.5) * W, y = (-ctr.y * 0.5 + 0.5) * H;
          g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2);
          g.fillStyle = L.failing ? COLORS.danger : '#23466f'; g.fill();
          g.fillStyle = '#ffffff'; g.font = '600 14px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(L.n), x, y + 0.5);
        }
      }
      if (!presentation) {
        g.fillStyle = '#57534e'; g.font = '500 15px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
        g.fillText(`${view} · ${models.map((o) => o.name).join(', ')}${msg.proposal ? ` · proposal ${msg.proposal}` : ''}`, 14, H - 14);
      }
      return { view, data: c.toDataURL('image/png') };
    });
    disposeTree(s);
    reply({ images, legend });
  } catch (e: any) {
    reply({ error: e.message ?? String(e) });
  }
}

// ── texture bake for game export (Decision 15) ─────────────────────────
// The daemon sends unwrapped parts (world positions + UVs); each part's material is drawn into
// UV space with the same grain shader the viewport uses, lighting-free, then islands are dilated
// so mipmaps don't bleed background into the edges. Two textures: base colour (sRGB) and
// glTF metallic-roughness (linear: G = roughness, B = metalness).
const br = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false });
br.setPixelRatio(1);
br.toneMapping = THREE.NoToneMapping;
const UV_VERTEX = 'gl_Position = vec4(bakeUv.x * 2.0 - 1.0, 1.0 - bakeUv.y * 2.0, 0.0, 1.0);';

function dilate(img: ImageData, passes: number) {
  const { width: W, height: H, data } = img;
  let filled = new Uint8Array(W * H);
  let sum = [0, 0, 0], n = 0;
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] > 0) { filled[i] = 1; sum[0] += data[i * 4]; sum[1] += data[i * 4 + 1]; sum[2] += data[i * 4 + 2]; n++; }
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (filled[i]) continue;
      let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const j = Y * W + X;
        if (!filled[j]) continue;
        r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; c++;
      }
      if (c) { data[i * 4] = r / c; data[i * 4 + 1] = g / c; data[i * 4 + 2] = b / c; data[i * 4 + 3] = 255; next[i] = 1; }
    }
    filled = next;
  }
  const avg = n ? sum.map((v) => v / n) : [128, 128, 128];
  for (let i = 0; i < W * H; i++) { if (!filled[i]) { data[i * 4] = avg[0]; data[i * 4 + 1] = avg[1]; data[i * 4 + 2] = avg[2]; } data[i * 4 + 3] = 255; }
}

function bakePass(parts: any[], size: number, padding: number, kind: 'base' | 'mr'): string {
  br.outputColorSpace = kind === 'base' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  br.setSize(size, size, false);
  br.setClearColor(0x000000, 0);
  const s = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  for (const p of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
    g.setAttribute('bakeUv', new THREE.BufferAttribute(p.uv, 2));
    const m: Mat = p.material;
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false, depthTest: false, depthWrite: false });
    if (kind === 'base') mat.color.set(m.color);
    else mat.color.setRGB(0, m.roughness ?? 0.6, m.metalness ?? 0, THREE.LinearSRGBColorSpace);
    addGrain(mat, kind === 'base' ? m : { ...m, grain: null }, p.bbox, { vertexDecl: 'attribute vec2 bakeUv;\n', vertex: UV_VERTEX });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    s.add(mesh);
  }
  br.render(s, cam);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g2 = c.getContext('2d', { willReadFrequently: true })!;
  g2.drawImage(br.domElement, 0, 0);
  const img = g2.getImageData(0, 0, size, size);
  dilate(img, padding * 2);
  g2.putImageData(img, 0, 0);
  disposeTree(s);
  return c.toDataURL('image/png');
}

async function handleBake(msg: any) {
  const reply = (body: object) => ws?.send(JSON.stringify({ type: 'bake-result', id: msg.id, ...body }));
  try {
    const parts = (msg.parts as any[]).map((p) => ({ ...p, pos: decodeF32(p.positions), uv: decodeF32(p.uvs) }));
    const baseColor = bakePass(parts, msg.size, msg.padding, 'base');
    const metallicRoughness = bakePass(parts, msg.size, msg.padding, 'mr');
    reply({ baseColor, metallicRoughness });
  } catch (e: any) {
    reply({ error: e.message ?? String(e) });
  }
}
function decodeF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ── connection ────────────────────────────────────────────────────────
function connect() {
  const conn = $('#conn');
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { conn.className = 'conn live'; conn.querySelector('span')!.textContent = 'live'; };
  ws.onclose = () => { conn.className = 'conn down'; conn.querySelector('span')!.textContent = 'reconnecting'; setTimeout(connect, 1200); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'state') {
      focus = focusOnState(focus, state?.active, m.state.active);
      state = m.state;
      preview = null;
      for (const o of [...state!.main, ...state!.proposals.flatMap((p) => p.objects)]) if (o.reference?.kind === 'image') void textureFor(o.reference.asset);
      render();
    } else if (m.type === 'preview') {
      previewPending = false;
      if (!m.error && Object.keys(scrubValues).length) { preview = { objects: m.objects, obj: selectedObj! }; rebuildScene(); }
      if (previewQueued) { const q = previewQueued; previewQueued = null; requestPreview(q.object, q.params); }
    }
    else if (m.type === 'render') void handleRender(m);
    else if (m.type === 'bake') void handleBake(m);
    else if (m.type === 'call-result' && !m.result.ok) toast(m.result.error ?? 'error');
  };
}
connect();

// Automation hook (headless tests drive real pointer events; this only reports where things are).
(window as any).__studioView = {
  /** Screen position (CSS px) of an object's origin or a world point. */
  project(p: V3 | string) {
    const v = typeof p === 'string' ? new THREE.Vector3(...(holders.get(p)?.userData.pivot ?? [0, 0, 0])) : new THREE.Vector3(...p);
    v.project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height];
  },
  gizmoAxis: () => (gizmo as any).axis ?? null,
  attached: () => (gizmo.object ? { id: gizmo.object.userData.id, part: gizmo.object.userData.part ?? null, pivot: gizmo.object.userData.pivot } : null),
  selection: () => ({ object: selectedObj, part: selectedPart }),
};
