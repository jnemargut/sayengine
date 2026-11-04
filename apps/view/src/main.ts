// Browser view: a live mirror of the engine daemon (the website is "just the view").
// Watch, inspect, review proposals change-by-change (Decision 9), and render labeled
// images for Claude Code on request (Decision 6).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { focusOnState, validFocus } from './focus.ts';

type V3 = [number, number, number];
interface BBox { min: V3; max: V3 }
interface Check { id: string; label: string; pass: boolean; detail: string; parts?: string[]; pending?: boolean }
interface Param { value: number; unit?: string; min?: number; max?: number; description?: string }
interface PackedObj {
  id: string; name: string; type: string; material: { name: string; color: string; roughness?: number };
  params: Record<string, Param>; code: string; ok: boolean; error?: string;
  positions: string; indices: string; parts: { name: string; ranges: [number, number][]; bbox: BBox; ops?: string[] }[];
  bbox: BBox | null; checks: Check[];
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

// Renders for Claude Code always use the light palette (stable input for the model);
// the on-screen viewport follows the theme tokens.
const COLORS = { sage: '#5b8c7a', danger: '#a8483a', bg: '#fafaf9', grid1: '#d6d3d1', grid2: '#e7e5e4' };
const cssVar = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

let state: State | null = null;
let focus: string = 'main';        // 'main' or a proposal id shown in the viewport/review
let before = false;                // Space held → show main (before)
let hoverStep: Step | null = null;
let selectedObj: string | null = null;
let selectedPart: string | null = null;
let wire = false;
let lastFrameKey = '';
let ws: WebSocket | null = null;
let callSeq = 0;

// ── three.js ──────────────────────────────────────────────────────────
const vpEl = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
vpEl.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.bg);
let grid: THREE.GridHelper;
const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 200);
camera.position.set(1.3, 0.95, 1.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.25, 0);
controls.enableDamping = true;
function addLights(s: THREE.Scene) {
  s.add(new THREE.HemisphereLight('#ffffff', '#d6d3d1', 1.7));
  const key = new THREE.DirectionalLight('#ffffff', 1.9); key.position.set(2.5, 4, 3); s.add(key);
  const fill = new THREE.DirectionalLight('#ffffff', 0.6); fill.position.set(-3, 2, -2); s.add(fill);
}
addLights(scene);
function applyTheme() {
  scene.background = new THREE.Color(cssVar('--color-50', COLORS.bg));
  if (grid) { scene.remove(grid); grid.dispose(); }
  grid = new THREE.GridHelper(6, 60, cssVar('--color-300', COLORS.grid1), cssVar('--color-200', COLORS.grid2));
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

function partColor(o: PackedObj, part: string, opts: { failing: Set<string>; highlight: Set<string> | null }): string {
  if (opts.highlight && (opts.highlight.has('*') || opts.highlight.has(part))) return COLORS.sage;
  if (opts.failing.has(part)) return COLORS.danger;
  return o.material.color;
}

function buildMesh(o: PackedObj, highlight: Set<string> | null, wireframe: boolean, edges?: { color: string; opacity: number }): THREE.Mesh | null {
  if (!o.positions) return null;
  const pos = new Float32Array(b64(o.positions));
  const idx = new Uint32Array(b64(o.indices));
  if (!idx.length) return null;
  const flat = new Float32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) flat.set(pos.subarray(idx[i] * 3, idx[i] * 3 + 3), i * 3);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(flat, 3));
  // Smooth shading across gentle angles (cylinders, revolves, smooth), crisp edges above 35°.
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(35));
  const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
  const mats: THREE.Material[] = [];
  o.parts.forEach((p, i) => {
    for (const [start, count] of p.ranges) g.addGroup(start * 3, count * 3, i);
    mats.push(new THREE.MeshStandardMaterial({
      color: partColor(o, p.name, { failing, highlight }), roughness: o.material.roughness ?? 0.6, metalness: 0,
      flatShading: false, wireframe, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
  });
  if (!mats.length) mats.push(new THREE.MeshStandardMaterial({ color: o.material.color, flatShading: true, wireframe }));
  const m = new THREE.Mesh(g, mats);
  m.userData = { id: o.id, parts: o.parts.map((p) => p.name) };
  if (edges && !wireframe) {
    const eg = new THREE.EdgesGeometry(g, 28);
    const lines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: edges.color, transparent: edges.opacity < 1, opacity: edges.opacity }));
    lines.raycast = () => {}; // never pickable
    m.add(lines);
  }
  return m;
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
  if (focus !== 'main' && !before) {
    const p = state.proposals.find((x) => x.id === focus);
    if (p) return p.objects;
  }
  return state.main;
}

