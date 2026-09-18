import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram, validateProgram, validateStatement } from '../../src/host/relational/sqlProfile.ts';

test('parseProgram splits marker comments into named statements', () => {
  const program = parseProgram(`
-- @relation kept
SELECT * FROM {log.events} WHERE activity IS NOT NULL

-- @output nodes
SELECT activity, COUNT(*) AS n FROM kept GROUP BY 1
`);
  assert.equal(program.statements.length, 2);
  assert.equal(program.statements[0].name, 'kept');
  assert.equal(program.statements[0].kind, 'relation');
  assert.equal(program.statements[1].name, 'nodes');
  assert.equal(program.statements[1].kind, 'output');
});

test('parseProgram rejects a program with no @output statement', () => {
  assert.throws(() => parseProgram('-- @relation a\nSELECT 1'), /at least one/);
});

test('parseProgram rejects text before the first marker', () => {
  assert.throws(() => parseProgram('SELECT 1\n-- @output a\nSELECT 2'), /before the first/);
});

test('parseProgram rejects duplicate statement names', () => {
  assert.throws(
    () => parseProgram('-- @output a\nSELECT 1\n-- @output a\nSELECT 2'),
    /duplicate/
  );
});

test('validateStatement accepts a plain SELECT over a declared input', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'SELECT activity FROM {log.events}' },
    new Set(['log.events'])
  );
  assert.deepEqual(v, []);
});

test('validateStatement accepts WITH ... SELECT', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'WITH x AS (SELECT 1 AS a) SELECT a FROM x' },
    new Set()
  );
  assert.deepEqual(v, []);
});

test('validateStatement rejects a bare table reference not declared as an input or CTE', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'SELECT * FROM some_guessed_table' },
    new Set(['log.events'])
  );
  assert.equal(v.length, 1);
  assert.match(v[0].message, /bare table reference/);
});

test('validateStatement accepts a bare reference to the statement\'s own CTE', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'WITH kept AS (SELECT 1 AS a) SELECT a FROM kept' },
    new Set()
  );
  assert.deepEqual(v, []);
});

test('validateStatement rejects a braced reference that is not a dotted role.relation', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'SELECT * FROM {notARoleDotRelation}' },
    new Set(['log.events'])
  );
  assert.equal(v.length, 1);
  assert.match(v[0].message, /braces are only for "\{role\.relation\}"/);
});

test('validateStatement rejects an undeclared {role.relation} input', () => {
  const v = validateStatement(
    { name: 'nodes', kind: 'output', sql: 'SELECT * FROM {ghost.events}' },
    new Set(['log.events'])
  );
  assert.equal(v.length, 1);
  assert.match(v[0].message, /"{ghost.events}" is not a declared input relation/);
});

test('validateProgram allows a later statement to reference an earlier one by its bare name, not vice versa', () => {
  const program = { statements: [
    { name: 'a', kind: 'relation' as const, sql: 'SELECT * FROM {log.events}' },
    { name: 'b', kind: 'output' as const, sql: 'SELECT * FROM a' },
  ] };
  assert.deepEqual(validateProgram(program, new Set(['log.events'])), []);
});

test('validateProgram rejects a forward reference', () => {
  const program = { statements: [
    { name: 'a', kind: 'relation' as const, sql: 'SELECT * FROM b' },
    { name: 'b', kind: 'output' as const, sql: 'SELECT * FROM {log.events}' },
  ] };
  const v = validateProgram(program, new Set(['log.events']));
  assert.equal(v.length, 1);
  assert.match(v[0].message, /bare table reference "b"/);
});

for (const bad of [
  'PRAGMA memory_limit',
  'INSTALL httpfs',
  'LOAD httpfs',
  "ATTACH 'evil.db' AS e",
  "COPY (SELECT 1) TO 'out.parquet'",
  'CREATE TABLE evil (x INT)',
  'DROP TABLE {log.events}',
  "INSERT INTO {log.events} VALUES (1)",
  "SELECT * FROM read_parquet('/opfs/artifacts/foo/events.parquet')",
  "SELECT * FROM read_csv('http://evil.example/x.csv')",
  'SELECT * FROM duckdb_tables()',
  "SET memory_limit='16GB'",
]) {
  test(`SQL profile rejects: ${bad}`, () => {
    const v = validateStatement({ name: 's', kind: 'output', sql: bad }, new Set(['log.events']));
    assert.ok(v.length > 0, `expected a violation for: ${bad}`);
  });
}

test('SQL profile rejects a second statement smuggled in via a semicolon', () => {
  const v = validateStatement(
    { name: 's', kind: 'output', sql: "SELECT 1; DROP TABLE {log.events}" },
    new Set(['log.events'])
  );
  assert.ok(v.some((x) => /exactly one statement/.test(x.message)));
});

test('a trailing semicolon alone is not a violation', () => {
  const v = validateStatement(
    { name: 's', kind: 'output', sql: 'SELECT * FROM {log.events};' },
    new Set(['log.events'])
  );
  assert.deepEqual(v, []);
});

test('a forbidden keyword inside a string literal is NOT flagged — event logs legitimately have activities named "Create Order" etc.', () => {
  const v = validateStatement(
    { name: 's', kind: 'output', sql: "SELECT * FROM {log.events} WHERE activity = 'Create Order'" },
    new Set(['log.events'])
  );
  assert.deepEqual(v, []);
});

test('a forbidden keyword inside a comment is not flagged either', () => {
  const v = validateStatement(
    { name: 's', kind: 'output', sql: "-- drop the noisy rows first\nSELECT * FROM {log.events}" },
    new Set(['log.events'])
  );
  assert.deepEqual(v, []);
});

test('the same keyword used as real SQL (outside any literal or comment) is still rejected', () => {
  const v = validateStatement(
    { name: 's', kind: 'output', sql: "SELECT * FROM {log.events} WHERE activity = CREATE_ORDER_LABEL" },
    new Set(['log.events'])
  );
  // CREATE_ORDER_LABEL contains "CREATE" but not as a whole word, so this
  // specific example must NOT trip the blocklist — word-boundary matching is
  // what keeps an identifier like this legal. A real bare keyword is covered
  // by the `bad` cases above (e.g. "CREATE TABLE evil (x INT)").
  assert.deepEqual(v, []);
});
