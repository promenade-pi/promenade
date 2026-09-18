import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildInteractionCohortArtifact, INTERACTION_COHORT_INLINE_LIMIT, isLassoInteractionSelection, requireInteractionCohort,
} from '../../src/host/artifact/interaction-cohort.ts';

const payload = {
  schemaVersion: 1 as const,
  sourceArtifactId: 'a_ocel',
  selection: {
    coordinateSystem: 'lifecycle-phase-v1' as const,
    pair: { a: 'Order', b: 'Item' },
    phaseBounds: { minA: 0.25, maxA: 0.5, minB: 0, maxB: 0.5 },
    filters: { activities: ['pack'], lifecycleBounds: 'fixed', weighting: 'equal-event-mass' },
  },
  members: { eventIds: ['e_1', 'e_2'], objectIds: ['o_1', 'o_2'], observationCount: 3 },
};

const source = {
  id: 'a_ocel', name: 'Orders', type: 'ObjectCentricEventLog' as const, createdAt: '2026-01-01T00:00:00Z',
  storage: { kind: 'parquet' as const, files: {} }, meta: {}, producedBy: null, inputs: [],
};

test('builds a source-bound interaction cohort with analytical provenance', () => {
  const { artifact, execution } = buildInteractionCohortArtifact({
    source, payload, provider: 'run.promenade.interaction-atlas',
  });
  assert.equal(artifact.type, 'ObjectCentricInteractionCohort');
  assert.deepEqual(artifact.inputs, ['a_ocel']);
  assert.equal((artifact.meta as any).observationCount, 3);
  assert.equal(execution.actionId, 'run.promenade.interaction-atlas.publishInteractionCohort');
  assert.deepEqual(execution.params, { selection: payload.selection, schemaVersion: 1 });
});

test('rejects inconsistent cohort source, bounds, and duplicate membership', () => {
  assert.throws(() => requireInteractionCohort({ ...payload, sourceArtifactId: 'other' }, 'a_ocel'), /sourceArtifactId/);
  assert.throws(() => requireInteractionCohort({ ...payload, selection: { ...payload.selection, phaseBounds: { minA: .7, maxA: .3, minB: 0, maxB: 1 } } }), /invalid analytical selection/);
  assert.throws(() => requireInteractionCohort({ ...payload, members: { ...payload.members, eventIds: ['e_1', 'e_1'] } }), /identifiers must be unique/);
});

test('accepts an exact lasso bin mask and rejects malformed masks', () => {
  const lasso = {
    ...payload,
    selection: { ...payload.selection, phaseBounds: null, binMask: { binCount: 8, bins: [0, 9, 63] } },
  };
  assert.deepEqual(requireInteractionCohort(lasso, 'a_ocel').selection.binMask, { binCount: 8, bins: [0, 9, 63] });
  assert.throws(() => requireInteractionCohort({
    ...lasso, selection: { ...lasso.selection, binMask: { binCount: 8, bins: [0, 64] } },
  }, 'a_ocel'), /invalid analytical selection/);
  assert.equal(isLassoInteractionSelection(lasso, 'a_ocel'), true);
  assert.equal(isLassoInteractionSelection(payload, 'a_ocel'), false);
  assert.equal(isLassoInteractionSelection(lasso, 'another_ocel'), false);
});

test('materializes a cohort membership larger than the catalogue inline limit', () => {
  const eventIds = Array.from({ length: 9_000 }, (_, i) => `e_${i}_${'x'.repeat(1024)}`);
  const { artifact } = buildInteractionCohortArtifact({
    source, payload: { ...payload, members: { ...payload.members, eventIds, observationCount: eventIds.length } },
    provider: 'run.promenade.interaction-atlas',
  });
  assert.ok(INTERACTION_COHORT_INLINE_LIMIT < JSON.stringify((artifact.meta as any).selection).length + eventIds.join('').length);
  assert.equal(artifact.storage.kind, 'json');
  assert.equal((artifact.meta as any).materialized, true);
});
