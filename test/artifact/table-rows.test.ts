import assert from 'node:assert/strict';
import test from 'node:test';
import * as arrow from 'apache-arrow';
import { buildTableRelations, TIMESTAMP_SUFFIX } from '../../src/host/artifact/table-rows.ts';

/**
 * The gate between "a plugin computed a dataset" and physical storage.
 *
 * Tested without a worker or DuckDB for the same reason `log-rows.test.ts` is:
 * this is where a generated table is either found malformed — with a message
 * naming what is wrong — or written as if it had been imported. Nothing
 * downstream re-checks it.
 *
 * The interesting half is `open`. A feature table has one column per activity
 * in the log, which no manifest can name in advance, so those columns arrive
 * undeclared and are typed by inspection. That is the one guess this module
 * makes, and most of what follows pins down what it guesses.
 */

const SCHEMA = [
  {
    name: 'features',
    open: true,
    columns: [
      { name: 'trace_idx', type: 'bigint' as const },
      { name: 'case_id', type: 'varchar' as const, required: false },
      { name: 'started_at', type: 'timestamp' as const, required: false },
    ],
  },
  {
    name: 'summary',
    columns: [{ name: 'metric', type: 'varchar' as const }, { name: 'value', type: 'double' as const }],
  },
];

const columnsOf = (ipc: Uint8Array) => {
  const table = arrow.tableFromIPC(ipc);
  return Object.fromEntries(table.schema.fields.map((f, i) => [f.name, table.getChildAt(i)!.toArray()]));
};

const typesOf = (ipc: Uint8Array) => {
  const table = arrow.tableFromIPC(ipc);
  return Object.fromEntries(table.schema.fields.map((f) => [f.name, String(f.type)]));
};

test('declared columns are written in declaration order, undeclared ones after them', () => {
  const built = buildTableRelations('FeatureTable', SCHEMA, {
    features: {
      'act:Pay': [2, 0],
      trace_idx: [0, 1],
      case_id: ['c1', 'c2'],
      'act:Order': [1, 1],
    },
  });

  assert.deepEqual(built.columns.features, ['trace_idx', 'case_id', 'act:Pay', 'act:Order']);
  assert.deepEqual(built.counts, { features: 2 });
});

test('an undeclared column is typed from its values', () => {
  const built = buildTableRelations('FeatureTable', SCHEMA, {
    features: {
      trace_idx: [0, 1],
      whole: [3, 4],
      fractional: [1.5, 2],
      flag: [true, false],
      label: ['a', 'b'],
      mixed: [1, 'two'],
      empty: [null, null],
    },
  });

  const types = typesOf(built.relations.features);
  assert.equal(types.whole, 'Int64');
  assert.equal(types.fractional, 'Float64');
  assert.equal(types.flag, 'Bool');
  assert.equal(types.label, 'Utf8');
  // A column that is neither all numbers nor all booleans becomes text
  // rather than being refused: an open relation exists for columns the host
  // was never told about, so there is nobody to report a type clash to.
  assert.equal(types.mixed, 'Utf8');
  assert.equal(types.empty, 'Utf8');
});

test('a closed relation refuses a column it does not declare, and says how to allow it', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, {
      summary: { metric: ['fitness'], value: [0.9], extra: [1] },
    }),
    /unknown column "extra".*Declare the relation "open"/s
  );
});

test('a missing required column is refused, a missing optional one is simply absent', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, { features: { case_id: ['c1'] } }),
    /required column "trace_idx" is missing/
  );

  const built = buildTableRelations('FeatureTable', SCHEMA, { features: { trace_idx: [0] } });
  assert.deepEqual(built.columns.features, ['trace_idx']);
});

test('a required column may not be null, and every column must describe the same rows', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, { features: { trace_idx: [0, null] } }),
    /column "trace_idx" is null at row 2/
  );
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, { features: { trace_idx: [0, 1], 'act:Pay': [1] } }),
    /column "act:Pay" has 1 values; the relation has 2 rows/
  );
});

test('timestamps leave as microsecond integers, under the same suffix a generated log uses', () => {
  const built = buildTableRelations('FeatureTable', SCHEMA, {
    features: { trace_idx: [0], started_at: [1_700_000_000_000_000] },
  });

  const columns = columnsOf(built.relations.features);
  assert.ok(`started_at${TIMESTAMP_SUFFIX}` in columns, 'timestamp column carries the suffix');
  assert.equal(columns[`started_at${TIMESTAMP_SUFFIX}`][0], 1_700_000_000_000_000n);
  assert.equal(typesOf(built.relations.features)[`started_at${TIMESTAMP_SUFFIX}`], 'Int64');
});

test('a value that is not a finite number is refused rather than stored', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, {
      summary: { metric: ['fitness'], value: [Number.NaN] },
    }),
    /is not a finite number/
  );
});

test('an unknown relation and a type with no table schema are both refused by name', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, { nope: { trace_idx: [0] } }),
    /unknown relation "nope" for FeatureTable — it declares features, summary/
  );
  assert.throws(
    () => buildTableRelations('Blob', [], { features: { trace_idx: [0] } }),
    /"Blob" is not a table-shaped artifact type/
  );
});

test('a table with no rows anywhere is refused rather than written empty', () => {
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, { features: { trace_idx: [] } }),
    /needs at least one non-empty relation/
  );
});

test('an undeclared column may not wear the timestamp suffix', () => {
  // The worker turns any `<name>_us` column into a real timestamp, so an
  // undeclared one carrying microseconds of *duration* would silently become
  // a date in 1970.
  assert.throws(
    () => buildTableRelations('FeatureTable', SCHEMA, {
      features: { trace_idx: [0], wait_us: [500] },
    }),
    /"wait_us" ends in "_us", which is reserved for timestamps/
  );
});
