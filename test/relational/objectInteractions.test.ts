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
 * Proves the second reference package — Object Interaction Graph, the one
 * that only makes sense for an ObjectCentricEventLog — validates against the
 * same rules a real install would run, and that its E2O/O2O self-joins
 * compile correctly against the OCEL logical schema.
 */
const PKG_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/host/relational/reference-actions/object-interactions'
);

const manifest = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'manifest.json'), 'utf8'));
const querySql = fs.readFileSync(path.join(PKG_DIR, 'query.sql'), 'utf8');

test('the object-interactions package manifest.json validates against manifest.ts', () => {
  const r = validateManifest(manifest, new Set(['query.sql']));
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('the manifest declares the new ObjectInteractionGraph artifact type, not folded into an existing one', () => {
  assert.deepEqual(manifest.artifactTypes, [
    { id: 'ObjectInteractionGraph', label: 'Object Interaction Graph', shortLabel: 'OI' },
  ]);
});

test('the manifest input requires an ObjectCentricEventLog, not a TraditionalEventLog', () => {
  const action = manifest.actions[0];
  assert.equal(action.inputs.length, 1);
  assert.equal(action.inputs[0].type, 'ObjectCentricEventLog');
});

test('query.sql parses into ten named statements: six relations, four outputs', () => {
  const program = parseProgram(querySql);
  const byKind = { relation: 0, output: 0 };
  for (const s of program.statements) byKind[s.kind]++;
  assert.equal(byKind.relation, 6);
  assert.equal(byKind.output, 4);
  assert.deepEqual(
    program.statements.filter((s) => s.kind === 'output').map((s) => s.name).sort(),
    ['e2o_qualifiers', 'o2o_relations', 'object_type_summary', 'type_interactions']
  );
});

test('query.sql compiles against a bound ObjectCentricEventLog input, using E2O and O2O relations no TraditionalEventLog has', () => {
  const program = parseProgram(querySql);
  const inputs: RelationalInputBinding[] = [
    { role: 'log', artifactId: 'a_ocel1', artifactType: 'ObjectCentricEventLog' },
  ];
  const compiled = compileProgram(program, inputs, { minSharedEvents: 1 }, undefined, {
    physicalTableOf: (id, logical) => `${id}__${logical}`,
    declaredParams: { minSharedEvents: { type: 'integer' } },
  });
  assert.equal(compiled.statements.length, 4);

  const interactions = compiled.statements.find((s) => s.name === 'type_interactions')!;
  // The self-join that makes this an "interaction graph" and not just a count.
  assert.match(interactions.sql, /JOIN event_object_types b\s+ON a\.event_id = b\.event_id AND a\.object_type < b\.object_type/);
  assert.match(interactions.sql, />= \?/);
  assert.deepEqual(interactions.values, [1]);
  assert.match(interactions.sql, /a_ocel1__e2o\b/);
  assert.match(interactions.sql, /a_ocel1__object\b/);

  const o2o = compiled.statements.find((s) => s.name === 'o2o_relations')!;
  assert.match(o2o.sql, /a_ocel1__o2o\b/);
});

test('the query would not compile against a TraditionalEventLog input — {log.event_object} is OCEL-only', () => {
  const program = parseProgram(querySql);
  const inputs: RelationalInputBinding[] = [
    { role: 'log', artifactId: 'a_trad1', artifactType: 'TraditionalEventLog' },
  ];
  assert.throws(() =>
    compileProgram(program, inputs, { minSharedEvents: 1 }, undefined, {
      physicalTableOf: (id, logical) => `${id}__${logical}`,
      declaredParams: { minSharedEvents: { type: 'integer' } },
    })
  );
});
