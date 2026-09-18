/**
 * Single-writer guard.
 *
 * OPFS storage is per-origin and shared by every tab, window and worker of
 * that origin. `createSyncAccessHandle` — which duckdb-wasm opens on the
 * engine-arming file `opfs://engine/session.db` (see `duck.ts`) and on every
 * mounted artifact's Parquet file — takes a lock that is *exclusive across the
 * whole origin*, not just the tab. A second Promenade tab therefore cannot
 * boot DuckDB: it throws
 *
 *   Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle':
 *   Access Handles cannot be created if there is another open Access Handle
 *   or Writable stream associated with the same file.
 *
 * Even without that lock the storage model assumes one writer: two tabs
 * writing the same `workspaces/<id>/catalog.json`, Parquet files and
 * `active-workspace.json` would corrupt the catalog.
 *
 * So we make the constraint explicit and legible. Before the data worker
 * arms DuckDB (`DataClient.boot()`), the tab tries to take a Web Lock. If
 * another tab already holds it, boot is refused with `AnotherTabError` and
 * the UI shows a "Promenade is open in another tab" screen instead of the
 * raw DuckDB crash. The lock is held for the tab's lifetime and released
 * automatically when the tab closes or navigates away — there is no explicit
 * release, by design.
 *
 * ---------------------------------------------------------------------------
 * FUTURE: option 2 — a SharedWorker to actually allow multiple tabs.
 *
 * The guard makes multi-tab *safe* but still single-tab. To let several tabs
 * of one origin drive Promenade at once, the single writer has to move
 * somewhere all of them can share:
 *
 *   - Host the data worker (`worker/data-worker.ts`) in a `SharedWorker`
 *     instead of a per-tab dedicated `Worker` (created in `DataClient`'s
 *     constructor). One DuckDB instance, one set of OPFS handles, one writer;
 *     every tab connects to it over `SharedWorker.port` (a `MessagePort`).
 *   - `DataClient.call()` already speaks a small `{id, cmd, args}` / `{type,
 *     id, payload}` RPC over `postMessage`; that maps onto a port almost
 *     unchanged. The `progress` / `log` broadcast messages need fan-out to
 *     every connected port rather than a single `worker.onmessage`.
 *   - The worker keeps per-connection state today (`registered`,
 *     `registeredFiles`, `catalogCache`, `cancellableSql`, the active
 *     workspace id). With N tabs that all becomes shared mutable state:
 *       * the active workspace becomes a property of the shared worker, and
 *         switching it in one tab has to push a catalog refresh to the
 *         others (a broadcast message -> each `DataClient` re-emits its
 *         `catalog` result to subscribers);
 *       * `reset()` / workspace delete, which today assume the caller reloads
 *         immediately after, need to tell *all* tabs to reload;
 *       * cancellable-SQL connections must be keyed by (port, queryId) so one
 *         tab's cancel can't tear down another tab's query.
 *   - SharedWorker is unavailable on some engines (notably older mobile
 *     Safari) and in Chrome incognito; keep the dedicated-Worker + this
 *     guard as the fallback path when `typeof SharedWorker === 'undefined'`.
 *   - Plugin workers (`plugin-worker.ts`, `wasm-plugin-worker.ts`,
 *     `pyodide-worker.ts`) stay per-tab — they don't touch OPFS directly,
 *     they call back through the host. Only the data worker needs to be
 *     shared.
 *
 * Rough shape: a `SharedDataWorkerTransport` implementing the same interface
 * `DataClient` uses, selected at construction time, with the RPC and
 * broadcast plumbing generalised to N ports. Everything above `DataClient`
 * is unaffected.
 * ---------------------------------------------------------------------------
 */

const LOCK_NAME = 'promenade:single-writer';

export class AnotherTabError extends Error {
  constructor() {
    super('Promenade is already open in another tab of this browser.');
    this.name = 'AnotherTabError';
  }
}

export type WriterLockStatus = 'acquired' | 'contended' | 'unsupported';

let attempt: Promise<WriterLockStatus> | null = null;

/**
 * Tries to take the single-writer lock for this tab, without waiting. The
 * result is memoised: repeated calls (StrictMode, re-renders) return the same
 * outcome and never re-request the lock — a second `ifAvailable` request from
 * the same document would see our own held lock and wrongly report contention.
 *
 * `'unsupported'` (no Web Locks API, or the request threw) is treated as
 * "proceed": the guard is best-effort, and duckdb-wasm's own error still
 * surfaces if a real conflict exists.
 */
export function acquireWriterLock(): Promise<WriterLockStatus> {
  attempt ??= new Promise<WriterLockStatus>((resolve) => {
    if (!navigator.locks?.request) {
      resolve('unsupported');
      return;
    }
    navigator.locks
      .request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve('contended');
          return; // returning from the callback ends the request; nothing held
        }
        resolve('acquired');
        // Hold the lock until this tab goes away. The returned promise never
        // settles, so the lock is released only when the page is discarded.
        return new Promise<void>(() => {});
      })
      .catch(() => resolve('unsupported'));
  });
  return attempt;
}

/**
 * Resolves once the single-writer lock is free — i.e. the tab that held it
 * has closed or navigated away. Used by the "another tab" screen to reload
 * automatically the moment this tab can take over.
 */
export async function waitForWriterLockToFree(): Promise<void> {
  // Without Web Locks we never get here (boot is refused only on 'contended',
  // which this API can't return) — but never resolve rather than risk a
  // reload loop if we somehow do.
  if (!navigator.locks?.request) return new Promise<void>(() => {});
  await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => {
    // Acquired — which means it is free. Return immediately, releasing it,
    // so the imminent reload's `acquireWriterLock()` can take it cleanly.
  });
}
