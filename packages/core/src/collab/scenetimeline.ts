// The scene timeline (Phase 10 step 2): everything that moves in a scene, as tracks on one timeline the
// live view plays — character clips and rig-part creatures with their motion checks (red where they
// fail) and named moments, voice lines with their waveforms (lip sync rides on the line's clip), a
// cutscene's shots on the shot clock, effects with their bursts on the moments that fire them, and the
// scene's sounds as waveform tracks (music on the beats clock). Built from recipes; the GLBs and audio it
// points at are caches keyed by the recipe stamp (Decision 62), made on demand by the daemon.
import type { SceneDoc, SceneObject } from '../types.ts';
import { bakeMotion } from '../motion.ts';
import { characterMotionChecks } from '../parttools.ts';
import { buildCreature, bakeCreature, creatureChecks, type MotionCheck } from '../rigparts.ts';
import { creatureGLB } from '../creatures.ts';
import { toGLB } from '../export.ts';
import { selectForExport } from '../selection.ts';
import { cutsceneTimeline } from '../cutscene.ts';
import { effectAt } from '../gamedata.ts';
import { DEFAULT_FIRE_PALETTE, resolveColour, type EffectDef } from '../effects.ts';
import { lineWords } from '../performance.ts';
import type { SoundDef } from '../sounds.ts';
import { stamp } from './address.ts';
import { clipTimeline } from './timelines.ts';
import { lifeCast } from '../life/view.ts';
import { reelsOf, reelShots, cameraAt } from '../reels.ts';
import { TL_TICKS, toTicks, framesToTicks, firesAt, peaks, type SceneTimeline, type TlTrack, type TlCheck, type TlMarker } from './movetimeline.ts';

export interface RenderedSound { sr: number; mono: Float32Array; wav: Uint8Array; bpm?: number; bars?: number; seconds: number }
export interface BuildOpts {
  branch?: string;
  /** object → motion to play (default: its first action, else idle, else its first motion) */
  play?: Record<string, string>;
  /** cutscene mode: play this cutscene on the shot clock */
  cutscene?: string;
  /** render a scene sound from its recipe (the daemon passes the sound module's; cached by recipe) */
  renderSound?: (s: SoundDef) => RenderedSound | null;
}
export interface BuiltTimeline { timeline: SceneTimeline; assets: Record<string, { type: string; make: () => Uint8Array }> }

const MIN_SCENE = 6; // s: a scene timeline is at least this long (loops repeat inside it)

/** Which motion plays on an object in the scene by default: its first one-off action, else idle, else the first. */
export function defaultMotion(o: SceneObject): string | undefined {
  const ms: Record<string, any> = (o.character?.motions ?? o.creature?.motions ?? {}) as any;
  const ids = Object.keys(ms);
  return ids.find((k) => ms[k].kind === 'action') ?? ids.find((k) => ms[k].kind === 'idle') ?? ids[0];
}

const rows = (ks: MotionCheck[], fps: number): TlCheck[] => ks.map((k) => ({ name: k.name, pass: k.pass, worst: k.worst, limit: k.limit, unit: k.unit, detail: k.detail, ranges: k.frames.map((f) => framesToTicks(f, fps)) }));

/** A tiny PCM WAV reader (16-bit or float32), mono-mixed: for line waveforms. */
export function wavMono(bytes: Uint8Array): { sr: number; mono: Float32Array } | null {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 12, fmt = 1, ch = 1, sr = 44100, bits = 16;
    while (p + 8 <= dv.byteLength) {
      const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3)), n = dv.getUint32(p + 4, true);
      if (id === 'fmt ') { fmt = dv.getUint16(p + 8, true); ch = dv.getUint16(p + 10, true); sr = dv.getUint32(p + 12, true); bits = dv.getUint16(p + 22, true); }
      if (id === 'data') {
        const bps = bits / 8, frames = Math.floor(Math.min(n, dv.byteLength - p - 8) / (bps * ch)), mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          let s = 0;
          for (let c = 0; c < ch; c++) { const o = p + 8 + (i * ch + c) * bps; s += fmt === 3 ? dv.getFloat32(o, true) : bits === 16 ? dv.getInt16(o, true) / 32768 : 0; }
          mono[i] = s / ch;
        }
        return { sr, mono };
      }
      p += 8 + n + (n & 1);
    }
  } catch { /* not a wav */ }
  return null;
}

