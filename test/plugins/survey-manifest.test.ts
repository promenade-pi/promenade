import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(new URL('../../../plugins/survey/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set(['manifest.json', 'plugin.js', 'README.md', 'CHANGELOG.md']);

test('the survey manifest validates, declaring both new capabilities', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);

  const byId = Object.fromEntries(manifest.views.map((v: any) => [v.id, v]));
  assert.equal(byId['run.promenade.survey.run'].readsWorkspace, true);
  assert.deepEqual(byId['run.promenade.survey.run'].publishes, ['SurveyResponse']);
  assert.deepEqual(byId['run.promenade.survey.edit'].publishes, ['Survey']);
  // The authoring surface is standalone *and* reads the workspace — that pair
  // is the whole "capture the panel I just arranged" feature, so it must stay
  // legal.
  assert.equal(byId['run.promenade.survey.new'].standalone, true);
  assert.equal(byId['run.promenade.survey.new'].readsWorkspace, true);
});

test('the runner is first, so opening a Survey runs it — but it is not primary', () => {
  // `forType` orders by registration, so first-in-manifest is what opening the
  // artifact lands on. `primary` would do that too *and* make the view
  // unpersistable (`hasPersistableViewState`), which would take away the
  // saved-view slot the in-progress run is stored in.
  assert.equal(manifest.views[0].id, 'run.promenade.survey.run');
  for (const v of manifest.views) assert.notEqual(v.primary, true);
});

test('both artifact types declare a family, so the tree can tell them apart', () => {
  // Without it every plugin-contributed type falls back to the same green
  // "result" — a questionnaire and its responses would be indistinguishable.
  const families = Object.fromEntries(manifest.artifactTypes.map((t: any) => [t.id, t.family]));
  assert.deepEqual(families, { Survey: 'model', SurveyResponse: 'result' });
});

test('a package may publish its own declared types and nothing else', () => {
  const forged = structuredClone(manifest);
  forged.views[0].publishes = ['ProcessTree'];
  assert.match(
    validateManifest(forged, files).errors.join(' '),
    /cannot publish "ProcessTree"/,
  );

  // Removing the type declaration removes the entitlement with it: the rule is
  // "your own types", not "any type you name twice".
  const undeclared = structuredClone(manifest);
  undeclared.artifactTypes = undeclared.artifactTypes.filter((t: any) => t.id !== 'SurveyResponse');
  assert.match(
    validateManifest(undeclared, files).errors.join(' '),
    /cannot publish "SurveyResponse"/,
  );
});

test('readsWorkspace needs a sandboxed renderer to read into', () => {
  const native = structuredClone(manifest);
  native.views[0] = {
    id: 'run.promenade.survey.run', label: 'x',
    readsWorkspace: true, kind: 'native', native: 'core.ocpnView',
  };
  assert.match(validateManifest(native, files).errors.join(' '), /readsWorkspace needs a sandboxed entry/);
});

test('an unknown artifact-type family is refused rather than silently green', () => {
  const odd = structuredClone(manifest);
  odd.artifactTypes[0].family = 'questionnaire';
  assert.match(validateManifest(odd, files).errors.join(' '), /unknown family "questionnaire"/);
});

test('a view that declares neither capability still validates', () => {
  // Both are opt-in; their absence must never be an error, or every existing
  // view plugin would stop installing.
  const plain = structuredClone(manifest);
  for (const v of plain.views) { delete v.readsWorkspace; delete v.publishes; }
  assert.deepEqual(validateManifest(plain, files).errors, []);
});
