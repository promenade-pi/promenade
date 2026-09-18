import assert from 'node:assert/strict';
import test from 'node:test';
import * as arrow from 'apache-arrow';
import { authoredSemantics, buildAuthoredOcelRelations, buildEditedLogExecution } from '../../src/host/artifact/publish-log.ts';

const hello = {
  type: 'ObjectCentricEventLog',
  name: 'Hello log',
  events: [
    { event_id: 'e1', activity: 'Place order', ts: '2026-01-01T09:00:00Z', channel: 'web' },
    { event_id: 'e2', activity: 'Pay', ts: '2026-01-01T10:30:00Z', channel: '' },
  ],
  objects: [
    { object_id: 'o1', object_type: 'Order', priority: 'high' },
    { object_id: 'i1', object_type: 'Item' },
  ],
  e2o: [
    { event_id: 'e1', object_id: 'o1', qualifier: 'order' },
    { event_id: 'e1', object_id: 'o1', qualifier: 'order' },
    { event_id: 'e2', object_id: 'o1' },
  ],
  o2o: [{ source_id: 'o1', target_id: 'i1', qualifier: 'contains' }],
};

function tableOf(relations: Record<string, Uint8Array>, name: string) {
  return arrow.tableFromIPC(relations[name]);
}

test('encodes authored rows as the log relations storage expects', () => {
  const { relations, summary } = buildAuthoredOcelRelations(hello);

  const event = tableOf(relations, 'event');
  assert.deepEqual(event.schema.fields.map((f) => f.name), ['event_id', 'activity', 'ts']);
  assert.equal(event.numRows, 2);
  assert.equal(event.getChild('activity')!.get(0), 'Place order');

  const object = tableOf(relations, 'object');
  assert.deepEqual([...object.getChild('object_type')!], ['Order', 'Item']);

  assert.equal(summary.events, 2);
  assert.equal(summary.objects, 2);
  // The repeated (e1, o1, order) triple is one relation, not two.
  assert.equal(summary.e2o, 2);
  assert.equal(summary.o2o, 1);
});

test('timestamps land as the millisecond-valued column an import produces', () => {
  const { relations } = buildAuthoredOcelRelations({
    ...hello,
    events: [
      { event_id: 'e1', activity: 'A', ts: '2026-01-01T09:00:00Z' },
      { event_id: 'e2', activity: 'B' },
    ],
    e2o: [{ event_id: 'e1', object_id: 'o1' }],
  });
  const ts = tableOf(relations, 'event').getChild('ts')!;
  assert.equal(ts.type.typeId, arrow.Type.Timestamp);
  // The raw integer, not the labelled unit, is what survives the app's
  // Parquet round trip — a microsecond-valued column reads back a thousand
  // times too large (year 57983) with every type still saying "TIMESTAMP".
  assert.equal(Number(ts.get(0)), Date.parse('2026-01-01T09:00:00Z'));
  assert.equal(ts.get(1), null);
});

test('extra columns become attribute rows, blank cells do not', () => {
  const { relations, summary } = buildAuthoredOcelRelations(hello);
  const eventAttr = tableOf(relations, 'event_attr');
  assert.equal(eventAttr.numRows, 1);
  assert.equal(eventAttr.getChild('name')!.get(0), 'channel');
  assert.equal(eventAttr.getChild('value')!.get(0), 'web');
  assert.equal(summary.objectAttributes, 1);
  // Static values only: the ts column exists but carries no value.
  assert.equal(tableOf(relations, 'object_attr').getChild('ts')!.get(0), null);
});

test('a log with no attributes ships no attribute relations', () => {
  const { relations } = buildAuthoredOcelRelations({
    type: 'ObjectCentricEventLog',
    name: 'Bare',
    events: [{ event_id: 'e1', activity: 'A' }],
    objects: [{ object_id: 'o1', object_type: 'Order' }],
    e2o: [{ event_id: 'e1', object_id: 'o1' }],
  });
  assert.deepEqual(Object.keys(relations).sort(), ['e2o', 'event', 'o2o', 'object']);
});

