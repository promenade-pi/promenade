import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/ocpn-replay/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.py', 'view.js', 'README.md', 'docs/semantics.md']);

test('ocpn-replay manifest validates with a stdlib-only (empty) pythonDeps closure', () => {
  assert.deepEqual(manifest.pythonDeps, []);
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('the replay action exposes a traceLimit param for the animation trace', () => {
  const action = manifest.actions.find((a: any) => a.id === 'run.promenade.ocpn-replay.replay');
  const trace = action.params.properties.traceLimit;
  assert.equal(trace.type, 'integer');
  assert.equal(trace.default, 3000);
  assert.equal(trace.minimum, 0);
});

test('ships a primary live-preview view for the replay evidence', () => {
  const view = manifest.views.find((v: any) => v.appliesTo?.includes('ObjectCentricReplayEvidence'));
  assert.ok(view);
  assert.equal(view.entry, 'view.js');
  assert.equal(view.primary, true);
  assert.equal(view.livePreview, true);
});

test('a pyodide manifest that omits pythonDeps entirely is still rejected', () => {
  const { pythonDeps, ...withoutDeps } = manifest;
  const r = validateManifest(withoutDeps, files);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('pythonDeps')));
});
