// Clocks read from the scene doc (Decision 61): what a clock looks like now, so addresses on it can
// be re-resolved. clip:<motion> (character and creature actions: their labelled keys are the named
// moments), shot:<cutscene> (shots and events), none (a model part: exists or not). beats, sound and
// game clocks come from their own systems; they register a provider here when they join the view.
import type { SceneDoc } from '../types.ts';
import { ACTIONS, actionTempo } from '../motion.ts';
import { applyNotes } from '../actions.ts';
import { cutsceneTimeline } from '../cutscene.ts';
import { ACTION_EVENTS } from '../effects.ts';
import { TICKS, secondsToTicks, stamp, type Clock, type MomentAddress, type Timeline } from './address.ts';

export type TimelineProvider = (doc: SceneDoc, thing: string, clock: Clock, ctx?: { studio?: any }) => Timeline | null | undefined;
const providers: TimelineProvider[] = [];
/** Another system's clocks (beats, sound, game): return undefined when the clock isn't yours. */
export function addTimelineProvider(p: TimelineProvider) { providers.push(p); }

export function timelineFor(doc: SceneDoc, thing: string, clock: Clock, ctx: { studio?: any } = {}): Timeline | null {
  for (const p of providers) { const t = p(doc, thing, clock, ctx); if (t !== undefined) return t; }
  const [head, part] = thing.split('/');
  if (clock === 'none') return thingTimeline(doc, head, part, ctx.studio);
  const [kind, name] = [clock.slice(0, clock.indexOf(':')), clock.slice(clock.indexOf(':') + 1)];
  if (kind === 'clip') return clipTimeline(doc, head, name);
  if (kind === 'shot') return shotTimeline(doc, name, ctx.studio);
  if (kind === 'sound' || kind === 'beats') return soundTimeline(doc, head, kind, name);
  return null;
}

/** A timeless thing: an object (or one of its parts) exists or not; its version is its recipe. */
function thingTimeline(doc: SceneDoc, id: string, part: string | undefined, studio?: any): Timeline {
  const [kind, key] = id === 'ui' ? ['ui', 'ui'] : id.includes(':') ? [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)] : ['object', id];
  const rec = assetRecord(doc, kind, key);
  let exists = rec !== undefined;
  if (exists && part && kind === 'object' && studio) {
    const r = studio.evaluate(doc.objects[key]);
    exists = !!r.parts?.some((p: any) => p.name === part);
  }
  // a UI kit element ("ui/heat") and a town's building by its stable id ("town:Pocket Raleigh/ov:2a17…")
  if (exists && part && kind === 'ui') exists = !!(rec as any).layout?.some((e: any) => e.id === part);
  if (exists && part && kind === 'town' && partExists.town) exists = partExists.town(doc, key, part);
  if (exists && part && kind !== 'object') return { clock: 'none', thing: `${id}/${part}`, length: 0, version: stamp(kind === 'ui' ? (rec as any).layout.find((e: any) => e.id === part) : { town: rec, part }), markers: {}, exists };
  return { clock: 'none', thing: id + (part ? `/${part}` : ''), length: 0, version: exists ? stamp(rec) : 'gone', markers: {}, exists };
}

/** Part checks other modules provide (the world module: does this town still have that building?). */
export const partExists: { town?: (doc: SceneDoc, town: string, building: string) => boolean } = {};
/** Part names in words other modules provide (a building's "Office 2a17ab" instead of its id). */
export const partWords: { town?: (doc: SceneDoc, town: string, building: string) => string | null } = {};

export function assetRecord(doc: SceneDoc, kind: string, key: string): unknown {
  const d: any = doc;
  switch (kind) {
    case 'object': return d.objects?.[key];
    case 'cutscene': return d.cutscenes?.[key];
    case 'effect': return d.effects?.[key];
    case 'sound': return d.sounds?.[key];
    case 'look': return d.look?.looks?.[key];
    case 'ui': return d.ui;
    case 'town': return d.world?.towns?.[key];
    default: return undefined;
  }
}

/** A character or creature action's clock: its labelled keys, timed after its word notes ("slower"). */
export function clipTimeline(doc: SceneDoc, objectId: string, motion: string): Timeline | null {
  const o: any = doc.objects[objectId];
  const gone = { clock: `clip:${motion}` as Clock, thing: objectId, length: 0, version: 'gone', markers: {}, exists: false };
  if (!o) return gone;
  const cm = o.creature?.motions?.[motion];
  if (cm) {
    if (cm.kind !== 'action' || !cm.action) return { clock: `clip:${motion}`, thing: objectId, length: secondsToTicks(cm.duration ?? 2), version: stamp(cm), markers: {} };
    const r = applyNotes(cm.action);
    const markers: Timeline['markers'] = {};
    for (const k of r.keys) if (k.label && !(k.label in markers)) markers[k.label] = { at: secondsToTicks(k.t * r.style.tempo) };
    const end = Math.max(0, ...r.keys.map((k) => k.t * r.style.tempo)) + 0.6 * r.style.tempo; // the settle after the last key
    return { clock: `clip:${motion}`, thing: objectId, length: secondsToTicks(end), version: stamp(cm), markers };
  }
  const spec = o.character?.motions?.[motion];
  if (!spec) return gone;
  if (spec.kind !== 'action') return { clock: `clip:${motion}`, thing: objectId, length: secondsToTicks(spec.duration ?? 1), version: stamp(spec), markers: {} };
  const def = spec.keys ? { duration: spec.duration ?? 3, keys: spec.keys } : ACTIONS[spec.action];
  const dur = (spec.duration ?? def?.duration ?? 2) * actionTempo(spec.notes ?? []);
  const markers: Timeline['markers'] = {};
  (def?.keys ?? []).forEach((k: any, i: number) => { const name = k.label ?? `key ${i + 1}`; if (!(name in markers)) markers[name] = { at: secondsToTicks(k.at * dur) }; });
  // a library action's named moments (the strike's "impact"): effects and sounds fire on them
  for (const [name, frac] of Object.entries(ACTION_EVENTS[spec.action] ?? {})) if (!(name in markers) && frac < 1) markers[name] = { at: secondsToTicks(frac * dur) };
  return { clock: `clip:${motion}`, thing: objectId, length: secondsToTicks(dur), version: stamp(spec), markers };
}

