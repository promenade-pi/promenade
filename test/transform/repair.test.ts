import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../../src/host/transform/compile.ts';
import { insertOpOrdered, OP_PHASE, type TransformOp } from '../../src/host/transform/types.ts';
import { run, rows } from './duckdb.mjs';

/**
 * Executable invariants for the repair operations.
 *
 * `disambiguateEventOrder` asserts an order the source did not record, so the
 * one thing it must never do is disturb an order the source *did* record. That
 * is checked here against a real engine over randomised logs rather than by
 * reading the generated SQL, because the hazard is arithmetic: a fixed +1ms
 * step walks a tied group straight over a genuine event one millisecond later,
 * and no amount of staring at the query text shows that.
 */

const XES = (p: string) => ({
  event: `${p}__event`, event_attr: `${p}__event_attr`,
  trace: `${p}__trace`, trace_attr: `${p}__trace_attr`,
});

const OCEL = (p: string) => ({
  event: `${p}__event`, event_attr: `${p}__event_attr`, object: `${p}__object`,
  object_attr: `${p}__object_attr`, e2o: `${p}__e2o`, o2o: `${p}__o2o`,
});

let seq = 0;
const uniq = () => `t${seq++}`;

/** Deterministic PRNG: a failing seed has to be reproducible to be useful. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Epoch microseconds: the unit storage actually uses, and the unit a repair
 *  works in. Building the fixtures in milliseconds made the tests agree with
 *  the code about the wrong grid. */
const BASE = Date.UTC(2024, 0, 1, 10, 0, 0) * 1000;
const MS = 1000;

type Row = { event_idx: number; trace_idx: number; ts: number };

/**
 * A log whose timestamps sit on a millisecond grid, exactly as ingest leaves
 * them, with heavy ties and deliberately adjacent milliseconds — the shape in
 * which a fixed-step repair corrupts the order.
 */
function generate(seed: number, cases = 6, grid: 'ms' | 'us' = 'ms'): Row[] {
  const rand = rng(seed);
  const out: Row[] = [];
  let idx = 0;
  for (let c = 0; c < cases; c++) {
    let t = BASE + Math.floor(rand() * 5) * MS;
    const steps = 3 + Math.floor(rand() * 6);
    for (let s = 0; s < steps; s++) {
      // The adversarial gap roughly half the time: adjacent points on whatever
      // grid the source used. On 'us' that gap is a thousandth of the default
      // step, so the repair has to shrink into it rather than step over it.
      const unit = grid === 'ms' ? MS : 1;
      t += rand() < 0.5 ? unit : unit * (1 + Math.floor(rand() * 2000));
      const ties = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < ties; k++) out.push({ event_idx: idx++, trace_idx: c, ts: t });
    }
  }
  return out;
}

async function loadXes(prefix: string, events: Row[]) {
  const values = events
    .map((e) => `(${e.event_idx}, ${e.trace_idx}, 'A', make_timestamp(${e.ts}), NULL, NULL)`)
    .join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${prefix}__event AS SELECT * FROM (VALUES ${values}) ` +
      `v(event_idx, trace_idx, activity, ts, lifecycle, resource)`,
    `CREATE OR REPLACE TABLE ${prefix}__trace AS SELECT DISTINCT trace_idx, ` +
      `'case-' || trace_idx AS case_id FROM ${prefix}__event`,
    `CREATE OR REPLACE TABLE ${prefix}__event_attr AS SELECT CAST(NULL AS BIGINT) AS event_idx, ` +
      `CAST(NULL AS VARCHAR) AS key, CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`,
    `CREATE OR REPLACE TABLE ${prefix}__trace_attr AS SELECT CAST(NULL AS BIGINT) AS trace_idx, ` +
      `CAST(NULL AS VARCHAR) AS key, CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
}

async function applyPlan(prefix: string, tables: Record<string, string>, ops: TransformOp[]) {
  const target = uniq();
  const compiled = compilePlan(target, tables, ops);
  await run(compiled.statements);
  return compiled.tables;
}

const DISAMBIGUATE: TransformOp = {
  kind: 'disambiguateEventOrder', tieBreak: 'identifier', stepMicroseconds: 1000,
};

