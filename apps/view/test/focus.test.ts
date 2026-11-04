// Regression: clicking a proposal thumbnail must stick. The view used to re-focus the active
// branch on every render, so clicking p2 while Claude had last edited p3 snapped back to p3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusOnState, validFocus } from '../src/focus.ts';

test('a clicked thumbnail survives later state updates on the same active branch', () => {
  let focus = focusOnState('main', undefined, 'p3');   // first state: Claude is on p3
  assert.equal(focus, 'p3');
  focus = 'p2';                                        // human clicks the p2 thumbnail
  for (let i = 0; i < 3; i++) focus = focusOnState(focus, 'p3', 'p3');
  assert.equal(focus, 'p2');
  focus = 'main';                                      // clicking main sticks too
  assert.equal(focusOnState(focus, 'p3', 'p3'), 'main');
});

test('the view follows Claude when it switches to another proposal, but not back to main', () => {
  assert.equal(focusOnState('p2', 'p3', 'p4'), 'p4');
  assert.equal(focusOnState('p2', 'p3', 'main'), 'p2');
});

test('a committed or discarded proposal falls back to an open one, then main', () => {
  assert.equal(validFocus('p2', ['p3']), 'p3');
  assert.equal(validFocus('p2', []), 'main');
  assert.equal(validFocus('p2', ['p2', 'p3']), 'p2');
  assert.equal(validFocus('main', ['p3']), 'main');
});
