import assert from 'node:assert/strict';
import test from 'node:test';
import * as arrow from 'apache-arrow';
import { buildLogRelations, TIMESTAMP_SUFFIX } from '../../src/host/artifact/log-rows.ts';

/**
 * The gate between "a plugin computed a log" and physical storage.
 *
 * Worth testing without a worker or DuckDB for the same reason
 * `publish-log.test.ts` is: this is where a generated log is either found
 * malformed — with a message naming what is wrong — or written as if it had
 * been imported. Nothing downstream re-checks it.
 */

const columnsOf = (ipc: Uint8Array) => {
  const table = arrow.tableFromIPC(ipc);
  return Object.fromEntries(table.schema.fields.map((f, i) => [f.name, table.getChildAt(i)!.toArray()]));
};

function playedOut() {
  return {
    events: {
      event_idx: [0, 1, 2],
      trace_idx: [0, 0, 1],
      activity: ['a', 'b', 'a'],
      ts: [1_700_000_000_000_000, 1_700_000_060_000_000, 1_700_000_120_000_000],
      lifecycle: ['complete', 'complete', 'complete'],
    },
    cases: { trace_idx: [0, 1], case_id: ['case_1', 'case_2'] },
  };
}

test('generated columns become the physical relations of a traditional log', () => {
  const { relations, counts } = buildLogRelations('TraditionalEventLog', playedOut());

  assert.deepEqual(Object.keys(relations).sort(), ['event', 'trace'], 'named by their physical, not logical, names');
  assert.deepEqual(counts, { event: 3, trace: 2 });

  const event = columnsOf(relations.event);
  assert.deepEqual([...event.event_idx], [0n, 1n, 2n]);
  assert.deepEqual([...event.trace_idx], [0n, 0n, 1n]);
  assert.deepEqual([...event.activity], ['a', 'b', 'a']);
  assert.deepEqual([...event.lifecycle], ['complete', 'complete', 'complete']);

  // The one column that changes name on the way out: microseconds as an
  // integer, which the worker turns into a TIMESTAMP with make_timestamp().
  assert.ok(!('ts' in event), 'no Arrow timestamp vector is ever built here');
  assert.deepEqual([...event[`ts${TIMESTAMP_SUFFIX}`]], [1_700_000_000_000_000n, 1_700_000_060_000_000n, 1_700_000_120_000_000n]);

  // `resource` was not supplied at all; the worker fills it with typed nulls
  // rather than this module inventing a column of empty strings.
  assert.ok(!('resource' in event));
});

test('an optional column may carry nulls, a required one may not', () => {
  const rows = playedOut();
  (rows.events as any).resource = ['ann', null, 'bob'];
  const { relations } = buildLogRelations('TraditionalEventLog', rows);
  assert.deepEqual([...columnsOf(relations.event).resource], ['ann', null, 'bob']);

  const broken = playedOut();
  (broken.events.trace_idx as any)[1] = null;
  assert.throws(
    () => buildLogRelations('TraditionalEventLog', broken),
    /column "trace_idx" is null at row 2/,
  );
});

test('a relation, column or length the schema does not allow is named, not guessed at', () => {
  const unknownRelation = { ...playedOut(), variants: { id: [1] } };
  assert.throws(() => buildLogRelations('TraditionalEventLog', unknownRelation as any), /unknown relation "variants"/);

  const unknownColumn = playedOut();
  (unknownColumn.events as any).cost = [1, 2, 3];
  assert.throws(() => buildLogRelations('TraditionalEventLog', unknownColumn), /unknown column "cost"/);

  const missing = playedOut();
  delete (missing.events as any).trace_idx;
  assert.throws(() => buildLogRelations('TraditionalEventLog', missing), /required column "trace_idx" is missing/);

  const ragged = playedOut();
  ragged.events.activity = ['a', 'b'];
  assert.throws(() => buildLogRelations('TraditionalEventLog', ragged), /has 2 values; the relation has 3 rows/);

  const fractional = playedOut();
  (fractional.events.ts as any)[0] = 1.5;
  assert.throws(() => buildLogRelations('TraditionalEventLog', fractional), /expected a whole number/);
});

test('a log needs events; everything else may be empty', () => {
  assert.throws(
    () => buildLogRelations('TraditionalEventLog', { cases: { trace_idx: [0], case_id: ['c'] } }),
    /needs a non-empty "events" relation/,
  );

  // An empty relation is omitted rather than written empty — what an import
  // of a log with no trace attributes does too.
  const { relations, counts } = buildLogRelations('TraditionalEventLog', {
    ...playedOut(), case_attributes: { trace_idx: [], key: [], type: [], value: [] },
  });
  assert.ok(!('trace_attr' in relations));
  assert.equal(counts.trace_attr, 0);
});

test('only a type with a logical schema can be built from rows', () => {
  assert.throws(
    () => buildLogRelations('AcceptingPetriNet', playedOut()),
    /not a log-shaped artifact type/,
  );
});

test('object-centric logs go through the same builder', () => {
  const { relations, counts } = buildLogRelations('ObjectCentricEventLog', {
    events: { event_id: ['e1', 'e2'], activity: ['place order', 'pay'], ts: [1_700_000_000_000_000, 1_700_000_001_000_000] },
    objects: { object_id: ['o1'], object_type: ['Order'] },
    event_object: { event_id: ['e1', 'e2'], object_id: ['o1', 'o1'], qualifier: [null, null] },
  });
  assert.deepEqual(Object.keys(relations).sort(), ['e2o', 'event', 'object']);
  assert.deepEqual(counts, { event: 2, object: 1, e2o: 2 });
  assert.deepEqual([...columnsOf(relations.event)[`ts${TIMESTAMP_SUFFIX}`]], [1_700_000_000_000_000n, 1_700_000_001_000_000n]);
});
