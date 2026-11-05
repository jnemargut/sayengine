import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, step, pickUp, deliver, feed, drainRate, GOAL, CHARCOAL, WRONG_COST, WORK_TIME } from '../src/rules.ts';

const run = (s: ReturnType<typeof newGame>, secs: number, dt = 0.1) => { const ev = []; for (let t = 0; t < secs; t += dt) ev.push(...step(s, dt)); return ev; };

test('the fire drains and the game is lost when it goes out', () => {
  const s = newGame(7);
  const ev = run(s, 200);
  assert.equal(s.phase, 'lost');
  assert.ok(ev.some((e) => e.kind === 'lost'));
  assert.ok(ev.some((e) => e.kind === 'low-fire'), 'the smith shouts for charcoal before it dies');
  // starting at 0.8 and draining 0.014/s, it lasts about 57 s with no help
  assert.ok(s.t > 52 && s.t < 62, `lasted ${s.t.toFixed(1)} s`);
});

test('the smith calls for a tool after a short wait, never the same twice in a row', () => {
  const s = newGame(3);
  let last: string | null = null;
  for (let i = 0; i < GOAL - 1; i++) {
    const call = run(s, 6).find((e) => e.kind === 'call');
    assert.ok(call && call.kind === 'call', 'a call within 6 s');
    assert.notEqual(call.item, last);
    last = call.item;
    pickUp(s, call.item);
    deliver(s);
    s.fire = 1; // keep it alive for the test
  }
});

test('the right tool counts towards the blade; the wrong one costs fire and keeps the call', () => {
  const s = newGame(5);
  run(s, 2);
  const want = s.request!;
  const other = (['tongs', 'hammer', 'bucket', 'file'] as const).find((i) => i !== want)!;
  pickUp(s, other);
  const f0 = s.fire;
  const ev = deliver(s);
  assert.equal(ev[0].kind, 'wrong');
  assert.equal(s.done, 0);
  assert.equal(s.request, want);
  assert.ok(Math.abs(s.fire - (f0 - WRONG_COST)) < 1e-9);
  pickUp(s, want);
  assert.equal(deliver(s)[0].kind, 'good');
  assert.equal(s.done, 1);
  assert.equal(s.request, null);
  assert.equal(s.working, WORK_TIME);
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

test('the blade is finished after GOAL tools; the fire drains faster as it nears done', () => {
  const s = newGame(11);
  assert.ok(drainRate(GOAL - 1) > drainRate(0) * 1.75);
  let won = false;
  for (let i = 0; i < GOAL; i++) {
    run(s, 6);
    pickUp(s, s.request!);
    won = deliver(s).some((e) => e.kind === 'won');
    s.fire = 1;
  }
  assert.ok(won);
  assert.equal(s.phase, 'won');
  assert.deepEqual(step(s, 1), [], 'nothing happens after the end');
});

test('the same seed plays the same calls', () => {
  const calls = (seed: number) => { const s = newGame(seed); const out: string[] = []; for (let i = 0; i < 8; i++) { run(s, 6); out.push(s.request!); pickUp(s, s.request!); deliver(s); s.fire = 1; } return out.join(','); };
  assert.equal(calls(42), calls(42));
  assert.notEqual(calls(42), calls(43));
});
