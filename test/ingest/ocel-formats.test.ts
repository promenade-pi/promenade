import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeOcel, parseBundle, parseOcelCsv, parsePromCsv, type OcelLog } from '../../src/ingest/ocel-formats.ts';
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
