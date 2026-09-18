import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionPartitionArtifact, EXECUTION_PARTITION_INLINE_LIMIT, requireExecutionPartition,
} from '../../src/host/artifact/execution-partition.ts';

const payload = {
  schemaVersion: 1 as const,
  sourceArtifactId: 'a_ocel',
  extraction: { method: 'leadingType' as const, leadingType: 'Order', scopeSharedObjects: true, maxEvents: 300 },
  executions: [{
    id: 'case_1', objectIds: ['o_1'], eventIds: ['e_1', 'e_2'], variantId: 'variant_1',
    truncated: false, startMs: 10, endMs: 20,
  }],
  variants: [{ id: 'variant_1', executionIds: ['case_1'] }],
};

test('builds a source-bound OCEL execution partition with provenance', () => {
  const { artifact, execution } = buildExecutionPartitionArtifact({
    source: {
      id: 'a_ocel', name: 'Orders', type: 'ObjectCentricEventLog', createdAt: '2026-01-01T00:00:00Z',
      storage: { kind: 'parquet', files: {} }, meta: {}, producedBy: null, inputs: [],
    }, payload, provider: 'run.promenade.ocel-cases-variants',
  });
  assert.equal(artifact.type, 'ObjectCentricExecutionPartition');
  assert.deepEqual(artifact.inputs, ['a_ocel']);
  assert.equal(execution.actionId, 'run.promenade.ocel-cases-variants.publishExecutionPartition');
  assert.deepEqual(execution.inputs, { source: ['a_ocel'] });
});

test('rejects a partition whose declared source or variant membership is inconsistent', () => {
  assert.throws(() => requireExecutionPartition({ ...payload, sourceArtifactId: 'other' }, 'a_ocel'), /sourceArtifactId/);
  assert.throws(() => requireExecutionPartition({ ...payload, variants: [{ id: 'variant_1', executionIds: ['missing'] }] }), /invalid variant/);
});

test('materializes a partition larger than the catalogue inline limit', () => {
  const eventIds = Array.from({ length: 9_000 }, (_, i) => `e_${i}_${'x'.repeat(1024)}`);
  const large = { ...payload, executions: [{ ...payload.executions[0], eventIds }], variants: [{ id: 'variant_1', executionIds: ['case_1'] }] };
  const { artifact } = buildExecutionPartitionArtifact({
    source: {
      id: 'a_ocel', name: 'Orders', type: 'ObjectCentricEventLog', createdAt: '2026-01-01T00:00:00Z',
      storage: { kind: 'parquet', files: {} }, meta: {}, producedBy: null, inputs: [],
    }, payload: large, provider: 'run.promenade.ocel-cases-variants',
  });
  assert.ok(EXECUTION_PARTITION_INLINE_LIMIT < eventIds.join('').length);
  assert.equal(artifact.storage.kind, 'json');
  assert.equal((artifact.meta as any).materialized, true);
});
