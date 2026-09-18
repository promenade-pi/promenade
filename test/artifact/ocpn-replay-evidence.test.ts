import assert from 'node:assert/strict';
import test from 'node:test';
import { requireObjectCentricReplayEvidence } from '../../src/host/artifact/ocpn-replay-evidence.ts';

const evidence = {
  schemaVersion: 1 as const, sourceArtifactId: 'a_ocel', modelArtifactId: 'a_ocpn', coordinateSystem: 'lifecycle-phase-v1' as const,
  replay: { engineId: 'run.promenade.ocpn-replay', engineVersion: '1', ordering: 'timestamp-total-order-v1' as const, completed: true as const },
  events: [{ eventId: 'e_1', support: .75, logMoves: 1, modelMoves: 0 }],
  expectedFields: [{ pair: { a: 'Order', b: 'Item' }, binCount: 8, mass: Array(64).fill(0), population: 'replayed-events' as const }],
};

test('accepts source-bound OCPN replay evidence and its optional expected field', () => {
  assert.equal(requireObjectCentricReplayEvidence(evidence, 'a_ocel').modelArtifactId, 'a_ocpn');
});

test('tolerates the animation extras (net, trace, per-event tsMs) added in plugin 0.2.0', () => {
  const withExtras = {
    ...evidence,
    events: [{ ...evidence.events[0], tsMs: 1_700_000_000_000 }],
    net: { objectTypes: ['Order'], places: [], transitions: [], arcs: [] },
    trace: { limit: 3000, truncated: false, objectTypes: ['Order'], frames: [] },
  };
  assert.equal(requireObjectCentricReplayEvidence(withExtras, 'a_ocel').sourceArtifactId, 'a_ocel');
});

test('rejects a foreign source, incomplete replay, duplicate events, and malformed expectations', () => {
  assert.throws(() => requireObjectCentricReplayEvidence({ ...evidence, sourceArtifactId: 'other' }, 'a_ocel'), /sourceArtifactId/);
  assert.throws(() => requireObjectCentricReplayEvidence({ ...evidence, replay: { ...evidence.replay, completed: false } }), /completed/);
  assert.throws(() => requireObjectCentricReplayEvidence({ ...evidence, events: [evidence.events[0], evidence.events[0]] }), /invalid event support/);
  assert.throws(() => requireObjectCentricReplayEvidence({ ...evidence, expectedFields: [{ ...evidence.expectedFields[0], mass: [] }] }), /invalid expected interaction field/);
});
