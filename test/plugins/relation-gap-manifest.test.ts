import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateManifest, runtimeOf, runtimeLabel } from '../../src/host/plugins/manifest.ts';

const manifestPath = fileURLToPath(
  new URL('../../../plugins/relation-gap/manifest.json', import.meta.url),
);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The files the packaged .pmplugin contains (see package.sh).
const files = new Set([
  'manifest.json', 'ablate.sql', 'plugin.py', 'README.md', 'CHANGELOG.md', 'view/plugin.js',
  'promenade_relation_gap.js', 'promenade_relation_gap_bg.wasm',
]);

test('relation-gap manifest validates', () => {
  const r = validateManifest(manifest, files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('one package carries three runtimes', () => {
  // The whole packaging argument rests on this: no package-wide runtime, each
  // action declaring its own, plus a view. If a future edit collapses them
  // into one runtime the package silently stops being the thing it documents.
  assert.equal(manifest.runtime, undefined);
  const simulate = manifest.actions.find((a: any) => a.id.endsWith('.simulate'));
  const reconstruct = manifest.actions.find((a: any) => a.id.endsWith('.reconstruct'));
  assert.equal(runtimeOf(manifest, simulate), 'relational');
  assert.equal(runtimeOf(manifest, reconstruct), 'pyodide');
  const gnn = manifest.actions.find((a: any) => a.id.endsWith('.reconstruct-gnn'));
  const graph = manifest.actions.find((a: any) => a.id.endsWith('.graph'));
  assert.equal(runtimeOf(manifest, gnn), 'wasm');
  assert.equal(runtimeOf(manifest, graph), 'pyodide');
  assert.equal(runtimeLabel(manifest), 'relational + pyodide + wasm');
  assert.equal(manifest.views.length, 1);
  assert.equal(manifest.views[0].kind, 'sandboxed');
});

test('the GNN arm reaches its data through a hidden pyodide stage', () => {
  // The wasm scan ABI only ever streams trace-shaped rows, so a kernel that
  // needs a heterogeneous graph gets it as one JSON payload instead — which is
  // what `value-finalize/1` means, and why `scans` has to name a stage that
  // reads *both* logs. The stage is `internal`, so the graph it builds does
  // not appear in the artifact tree as something the user has to run.
  const gnn = manifest.actions.find((a: any) => a.id.endsWith('.reconstruct-gnn'));
  const graph = manifest.actions.find((a: any) => a.id.endsWith('.graph'));
  assert.equal(gnn.kernel.abi, 'value-finalize/1');
  assert.equal(gnn.scans, 'RelationGapGraph');
  assert.equal(gnn.scanAction, graph.id);
  assert.equal(graph.internal, true);
  assert.deepEqual(graph.outputs, [{ name: 'graph', type: 'RelationGapGraph' }]);
  assert.deepEqual(graph.inputs.map((i: any) => i.name), ['partial', 'truth']);
  assert.deepEqual(gnn.inputs.map((i: any) => i.name), ['partial', 'truth']);
});

test('both reconstruction arms emit the one type the view renders', () => {
  const arms = manifest.actions.filter((a: any) => a.id.includes('reconstruct'));
  assert.equal(arms.length, 2);
  for (const arm of arms) {
    assert.equal(arm.outputs[0].type, 'RelationGapEvaluation');
  }
  assert.deepEqual(manifest.views[0].appliesTo, ['RelationGapEvaluation']);
});

test('the simulator produces a log, not a result', () => {
  // A relational action can only be persisted through `persistLog`, which
  // needs an output type carrying a logical schema. An output type that is
  // not log-shaped fails at run time, not at install time.
  const simulate = manifest.actions.find((a: any) => a.id.endsWith('.simulate'));
  assert.deepEqual(simulate.outputs, [{ name: 'gapped', type: 'ObjectCentricEventLog' }]);
  assert.equal(simulate.queryFile, 'ablate.sql');
});

test('reconstruction binds the gapped log first and the reference second', () => {
  // Slot order is what the user is asked for first, and the gapped log is the
  // one they actually hold. It is also what `{partial__e2o}` / `{truth__e2o}`
  // resolve against in plugin.py — renaming a slot here silently breaks the
  // SQL there, which is why the names are asserted rather than the count.
  const reconstruct = manifest.actions.find((a: any) => a.id.endsWith('.reconstruct'));
  assert.deepEqual(reconstruct.inputs.map((i: any) => i.name), ['partial', 'truth']);
  assert.ok(reconstruct.inputs.every(
    (i: any) => i.type === 'ObjectCentricEventLog' && i.required && i.requires.includes('objects'),
  ));
  assert.deepEqual(reconstruct.outputs, [{ name: 'evaluation', type: 'RelationGapEvaluation' }]);
  assert.deepEqual(manifest.pythonDeps, ['pandas']);
});

test('the view renders the type this package declares', () => {
  const declared = manifest.artifactTypes.map((t: any) => t.id);
  assert.deepEqual(declared, ['RelationGapEvaluation', 'RelationGapGraph']);
  assert.deepEqual(manifest.views[0].appliesTo, ['RelationGapEvaluation']);
});
