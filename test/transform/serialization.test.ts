import test from 'node:test';
import assert from 'node:assert/strict';
import { exportOperation, exportPlan, importOperations } from '../../src/host/transform/serialization.ts';

test('operation and plan definitions round-trip through JSON', () => {
  const op = { kind: 'filterEvents' as const, column: 'activity' as const, op: 'is' as const, value: 'Ship', disabled: true };

  assert.deepEqual(importOperations(JSON.stringify(exportOperation(op))), [op]);
  assert.deepEqual(importOperations(JSON.stringify(exportPlan([op]))), [op]);
});

test('imports reject malformed definitions and invalid flatten placement', () => {
  assert.throws(() => importOperations(JSON.stringify({ kind: 'filterEvents', column: 'activity' })), /invalid fields/);
  assert.throws(() => importOperations(JSON.stringify([
    { kind: 'filterEvents', column: 'activity', op: 'is', value: 'Ship' },
    { kind: 'flattenByObjectType', objectType: 'order' },
  ])), /first and only/);
});

test('a case set from a plugin is checked element by element', () => {
  const ops = importOperations(JSON.stringify([
    { kind: 'keepCases', traces: [0, 7, 12], label: 'Cluster 1' },
  ]));
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { kind: 'keepCases', traces: [0, 7, 12], label: 'Cluster 1' });

  for (const traces of [[1, -2], [1, 2.5], [1, '2'], 'all', []]) {
    assert.throws(
      () => importOperations(JSON.stringify([{ kind: 'keepCases', traces }])),
      /invalid fields/,
      `accepted ${JSON.stringify(traces)}`
    );
  }
});
