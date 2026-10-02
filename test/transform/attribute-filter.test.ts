import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../../src/host/transform/compile.ts';
import { ATTRIBUTE_FILTER_MODES, NEGATED_ATTRIBUTE_MODE, isComplete, type AttributeFilterMode, type TransformOp } from '../../src/host/transform/types.ts';
import { run, rows } from './duckdb.mjs';

/**
 * Every attribute-filter mode, run on a real DuckDB and checked against an
 * independent oracle written here in JS — not against the SQL text.
 *
 * The fixture values are picked to separate the plausible wrong answers:
 * "9" vs "10" (numeric, not lexicographic, comparison), "50%" and "a_b"
 * (LIKE wildcards that must be literal), mixed case (ILIKE vs equals),
 * offset timestamps (normalised to UTC), "12" (a number DuckDB will not
 * read as a date), and entities without the attribute at all (which the
 * negative modes must keep). OCEL objects carry several values each, so
 * "any value passes" and "no value passes" are actually different.
 */

const VALUES = [
  '10', '9', '100', '-2.5', '1e3', '12', 'abc', 'ABC def', '50%', 'a_b', 'Ab%c',
  '2024-01-02', '2024-01-02T10:00:00+02:00', '2024-03-15 08:30', 'not a date',
];

const NUM_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i;
const asNumber = (s: string) => (NUM_RE.test(s) ? Number(s) : null);

/** ISO-ish date or datetime; a value without an offset is read as UTC, as DuckDB's TIMESTAMP does. */
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?(Z|[+-]\d{2}:?\d{2})?$/;
function asDate(s: string): number | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  return Date.parse(`${m[1]}T${m[2] ?? '00:00:00'}${m[2]?.length === 5 ? ':00' : ''}${m[3] ?? 'Z'}`);
}

type AttrOp = Extract<TransformOp, { kind: 'filterEventAttribute' }>;

/** The oracle: does one value pass the *positive* form of the test? */
function passes(op: AttrOp, mode: AttributeFilterMode, s: string): boolean {
  const lower = s.toLowerCase(), x = op.value.toLowerCase();
  switch (mode) {
    case 'has': return true;
    case 'equals': return s === op.value;
    case 'oneOf': return (op.values ?? []).includes(s);
    case 'contains': return lower.includes(x);
    case 'startsWith': return lower.startsWith(x);
    case 'endsWith': return lower.endsWith(x);
    case 'regex': {
      // RE2's leading `(?i)` is not JS syntax; the oracle spells it as a flag.
      const ci = op.value.startsWith('(?i)');
      return new RegExp(ci ? op.value.slice(4) : op.value, ci ? 'i' : '').test(s);
    }
    case 'atLeast': { const n = asNumber(s); return n != null && n >= op.min!; }
    case 'atMost': { const n = asNumber(s); return n != null && n <= op.max!; }
    case 'numberRange': {
      const n = asNumber(s);
      return n != null && (op.min == null || n >= op.min) && (op.max == null || n <= op.max);
    }
    case 'onOrAfter': { const d = asDate(s); return d != null && d >= asDate(op.from!)!; }
    case 'onOrBefore': { const d = asDate(s); return d != null && d <= asDate(op.to!)!; }
    case 'dateRange': {
      const d = asDate(s);
      return d != null && (!op.from || d >= asDate(op.from)!) && (!op.to || d <= asDate(op.to)!);
    }
    default: throw new Error(`no oracle for ${mode}`);
  }
}

/** Which entities the oracle keeps, given each entity's values of the key. */
function expected(op: AttrOp, valuesOf: Map<string, string[]>): string[] {
  const twin = NEGATED_ATTRIBUTE_MODE[op.mode];
  const keep = [...valuesOf].filter(([, vs]) => vs.some((v) => passes(op, twin ?? op.mode, v)));
  const hit = new Set(keep.map(([id]) => id));
  return [...valuesOf.keys()].filter((id) => (twin ? !hit.has(id) : hit.has(id))).sort();
}