function rebuildScene() {
  objGroup.children.forEach(disposeTree);
  objGroup.clear();
  const edgeStyle = { color: cssVar('--color-900', '#1c1917'), opacity: 0.18 };
  const objs = shownObjects();
  for (const o of objs) {
    let hl: Set<string> | null = null;
    if (hoverStep?.affects[o.id]) hl = new Set(hoverStep.affects[o.id]);
    else if (selectedPart && selectedObj === o.id) hl = new Set([selectedPart]);
    const m = buildMesh(o, hl, wire, edgeStyle);
    if (m) objGroup.add(m);
  }
  $('#empty').classList.toggle('hidden', objs.length > 0);
  const key = objs.map((o) => o.id).join('|');
  if (key && key !== lastFrameKey) { frame(objs, 'iso', camera, controls); lastFrameKey = key; }
  const badge = $('#vpBadge');
  badge.className = 'vp-badge';
  if (before && focus !== 'main') { badge.textContent = 'Before (main)'; badge.classList.add('on', 'before'); }
  else if (focus !== 'main') { badge.textContent = `Proposal ${focus} · hold Space for before`; badge.classList.add('on'); }
}

function unionBox(objs: PackedObj[]): THREE.Box3 {
  const b = new THREE.Box3();
  for (const o of objs) if (o.bbox) { b.expandByPoint(new THREE.Vector3(...o.bbox.min)); b.expandByPoint(new THREE.Vector3(...o.bbox.max)); }
  if (b.isEmpty()) b.set(new THREE.Vector3(-0.3, 0, -0.3), new THREE.Vector3(0.3, 0.5, 0.3));
  return b;
}

const VIEW_DIRS: Record<string, V3> = { front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, 0.0001], iso: [1, 0.75, 1.15], back: [0, 0, -1] };

function frame(objs: PackedObj[], view: string, cam: THREE.Camera, ctl?: OrbitControls) {
  const b = unionBox(objs);
  const c = b.getCenter(new THREE.Vector3());
  const size = b.getSize(new THREE.Vector3()).length();
  const d = new THREE.Vector3(...(VIEW_DIRS[view] ?? VIEW_DIRS.iso)).normalize();
  if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const pc = cam as THREE.PerspectiveCamera;
    const dist = (size * 0.62) / Math.tan(THREE.MathUtils.degToRad(pc.fov / 2));
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
  if (!selectedObj || !objs.find((o) => o.id === selectedObj)) { selectedObj = objs[objs.length - 1]?.id ?? null; selectedPart = null; }
  const obj = objs.find((o) => o.id === selectedObj) ?? null;

  $('#objTitle').textContent = obj ? obj.name : 'No object yet';
  $('#branchChip').innerHTML = state.active === 'main'
    ? `main · <b>${state.mainHead ?? '—'}</b> · ${state.commitCount} commits`
    : `editing proposal <b>${state.active}</b>`;
  $('#navProposals').textContent = state.proposals.length ? `Proposals ${state.proposals.length}` : 'Proposals';

  // scene tree
  $('#tree').innerHTML = objs.length ? objs.map((o) => {
    const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
    return `<div class="obj" data-obj="${esc(o.id)}"><i></i>${esc(o.name)}</div>` +
      o.parts.filter((p) => !p.name.startsWith('~')).map((p) => `<div class="part${selectedObj === o.id && selectedPart === p.name ? ' sel' : ''}${failing.has(p.name) ? ' fail' : ''}" data-obj="${esc(o.id)}" data-part="${esc(p.name)}"><span>${esc(p.name)}</span></div>`).join('');
  }).join('') + '<div class="muted">Floor · y = 0</div>' : '<div class="muted">Empty scene</div>';

  // checks
  $('#checks').innerHTML = obj ? obj.checks.map((c) => `<span class="check${c.pass ? '' : c.pending ? ' pend' : ' fail'}" title="${esc(c.detail)}"><i></i>${esc(c.pass ? c.label : c.pending ? `In progress — ${c.detail}` : `${c.label} — ${c.detail}`)}</span>`).join('') : '';

  // inspector
  $('#inspLabel').textContent = obj ? `Inspector · ${obj.name}` : 'Inspector';
  const sp = obj && selectedPart ? obj.parts.find((p) => p.name === selectedPart) : null;
  $('#partInfo').innerHTML = sp ? (() => {
    const d = [0, 1, 2].map((k) => Math.round((sp.bbox.max[k] - sp.bbox.min[k]) * 1000));
    return `<b>${esc(sp.name)}</b> · ${d[0]} × ${d[1]} × ${d[2]} mm · lowest y ${Math.round(sp.bbox.min[1] * 1000)} mm<br><span>made by ${esc((sp.ops ?? []).join(', ') || '—')} · Claude sees this via <code>studio selection</code></span>`;
  })() : obj ? '<span>Click a part in the viewport to select it.</span>' : '';
  const params = obj ? Object.entries(obj.params) : [];
  $('#params').innerHTML = params.length ? params.map(([k, p]) => {
    const isDeg = p.unit === 'deg';
    const lo = p.min ?? (isDeg ? Math.min(-45, p.value) : 0);
    const hi = p.max ?? (isDeg ? Math.max(45, p.value) : Math.max(p.value * 2, 0.1));
    const step = isDeg ? 0.5 : (hi - lo) / 400;
    return `<div class="param" title="${esc(p.description ?? '')}"><div class="param-row">${esc(k)} <b data-val="${esc(k)}">${fmtParam(p.value, p.unit)}</b></div>
      <input type="range" data-param="${esc(k)}" data-unit="${esc(p.unit ?? '')}" min="${lo}" max="${hi}" step="${step}" value="${p.value}"></div>`;
  }).join('') : '<div class="noparams">No parameters yet.</div>';
  $('#code').textContent = obj?.code ?? '';

  // activity feed
  const acts = state.activity.filter((a) => !['scene', 'inspect', 'check', 'log', 'proposals', 'ops', 'status'].includes(a.tool)).slice(state.proposals.length ? -4 : -9);
  $('#feed').innerHTML = acts.length ? acts.map((a) => `<div class="fl${a.ok ? '' : ' err'}" title="${esc(a.args)}"><span class="who">${esc(a.author)}</span><span class="tool">${esc(a.tool)}</span><span class="msg">${esc(a.ok ? a.summary ?? '' : a.error ?? 'error')}</span></div>`).join('')
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
    (p.steps.length ? p.steps.map((s) => `<div class="step${s.undone ? ' undone' : ''}" data-step="${s.id}"><span class="txt">${esc(s.summary)}<span class="who">${esc(s.author)} · ${esc(s.tool)}</span></span><span class="btns"><button class="k" data-act="keep" data-step="${s.id}">Keep</button><button class="u" data-act="undo-step" data-step="${s.id}">${s.undone ? 'Undone' : 'Undo'}</button></span></div>`).join('') : '<div class="rv-empty">No changes on this proposal yet.</div>') +
    (fails.length ? `<div class="rv-fails">${fails.map((f) => esc(`${f.label}: ${f.detail}`)).join('<br>')}</div>` : '') +
    `<div class="rv-actions"><button class="primary" data-act="commit-proposal">Commit ${kept} change${kept === 1 ? '' : 's'}</button><button class="ghost" data-act="discard-proposal">Discard</button><span class="hint">Hover a change to see it · hold Space for before</span></div>`;
}

