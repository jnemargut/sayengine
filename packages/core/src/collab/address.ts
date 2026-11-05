// Moment addresses (Decision 61): pointing at a thing, and at a moment on its own clock.
//
//   { thing, clock, at?, len?, near?, of? }
//
// - thing: what is pointed at. "stool", "stool/leg#2" (an object's part), "cutscene:intro",
//   "effect:spark", "look:dusk", "ui", "town:raleigh". A bare id is a model object.
// - clock: whose time `at` is measured on. "clip:<motion>", "game" (tick + seed + build),
//   "beats:<track>", "sound:<file>", "shot:<reel>", or "none" for timeless model parts.
// - at / len: whole ticks at 24,000 a second (Unreal's tick rate: no decimal drift, and 24, 25,
//   30, 48, 50 and 60 fps all land on whole ticks). len is exclusive: [at, at + len).
// - near: a named moment the address is anchored to (an action key's label, a cutscene beat, a
//   strike event). After re-timing, the address follows that moment.
// - of: the version stamp of the asset when the address was made.
//
// Re-resolving never moves an address silently: it follows its named moment, or it is marked stale.
import { createHash } from 'node:crypto';

export const TICKS = 24000;

export type Clock = 'none' | 'game' | `clip:${string}` | `beats:${string}` | `sound:${string}` | `shot:${string}`;

export interface MomentAddress {
  thing: string;
  clock: Clock;
  at?: number;
  len?: number;
  near?: string;
  of?: string;
  /** clock "game" only: which run the tick belongs to */
  game?: { seed: number; build: string };
}

/** A clock's current shape: how long it is, its named moments, and a version stamp of what made it. */
export interface Timeline {
  clock: Clock;
  thing: string;
  length: number;                                           // ticks
  version: string;
  markers: Record<string, { at: number; len?: number }>;    // named moments, ticks
  bpm?: number; beatsPerBar?: number;                       // beats clocks
  shots?: Array<{ id: string; at: number; len: number }>;   // shot clocks, in order
  exists?: boolean;                                         // false: the thing or clock is gone
}

export interface Resolution {
  status: 'ok' | 'moved' | 'stale';
  address: MomentAddress;       // the re-resolved address (unchanged unless it followed `near`)
  reason?: string;              // why it moved or went stale, in words
}

const CLOCK_RE = /^(none|game|(clip|beats|sound|shot):.+)$/;

export function isClock(s: string): s is Clock { return CLOCK_RE.test(s); }

export const secondsToTicks = (s: number) => Math.round(s * TICKS);
export const ticksToSeconds = (t: number) => t / TICKS;

/** Validate an address: whole ticks, a known clock, len > 0, timeless clocks carry no time. */
export function checkAddress(a: MomentAddress): string[] {
  const out: string[] = [];
  if (!a || typeof a.thing !== 'string' || !a.thing) out.push('thing is required');
  if (!isClock(String(a?.clock))) out.push(`clock "${a?.clock}" is not one of none, game, clip:<name>, beats:<track>, sound:<file>, shot:<reel>`);
  if (a.at !== undefined && (!Number.isInteger(a.at) || a.at < 0)) out.push(`at must be whole ticks ≥ 0 (24,000 a second), got ${a.at}`);
  if (a.len !== undefined && (!Number.isInteger(a.len) || a.len <= 0)) out.push(`len must be whole ticks > 0, got ${a.len}`);
  if (a.clock === 'none' && (a.at !== undefined || a.len !== undefined)) out.push('a timeless address (clock none) has no at/len');
  if (a.clock === 'game' && a.at !== undefined && !a.game) out.push('a game moment needs its run: game: { seed, build }');
  return out;
}

/** Short, stable version stamp of any recipe record (the same hash keys render caches). */
export function stamp(record: unknown): string {
  return createHash('sha1').update(stableJson(record)).digest('hex').slice(0, 10);
}

export function stableJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v as object).sort().filter((k) => (v as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson((v as any)[k])}`).join(',')}}`;
}

// ── re-resolving ────────────────────────────────────────────────────────────────────────────────

