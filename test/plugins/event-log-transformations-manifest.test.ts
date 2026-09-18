import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/event-log-transformations/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.py', 'view.js', 'README.md', 'CHANGELOG.md']);

test('event-log-transformations manifest validates', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('the compare action declares two required OCEL inputs', () => {
  const action = manifest.actions.find((a: any) => a.id === 'run.promenade.event-log-transformations.compare');
  assert.ok(action);
  assert.equal(action.inputs.length, 2);
  assert.deepEqual(action.inputs.map((i: any) => i.name), ['baseline', 'candidate']);
  assert.ok(action.inputs.every((i: any) => i.type === 'ObjectCentricEventLog' && i.required));
});