function renderHistory() {
  if (!state) return;
  const commits = state.history.slice(0, 8); // newest first
  $('#history').innerHTML = `<span class="h-label">History</span>` +
    state.proposals.map((p) => `<span class="commit prop" data-focus="${p.id}">${esc(p.id)} · ${esc(p.title)} · in review</span>`).join('') +
    commits.map((c, i) => `<span class="commit${i === 0 ? ' on' : ''}" title="${esc(c.summary)} — ${esc(c.author)} · ${esc(c.tool)}">${esc(c.id)} · ${esc(c.summary.length > 34 ? c.summary.slice(0, 33) + '…' : c.summary)}</span>`).join('');
}

// ── picking (click a part in the viewport) ────────────────────────────
const ray = new THREE.Raycaster();
let downAt: [number, number] | null = null;
function pickAt(cx: number, cy: number): { obj: string; part: string | null } | null {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(objGroup.children, false)[0];
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
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { downAt = null; return; }
  downAt = null;
  const p = pickAt(e.clientX, e.clientY);
  if (!p) { if (selectedPart) select(selectedObj, null); return; }
  select(p.obj, p.part && p.part === selectedPart && p.obj === selectedObj ? null : p.part);
});
const tip = document.createElement('div');
tip.className = 'pick-tip';
vpEl.appendChild(tip);
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) { tip.classList.remove('on'); return; }
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

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-act],[data-focus],[data-obj],[data-mode],[data-cam],[data-theme-toggle]') as HTMLElement | null;
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

