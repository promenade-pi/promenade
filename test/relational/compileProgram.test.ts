import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from '../../src/host/relational/sqlProfile.ts';
import { compileProgram, RelationalCompileError } from '../../src/host/relational/compileProgram.ts';
import type { RelationalInputBinding } from '../../src/host/relational/types.ts';

const physicalTableOf = (artifactId: string, logical: string) =>
  `${artifactId.replace(/[^a-zA-Z0-9_]/g, '_')}__${logical}`;

const logInput: RelationalInputBinding[] = [
  { role: 'log', artifactId: 'a_abc123', artifactType: 'TraditionalEventLog' },
];

test('compiles a single-output program, resolving {log.events} to the physical view', () => {
  const program = parseProgram(`
-- @output activities
SELECT activity, COUNT(*) AS n FROM {log.events} GROUP BY 1
`);
  const compiled = compileProgram(program, logInput, {}, undefined, {
    physicalTableOf, declaredParams: {},
  });
  assert.equal(compiled.statements.length, 1);
  const s = compiled.statements[0];
  assert.equal(s.name, 'activities');
  assert.equal(s.kind, 'output');
  assert.match(s.sql, /a_abc123__event/);
  assert.match(s.sql, /WITH activities AS \(/);
  assert.match(s.sql, /SELECT \* FROM activities$/);
});

test('an intermediate relation becomes a CTE the output depends on, in dependency order', () => {
  const program = parseProgram(`
-- @relation kept
SELECT * FROM {log.events} WHERE activity IS NOT NULL

-- @output activities
SELECT activity, COUNT(*) AS n FROM kept GROUP BY 1
`);
  const compiled = compileProgram(program, logInput, {}, undefined, {
    physicalTableOf, declaredParams: {},
  });
  assert.equal(compiled.statements.length, 1);
  const sql = compiled.statements[0].sql;
  // Both CTEs present, `kept` declared before `activities` references it.
  assert.match(sql, /WITH kept AS \([\s\S]*\),\nactivities AS \(/);
  assert.match(sql, /FROM kept/);
});

test('requestedRelations returns an additional compiled statement for a named intermediate result', () => {
  const program = parseProgram(`
-- @relation kept
SELECT * FROM {log.events} WHERE activity IS NOT NULL

-- @output activities
SELECT activity, COUNT(*) AS n FROM kept GROUP BY 1
`);
  const compiled = compileProgram(program, logInput, {}, ['kept'], {
    physicalTableOf, declaredParams: {},
  });
  assert.equal(compiled.statements.length, 2);
  const names = compiled.statements.map((s) => s.name).sort();
  assert.deepEqual(names, ['activities', 'kept']);
  const keptCompiled = compiled.statements.find((s) => s.name === 'kept')!;
  assert.equal(keptCompiled.kind, 'relation');
  assert.match(keptCompiled.sql, /SELECT \* FROM kept$/);
  // The `kept`-only compilation does not need to pull in `activities` at all.
  assert.ok(!keptCompiled.sql.includes('activities AS ('));
});

test('binds a declared parameter positionally rather than splicing it into SQL', () => {
  const program = parseProgram(`
-- @output activities
SELECT activity, COUNT(*) AS n FROM {log.events}
WHERE activity IS NOT NULL
GROUP BY 1 HAVING COUNT(*) >= :minFrequency
`);
  const compiled = compileProgram(program, logInput, { minFrequency: 10 }, undefined, {
    physicalTableOf, declaredParams: { minFrequency: { type: 'integer' } },
  });
  const s = compiled.statements[0];
  assert.match(s.sql, />= \?/);
  assert.deepEqual(s.values, [10]);
});

test('rejects a program that fails SQL Profile validation before ever compiling', () => {
  const program = parseProgram(`
-- @output activities
SELECT * FROM read_parquet('/opfs/artifacts/x/events.parquet')
`);
  assert.throws(
    () => compileProgram(program, logInput, {}, undefined, { physicalTableOf, declaredParams: {} }),
    RelationalCompileError
  );
});

test('rejects an input role the program never binds', () => {
  const program = parseProgram(`
-- @output activities
SELECT * FROM {ghost.events}
`);
  assert.throws(
    () => compileProgram(program, logInput, {}, undefined, { physicalTableOf, declaredParams: {} }),
    RelationalCompileError
  );
});

test('two inputs with different roles do not collide, even against the same artifact type', () => {
  const twoLogs: RelationalInputBinding[] = [
    { role: 'baseline', artifactId: 'a_1', artifactType: 'TraditionalEventLog' },
    { role: 'variant', artifactId: 'a_2', artifactType: 'TraditionalEventLog' },
  ];
  const program = parseProgram(`
-- @output both
SELECT COUNT(*) AS a, (SELECT COUNT(*) FROM {variant.events}) AS b FROM {baseline.events}
`);
  const compiled = compileProgram(program, twoLogs, {}, undefined, { physicalTableOf, declaredParams: {} });
  const sql = compiled.statements[0].sql;
  assert.match(sql, /a_1__event/);
  assert.match(sql, /a_2__event/);
});
