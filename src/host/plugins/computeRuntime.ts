/**
 * The Promenade Compute half of `wasmActionRuntime` (`runtimeAdapters.ts`).
 *
 * Split into its own file because it's a genuinely different transport (HTTP
 * + SSE to an engine instead of `postMessage` to a worker) even though it
 * produces the exact same `ActionOutcome` shape its browser sibling does —
 * `DfgView` (or any future compute-eligible plugin's view) never needs to
 * know which one ran.
 *
 * What this does *not* try to be: a general SQL bridge. `docs/promenade-compute.md`
 * §4.2 describes routing arbitrary `ctx.sql()` calls to the engine's own
 * DuckDB; Stage 1 has no embedded DuckDB (see `compute/README.md`), so
 * instead the browser runs the one scan an action's kernel needs *locally*
 * (same query shape `wasm-plugin-worker.ts` runs, just un-chunked — compute
 * targets are small logs for now) and uploads only the resulting columns.
 */

import { dataClient } from '../data/client';
import { tableOf } from '../artifact/tables';
import type { ActionContext, ActionOutcome } from '../actions/types';
import type { PluginManifest } from './manifest';

type ManifestAction = NonNullable<PluginManifest['actions']>[number];

interface ScanResult {
  nActivities: number;
  activityNames: string[];
  caseIdx: Int32Array;
  activityId: Int32Array;
}

/** The same activity-dictionary-then-ordered-rows scan `wasm-plugin-worker.ts`
 * runs in a browser worker, run once, un-chunked, on the main thread. */
async function scanForUpload(table: string, action: ManifestAction, params: Record<string, unknown>): Promise<ScanResult> {
  const maxActivities = Math.max(1, Number(params.maxActivities) || 24);
  const activityIds = action.kernel?.scan?.activityIds ?? 'frequency';
  const order = action.kernel?.scan?.order ?? 'timestamp';
  const timed = order === 'timestamp';
  const timestampNullsLast = order === 'timestampNullsLast';
  const eventFilter = timed ? 'AND ts IS NOT NULL' : '';
  // `c` resolves via this query's own SELECT alias; `ts`/`event_idx` are real
  // source columns on `e` (there is no `ord` alias here, unlike the
  // browser-worker version this scan is modeled on — every column ORDER BY
  // references must actually be nameable).
  const orderBy = timed ? 'c, e.ts, e.event_idx' : timestampNullsLast ? 'c, e.ts NULLS LAST, e.event_idx' : 'c, e.event_idx';

  const actsCte = activityIds === 'firstAppearance'
    ? `SELECT activity, CAST(row_number() OVER (ORDER BY first_seen) - 1 AS INTEGER) AS aid
       FROM (SELECT activity, MIN(event_idx) AS first_seen, COUNT(*) AS n FROM ${table}
             WHERE activity IS NOT NULL ${eventFilter} GROUP BY 1)
       QUALIFY row_number() OVER (ORDER BY first_seen) <= ${maxActivities}`
    : `SELECT activity, CAST(row_number() OVER (ORDER BY n DESC, activity) - 1 AS INTEGER) AS aid
       FROM (SELECT activity, COUNT(*) AS n FROM ${table} WHERE activity IS NOT NULL ${eventFilter} GROUP BY 1)
       QUALIFY aid < ${maxActivities}`;

  const acts = await dataClient.sql(actsCte);
  const activityNames: string[] = [];
  for (const r of acts.toArray() as any[]) activityNames[Number(r.aid)] = String(r.activity);

  const rows = await dataClient.sql(`
    WITH acts AS (${actsCte})
    SELECT CAST(e.trace_idx AS INTEGER) AS c, a.aid AS a
    FROM ${table} e JOIN acts a ON a.activity = e.activity
    WHERE e.activity IS NOT NULL ${eventFilter}
    ORDER BY ${orderBy}
  `);

  return {
    nActivities: activityNames.length,
    activityNames,
    caseIdx: Int32Array.from(rows.getChild('c')!.toArray() as any),
    activityId: Int32Array.from(rows.getChild('a')!.toArray() as any),
  };
}