$('#params').addEventListener('input', (e) => {
  const inp = e.target as HTMLInputElement;
  if (!inp.dataset.param) return;
  const v = Number(inp.value);
  const lab = document.querySelector(`[data-val="${CSS.escape(inp.dataset.param)}"]`);
  if (lab) lab.textContent = fmtParam(v, inp.dataset.unit);
});
$('#params').addEventListener('change', (e) => {
  const inp = e.target as HTMLInputElement;
  if (!inp.dataset.param || !selectedObj) return;
  call('set-param', { object: selectedObj, name: inp.dataset.param, value: +Number(inp.value).toFixed(5) });
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && focus !== 'main' && !before) { e.preventDefault(); before = true; rebuildScene(); }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && before) { before = false; rebuildScene(); } });

// ── renders for Claude Code (Decision 6: labeled, separate images) ────
const rr = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
rr.outputColorSpace = THREE.SRGBColorSpace;
const RS = 768;
rr.setSize(RS, RS, false);

const TS = 192;
const tr = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
tr.outputColorSpace = THREE.SRGBColorSpace;
tr.setSize(TS, TS, false);
const thumbCache = new Map<string, string>();
function thumbnail(objs: PackedObj[]): string {
  const s = new THREE.Scene();
  s.background = new THREE.Color(cssVar('--color-100', '#f5f5f4'));
  addLights(s);
  for (const o of objs) { const m = buildMesh(o, null, false, { color: '#292524', opacity: 0.35 }); if (m) s.add(m); }
  const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  frame(objs, 'iso', cam);
  tr.render(s, cam);
  disposeTree(s);
  return tr.domElement.toDataURL('image/png');
}

function handleRender(msg: any) {
  const reply = (body: object) => ws?.send(JSON.stringify({ type: 'render-result', id: msg.id, ...body }));
  try {
    if (!state) return reply({ error: 'view has no state yet' });
    let objs = msg.proposal ? state.proposals.find((p) => p.id === msg.proposal)?.objects : (state.active !== 'main' ? state.proposals.find((p) => p.id === state!.active)?.objects : state.main);
    if (!objs) return reply({ error: `no proposal ${msg.proposal}` });
    if (msg.object) objs = objs.filter((o) => o.id === msg.object || o.name.toLowerCase() === String(msg.object).toLowerCase());
    if (!objs.length) return reply({ error: 'nothing to render' });
    const s = new THREE.Scene();
    s.background = new THREE.Color(COLORS.bg);
    addLights(s);
    s.add(new THREE.GridHelper(6, 60, COLORS.grid1, COLORS.grid2));
    for (const o of objs) { const m = buildMesh(o, null, false, { color: '#292524', opacity: 0.85 }); if (m) s.add(m); }
    const legend: { n: number; object: string; part: string; failing: boolean }[] = [];
    for (const o of objs) {
      const failing = new Set(o.checks.flatMap((c) => (c.pass ? [] : c.parts ?? [])));
      for (const p of o.parts) if (!p.name.startsWith('~')) legend.push({ n: legend.length + 1, object: o.name, part: p.name, failing: failing.has(p.name) });
    }
    const images = (msg.views as string[]).map((view) => {
      const cam = view === 'iso' ? new THREE.PerspectiveCamera(35, 1, 0.01, 100) : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
      frame(objs!, view, cam);
      rr.render(s, cam);
      const c = document.createElement('canvas');
      c.width = RS; c.height = RS;
      const g = c.getContext('2d')!;
      g.drawImage(rr.domElement, 0, 0);
      if (msg.labels) {
        let k = 0;
        for (const o of objs!) for (const p of o.parts) {
          if (p.name.startsWith('~')) continue;
          const L = legend[k++];
          const ctr = new THREE.Vector3((p.bbox.min[0] + p.bbox.max[0]) / 2, (p.bbox.min[1] + p.bbox.max[1]) / 2, (p.bbox.min[2] + p.bbox.max[2]) / 2).project(cam);
          const x = (ctr.x * 0.5 + 0.5) * RS, y = (-ctr.y * 0.5 + 0.5) * RS;
          g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2);
          g.fillStyle = L.failing ? COLORS.danger : '#23466f'; g.fill();
          g.fillStyle = '#ffffff'; g.font = '600 14px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(String(L.n), x, y + 0.5);
        }
      }
      g.fillStyle = '#57534e'; g.font = '500 15px system-ui, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillText(`${view} · ${objs!.map((o) => o.name).join(', ')}${msg.proposal ? ` · proposal ${msg.proposal}` : ''}`, 14, RS - 14);
      return { view, data: c.toDataURL('image/png') };
    });
    disposeTree(s);
    reply({ images, legend });
  } catch (e: any) {
    reply({ error: e.message ?? String(e) });
  }
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
      state = m.state; render();
    }
    else if (m.type === 'render') handleRender(m);
    else if (m.type === 'call-result' && !m.result.ok) toast(m.result.error ?? 'error');
  };
}
connect();
