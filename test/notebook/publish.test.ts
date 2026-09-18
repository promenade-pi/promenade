import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishedArtifact, type NotebookProvenance } from '../../src/host/notebook/publish.ts';

const provenance: NotebookProvenance = {
  notebookId: 'nb_1',
  notebookTitle: 'Exploratory analysis',
  cellId: 'c_7',
  executionCount: 4,
  kernelLabel: 'Python · Pyodide',
  kernelVersion: '314.0.3',
  packages: { pm4py: '2.7.23.4' },
};

test('publishes a known artifact type with correct provenance shape', () => {
  const { artifact, execution } = buildPublishedArtifact({
    type: 'AcceptingPetriNet',
    name: 'Notebook Petri net',
    payload: { places: [], transitions: [] },
    inputArtifactIds: ['a_log'],
    provenance,
  });

  assert.equal(artifact.type, 'AcceptingPetriNet');
  assert.equal(artifact.name, 'Notebook Petri net');
  assert.equal(artifact.storage.kind, 'inline');
  assert.deepEqual(artifact.inputs, ['a_log']);
  assert.equal(artifact.producedBy, execution.id);

  assert.equal(execution.actionId, 'core.notebook');
  assert.deepEqual(execution.inputs, { source: ['a_log'] });
  assert.deepEqual(execution.outputs, [artifact.id]);
  assert.equal(execution.runtime.kind, 'pyodide');
  assert.equal((execution.params as any).cellId, 'c_7');
  assert.equal((execution.params as any).executionCount, 4);
  assert.deepEqual((execution.params as any).packages, { pm4py: '2.7.23.4' });
});

test('rejects an unregistered artifact type rather than inventing one', () => {
  assert.throws(
    () => buildPublishedArtifact({
      type: 'NotARealType', name: 'x', payload: {}, inputArtifactIds: [], provenance,
    }),
    /Unknown artifact type/,
  );
});

test('rejects an empty name so no half-created artifact results', () => {
  assert.throws(
    () => buildPublishedArtifact({
      type: 'AcceptingPetriNet', name: '   ', payload: {}, inputArtifactIds: [], provenance,
    }),
    /non-empty name/,
  );
});

test('two publishes with the same display name never collide — identity is the minted id', () => {
  const first = buildPublishedArtifact({
    type: 'AcceptingPetriNet', name: 'dup', payload: {}, inputArtifactIds: [], provenance,
  });
  const second = buildPublishedArtifact({
    type: 'AcceptingPetriNet', name: 'dup', payload: {}, inputArtifactIds: [], provenance,
  });
  assert.notEqual(first.artifact.id, second.artifact.id);
  assert.equal(first.artifact.name, second.artifact.name);
});

test('publishing a ProcessTree uses the same contract, not a special case', () => {
  const { artifact } = buildPublishedArtifact({
    type: 'ProcessTree', name: 'Tree', payload: { root: 0, nodes: [] }, inputArtifactIds: ['a_log'], provenance,
  });
  assert.equal(artifact.type, 'ProcessTree');
});
