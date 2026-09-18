import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampRangeHandle, epochAtPercent, keyboardPercent, percentAtEpoch, pointerPercent,
} from '../../src/ui/views/rangeMath.ts';

test('the start handle moves independently and preserves the end handle', () => {
  assert.deepEqual(clampRangeHandle('start', 37.5, 0, 82), [37.5, 82]);
});

test('the end handle moves independently and preserves the start handle', () => {
  assert.deepEqual(clampRangeHandle('end', 82, 37.5, 100), [37.5, 82]);
});

test('handles clamp at each other and at the rail boundaries', () => {
  assert.deepEqual(clampRangeHandle('start', 90, 20, 70), [70, 70]);
  assert.deepEqual(clampRangeHandle('end', 10, 30, 80), [30, 30]);
  assert.deepEqual(clampRangeHandle('start', -50, 20, 70), [0, 70]);
  assert.deepEqual(clampRangeHandle('end', 150, 30, 80), [30, 100]);
});

test('pointer coordinates map to a bounded rail percentage', () => {
  assert.equal(pointerPercent(150, 100, 200), 25);
  assert.equal(pointerPercent(50, 100, 200), 0);
  assert.equal(pointerPercent(350, 100, 200), 100);
});

test('slider percentages convert to epochs only at the boundary', () => {
  const lower = Date.parse('2023-04-03T00:00:00Z');
  const upper = Date.parse('2024-06-04T00:00:00Z');
  const middle = epochAtPercent(lower, upper, 35);
  assert.ok(middle > lower && middle < upper);
  assert.equal(percentAtEpoch(lower, upper, middle), 35);
  // A percentage must never itself be interpreted as an epoch timestamp.
  assert.notEqual(middle, 35);
});

test('keyboard movement supports fine and accelerated steps', () => {
  assert.equal(keyboardPercent('ArrowRight', 20), 20.5);
  assert.equal(keyboardPercent('ArrowLeft', 20, true), 15);
  assert.equal(keyboardPercent('Home', 20), 0);
  assert.equal(keyboardPercent('End', 20), 100);
  assert.equal(keyboardPercent('Enter', 20), null);
});
