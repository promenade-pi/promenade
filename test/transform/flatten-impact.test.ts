import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../../src/host/transform/compile.ts';
import type { TransformOp } from '../../src/host/transform/types.ts';
import {
  activitySql, distortionOf, divergenceSql, impactSql,
} from '../../src/host/transform/flattenImpact.ts';
import { run, rows } from './duckdb.mjs';

/**
 * The flattening impact preview, checked against the flattening itself.
 *
 * The preview's only job is to predict what `compilePlan` will produce, and
 * the two are written independently — one aggregates the relations, the other
 * joins them into views. Agreeing about the textbook definition of
 * convergence is not enough: the compiled flatten view joins E2O *without*
 * de-duplicating, so two identical relation tuples really do yield two rows,
 * and a preview counting distinct objects would quietly under-report
 * convergence on exactly the logs that need a `deduplicateRelations` repair.
 * The only way to know the two agree is to run both.
 *
 * So every assertion here is of the form "what the preview says" ===
 * "what the plan then does", over randomised logs built to contain each
 * hazard, plus the two divergence cases that a count can never separate:
 * an activity that repeats because another object type drives it, and one
 * that repeats because the process really does it twice.
 */

let seq = 0;
const uniq = () => `fi${seq++}`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Log {
  events: { id: string; activity: string; ts: number }[];
  objects: { id: string; type: string }[];
  e2o: { event: string; object: string }[];
}

const BASE = Date.UTC(2024, 0, 1);

/** Materialises a log as the six OCEL relations, under a fresh prefix. */
async function mount(log: Log): Promise<Record<string, string>> {
  const p = uniq();
  const t = (l: string) => `${p}__${l}`;
  const values = (xs: string[]) => (xs.length ? `VALUES ${xs.join(', ')}` : null);
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

  const ev = values(log.events.map((e) =>
    `(${q(e.id)}, ${q(e.activity)}, TIMESTAMP '${new Date(e.ts).toISOString().replace('T', ' ').replace('Z', '')}')`));
  const ob = values(log.objects.map((o) => `(${q(o.id)}, ${q(o.type)})`));
  const re = values(log.e2o.map((r) => `(${q(r.event)}, ${q(r.object)}, NULL)`));

  await run([
    `CREATE OR REPLACE TABLE ${t('event')} (event_id VARCHAR, activity VARCHAR, ts TIMESTAMP)`,
    `CREATE OR REPLACE TABLE ${t('object')} (object_id VARCHAR, object_type VARCHAR)`,
    `CREATE OR REPLACE TABLE ${t('e2o')} (event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR)`,
    `CREATE OR REPLACE TABLE ${t('o2o')} (source_id VARCHAR, target_id VARCHAR, qualifier VARCHAR)`,
    `CREATE OR REPLACE TABLE ${t('event_attr')} (event_id VARCHAR, name VARCHAR, value VARCHAR)`,
    `CREATE OR REPLACE TABLE ${t('object_attr')} (object_id VARCHAR, name VARCHAR, value VARCHAR, ts TIMESTAMP)`,
    ...(ev ? [`INSERT INTO ${t('event')} ${ev}`] : []),
    ...(ob ? [`INSERT INTO ${t('object')} ${ob}`] : []),
    ...(re ? [`INSERT INTO ${t('e2o')} ${re}`] : []),
  ]);

  return {
    event: t('event'), object: t('object'), e2o: t('e2o'), o2o: t('o2o'),
    event_attr: t('event_attr'), object_attr: t('object_attr'),
  };
}

/** Runs the real flatten plan and returns the views it built. */
async function flatten(tables: Record<string, string>, objectType: string) {
  const target = uniq();
  const op: TransformOp = { kind: 'flattenByObjectType', objectType };
  const plan = compilePlan(target, tables, [op]);
  await run(plan.statements);
  return plan.tables;
}

/**
 * A log with every hazard in it at once: events with no object of a type,
 * events with several, duplicate relation tuples, and objects no event
 * mentions.
 */