/** A cutscene's clock: shots (named moments "shot <id>") and its events. */
function shotTimeline(doc: SceneDoc, id: string, studio?: any): Timeline | null {
  const cs: any = (doc as any).cutscenes?.[id];
  if (!cs) return { clock: `shot:${id}`, thing: `cutscene:${id}`, length: 0, version: 'gone', markers: {}, exists: false };
  let shots: Array<{ id: string; start: number; end: number }> = [], events: Array<{ t: number; name: string }> = [], duration = 0;
  try {
    if (!studio) throw new Error('no studio');
    const tl = cutsceneTimeline(studio, doc, cs);
    shots = tl.shots; events = tl.events; duration = tl.duration;
  } catch {
    // without the studio: each shot's own length (or 3 s)
    let t = 0;
    for (const s of cs.shots ?? []) { const d = s.duration ?? 3; shots.push({ id: s.id, start: t, end: t + d }); for (const e of s.events ?? []) events.push({ t: t + e.at, name: e.name }); t += d; }
    duration = t;
  }
  const markers: Timeline['markers'] = {};
  for (const s of shots) markers[`shot ${s.id}`] = { at: secondsToTicks(s.start), len: secondsToTicks(s.end - s.start) };
  for (const e of events) if (!(e.name in markers)) markers[e.name] = { at: secondsToTicks(e.t) };
  return { clock: `shot:${id}`, thing: `cutscene:${id}`, length: secondsToTicks(duration), version: stamp(cs), markers, shots: shots.map((s) => ({ id: s.id, at: secondsToTicks(s.start), len: secondsToTicks(s.end - s.start) })) };
}

/**
 * A scene sound's clock (Phase 10 step 2): sound:<id> (an event or bed: its length, no moments) and
 * beats:<id> (music: bars and beats are its moments, "bar 3"). Lengths come from the recipe; the
 * rendered audio is a cache. Voice lines (sound:line-<id> on a character) are timed by their line.
 */
function soundTimeline(doc: SceneDoc, thing: string, kind: string, name: string): Timeline | null {
  const d: any = doc;
  if (name.startsWith('line-')) {
    const o = doc.objects[thing];
    const l = o?.character?.lines?.[name.slice(5)];
    if (!l) return { clock: `sound:${name}` as Clock, thing, length: 0, version: 'gone', markers: {}, exists: false };
    return { clock: `sound:${name}` as Clock, thing, length: secondsToTicks(l.duration), version: stamp(l), markers: {} };
  }
  const s = d.sounds?.[name];
  if (!s) return { clock: `${kind}:${name}` as Clock, thing, length: 0, version: 'gone', markers: {}, exists: false };
  if (kind === 'beats' || s.kind === 'music') {
    const bpm = s.music?.bpm ?? 96, bars = s.music?.bars ?? 8, bar = (60 / bpm) * 4;
    const markers: Timeline['markers'] = {};
    for (let b = 0; b < bars; b++) markers[`bar ${b + 1}`] = { at: secondsToTicks(b * bar), len: secondsToTicks(bar) };
    return { clock: `beats:${name}` as Clock, thing, length: secondsToTicks(bars * bar), version: stamp(s), markers, bpm, beatsPerBar: 4 };
  }
  const len = s.kind === 'bed' ? s.bed?.seconds ?? 8 : 1.6;
  return { clock: `sound:${name}` as Clock, thing, length: secondsToTicks(len), version: stamp(s), markers: {} };
}

/** A fresh address for something selected: model parts are timeless; a moment on a clip snaps to the nearest named key. */
export function addressFor(doc: SceneDoc, sel: { object: string; part?: string | null; clock?: Clock; seconds?: number; near?: string }, ctx: { studio?: any } = {}): MomentAddress {
  const thing = sel.part ? `${sel.object}/${sel.part}` : sel.object;
  const clock: Clock = sel.clock ?? 'none';
  const t = timelineFor(doc, thing, clock, ctx);
  if (clock === 'none') return { thing, clock, of: t?.version };
  const a: MomentAddress = { thing, clock, of: t?.version };
  if (sel.near && t?.markers[sel.near]) { a.near = sel.near; a.at = t.markers[sel.near].at; }
  else if (sel.seconds !== undefined) {
    a.at = secondsToTicks(sel.seconds);
    if (t) { let best: string | undefined, bd = TICKS / 2; for (const [k, m] of Object.entries(t.markers)) { const d = Math.abs(m.at - a.at); if (d <= bd) { bd = d; best = k; } } if (best) a.near = best; }
  }
  return a;
}
