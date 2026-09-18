import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/ocel-builder/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.js', 'README.md', 'CHANGELOG.md']);

test('ocel-builder manifest validates as a standalone publishing view', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);

  const view = manifest.views[0];
  assert.equal(view.standalone, true);
  assert.equal(view.entry, 'plugin.js');
  assert.deepEqual(view.publishes, ['ObjectCentricEventLog']);
  // An authoring panel has no artifact, so it declares no type it applies to.
  assert.equal(view.appliesTo, undefined);
});

test('a standalone view must ship a sandboxed renderer and claim no artifact type', () => {
  const nativeInstead = structuredClone(manifest);
  nativeInstead.views[0] = {
    id: 'run.promenade.ocel-builder.editor', label: 'x', standalone: true,
    kind: 'native', native: 'core.ocpnView',
  };
  assert.match(
    validateManifest(nativeInstead, files).errors.join(' '),
    /standalone view needs a sandboxed entry/,
  );

  const alsoAppliesTo = structuredClone(manifest);
  alsoAppliesTo.views[0].appliesTo = ['ObjectCentricEventLog'];
  assert.match(
    validateManifest(alsoAppliesTo, files).errors.join(' '),
    /cannot declare "appliesTo"/,
  );
});

test('only host-materializable log types may be published', () => {
  const bogus = structuredClone(manifest);
  // Not the two net types: those are the narrow exception the host validates
  // structurally on every publish, so naming one is not the forgery this rule
  // is about. A type nobody can check is.
  bogus.views[0].publishes = ['ProcessTree'];
  assert.match(
    validateManifest(bogus, files).errors.join(' '),
    /cannot publish "ProcessTree"/,
  );
});
