// The timeline dock (Phase 10 step 2, Decision 60 A): everything that moves, on one timeline at the
// bottom of the live view. Play, pause, scrub and loop; a track per system (motion clips with their
// failed checks as red stretches and named moments, voice lines and sounds as waveforms, a cutscene's
// shots, effects with their bursts, music bars and beats); notes pinned at moments. Scrubbing sets the
// view's current moment, so a bone or part selected now is a full moment address (Decision 61) on the
// right clock. A word note on a clip becomes a step (Decision 62) with a before and after to play;
// effect knobs are sliders whose release is one labelled step; a sound can be "shown three" with a
// listen-and-pick ask (Decision 64). main.ts only hooks this in: init, the frame loop, picking, select.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CutscenePlayer } from '../../../../packages/game/templates/web/studio/cutscene.ts';
import {
  TL_TICKS, localTicks, masterTimes, checkStretches, momentAt, momentWords, trackFor, effectKnobs, knobChange,
  type SceneTimeline, type TlTrack, type TlAddress, type Knob,
} from '../../../../packages/core/src/collab/movetimeline.ts';
import { TimelineFx } from './fx.ts';
import { TimelineAudio } from './audio.ts';
import { TIMELINE_CSS } from './style.ts';

export interface TimelineDeps {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: { enabled: boolean; target: THREE.Vector3; update(): void }; renderer: THREE.WebGLRenderer;
  vpEl: HTMLElement;
  holders(): Map<string, THREE.Object3D>;
  call(tool: string, args: object, why?: string): void;
  view(): { focus: string; before: boolean; selectedObj: string | null; selectedPart: string | null; state: any };
  select(obj: string | null, part: string | null): void;
  setBefore(on: boolean): void;
  renderNow(): void;
  toast(msg: string): void;
}

interface Anim { rest?: Map<string, THREE.Matrix4>; key: string; root: THREE.Object3D; gltf: any; mixer: THREE.AnimationMixer; actions: Map<string, THREE.AnimationAction>; player?: CutscenePlayer }

