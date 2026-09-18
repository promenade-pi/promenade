import test from 'node:test';
import assert from 'node:assert/strict';
import { actionDisplayLabels } from '../../src/host/plugins/manifest.ts';

const SHORT: Record<string, string> = {
  TraditionalEventLog: 'XES',
  ObjectCentricEventLog: 'OCEL 2.0',
  AcceptingPetriNet: 'APN',
  ObjectCentricPetriNet: 'OCPN',
};
const shortLabelOf = (type: string) => SHORT[type];

test('actions with distinct labels are left alone', () => {
  const labels = actionDisplayLabels([
    { id: 'a', label: 'Discover DFG', inputs: [{ type: 'TraditionalEventLog' }] },
    { id: 'b', label: 'Discover OC-DFG', inputs: [{ type: 'ObjectCentricEventLog' }] },
  ], shortLabelOf);
  assert.equal(labels.get('a'), 'Discover DFG');
  assert.equal(labels.get('b'), 'Discover OC-DFG');
});

test('a colliding label is qualified by the input type that distinguishes it', () => {
  // The real case: Log Quality offers one capability for both kinds of log.
  const labels = actionDisplayLabels([
    { id: 'xes', label: 'Analyze Log Quality', inputs: [{ type: 'TraditionalEventLog' }] },
    { id: 'ocel', label: 'Analyze Log Quality', inputs: [{ type: 'ObjectCentricEventLog' }] },
  ], shortLabelOf);
  assert.equal(labels.get('xes'), 'Analyze Log Quality (XES)');
  assert.equal(labels.get('ocel'), 'Analyze Log Quality (OCEL 2.0)');
});

test('the output type disambiguates when the inputs are the same', () => {
  const labels = actionDisplayLabels([
    { id: 'a', label: 'Discover', inputs: [{ type: 'ObjectCentricEventLog' }], outputs: [{ type: 'ObjectCentricPetriNet' }] },
    { id: 'b', label: 'Discover', inputs: [{ type: 'ObjectCentricEventLog' }], outputs: [{ type: 'AcceptingPetriNet' }] },
  ], shortLabelOf);
  assert.equal(labels.get('a'), 'Discover (OCPN)');
  assert.equal(labels.get('b'), 'Discover (APN)');
});

test('nothing is invented when no type tells the actions apart', () => {
  // A repeated label is better than a suffix that means nothing.
  const labels = actionDisplayLabels([
    { id: 'a', label: 'Run', inputs: [{ type: 'TraditionalEventLog' }] },
    { id: 'b', label: 'Run', inputs: [{ type: 'TraditionalEventLog' }] },
  ], shortLabelOf);
  assert.equal(labels.get('a'), 'Run');
  assert.equal(labels.get('b'), 'Run');
});

test('an unregistered type does not produce an empty qualifier', () => {
  const labels = actionDisplayLabels([
    { id: 'a', label: 'Run', inputs: [{ type: 'TraditionalEventLog' }] },
    { id: 'b', label: 'Run', inputs: [{ type: 'SomethingUnknown' }] },
  ], shortLabelOf);
  assert.equal(labels.get('a'), 'Run');
  assert.equal(labels.get('b'), 'Run');
});

test('three colliding labels are all qualified', () => {
  const labels = actionDisplayLabels([
    { id: 'a', label: 'Export', inputs: [{ type: 'TraditionalEventLog' }] },
    { id: 'b', label: 'Export', inputs: [{ type: 'ObjectCentricEventLog' }] },
    { id: 'c', label: 'Export', inputs: [{ type: 'AcceptingPetriNet' }] },
  ], shortLabelOf);
  assert.deepEqual(
    ['a', 'b', 'c'].map((id) => labels.get(id)),
    ['Export (XES)', 'Export (OCEL 2.0)', 'Export (APN)']
  );
});
