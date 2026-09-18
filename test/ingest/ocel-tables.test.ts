import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOcelTables } from '../../src/ingest/ocel-tables.ts';

test('OCEL imports materialise every canonical relation, including empty ones', async () => {
  const queries: string[] = [];
  await ensureOcelTables({ query: async (sql: string) => { queries.push(sql); } }, 'log');
  assert.equal(queries.length, 6);
  assert.match(queries.find((sql) => sql.includes('log_event_attr'))!, /event_id VARCHAR, name VARCHAR, value VARCHAR/);
  assert.match(queries.find((sql) => sql.includes('log_object_attr'))!, /ts TIMESTAMP/);
});
