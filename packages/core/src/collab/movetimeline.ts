// One timeline for everything that moves (Phase 10 step 2, Decision 60 A). The live view plays a scene
// timeline: one master playhead, and a track per system (motion, voice, cutscene, effect, sound, music),
// each on its own clock (Decision 61: clip, sound, shot, beats). This file is pure and browser-safe (no
// node imports): the view and the studio share it, so a moment scrubbed in the view and an address made
// by Claude are the same thing.
//
// - A track has a start on the master timeline, a length on its own clock and whether it loops.
// - Failed motion checks are red stretches: their failing frames, mapped onto every pass of the track.
// - Effects and sound events fire on moments of motion tracks ("Blacksmith:strike@impact").
// - momentAt(): the playhead + a selection → a full moment address on the right clock, anchored to a
//   named moment when one is within half a second.
import type { EffectDef, ParticleLayer, ShapeLayer } from '../effects.ts';

export const TL_TICKS = 24000;
export const toTicks = (s: number) => Math.round(s * TL_TICKS);
export const toSeconds = (t: number) => t / TL_TICKS;

export type TlSystem = 'motion' | 'voice' | 'cutscene' | 'effect' | 'sound' | 'music';
export type MarkerKind = 'moment' | 'shot' | 'burst' | 'beat' | 'bar' | 'event' | 'word' | 'cue';
export interface TlMarker { name: string; at: number; len?: number; kind: MarkerKind }
/** One motion check on a track: failing ranges as [at, len] ticks on the track's own clock. */
export interface TlCheck { name: string; pass: boolean; worst: number; limit: number; unit: string; detail?: string; ranges: Array<[number, number]> }
export interface TlTrack {
  id: string;                    // "motion:blacksmith", "voice:blacksmith:big-hammer", "effect:sparks", "sound:clink"
  system: TlSystem;
  label: string;
  thing: string;                 // the address thing ("blacksmith", "effect:sparks", "sound:clink", "cutscene:lesson")
  clock: string;                 // its own clock: clip:<motion>, sound:<id>, shot:<cutscene>, beats:<id>, none
  start: number;                 // ticks on the master timeline
  length: number;                // ticks of one pass on its own clock
  loop: boolean;
  markers: TlMarker[];
  checks?: TlCheck[];
  version: string;               // the recipe stamp (address `of`, cache key)
  object?: string; motion?: string; motions?: string[]; line?: string; effect?: string; sound?: string; cutscene?: string;
  fps?: number;
  glb?: string;                  // asset key: the animated object (character: placed in the scene; creature: at the origin, see place)
  held?: Array<{ object: string; bone: string }>;   // props held in a hand: the view moves them with that bone
  covers?: string[];             // the scene objects the GLB stands in for while it plays (the character and what it holds)
  place?: { position: [number, number, number]; rotation: number };
  audio?: string;                // asset key: a WAV
  wave?: number[];               // peaks 0..1 over one pass, ~100 a second
  bpm?: number; beatsPerBar?: number;
  fx?: { def: EffectDef; at: [number, number, number]; colours: Record<string, string> };
  error?: string;
  gain?: number;
}
export interface SceneTimeline {
  stamp: string;
  branch: string;
  mode: 'scene' | 'cutscene';
  length: number;                // master ticks
  tracks: TlTrack[];
  cutscene?: any;                // cutscene mode: the cutscene timeline the players read (shots, cues, cameras)
  play: Record<string, string>;  // object → the motion playing on it
}

// ── time on a track ─────────────────────────────────────────────────────────────────────────────────

/** The track's own time at a master tick (null when it isn't playing then). A one-shot holds its end for a beat. */
export function localTicks(tr: Pick<TlTrack, 'start' | 'length' | 'loop'>, master: number): number | null {
  const d = master - tr.start;
  if (d < 0 || tr.length <= 0) return null;
  if (tr.loop) return d % tr.length;
  return d < tr.length ? d : null;
}

/** Every master tick at which a track is at its own tick `at` (once per pass), inside [0, masterLength). */
export function masterTimes(tr: Pick<TlTrack, 'start' | 'length' | 'loop'>, at: number, masterLength: number): number[] {
  const out: number[] = [];
  if (tr.length <= 0) return out;
  for (let base = tr.start; base < masterLength; base += tr.length) {
    if (base + at < masterLength) out.push(base + at);
    if (!tr.loop) break;
  }
  return out;
}

/** A frame range [a, b] (inclusive, at fps) as [at, len] ticks. */
export function framesToTicks([a, b]: [number, number], fps: number): [number, number] {
  const at = toTicks(a / fps), end = toTicks((b + 1) / fps);
  return [at, Math.max(1, end - at)];
}

