import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRegistry } from '../../src/host/actions/registry.ts';
import type { Artifact } from '../../src/host/artifact/types.ts';

function ocpn(id: string): Artifact {
  return {
    id, name: id, type: 'ObjectCentricPetriNet', createdAt: '2026-08-19T00:00:00Z',
    storage: { kind: 'inline', value: {} }, meta: {}, producedBy: null, inputs: [],
  };
}

test('two same-typed required slots need two selected artifacts', () => {
  const registry = new ActionRegistry();
  registry.register({
    id: 'test.compare', label: 'Compare OCPNs', version: '1', provider: 'test',
    trusted: true, runtime: 'pyodide', implemented: true,
    inputs: [
      { name: 'baseline', type: 'ObjectCentricPetriNet', required: true, label: 'a baseline OCPN' },
      { name: 'candidate', type: 'ObjectCentricPetriNet', required: true, label: 'a candidate OCPN' },
    ],
    outputs: [{ name: 'comparison', type: 'OcpnComparison' }],
    params: { type: 'object', properties: {} },
    run: async () => ({ inline: { value: {} } }),
  });

  const one = registry.applicableTo([ocpn('a')])[0];
  assert.equal(one.applicable, false);
  assert.deepEqual(one.missing.map((slot) => slot.name), ['candidate']);

  const two = registry.applicableTo([ocpn('a'), ocpn('b')])[0];
  assert.equal(two.applicable, true);
  assert.deepEqual(two.missing, []);
});