export function buildSceneTimeline(studio: any, doc: SceneDoc, opts: BuildOpts = {}): BuiltTimeline {
  const tracks: TlTrack[] = [];
  const assets: BuiltTimeline['assets'] = {};
  const play: Record<string, string> = {};
  const nameOf = (id: string) => doc.objects[id]?.name ?? id;
  const cs = opts.cutscene ? (doc as any).cutscenes?.[opts.cutscene] : null;
  if (opts.cutscene && !cs) throw new Error(`no cutscene "${opts.cutscene}" (cutscenes: ${Object.keys((doc as any).cutscenes ?? {}).join(', ') || 'none'})`);
  const cut = cs ? cutsceneTimeline(studio, doc, cs) : null;

  // ── motion: kit characters and rig-part creatures (life's cast plays in the town on the day clock instead) ──
  const cast = new Set(lifeCast(doc));
  for (const id of doc.objectOrder) {
    const o = doc.objects[id];
    if (!o || (!o.character?.motions && !o.creature) || cast.has(id)) continue;
    const motions: Record<string, any> = (o.character?.motions ?? o.creature?.motions ?? {}) as any;
    if (!Object.keys(motions).length) continue;
    const want = opts.play?.[id];
    const mid = want && motions[want] ? want : defaultMotion(o)!;
    play[id] = mid;
    const tr: TlTrack = { id: `motion:${id}`, system: 'motion', label: `${o.name} · ${mid}`, thing: id, clock: `clip:${mid}`, start: 0, length: 0, loop: true, markers: [], version: '', object: id, motion: mid, motions: Object.keys(motions) };
    try {
      if (o.creature) {
        const c = buildCreature(o.creature.def);
        const clips = Object.keys(motions).map((k) => bakeCreature(c, k, motions[k]));
        const clip = clips.find((k) => k.id === mid)!;
        tr.fps = clip.fps; tr.length = toTicks(clip.duration);
        tr.checks = rows(creatureChecks(c, clip), clip.fps);
        for (const k of clip.keys ?? []) if (!/\(held\)/.test(k.label)) tr.markers.push({ name: k.label, at: toTicks(k.t), kind: 'moment' });
        tr.version = stamp({ def: o.creature.def, m: motions[mid] });
        tr.place = { position: o.position, rotation: o.rotation ?? 0 };
        tr.covers = [id];
        const key = `creature-${stamp(o.creature)}`;
        tr.glb = key;
        assets[key] ??= { type: 'model/gltf-binary', make: () => creatureGLB(c, clips, {}) };
      } else {
        const r = studio.evaluate(o);
        if (!r.ok || !r.rig) throw new Error(`${o.name} does not build`);
        const clip = bakeMotion(mid, motions[mid], r.rig.rig, o.character);
        tr.fps = clip.fps; tr.length = toTicks(clip.duration);
        tr.checks = rows(characterMotionChecks(r.rig.rig, clip), clip.fps);
        const t = clipTimeline(doc, id, mid);
        for (const [name, m] of Object.entries(t?.markers ?? {})) tr.markers.push({ name, at: m.at, kind: /^key \d+$/.test(name) ? 'cue' : 'moment' });
        tr.version = t?.version ?? stamp(motions[mid]);
        // exported at the origin (held props ride the hand bones correctly there), placed in the scene by the view
        // held props stay scene objects: the view carries them on the hand bone as it moves
        const items = selectForExport(studio, doc, { object: id, atOrigin: true }).filter((i) => i.obj.id === id);
        tr.held = doc.objectOrder.filter((k) => (doc.objects[k]?.place as any)?.kind === 'held' && (doc.objects[k].place as any).target === id).map((k) => ({ object: k, bone: (doc.objects[k].place as any).hand === 'left' ? 'LeftHand' : 'RightHand' }));
        tr.place = { position: [o.position[0], 0, o.position[2]], rotation: o.rotation ?? 0 };
        const key = `character-${stamp(items.map((i) => i.obj))}`;
        tr.glb = key;
        tr.covers = items.map((i) => i.obj.id);
        assets[key] ??= { type: 'model/gltf-binary', make: () => toGLB(items, {}) };
      }
    } catch (e: any) { tr.error = e.message; }
    tr.markers.sort((a, b) => a.at - b.at);
    tracks.push(tr);

    // voice lines: a waveform track each (lip sync is the line's clip on the same GLB)
    if (!cut) {
      let at = 0.4;
      for (const [lid, l] of Object.entries(o.character?.lines ?? {})) {
        const vt: TlTrack = { id: `voice:${id}:${lid}`, system: 'voice', label: `${o.name}: “${l.text.length > 38 ? l.text.slice(0, 37) + '…' : l.text}”`, thing: id, clock: `sound:line-${lid}`, start: toTicks(at), length: toTicks(l.duration), loop: false, markers: [], version: stamp(l), object: id, line: lid };
        for (const w of lineWords(l)) vt.markers.push({ name: w.word, at: toTicks(w.start), len: Math.max(1, toTicks(w.end - w.start)), kind: 'word' });
        try {
          const bytes = studio.assets.get(l.audio) as Uint8Array;
          const wv = wavMono(bytes);
          if (wv) vt.wave = peaks(wv.mono, wv.sr);
          vt.audio = `line-${stamp(l.audio)}`;
          assets[vt.audio] ??= { type: 'audio/wav', make: () => studio.assets.get(l.audio) };
        } catch { vt.error = 'no audio for this line'; }
        tracks.push(vt);
        at += l.duration + 0.5;
      }
    }
  }

  // ── cutscene: shots on the shot clock; its lines as voice tracks at their cues ─────────────────────
  if (cut && cs) {
    const markers: TlMarker[] = [];
    cut.shots.forEach((s) => markers.push({ name: `shot ${s.id}`, at: toTicks(s.start), len: toTicks(s.end - s.start), kind: 'shot' }));
    for (const e of cut.events) markers.push({ name: e.name, at: toTicks(e.t), kind: 'event' });
    for (const q of cut.cues) if (q.kind === 'motion') markers.push({ name: `${q.name}: ${q.clip}`, at: toTicks(q.t), kind: 'cue' });
    tracks.unshift({ id: `cutscene:${cs.id}`, system: 'cutscene', label: `${cs.title ?? cs.id} · ${cut.shots.length} shots`, thing: `cutscene:${cs.id}`, clock: `shot:${cs.id}`, start: 0, length: toTicks(cut.duration), loop: false, markers: markers.sort((a, b) => a.at - b.at), version: stamp(cs), cutscene: cs.id });
    cut.cues.forEach((q, i) => {
      if (q.kind !== 'line') return;
      const o = Object.values(doc.objects).find((x) => x.id === q.character || x.name === q.name);
      const lid = q.clip.replace(/^line:/, '');
      const l: any = o?.character?.lines?.[lid];
      const vt: TlTrack = { id: `voice:${q.character}:${lid}:${i}`, system: 'voice', label: `${q.name}: “${(q.text ?? '').slice(0, 38)}”`, thing: q.character, clock: `sound:line-${lid}`, start: toTicks(q.t), length: toTicks(q.end - q.t), loop: false, markers: [], version: l ? stamp(l) : 'gone', object: q.character, line: lid, cutscene: cs.id };
      if (l) for (const w of lineWords(l)) vt.markers.push({ name: w.word, at: toTicks(w.start), len: Math.max(1, toTicks(w.end - w.start)), kind: 'word' });
      if (q.audio) {
        try { const wv = wavMono(studio.assets.get(q.audio)); if (wv) vt.wave = peaks(wv.mono, wv.sr); vt.audio = `line-${stamp(q.audio)}`; assets[vt.audio] ??= { type: 'audio/wav', make: () => studio.assets.get(q.audio!) }; } catch { /* a test line without audio */ }
      }
      tracks.push(vt);
    });
    // the characters play their cues, not a scene loop: drop the loop tracks' checks to the clips cued
    for (const t of tracks) if (t.system === 'motion') t.loop = false;
  }

  // ── trailers: shots as segments on a "shots" track with beat marks (the shot clock), cameras for the view ──
  if (!cut) for (const [rid, sr] of Object.entries(reelsOf(doc))) {
    let rs: ReturnType<typeof reelShots>;
    try { rs = reelShots(sr); } catch (e: any) { tracks.push({ id: `shots:${rid}`, system: 'shots', label: `${sr.reel.title} · shots`, thing: `reel:${rid}`, clock: `shot:${rid}`, start: 0, length: toTicks(1), loop: false, markers: [], version: stamp(sr.reel), error: e.message }); continue; }
    const markers: TlMarker[] = [];
    for (const sh of rs.shots) markers.push({ name: `${sh.index} ${sh.take}${sh.kept ? ' ✓' : ''}`, at: toTicks(sh.start), len: toTicks(sh.end - sh.start), kind: 'shot' });
    if (rs.endCard) markers.push({ name: 'end card', at: toTicks(rs.endCard.start), len: toTicks(rs.endCard.end - rs.endCard.start), kind: 'shot' });
    rs.beats.forEach((b, k) => markers.push(k % 4 === 0 ? { name: `bar ${k / 4 + 1}`, at: toTicks(b), len: toTicks(240 / rs.bpm), kind: 'bar' } : { name: `beat ${(k % 4) + 1}`, at: toTicks(b), kind: 'beat' }));
    const takes = Object.fromEntries(sr.reel.takes.filter((t) => rs.shots.some((s) => s.take === t.id)).map((t) => [t.id, t]));
    tracks.unshift({
      id: `shots:${rid}`, system: 'shots', label: `${sr.reel.title} · ${rs.shots.length} shots`, thing: `reel:${rid}`, clock: `shot:${rid}`, start: 0, length: toTicks(rs.duration), loop: false,
      markers: markers.sort((a, b) => a.at - b.at), version: stamp(sr.reel), bpm: rs.bpm, beatsPerBar: 4,
      reel: { id: rid, title: sr.reel.title, shots: rs.shots, endCard: rs.endCard, takes, mid: Object.fromEntries(rs.shots.map((s) => { const t = takes[s.take]; return [s.index, cameraAt(t, Math.min(1, (s.in + (s.end - s.start) / 2) / t.seconds))]; })), warnings: rs.warnings },
    });
  }

  // master length: a cutscene's own; a scene: the longest one-shot, at least MIN_SCENE s (loops repeat)
  const oneShots = tracks.filter((t) => !t.loop).map((t) => t.start + t.length);
  const length = cut ? toTicks(cut.duration) : Math.max(toTicks(MIN_SCENE), ...oneShots);
  const partial = { tracks, length };

  // ── effects: loops span the scene; triggered ones burst on the moments that fire them ──────────────
  for (const fx of Object.values(doc.effects ?? {}) as EffectDef[]) {
    const pal = { ...DEFAULT_FIRE_PALETTE, ...((doc as any).look?.palette ?? {}), ...(fx.palette ?? {}) };
    const colours: Record<string, string> = {};
    for (const l of fx.layers) for (const c of l.colour) { try { colours[c] = resolveColour(c, pal); } catch { colours[c] = '#ffffff'; } }
    let at: [number, number, number] = [0, 0, 0];
    try { at = effectAt(studio, doc, fx) as any; } catch { /* placed at the origin */ }
    const tr: TlTrack = { id: `effect:${fx.id}`, system: 'effect', label: `${fx.name}${fx.loop ? ' · loop' : ''}`, thing: `effect:${fx.id}`, clock: 'none', start: 0, length, loop: !!fx.loop, markers: [], version: stamp(fx), effect: fx.id, fx: { def: fx, at, colours } };
    for (const t of fx.triggers ?? []) {
      const times = firesAt(t, partial, nameOf);
      for (const m of times) tr.markers.push({ name: `${t.layer} · ${t.on.split('@')[1] ?? t.on}`, at: m, kind: 'burst' });
      if (!times.length && !t.character) tr.markers.push({ name: `waits for "${t.on}"`, at: 0, kind: 'event' });
    }
    if (!fx.loop && !fx.triggers?.length) tr.markers.push({ name: 'burst', at: 0, kind: 'burst' });
    tr.markers.sort((a, b) => a.at - b.at);
    tracks.push(tr);
  }

  // ── sounds: events fire on moments; beds loop; music on the beats clock ─────────────────────────────
  for (const s of Object.values((doc as any).sounds ?? {}) as SoundDef[]) {
    const isMusic = s.kind === 'music';
    const tr: TlTrack = { id: `sound:${s.id}`, system: isMusic ? 'music' : 'sound', label: `${s.name} · ${s.kind === 'event' ? s.sfx?.kind : s.kind === 'bed' ? `${s.bed?.kind} bed` : `music ${s.music?.mood ?? ''}`}`.trim(), thing: `sound:${s.id}`, clock: isMusic ? `beats:${s.id}` : `sound:${s.id}`, start: 0, length: 0, loop: s.kind !== 'event', markers: [], version: stamp(s), sound: s.id, gain: s.gain ?? 0 };
    try {
      const r = opts.renderSound?.(s) ?? null;
      if (!r) throw new Error('no sound renderer');
      tr.length = toTicks(r.seconds);
      tr.wave = peaks(r.mono, r.sr);
      tr.audio = `sound-${tr.version}`;
      assets[tr.audio] ??= { type: 'audio/wav', make: () => r.wav };
      if (isMusic && r.bpm) {
        tr.bpm = r.bpm; tr.beatsPerBar = 4;
        const beat = 60 / r.bpm;
        for (let b = 0; b * beat < r.seconds - 1e-6; b++) tr.markers.push(b % 4 === 0 ? { name: `bar ${b / 4 + 1}`, at: toTicks(b * beat), len: toTicks(beat * 4), kind: 'bar' } : { name: `beat ${(b % 4) + 1}`, at: toTicks(b * beat), kind: 'beat' });
      }
    } catch (e: any) { tr.error = e.message; tr.length = toTicks(s.kind === 'bed' ? s.bed?.seconds ?? 8 : 1.6); }
    if (s.kind === 'event') {
      // an event is one pass per firing: the track's start is its first firing; markers show every one
      const fires = s.on ? firesAt(s.on, partial, nameOf) : firesAt({ at: s.at ?? [0] }, partial, nameOf);
      for (const m of fires) tr.markers.push({ name: s.on ? (s.on.on.split('@')[1] ?? 'fires') : 'plays', at: m, kind: 'burst' });
      tr.start = fires[0] ?? 0;
    }
    tracks.push(tr);
  }

  const timeline: SceneTimeline = {
    stamp: '', branch: opts.branch ?? 'main', mode: cut ? 'cutscene' : 'scene', length, tracks, play,
    ...(cut ? { cutscene: cut } : {}),
  };
  timeline.stamp = stamp({ v: tracks.map((t) => [t.id, t.version, t.length, t.start]), play, mode: timeline.mode });
  return { timeline, assets };
}

/** The recipe parts a scene timeline depends on (cheap): if this stamp is unchanged, the timeline is too. */
export function timelineInputs(doc: SceneDoc, opts: BuildOpts = {}): string {
  const moving = doc.objectOrder.map((id) => doc.objects[id]).filter((o) => o && (o.character || o.creature || o.place?.kind === 'held'));
  return stamp({ moving, life: lifeCast(doc), reels: (doc as any).reels ?? null, effects: (doc as any).effects ?? null, sounds: (doc as any).sounds ?? null, cutscenes: opts.cutscene ? (doc as any).cutscenes?.[opts.cutscene] : null, play: opts.play ?? null, cutscene: opts.cutscene ?? null, look: (doc as any).look?.palette ?? null, ticks: TL_TICKS });
}