function generate(seed: number): Log {
  const rand = rng(seed);
  const acts = ['Create', 'Pick', 'Pay', 'Ship', 'Close'];
  const types = ['Order', 'Item', 'Package'];
  const log: Log = { events: [], objects: [], e2o: [] };

  const perType: Record<string, string[]> = {};
  for (const ty of types) {
    perType[ty] = [];
    const n = 3 + Math.floor(rand() * 8);
    for (let i = 0; i < n; i++) {
      const id = `${ty}-${i}`;
      perType[ty].push(id);
      log.objects.push({ id, type: ty });
    }
  }

  const n = 25 + Math.floor(rand() * 40);
  for (let i = 0; i < n; i++) {
    const id = `e${i}`;
    log.events.push({ id, activity: acts[Math.floor(rand() * acts.length)], ts: BASE + i * 60000 });
    for (const ty of types) {
      // A third of the time an event touches none of a type — deficiency.
      if (rand() < 0.33) continue;
      const k = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < k; j++) {
        const pool = perType[ty];
        log.e2o.push({ event: id, object: pool[Math.floor(rand() * pool.length)] });
      }
    }
    // A duplicate tuple now and then: the compiled view keeps both.
    if (rand() < 0.15 && log.e2o.length) {
      log.e2o.push({ ...log.e2o[log.e2o.length - 1] });
    }
  }

  // Relations pointing nowhere, which both sides must ignore identically.
  if (rand() < 0.5) log.e2o.push({ event: 'ghost', object: perType.Order[0] });
  if (rand() < 0.5) log.e2o.push({ event: log.events[0].id, object: 'ghost' });
  return log;
}

test('the preview predicts the flattened log exactly', async () => {
  for (let seed = 1; seed <= 25; seed++) {
    const log = generate(seed);
    const tables = await mount(log);
    const predicted = await rows(impactSql(tables.object, tables.event, tables.e2o));

    for (const p of predicted) {
      const t = String(p.object_type);
      const flat = await flatten(tables, t);
      const [actual] = await rows(
        `SELECT (SELECT COUNT(*) FROM ${flat.event}) AS events,
                (SELECT COUNT(*) FROM ${flat.trace}) AS cases`
      );
      const where = `seed ${seed}, type ${t}`;

      assert.equal(p.out_rows, actual.events, `output rows disagree (${where})`);
      assert.equal(p.cases, actual.cases, `case count disagrees (${where})`);

      // The three source-event classes partition the source log, and the two
      // that survive account for every output row. Without this, a preview
      // could get the total right while attributing it to the wrong cause.
      assert.equal(
        p.retained_once + p.dup_events + p.dropped, p.src_events,
        `classes do not partition the source log (${where})`
      );
      assert.equal(
        p.retained_once + p.dup_rows, p.out_rows,
        `rows do not decompose into retained + duplicated (${where})`
      );
      assert.ok(p.dup_rows >= p.dup_events * 2 || p.dup_events === 0,
        `a duplicated event must yield at least two rows (${where})`);
    }
  }
});

test('the per-activity split predicts the flattened log too', async () => {
  for (let seed = 30; seed <= 42; seed++) {
    const log = generate(seed);
    const tables = await mount(log);
    const types = [...new Set(log.objects.map((o) => o.type))];

    for (const t of types) {
      const predicted = await rows(activitySql(tables.object, tables.event, tables.e2o, t));
      const flat = await flatten(tables, t);
      const actual = await rows(
        `SELECT activity, COUNT(*) AS n FROM ${flat.event} GROUP BY 1`
      );
      const byAct = new Map(actual.map((r) => [String(r.activity), Number(r.n)]));
      const where = `seed ${seed}, type ${t}`;

      for (const p of predicted) {
        const a = String(p.activity);
        // retained-once events plus the rows the duplicated ones became.
        const expect = (p.events - p.dropped - p.dup_events) + p.dup_rows;
        assert.equal(expect, byAct.get(a) ?? 0, `activity ${a} disagrees (${where})`);
        // An activity every one of whose events is dropped must be gone.
        if (p.dropped === p.events) {
          assert.ok(!byAct.has(a), `${a} should have vanished (${where})`);
        }
      }
      // And the preview must not miss an activity the flat log has.
      for (const a of byAct.keys()) {
        assert.ok(predicted.some((p) => String(p.activity) === a),
          `flat log has ${a}, preview does not (${where})`);
      }
    }
  }
});

/**
 * Divergence is the one problem no count reveals, so it needs the one test a
 * count cannot pass: two logs with the same event, object and relation totals,
 * where one activity is driven by another object type and the other is genuine
 * rework.
 */