const OPS: AttrOp[] = ([
  { mode: 'has' }, { mode: 'missing' },
  { mode: 'equals', value: 'abc' }, { mode: 'notEquals', value: 'abc' },
  { mode: 'oneOf', values: ['9', 'abc', 'nope'] }, { mode: 'noneOf', values: ['9', 'abc'] },
  { mode: 'contains', value: 'abc' }, { mode: 'notContains', value: 'ABC' },
  { mode: 'contains', value: '%' }, { mode: 'contains', value: '_' },
  { mode: 'startsWith', value: 'a' }, { mode: 'endsWith', value: 'C' },
  { mode: 'regex', value: '^[0-9]+$' }, { mode: 'regex', value: '^a' }, { mode: 'regex', value: '(?i)^a' },
  { mode: 'atLeast', min: 10 }, { mode: 'atMost', max: 9 }, { mode: 'atMost', max: -1 },
  { mode: 'numberRange', min: 9, max: 100 }, { mode: 'numberRange', min: 50 },
  { mode: 'onOrAfter', from: '2024-01-02T08:00' }, { mode: 'onOrBefore', to: '2024-01-02T07:59' },
  { mode: 'dateRange', from: '2024-01-01', to: '2024-02-01' }, { mode: 'dateRange', to: '2024-12-31' },
] as Partial<AttrOp>[]).map((o) => ({ kind: 'filterEventAttribute', key: 'v', value: '', ...o }) as AttrOp);

test('every mode has an oracle case here', () => {
  const covered = new Set(OPS.map((o) => o.mode));
  assert.deepEqual(ATTRIBUTE_FILTER_MODES.filter((m) => !covered.has(m)), []);
  for (const op of OPS) assert.ok(isComplete(op), `${op.mode} should be complete`);
});

/** Entity i carries VALUES[i]; the last two carry only an unrelated key. */
const ids = [...VALUES.keys(), VALUES.length, VALUES.length + 1];

