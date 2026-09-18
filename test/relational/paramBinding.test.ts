import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractParamNames, toPositionalSql, coerceParamValue, bindStatementParams,
  paramTypeSchemasFrom,
} from '../../src/host/relational/paramBinding.ts';

test('paramTypeSchemasFrom narrows a manifest ParamSchema to what binding needs', () => {
  const schemas = paramTypeSchemasFrom({
    minFrequency: { type: 'integer', title: 'Minimum edge frequency', default: 10, primary: true },
    activities: { type: 'array', title: 'Activities', items: { type: 'string' } },
  } as any);
  assert.deepEqual(schemas, {
    minFrequency: { type: 'integer', items: undefined },
    activities: { type: 'array', items: { type: 'string' } },
  });
});

test('extractParamNames finds :name references', () => {
  assert.deepEqual(
    extractParamNames('SELECT * FROM t WHERE n >= :minFrequency AND m < :maxFrequency'),
    ['minFrequency', 'maxFrequency']
  );
});

test('extractParamNames ignores DuckDB :: cast syntax', () => {
  assert.deepEqual(extractParamNames('SELECT col::INTEGER FROM t'), []);
});

test('extractParamNames ignores : inside string literals', () => {
  assert.deepEqual(extractParamNames(`SELECT '10:30' AS x FROM t`), []);
});

test('extractParamNames handles an escaped quote inside a literal without losing sync', () => {
  assert.deepEqual(
    extractParamNames(`SELECT 'it''s :notAParam' AS x WHERE n = :realParam`),
    ['realParam']
  );
});

test('toPositionalSql rewrites :name to ? and returns bind order', () => {
  const { sql, order } = toPositionalSql('SELECT * FROM t WHERE n >= :min AND n <= :max');
  assert.equal(sql, 'SELECT * FROM t WHERE n >= ? AND n <= ?');
  assert.deepEqual(order, ['min', 'max']);
});

test('toPositionalSql repeats the placeholder for a parameter used twice, in order', () => {
  const { sql, order } = toPositionalSql('SELECT * FROM t WHERE a = :x OR b = :x');
  assert.equal(sql, 'SELECT * FROM t WHERE a = ? OR b = ?');
  assert.deepEqual(order, ['x', 'x']);
});

test('coerceParamValue rejects a numeric string for an integer parameter (no silent coercion)', () => {
  assert.throws(() => coerceParamValue('n', '10', { type: 'integer' }), /must be an integer/);
});

test('coerceParamValue rejects a non-integer number for an integer parameter', () => {
  assert.throws(() => coerceParamValue('n', 1.5, { type: 'integer' }), /must be an integer/);
});

test('coerceParamValue accepts a valid integer', () => {
  assert.equal(coerceParamValue('n', 10, { type: 'integer' }), 10);
});

test('coerceParamValue validates array element types', () => {
  assert.throws(
    () => coerceParamValue('acts', [1, 2], { type: 'array', items: { type: 'string' } }),
    /every element must be a string/
  );
  assert.throws(
    () => coerceParamValue('n', ['a'], { type: 'array', items: { type: 'number' } }),
    /every element must be a number/
  );
});

test('coerceParamValue binds an array as one unit-separated string', () => {
  // DuckDB-Wasm's prepared statements have no LIST-typed bound parameter, so
  // an array arrives as a single scalar delimited by U+001F and a query
  // reconstitutes it with `string_split(:name, chr(31))` — see
  // plugins/ocpn-rs/project.sql, which depends on exactly this encoding.
  assert.equal(
    coerceParamValue('acts', ['a', 'b'], { type: 'array', items: { type: 'string' } }),
    'ab'
  );
  assert.equal(
    coerceParamValue('acts', ['solo'], { type: 'array', items: { type: 'string' } }),
    'solo'
  );
  assert.equal(
    coerceParamValue('n', [1, 2], { type: 'array', items: { type: 'number' } }),
    '12'
  );
});

test('bindStatementParams rejects a parameter the action manifest does not declare', () => {
  assert.throws(
    () => bindStatementParams('SELECT * FROM t WHERE n >= :evil', {}, {}),
    /is not a declared parameter/
  );
});

test('bindStatementParams rejects a missing value for a declared parameter', () => {
  assert.throws(
    () => bindStatementParams('SELECT * FROM t WHERE n >= :min', {}, { min: { type: 'integer' } }),
    /missing value/
  );
});

test('bindStatementParams never splices the value into the SQL text', () => {
  const injection = "1; DROP TABLE events; --";
  const { sql, values } = bindStatementParams(
    'SELECT * FROM t WHERE label = :label',
    { label: injection },
    { label: { type: 'string' } }
  );
  assert.equal(sql, 'SELECT * FROM t WHERE label = ?');
  assert.ok(!sql.includes('DROP'));
  assert.deepEqual(values, [injection]);
});

test('an apostrophe in a comment does not flip string parity', () => {
  // The failure this prevents is silent and confusing: a comment reading
  // "the notebook's protocol" opens a string literal that the next real quote
  // closes, so every literal after it is read as code. The symptom is a
  // parameter the action never declared — here `:partition`, which only ever
  // appears inside a salt string.
  const sql = [
    "-- the notebook's protocol, and the paper's",
    "SELECT CASE WHEN CAST(:protocol AS VARCHAR) = 'singleTarget' THEN 1 ELSE 0 END",
    "FROM t WHERE hash(id || ':partition:' || CAST(:seed AS VARCHAR)) > 0",
  ].join('\n');
  assert.deepEqual(extractParamNames(sql), ['protocol', 'seed']);
});

test('a parameter reference inside a comment is not bound', () => {
  const sql = '-- :notAParam is only mentioned here\nSELECT * FROM t WHERE n = :real';
  assert.deepEqual(extractParamNames(sql), ['real']);
  const { sql: positional, order } = toPositionalSql(sql);
  assert.deepEqual(order, ['real']);
  assert.ok(positional.includes(':notAParam'), 'the comment text must survive untouched');
});
