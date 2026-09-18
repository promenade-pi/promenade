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