/**
 * Re-resolve an address against the clock as it is now. `before` is the timeline the address was
 * made on (if known): it gives the offset from the named moment, so "0.2 s after the pour" stays
 * 0.2 s after the pour.
 *
 * - The thing or clock is gone → stale.
 * - Anchored (`near`) and the moment still exists → follows it (moved, with the reason).
 * - Anchored and the moment is gone → stale.
 * - Not anchored, and the timing changed (length or any named moment moved) → stale: we can't tell
 *   what the tick now points at.
 * - Not anchored, timing unchanged → ok (the version stamp is refreshed).
 * - Past the end of the clock → stale.
 */
export function resolveAddress(a: MomentAddress, now: Timeline | null, before?: Timeline | null): Resolution {
  if (a.clock === 'none') {
    if (now && now.exists === false) return { status: 'stale', address: a, reason: `${a.thing} no longer exists` };
    return { status: 'ok', address: now ? { ...a, of: now.version } : a };
  }
  if (!now || now.exists === false) return { status: 'stale', address: a, reason: `${a.thing} has no ${a.clock} any more` };
  if (a.of && a.of === now.version) return { status: 'ok', address: a };
  if (a.near) {
    const m = now.markers[a.near];
    if (!m) return { status: 'stale', address: a, reason: `the moment "${a.near}" is gone from ${a.clock} (has: ${Object.keys(now.markers).join(', ') || 'no named moments'})` };
    const was = before?.markers[a.near];
    const off = a.at !== undefined && was ? a.at - was.at : 0;
    const at = a.at === undefined ? undefined : Math.max(0, m.at + off);
    let len = a.len;
    if (len !== undefined && was?.len && m.len) len = Math.max(1, Math.round(len * (m.len / was.len)));
    if (at !== undefined && at >= now.length) return { status: 'stale', address: a, reason: `"${a.near}" now ends past the clip (${fmtTicks(now.length)} long)` };
    const moved = at !== a.at || len !== a.len;
    const next: MomentAddress = { ...a, ...(at !== undefined ? { at } : {}), ...(len !== undefined ? { len } : {}), of: now.version };
    return moved
      ? { status: 'moved', address: next, reason: `followed "${a.near}" from ${a.at !== undefined ? fmtTicks(a.at) : '?'} to ${at !== undefined ? fmtTicks(at) : '?'}` }
      : { status: 'ok', address: next };
  }
  if (a.at !== undefined) {
    if (a.at >= now.length) return { status: 'stale', address: a, reason: `${fmtTicks(a.at)} is past the end (${fmtTicks(now.length)})` };
    if (!before) return a.of ? { status: 'stale', address: a, reason: `${a.clock} changed since the note (version ${a.of} → ${now.version}) and the note has no named moment to follow` } : { status: 'ok', address: { ...a, of: now.version } };
    if (retimed(before, now)) return { status: 'stale', address: a, reason: `${a.clock} was re-timed and the note has no named moment to follow` };
  }
  return { status: 'ok', address: { ...a, of: now.version } };
}

function retimed(a: Timeline, b: Timeline): boolean {
  if (a.length !== b.length) return true;
  for (const [k, m] of Object.entries(a.markers)) if (!b.markers[k] || b.markers[k].at !== m.at) return true;
  return false;
}

/** The nearest named moment to a tick (to anchor a fresh address). Within `within` ticks (default 0.5 s). */
export function nearestMoment(t: Timeline, at: number, within = TICKS / 2): string | undefined {
  let best: string | undefined, bd = Infinity;
  for (const [k, m] of Object.entries(t.markers)) { const d = Math.abs(m.at - at); if (d < bd) { bd = d; best = k; } }
  return bd <= within ? best : undefined;
}

// ── readable formatting (the view; ticks stay in the files) ──────────────────────────────────────

export function fmtTicks(t: number): string {
  const s = t / TICKS;
  return `${Math.abs(s) < 10 ? +s.toFixed(2) : +s.toFixed(1)} s`;
}

