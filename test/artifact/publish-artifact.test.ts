import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishedArtifact, HOST_VALIDATED_TYPES, PUBLISH_ARTIFACT_INLINE_LIMIT } from '../../src/host/artifact/publish-artifact.ts';
import type { ProvenanceGraph } from '../../src/host/artifact/types.ts';

/**
 * The third publish door, and the first one where the host has no opinion
 * about the payload. What it validates instead is the envelope — which is
 * exactly the part a plugin could otherwise get wrong in ways that corrupt
 * the catalog rather than merely its own view.
 */

const graph = {
  artifacts: {
    a_log: { id: 'a_log', name: 'Logistics', type: 'ObjectCentricEventLog' },
    a_survey: { id: 'a_survey', name: 'Study', type: 'Survey' },
  },
  executions: {},
} as unknown as ProvenanceGraph;

const base = {
  provider: 'run.promenade.survey',
  graph,
  ownTypes: (t: string) => t === 'Survey' || t === 'SurveyResponse',
};

test('a package may publish a type it declares', () => {
  const built = buildPublishedArtifact({
    ...base,
    request: { type: 'Survey', name: 'Metro map vs DFG', value: { schemaVersion: 1 } },
  });
  assert.equal(built.artifact.type, 'Survey');
  assert.equal(built.artifact.name, 'Metro map vs DFG');
  assert.equal(built.artifact.storage.kind, 'inline');
  // No inputs means a root, exactly like an import: nothing was derived, so
  // there is no execution to record.
  assert.equal(built.execution, null);
  assert.equal(built.artifact.producedBy, null);
  assert.deepEqual(built.artifact.inputs, []);
  assert.equal(built.artifact.meta.publishedBy, 'run.promenade.survey');
});

test('a package may not publish somebody else’s type', () => {
  // The whole point of the rule: without it, any manifest could declare
  // `publishes: ["ProcessTree"]` and put a forged model in the catalog. The
  // types here are the ones the host has no way to check — its opinion about
  // them is exactly "not yours".
  for (const type of ['ProcessTree', 'ObjectCentricEventLog', 'DFG']) {
    assert.throws(
      () => buildPublishedArtifact({ ...base, request: { type, name: 'x', value: {} } }),
      /does not define the artifact type/,
      `expected ${type} to be refused`
    );
  }
});

test('a core type the host can validate is open to any package — as data, not as a name', () => {
  // The exception exists for an editor: its purpose is to author a core type,
  // and it can never own one. What keeps it from being a hole is that the
  // payload is checked on the way through, so the forgery the ownership rule
  // guarded against is refused on its own terms.
  for (const type of Object.keys(HOST_VALIDATED_TYPES)) {
    assert.throws(
      () => buildPublishedArtifact({ ...base, request: { type, name: 'x', value: { nope: 1 } } }),
      /is not a valid/,
      `expected a bogus ${type} payload to be refused`
    );
  }

  const net = {
    labels: ['a', null], places: [{ id: 'p0', inputs: [], outputs: [0] }, { id: 'p1', inputs: [0], outputs: [] }],
    place_to_transition: [[0, 0]], transition_to_place: [[0, 1]],
    initial_marking: [0], final_marking: [1],
  };
  const built = buildPublishedArtifact({
    ...base, request: { type: 'AcceptingPetriNet', name: 'Drawn by hand', value: net },
  });
  assert.equal(built.artifact.type, 'AcceptingPetriNet');
  assert.equal(built.artifact.meta.publishedBy, 'run.promenade.survey');
});

test('inputs become provenance, and are checked against the catalog first', () => {
  const built = buildPublishedArtifact({
    ...base,
    request: {
      type: 'SurveyResponse', name: 'P01', value: { answers: [] },
      inputs: ['a_survey', 'a_log'],
    },
  });
  assert.deepEqual(built.artifact.inputs, ['a_survey', 'a_log']);
  assert.equal(built.artifact.producedBy, built.execution!.id);
  assert.deepEqual(built.execution!.inputs, { source: ['a_survey', 'a_log'] });
  assert.deepEqual(built.execution!.outputs, [built.artifact.id]);
});

test('an input that does not exist is refused rather than left dangling in the DAG', () => {
  assert.throws(
    () => buildPublishedArtifact({
      ...base,
      request: { type: 'SurveyResponse', name: 'P01', value: {}, inputs: ['a_survey', 'a_ghost'] },
    }),
    /No artifact with id "a_ghost"/,
  );
});

test('a repeated input is refused', () => {
  assert.throws(
    () => buildPublishedArtifact({
      ...base,
      request: { type: 'Survey', name: 'x', value: {}, inputs: ['a_log', 'a_log'] },
    }),
    /same input twice/,
  );
});

test('the envelope is required: type, name and value', () => {
  assert.throws(() => buildPublishedArtifact({ ...base, request: { name: 'x', value: {} } }), /needs a type/);
  assert.throws(() => buildPublishedArtifact({ ...base, request: { type: 'Survey', value: {} } }), /needs a name/);
  assert.throws(() => buildPublishedArtifact({ ...base, request: { type: 'Survey', name: '  ' } }), /needs a name/);
  assert.throws(() => buildPublishedArtifact({ ...base, request: { type: 'Survey', name: 'x' } }), /needs a value/);
});

test('a value that survives structured clone but not storage is caught here', () => {
  // A cycle crosses the frame boundary intact and dies at the storage layer.
  // Better to refuse it before anything is written than half-way through.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => buildPublishedArtifact({ ...base, request: { type: 'Survey', name: 'x', value: cyclic } }),
    /not JSON-serialisable/,
  );
});

test('a payload past the ceiling is refused, and a large one is materialized rather than inlined', () => {
  const big = { blob: 'x'.repeat(PUBLISH_ARTIFACT_INLINE_LIMIT + 1) };
  const built = buildPublishedArtifact({ ...base, request: { type: 'Survey', name: 'x', value: big } });
  assert.equal(built.materialize, true);
  assert.equal(built.artifact.storage.kind, 'json');

  const huge = { blob: 'x'.repeat(9 * 1024 * 1024) };
  assert.throws(
    () => buildPublishedArtifact({ ...base, request: { type: 'Survey', name: 'x', value: huge } }),
    /the limit is/,
  );
});

test('a small payload stays inline, so opening it costs no file read', () => {
  const built = buildPublishedArtifact({
    ...base, request: { type: 'Survey', name: 'x', value: { steps: [] } },
  });
  assert.equal(built.materialize, false);
  assert.deepEqual((built.artifact.storage as { value: unknown }).value, { steps: [] });
});
