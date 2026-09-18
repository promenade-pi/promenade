import * as duckdb from '@duckdb/duckdb-wasm';

// Served from jsdelivr rather than bundled: the `eh` wasm binary is ~36MB,
// over Cloudflare Pages' 25MB per-file deploy limit. duckdb-wasm's
// `createWorker()` fetches the worker script and reinstantiates it as a
// same-origin Blob URL, which is what makes a cross-origin worker script
// loadable at all (`new Worker(crossOriginURL)` is rejected by browsers).
//
// Pinned to the exact installed version (must match the
// "@duckdb/duckdb-wasm" entry in package.json) so the CDN copy always
// matches what @duckdb/duckdb-wasm's JS glue expects.
const DUCKDB_WASM_VERSION = '1.33.1-dev57.0';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}/dist`;
const wasm_eh = `${CDN_BASE}/duckdb-eh.wasm`;
const worker_eh = `${CDN_BASE}/duckdb-browser-eh.worker.js`;

/**
 * DuckDB bootstrap.
 *
 * The `eh` (single-threaded) bundle is pinned deliberately, not chosen by
 * `selectBundle()`. On a cross-origin-isolated page selectBundle picks `coi`
 * (pthreads), where every DuckDB extension fails to link:
 *
 *   LinkError: Import "env" "memory": mismatch in shared state of memory,
 *              declared = 0, imported = 1
 *
 * The published `wasm_threads` extension binaries are built against
 * non-shared memory while the coi build uses shared memory; an explicit
 * `INSTALL parquet` there hangs indefinitely rather than failing. Parquet is
 * the storage format, so single-threaded is the only viable configuration.
 *
 * A useful consequence: the data path does not need COOP/COEP at all, so
 * static hosting without header control needs no coi-serviceworker workaround.
 */

export interface DuckHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
  report: Record<string, unknown>;
}

export async function bootDuckDB(log: (s: string) => void = () => {}): Promise<DuckHandle> {
  const db = new duckdb.AsyncDuckDB(
    new duckdb.VoidLogger(),
    await duckdb.createWorker(worker_eh)
  );
  await db.instantiate(wasm_eh);

  // The database is opened on an `opfs://` path even though it stores nothing.
  // M0 established that duckdb-wasm never writes to such a file - it is an
  // in-memory database in practice. But opening one is what initialises the
  // OPFS runtime inside the worker, and without that a BROWSER_FSACCESS
  // `COPY ... TO` silently produces a 0-byte file. Persistence is Parquet;
  // this open exists purely to arm the OPFS filesystem.
  const root = await navigator.storage.getDirectory();
  await root.getDirectoryHandle('engine', { create: true });
  await db.open({
    path: 'opfs://engine/session.db',
    accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
  });

  const conn = await db.connect();

  const extensions: Record<string, string> = {};
  for (const ext of ['parquet', 'json']) {
    try {
      await conn.query(`INSTALL ${ext}`);
      await conn.query(`LOAD ${ext}`);
      extensions[ext] = 'ok';
    } catch (e) {
      extensions[ext] = String(e).slice(0, 160);
    }
  }

  // Insertion order costs memory on large ingests and buys nothing here.
  try { await conn.query(`SET preserve_insertion_order=false`); } catch {}

  const cfg = await conn.query(
    `SELECT current_setting('memory_limit') AS memory_limit,
            current_setting('threads') AS threads`
  );

  // DuckDB returns settings as BigInt where they are numeric; JSON.stringify
  // throws on those, so they are normalised at the boundary.
  const settings = Object.fromEntries(
    Object.entries(cfg.get(0)!.toJSON() as Record<string, unknown>)
      .map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
  );

  const report = {
    bundle: 'eh (single-thread, pinned)',
    extensions,
    ...settings,
    // No temp_directory: duckdb-wasm's OPFS binding is file-handle based and
    // has no directory a spill file could be created in, so DuckDB cannot go
    // out-of-core. Aggregations must stay within the WASM heap.
    spilling: 'unavailable (no OPFS temp_directory in duckdb-wasm)',
  };
  log(`duckdb: ${JSON.stringify(report)}`);
  return { db, conn, report };
}

export { duckdb };