const COLOR: Record<string, string> = { motion: '#5b8c7a', voice: '#7d93ab', cutscene: '#8b6fae', effect: '#d9822b', sound: '#b58b3c', music: '#6f8f3f' };
const RED = '#c8392b';
const ROW = 22, RULER = 18;
const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cssVar = (n: string, d: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
const compact = (a: TlAddress) => [a.clock === 'none' ? a.thing : `${a.thing}@${a.clock}`, a.at !== undefined ? `${a.at}t` : '', a.near ? `~${a.near.replace(/\s/g, '_')}` : '', a.of ? `#${a.of}` : ''].filter(Boolean).join(' ');
const WORDS = ['slower', 'faster', 'more weight', 'snappier', 'bigger', 'subtler'];

export function initTimeline(d: TimelineDeps) {
  const params = new URLSearchParams(location.search);
  const capture = params.has('capture');
  const style = document.createElement('style'); style.textContent = TIMELINE_CSS; document.head.appendChild(style);

  // dock under the viewport, in the same grid cell
  const col = document.createElement('div'); col.className = 'vp-col';
  d.vpEl.parentElement!.insertBefore(col, d.vpEl); col.appendChild(d.vpEl);
  const dock = document.createElement('div'); dock.className = 'tl-dock empty'; col.appendChild(dock);
  dock.innerHTML = `<div class="tl-main"><div class="tl-bar">
      <button data-tl="play" title="Play / pause (K)">▶ Play</button><button data-tl="loop" class="on" title="Loop">Loop</button><button data-tl="start" title="Back to the start">⏮</button>
      <span class="tl-time">0.00 s</span><span class="tl-moment"></span><span class="tl-perf"></span></div>
      <div class="tl-body"><div class="tl-labels"></div><div class="tl-lanes"><canvas></canvas></div></div></div>
    <div class="tl-side"></div>`;
  const $ = <T extends HTMLElement>(s: string) => dock.querySelector(s) as T;
  const labelsEl = $('.tl-labels'), lanesEl = $('.tl-lanes'), canvas = $<HTMLCanvasElement>('canvas'), side = $('.tl-side');
  const timeEl = $('.tl-time'), momentEl = $('.tl-moment'), perfEl = $('.tl-perf'), playBtn = $('[data-tl="play"]'), loopBtn = $('[data-tl="loop"]');

  const anim = new THREE.Group(); anim.name = 'timeline-anim'; d.scene.add(anim);
  const fx = new TimelineFx(d.scene);
  const audio = new TimelineAudio(); audio.muted = capture;
  const glbs = new Map<string, Promise<any>>();
  const anims = new Map<string, Anim>();      // by track id
  let tl: SceneTimeline | null = null, branch = 'main', loading = false, wantAgain = false, loadedOnce = false;
  let t = 0, playing = false, loop = true, selTrack: string | null = params.get('track');
  const play: Record<string, string> = {};
  for (const kv of (params.get('play') ?? '').split(',').filter(Boolean)) { const [o, m] = kv.split(':'); if (o && m) play[o] = m; }
  let cutscene: string | null = params.get('cutscene');
  let seg: any = null;                          // capture: the segment being shown (focus, solo, close)
  let sideKey = '', draft = '', pinDraft = '';
  // headless Chrome without a GPU renders in software: its frame times say nothing about the Mac's
  const software = (() => { try { const g = d.renderer.getContext() as any, e = g.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|software|llvmpipe/i.test(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''); } catch { return false; } })();
  const perf = { cpu: [] as number[], gap: [] as number[], last: 0, t0: 0, particles: 0 };

  // ── loading the timeline ───────────────────────────────────────────────────────────────────────────
  const shownBranch = () => { const v = d.view(); return v.before ? 'main' : v.focus || 'main'; };
  async function refresh(force = false): Promise<void> {
    if (loading) { wantAgain = true; return; }
    loading = true;
    try {
      const b = shownBranch();
      const q = new URLSearchParams({ branch: b, play: Object.entries(play).map(([o, m]) => `${o}:${m}`).join(','), ...(cutscene ? { cutscene } : {}), ...(!force && tl && b === branch ? { have: tl.stamp } : {}) });
      const r = await fetch(`/api/timeline?${q}`);
      if (!r.ok) throw new Error(`timeline: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const next = await r.json();
      if (!next.same) { branch = b; await apply(next as SceneTimeline); }
    } catch (e: any) { console.warn(e.message ?? e); }
    finally { loading = false; loadedOnce = true; if (wantAgain) { wantAgain = false; void refresh(); } }
  }

  function loadGlb(key: string): Promise<any> {
    let p = glbs.get(key);
    if (!p) { p = new GLTFLoader().loadAsync(`/api/timeline/asset/${key}`); glbs.set(key, p); p.catch(() => glbs.delete(key)); }
    return p;
  }

  async function apply(next: SceneTimeline) {
    const want = new Map(next.tracks.filter((x) => x.system === 'motion' && x.glb && !x.error).map((x) => [x.id, x]));
    // load what's new first, so the old pose stays on screen until the new one is ready
    const fresh = [...want.values()].filter((tr) => anims.get(tr.id)?.key !== tr.glb);
    const loaded = await Promise.all(fresh.map((tr) => loadGlb(tr.glb!)));
    for (const [id, a] of anims) if (!want.has(id) || want.get(id)!.glb !== a.key) { anim.remove(a.root); anims.delete(id); }
    fresh.forEach((tr, i) => {
      const gltf = loaded[i];
      const root = new THREE.Group();
      root.name = tr.id; root.userData.object = tr.object;
      // creatures come at the origin: place them where they stand in the scene
      if (tr.place) { root.position.set(...tr.place.position); root.rotation.y = THREE.MathUtils.degToRad(tr.place.rotation); }
      const model = gltf.scene; // one track per GLB key
      model.removeFromParent();
      model.getObjectByName('ground')?.removeFromParent();
      model.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.userData.tlTrack = tr.id; } });
      root.add(model);
      const mixer = new THREE.AnimationMixer(model);
      const actions = new Map<string, THREE.AnimationAction>();
      for (const c of gltf.animations as THREE.AnimationClip[]) { const a = mixer.clipAction(c); a.setLoop(THREE.LoopRepeat, Infinity); actions.set(c.name, a); }
      anims.set(tr.id, { key: tr.glb!, root, gltf, mixer, actions });
      anim.add(root);
      // the hand bones in the rest pose: held props follow each bone's motion from there
      const poseAct = actions.get('pose');
      if (poseAct) { poseAct.play(); poseAct.paused = true; poseAct.time = 0; mixer.update(0); }
      root.updateMatrixWorld(true);
      if (poseAct) poseAct.stop();
      const rest = new Map<string, THREE.Matrix4>();
      for (const h of tr.held ?? []) { const b = model.getObjectByName(h.bone); if (b) rest.set(h.bone, b.matrixWorld.clone()); }
      anims.get(tr.id)!.rest = rest;
    });
    tl = next;
    // cutscene mode: one cutscene player per character GLB (the same player web games use)
    for (const [id, a] of anims) {
      a.player = undefined;
      if (tl.mode !== 'cutscene' || !tl.cutscene) continue;
      const obj = id.slice('motion:'.length);
      const sub = { ...tl.cutscene, characters: tl.cutscene.characters.filter((c: any) => c.id === obj), cues: tl.cutscene.cues.filter((q: any) => q.character === obj) };
      if (sub.characters.length) { for (const act of a.actions.values()) act.stop(); a.player = new CutscenePlayer(a.root.children[0], a.gltf.animations, sub, d.camera, ''); }
    }
    fx.sync(tl.tracks.filter((x) => x.system === 'effect') as any);
    for (const k of Object.keys(tl.play)) play[k] ??= tl.play[k];
    t = Math.min(t, toS(tl.length));
    dock.classList.toggle('empty', !tl.tracks.length);
    buildLabels();
    pose();
    draw();
    sideKey = '';
  }
  const toS = (ticks: number) => ticks / TL_TICKS;

  // ── posing everything at t ─────────────────────────────────────────────────────────────────────────
  const covered = new Set<string>();
  function pose() {
    if (!tl) return;
    const ticks = Math.round(t * TL_TICKS);
    covered.clear();
    for (const tr of tl.tracks) {
      if (tr.system !== 'motion') continue;
      const a = anims.get(tr.id);
      if (!a) continue;
      for (const c of tr.covers ?? [tr.object!]) covered.add(c);
      if (a.player) { a.player.setTime(t); continue; }
      let local = localTicks(tr, ticks);
      if (local === null) local = ticks < tr.start ? 0 : tr.length - 1;
      const voice = tl.tracks.find((v) => v.system === 'voice' && v.object === tr.object && localTicks(v, ticks) !== null);
      const lineClip = voice ? a.actions.get(`line:${voice.line}`) : undefined;
      for (const [name, act] of a.actions) {
        if (name === tr.motion) { act.enabled = true; act.play(); act.paused = true; act.time = Math.min(local / TL_TICKS, act.getClip().duration - 1e-4); act.setEffectiveWeight(1); }
        else if (lineClip && act === lineClip) { act.enabled = true; act.play(); act.paused = true; act.time = Math.min(localTicks(voice!, ticks)! / TL_TICKS, act.getClip().duration - 1e-4); act.setEffectiveWeight(1); }
        else act.enabled = false;
      }
      a.mixer.update(0);
    }
    perf.particles = fx.setTime(t, d.renderer.domElement.height * 0.9);
    applyVisibility();
  }
  const tmpM = new THREE.Matrix4();
  /** Held props (scene objects) ride their hand bone: bone now × bone at rest⁻¹ × where the prop rests. */
  function carryHeld() {
    if (!tl) return;
    const hs = d.holders();
    for (const tr of tl.tracks) {
      const a = anims.get(tr.id);
      if (!a?.rest || !tr.held?.length) continue;
      a.root.updateMatrixWorld(true);
      for (const h of tr.held) {
        const holder = hs.get(h.object), b = a.root.getObjectByName(h.bone), r0 = a.rest.get(h.bone);
        if (!holder || !b || !r0) continue;
        if (!holder.userData.tlBase) { holder.updateMatrix(); holder.userData.tlBase = holder.matrix.clone(); }
        tmpM.copy(r0).invert().premultiply(b.matrixWorld).multiply(holder.userData.tlBase);
        holder.matrixAutoUpdate = false;
        holder.matrix.copy(tmpM);
        holder.matrixWorldNeedsUpdate = true;
      }
    }
  }
  function applyVisibility() {
    carryHeld();
    const solo = seg?.solo ? new Set<string>([seg.focus, ...(seg.show ?? [])]) : null;
    for (const [id, h] of d.holders()) h.visible = !covered.has(id) && (!solo || solo.has(id));
    for (const [id, a] of anims) {
      const tr = tl?.tracks.find((x) => x.id === id);
      a.root.visible = !solo || (!!tr?.covers?.some((c) => solo.has(c)) || solo.has(tr?.object ?? ''));
    }
    fx.root.visible = !solo;
  }

  // ── the frame loop (main.ts calls begin/end around its render) ─────────────────────────────────────
  function begin(now: number) {
    perf.t0 = performance.now();
    if (perf.last) { perf.gap.push(now - perf.last); if (perf.gap.length > 240) perf.gap.shift(); }
    perf.last = now;
    if (!tl) return;
    if (playing) {
      t += Math.min(0.1, (perf.gap.at(-1) ?? 16) / 1000);
      const L = toS(tl.length);
      if (t >= L) { if (loop) { t %= L; void audio.play(tl.tracks as any, t, L); } else { t = L; playing = false; updateTransport(); } }
      pose(); draw(); maybeSide();
    }
    applyVisibility();
  }
  function end() {
    perf.cpu.push(performance.now() - perf.t0);
    if (perf.cpu.length > 240) perf.cpu.shift();
  }
  setInterval(() => {
    const s = stats();
    if (!s.frames || capture || software) { perfEl.textContent = software ? 'software GL' : ''; return; }
    perfEl.textContent = `frame ${s.cpuMean.toFixed(1)} ms · ${s.fps.toFixed(0)} fps${perf.particles ? ` · ${perf.particles} particles` : ''}`;
    perfEl.classList.toggle('bad', s.gapP95 > 30);
  }, 1000);
  function stats() {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const p95 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0; };
    return { frames: perf.cpu.length, cpuMean: mean(perf.cpu), cpuP95: p95(perf.cpu), gapMean: mean(perf.gap), gapP95: p95(perf.gap), fps: 1000 / Math.max(1, mean(perf.gap)), particles: perf.particles, playing };
  }

  // ── transport ──────────────────────────────────────────────────────────────────────────────────────
  function setPlaying(on: boolean) {
    playing = on && !!tl;
    if (playing && tl) { if (t >= toS(tl.length) - 1e-3) t = 0; void audio.play(tl.tracks as any, t, toS(tl.length)); } else audio.stop();
    updateTransport();
  }
  function updateTransport() { playBtn.textContent = playing ? '❚❚ Pause' : '▶ Play'; playBtn.classList.toggle('on', playing); loopBtn.classList.toggle('on', loop); }
  dock.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('[data-tl]') as HTMLElement | null;
    if (!b) return;
    const act = b.dataset.tl!;
    if (act === 'play') setPlaying(!playing);
    else if (act === 'loop') { loop = !loop; updateTransport(); }
    else if (act === 'start') { t = 0; if (playing) setPlaying(true); pose(); draw(); momentChanged(); }
    else sideAct(b);
  });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'k' || e.key === 'K') { setPlaying(!playing); e.preventDefault(); }
  });

  // scrub: click or drag in the lanes
  let scrubbing = false;
  const scrubTo = (cx: number) => {
    if (!tl) return;
    const r = canvas.getBoundingClientRect();
    t = Math.max(0, Math.min(1, (cx - r.left) / r.width)) * toS(tl.length);
    pose(); draw(); maybeSide(true);
  };
  lanesEl.addEventListener('pointerdown', (e) => {
    scrubbing = true; lanesEl.setPointerCapture(e.pointerId); if (playing) { playing = false; audio.stop(); updateTransport(); }
    const r = canvas.getBoundingClientRect(), row = Math.floor((e.clientY - r.top - RULER) / ROW);
    if (tl && row >= 0 && row < tl.tracks.length) selTrack = tl.tracks[row].id;
    scrubTo(e.clientX); buildLabels();
  });
  lanesEl.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e.clientX); });
  lanesEl.addEventListener('pointerup', () => { if (scrubbing) { scrubbing = false; momentChanged(); } });

  // ── labels and lanes ──────────────────────────────────────────────────────────────────────────────
  function buildLabels() {
    if (!tl) return;
    labelsEl.innerHTML = tl.tracks.map((tr) => `<div class="tl-label${tr.id === currentTrack()?.id ? ' sel' : ''}" data-track-row="${esc(tr.id)}" title="${esc(tr.label + (tr.error ? ` — ${tr.error}` : ''))}"><i style="background:${COLOR[tr.system]}"></i><span>${esc(tr.label)}</span>${tr.system === 'motion' && (tr.motions?.length ?? 0) > 1 && tl!.mode === 'scene' ? `<select data-motion-for="${esc(tr.object!)}">${tr.motions!.map((m) => `<option${m === tr.motion ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>` : ''}</div>`).join('');
  }
  labelsEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('[data-track-row]') as HTMLElement | null;
    if (!row || (e.target as HTMLElement).tagName === 'SELECT') return;
    const id = row.dataset.trackRow!;
    const tr = tl?.tracks.find((x) => x.id === id);
    d.select(tr?.object ?? null, null);
    selTrack = id;
    buildLabels(); maybeSide(true); draw();
  });
  labelsEl.addEventListener('change', (e) => {
    const s = e.target as HTMLSelectElement;
    if (!s.dataset.motionFor) return;
    play[s.dataset.motionFor] = s.value;
    void refresh(true);
  });

  function currentTrack(): TlTrack | undefined {
    if (!tl) return undefined;
    const v = d.view();
    return trackFor(tl, Math.round(t * TL_TICKS), { object: selTrack ? null : v.selectedObj, track: selTrack }) ?? undefined;
  }

  function draw() {
    if (!tl) return;
    const w = Math.max(200, lanesEl.clientWidth), h = RULER + ROW * tl.tracks.length, dpr = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); canvas.style.height = `${h}px`; }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const L = tl.length, X = (ticks: number) => (ticks / L) * w;
    const ink = cssVar('--color-900', '#1c1917'), faint = cssVar('--color-200', '#e7e5e4'), mid = cssVar('--color-500', '#78716c'), band = cssVar('--color-100', '#f5f5f4');
    // ruler: whole seconds
    g.font = '10px system-ui, sans-serif'; g.fillStyle = mid; g.strokeStyle = faint;
    for (let s = 0; s <= toS(L) + 1e-6; s += toS(L) > 12 ? 2 : 1) { const x = X(s * TL_TICKS); g.fillRect(x, RULER - 5, 1, 5); g.fillText(`${s}s`, Math.min(w - 16, x + 2), 10); }
    const stretches = checkStretches(tl);
    const notes: any[] = (d.view().state?.notes ?? []).filter((n: any) => n.status !== 'done' && n.address?.clock && n.address.clock !== 'none' && n.address.at !== undefined);
    tl.tracks.forEach((tr, i) => {
      const y = RULER + i * ROW, cy = y + ROW / 2;
      g.fillStyle = i % 2 ? band : 'transparent'; g.fillRect(0, y, w, ROW);
      const c = COLOR[tr.system];
      // the span it plays over (passes of a loop marked)
      const passes = tr.loop ? masterTimes(tr, 0, L) : [tr.start];
      g.globalAlpha = 0.22; g.fillStyle = c;
      if (tr.system === 'sound' && !tr.loop) { for (const m of tr.markers) if (m.kind === 'burst') g.fillRect(X(m.at), y + 4, Math.max(2, X(tr.length)), ROW - 8); }
      else for (const p of passes) g.fillRect(X(p), y + 4, Math.max(2, X(Math.min(tr.length, L - p))), ROW - 8);
      g.globalAlpha = 1;
      if (tr.loop) { g.fillStyle = c; for (const p of passes) g.fillRect(X(p), y + 3, 1, ROW - 6); }
      // waveforms
      if (tr.wave?.length) {
        g.fillStyle = c;
        const starts = tr.system === 'sound' && !tr.loop ? tr.markers.filter((m) => m.kind === 'burst').map((m) => m.at) : passes;
        const dur = tr.length;
        for (const s0 of starts) {
          const x0 = X(s0), x1 = X(Math.min(L, s0 + dur)), n = tr.wave.length;
          for (let x = x0; x < x1; x += 1.5) { const k = Math.floor(((x - x0) / Math.max(1, X(dur))) * n); const a = tr.wave[Math.min(n - 1, k)] ?? 0; const hh = Math.max(0.5, a * (ROW / 2 - 3)); g.fillRect(x, cy - hh, 1, hh * 2); }
        }
      }
      // shots: alternating blocks with their names
      for (const m of tr.markers) {
        if (m.kind === 'shot') { g.fillStyle = c; g.globalAlpha = 0.18 + 0.14 * (tr.markers.filter((x) => x.kind === 'shot').indexOf(m) % 2); g.fillRect(X(m.at), y + 3, X(m.len ?? 0), ROW - 6); g.globalAlpha = 1; g.fillStyle = ink; g.fillRect(X(m.at), y + 2, 2, ROW - 4); g.fillText(m.name, X(m.at) + 4, cy + 3); }
      }
      // red stretches: failed motion checks, on every pass
      g.fillStyle = RED;
      for (const s of stretches) if (s.track === tr.id) g.fillRect(X(s.from), y + 5, Math.max(3, X(s.to - s.from)), ROW - 10);
      // moments
      const named = tr.markers.filter((m) => m.kind === 'moment' || m.kind === 'event');
      for (const m of tr.markers) {
        if (m.kind === 'bar') { g.fillStyle = c; g.fillRect(X(m.at), y + 2, 1.5, ROW - 4); if (X(m.len ?? 0) > 30) g.fillText(m.name.replace('bar ', ''), X(m.at) + 3, y + 9); }
        else if (m.kind === 'beat') { g.fillStyle = c; g.globalAlpha = 0.45; g.fillRect(X(m.at), y + ROW - 7, 1, 4); g.globalAlpha = 1; }
        else if (m.kind === 'burst') { g.fillStyle = tr.system === 'effect' ? '#e8951f' : c; const x = X(m.at); g.beginPath(); g.moveTo(x, y + 4); g.lineTo(x + 4, cy); g.lineTo(x, y + ROW - 4); g.lineTo(x - 4, cy); g.closePath(); g.fill(); }
        else if (m.kind === 'cue' && tr.system === 'motion') { g.fillStyle = mid; for (const p of passes) g.fillRect(X(p + m.at), y + ROW - 6, 1, 3); }
        else if (m.kind === 'word') { g.fillStyle = mid; g.fillRect(X(tr.start + m.at), y + ROW - 5, 1, 3); }
      }
      g.fillStyle = ink; g.font = '600 9.5px system-ui, sans-serif';
      let lastLabel = -1e9;
      for (const p of tr.loop ? passes : [tr.start]) for (const m of named) { const x = X(p + m.at); g.fillRect(x, y + 2, 1.5, 6); const wl = g.measureText(m.name).width; if (x > lastLabel + 4) { g.fillText(m.name, x + 3, y + 9); lastLabel = x + 3 + wl; } }
      g.font = '10px system-ui, sans-serif';
      // notes pinned at a moment on this track's clock
      for (const n of notes) {
        const head = String(n.address.thing).split('/')[0];
        if (n.address.clock !== tr.clock || (head !== tr.object && head !== tr.thing)) continue;
        for (const m of masterTimes(tr, n.address.at, L)) {
          const x = X(m);
          g.fillStyle = n.status === 'stale' ? mid : '#2f6fd6';
          g.beginPath(); g.arc(x, cy, 6.5, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#fff'; g.font = '600 9px system-ui, sans-serif'; g.fillText(String(n.id).slice(1), x - (String(n.id).length > 2 ? 5 : 2.6), cy + 3); g.font = '10px system-ui, sans-serif';
        }
      }
      if (tr.error) { g.fillStyle = RED; g.fillText(`⚠ ${tr.error}`, 6, cy + 3); }
    });
    // playhead
    const px = X(t * TL_TICKS);
    g.fillStyle = ink; g.fillRect(px - 1, 0, 2, h);
    g.beginPath(); g.moveTo(px - 5, 0); g.lineTo(px + 5, 0); g.lineTo(px, 7); g.closePath(); g.fill();
    // readouts
    timeEl.textContent = `${t.toFixed(2)} / ${toS(L).toFixed(1)} s`;
    const tr = currentTrack(), a = moment();
    const stretch = stretches.find((s) => s.track === tr?.id && t * TL_TICKS >= s.from && t * TL_TICKS <= s.to);
    momentEl.innerHTML = tr ? `<b>${esc(tr.label)}</b> · ${esc(momentWords(tr, localTicks(tr, Math.round(t * TL_TICKS))))}${stretch ? ` · <span style="color:${RED}">✗ ${esc(stretch.check)} ${stretch.worst}${esc(stretch.unit)} &gt; ${stretch.limit}</span>` : ''}${a && d.view().selectedPart ? ` · ${esc(a.thing)}` : ''}` : '';
  }
  new ResizeObserver(() => draw()).observe(lanesEl);

  // ── the current moment as an address ───────────────────────────────────────────────────────────────
  function moment(): TlAddress | null {
    if (!tl) return null;
    const v = d.view();
    const st = selTrack ? tl.tracks.find((x) => x.id === selTrack) : undefined;
    if (st && !st.object) return momentAt(tl, Math.round(t * TL_TICKS), { track: st.id });
    return momentAt(tl, Math.round(t * TL_TICKS), { object: v.selectedObj, part: v.selectedPart, track: st && st.object === v.selectedObj ? st.id : null });
  }
  /** Extra fields for the view's select message: the clock, the seconds on it and the named moment. */
  function selectExtra(obj: string | null, part: string | null): Record<string, unknown> {
    if (!tl || !obj) return {};
    const a = momentAt(tl, Math.round(t * TL_TICKS), { object: obj, part });
    if (!a || a.clock === 'none' || a.at === undefined) return {};
    return { clock: a.clock, seconds: +(a.at / TL_TICKS).toFixed(4), ...(a.near ? { near: a.near } : {}) };
  }
  let momentTimer: any = null;
  function momentChanged() {
    clearTimeout(momentTimer);
    momentTimer = setTimeout(() => { const v = d.view(), own = selTrack ? tl?.tracks.find((x) => x.id === selTrack)?.object : v.selectedObj; if (v.selectedObj && own === v.selectedObj) d.select(v.selectedObj, v.selectedPart); }, 200);
  }

  // ── the side panel: word notes, sliders, three takes, pins ────────────────────────────────────────
  function maybeSide(force = false) {
    const tr = currentTrack();
    const v = d.view();
    const key = `${tr?.id}|${tr?.version}|${v.focus}|${v.before}|${JSON.stringify((v.state?.takes ?? []).map((g: any) => [g.id, g.status]))}|${(v.state?.proposals ?? []).length}`;
    if (!force && key === sideKey) { updateAddr(); return; }
    sideKey = key;
    const active = document.activeElement as HTMLInputElement | null;
    if (active && side.contains(active) && active.type === 'range') return; // don't rebuild under a dragged slider
    side.innerHTML = sideHtml(tr);
    updateAddr();
  }
  function updateAddr() {
    const a = moment(), el = side.querySelector('.tl-addr');
    if (el) el.textContent = a ? compact(a) : 'scrub to a moment';
    const pin = side.querySelector('[data-tl="pin"]');
    if (pin && tl) { const tr = currentTrack(); pin.textContent = `Pin at ${momentWords(tr, tr ? localTicks(tr, Math.round(t * TL_TICKS)) : null) || 'this moment'}`; }
  }
  function sideHtml(tr: TlTrack | undefined): string {
    if (!tl) return '';
    const v = d.view(), out: string[] = [];
    const pin = `<div class="row"><input type="text" data-tl-input="pin" placeholder="A note at this moment…" value="${esc(pinDraft)}"><button data-tl="pin" class="primary">Pin</button></div>`;
    if (!tr) return `<h4>Timeline</h4><div class="muted">Select a track or a part.</div>`;
    out.push(`<h4>${esc(tr.label)}</h4><div class="tl-addr"></div>`);
    if (tr.system === 'motion') {
      const bad = (tr.checks ?? []).filter((k) => !k.pass);
      out.push(bad.length ? bad.map((k) => `<div class="bad">✗ ${esc(k.name)}: ${k.worst}${esc(k.unit)} &gt; ${k.limit} (red on the track)</div>`).join('') : `<div class="muted">✓ ${(tr.checks ?? []).length} motion checks pass</div>`);
      out.push(`<div class="muted">A word note on this clip becomes one step:</div><div class="chips">${WORDS.map((w) => `<button data-tl="word" data-word="${esc(w)}">${esc(w)}</button>`).join('')}</div>
        <div class="row"><input type="text" data-tl-input="word" placeholder="hold the pour longer…" value="${esc(draft)}"><button data-tl="word">Step</button></div>`);
    }
    if (v.focus !== 'main') {
      const p = (v.state?.proposals ?? []).find((x: any) => x.id === v.focus);
      if (p) out.push(`<div class="ask"><div class="q">${esc(p.title)}</div><div class="row"><button data-tl="before" class="${v.before ? 'primary' : ''}">▶ Before</button><button data-tl="after" class="${!v.before ? 'primary' : ''}">▶ After</button></div><div class="muted">${esc(p.steps.map((s: any) => s.note ?? s.summary).join(' · '))}</div></div>`);
    }
    if (tr.system === 'effect' && tr.fx) {
      const knobs = effectKnobs(tr.fx.def);
      out.push(`<div class="muted">Knobs: each release is one labelled step</div>${knobs.map((k, i) => `<div class="knob" title="${esc(k.layer)}"><span>${esc(k.layer)} ${esc(k.label)}</span><input type="range" data-knob="${i}" min="${k.min}" max="${k.max}" step="${k.step}" value="${k.value}"><b>${+k.value.toFixed(3)}</b></div>`).join('')}`);
    }
    if (tr.system === 'sound' || tr.system === 'music') {
      const g = (v.state?.takes ?? []).find((x: any) => x.ask?.sound === tr.sound && x.status === 'open');
      if (g) out.push(`<div class="ask"><div class="q">Your call: ${esc(g.ask.question)}</div>${g.ask.options.map((o: any) => `<div class="take"><span>${esc(o.label)}</span><button data-tl="listen" data-proposal="${esc(o.proposal)}" data-group="${esc(g.id)}">▶ Listen</button><button data-tl="pick" data-group="${esc(g.id)}" data-take="${esc(o.label)}">Pick</button></div>`).join('')}<div class="muted">The other two are discarded, never merged.</div></div>`);
      else out.push(`<div class="row"><button data-tl="listen-track">▶ Listen</button><button data-tl="three" data-sound="${esc(tr.sound ?? '')}">Show me three</button></div>`);
    }
    if (tr.system === 'voice') out.push(`<div class="row"><button data-tl="listen-track">▶ Listen</button></div><div class="muted">Lip sync plays on the character's line clip.</div>`);
    out.push(pin);
    return out.join('');
  }
  side.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.tlInput === 'word') draft = el.value;
    if (el.dataset.tlInput === 'pin') pinDraft = el.value;
    if (el.dataset.knob !== undefined) {
      // live preview of the knob (not a step yet)
      const tr = currentTrack(); if (!tr?.fx) return;
      const k = effectKnobs(tr.fx.def)[Number(el.dataset.knob)];
      const c = knobChange(tr.fx.def, k, Number(el.value));
      const def = structuredClone(tr.fx.def); Object.assign(def.layers.find((l) => l.id === c.args.layer)!, c.args.set);
      const b = el.parentElement!.querySelector('b'); if (b) b.textContent = String(+Number(el.value).toFixed(3));
      fx.sync(tl!.tracks.filter((x) => x.system === 'effect').map((x) => (x.id === tr.id ? { ...x, version: `${x.version}~${el.value}`, fx: { ...x.fx!, def } } : x)) as any);
      pose(); d.renderNow();
    }
  });
  side.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.knob === undefined) return;
    const tr = currentTrack(); if (!tr?.fx) return;
    const k: Knob = effectKnobs(tr.fx.def)[Number(el.dataset.knob)];
    const c = knobChange(tr.fx.def, k, Number(el.value));
    d.call(c.tool, c.args, c.why);
    d.toast(`Step: ${c.why}`);
  });
  side.addEventListener('keydown', (e) => {
    const el = e.target as HTMLInputElement;
    if (e.key !== 'Enter') return;
    if (el.dataset.tlInput === 'word') sideAct(side.querySelector('[data-tl="word"]:not([data-word])')!);
    if (el.dataset.tlInput === 'pin') sideAct(side.querySelector('[data-tl="pin"]')!);
  });
  function sideAct(b: HTMLElement) {
    const act = b.dataset.tl;
    const a = moment();
    const tr = currentTrack();
    if (act === 'word') {
      const note = (b.dataset.word ?? draft).trim();
      if (!note || !tr?.object || !tr.motion) return;
      const at = a && a.clock === tr.clock ? a : { thing: tr.object, clock: tr.clock, at: localTicks(tr, Math.round(t * TL_TICKS)) ?? 0 };
      d.call('word-note', { note, at: compact(at as TlAddress) });
      draft = '';
      d.toast(`Word note "${note}" → a step on ${tr.label}`);
    } else if (act === 'pin') {
      if (!pinDraft.trim() || !a) { d.toast('Type a note, then Pin'); return; }
      d.call('notes', { action: 'add', text: pinDraft.trim(), at: { thing: a.thing, clock: a.clock, ...(a.at !== undefined ? { at: a.at } : {}), ...(a.near ? { near: a.near } : {}), ...(a.of ? { of: a.of } : {}) } });
      pinDraft = ''; sideKey = '';
    } else if (act === 'before' || act === 'after') { d.setBefore(act === 'before'); t = 0; setTimeout(() => setPlaying(true), 50); }
    else if (act === 'three') d.call('sound-three', { id: b.dataset.sound });
    else if (act === 'listen' || act === 'listen-track') {
      if (act === 'listen') d.call('pick-take', { group: b.dataset.group, opened: true });
      void (async () => {
        let key = tr?.audio;
        if (act === 'listen') {
          const r = await fetch(`/api/timeline?branch=${encodeURIComponent(b.dataset.proposal!)}`); const other = await r.json();
          key = other.tracks?.find((x: TlTrack) => x.id === tr?.id)?.audio;
        }
        if (key) await audio.listen(key);
      })();
    } else if (act === 'pick') d.call('pick-take', { group: b.dataset.group, take: b.dataset.take });
  }

  // ── picking a bone or part on the moving GLBs ─────────────────────────────────────────────────────
  function pick(ray: THREE.Raycaster): { obj: string; part: string | null } | null {
    if (!tl || !anim.visible) return null;
    const hit = ray.intersectObjects(anim.children, true).find((h) => h.object.visible && (h.object as any).isMesh);
    if (!hit) return null;
    let o: THREE.Object3D | null = hit.object, root: THREE.Object3D | null = null;
    while (o) { if (o.parent === anim) { root = o; break; } o = o.parent; }
    const objId = root?.userData.object;
    if (!objId) return null;
    const m = hit.object as THREE.SkinnedMesh;
    let bone: string | null = null;
    if ((m as any).isSkinnedMesh && hit.face) {
      const si = m.geometry.getAttribute('skinIndex'), sw = m.geometry.getAttribute('skinWeight');
      let best = -1, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(hit.face.a, k); if (w > bw) { bw = w; best = si.getComponent(hit.face.a, k); } }
      bone = m.skeleton.bones[best]?.name ?? null;
    } else {
      let p: THREE.Object3D | null = hit.object.parent;
      while (p && p !== root && !(p as any).isBone && !p.name) p = p.parent;
      bone = p && p !== root ? p.name : hit.object.name || null;
    }
    return { obj: objId, part: bone };
  }

  // ── capture (frames of the real view for previews and bench videos) ───────────────────────────────
  async function setup(s: any) {
    seg = s;
    playing = false; audio.stop();
    for (const k of Object.keys(play)) delete play[k];
    Object.assign(play, s.play ?? {});
    cutscene = s.cutscene ?? null;
    if (s.branch && s.branch !== d.view().focus) d.setBefore(s.branch === 'main' && d.view().focus !== 'main');
    await refresh(true);
    if (s.select) { d.select(s.select.object, s.select.part ?? null); }
    t = s.from ?? 0; pose();
    if (!cutscene) frameFocus(s);
    draw(); maybeSide(true); d.renderNow();
    return true;
  }
  function frameFocus(s: any) {
    const box = new THREE.Box3();
    const focusRoot = [...anims.values()].find((a) => a.root.userData.object === s.focus)?.root;
    if (s.focus && focusRoot) {
      box.setFromObject(focusRoot);
      if (s.close === 'face') {
        let head: THREE.Object3D | undefined; focusRoot.traverse((o) => { if (!head && /^Head$/.test(o.name)) head = o; });
        if (head) {
          const c = new THREE.Vector3(); head.getWorldPosition(c); c.y += 0.08;
          const st = d.view().state?.main?.find((o: any) => o.id === s.focus);
          const yaw = THREE.MathUtils.degToRad(st?.rotation ?? 0), fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
          d.camera.position.copy(c).addScaledVector(fwd, 0.95).addScaledVector(right, 0.32).add(new THREE.Vector3(0, 0.04, 0));
          d.camera.near = 0.02; d.camera.far = 60; d.camera.updateProjectionMatrix();
          d.controls.target.copy(c); d.camera.lookAt(c); return;
        }
      }
      for (const id of s.show ?? []) { const h = d.holders().get(id); if (h) box.expandByObject(h); }
    } else {
      for (const a of anims.values()) box.expandByObject(a.root);
      for (const h of d.holders().values()) box.expandByObject(h);
    }
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    const dir = new THREE.Vector3(...((s.dir as [number, number, number]) ?? [1, 0.6, 1.25])).normalize();
    const dist = (size * (s.fill ?? 0.62)) / Math.tan(THREE.MathUtils.degToRad(d.camera.fov / 2));
    d.camera.position.copy(c).addScaledVector(dir, dist);
    d.camera.near = dist / 100; d.camera.far = dist * 20; d.camera.updateProjectionMatrix();
    d.controls.target.copy(c); d.camera.lookAt(c);
  }
  function frame(at: number) {
    t = at; pose(); draw(); updateAddr();
    if (tl?.mode === 'cutscene') { /* the cutscene players set the camera */ }
    d.renderNow();
    return true;
  }

  const api = {
    ready: () => loadedOnce && !loading,
    refresh: () => refresh(true),
    setup, frame, stats,
    seek(at: number) { t = at; pose(); draw(); maybeSide(true); momentChanged(); },
    play: (on = true) => setPlaying(on),
    select(track: string | null) { selTrack = track; const o = tl?.tracks.find((x) => x.id === track)?.object; d.select(o ?? null, null); selTrack = track; buildLabels(); maybeSide(true); draw(); },
    frameOn(object: string, opts: any = {}) { frameFocus({ focus: object, ...opts }); d.renderNow(); },
    moment, timeline: () => tl, time: () => t,
    stretches: () => (tl ? checkStretches(tl) : []),
    resetStats() { perf.cpu = []; perf.gap = []; },
  };
  (window as any).__timeline = api;

  return {
    /** the view got a new state (a change on the shown branch, focus or before/after) */
    onState() { void refresh(); maybeSide(); draw(); },
    begin, end, pick, selectExtra, onSelect() { const o = selTrack ? tl?.tracks.find((x) => x.id === selTrack)?.object : undefined; if (selTrack && ((o && o !== d.view().selectedObj) || (!o && d.view().selectedPart))) selTrack = null; buildLabels(); maybeSide(); draw(); },
    get cutsceneCamera() { return tl?.mode === 'cutscene'; },
    api,
  };
}
