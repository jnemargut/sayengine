// Fire's Dying — the rules, as plain code (no three.js): tested in test/rules.test.ts.
// The smith calls for one job at a time: a tool fetched and handed to him, the bellows pumped, or (every
// fifth job) the blade quenched — the water bucket tipped into the quench tub. The forge fire drains
// all the while, faster as the blade nears done; charcoal from the sack feeds it. A job left waiting
// past his patience cools the iron and costs fire. Finish the blade (GOAL jobs) before the fire dies.
import type { Item, Job } from './lines.ts';

/** jobs he calls at random (never the same twice running); quench comes on its own beat */
export const RANDOM_JOBS: Job[] = ['tongs', 'hammer', 'file', 'chisel', 'whetstone', 'bellows'];
export const TOOLS: Item[] = ['tongs', 'hammer', 'file', 'chisel', 'whetstone'];
export const GOAL = 20;
export const QUENCH_EVERY = 5;   // jobs 5, 10, 15 and 20 are "quench it"
/** fire drained per second: gentle at first, about twice as fast at the end */
export const drainRate = (done: number) => 0.0095 + 0.0005 * done;
/** seconds he waits for a job before the iron cools (shorter as the work goes on) */
export const patience = (done: number) => 16 - 0.25 * done;
export const CHARCOAL = 0.4;        // fire added per sack of charcoal tipped in
export const BELLOWS = 0.1;         // fire added by pumping the bellows when he calls for it
export const BELLOWS_SPARE = 0.04;  // ...and when he didn't (once every PUMP_COOL seconds)
export const PUMP_COOL = 3;
export const WRONG_COST = 0.06;     // fire lost to the time a wrong tool wastes
export const WAIT_COST = 0.07;      // fire lost each time a job outlasts his patience
export const WORK_TIME = 3.5;       // seconds the smith hammers between calls
export const LOW_FIRE = 0.3;        // he shouts for charcoal below this
/** walking speed while carrying (the sack and the full bucket are heavy) */
export const CARRY_SPEED: Partial<Record<Item, number>> = { charcoal: 0.75, bucket: 0.8 };

export type Phase = 'play' | 'won' | 'lost';
export type Event =
  | { kind: 'call'; job: Job }
  | { kind: 'good'; job: Job }
  | { kind: 'wrong'; item: Item; wanted: Job }
  | { kind: 'impatient'; job: Job }
  | { kind: 'fed'; fire: number }
  | { kind: 'pumped'; fire: number }
  | { kind: 'low-fire' }
  | { kind: 'won' } | { kind: 'lost' };

export interface State {
  phase: Phase; t: number; fire: number; done: number;
  request: Job | null; waited: number;   // seconds the current job has waited
  working: number;                       // seconds left before the next call
  carrying: Item | null; wrongs: number; fed: number; pumped: number; late: number; pumpCool: number;
  warned: boolean; seed: number; lastCall?: Job;
}

export function newGame(seed = 1): State {
  return { phase: 'play', t: 0, fire: 0.8, done: 0, request: null, waited: 0, working: 1.5, carrying: null, wrongs: 0, fed: 0, pumped: 0, late: 0, pumpCool: 0, warned: false, seed: seed >>> 0 || 1 };
}

function rand(s: State): number { // xorshift32, deterministic per seed
  let x = s.seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; s.seed = x >>> 0;
  return s.seed / 4294967296;
}

/** The job the next call will be: quench on its beat, otherwise random (never the last one again). */
export function nextJob(s: State): Job {
  if ((s.done + 1) % QUENCH_EVERY === 0) return 'quench';
  const pool = RANDOM_JOBS.filter((j) => j !== s.lastCall);
  return pool[Math.floor(rand(s) * pool.length)];
}

const burn = (s: State, cost: number, ev: Event[]) => {
  s.fire = Math.max(0, s.fire - cost);
  if (s.fire <= 0 && s.phase === 'play') { s.phase = 'lost'; ev.push({ kind: 'lost' }); }
};

/** Advance time. Returns what happened (calls, warnings, the end). */
export function step(s: State, dt: number): Event[] {
  if (s.phase !== 'play') return [];
  const ev: Event[] = [];
  s.t += dt;
  s.pumpCool = Math.max(0, s.pumpCool - dt);
  burn(s, drainRate(s.done) * dt, ev);
  if (s.phase !== 'play') return ev;
  if (s.fire < LOW_FIRE && !s.warned) { s.warned = true; ev.push({ kind: 'low-fire' }); }
  if (s.fire >= LOW_FIRE + 0.1) s.warned = false;
  if (!s.request) {
    s.working -= dt;
    if (s.working <= 0) {
      const job = nextJob(s);
      s.request = job; s.lastCall = job; s.waited = 0;
      ev.push({ kind: 'call', job });
    }
  } else if ((s.waited += dt) >= patience(s.done)) {
    s.waited = 0; s.late++;
    ev.push({ kind: 'impatient', job: s.request });
    burn(s, WAIT_COST, ev);
  }
  return ev;
}

/** Pick something up from where it lives (one thing at a time: what you held goes back). */
export function pickUp(s: State, item: Item): void { if (s.phase === 'play') s.carrying = item; }

const done = (s: State, job: Job): Event[] => {
  s.done++;
  s.request = null;
  s.working = WORK_TIME;
  if (s.done >= GOAL) { s.phase = 'won'; return [{ kind: 'good', job }, { kind: 'won' }]; }
  return [{ kind: 'good', job }];
};

/** Hand what you carry to the smith (tools only: charcoal goes in the forge, water in the tub). */
export function deliver(s: State): Event[] {
  if (s.phase !== 'play' || !s.carrying || s.carrying === 'charcoal') return [];
  const item = s.carrying;
  s.carrying = null;
  if (!s.request || item !== s.request) {
    s.wrongs++;
    const ev: Event[] = [{ kind: 'wrong', item, wanted: s.request ?? (item as Job) }];
    burn(s, WRONG_COST, ev);
    return ev;
  }
  return done(s, item as Job);
}

/** Tip the charcoal you carry into the forge. */
export function feed(s: State): Event[] {
  if (s.phase !== 'play' || s.carrying !== 'charcoal') return [];
  s.carrying = null;
  s.fed++;
  s.fire = Math.min(1, s.fire + CHARCOAL);
  return [{ kind: 'fed', fire: s.fire }];
}

/** Tip the water bucket into the quench tub: only when he has called "quench" (otherwise you keep it). */
export function quench(s: State): Event[] {
  if (s.phase !== 'play' || s.carrying !== 'bucket' || s.request !== 'quench') return [];
  s.carrying = null;
  return done(s, 'quench');
}

/** Pump the bellows (hands free or not): a big lift when he called for it, a small one otherwise. */
export function pump(s: State): Event[] {
  if (s.phase !== 'play') return [];
  if (s.request === 'bellows') {
    s.pumped++;
    s.fire = Math.min(1, s.fire + BELLOWS);
    s.pumpCool = PUMP_COOL;
    return [{ kind: 'pumped', fire: s.fire }, ...done(s, 'bellows')];
  }
  if (s.pumpCool > 0) return [];
  s.pumped++;
  s.pumpCool = PUMP_COOL;
  s.fire = Math.min(1, s.fire + BELLOWS_SPARE);
  return [{ kind: 'pumped', fire: s.fire }];
}
