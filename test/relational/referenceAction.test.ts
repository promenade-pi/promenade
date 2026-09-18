import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from '../../src/host/plugins/manifest.ts';
import { parseProgram } from '../../src/host/relational/sqlProfile.ts';
import { compileProgram } from '../../src/host/relational/compileProgram.ts';
import type { RelationalInputBinding } from '../../src/host/relational/types.ts';

/**
 * Proves the on-disk reference package — the "plugin package concept" from
 * the relational-runtime task (a `manifest.json` + `query.sql` pair) — is
 * itself valid against the same rules a real `.pmplugin` install would run.
 */
const PKG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/host/relational/reference-actions/discover-dfg'
);

const manifest = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'manifest.json'), 'utf8'));
const querySql = fs.readFileSync(path.join(PKG_DIR, 'query.sql'), 'utf8');

test('the reference DFG package manifest.json validates against manifest.ts', () => {
  const r = validateManifest(manifest, new Set(['query.sql']));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('the reference DFG package fails to validate if query.sql is missing from the package', () => {
  const r = validateManifest(manifest, new Set());
  assert.ok(r.errors.some((e) => /queryFile not in package/.test(e)));
});

test('query.sql parses into five named statements: four relations, five outputs (activities/edges/starts/ends/statistics)', () => {
  const program = parseProgram(querySql);
  const byKind = { relation: 0, output: 0 };
  for (const s of program.statements) byKind[s.kind]++;
  assert.equal(byKind.output, 5);
  assert.deepEqual(
    program.statements.filter((s) => s.kind === 'output').map((s) => s.name).sort(),
    ['activities', 'edges', 'ends', 'starts', 'statistics']
  );
});

test('query.sql compiles against a bound TraditionalEventLog input, with :minFrequency bound positionally', () => {
  const program = parseProgram(querySql);
  const inputs: RelationalInputBinding[] = [
    { role: 'log', artifactId: 'a_test1', artifactType: 'TraditionalEventLog' },
  ];
  const compiled = compileProgram(program, inputs, { minFrequency: 10 }, undefined, {
    physicalTableOf: (id, logical) => `${id}__${logical}`,
    declaredParams: { minFrequency: { type: 'integer' } },
  });
  assert.equal(compiled.statements.length, 5);
  const edges = compiled.statements.find((s) => s.name === 'edges')!;
  assert.match(edges.sql, />= \?/);
  assert.deepEqual(edges.values, [10]);
  assert.match(edges.sql, /LEAD\(activity\) OVER/); // the window function the task asks this reference action to exercise
});