async function checkNoCrossing(grid: 'ms' | 'us') {
  for (let seed = 1; seed <= 25; seed++) {
    const prefix = uniq();
    const source = generate(seed, 6, grid);
    await loadXes(prefix, source);
    const out = await applyPlan(prefix, XES(prefix), [DISAMBIGUATE]);
    // Microseconds, not milliseconds: `epoch_ms` truncates, which would hide
    // exactly the sub-millisecond separation this operation produces when a
    // tied group has to fit inside a one-millisecond gap.
    const repaired: Row[] = await rows(
      `SELECT event_idx, trace_idx, epoch_us(ts) AS ts FROM ${out.event}`
    ) as any;

    assert.equal(repaired.length, source.length, `seed ${seed}: event count changed`);
    const before = new Map(source.map((e) => [e.event_idx, e]));
    const byCase = new Map<number, Row[]>();
    for (const r of repaired) {
      if (!byCase.has(r.trace_idx)) byCase.set(r.trace_idx, []);
      byCase.get(r.trace_idx)!.push(r);
    }

    for (const [caseId, group] of byCase) {
      // The recorded order, as the source left it.
      const original = group
        .map((r) => before.get(r.event_idx)!)
        .sort((a, b) => a.ts - b.ts || a.event_idx - b.event_idx);
      const after = [...group].sort((a, b) => a.ts - b.ts || a.event_idx - b.event_idx);

      assert.deepEqual(
        after.map((r) => r.event_idx), original.map((r) => r.event_idx),
        `seed ${seed}, case ${caseId}: the repair reordered events`
      );

      // How much room each tied group had: the distance to the next distinct
      // source timestamp in the same case. A group wider than its gap cannot be
      // separated without stepping onto a genuine event, and must not be.
      const distinct = [...new Set(original.map((r) => r.ts))].sort((a, b) => a - b);
      const size = new Map<number, number>();
      for (const r of original) size.set(r.ts, (size.get(r.ts) ?? 0) + 1);
      const room = new Map<number, number>();
      distinct.forEach((ts, i) => {
        room.set(ts, i + 1 < distinct.length ? distinct[i + 1] - ts : Infinity);
      });

      for (let i = 0; i < after.length; i++) {
        const src = before.get(after[i].event_idx)!;
        assert.ok(
          after[i].ts >= src.ts,
          `seed ${seed}: an event moved backwards (${after[i].ts} < ${src.ts})`
        );
        if (i === 0) continue;
        const prevSrc = before.get(after[i - 1].event_idx)!;

        if (prevSrc.ts < src.ts) {
          // Two events the source separated must stay separated, and in order.
          // This is the invariant that matters: it is what a fixed-step repair
          // violates, and it holds whatever the source's resolution was.
          assert.ok(
            after[i - 1].ts < after[i].ts,
            `seed ${seed}, case ${caseId}: genuinely ordered events collided ` +
            `(${prevSrc.ts}→${after[i - 1].ts}, ${src.ts}→${after[i].ts})`
          );
          continue;
        }

        // A tie. It is separated when the group had room for it — and when it
        // did not, staying put is the correct outcome, not a failure.
        assert.ok(
          after[i - 1].event_idx < after[i].event_idx,
          `seed ${seed}: the tie-break did not follow order of appearance`
        );
        if (room.get(src.ts)! >= size.get(src.ts)!) {
          assert.ok(
            after[i - 1].ts < after[i].ts,
            `seed ${seed}, case ${caseId}: a tie at ${src.ts} had ` +
            `${room.get(src.ts)}µs of room for ${size.get(src.ts)} events and was not separated`
          );
        }
      }
    }
  }
}

test('tied timestamps are separated without ever crossing a genuine neighbour', async () => {
  await checkNoCrossing('ms');
});

test('the invariant holds when the source itself has microsecond precision', async () => {
  // Ingest preserves the source's microseconds, so a genuine gap can be a
  // single microsecond. A fixed-step repair has no room at all there; spreading
  // across the measured gap still must not reorder anything.
  await checkNoCrossing('us');
});

test('a tied group too large for its gap stays put rather than crossing the next event', async () => {
  const prefix = uniq();
  // 2,000 events tied inside a one-millisecond gap: 1 µs of room each at best.
  const crowded: Row[] = [];
  for (let i = 0; i < 2000; i++) crowded.push({ event_idx: i, trace_idx: 0, ts: BASE });
  crowded.push({ event_idx: 2000, trace_idx: 0, ts: BASE + MS });
  await loadXes(prefix, crowded);
  const out = await applyPlan(prefix, XES(prefix), [DISAMBIGUATE]);

  const [{ max_shifted, neighbour }]: any = await rows(
    `SELECT MAX(CASE WHEN event_idx < 2000 THEN epoch_us(ts) END) AS max_shifted, ` +
    `MAX(CASE WHEN event_idx = 2000 THEN epoch_us(ts) END) AS neighbour FROM ${out.event}`
  );
  assert.ok(
    max_shifted < neighbour,
    `the crowded group reached its genuine neighbour (${max_shifted} >= ${neighbour})`
  );
});

