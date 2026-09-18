/**
 * Generic WASM plugin worker.
 *
 * Unlike the first DFG worker, this one imports nothing plugin-specific: it
 * receives the glue source and the wasm bytes from the host and drives
 * whatever kernel the manifest names, through one ABI:
 *
 *   new Kernel(nActivities)
 *   .pushChunk(Int32Array cases, Int32Array activities,
 *              Float64Array timestampsMs?, Int32Array resources?)
 *   .finish()
 *   .finalize(params) -> result
 *   .free()
 *
 * The two stages are the host's contract, not a per-plugin invention: the scan
 * is expensive and parameter-independent and is cached here; `finalize` is
 * cheap and is what a live parameter control calls.
 */
import * as arrow from 'apache-arrow';

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer);

let sqlSeq = 0;
const sqlWaiting = new Map<number, { resolve: (t: arrow.Table) => void; reject: (e: Error) => void }>();

/** The plugin's only data door, serviced by the host. */
function sql(text: string): Promise<arrow.Table> {
  const id = ++sqlSeq;
  return new Promise((resolve, reject) => {
    sqlWaiting.set(id, { resolve, reject });
    post({ type: 'sql', id, text });
  });
}

const progress = (fraction: number, message?: string) =>
  post({ type: 'progress', fraction, message });

/** Loaded kernel module, keyed by plugin id. */
const modules = new Map<string, any>();

/** Cached scan, keyed by everything the expensive stage depends on. */
let scan: { key: string; kernel: any; activities: string[] } | null = null;

/** Cancellation flag, raised by the host between chunks. */
let aborted = false;

