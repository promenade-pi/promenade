/**
 * A real DuckDB for the transform tests.
 *
 * The repair operations that rewrite timestamps cannot be checked by asserting
 * on their SQL text: the question is what the SQL *computes*, and the failure
 * mode they exist to prevent (an event pushed past a genuine neighbour) is a
 * property of the result, not of the query string. duckdb-wasm's blocking node
 * build gives the same engine the app runs, in-process.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs')
  .replace(/duckdb-node-blocking\.cjs$/, '');
const duckdb = require(base + 'duckdb-node-blocking.cjs');

const BUNDLES = {
  mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-node-mvp.worker.cjs' },
  eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-node-eh.worker.cjs' },
};

let connection = null;

/** One connection for the whole file; each test builds its own tables. */
export async function db() {
  if (connection) return connection;
  const instance = await duckdb.createDuckDB(BUNDLES, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await instance.instantiate(() => {});
  connection = instance.connect();
  return connection;
}

export async function run(statements) {
  const conn = await db();
  for (const sql of statements) conn.query(sql);
}

export async function rows(sql) {
  const conn = await db();
  // Arrow hands back BigInt for 64-bit columns, which JSON cannot carry. Every
  // value these tests compare is a count, an index or an epoch-millisecond
  // offset, all far inside Number's exact range.
  return conn.query(sql).toArray().map((row) =>
    JSON.parse(JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? Number(v) : v)))
  );
}
