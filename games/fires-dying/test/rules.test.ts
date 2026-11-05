import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, step, pickUp, deliver, feed, quench, pump, nextJob, drainRate, patience, GOAL, CHARCOAL, BELLOWS, BELLOWS_SPARE, WRONG_COST, WAIT_COST, WORK_TIME, QUENCH_EVERY, type State } from '../src/rules.ts';
import type { Item, Job } from '../src/lines.ts';

const run = (s: State, secs: number, dt = 0.1) => { const ev = []; for (let t = 0; t < secs - 1e-9; t += dt) ev.push(...step(s, dt)); return ev; };
/** do whatever the current job needs, instantly */
const doJob = (s: State) => {
  const j = s.request!;
  if (j === 'bellows') return pump(s);
  if (j === 'quench') { pickUp(s, 'bucket'); return quench(s); }
  pickUp(s, j as Item); return deliver(s);
};
const callWithin = (s: State, secs: number) => run(s, secs).find((e) => e.kind === 'call');

test('left alone, the fire dies in about a minute (and he shouts for charcoal first)', () => {
  const s = newGame(7);
  const ev = run(s, 200);
  assert.equal(s.phase, 'lost');
  assert.ok(ev.some((e) => e.kind === 'lost'));
  assert.ok(ev.some((e) => e.kind === 'low-fire'), 'the smith shouts for charcoal before it dies');
  assert.ok(ev.filter((e) => e.kind === 'impatient').length >= 2, 'the jobs he called went cold');
  assert.ok(s.t > 52 && s.t < 68, `lasted ${s.t.toFixed(1)} s`);
});

test('he calls a job after a short wait, never the same twice running, and quench every fifth', () => {
  const s = newGame(3);
  let last: Job | null = null;
  const seen = new Set<Job>();
  for (let i = 0; i < GOAL - 1; i++) {
    const call = callWithin(s, 6);
    assert.ok(call && call.kind === 'call', 'a call within 6 s');
    assert.notEqual(call.job, last);
    assert.equal(call.job === 'quench', (i + 1) % QUENCH_EVERY === 0, `job ${i + 1} is ${call.job}`);
    last = call.job;
    seen.add(call.job);
    doJob(s);
    s.fire = 1; // keep it alive for the test
  }
  assert.equal(seen.size, 7, `every job comes up in a run (saw ${[...seen].join(', ')})`);
});

test('the right tool counts towards the blade; the wrong one costs fire and keeps the call', () => {
  const s = newGame(5);
  while (s.request === null || s.request === 'bellows' || s.request === 'quench') { if (s.request) doJob(s); run(s, 1); s.fire = 1; }
  const want = s.request as Item;
  const other = (['tongs', 'hammer', 'file', 'chisel'] as const).find((i) => i !== want)!;
  pickUp(s, other);
  const f0 = s.fire, d0 = s.done;
  const ev = deliver(s);
  assert.equal(ev[0].kind, 'wrong');
  assert.equal(s.done, d0);
  assert.equal(s.request, want);
  assert.ok(Math.abs(s.fire - (f0 - WRONG_COST)) < 1e-9);
  pickUp(s, want);
  assert.equal(deliver(s)[0].kind, 'good');
  assert.equal(s.done, d0 + 1);
  assert.equal(s.request, null);
  assert.equal(s.working, WORK_TIME);
});

test('a job left waiting past his patience costs fire, and again each time it runs out', () => {
  const s = newGame(9);
  callWithin(s, 3);
  const f0 = s.fire;
  const ev = run(s, patience(0) * 2 + 0.05);
  assert.equal(ev.filter((e) => e.kind === 'impatient').length, 2);
  const drained = drainRate(0) * (patience(0) * 2 + 0.05);
  assert.ok(Math.abs(s.fire - (f0 - drained - 2 * WAIT_COST)) < 0.01, `fire ${s.fire}`);
  assert.ok(patience(GOAL - 1) < patience(0) * 0.75, 'he gets less patient as the blade nears done');
});

test('charcoal feeds the forge (not the smith), capped at full', () => {
  const s = newGame(1);
  s.fire = 0.3;
  pickUp(s, 'charcoal');
  assert.deepEqual(deliver(s), [], 'the smith does not take charcoal');
  assert.equal(s.carrying, 'charcoal');
  feed(s);
  assert.ok(Math.abs(s.fire - (0.3 + CHARCOAL)) < 1e-9);
  s.fire = 0.9; pickUp(s, 'charcoal'); feed(s);
  assert.equal(s.fire, 1);
  assert.deepEqual(feed(s), [], 'nothing to feed with empty hands');
});