test('the repair is deterministic: the same plan compiles to the same timestamps twice', async () => {
  const prefix = uniq();
  await loadXes(prefix, generate(7));
  const first = await applyPlan(prefix, XES(prefix), [DISAMBIGUATE]);
  const second = await applyPlan(prefix, XES(prefix), [DISAMBIGUATE]);
  const diff: any[] = await rows(
    `SELECT a.event_idx FROM ${first.event} a JOIN ${second.event} b USING (event_idx) ` +
    `WHERE a.ts IS DISTINCT FROM b.ts`
  );
  assert.deepEqual(diff, []);
});

test('a lifecycle tie-break puts start before complete inside a tied group', async () => {
  const prefix = uniq();
  await run([
    `CREATE OR REPLACE TABLE ${prefix}__event AS SELECT * FROM (VALUES ` +
      `(0, 0, 'A', make_timestamp(${BASE}), 'complete', NULL), ` +
      `(1, 0, 'A', make_timestamp(${BASE}), 'start', NULL)) ` +
      `v(event_idx, trace_idx, activity, ts, lifecycle, resource)`,
    `CREATE OR REPLACE TABLE ${prefix}__trace AS SELECT 0 AS trace_idx, 'c' AS case_id`,
  ]);
  const out = await applyPlan(
    prefix,
    { event: `${prefix}__event`, trace: `${prefix}__trace` },
    [{ kind: 'disambiguateEventOrder', tieBreak: 'lifecycle', stepMicroseconds: 1000 }]
  );
  const ordered: any[] = await rows(`SELECT lifecycle FROM ${out.event} ORDER BY ts`);
  assert.deepEqual(ordered.map((r) => r.lifecycle), ['start', 'complete']);
});

test('events with no timestamp are left alone', async () => {
  const prefix = uniq();
  await run([
    `CREATE OR REPLACE TABLE ${prefix}__event AS SELECT * FROM (VALUES ` +
      `(0, 0, 'A', CAST(NULL AS TIMESTAMP), NULL, NULL), ` +
      `(1, 0, 'A', make_timestamp(${BASE}), NULL, NULL), ` +
      `(2, 0, 'A', make_timestamp(${BASE}), NULL, NULL)) ` +
      `v(event_idx, trace_idx, activity, ts, lifecycle, resource)`,
    `CREATE OR REPLACE TABLE ${prefix}__trace AS SELECT 0 AS trace_idx, 'c' AS case_id`,
  ]);
  const out = await applyPlan(prefix, { event: `${prefix}__event`, trace: `${prefix}__trace` }, [DISAMBIGUATE]);
  const all: any[] = await rows(`SELECT event_idx, ts FROM ${out.event} ORDER BY event_idx`);
  assert.equal(all[0].ts, null);
  assert.notEqual(all[1].ts, all[2].ts);
});

test('the fixed-step recipe this operation replaces would reorder the log', async () => {
  // Documents the hazard rather than the fix: three events tied at T with a
  // genuine event at T+1ms. Stepping every tie by a fixed millisecond walks the
  // third one past the genuine neighbour *and* collides with it on the way.
  const prefix = uniq();
  await loadXes(prefix, [
    { event_idx: 0, trace_idx: 0, ts: BASE },
    { event_idx: 1, trace_idx: 0, ts: BASE },
    { event_idx: 2, trace_idx: 0, ts: BASE },
    { event_idx: 3, trace_idx: 0, ts: BASE + MS },
  ]);

  const naive: any[] = await rows(
    `SELECT event_idx, epoch_us(ts + to_microseconds(CAST(1000 * ` +
    `(row_number() OVER (PARTITION BY ts ORDER BY event_idx) - 1) AS BIGINT))) AS ts ` +
    `FROM ${prefix}__event`
  );
  const naiveOrder = [...naive].sort((a, b) => a.ts - b.ts || a.event_idx - b.event_idx);
  assert.notDeepEqual(
    naiveOrder.map((r) => r.event_idx), [0, 1, 2, 3],
    'the fixed-step recipe is expected to reorder this log — if it no longer does, this test is wrong'
  );

  const out = await applyPlan(prefix, XES(prefix), [DISAMBIGUATE]);
  const fixed: any[] = await rows(`SELECT event_idx FROM ${out.event} ORDER BY ts, event_idx`);
  assert.deepEqual(fixed.map((r) => r.event_idx), [0, 1, 2, 3]);
});

