import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/raw-artifact-viewer/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.js', 'README.md', 'CHANGELOG.md']);

test('raw-artifact-viewer manifest validates as a file-reading view', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);

  const view = manifest.views[0];
  assert.equal(view.readsFiles, true);
  assert.equal(view.entry, 'plugin.js');
  // No `appliesTo`: a storage inspector applies to every artifact, and the
  // registry treats an unrestricted view exactly that way (ordered after the
  // type-specific ones, so it never wins a default-view pick by accident).
  assert.equal(view.appliesTo, undefined);
  assert.equal(view.standalone, undefined);
  // Read-only by construction: nothing here declares a write door.
  assert.equal(view.publishes, undefined);
});

test('readsFiles needs a sandboxed renderer to read them into', () => {
  const nativeInstead = structuredClone(manifest);
  nativeInstead.views[0] = {
    id: 'run.promenade.raw-artifact-viewer.files', label: 'x',
    readsFiles: true, kind: 'native', native: 'core.ocpnView',
  };
  assert.match(
    validateManifest(nativeInstead, files).errors.join(' '),
    /readsFiles needs a sandboxed entry/,
  );
});

test('a standalone view has no artifact, so it cannot declare readsFiles', () => {
  const standalone = structuredClone(manifest);
  standalone.views[0].standalone = true;
  assert.match(
    validateManifest(standalone, files).errors.join(' '),
    /cannot declare "readsFiles"/,
  );
});

test('a view that does not declare readsFiles validates unchanged', () => {
  // The declaration is opt-in: the field's absence must not be an error, or
  // every existing view plugin would stop installing.
  const silent = structuredClone(manifest);
  delete silent.views[0].readsFiles;
  const r = validateManifest(silent, files);
  assert.deepEqual(r.errors, []);
});
