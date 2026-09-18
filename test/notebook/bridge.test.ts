import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactSummaryOf } from '../../src/host/notebook/bridge.ts';
import type { Artifact } from '../../src/host/artifact/types.ts';

test('artifactSummaryOf strips an artifact down to metadata-listing fields only', () => {
  const a: Artifact = {
    id: 'a_1', name: 'log.xes', type: 'TraditionalEventLog', createdAt: '2024-01-01T00:00:00Z',
    storage: { kind: 'inline', value: { secret: 'do-not-leak' } },
    meta: { events: 100 }, producedBy: null, inputs: [],
  };
  const summary = artifactSummaryOf(a);
  assert.deepEqual(summary, { id: 'a_1', name: 'log.xes', type: 'TraditionalEventLog', createdAt: '2024-01-01T00:00:00Z' });
  assert.ok(!('storage' in summary));
  assert.ok(!('meta' in summary));
});