test('quench: the bucket goes in the tub only when he calls for it; to the smith it is the wrong thing', () => {
  const s = newGame(2);
  pickUp(s, 'bucket');
  assert.deepEqual(quench(s), [], 'no quench called: you keep the bucket');
  assert.equal(s.carrying, 'bucket');
  s.done = QUENCH_EVERY - 1;
  assert.equal(nextJob(s), 'quench');
  callWithin(s, 3);
  assert.equal(s.request, 'quench');
  const ev = quench(s);
  assert.equal(ev[0].kind, 'good');
  assert.equal(s.done, QUENCH_EVERY);
  assert.equal(s.carrying, null);
});

test('bellows: a big lift when called (and it counts), a small one on spare pumps, with a cool-down', () => {
  const s = newGame(4);
  s.fire = 0.5;
  assert.equal(pump(s)[0].kind, 'pumped');
  assert.ok(Math.abs(s.fire - (0.5 + BELLOWS_SPARE)) < 1e-9);
  assert.deepEqual(pump(s), [], 'cooling down');
  s.request = 'bellows'; s.fire = 0.5;
  const ev = pump(s);
  assert.ok(ev.some((e) => e.kind === 'good'));
  assert.ok(Math.abs(s.fire - (0.5 + BELLOWS)) < 1e-9);
  assert.equal(s.done, 1);
});

test('the blade is finished after GOAL jobs; the fire drains faster as it nears done', () => {
  const s = newGame(11);
  assert.ok(drainRate(GOAL - 1) > drainRate(0) * 1.75);
  let won = false;
  for (let i = 0; i < GOAL; i++) { callWithin(s, 6); won = doJob(s).some((e) => e.kind === 'won'); s.fire = 1; }
  assert.ok(won);
  assert.equal(s.phase, 'won');
  assert.deepEqual(step(s, 1), [], 'nothing happens after the end');
});

test('the same seed plays the same calls', () => {
  const calls = (seed: number) => { const s = newGame(seed); const out: string[] = []; for (let i = 0; i < 12; i++) { callWithin(s, 6); out.push(s.request!); doJob(s); s.fire = 1; } return out.join(','); };
  assert.equal(calls(42), calls(42));
  assert.notEqual(calls(42), calls(43));
});

// ── balance: a model player who walks the yard ─────────────────────────────────────────────────
// Seconds each errand takes at walking pace (1.4 m/s; slower with the sack or the full bucket), from
// the yard's layout: the shelf is ~3.6 m from the anvil, the bench ~2 m, the bellows ~2.8 m, the sack
// ~2.6 m and then ~2.1 m to the forge, the bucket ~2.1 m and then ~3.7 m to the quench tub.
const ERRAND: Record<Job | 'charcoal', number> = { tongs: 7.2, file: 7.2, chisel: 7.2, whetstone: 7.2, hammer: 4.9, bellows: 5.4, quench: 8.1, charcoal: 7 };
/** A player who reacts after `react` s, works at `pace` (1 = brisk), and fetches charcoal below `feedAt`
 *  (during the smith's hammering when they can). Returns the run. */
function model(seed: number, pace: number, react: number, feedAt: number) {
  const s = newGame(seed), dt = 0.1;
  let busy = 0, doing: Job | 'charcoal' | null = null, minFire = 1;
  while (s.phase === 'play' && s.t < 900) {
    step(s, dt);
    minFire = Math.min(minFire, s.fire);
    if (busy > 0) { busy -= dt; if (busy <= 0 && doing) { if (doing === 'charcoal') { pickUp(s, 'charcoal'); feed(s); } else if (s.request === doing) doJob(s); doing = null; } continue; }
    if (s.fire < feedAt) { doing = 'charcoal'; busy = ERRAND.charcoal * pace + react; }
    else if (s.request) { doing = s.request; busy = ERRAND[s.request] * pace + react; }
  }
  return { phase: s.phase, t: s.t, minFire, fed: s.fed, late: s.late };
}

test('balance: a brisk player wins in about 4–5 minutes, under pressure; a slow one loses', () => {
  const good = [1, 2, 3, 4, 5].map((seed) => model(seed, 1, 0.8, 0.4));
  for (const r of good) {
    assert.equal(r.phase, 'won', JSON.stringify(r));
    assert.ok(r.t > 200 && r.t < 330, `a brisk run takes ${r.t.toFixed(0)} s`);
    assert.ok(r.minFire < 0.42, `the fire got low at least once (${r.minFire.toFixed(2)})`);
  }
  const slow = [1, 2, 3].map((seed) => model(seed, 1.7, 1.5, 0.3));
  assert.ok(slow.every((r) => r.phase === 'lost'), JSON.stringify(slow));
});