/**
 * The registry URL to hand the engine so it can resolve `pluginId@version`
 * itself (`docs/promenade-compute.md` §4.3). Built from the browser's own
 * configured/effective registry — but a loopback hostname means something
 * different inside a container than it does in this tab: "reach the dev
 * server that served this page" has to become `host.docker.internal`
 * (compute/README.md documents this explicitly) rather than the engine
 * connecting back to itself. A genuinely remote engine could never have
 * reached a loopback URL either way, so this rewrite only ever helps.
 */
function registryUrlFor(): string {
  const url = new URL('/registry/index.json', window.location.origin);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.hostname = 'host.docker.internal';
  }
  return url.href;
}

/** `POST /jobs`'s SSE stream, resolved into one settled outcome. */
function watchJob(endpoint: string, jobId: string, signal: AbortSignal, onProgress: ActionContext['progress']) {
  return new Promise<{ value: any; timing: any }>((resolve, reject) => {
    const es = new EventSource(`${endpoint}/jobs/${jobId}/events`);
    const cleanup = () => { es.close(); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      cleanup();
      fetch(`${endpoint}/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);

    es.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'progress') onProgress(msg.fraction, msg.message);
      else if (msg.type === 'result') { cleanup(); resolve({ value: msg.value, timing: msg.timing }); }
      else if (msg.type === 'error') { cleanup(); reject(new Error(msg.message)); }
    };
    es.onerror = () => {
      // A closed-by-server connection with no terminal event is itself a
      // failure — EventSource retries by default, which would otherwise
      // hang this promise forever after the job is long gone.
      cleanup();
      reject(new Error('lost connection to the Promenade Compute engine'));
    };
  });
}

export async function runOnComputeEngine(
  manifest: PluginManifest, action: ManifestAction, logId: string, table: string,
  params: Record<string, unknown>, ctx: ActionContext,
): Promise<ActionOutcome> {
  const { endpoint } = ctx.compute!;
  const t0 = performance.now();

  ctx.progress(0, 'scanning log');
  const scan = await scanForUpload(table, action, params);

  const uploadStart = performance.now();
  const uploadRes = await fetch(`${endpoint}/artifacts/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      artifactId: logId, table: 'event', nActivities: scan.nActivities, activityNames: scan.activityNames,
      columns: { caseIdx: Array.from(scan.caseIdx), activityId: Array.from(scan.activityId) },
    }),
    signal: ctx.signal,
  });
  if (!uploadRes.ok) throw new Error(`Promenade Compute upload failed: ${uploadRes.status} ${await uploadRes.text().catch(() => '')}`);
  const { remoteId } = await uploadRes.json();
  const uploadMs = performance.now() - uploadStart;

  const registryUrl = registryUrlFor();
  const jobRes = await fetch(`${endpoint}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pluginId: manifest.id, pluginVersion: manifest.version, actionId: action.id,
      registryUrl, table: remoteId, params,
    }),
    signal: ctx.signal,
  });
  if (!jobRes.ok) throw new Error(`Promenade Compute job creation failed: ${jobRes.status} ${await jobRes.text().catch(() => '')}`);
  const { jobId } = await jobRes.json();

  const { value, timing } = await watchJob(endpoint, jobId, ctx.signal, ctx.progress);
  const totalMs = performance.now() - t0;

  return {
    inline: { value, activities: value?.activities ?? [], stats: value?.stats ?? {} },
    runtimeVersion: `${manifest.id} ${manifest.version} (Promenade Compute)`,
    benchmark: {
      cacheState: 'cold',
      phases: [
        { id: 'prepare', label: 'Scan log (browser)', durationMs: uploadStart - t0 },
        { id: 'network', label: 'Upload to engine', durationMs: uploadMs },
        { id: 'queue', label: 'Queue on engine', durationMs: Number(timing?.queueMs) || 0 },
        { id: 'compute', label: 'Compute on engine', durationMs: Number(timing?.computeMs) || Math.max(0, totalMs - uploadMs) },
      ],
    },
  };
}
