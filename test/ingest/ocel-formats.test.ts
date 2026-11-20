import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOcel, parseBundle, parseOcelXml, parseOcelCsv, parsePromCsv, type OcelLog } from '../../src/ingest/ocel-formats.ts';
import { encodeOcelSqlite, parseOcelSqlite } from '../../src/ingest/ocel-sqlite.ts';

test('compact OCEL CSV preserves event/object relations through both bundle storages', async () => {
  const log = parseOcelCsv(
    'id,activity,timestamp,ot:order,total\r\n' +
    'e1,create,2024-01-01T00:00:00Z,o1#primary,2\r\n' +
    ',,,"o1{""priority"":""high""}"'
  );
  assert.equal(log.events[0].relationships[0].qualifier, 'primary');
  assert.equal(log.objects[0].attributes[0].name, 'priority');

  for (const format of ['bundle-csv', 'bundle-parquet'] as const) {
    const reopened = await parseBundle(encodeOcel(log, format));
    assert.equal(reopened.events.length, 1);
    assert.equal(reopened.objects.length, 1);
    assert.equal(reopened.events[0].relationships[0].objectId, 'o1');
  }
});

test('ProM event-table CSV becomes OCEL records', () => {
  const fromProm = parsePromCsv('Event,Activity,Timestamp,Order,amount\ne1,Create,2024-01-01T00:00:00Z,o1,4');
  assert.equal(fromProm.events[0].type, 'Create');
  assert.equal(fromProm.objects[0].type, 'Order');
});

test('an <Object>-<attr> column sets that attribute on the objects instead of becoming an object type of its own', () => {
  const log = parsePromCsv('Event,Activity,Timestamp,Order,Item,Item-weight,ot:box,ot:box-size\ne1,Place order,2026-03-02T09:14:00Z,o1,i1|i2,1.2;0.4,b1,L');
  assert.deepEqual(log.objectTypes.map((t) => t.name).sort(), ['Item', 'Order', 'box']);
  assert.deepEqual(log.objects.map((o) => `${o.type}:${o.id}`), ['Order:o1', 'Item:i1', 'Item:i2', 'box:b1']);
  assert.deepEqual(log.objects.filter((o) => o.type === 'Item').map((o) => o.attributes.map((a) => a.value)), [['1.2'], ['0.4']]);
  assert.deepEqual(log.objects.find((o) => o.id === 'b1')?.attributes.map((a) => [a.name, a.value]), [['size', 'L']]);
  assert.deepEqual(log.events[0].relationships.map((r) => r.objectId), ['o1', 'i1', 'i2', 'b1']);
  assert.deepEqual(log.events[0].attributes, []);
});

test('a case-centric Case ID column becomes a Case object, not the event id — so events of one case stay distinct and sit beside a Resource object', () => {
  const log = parsePromCsv('Case ID,Activity,Timestamp,Resource,amount\nc1,Register,2026-03-02T09:00:00Z,Anna,100\nc1,Approve,2026-03-02T10:00:00Z,Ben,\nc2,Register,2026-03-02T09:30:00Z,Anna,250');
  assert.deepEqual(log.events.map((e) => e.id), ['event-1', 'event-2', 'event-3']);
  assert.deepEqual(log.objectTypes.map((t) => t.name).sort(), ['Case', 'Resource']);
  assert.deepEqual(log.objects.map((o) => `${o.type}:${o.id}`), ['Case:c1', 'Resource:Anna', 'Resource:Ben', 'Case:c2']);
  assert.deepEqual(log.events[1].relationships.map((r) => r.objectId), ['c1', 'Ben']);
  assert.deepEqual(log.events[0].attributes, [{ name: 'amount', value: '100' }]);
  const xes = parsePromCsv('case:concept:name,concept:name,time:timestamp\nc1,Register,2026-03-02T09:00:00Z');
  assert.equal(xes.objects[0].type, 'Case');
});

test('a numeric epoch-ms event time — what DuckDB/Arrow actually hands the worker, not a pre-formatted ISO string — survives bundle export instead of collapsing to 1970', async () => {
  const time = Date.parse('2024-06-05T12:34:56Z');
  const log: OcelLog = {
    eventTypes: [{ name: 'create', attributes: [] }],
    objectTypes: [],
    events: [{ id: 'e1', type: 'create', time, attributes: [], relationships: [] }],
    objects: [],
  };
  for (const format of ['bundle-csv', 'bundle-parquet'] as const) {
    const reopened = await parseBundle(encodeOcel(log, format));
    assert.equal(reopened.events[0].time, new Date(time).toISOString());
  }
});

test('SQLite retains objects with no declared attribute values', async () => {
  const log = parseOcelCsv('id,activity,timestamp,ot:order\ne1,create,2024-01-01T00:00:00Z,o1');
  const bytes = await encodeOcelSqlite(log);
  const reopened = await parseOcelSqlite(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  assert.equal(reopened.objects.length, 1);
  assert.equal(reopened.events[0].relationships[0].objectId, 'o1');
});

test('OCEL XML: pm4py-style <object object-id> links inside an event/object are relationships, not new objects', async () => {
  const xml = `<?xml version="1.0"?><log><object-types><object-type name="files"><attributes/></object-type></object-types>
<event-types><event-type name="build"><attributes/></event-type></event-types>
<objects><object id="a" type="files"><attributes/><objects><object object-id="b" qualifier="part"/></objects></object><object id="b" type="files"><attributes/></object></objects>
<events><event id="e1" type="build" time="2014-09-18T09:12:01-07:00"><attributes><attribute name="x">1</attribute></attributes><objects><object object-id="a" qualifier="None"/><object object-id="b" qualifier="None"/></objects></event>
<event id="e2" type="build" time="2014-09-19T09:12:01-07:00"><attributes/><objects><relationship object-id="a" qualifier="q"/></objects></event></events></log>`;
  async function* source() { yield new TextEncoder().encode(xml); }
  const log = await parseOcelXml(source());
  assert.deepEqual(log.events.map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(log.events[0].relationships.map((r) => r.objectId), ['a', 'b']);
  assert.deepEqual(log.events[0].attributes.map((a) => a.name), ['x']);
  assert.deepEqual(log.events[1].relationships, [{ objectId: 'a', qualifier: 'q' }]);
  assert.deepEqual(log.objects.map((o) => o.id), ['a', 'b']);
  assert.deepEqual(log.objects[0].relationships, [{ objectId: 'b', qualifier: 'part' }]);
});
