import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../../src/host/plugins/manifest.ts';

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'org.example.dfg-sql',
    name: 'DFG (SQL)',
    version: '0.1.0',
    runtime: 'relational',
    apiVersion: '1',
    actions: [{
      id: 'org.example.dfg-sql.discover',
      label: 'Discover DFG (SQL)',
      inputs: [{ name: 'log', type: 'TraditionalEventLog', required: true, label: 'a log' }],
      outputs: [{ name: 'edges', type: 'DFG' }],
      params: { type: 'object', properties: {} },
      query: `
-- @output edges
SELECT activity FROM {log.events}
`,
    }],
    ...overrides,
  };
}

test('accepts a well-formed relational manifest', () => {
  const r = validateManifest(baseManifest(), new Set());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('rejects a relational manifest with no apiVersion', () => {
  const r = validateManifest(baseManifest({ apiVersion: undefined }), new Set());
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /unsupported apiVersion/.test(e)));
});

test('rejects a relational manifest with a manifest-level entry (not used by this runtime)', () => {
  const r = validateManifest(baseManifest({ entry: 'plugin.js' }), new Set());
  assert.ok(r.errors.some((e) => /manifest-level entry is not used/.test(e)));
});

test('rejects an action with neither query nor queryFile', () => {
  const m = baseManifest();
  (m.actions[0] as any).query = undefined;
  const r = validateManifest(m, new Set());
  assert.ok(r.errors.some((e) => /needs "query" or "queryFile"/.test(e)));
});

test('rejects an action declaring both query and queryFile', () => {
  const m = baseManifest();
  (m.actions[0] as any).queryFile = 'query.sql';
  const r = validateManifest(m, new Set());
  assert.ok(r.errors.some((e) => /either "query" or "queryFile", not both/.test(e)));
});

test('accepts queryFile when present in the package', () => {
  const m = baseManifest();
  (m.actions[0] as any).query = undefined;
  (m.actions[0] as any).queryFile = 'query.sql';
  const r = validateManifest(m, new Set(['query.sql']));
  assert.deepEqual(r.errors, []);
});

test('rejects queryFile missing from the package', () => {
  const m = baseManifest();
  (m.actions[0] as any).query = undefined;
  (m.actions[0] as any).queryFile = 'query.sql';
  const r = validateManifest(m, new Set());
  assert.ok(r.errors.some((e) => /queryFile not in package/.test(e)));
});

test('rejects an inline query that fails SQL Profile v1 validation', () => {
  const m = baseManifest();
  m.actions[0].query = `
-- @output edges
SELECT * FROM read_parquet('/opfs/artifacts/x/events.parquet')
`;
  const r = validateManifest(m, new Set());
  assert.ok(r.errors.some((e) => /forbidden function: read_parquet/.test(e)));
});

test('a manifest artifact output need not share its name with any single program @output — several relations may feed one artifact', () => {
  const m = baseManifest();
  m.actions[0].outputs = [{ name: 'dfg', type: 'DFG' }]; // not "edges" — the program's own @output name
  m.actions[0].query = `
-- @output activities
SELECT activity, COUNT(*) AS n FROM {log.events} GROUP BY 1

-- @output edges
SELECT activity FROM {log.events}
`;
  const r = validateManifest(m, new Set());
  assert.deepEqual(r.errors, []);
});

test('rejects a query referencing an input relation the declared input type does not have', () => {
  const m = baseManifest();
  m.actions[0].query = `
-- @output edges
SELECT * FROM {log.objects}
`;
  const r = validateManifest(m, new Set());
  // TraditionalEventLog has no "objects" relation — that's an OCEL-only name.
  assert.ok(r.errors.some((e) => /"{log.objects}" is not a declared input relation/.test(e)));
});

/**
 * An action with no inputs is nearly always a forgotten `inputs`, and
 * occasionally a generator — something that makes an artifact out of nothing,
 * with only its own parameters. The two are indistinguishable from the
 * outside, so the generator declares itself.
 */
function generatorManifest(action: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    id: 'org.example.generator',
    name: 'Generator',
    version: '0.1.0',
    runtime: 'wasm',
    entry: 'gen.js',
    wasm: 'gen_bg.wasm',
    actions: [{
      id: 'org.example.generator.make',
      label: 'Generate a model',
      kernel: { class: 'Generate', abi: 'value-finalize/1' },
      inputs: [],
      outputs: [{ name: 'tree', type: 'ProcessTree' }],
      params: { type: 'object', properties: { size: { type: 'integer', default: 20 } } },
      ...action,
    }],
  };
}

test('an action with no inputs is refused unless it declares itself standalone', () => {
  const files = new Set(['gen.js', 'gen_bg.wasm']);

  const forgotten = validateManifest(generatorManifest(), files);
  assert.equal(forgotten.ok, false);
  assert.ok(forgotten.errors.some((e) => /no inputs declared/.test(e)));
  assert.ok(forgotten.errors.some((e) => /standalone/.test(e)), 'the error says how to declare a real generator');

  const declared = validateManifest(generatorManifest({ standalone: true }), files);
  assert.deepEqual(declared.errors, []);
});

test('an importer still says so by having a file param, not by declaring standalone', () => {
  const importer = generatorManifest({
    params: { type: 'object', properties: { xml: { type: 'file', title: 'A file' } } },
  });
  assert.deepEqual(validateManifest(importer, new Set(['gen.js', 'gen_bg.wasm'])).errors, []);
});

/**
 * `primary` means "this view is the artifact" — a per-type claim (see
 * `ViewDef.primary`), so a package contributing two artifact types may have a
 * primary view for each, and two primaries on the *same* type is the mistake.
 */
function viewManifest(views: unknown[]) {
  return {
    manifestVersion: 1,
    id: 'org.example.two-types',
    name: 'Two types',
    version: '0.1.0',
    runtime: 'view',
    artifactTypes: [{ id: 'ExampleModel' }, { id: 'ExampleReport' }],
    views,
  };
}

test('a package may declare one primary view per artifact type', () => {
  const ok = validateManifest(viewManifest([
    { id: 'org.example.two-types.model', entry: 'view/model.js', appliesTo: ['ExampleModel'], primary: true },
    { id: 'org.example.two-types.report', entry: 'view/report.js', appliesTo: ['ExampleReport'], primary: true },
  ]), new Set(['view/model.js', 'view/report.js']));
  assert.deepEqual(ok.errors, []);
});

test('two primary views of the same artifact type are refused', () => {
  const clash = validateManifest(viewManifest([
    { id: 'org.example.two-types.a', entry: 'view/a.js', appliesTo: ['ExampleModel'], primary: true },
    { id: 'org.example.two-types.b', entry: 'view/b.js', appliesTo: ['ExampleModel', 'ExampleReport'], primary: true },
  ]), new Set(['view/a.js', 'view/b.js']));
  assert.equal(clash.ok, false);
  assert.ok(clash.errors.some((e) => /at most one view per artifact type/.test(e)));
  assert.ok(clash.errors.some((e) => /ExampleModel/.test(e)));
});