async function loadKernel(pluginId: string, glue: string, wasmBytes: Uint8Array, className: string) {
  const cached = modules.get(pluginId);
  if (cached) return cached[className];

  // wasm-pack --target web emits an ES module. Importing it from a blob URL
  // keeps the host free of any build-time knowledge of the plugin.
  const url = URL.createObjectURL(new Blob([glue], { type: 'text/javascript' }));
  try {
    const mod = await import(/* @vite-ignore */ url);
    await mod.default({ module_or_path: wasmBytes });
    modules.set(pluginId, mod);
    const Kernel = mod[className];
    if (!Kernel) throw new Error(`kernel class "${className}" not exported by the package`);
    return Kernel;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * How many distinct `org:resource` values a resource-scanning kernel is
 * offered. Beyond this the tail is delivered as "no resource" (`-1`): a
 * dictionary that large has stopped being an organizational perspective and
 * started being an identifier column, and the transfer cost is real.
 */
const MAX_RESOURCES = 4096;

/**
 * Expensive stage: one ordered pass over the events.
 *
 * Relational work stays in SQL — ordering, dictionary encoding, and the
 * activity filter that keeps the kernel inside its 64-activity bound. The
 * kernel receives two integer columns, an optional timestamp vector, and —
 * for a kernel that declares `kernel.scan.resource` — a dictionary-encoded
 * resource column.
 */
async function runScan(opts: {
  Kernel: any; table: string; maxActivities: number; chunkRows: number;
  order: 'timestamp' | 'timestampNullsLast' | 'log'; includeEmptyTraces: boolean;
  activityIds: 'frequency' | 'firstAppearance';
  classifier: 'activity' | 'activityLifecycle';
  resource: boolean;
}) {
  const { Kernel, table, maxActivities, chunkRows, order, includeEmptyTraces,
          activityIds, classifier, resource: withResource } = opts;

  // Two orderings, declared per plugin in the manifest. Timestamp order is the
  // default and what the DFG, Alpha and Heuristics kernels were built on. Log
  // order exists because some algorithms are defined over the sequence the
  // events were recorded in — and because a log with no timestamps at all
  // yields nothing under the timestamp rule, which is a silent empty result
  // rather than an error.
  const timed = order === 'timestamp';
  const timestampNullsLast = order === 'timestampNullsLast';
  const eventFilter = timed ? 'AND ts IS NOT NULL' : '';
  const eventFilterE = timed ? 'AND e.ts IS NOT NULL' : '';
  const orderBy = timed
    ? 'c, ts, ord'
    : timestampNullsLast
      ? 'c, ts NULLS LAST, ord'
      : 'c, ord';
  // Lifecycle alignment is performed against an expanded model. The delimiter
  // is intentionally unprintable so an activity called "A · start" cannot be
  // confused with the lifecycle event A/start.
  const activityExpr = classifier === 'activityLifecycle'
    ? "e.activity || chr(31) || CASE lower(coalesce(e.lifecycle, '')) WHEN 'enqueue' THEN 'enqueue' WHEN 'start' THEN 'start' ELSE 'complete' END"
    : 'e.activity';
  const activityExprBare = classifier === 'activityLifecycle'
    ? "activity || chr(31) || CASE lower(coalesce(lifecycle, '')) WHEN 'enqueue' THEN 'enqueue' WHEN 'start' THEN 'start' ELSE 'complete' END"
    : 'activity';

  /**
   * Activity numbering.
   *
   * The activity *limit* always keeps the most frequent, whichever numbering is
   * used — dropping a rare activity is bad enough without dropping a common one
   * instead. What the manifest chooses is how the survivors are numbered.
   *
   * `frequency` (default) numbers them most-frequent-first, which is what the
   * DFG, Alpha and Heuristics kernels have always seen and what makes their
   * truncation bound read naturally.
   *
   * `firstAppearance` numbers them in the order they first occur in the log.
   * That looks like an implementation detail and is not: an algorithm whose
   * behavior is defined against a reference implementation inherits that
   * reference's tie-breaks, and the reference numbers activities as it reads
   * them. Under frequency numbering the Inductive Miner still produces a valid
   * model — just, on some logs, a different one from ProM.
   */
  const actsCte = activityIds === 'firstAppearance'
    ? `
    SELECT activity, CAST(row_number() OVER (ORDER BY first_seen) - 1 AS INTEGER) AS aid
    FROM (
      SELECT activity, first_seen
      FROM (SELECT ${activityExprBare} AS activity, COUNT(*) AS n, MIN(event_idx) AS first_seen FROM ${table}
            WHERE activity IS NOT NULL ${eventFilter} GROUP BY 1)
      QUALIFY row_number() OVER (ORDER BY n DESC, activity) <= ${maxActivities}
    )`
    : `
    SELECT activity, CAST(row_number() OVER (ORDER BY n DESC, activity) - 1 AS INTEGER) AS aid
    FROM (SELECT ${activityExprBare} AS activity, COUNT(*) AS n FROM ${table}
          WHERE activity IS NOT NULL ${eventFilter} GROUP BY 1)
    QUALIFY aid < ${maxActivities}`;

  const acts = await sql(actsCte);
  const activities: string[] = [];
  for (const r of acts.toArray() as any[]) activities[Number(r.aid)] = String(r.activity);

  /**
   * A case with no surviving events produces no rows at all, so a kernel fed
   * only `(case, activity)` pairs cannot tell it apart from a case that does
   * not exist. For most algorithms that is harmless. For the Inductive Miner it
   * is not: an empty trace is evidence that the whole block is skippable, and
   * losing it silently changes the model.
   *
   * Kernels that ask for it get one synthetic row per empty case, carrying
   * activity `-1`. Cases can also *become* empty here — through the activity
   * limit, or a null activity — and those count too.
   */
  const traceTable = table.replace(/__event$/, '__trace');
  // Resources are dictionary-encoded exactly like activities, and by the same
  // rule (most frequent first). A left join, not an inner one: an event with
  // no resource must still reach the kernel, carrying `-1`.
  const resCte = `
    SELECT resource, CAST(row_number() OVER (ORDER BY n DESC, resource) - 1 AS INTEGER) AS rid
    FROM (SELECT resource, COUNT(*) AS n FROM ${table}
          WHERE resource IS NOT NULL GROUP BY 1)
    QUALIFY rid < ${MAX_RESOURCES}`;
  const keptRes = withResource ? ', CAST(COALESCE(r.rid, -1) AS INTEGER) AS res' : '';
  const keptResJoin = withResource ? `LEFT JOIN res r ON r.resource = e.resource` : '';
  const emptiesRes = withResource ? ', -1 AS res' : '';
  const keptCte = `
    SELECT CAST(e.trace_idx AS INTEGER) AS c, a.aid AS a, e.ts AS ts, e.event_idx AS ord${keptRes}
    FROM ${table} e JOIN acts a ON a.activity = ${activityExpr} ${keptResJoin}
    WHERE TRUE ${eventFilterE}`;
  const emptiesCte = `
    SELECT CAST(t.trace_idx AS INTEGER) AS c, -1 AS a, NULL AS ts, -1 AS ord${emptiesRes}
    FROM ${traceTable} t
    WHERE NOT EXISTS (SELECT 1 FROM kept k WHERE k.c = CAST(t.trace_idx AS INTEGER))`;
  const rowsCte = includeEmptyTraces
    ? `SELECT * FROM kept UNION ALL SELECT * FROM empties`
    : `SELECT * FROM kept`;
  const ctes = [`acts AS (${actsCte})`];
  if (withResource) ctes.push(`res AS (${resCte})`);
  ctes.push(`kept AS (${keptCte})`);
  if (includeEmptyTraces) ctes.push(`empties AS (${emptiesCte})`);
  const withClause = `WITH ${ctes.join(', ')}`;

  const totalRow = await sql(`${withClause} SELECT COUNT(*) AS n FROM (${rowsCte})`);
  const total = Number(totalRow.get(0)!.toJSON().n);

  const resources: string[] = [];
  if (withResource) {
    const rs = await sql(resCte);
    for (const r of rs.toArray() as any[]) resources[Number(r.rid)] = String(r.resource);
  }

  const kernel = new Kernel(activities.length);
  // Kernels that put labels in their own output need the names; the rest
  // ignore this and let the host attach them.
  kernel.setActivityNames?.(activities);
  if (withResource) kernel.setResourceNames?.(resources);

  let offset = 0;
  while (offset < total) {
    // A WASM call cannot be interrupted from outside, so the abort check lives
    // between chunks. This is what makes the signal meaningful rather than
    // decorative.
    if (aborted) { kernel.free(); throw new Error('aborted'); }

    // `tm` stays in milliseconds — every wasm kernel's duration arithmetic is
    // written against that unit — but as a fractional value rather than a
    // truncated integer. Ingest preserves microseconds, and a kernel that
    // could not see them would order sub-millisecond events arbitrarily, which
    // is exactly what the tied-timestamp work exists to prevent. Epoch
    // microseconds need 51 bits, so a DOUBLE carries them exactly.
    const batch = await sql(`
      ${withClause}
      SELECT c, a, CAST(COALESCE(epoch_us(ts) / 1000.0, -1) AS DOUBLE) AS tm${withResource ? ', res' : ''} FROM (${rowsCte})
      ORDER BY ${orderBy}
      LIMIT ${chunkRows} OFFSET ${offset}
    `);
    kernel.pushChunk(
      Int32Array.from(batch.getChild('c')!.toArray() as any),
      Int32Array.from(batch.getChild('a')!.toArray() as any),
      // Existing two-argument kernels ignore the extra JS arguments. IVM
      // consumes the timestamps to normalise its animation speed from real
      // elapsed time; the Fuzzy Miner consumes the resources as well.
      Float64Array.from(batch.getChild('tm')!.toArray() as any, (value: any) => Number(value)),
      withResource
        ? Int32Array.from(batch.getChild('res')!.toArray() as any)
        : undefined
    );
    offset += chunkRows;
    progress(Math.min(1, offset / total), `${Math.min(offset, total)} / ${total} events`);
  }
  kernel.finish();
  return { kernel, activities };
}

const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  async run({ pluginId, glue, wasm, className, table, params, prepareKey,
              scanOrder = 'timestamp', scanEmptyTraces = false,
              scanActivityIds = 'frequency', scanClassifier = 'activity',
              scanResource = false, chunkRows = 250_000,
              valueFinalize = false }) {
    aborted = false;
    const Kernel = await loadKernel(pluginId, glue, new Uint8Array(wasm), className);

    // Inline artifacts have no SQL table by design.  The value-finalize ABI
    // keeps their conversion in WASM (and therefore in Rust where a plugin
    // chooses it) without widening the plugin's data access surface.
    if (valueFinalize) {
      const t0 = performance.now();
      const kernel = new Kernel();
      const prepareMs = performance.now() - t0;
      const t1 = performance.now();
      const result = kernel.finalize(params);
      const finalizeMs = performance.now() - t1;
      const rows = kernel.rowCount?.() ?? null;
      const cases = kernel.caseCount?.() ?? null;
      kernel.free?.();
      return { result, activities: [], timing: { prepareMs, finalizeMs, reused: false, rows, cases } };
    }

    const t0 = performance.now();
    let reused = true;
    if (!scan || scan.key !== prepareKey) {
      reused = false;
      scan?.kernel.free();
      scan = null;
      const r = await runScan({
        Kernel, table,
        maxActivities: Number(params.maxActivities ?? 24),
        chunkRows,
        order: scanOrder,
        includeEmptyTraces: scanEmptyTraces,
        activityIds: scanActivityIds,
        classifier: scanClassifier,
        resource: scanResource,
      });
      scan = { key: prepareKey, kernel: r.kernel, activities: r.activities };
    }
    const prepareMs = performance.now() - t0;

    const t1 = performance.now();
    const result = scan.kernel.finalize(params);
    const finalizeMs = performance.now() - t1;

    return {
      result,
      activities: scan.activities,
      timing: {
        prepareMs, finalizeMs, reused,
        rows: scan.kernel.rowCount?.() ?? null,
        cases: scan.kernel.caseCount?.() ?? null,
      },
    };
  },

  async abort() { aborted = true; return { aborted: true }; },

  async dispose() {
    scan?.kernel.free();
    scan = null;
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