test('case attribute filters keep exactly the oracle\'s cases', async () => {
  const p = 'attr_case';
  const traceAttr = VALUES.map((v, i) => `(${i}, 'v', 'string', ${lit(v)})`)
    .concat([`(${VALUES.length}, 'w', 'string', 'x')`]).join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${p}__trace AS SELECT i AS trace_idx, 'c' || i AS case_id FROM range(${ids.length}) t(i)`,
    `CREATE OR REPLACE TABLE ${p}__event AS SELECT i AS event_idx, i AS trace_idx, 'A' AS activity, ` +
      `TIMESTAMP '2024-01-01' AS ts, CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource FROM range(${ids.length}) t(i)`,
    `CREATE OR REPLACE TABLE ${p}__event_attr AS SELECT CAST(NULL AS BIGINT) AS event_idx, CAST(NULL AS VARCHAR) AS key, ` +
      `CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`,
    `CREATE OR REPLACE TABLE ${p}__trace_attr AS SELECT * FROM (VALUES ${traceAttr}) v(trace_idx, key, type, value)`,
  ]);
  const valuesOf = new Map(ids.map((i) => [String(i), i < VALUES.length ? [VALUES[i]] : []]));
  for (const base of OPS) {
    const op = { ...base, kind: 'filterObjectAttribute' } as unknown as AttrOp;
    const out = `${p}_out`;
    await run(compilePlan(out, tables(p, 'xes'), [op as TransformOp]).statements);
    const got = (await rows(`SELECT trace_idx FROM ${out}__trace`)).map((r: any) => String(r.trace_idx)).sort();
    assert.deepEqual(got, expected(op, valuesOf), `case scope · ${JSON.stringify(base)}`);
  }
});

test('event attribute filters keep exactly the oracle\'s events', async () => {
  const p = 'attr_event';
  const eventAttr = VALUES.map((v, i) => `(${i}, 'v', 'string', ${lit(v)})`)
    .concat([`(${VALUES.length}, 'w', 'string', 'x')`]).join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${p}__trace AS SELECT 0 AS trace_idx, 'c0' AS case_id`,
    `CREATE OR REPLACE TABLE ${p}__event AS SELECT i AS event_idx, 0 AS trace_idx, 'A' AS activity, ` +
      `TIMESTAMP '2024-01-01' + INTERVAL (i) MINUTE AS ts, CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource FROM range(${ids.length}) t(i)`,
    `CREATE OR REPLACE TABLE ${p}__event_attr AS SELECT * FROM (VALUES ${eventAttr}) v(event_idx, key, type, value)`,
    `CREATE OR REPLACE TABLE ${p}__trace_attr AS SELECT CAST(NULL AS BIGINT) AS trace_idx, CAST(NULL AS VARCHAR) AS key, ` +
      `CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
  const valuesOf = new Map(ids.map((i) => [String(i), i < VALUES.length ? [VALUES[i]] : []]));
  for (const op of OPS) {
    const out = `${p}_out`;
    await run(compilePlan(out, tables(p, 'xes'), [op as TransformOp]).statements);
    const got = (await rows(`SELECT event_idx FROM ${out}__event`)).map((r: any) => String(r.event_idx)).sort();
    assert.deepEqual(got, expected(op, valuesOf), `event scope · ${JSON.stringify(op)}`);
  }
});

test('object attribute filters test any recorded value, and negations test none', async () => {
  const p = 'attr_obj';
  // Object j records the values at j, j+1 and j+2 (mod n) over time; three
  // objects record none of `v`. Every object has an event so none is pruned
  // for being unreferenced.
  const n = VALUES.length;
  const objs = Array.from({ length: n + 3 }, (_, j) => `o${j}`);
  const valuesOf = new Map(objs.map((id, j) => [id, j < n ? [VALUES[j], VALUES[(j + 1) % n], VALUES[(j + 4) % n]] : []]));
  const objectAttr = [...valuesOf].flatMap(([id, vs]) => vs.map((v, k) =>
    `(${lit(id)}, 'v', ${lit(v)}, TIMESTAMP '2024-01-01' + INTERVAL (${k}) DAY)`))
    .concat([`('o${n}', 'w', 'x', TIMESTAMP '2024-01-01')`]).join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${p}__object AS SELECT * FROM (VALUES ${objs.map((o) => `(${lit(o)}, 'T')`).join(', ')}) v(object_id, object_type)`,
    `CREATE OR REPLACE TABLE ${p}__event AS SELECT * FROM (VALUES ${objs.map((o) => `(${lit('e_' + o)}, 'A', TIMESTAMP '2024-01-01')`).join(', ')}) v(event_id, activity, ts)`,
    `CREATE OR REPLACE TABLE ${p}__e2o AS SELECT * FROM (VALUES ${objs.map((o) => `(${lit('e_' + o)}, ${lit(o)}, 'q')`).join(', ')}) v(event_id, object_id, qualifier)`,
    `CREATE OR REPLACE TABLE ${p}__o2o AS SELECT CAST(NULL AS VARCHAR) AS source_id, CAST(NULL AS VARCHAR) AS target_id, CAST(NULL AS VARCHAR) AS qualifier WHERE false`,
    `CREATE OR REPLACE TABLE ${p}__object_attr AS SELECT * FROM (VALUES ${objectAttr}) v(object_id, name, value, ts)`,
    `CREATE OR REPLACE TABLE ${p}__event_attr AS SELECT CAST(NULL AS VARCHAR) AS event_id, CAST(NULL AS VARCHAR) AS name, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
  for (const base of OPS) {
    const op = { ...base, kind: 'filterObjectAttribute' } as unknown as AttrOp;
    const out = `${p}_out`;
    await run(compilePlan(out, tables(p, 'ocel'), [op as TransformOp]).statements);
    const got = (await rows(`SELECT object_id FROM ${out}__object`)).map((r: any) => String(r.object_id)).sort();
    assert.deepEqual(got, expected(op, valuesOf), `object scope · ${JSON.stringify(base)}`);
  }
});

/**
 * The same attribute name on two types is two attributes. Here every even
 * entity is of type X and every odd one of type Y, both carrying `v`; a test
 * scoped to X must decide X's entities exactly as the oracle does and leave
 * every Y entity in place — including for the negative modes, whose
 * complement is taken within X only.
 */
test('a type-scoped filter tests only that type and keeps every other type', async () => {
  const typeOf = (i: number) => (i % 2 === 0 ? 'X' : 'Y');
  const scopedExpected = (op: AttrOp, valuesOf: Map<string, string[]>, idx: (id: string) => number) => {
    const ofX = new Map([...valuesOf].filter(([id]) => typeOf(idx(id)) === 'X'));
    const others = [...valuesOf.keys()].filter((id) => typeOf(idx(id)) !== 'X');
    return [...expected(op, ofX), ...others].sort();
  };

  // Events of a case-centric log, typed by activity.
  const pe = 'attr_scoped_event';
  const eventAttr = VALUES.map((v, i) => `(${i}, 'v', 'string', ${lit(v)})`).join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${pe}__trace AS SELECT 0 AS trace_idx, 'c0' AS case_id`,
    `CREATE OR REPLACE TABLE ${pe}__event AS SELECT i AS event_idx, 0 AS trace_idx, ` +
      `CASE WHEN i % 2 = 0 THEN 'X' ELSE 'Y' END AS activity, TIMESTAMP '2024-01-01' + INTERVAL (i) MINUTE AS ts, ` +
      `CAST(NULL AS VARCHAR) AS lifecycle, CAST(NULL AS VARCHAR) AS resource FROM range(${ids.length}) t(i)`,
    `CREATE OR REPLACE TABLE ${pe}__event_attr AS SELECT * FROM (VALUES ${eventAttr}) v(event_idx, key, type, value)`,
    `CREATE OR REPLACE TABLE ${pe}__trace_attr AS SELECT CAST(NULL AS BIGINT) AS trace_idx, CAST(NULL AS VARCHAR) AS key, ` +
      `CAST(NULL AS VARCHAR) AS type, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
  const eventValues = new Map(ids.map((i) => [String(i), i < VALUES.length ? [VALUES[i]] : []]));
  for (const base of OPS) {
    const op = { ...base, activity: 'X' } as AttrOp;
    await run(compilePlan(`${pe}_out`, tables(pe, 'xes'), [op as TransformOp]).statements);
    const got = (await rows(`SELECT event_idx FROM ${pe}_out__event`)).map((r: any) => String(r.event_idx)).sort();
    assert.deepEqual(got, scopedExpected(op, eventValues, Number), `scoped event · ${JSON.stringify(base)}`);
  }

  // Objects of an OCEL log, typed by object type.
  const po = 'attr_scoped_obj';
  const objs = ids.map((i) => `o${i}`);
  const objectValues = new Map(objs.map((id, i) => [id, i < VALUES.length ? [VALUES[i]] : []]));
  const objectAttr = [...objectValues].flatMap(([id, vs]) => vs.map((v) => `(${lit(id)}, 'v', ${lit(v)}, TIMESTAMP '2024-01-01')`)).join(', ');
  await run([
    `CREATE OR REPLACE TABLE ${po}__object AS SELECT * FROM (VALUES ${objs.map((o, i) => `(${lit(o)}, '${typeOf(i)}')`).join(', ')}) v(object_id, object_type)`,
    `CREATE OR REPLACE TABLE ${po}__event AS SELECT * FROM (VALUES ${objs.map((o) => `(${lit('e_' + o)}, 'A', TIMESTAMP '2024-01-01')`).join(', ')}) v(event_id, activity, ts)`,
    `CREATE OR REPLACE TABLE ${po}__e2o AS SELECT * FROM (VALUES ${objs.map((o) => `(${lit('e_' + o)}, ${lit(o)}, 'q')`).join(', ')}) v(event_id, object_id, qualifier)`,
    `CREATE OR REPLACE TABLE ${po}__o2o AS SELECT CAST(NULL AS VARCHAR) AS source_id, CAST(NULL AS VARCHAR) AS target_id, CAST(NULL AS VARCHAR) AS qualifier WHERE false`,
    `CREATE OR REPLACE TABLE ${po}__object_attr AS SELECT * FROM (VALUES ${objectAttr}) v(object_id, name, value, ts)`,
    `CREATE OR REPLACE TABLE ${po}__event_attr AS SELECT CAST(NULL AS VARCHAR) AS event_id, CAST(NULL AS VARCHAR) AS name, CAST(NULL AS VARCHAR) AS value WHERE false`,
  ]);
  for (const base of OPS) {
    const op = { ...base, kind: 'filterObjectAttribute', objectType: 'X' } as unknown as AttrOp;
    await run(compilePlan(`${po}_out`, tables(po, 'ocel'), [op as TransformOp]).statements);
    const got = (await rows(`SELECT object_id FROM ${po}_out__object`)).map((r: any) => String(r.object_id)).sort();
    assert.deepEqual(got, scopedExpected(op, objectValues, (id) => Number(id.slice(1))), `scoped object · ${JSON.stringify(base)}`);
  }
});

test('an unfinished regex is incomplete rather than a failing query', () => {
  assert.equal(isComplete({ kind: 'filterEventAttribute', key: 'v', mode: 'regex', value: '([a-' }), false);
  assert.equal(isComplete({ kind: 'filterEventAttribute', key: 'v', mode: 'oneOf', value: '', values: [] }), false);
  assert.equal(isComplete({ kind: 'filterEventAttribute', key: 'v', mode: 'atLeast', value: '' }), false);
  // RE2's case-insensitive flag group is valid, even though JS's parser has no such syntax.
  assert.equal(isComplete({ kind: 'filterEventAttribute', key: 'v', mode: 'regex', value: '(?i)^abc' }), true);
});

function lit(v: string) { return `'${v.replace(/'/g, "''")}'`; }

function tables(p: string, kind: 'xes' | 'ocel') {
  return kind === 'xes'
    ? { event: `${p}__event`, event_attr: `${p}__event_attr`, trace: `${p}__trace`, trace_attr: `${p}__trace_attr` }
    : {
        event: `${p}__event`, event_attr: `${p}__event_attr`, object: `${p}__object`,
        object_attr: `${p}__object_attr`, e2o: `${p}__e2o`, o2o: `${p}__o2o`,
      };
}
