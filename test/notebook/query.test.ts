import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuerySql } from '../../src/host/notebook/query.ts';
import type { Artifact } from '../../src/host/artifact/types.ts';

function xesLog(id = 'a_xes'): Artifact {
  return {
    id, name: 'log.xes', type: 'TraditionalEventLog', createdAt: '2024-01-01T00:00:00Z',
    storage: { kind: 'parquet', files: { event: 'x', event_attr: 'x', trace: 'x', trace_attr: 'x' } },
    meta: {}, producedBy: null, inputs: [],
  };
}

function ocelLog(id = 'a_ocel'): Artifact {
  return {
    id, name: 'log.json', type: 'ObjectCentricEventLog', createdAt: '2024-01-01T00:00:00Z',
    storage: { kind: 'parquet', files: { event: 'x', object: 'x', e2o: 'x', o2o: 'x', event_attr: 'x', object_attr: 'x' } },
    meta: {}, producedBy: null, inputs: [],
  };
}

test('events() never leaks the physical table name into the query text a caller could log or misuse — it only sees the artifact id, folded into a sanitized identifier', () => {
  const sql = buildQuerySql(xesLog('a_abc'), { artifactId: 'a_abc', op: 'events' });
  assert.match(sql, /a_abc__event\b/);
  assert.match(sql, /LIMIT 10000/);
});

test('a caller-supplied limit is honored, up to the max', () => {
  const sql = buildQuerySql(xesLog(), { artifactId: 'a_xes', op: 'events', limit: 25 });
  assert.match(sql, /LIMIT 25/);
});

test('an absurd limit is clamped rather than passed through verbatim', () => {
  const sql = buildQuerySql(xesLog(), { artifactId: 'a_xes', op: 'events', limit: 999_999_999 });
  assert.match(sql, /LIMIT 200000/);
});

test('columns are allowlisted against the logical schema, not interpolated as-is', () => {
  const sql = buildQuerySql(xesLog(), { artifactId: 'a_xes', op: 'events', columns: ['activity', 'ts'] });
  assert.match(sql, /SELECT "activity", "ts" FROM/);
});

test('an unknown column is silently dropped from the select list rather than injected into SQL', () => {
  const sql = buildQuerySql(xesLog(), {
    artifactId: 'a_xes', op: 'events', columns: ['activity', "'; DROP TABLE event; --"],
  });
  assert.doesNotMatch(sql, /DROP TABLE/);
  assert.match(sql, /SELECT "activity" FROM/);
});

test('variants() aggregates per-trace activity sequences on a TraditionalEventLog', () => {
  const sql = buildQuerySql(xesLog(), { artifactId: 'a_xes', op: 'variants' });
  assert.match(sql, /string_agg\(activity/);
  assert.match(sql, /GROUP BY trace_idx/);
});

test('cases()/variants()/attributes() refuse to run against an ObjectCentricEventLog', () => {
  for (const op of ['cases', 'variants', 'attributes'] as const) {
    assert.throws(() => buildQuerySql(ocelLog(), { artifactId: 'a_ocel', op }), /TraditionalEventLog/);
  }
});

test('objects()/e2o()/o2o()/event_attributes()/object_attributes() refuse to run against a TraditionalEventLog', () => {
  for (const op of ['objects', 'e2o', 'o2o', 'event_attributes', 'object_attributes'] as const) {
    assert.throws(() => buildQuerySql(xesLog(), { artifactId: 'a_xes', op }), /ObjectCentricEventLog/);
  }
});

test('e2o()/o2o() resolve to the OCEL physical relation tables', () => {
  const e2o = buildQuerySql(ocelLog('a_o'), { artifactId: 'a_o', op: 'e2o' });
  assert.match(e2o, /a_o__e2o\b/);
  const o2o = buildQuerySql(ocelLog('a_o'), { artifactId: 'a_o', op: 'o2o' });
  assert.match(o2o, /a_o__o2o\b/);
});

test('activities() works for either log family', () => {
  assert.match(buildQuerySql(xesLog(), { artifactId: 'a_xes', op: 'activities' }), /GROUP BY activity/);
  assert.match(buildQuerySql(ocelLog(), { artifactId: 'a_ocel', op: 'activities' }), /GROUP BY activity/);
});
