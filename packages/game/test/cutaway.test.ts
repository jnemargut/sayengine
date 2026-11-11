// Camera cutaway protection (web template cutaway.ts): fade what blocks the view of the subject, but never the
// subject, its support (found by a ray down, not a height test), the event's target, or where a thrown object
// started, in any beat including its flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutaway, segmentHitsBox, supportUnder, type CutBox, type V3 } from '../templates/web/studio/cutaway.ts';

const box = (id: string, min: V3, max: V3): CutBox => ({ id, min, max });
// a kitchen: a floor, a counter the subject stands on, a dining chair between the camera and the subject,
// a chair off to the side, a shelf the mug starts on, and a wall behind
const floor = box('floor', [-5, -0.1, -5], [5, 0, 5]);
const counter = box('counter', [-0.5, 0, -0.5], [0.5, 0.9, 0.5]);
const chairBetween = box('chair-between', [-0.3, 0, 1.5], [0.3, 0.85, 2.0]);   // lower than the subject's feet
const chairAside = box('chair-aside', [2.5, 0, 0], [3.0, 0.85, 0.5]);
const shelf = box('shelf', [-2.2, 1.2, -0.3], [-1.6, 1.25, 0.3]);
const wall = box('wall', [-5, 0, -1.2], [5, 2.5, -1.0]);
const cat = box('subject', [-0.15, 0.9, -0.2], [0.15, 1.2, 0.2]);
const boxes = [floor, counter, chairBetween, chairAside, shelf, wall, cat];
const camera: V3 = [0, 1.1, 4];
const subject = { id: 'subject', points: [[0, 1.15, 0], [0, 1.0, 0], [0, 0.92, 0.15]] as V3[] };
const feet: V3 = [0, 0.9, 0];

test('geometry: a segment through a box, and the support straight down', () => {
  assert.equal(segmentHitsBox([0, 0.5, 4], [0, 0.5, 0], chairBetween), true);
  assert.equal(segmentHitsBox([0, 2, 4], [0, 2, 0], chairBetween), false, 'over it');
  assert.equal(segmentHitsBox([0, 0.5, 4], [0, 0.5, 2.2], chairBetween), false, 'stops short');
  assert.equal(segmentHitsBox([0, 0.9, 4], [0, 0.9, 0.5], counter, 0.05), false, 'ends at the face: the inset keeps a touch from counting');
  assert.equal(supportUnder(feet, boxes.filter((b) => b.id !== 'subject'))?.id, 'counter', 'the counter, not the floor below it');
  assert.equal(supportUnder([2.75, 1.0, 0.25], boxes)?.id, 'chair-aside');
  assert.equal(supportUnder([0, 5, 0], boxes, 1.5), null, 'too high above anything');
});

test('a chair lower than the subject\'s feet still fades when it blocks the view; the counter under the feet never does', () => {
  // the camera sits low enough that the sight line to the feet crosses both the chair and the counter edge
  const low: V3 = [0, 0.7, 4];
  const r = cutaway({ camera: low, subject, feet, boxes });
  assert.ok(r.fade.includes('chair-between'), JSON.stringify(r));
  assert.ok(!r.fade.includes('counter'), 'the support stays drawn');
  assert.deepEqual(r.support, ['counter']);
  assert.ok(r.kept.some((k) => k.id === 'counter' && k.why === 'support'), JSON.stringify(r.kept));
  assert.ok(!r.fade.includes('subject') && !r.fade.includes('chair-aside') && !r.fade.includes('wall'), 'only true occluders fade');
});

test('the event\'s target and the subject are never faded, even when they block', () => {
  const r = cutaway({ camera: [0, 0.7, 4], subject, feet, boxes, protect: ['chair-between'] });
  assert.ok(!r.fade.includes('chair-between'));
  assert.ok(r.kept.some((k) => k.id === 'chair-between' && k.why === 'protected'));
  // a camera inside the subject's own box sees through nothing of it
  const r2 = cutaway({ camera: [0, 1.0, 3], subject, feet, boxes: [cat, counter] });
  assert.ok(!r2.fade.includes('subject'));
});

test('a thrown object: where it started stays drawn in every beat, flight included; what blocks it in flight fades', () => {
  const start: V3 = [-1.9, 1.3, 0];
  const now: V3 = [-1.0, 0.5, 1.75];
  const beside = box('stool', [-1.2, 0, 2.2], [-0.8, 0.6, 2.6]);   // between the camera and the mug mid-flight
  const all = [...boxes, beside];
  // the camera looks past the shelf at the subject: without the thrown object the shelf is just an occluder
  const cam: V3 = [-3.8, 1.3, 0];
  assert.ok(cutaway({ camera: cam, subject, feet, boxes: all }).fade.includes('shelf'), 'control: the shelf blocks this view');
  for (const beat of ['setup', 'flight', 'landing'] as const) {
    const r = cutaway({ camera: cam, subject, feet, boxes: all, thrown: { start, now: beat === 'flight' ? now : undefined } });
    assert.ok(!r.fade.includes('shelf'), `${beat}: the shelf the mug left is kept (${JSON.stringify(r)})`);
    assert.ok(r.kept.some((k) => k.id === 'shelf' && k.why === 'thrown from'));
    assert.ok(r.support.includes('shelf'), `${beat}: the shelf is in the support set`);
  }
  const r = cutaway({ camera: [-1.0, 0.4, 4], subject: { points: [] }, boxes: all, thrown: { start, now } });
  assert.ok(r.fade.includes('stool'), `the stool blocks the flying mug: ${JSON.stringify(r)}`);
  assert.ok(!r.fade.includes('shelf'));
});

test('a protected point keeps whatever holds it', () => {
  const vase: V3 = [2.75, 0.95, 0.25];   // on the side chair
  const cam: V3 = [6, 0.5, 0.25];
  assert.ok(cutaway({ camera: cam, subject: { points: [[2.4, 0.5, 0.25]] }, boxes }).fade.includes('chair-aside'), 'control: the chair blocks a point behind it');
  const r = cutaway({ camera: cam, subject: { points: [[2.4, 0.5, 0.25]] }, boxes, points: [vase] });
  assert.ok(r.support.includes('chair-aside'));
  assert.ok(!r.fade.includes('chair-aside'));
});
