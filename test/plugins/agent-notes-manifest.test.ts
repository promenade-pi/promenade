import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_TEXT_LIMITS, validateManifest } from '../../src/host/plugins/manifest.ts';

/**
 * A package's agent-facing text: `actions[].description` and `actions[].agent`.
 *
 * The fields are optional, so the first thing worth pinning is that every
 * existing manifest still validates without them. The rest is the caps — this
 * text is written by a package the host does not vet and is forwarded into a
 * caller's context, so an over-long field is refused at install (visible to
 * the author) rather than silently truncated later.
 */

const files = new Set(['manifest.json', 'plugin.py', 'README.md', 'CHANGELOG.md']);

function manifest(action: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'org.test.notes',
    name: 'Notes',
    version: '1.0.0',
    runtime: 'pyodide',
    entry: 'plugin.py',
    pythonDeps: [],
    actions: [{
      id: 'org.test.notes.run',
      label: 'Run',
      inputs: [{ name: 'log', type: 'TraditionalEventLog', required: true, label: 'a log' }],
      outputs: [{ name: 'out', type: 'DFG' }],
      params: { type: 'object', properties: {} },
      ...action,
    }],
  };
}

test('an action with no agent text is still a valid action', () => {
  const r = validateManifest(manifest(), files);
  assert.deepEqual(r.errors, []);
});

test('description and agent notes pass through validation', () => {
  const r = validateManifest(manifest({
    description: 'Counts directly-follows pairs.',
    agent: {
      whenToUse: 'A first look at a log.',
      notFor: 'Conformance checking.',
      examples: ['minFrequency 1 to see everything'],
    },
  }), files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.manifest?.actions?.[0].agent?.whenToUse, 'A first look at a log.');
});

test('an over-long description is refused, with the limit named', () => {
  const r = validateManifest(manifest({
    description: 'x'.repeat(AGENT_TEXT_LIMITS.description + 1),
  }), files);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('"description"') && e.includes(String(AGENT_TEXT_LIMITS.description))));
});

test('caps apply to each agent field and to the number of examples', () => {
  const tooMany = validateManifest(manifest({
    agent: { examples: Array.from({ length: AGENT_TEXT_LIMITS.examples + 1 }, () => 'x') },
  }), files);
  assert.ok(tooMany.errors.some((e) => e.includes('agent.examples')));

  const tooLong = validateManifest(manifest({
    agent: { examples: ['x'.repeat(AGENT_TEXT_LIMITS.example + 1)] },
  }), files);
  assert.ok(tooLong.errors.some((e) => e.includes('agent.examples[0]')));

  const notFor = validateManifest(manifest({
    agent: { notFor: 'x'.repeat(AGENT_TEXT_LIMITS.notFor + 1) },
  }), files);
  assert.ok(notFor.errors.some((e) => e.includes('agent.notFor')));
});

test('wrong shapes are refused rather than ignored', () => {
  assert.ok(validateManifest(manifest({ description: 42 }), files)
    .errors.some((e) => e.includes('"description" must be a string')));
  assert.ok(validateManifest(manifest({ agent: 'be careful' }), files)
    .errors.some((e) => e.includes('"agent" must be an object')));
  assert.ok(validateManifest(manifest({ agent: { examples: 'one' } }), files)
    .errors.some((e) => e.includes('must be an array')));
});

test('a misspelled agent field is an error, not a note that silently vanishes', () => {
  const r = validateManifest(manifest({ agent: { whenToUser: 'oops' } }), files);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unknown "agent" field(s): whenToUser')));
});

test('the shipped Inductive Miner manifest carries agent notes for both actions', () => {
  const path = fileURLToPath(new URL('../../../plugins/inductive-py/manifest.json', import.meta.url));
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const r = validateManifest(m, new Set(['manifest.json', 'plugin.py', 'README.md', 'CHANGELOG.md']));
  assert.deepEqual(r.errors, []);
  for (const a of m.actions) {
    assert.ok(a.description, `${a.id} has a description`);
    assert.ok(a.agent?.whenToUse, `${a.id} says when to use it`);
    assert.ok(a.agent?.notFor, `${a.id} says when not to`);
  }
});