/** "1.4 s", "bar 9", "10:32", "shot 3" — the moment in words for its clock. */
export function formatMoment(a: MomentAddress, t?: Timeline | null): string {
  if (a.clock === 'none' || a.at === undefined) return a.near ? `"${a.near}"` : '';
  const [kind] = a.clock.split(':');
  const s = a.at / TICKS;
  const span = a.len ? `–${fmtNum(s + a.len / TICKS)}` : '';
  switch (kind) {
    case 'beats': {
      const bpm = t?.bpm ?? 120, bpb = t?.beatsPerBar ?? 4;
      const beat = (s * bpm) / 60;
      const bar = Math.floor(beat / bpb) + 1, inBar = Math.floor(beat % bpb) + 1;
      return inBar === 1 ? `bar ${bar}` : `bar ${bar} beat ${inBar}`;
    }
    case 'game': return clockTime(s);
    case 'shot': {
      const shots = t?.shots ?? [];
      const i = shots.findIndex((x) => a.at! >= x.at && a.at! < x.at + x.len);
      if (i < 0) return `${fmtNum(s)} s`;
      const into = (a.at - shots[i].at) / TICKS;
      return into < 0.05 ? `shot ${i + 1}` : `shot ${i + 1} +${fmtNum(into)} s`;
    }
    default: return `${fmtNum(s)}${span} s`;
  }
}

const fmtNum = (s: number) => String(Math.abs(s) < 10 ? +s.toFixed(2) : +s.toFixed(1));
const clockTime = (s: number) => { const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`; };

/** The whole address in words: "Octopus · pour · 2.4 s", "Walnut stool / leg#2". */
export function describeAddress(a: MomentAddress, t?: Timeline | null, nameOf: (id: string) => string = (x) => x): string {
  const [head, ...sub] = a.thing.split('/');
  const what = [nameOf(head), ...sub].join(' / ');
  if (a.clock === 'none') return what;
  const clockName = a.clock.includes(':') ? a.clock.slice(a.clock.indexOf(':') + 1) : a.clock;
  const when = formatMoment(a, t);
  return [what, clockName, a.near ? `"${a.near}"` : '', when].filter(Boolean).join(' · ');
}

// ── a compact string form for the CLI: thing[@clock] [time][+len] [~near] [#of] ────────────────────
//   stool/leg#2
//   octopus@clip:pours-tea 2.4s+0.5s ~pour
//   run@game 37440000t seed=7 build=a1b2

export function formatAddress(a: MomentAddress): string {
  const parts = [a.clock === 'none' ? a.thing : `${a.thing}@${a.clock}`];
  if (a.at !== undefined) parts.push(`${a.at}t${a.len ? `+${a.len}t` : ''}`);
  if (a.near) parts.push(`~${a.near.replace(/\s/g, '_')}`);
  if (a.game) parts.push(`seed=${a.game.seed}`, `build=${a.game.build}`);
  if (a.of) parts.push(`#${a.of}`);
  return parts.join(' ');
}

const TIME_RE = /^(\d+(?:\.\d+)?)(s|t|ms)$/;
const toTicks = (s: string) => {
  const m = s.match(TIME_RE);
  if (!m) throw new Error(`time "${s}" must be like 1.4s, 350ms or 33600t`);
  const v = Number(m[1]);
  return m[2] === 't' ? Math.round(v) : m[2] === 'ms' ? secondsToTicks(v / 1000) : secondsToTicks(v);
};

export function parseAddress(s: string | MomentAddress): MomentAddress {
  if (typeof s !== 'string') { const e = checkAddress(s); if (e.length) throw new Error(e.join('; ')); return s; }
  const trimmed = s.trim();
  if (trimmed.startsWith('{')) return parseAddress(JSON.parse(trimmed));
  const toks = trimmed.split(/\s+/);
  const [thing, clock = 'none'] = toks[0].split('@');
  const a: MomentAddress = { thing, clock: clock as Clock };
  let seed: number | undefined, build: string | undefined;
  for (const tok of toks.slice(1)) {
    if (tok.startsWith('~')) a.near = tok.slice(1).replace(/_/g, ' ');
    else if (tok.startsWith('#')) a.of = tok.slice(1);
    else if (tok.startsWith('seed=')) seed = Number(tok.slice(5));
    else if (tok.startsWith('build=')) build = tok.slice(6);
    else { const [at, len] = tok.split('+'); a.at = toTicks(at); if (len) a.len = toTicks(len); }
  }
  if (seed !== undefined || build !== undefined) a.game = { seed: seed ?? 0, build: build ?? '' };
  const e = checkAddress(a);
  if (e.length) throw new Error(e.join('; '));
  return a;
}