test('rejects the mistakes hand-editing actually produces', () => {
  const cases: Array<[string, RegExp]> = [
    [JSON.stringify({ ...hello, name: ' ' }), /needs a name/],
    [JSON.stringify({ ...hello, events: [] }), /at least one event/],
  ];
  for (const [raw, expected] of cases) {
    assert.throws(() => buildAuthoredOcelRelations(JSON.parse(raw)), expected);
  }

  assert.throws(() => buildAuthoredOcelRelations({
    ...hello, events: [{ event_id: 'e1', activity: 'A' }, { event_id: 'e1', activity: 'B' }],
  }), /used twice/);
  assert.throws(() => buildAuthoredOcelRelations({
    ...hello, events: [{ event_id: 'e1', activity: '' }], e2o: [{ event_id: 'e1', object_id: 'o1' }],
  }), /Events row 1: activity is required/);
  assert.throws(() => buildAuthoredOcelRelations({
    ...hello, events: [{ event_id: 'e1', activity: 'A', ts: 'yesterday' }],
  }), /not a date\/time/);
  assert.throws(() => buildAuthoredOcelRelations({
    ...hello, e2o: [{ event_id: 'e9', object_id: 'o1' }],
  }), /no event “e9”/);
  assert.throws(() => buildAuthoredOcelRelations({
    ...hello, o2o: [{ source_id: 'o1', target_id: 'nope' }],
  }), /no object “nope”/);
  assert.throws(() => buildAuthoredOcelRelations({ ...hello, type: 'TraditionalEventLog' }), /not supported/);
});

test('declared types default to the types the rows actually use', () => {
  const semantics = authoredSemantics(hello) as any;
  assert.deepEqual(semantics.objectTypes.map((t: any) => t.name), ['Order', 'Item']);
  assert.deepEqual(semantics.eventTypes.map((t: any) => t.name), ['Place order', 'Pay']);
  // Inferred declarations claim no attribute types: a cell's text says
  // nothing about whether it was meant as an integer.
  assert.deepEqual(semantics.objectTypes[0].attributes, []);
});

test('a declared schema is kept, normalized and checked', () => {
  const semantics = authoredSemantics({
    ...hello,
    semantics: {
      eventTypes: [{ name: ' Place order ', attributes: [{ name: 'channel', type: 'string' }] }],
      objectTypes: [{ name: 'Order' }],
      sourceFormat: 'ignored',
    },
  }) as any;
  assert.deepEqual(semantics.eventTypes, [
    { name: 'Place order', attributes: [{ name: 'channel', type: 'string' }] },
  ]);
  // A type with no attributes list is a type with no attributes.
  assert.deepEqual(semantics.objectTypes, [{ name: 'Order', attributes: [] }]);
  assert.equal(semantics.sourceFormat, 'json');
});

test('a schema that could not be true is refused rather than stored', () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ objectTypes: [{ name: 'Order', attributes: [{ name: 'total', type: 'decimal' }] }] }, /unknown type “decimal”/],
    [{ objectTypes: [{ name: '' }] }, /name is required/],
    [{ objectTypes: [{ name: 'Order' }, { name: 'Order' }] }, /declared twice/],
    [{ objectTypes: [{ name: 'Order', attributes: [{ name: 'a', type: 'string' }, { name: 'a', type: 'string' }] }] }, /attribute “a” is declared twice/],
    [{ objectTypes: 'Order' }, /must be a list of declared types/],
    [{ objectTypes: [{ name: 'Order', attributes: 'total' }] }, /attributes must be a list/],
    [[], /must be an object/],
  ];
  for (const [semantics, expected] of cases) {
    assert.throws(() => authoredSemantics({ ...hello, semantics }), expected);
  }
});

