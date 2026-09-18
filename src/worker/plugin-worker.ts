/**
 * WASM plugin worker.
 *
 * Runs a compute plugin in isolation. It has no access to OPFS, no DuckDB
 * connection and no artifact deserialisation — its only way to data is to ask
 * the host for SQL and receive Arrow back. That constraint is what lets the
 * same plugin later run against a native DuckDB over IPC without changes.
 *
 * The worker is also the unit of termination: the host kills it to enforce an
 * abort or a memory budget, which is why plugin state lives here and not in
 * the main thread.
 */
import * as arrow from 'apache-arrow';
import init, { DfgBuilder } from '../plugins/dfg/wasm/promenade_dfg.js';
import wasmUrl from '../plugins/dfg/wasm/promenade_dfg_bg.wasm?url';

let ready: Promise<unknown> | null = null;

/** Cached prepared state, keyed by the parameters the expensive stage depends on. */
let prepared: { key: string; builder: DfgBuilder; activities: string[] } | null = null;

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer);

let sqlSeq = 0;
const sqlWaiting = new Map<number, { resolve: (t: arrow.Table) => void; reject: (e: Error) => void }>();

/**
 * `ctx.sql` as seen by the plugin: SQL out, Arrow in, nothing else.
 * Implemented as an RPC back through the host rather than a direct connection.
 */
function sql(text: string): Promise<arrow.Table> {
  const id = ++sqlSeq;
  return new Promise((resolve, reject) => {
    sqlWaiting.set(id, { resolve, reject });
    post({ type: 'sql', id, text });
  });
}

const progress = (fraction: number, message?: string) =>
  post({ type: 'progress', fraction, message });

/**
 * Expensive, parameter-independent stage.
 *
 * The relational work — ordering, dictionary encoding — is done in SQL because
 * that is what a columnar engine is for. Rust gets two integer columns and
 * does the algorithm. Chunking keeps the abort check possible: a single call
 * into WASM cannot be interrupted, the loop around it can.
 */
async function prepare(
  table: string, chunkRows: number, shouldAbort: () => boolean, activityFilter: string[] = []
) {
  await (ready ??= init({ module_or_path: wasmUrl }));

  // The activity filter is applied in SQL, before anything crosses into the
  // kernel — filtering after the scan would mean scanning what was excluded.
  const esc = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
  const filter = activityFilter.length
    ? `AND activity IN (${activityFilter.map(esc).join(', ')})`
    : '';

  // Dictionary-encode activities in SQL so the boundary carries integers.
  const acts = await sql(`
    SELECT activity, CAST(row_number() OVER (ORDER BY activity) - 1 AS INTEGER) AS aid
    FROM (SELECT DISTINCT activity FROM ${table} WHERE activity IS NOT NULL ${filter})
  `);
  const activities: string[] = [];
  for (const r of acts.toArray() as any[]) activities[Number(r.aid)] = String(r.activity);

  // A DFG is defined over the event sequence of a case, not only the subset
  // of events that happens to have a timestamp.  Dropping timestamp-less
  // events here made the Rust result disagree with the relational reference
  // implementation (and could silently remove a directly-follows loop).
  // `event_idx` is the stable import-order tie breaker; events without a
  // timestamp are placed after dated events of their case consistently with
  // the SQL reference program below.
  const total = Number(
    (await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE activity IS NOT NULL ${filter}`))
      .get(0)!.toJSON().n
  );

  const builder = new DfgBuilder(activities.length);
  let offset = 0;
  while (offset < total) {
    if (shouldAbort()) { builder.free(); throw new Error('aborted'); }

    // ORDER BY belongs in the query; the kernel assumes an ordered stream and
    // says so rather than sorting again.
    const batch = await sql(`
      WITH acts AS (
        SELECT activity, CAST(row_number() OVER (ORDER BY activity) - 1 AS INTEGER) AS aid
        FROM (SELECT DISTINCT activity FROM ${table} WHERE activity IS NOT NULL ${filter})
      )
      SELECT CAST(e.trace_idx AS INTEGER) AS c, a.aid AS a
      FROM ${table} e JOIN acts a USING (activity)
      WHERE e.activity IS NOT NULL
      ORDER BY e.trace_idx, e.ts NULLS LAST, e.event_idx
      LIMIT ${chunkRows} OFFSET ${offset}
    `);

    const cases = Int32Array.from(batch.getChild('c')!.toArray() as any);
    const actIds = Int32Array.from(batch.getChild('a')!.toArray() as any);
    builder.pushChunk(cases, actIds);

    offset += chunkRows;
    progress(Math.min(1, offset / total), `${Math.min(offset, total)} / ${total} events`);
  }
  builder.finish();
  return { builder, activities };
}

const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  /**
   * Runs the action. `prepareKey` identifies the expensive stage's inputs, so a
   * parameter change that only affects the cheap stage reuses the cache — the
   * difference between a live control and an 8-second wait.
   */
  async run({ table, params, prepareKey, chunkRows = 250_000 }) {
    const t0 = performance.now();
    let reused = true;

    if (!prepared || prepared.key !== prepareKey) {
      reused = false;
      prepared?.builder.free();
      prepared = null;
      const { builder, activities } = await prepare(
        table, chunkRows, () => false,
        Array.isArray(params.activities) ? (params.activities as string[]) : []
      );
      prepared = { key: prepareKey, builder, activities };
    }
    const prepareMs = performance.now() - t0;

    const t1 = performance.now();
    const min = Number(params.minFrequency ?? 1);
    const flat = prepared.builder.filter(min);
    const starts = prepared.builder.startActivities(1);
    const ends = prepared.builder.endActivities(1);
    const counts = prepared.builder.activityCounts();
    const finalizeMs = performance.now() - t1;

    return {
      activities: prepared.activities,
      edges: flat,          // [src, dst, freq, ...]
      starts, ends, counts,
      stats: {
        rows: prepared.builder.rowCount(),
        cases: prepared.builder.caseCount(),
        totalEdges: prepared.builder.edgeCount(),
        shownEdges: flat.length / 3,
        prepareMs, finalizeMs, reused,
        heapEstimate: prepared.builder.heapEstimate(),
      },
    };
  },

  async dispose() {
    prepared?.builder.free();
    prepared = null;
    return { disposed: true };
  },
};

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;

  if (m.type === 'sqlResult') {
    const w = sqlWaiting.get(m.id);
    if (!w) return;
    sqlWaiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(arrow.tableFromIPC(m.ipc));
    return;
  }

  const { id, cmd, args } = m;
  try {
    const h = HANDLERS[cmd];
    if (!h) throw new Error(`unknown cmd ${cmd}`);
    post({ type: 'result', id, payload: await h(args || {}) });
  } catch (err: any) {
    post({ type: 'error', id, error: String(err?.message || err) });
  }
};