async function loadOcel(prefix: string) {
  await run([
    `CREATE OR REPLACE TABLE ${prefix}__event AS SELECT * FROM (VALUES ` +
      `('e1', 'Create', make_timestamp(${BASE})), ('e2', 'Pay', make_timestamp(${BASE + 5000 * MS})), ` +
      `('e3', 'Orphaned', make_timestamp(${BASE + 9000 * MS}))) v(event_id, activity, ts)`,
    `CREATE OR REPLACE TABLE ${prefix}__object AS SELECT * FROM (VALUES ` +
      `('o1', 'Order'), ('o2', 'Item'), ('o3', 'NeverUsed')) v(object_id, object_type)`,
    // A duplicate E2O tuple, and one pointing at an event that does not exist.
    `CREATE OR REPLACE TABLE ${prefix}__e2o AS SELECT * FROM (VALUES ` +
      `('e1', 'o1', 'Creates'), ('e1', 'o1', 'Creates'), ('e1', 'o2', 'creates'), ` +
      `('e2', 'o1', ' Creates '), ('e9', 'o1', 'Creates')) v(event_id, object_id, qualifier)`,
    // A self-reference and a dangling target.
    `CREATE OR REPLACE TABLE ${prefix}__o2o AS SELECT * FROM (VALUES ` +
      `('o1', 'o2', 'contains'), ('o1', 'o1', 'contains'), ('o1', 'o9', 'contains')) ` +
      `v(source_id, target_id, qualifier)`,
    `CREATE OR REPLACE TABLE ${prefix}__object_attr AS SELECT * FROM (VALUES ` +
      `('o1', 'status', 'Open', CAST(NULL AS TIMESTAMP)), ('o1', 'email', 'a@b.com', NULL), ` +
      `('o2', 'status', 'open', NULL), ('o2', 'status', 'N/A', NULL)) ` +
      `v(object_id, name, value, ts)`,
    `CREATE OR REPLACE TABLE ${prefix}__event_attr AS SELECT CAST(NULL AS VARCHAR) AS event_id, ` +
      `CAST(NULL AS VARCHAR) AS name, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
}

test('relation repairs deduplicate, drop self-references and drop dangling rows', async () => {
  const prefix = uniq();
  await loadOcel(prefix);
  const out = await applyPlan(prefix, OCEL(prefix), [
    { kind: 'deduplicateRelations', scope: 'both' },
    { kind: 'dropSelfRelations' },
    { kind: 'dropDanglingRelations' },
  ]);

  const e2o: any[] = await rows(`SELECT event_id, object_id, qualifier FROM ${out.e2o} ORDER BY 1, 2, 3`);
  assert.deepEqual(e2o, [
    { event_id: 'e1', object_id: 'o1', qualifier: 'Creates' },
    { event_id: 'e1', object_id: 'o2', qualifier: 'creates' },
    { event_id: 'e2', object_id: 'o1', qualifier: ' Creates ' },
  ]);
  const o2o: any[] = await rows(`SELECT source_id, target_id FROM ${out.o2o} ORDER BY 1, 2`);
  assert.deepEqual(o2o, [{ source_id: 'o1', target_id: 'o2' }]);
});

test('canonicalising qualifiers collapses spelling variants onto the most frequent one', async () => {
  const prefix = uniq();
  await loadOcel(prefix);
  const out = await applyPlan(prefix, OCEL(prefix), [
    { kind: 'canonicaliseValues', scope: 'qualifier', names: [] },
  ]);
  const distinct: any[] = await rows(`SELECT DISTINCT qualifier FROM ${out.e2o} ORDER BY 1`);
  // 'Creates' ×3 beats 'creates' ×1 and ' Creates ' ×1; the dangling row counts
  // too, because canonicalisation runs before referential cleanup.
  assert.deepEqual(distinct.map((r) => r.qualifier), ['Creates']);
});

test('orphan objects go without taking events that never had objects', async () => {
  const prefix = uniq();
  await loadOcel(prefix);
  const out = await applyPlan(prefix, OCEL(prefix), [
    { kind: 'dropDanglingRelations' },
    { kind: 'dropOrphanObjects' },
  ]);
  const objects: any[] = await rows(`SELECT object_id FROM ${out.object} ORDER BY 1`);
  assert.deepEqual(objects.map((r) => r.object_id), ['o1', 'o2']);
  // e3 has no object relationship, but this repair is about objects only.
  const events: any[] = await rows(`SELECT event_id FROM ${out.event} ORDER BY 1`);
  assert.deepEqual(events.map((r) => r.event_id), ['e1', 'e2', 'e3']);
  const attrs: any[] = await rows(`SELECT DISTINCT object_id FROM ${out.object_attr} ORDER BY 1`);
  assert.deepEqual(attrs.map((r) => r.object_id), ['o1', 'o2']);
});

test('dropping events without objects is the separate repair, and it cascades', async () => {
  const prefix = uniq();
  await loadOcel(prefix);
  const out = await applyPlan(prefix, OCEL(prefix), [
    { kind: 'dropDanglingRelations' },
    { kind: 'dropEventsWithoutObjects' },
  ]);
  const events: any[] = await rows(`SELECT event_id FROM ${out.event} ORDER BY 1`);
  assert.deepEqual(events.map((r) => r.event_id), ['e1', 'e2']);
});

test('sentinel values become NULL and pseudonymisation is stable within the log', async () => {
  const prefix = uniq();
  await loadOcel(prefix);
  const out = await applyPlan(prefix, OCEL(prefix), [
    { kind: 'mapSentinelValues', scope: 'objectAttribute', names: ['status'], values: ['n/a'] },
    { kind: 'pseudonymiseAttributes', scope: 'objectAttribute', names: ['email'], mode: 'hash', salt: 's' },
  ]);
  const status: any[] = await rows(
    `SELECT object_id, value FROM ${out.object_attr} WHERE name = 'status' ORDER BY object_id, value`
  );
  assert.equal(status.filter((r) => r.value === null).length, 1);
  const email: any[] = await rows(`SELECT value FROM ${out.object_attr} WHERE name = 'email'`);
  assert.notEqual(email[0].value, 'a@b.com');
  assert.match(email[0].value, /^[0-9a-f]{16}$/);
});

test('empty cases are dropped without touching events', async () => {
  const prefix = uniq();
  await loadXes(prefix, [{ event_idx: 0, trace_idx: 0, ts: BASE }]);
  await run([`INSERT INTO ${prefix}__trace VALUES (1, 'case-1')`]);
  const out = await applyPlan(prefix, XES(prefix), [{ kind: 'dropEmptyCases' }]);
  const traces: any[] = await rows(`SELECT trace_idx FROM ${out.trace} ORDER BY 1`);
  assert.deepEqual(traces.map((r) => r.trace_idx), [0]);
});

test('implausible timestamps are cleared without dropping the event, or dropped on request', async () => {
  const prefix = uniq();
  const source = [
    { event_idx: 0, trace_idx: 0, ts: BASE },
    { event_idx: 1, trace_idx: 0, ts: Date.UTC(1900, 0, 1) * 1000 },
  ];
  await loadXes(prefix, source);
  const cleared = await applyPlan(prefix, XES(prefix), [
    { kind: 'dropImplausibleTimestamps', mode: 'clear', minYear: 1972, maxYear: 2099 },
  ]);
  const kept: any[] = await rows(`SELECT event_idx, ts FROM ${cleared.event} ORDER BY event_idx`);
  assert.equal(kept.length, 2);
  assert.equal(kept[1].ts, null);

  const dropped = await applyPlan(prefix, XES(prefix), [
    { kind: 'dropImplausibleTimestamps', mode: 'drop', minYear: 1972, maxYear: 2099 },
  ]);
  const remaining: any[] = await rows(`SELECT event_idx FROM ${dropped.event} ORDER BY event_idx`);
  assert.deepEqual(remaining.map((r) => r.event_idx), [0]);
});

test('a proposed repair lands at its phase position, not at the end of the plan', () => {
  const plan: TransformOp[] = [
    { kind: 'filterActivities', values: ['A'], mode: 'include', minFrequency: 0, maxFrequency: 100 },
    DISAMBIGUATE,
  ];
  const next = insertOpOrdered(plan, { kind: 'deduplicateRelations', scope: 'both' });
  assert.deepEqual(next.map((op) => op.kind),
    ['deduplicateRelations', 'filterActivities', 'disambiguateEventOrder']);
  // The order assertion must stay last: it is a statement about which events
  // survived the filters.
  assert.equal(OP_PHASE.disambiguateEventOrder, Math.max(...Object.values(OP_PHASE)));
});