test('timed object attribute values land in object_attr with their ts', () => {
  const { relations, summary } = buildAuthoredOcelRelations({
    ...hello,
    objects: [{ object_id: 'o1', object_type: 'Order', priority: 'low', total: '10' }],
    e2o: [{ event_id: 'e1', object_id: 'o1' }, { event_id: 'e2', object_id: 'o1' }],
    o2o: [],
    objectChanges: [
      { object_id: 'o1', name: 'priority', ts: '2026-01-01T09:00:00Z', value: 'low' },
      { object_id: 'o1', name: 'priority', ts: '2026-01-01T12:00:00Z', value: 'high' },
    ],
  });
  const attr = tableOf(relations, 'object_attr');
  const rows = [...Array(attr.numRows).keys()].map((i) => ({
    name: attr.getChild('name')!.get(i),
    value: attr.getChild('value')!.get(i),
    ts: attr.getChild('ts')!.get(i) === null ? null : Number(attr.getChild('ts')!.get(i)),
  }));
  // `total` stays static (null ts); `priority` becomes a history, and the
  // static value it also had is dropped rather than contradicting it.
  assert.deepEqual(rows, [
    { name: 'total', value: '10', ts: null },
    { name: 'priority', value: 'low', ts: Date.parse('2026-01-01T09:00:00Z') },
    { name: 'priority', value: 'high', ts: Date.parse('2026-01-01T12:00:00Z') },
  ]);
  assert.equal(summary.objectAttributes, 3);
  assert.equal(summary.timedObjectAttributes, 2);
});

test('a timed value that is not one is refused', () => {
  const base = {
    ...hello,
    objects: [{ object_id: 'o1', object_type: 'Order' }],
    e2o: [{ event_id: 'e1', object_id: 'o1' }, { event_id: 'e2', object_id: 'o1' }],
    o2o: [],
  };
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ object_id: 'o1', name: 'priority', value: 'high' }, /needs a ts/],
    [{ object_id: 'o1', name: 'priority', ts: '2026-01-01T09:00:00Z' }, /needs a value/],
    [{ object_id: 'ghost', name: 'priority', ts: '2026-01-01T09:00:00Z', value: 'x' }, /no object “ghost”/],
    [{ object_id: 'o1', ts: '2026-01-01T09:00:00Z', value: 'x' }, /name is required/],
    [{ object_id: 'o1', name: 'priority', ts: 'soon', value: 'x' }, /not a date/],
  ];
  for (const [change, expected] of cases) {
    assert.throws(() => buildAuthoredOcelRelations({ ...base, objectChanges: [change] }), expected);
  }
  // The same value at the same instant, twice, is one row — not an error.
  const { summary } = buildAuthoredOcelRelations({
    ...base,
    objectChanges: [
      { object_id: 'o1', name: 'p', ts: '2026-01-01T09:00:00Z', value: 'a' },
      { object_id: 'o1', name: 'p', ts: '2026-01-01T09:00:00Z', value: 'a' },
    ],
  });
  assert.equal(summary.timedObjectAttributes, 1);
});

test('an edited log is a child of the log it was edited from', () => {
  const source = { id: 'a_source', type: 'ObjectCentricEventLog' };
  const summary = { events: 1, objects: 1, e2o: 1, o2o: 0, eventAttributes: 0, objectAttributes: 0, timedObjectAttributes: 0 };
  const exec = buildEditedLogExecution({
    source, claimedSource: 'a_source', outputId: 'a_out', provider: 'run.promenade.ocel-builder', summary,
  });
  assert.deepEqual(exec.inputs, { source: ['a_source'] });
  assert.deepEqual(exec.outputs, ['a_out']);
  assert.equal(exec.actionId, 'run.promenade.ocel-builder.editLog');
  assert.equal(exec.runtime.kind, 'core');

  // A frame cannot claim provenance from an artifact it was not handed.
  assert.throws(() => buildEditedLogExecution({
    source, claimedSource: 'a_something_else', outputId: 'a_out', provider: 'p', summary,
  }), /bound to/);
  assert.throws(() => buildEditedLogExecution({
    source: { id: 'a_source', type: 'PetriNet' }, claimedSource: 'a_source', outputId: 'a_out', provider: 'p', summary,
  }), /object-centric event log/);
});