test('divergence separates a foreign-driven repeat from real rework', async () => {
  const mk = (rework: boolean): Log => {
    const log: Log = { events: [], objects: [], e2o: [] };
    for (let o = 0; o < 6; o++) {
      log.objects.push({ id: `O${o}`, type: 'Order' });
      for (let i = 0; i < 3; i++) log.objects.push({ id: `I${o}-${i}`, type: 'Item' });

      log.events.push({ id: `c${o}`, activity: 'Create', ts: BASE });
      log.e2o.push({ event: `c${o}`, object: `O${o}` });

      for (let i = 0; i < 3; i++) {
        const e = `p${o}-${i}`;
        log.events.push({ id: e, activity: 'Pick', ts: BASE + (i + 1) * 60000 });
        log.e2o.push({ event: e, object: `O${o}` });
        // Foreign-driven: one Pick per Item. Rework: three Picks, same Item.
        log.e2o.push({ event: e, object: rework ? `I${o}-0` : `I${o}-${i}` });
      }
    }
    return log;
  };

  for (const rework of [false, true]) {
    const tables = await mount(mk(rework));
    const found = await rows(divergenceSql(tables.object, tables.event, tables.e2o, 'Order'));
    const flagged = found.filter((r) =>
      Number(r.repeat_cases) >= 2 && Number(r.explained_cases) >= Number(r.repeat_cases) * 0.5);

    if (rework) {
      assert.equal(flagged.length, 0,
        'genuine rework must not be reported as divergence');
    } else {
      assert.equal(flagged.length, 1, 'the foreign-driven repeat must be found');
      assert.equal(String(flagged[0].activity), 'Pick');
      assert.equal(String(flagged[0].explained_by), 'Item');
      assert.equal(Number(flagged[0].repeat_cases), 6);
      assert.equal(Number(flagged[0].explained_cases), 6);
    }
  }
});

/** The case notion that loses nothing must be reported as losing nothing. */
test('a clean case notion shows no distortion at all', async () => {
  const log: Log = { events: [], objects: [], e2o: [] };
  for (let o = 0; o < 5; o++) {
    log.objects.push({ id: `O${o}`, type: 'Order' });
    for (let i = 0; i < 3; i++) {
      const e = `e${o}-${i}`;
      log.events.push({ id: e, activity: `A${i}`, ts: BASE + i * 60000 });
      log.e2o.push({ event: e, object: `O${o}` });
    }
  }
  const tables = await mount(log);
  const [order] = (await rows(impactSql(tables.object, tables.event, tables.e2o)))
    .filter((r) => r.object_type === 'Order');

  assert.equal(order.dropped, 0);
  assert.equal(order.dup_events, 0);
  assert.equal(order.empty_cases, 0);
  assert.equal(order.out_rows, order.src_events);
  assert.equal(distortionOf({
    objectType: 'Order', cases: Number(order.cases), emptyCases: 0,
    srcEvents: Number(order.src_events), retainedOnce: Number(order.retained_once),
    dupEvents: 0, dupRows: 0, dropped: 0, outRows: Number(order.out_rows),
  }), 'low');

  const found = await rows(divergenceSql(tables.object, tables.event, tables.e2o, 'Order'));
  assert.equal(found.length, 0, 'nothing repeats, so nothing can diverge');
});

/** An object no event mentions still becomes a case — the preview says so. */
test('objects without events are counted as the empty cases they become', async () => {
  const log: Log = {
    events: [{ id: 'e0', activity: 'A', ts: BASE }],
    objects: [{ id: 'O0', type: 'Order' }, { id: 'O1', type: 'Order' }, { id: 'O2', type: 'Order' }],
    e2o: [{ event: 'e0', object: 'O0' }],
  };
  const tables = await mount(log);
  const [order] = await rows(impactSql(tables.object, tables.event, tables.e2o));
  assert.equal(order.cases, 3);
  assert.equal(order.empty_cases, 2);

  const flat = await flatten(tables, 'Order');
  const [actual] = await rows(`SELECT COUNT(*) AS n FROM ${flat.trace}`);
  assert.equal(actual.n, 3, 'the compiled plan makes a case out of them too');
});
