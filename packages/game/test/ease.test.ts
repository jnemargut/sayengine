// Character state transitions (web template ease.ts): the drawn pose eases toward the logical one, position,
// height and heading together, the heading along the shortest arc, never faster than the limits, and it snaps
// only on a declared cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleDelta, wrapAngle, easePose, PoseEaser, EASE_DEFAULTS, type Pose } from '../templates/web/studio/ease.ts';

const deg = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('the shortest arc: 350° → 10° is +20°, 10° → 350° is −20°, and any number of turns wraps', () => {
  assert.ok(near(toDeg(angleDelta(deg(350), deg(10))), 20));
  assert.ok(near(toDeg(angleDelta(deg(10), deg(350))), -20));
  assert.ok(near(toDeg(angleDelta(deg(720 + 350), deg(-350))), 20));
  assert.ok(near(Math.abs(toDeg(angleDelta(0, Math.PI))), 180));
  assert.ok(near(wrapAngle(deg(-10)), deg(350)));
});

test('350° → 10° turns 20° in total (never 340° the long way), and every frame stays within the turn rate', () => {
  const e = new PoseEaser();
  const p = { x: 0, y: 0, z: 0, heading: deg(350) };
  e.update(p, 1 / 60);
  let travelled = 0, prev = deg(350), maxRate = 0;
  for (let i = 0; i < 240; i++) {
    const d = e.update({ ...p, heading: deg(10) }, 1 / 60);
    const step = angleDelta(prev, d.heading);
    travelled += step; maxRate = Math.max(maxRate, Math.abs(step) * 60); prev = d.heading;
  }
  assert.ok(near(toDeg(travelled), 20, 1e-3), `turned ${toDeg(travelled)}°`);
  assert.ok(near(toDeg(e.drawn!.heading), 10, 1e-3));
  assert.ok(maxRate <= EASE_DEFAULTS.turn + 1e-9, `${toDeg(maxRate)}°/s`);
});

test('a long frame cannot spin or pop: rates cap a big dt (the lerp(k = dt·8) bug)', () => {
  const from: Pose = { x: 0, y: 0, z: 0, heading: 0 };
  const to: Pose = { x: 3, y: 0.9, z: 0, heading: deg(180 - 1) };
  const dt = 0.25;   // a 4 fps hitch: lerp with k = dt·8 = 2 would overshoot
  const s = easePose(from, to, dt);
  assert.ok(s.x <= EASE_DEFAULTS.speed * dt + 1e-9 && s.x > 0, `moved ${s.x} m`);
  assert.ok(s.y <= EASE_DEFAULTS.climb * dt + 1e-9 && s.y > 0, `rose ${s.y} m`);
  assert.ok(Math.abs(angleDelta(0, s.heading)) <= EASE_DEFAULTS.turn * dt + 1e-9, `turned ${toDeg(s.heading)}°`);
  const w = easePose(from, to, dt, {}, { walking: true });
  assert.ok(Math.abs(angleDelta(0, w.heading)) <= EASE_DEFAULTS.turnWalking * dt + 1e-9, 'walking turns faster, still capped');
  assert.ok(Math.abs(angleDelta(0, w.heading)) > Math.abs(angleDelta(0, s.heading)));
});

test('position, height and heading arrive together without overshoot; limits are settings; a cut snaps', () => {
  const e = new PoseEaser({ speed: 1.5, turn: deg(90) });
  e.update({ x: 0, y: 0, z: 0, heading: 0 }, 1 / 30);
  const goal = { x: 1, y: 0.5, z: -1, heading: deg(-90) };
  let maxStep = 0, last = { ...e.drawn! };
  for (let i = 0; i < 300; i++) {
    const d = e.update(goal, 1 / 30);
    maxStep = Math.max(maxStep, Math.hypot(d.x - last.x, d.z - last.z) * 30);
    assert.ok(d.x <= 1 + 1e-9 && d.z >= -1 - 1e-9 && d.y <= 0.5 + 1e-9, 'no overshoot');
    last = { ...d };
  }
  assert.ok(maxStep <= 1.5 + 1e-9, `${maxStep} m/s`);
  assert.ok(near(e.drawn!.x, 1, 1e-3) && near(e.drawn!.y, 0.5, 1e-3) && near(toDeg(e.drawn!.heading), 270, 1e-2));
  const c = e.update({ x: 9, y: 0, z: 9, heading: deg(45) }, 1 / 30, { cut: true });
  assert.deepEqual([c.x, c.z], [9, 9], 'a declared cut places it exactly');
  e.cut();
  assert.deepEqual(e.update({ x: -4, y: 0, z: 2, heading: 0 }, 1 / 30).x, -4);
});