export interface Stretch { track: string; check: string; from: number; to: number; worst: number; limit: number; unit: string }
/** The red stretches: every failing range of every check, on every pass of its track, in master ticks. */
export function checkStretches(tl: Pick<SceneTimeline, 'tracks' | 'length'>): Stretch[] {
  const out: Stretch[] = [];
  for (const tr of tl.tracks) for (const k of tr.checks ?? []) {
    if (k.pass) continue;
    for (const [at, len] of k.ranges) for (const m of masterTimes(tr, at, tl.length)) {
      out.push({ track: tr.id, check: k.name, from: m, to: Math.min(tl.length, m + Math.min(len, tr.length - at)), worst: k.worst, limit: k.limit, unit: k.unit });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Bursts on a track that fires on another track's moment: the master ticks where it fires. */
export function firesAt(trigger: { character?: string; clip?: string; fraction?: number; at?: number[] } | undefined, tl: Pick<SceneTimeline, 'tracks' | 'length'>, nameOf: (objectId: string) => string): number[] {
  if (!trigger) return [];
  if (trigger.at?.length) return trigger.at.map(toTicks).filter((t) => t < tl.length);
  if (!trigger.character || !trigger.clip || trigger.fraction === undefined) return [];
  const who = trigger.character.toLowerCase();
  const tr = tl.tracks.find((t) => t.system === 'motion' && t.motion === trigger.clip && (t.object === trigger.character || nameOf(t.object ?? '').toLowerCase() === who));
  if (!tr) return [];
  return masterTimes(tr, Math.round(trigger.fraction * tr.length), tl.length);
}

// ── pointing at a moment ────────────────────────────────────────────────────────────────────────────

export interface TlAddress { thing: string; clock: string; at?: number; len?: number; near?: string; of?: string }

/** The nearest named moment to a tick on a track (moments, shots, events, words), within `within` ticks. */
export function nearestMarker(tr: Pick<TlTrack, 'markers'>, at: number, within = TL_TICKS / 2): TlMarker | undefined {
  let best: TlMarker | undefined, bd = Infinity;
  for (const m of tr.markers) {
    if (m.kind === 'beat' || m.kind === 'bar' || m.kind === 'burst') continue;
    // a named moment beats an unnamed key at the same tick ("impact" over "key 6")
    const d = (m.len && at >= m.at && at < m.at + m.len ? 0 : Math.abs(m.at - at)) + (m.kind === 'cue' ? TL_TICKS / 4 : 0);
    if (d < bd) { bd = d; best = m; }
  }
  return bd <= within ? best : undefined;
}

/** The track a selection belongs to at a moment: the object's playing voice line, else its motion; a sound or effect by id; else the cutscene's shots. */
export function trackFor(tl: Pick<SceneTimeline, 'tracks'>, master: number, sel: { object?: string | null; track?: string | null }): TlTrack | undefined {
  if (sel.track) { const t = tl.tracks.find((x) => x.id === sel.track); if (t) return t; }
  if (sel.object) {
    const mine = tl.tracks.filter((t) => t.object === sel.object || t.thing === sel.object);
    const speaking = mine.find((t) => t.system === 'voice' && localTicks(t, master) !== null);
    return speaking ?? mine.find((t) => t.system === 'motion') ?? mine.find((t) => localTicks(t, master) !== null) ?? mine[0];
  }
  return tl.tracks.find((t) => t.system === 'cutscene');
}

/**
 * The view's current moment as a moment address (Decision 61): what is selected (an object, a bone or
 * part, a sound, an effect), on the clock of the track it plays on, at the track's own tick, anchored to
 * a named moment within half a second, stamped with the track's version.
 */
export function momentAt(tl: Pick<SceneTimeline, 'tracks'>, master: number, sel: { object?: string | null; part?: string | null; track?: string | null }): TlAddress | null {
  const tr = trackFor(tl, master, sel);
  const thingOf = (t?: TlTrack) => sel.object ? (sel.part ? `${sel.object}/${sel.part}` : sel.object) : t?.thing ?? '';
  if (!tr) return sel.object ? { thing: thingOf(), clock: 'none' } : null;
  const at = localTicks(tr, master);
  if (at === null) return { thing: thingOf(tr), clock: tr.clock, of: tr.version };
  const m = nearestMarker(tr, at);
  return { thing: thingOf(tr), clock: tr.clock, at, ...(m ? { near: m.name } : {}), of: tr.version };
}

/** A moment in words for the dock: "strike · 0.84 s · near impact", "bar 3 beat 2", "shot 2 +0.4 s". */
export function momentWords(tr: TlTrack | undefined, at: number | null): string {
  if (!tr || at === null) return '';
  const s = at / TL_TICKS;
  if (tr.clock.startsWith('beats:') && tr.bpm) {
    const beat = (s * tr.bpm) / 60, bpb = tr.beatsPerBar ?? 4;
    const bar = Math.floor(beat / bpb) + 1, inBar = Math.floor(beat % bpb) + 1;
    return inBar === 1 ? `bar ${bar}` : `bar ${bar} beat ${inBar}`;
  }
  if (tr.clock.startsWith('shot:')) {
    const shots = tr.markers.filter((m) => m.kind === 'shot');
    const i = shots.findIndex((x) => at >= x.at && at < x.at + (x.len ?? 0));
    if (i >= 0) { const into = (at - shots[i].at) / TL_TICKS; return into < 0.05 ? `shot ${i + 1}` : `shot ${i + 1} +${+into.toFixed(2)} s`; }
  }
  const m = nearestMarker(tr, at);
  return `${+s.toFixed(2)} s${m ? ` · "${m.name}"` : ''}`;
}

// ── effect knobs as sliders (each release is one labelled step) ─────────────────────────────────────

export interface Knob { effect: string; layer: string; field: string; index?: number; label: string; min: number; max: number; step: number; value: number }

const PARTICLE_KNOBS: Array<[string, number | undefined, string, number, number, number]> = [
  ['rate', undefined, 'rate /s', 0, 400, 1],
  ['speed', 1, 'speed m/s', 0, 10, 0.05],
  ['life', 1, 'life s', 0.05, 6, 0.05],
  ['size', 1, 'size m', 0.002, 0.6, 0.002],
  ['spread', undefined, 'spread °', 0, 180, 1],
  ['gravity', undefined, 'gravity', -4, 12, 0.1],
];
const SHAPE_KNOBS: Array<[string, number | undefined, string, number, number, number]> = [
  ['size', 1, 'height m', 0.05, 2, 0.01],
  ['scroll', undefined, 'scroll', 0, 4, 0.05],
  ['noise', undefined, 'noise', 0, 1, 0.01],
  ['flicker', undefined, 'flicker', 0, 1, 0.01],
];

/** The sliders for an effect: per layer, its main numbers (a burst's count stands in for rate). */
export function effectKnobs(def: EffectDef): Knob[] {
  const out: Knob[] = [];
  for (const l of def.layers) {
    const table = l.kind === 'shape' ? SHAPE_KNOBS : PARTICLE_KNOBS;
    for (const [field, index, label, min, max, step] of table) {
      const raw = (l as any)[field];
      let value = index === undefined ? raw : Array.isArray(raw) ? raw[index] : undefined;
      if (field === 'rate' && l.kind === 'particles' && !(l as ParticleLayer).rate && (l as ParticleLayer).bursts?.length) {
        out.push({ effect: def.id, layer: l.id, field: 'bursts', label: 'burst count', min: 1, max: 400, step: 1, value: (l as ParticleLayer).bursts![0].count });
        continue;
      }
      if (value === undefined) value = field === 'gravity' || field === 'spread' || field === 'flicker' ? 0 : field === 'scroll' ? 1 : field === 'noise' ? 0.5 : undefined;
      if (typeof value !== 'number') continue;
      out.push({ effect: def.id, layer: l.id, field, ...(index !== undefined ? { index } : {}), label, min: Math.min(min, value), max: Math.max(max, value), step, value });
    }
  }
  return out;
}

const fmt = (v: number) => String(+v.toFixed(3));
/** A slider moved: the set-effect call and its word note ("sparks burst: speed 3.4 → 4.2"). A range moves both ends. */
export function knobChange(def: EffectDef, k: Knob, value: number): { tool: 'set-effect'; args: { id: string; layer: string; set: Record<string, unknown> }; why: string } {
  const l = def.layers.find((x) => x.id === k.layer) as (ParticleLayer | ShapeLayer) | undefined;
  if (!l) throw new Error(`no layer ${k.layer} on ${def.id}`);
  const raw = (l as any)[k.field];
  let next: unknown;
  if (k.field === 'bursts') next = ((l as ParticleLayer).bursts ?? [{ at: 0, count: 0 }]).map((b, i) => (i === 0 ? { ...b, count: Math.round(value) } : b));
  else if (Array.isArray(raw) && k.index !== undefined) {
    // a [min, max] range: scale both ends so the spread keeps its shape (size [x, y, z]: scale the height and keep the footprint)
    const old = raw[k.index] || 1e-6;
    next = k.field === 'size' && l.kind === 'shape' ? raw.map((x: number, i: number) => (i === 1 ? +value.toFixed(4) : x)) : raw.map((x: number) => +(x * (value / old)).toFixed(4));
  } else next = +value.toFixed(4);
  return { tool: 'set-effect', args: { id: def.id, layer: l.id, set: { [k.field]: next } }, why: `${def.name.toLowerCase()} ${l.id}: ${k.label.split(' ')[0]} ${fmt(k.value)} → ${fmt(value)}` };
}

// ── waveform peaks ──────────────────────────────────────────────────────────────────────────────────

/** Peaks (0..1) of mono samples, `perSecond` buckets a second. */
export function peaks(samples: Float32Array, sr: number, perSecond = 100): number[] {
  const step = Math.max(1, Math.round(sr / perSecond)), out: number[] = [];
  let top = 0;
  for (let i = 0; i < samples.length; i += step) {
    let p = 0;
    for (let j = i; j < Math.min(samples.length, i + step); j++) { const v = Math.abs(samples[j]); if (v > p) p = v; }
    out.push(p); if (p > top) top = p;
  }
  return out.map((p) => +(top ? p / top : 0).toFixed(3));
}
