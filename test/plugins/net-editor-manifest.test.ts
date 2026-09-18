import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';
import { HOST_VALIDATED_TYPES } from '../../src/host/artifact/publish-artifact.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/net-editor/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.js', 'README.md', 'CHANGELOG.md']);

test('the net editor installs, publishing two core types it does not own', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);

  const view = manifest.views[0];
  assert.equal(view.standalone, true);
  assert.deepEqual(view.publishes, ['AcceptingPetriNet', 'ObjectCentricPetriNet']);
  // The reason it may: both are types the host checks structurally itself.
  // This is the assertion that keeps the install gate and the publish gate
  // from drifting apart — the failure mode is a plugin that installs and then
  // cannot publish, which nothing else would catch.
  for (const type of view.publishes) {
    assert.ok(type in HOST_VALIDATED_TYPES, `${type} must be host-validated to be publishable`);
  }
  assert.equal((manifest.artifactTypes ?? []).length, 0, 'it declares no type of its own');
});

test('naming a core type the host cannot check is still refused', () => {
  const forged = structuredClone(manifest);
  forged.views[0].publishes = ['ProcessTree'];
  assert.match(
    validateManifest(forged, files).errors.join(' '),
    /cannot publish "ProcessTree"/,
  );
});
