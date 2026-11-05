// Fire's Dying — the rules, as plain code (no three.js): tested in test/rules.test.ts.
// The smith calls for tools one at a time; you fetch each from where it lives and hand it to him.
// The forge fire drains all the while; charcoal from the sack, tipped into the forge, feeds it.
// Finish the blade (GOAL tools delivered) before the fire goes out.
import type { Item } from './lines.ts';

export const TOOLS: Item[] = ['tongs', 'hammer', 'bucket', 'file'];
export const GOAL = 16;
/** fire drained per second: gentle at first, faster as the blade nears done */
export const drainRate = (done: number) => 0.014 + 0.0008 * done;
export const CHARCOAL = 0.45;   // fire added per sack of charcoal tipped in
export const WRONG_COST = 0.06; // fire lost to the time a wrong tool wastes
export const WORK_TIME = 3.5;   // seconds the smith hammers between calls
export const LOW_FIRE = 0.3;    // he shouts for charcoal below this

export type Phase = 'play' | 'won' | 'lost';
export type Event =
  | { kind: 'call'; item: Item }
  | { kind: 'good'; item: Item }
  | { kind: 'wrong'; item: Item; wanted: Item }
  | { kind: 'fed'; fire: number }
  | { kind: 'low-fire' }
  | { kind: 'won' } | { kind: 'lost' };

export interface State {
  phase: Phase; t: number; fire: number; done: number;
  request: Item | null; working: number;      // seconds left before the next call
  carrying: Item | null; wrongs: number; fed: number; warned: boolean; seed: number; lastCall?: Item;
}

export function newGame(seed = 1): State {
  return { phase: 'play', t: 0, fire: 0.8, done: 0, request: null, working: 1.5, carrying: null, wrongs: 0, fed: 0, warned: false, seed: seed >>> 0 || 1 };
}

function rand(s: State): number { // xorshift32, deterministic per seed
  let x = s.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; s.seed = x >>> 0;
  return s.seed / 4294967296;
}

/** Advance time. Returns what happened (calls, warnings, the end). */
export function step(s: State, dt: number): Event[] {
  if (s.phase !== 'play') return [];
  const ev: Event[] = [];
  s.t += dt;
  s.fire = Math.max(0, s.fire - drainRate(s.done) * dt);
  if (s.fire <= 0) { s.phase = 'lost'; return [{ kind: 'lost' }]; }
  if (s.fire < LOW_FIRE && !s.warned) { s.warned = true; ev.push({ kind: 'low-fire' }); }
  if (s.fire >= LOW_FIRE + 0.1) s.warned = false;
  if (!s.request) {
    s.working -= dt;
    if (s.working <= 0) {
      const prev = s.lastCall;
      const pool = TOOLS.filter((i) => i !== prev);
      const item = pool[Math.floor(rand(s) * pool.length)];
      s.request = item; s.lastCall = item;
      ev.push({ kind: 'call', item });
    }
  }
  return ev;
}

/** Pick something up from where it lives (one thing at a time: what you held goes back). */
export function pickUp(s: State, item: Item): void { if (s.phase === 'play') s.carrying = item; }

/** Hand what you carry to the smith. */
export function deliver(s: State): Event[] {
  if (s.phase !== 'play' || !s.carrying || s.carrying === 'charcoal') return [];
  const item = s.carrying;
  s.carrying = null;
  if (!s.request || item !== s.request) {
    s.wrongs++;
    s.fire = Math.max(0, s.fire - WRONG_COST);
    const ev: Event[] = [{ kind: 'wrong', item, wanted: s.request ?? item }];
    if (s.fire <= 0) { s.phase = 'lost'; ev.push({ kind: 'lost' }); }
    return ev;
  }
  s.done++;
  s.request = null;
  s.working = WORK_TIME;
  if (s.done >= GOAL) { s.phase = 'won'; return [{ kind: 'good', item }, { kind: 'won' }]; }
  return [{ kind: 'good', item }];
}

/** Tip the charcoal you carry into the forge. */
export function feed(s: State): Event[] {
  if (s.phase !== 'play' || s.carrying !== 'charcoal') return [];
  s.carrying = null;
  s.fed++;
  s.fire = Math.min(1, s.fire + CHARCOAL);
  return [{ kind: 'fed', fire: s.fire }];
}
