import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../../src/host/transform/compile.ts';

const OCEL_TABLES = {
  event: 'source__event',
  object: 'source__object',
  e2o: 'source__e2o',
  o2o: 'source__o2o',
  event_attr: 'source__event_attr',
  object_attr: 'source__object_attr',
};

test('an empty OCEL transform republishes every source relation', () => {
  const compiled = compilePlan('derived', OCEL_TABLES, []);

  assert.deepEqual(Object.keys(compiled.tables).sort(), Object.keys(OCEL_TABLES).sort());
  for (const logical of Object.keys(OCEL_TABLES)) {
    assert.ok(
      compiled.statements.includes(
        `CREATE OR REPLACE VIEW derived__${logical} AS SELECT * FROM source__${logical}`
      ),
      `missing identity view for ${logical}`
    );
  }
});

test('a disabled operation stays in the definition but is omitted from the compiled plan', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'filterEvents', column: 'activity', op: 'is', value: 'Load cargo', disabled: true },
    { kind: 'filterActivities', mode: 'include', values: ['Depart'], minFrequency: 0, maxFrequency: 100 },
  ]).statements.join('\n');

  assert.doesNotMatch(sql, /Load cargo/);
  assert.match(sql, /activity IN \('Depart'\)/);
});

test('an OCEL event filter cascades to event attributes and E2O only', () => {
  const compiled = compilePlan('derived', OCEL_TABLES, [
    { kind: 'filterEvents', column: 'activity', op: 'is', value: 'Load cargo' },
  ]);
  const sql = compiled.statements.join('\n');

  assert.match(sql, /derived__s0__event AS SELECT \* FROM source__event WHERE activity = 'Load cargo'/);
  assert.match(sql, /derived__s1__event_attr AS .*event_id IN \(SELECT event_id FROM derived__s0__event\)/);
  assert.match(sql, /derived__s1__e2o AS .*event_id IN \(SELECT event_id FROM derived__s0__event\)/);
  assert.doesNotMatch(sql, /s\d+__object AS/);
  assert.doesNotMatch(sql, /s\d+__o2o AS/);
});

test('case-only operations fail clearly on an OCEL plan', () => {
  assert.throws(
    () => compilePlan('derived', OCEL_TABLES, [
      { kind: 'filterCases', mode: 'contains', activity: 'Load cargo' },
    ]),
    /Case filters require a case-centric log/
  );
});

test('multi-activity filters support an explicit subset and a relative frequency range', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'filterActivities', mode: 'include', values: ['Load cargo', 'Depart'], minFrequency: 5, maxFrequency: 80 },
  ]).statements.join('\n');

  assert.match(sql, /activity IN \('Load cargo', 'Depart'\)/);
  assert.match(sql, /n \* 100\.0 .* BETWEEN 5 AND 80/);
});

test('an object-type filter cascades through the OCEL graph without dangling references', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'filterObjectTypes', mode: 'include', values: ['container'], minFrequency: 0, maxFrequency: 100 },
  ]).statements.join('\n');

  assert.match(sql, /object_type IN \('container'\)/);
  assert.match(sql, /object_attr AS SELECT \* FROM source__object_attr WHERE object_id IN/);
  assert.match(sql, /e2o AS SELECT \* FROM source__e2o WHERE object_id IN/);
  assert.match(sql, /o2o AS SELECT \* FROM source__o2o WHERE source_id IN .* AND target_id IN/);
  assert.match(sql, /event_id IN \(SELECT DISTINCT event_id FROM derived__s1__e2o\)/);
});

test('attribute and relationship-count filters compile as event/object predicates', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'filterEventAttribute', key: 'cost', mode: 'numberRange', value: '', min: 10, max: 20 },
    { kind: 'filterE2oCount', min: 2, max: 5 },
    { kind: 'filterO2oCount', min: 1 },
  ]).statements.join('\n');

  assert.match(sql, /name = 'cost' AND TRY_CAST\(value AS DOUBLE\) >= 10 AND TRY_CAST\(value AS DOUBLE\) <= 20/);
  assert.match(sql, /COUNT\(\*\) FROM .*e2o r WHERE r\.event_id = e\.event_id\) >= 2/);
  assert.match(sql, /COUNT\(\*\) FROM .*o2o r WHERE r\.source_id = o\.object_id OR r\.target_id = o\.object_id\) >= 1/);
});

test('relation count filters constrain only the selected typed and qualified relation', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    {
      kind: 'filterE2oCount',
      conditions: [{ sourceType: 'Pack order', targetType: 'item', qualifier: 'packed', min: 1, max: 4 }],
    },
    {
      kind: 'filterO2oCount',
      conditions: [{ sourceType: 'order', targetType: 'item', qualifier: 'contains', min: 2 }],
    },
  ]).statements.join('\n');

  assert.match(sql, /e\.activity <> 'Pack order'/);
  assert.match(sql, /target\.object_type = 'item'/);
  assert.match(sql, /COALESCE\(r\.qualifier, ''\) = 'packed'/);
  assert.match(sql, /o\.object_type <> 'order'/);
  assert.match(sql, /r\.source_id = o\.object_id/);
  assert.match(sql, /COALESCE\(r\.qualifier, ''\) = 'contains'/);
});

test('concrete edit operations rename real entity kinds and remove attributes only from their selected type', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'renameObjectType', from: 'sales order', to: 'order' },
    { kind: 'removeEventAttributes', activity: 'Confirm order', keys: ['cost', 'channel'] },
    { kind: 'removeObjectAttributes', objectType: 'order', keys: ['priority'] },
  ]).statements.join('\n');

  assert.match(sql, /CASE WHEN object_type = 'sales order' THEN 'order'/);
  assert.match(sql, /a\.name IN \('cost', 'channel'\).*activity = 'Confirm order'/s);
  assert.match(sql, /a\.name IN \('priority'\).*object_type = 'order'/s);
});

test('a new rename refuses to overwrite an existing category while merge is explicit relabelling', () => {
  const sql = compilePlan('derived', OCEL_TABLES, [
    { kind: 'renameActivity', from: 'Pack', to: 'Ship', allowMerge: false },
    { kind: 'mergeActivities', sources: ['Pack', 'Repack'], target: 'Ship' },
    { kind: 'mergeObjectTypes', sources: ['sales order', 'return order'], target: 'order' },
  ]).statements.join('\n');

  assert.match(sql, /activity = 'Pack' AND NOT EXISTS \(SELECT 1 FROM source__event rename_target WHERE rename_target\.activity = 'Ship'\)/);
  assert.match(sql, /CASE WHEN activity IN \('Pack', 'Repack'\) THEN 'Ship'/);
  assert.match(sql, /CASE WHEN object_type IN \('sales order', 'return order'\) THEN 'order'/);
});
