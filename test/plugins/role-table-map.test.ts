import assert from 'node:assert/strict';
import test from 'node:test';
import { roleTableMap } from '../../src/host/plugins/roleTables.ts';

const twoOcelInputs = {
  inputs: [
    { name: 'baseline', type: 'ObjectCentricEventLog', required: true, label: 'a baseline log' },
    { name: 'candidate', type: 'ObjectCentricEventLog', required: true, label: 'a candidate log' },
  ],
} as any;

const catalog = {
  artifacts: {
    a_base: { storage: { kind: 'parquet', files: { event: 'x', object: 'x', e2o: 'x', o2o: 'x' } } },
    a_cand: { storage: { kind: 'parquet', files: { event: 'x', object: 'x', e2o: 'x' } } },
  },
} as any;

test('secondary input gets namespaced placeholders', () => {
  const map = roleTableMap(twoOcelInputs, { baseline: ['a_base'], candidate: ['a_cand'] }, catalog);
  assert.equal(map['candidate__event'], 'a_cand__event');
  assert.equal(map['candidate__e2o'], 'a_cand__e2o');
  assert.equal(map['baseline__o2o'], 'a_base__o2o');
});

test('primary input keeps its bare logical names for backwards compatibility', () => {
  const map = roleTableMap(twoOcelInputs, { baseline: ['a_base'], candidate: ['a_cand'] }, catalog);
  assert.equal(map['event'], 'a_base__event');
  assert.equal(map['o2o'], 'a_base__o2o');
  // The secondary input never claims a bare name.
  assert.equal(map['event'], 'a_base__event');
  assert.ok(!('candidate' in map));
});

test('a missing or unbound input is skipped, not thrown on', () => {
  const map = roleTableMap(twoOcelInputs, { baseline: ['a_base'] }, catalog);
  assert.equal(map['event'], 'a_base__event');
  assert.ok(!Object.keys(map).some((k) => k.startsWith('candidate__')));
});

test('single-input action is unchanged — bare names only, no stray namespaced keys for absent slots', () => {
  const oneInput = { inputs: [{ name: 'log', type: 'ObjectCentricEventLog', required: true, label: 'a log' }] } as any;
  const map = roleTableMap(oneInput, { log: ['a_base'] }, catalog);
  assert.deepEqual(
    Object.keys(map).sort(),
    ['event', 'log__event', 'object', 'log__object', 'e2o', 'log__e2o', 'o2o', 'log__o2o'].sort(),
  );
});
