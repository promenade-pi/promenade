import * as arrow from 'apache-arrow';
import type { Artifact, ProvenanceGraph, ActionExecution } from '../artifact/types';
import type { StorageBreakdown, WorkspaceMeta } from './opfs';
import type { SavedView } from '../views/savedViews';
import { acquireWriterLock, AnotherTabError } from './singleWriter';

/**
 * Main-thread client for the data worker.
 *
 * This object *is* the host API surface that views and, later, plugins see.
 * Its shape is the contract: `sql()` returns Arrow, artifacts are metadata,
 * and there is no method that hands out an OPFS handle or a decoded log.
 */
export interface ImportProgress {
  id: string;
  phase: 'parse' | 'parquet';
  done: number;
  total: number;
}

/**
 * One entry in an artifact's own directory. `logical` is set only where the
 * file *is* one of the artifact's declared relations — the catalog's list and
 * what is on disk are not the same list.
 */
export interface ArtifactFileEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  logical?: string;
}

/** What `artifactFile` answers with: a relation for Parquet, bytes otherwise. */
export type ArtifactFileOpen =
  | {
      kind: 'parquet';
      path: string;
      size: number;
      /** A DuckDB relation over the file itself, queryable through `sql()`. */
      relation: string;
      rows: number;
      columns: Array<{ name: string; type: string }>;
      rowGroups: number | null;
      createdBy: string | null;
      compression: string | null;
    }
  | { kind: 'bytes'; path: string; size: number; bytes: Uint8Array; truncated: boolean };

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };
export interface CancellableSqlQuery {
  promise: Promise<arrow.Table>;
  cancel: () => Promise<boolean>;
}

export class DataClient {
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, Waiter>();
  private progressListeners = new Set<(p: ImportProgress) => void>();
  private logListeners = new Set<(s: string) => void>();

  constructor() {
    this.worker = new Worker(new URL('../../worker/data-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        for (const l of this.progressListeners) l(m.payload);
        return;
      }
      if (m.type === 'log') {
        for (const l of this.logListeners) l(m.payload);
        return;
      }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === 'error') w.reject(new Error(m.error));
      else w.resolve(m.payload);
    };
  }

  private call<T = any>(cmd: string, args?: unknown): Promise<T> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker.postMessage({ id, cmd, args });
    });
  }

  onProgress(fn: (p: ImportProgress) => void) {
    this.progressListeners.add(fn);
    return () => this.progressListeners.delete(fn);
  }
  onLog(fn: (s: string) => void) {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  private bootPromise: Promise<any> | null = null;

  /**
   * Idempotent. Booting twice would have two calls racing to open a
   * SyncAccessHandle on the same Parquet file, and OPFS allows only one at a
   * time - which StrictMode's double-invoked effects would trigger on every
   * mount in development.
   *
   * Guarded by a single-writer Web Lock (see `singleWriter.ts`): if another
   * tab of this origin already has Promenade open it holds the lock, DuckDB
   * cannot open its OPFS handles here, and this rejects with `AnotherTabError`
   * before the worker is even asked to boot.
   */
  boot() {
    this.bootPromise ??= (async () => {
      if ((await acquireWriterLock()) === 'contended') throw new AnotherTabError();
      return this.call<{
        report: any; catalog: ProvenanceGraph; quota: any;
        workspaces: WorkspaceMeta[]; activeWorkspaceId: string;
      }>('boot');
    })();
    return this.bootPromise;
  }
  catalog() {
    return this.call<{ catalog: ProvenanceGraph; quota: any }>('catalog');
  }

  /**
   * The File is transferred by reference: the worker reads it through
   * File.slice(), so a 1.6 GB log never becomes a string or a buffer.
   */
  import(file: File, format: ImportFormat, name: string) {
    return this.call<{ artifact: Artifact; quota: any }>('import', { file, format, name });
  }
  exportOcel(id: string, format: OcelExportFormat) {
    return this.call<{ content: Uint8Array; format: string }>('exportOcel', { id, format });
  }
  exportXes(id: string, format: XesExportFormat) {
    return this.call<{ content: Uint8Array; format: string }>('exportXes', { id, format });
  }

  /** The single data door. Returns Arrow, always. */
  async sql(text: string): Promise<arrow.Table> {
    const { ipc } = await this.call<{ ipc: Uint8Array }>('sql', { text });
    return arrow.tableFromIPC(ipc);
  }

  /**
   * Runs sandbox-view SQL on a dedicated DuckDB pending-query connection.
   * Unlike `sql()`, this request has a real DuckDB-Wasm interrupt path; its
   * cancellation never terminates the shared data-worker connection.
   */
  sqlCancelable(text: string): CancellableSqlQuery {
    const queryId = `q_${++this.seq}`;
    const promise = this.call<{ ipc: Uint8Array }>('sqlCancelable', { text, queryId })
      .then(({ ipc }) => arrow.tableFromIPC(ipc));
    return {
      promise,
      cancel: () => this.call<{ canceled: boolean }>('cancelSql', { queryId })
        .then((result) => !!result.canceled)
        .catch(() => false),
    };
  }

  /**
   * Runs a Promenade Relational Program.
   *
   * The wire-level counterpart of `sql()` for `runtime: 'relational'`
   * actions: unlike `sql()`, the worker never receives arbitrary DuckDB text
   * here — `programSource` is SQL Profile v1 text, revalidated inside the
   * worker before anything runs. See `host/relational/engine.ts` for the
   * friendlier, Arrow-`Table`-returning facade a relational action actually
   * calls; this method exists at the same level `sql()` does, for callers
   * that want the raw IPC bytes (e.g. a future sandboxed-view transport).
   */
  relational(request: {
    inputs: Array<{ role: string; artifactId: string }>;
    params: Record<string, unknown>;
    programSource: string;
    declaredParams: Record<string, unknown>;
    requestedRelations?: string[];
  }) {
    return this.call<{
      outputs: Record<string, Uint8Array>;
      relations: Record<string, Uint8Array>;
      stats: unknown;
      backend: { kind: string; version: string };
    }>('relational', request);
  }

  /**
   * Materializes a `runtime: 'relational'` program's output as physical,
   * queryable storage for a new artifact of a log-shaped type. The wire-level
   * counterpart of `relational()`, for the one thing that method's plain Arrow
   * result can't do by itself: back a real DuckDB object another action's
   * generic table scan can point at. See `ActionContext.persistLog`, the
   * facade an action actually calls.
   */
  materializeRelationalLog(request: {
    id: string;
    inputs: Array<{ role: string; artifactId: string }>;
    params: Record<string, unknown>;
    programSource: string;
    declaredParams: Record<string, unknown>;
    targetType: string;
  }) {
    return this.call<{ storage: unknown; meta: Record<string, unknown> }>(
      'materializeRelationalLog', request
    );
  }

  /**
   * The notebook-publishing counterpart of `materializeRelationalLog()`:
   * writes caller-supplied Arrow tables straight to Parquet under `id`,
   * instead of getting them by executing a SQL Profile v1 program first.
   * Used by `promenade.publish_event_log()`/`publish_ocel()` — see
   * `host/notebook/bridge-host.ts` and `worker/data-worker.ts`'s
   * `materializeNotebookLog`.
   */
  materializeNotebookLog(request: {
    id: string;
    targetType: string;
    /** Physical logical table name (`event`, `trace`, `object`, `e2o`, `o2o`) -> Arrow IPC bytes. */
    relations: Record<string, Uint8Array>;
  }) {
    return this.call<{ storage: unknown; meta: Record<string, unknown> }>(
      'materializeNotebookLog', request
    );
  }

  /**
   * Writes a log from columns an action computed, rather than from a query
   * over logs the workspace already has. The wire counterpart of
   * `ActionContext.persistLog`'s `rows` form; `host/artifact/log-rows.ts`
   * builds the Arrow tables this sends, and `materializeRowLog` (see
   * `worker/data-worker.ts`) turns them into physical storage.
   */
  materializeRowLog(request: {
    id: string;
    targetType: string;
    /** Physical relation name (`event`, `trace`, …) -> Arrow IPC bytes. */
    relations: Record<string, Uint8Array>;
  }) {
    return this.call<{ storage: unknown; meta: Record<string, unknown> }>(
      'materializeRowLog', request
    );
  }

  /** Writes an artifact (and optionally its execution) into the catalog. */
  putArtifact(artifact: Artifact, execution?: unknown) {
    return this.call<{ catalog: ProvenanceGraph; quota: any }>(
      'putArtifact', { artifact, execution }
    );
  }

  /** Stores a structured artifact payload in OPFS for catalog-light results. */
  materializeArtifactJson(artifactId: string, value: unknown) {
    return this.call<{ storage: Artifact['storage']; bytes: number }>('materializeArtifactJson', { artifactId, value });
  }

  /** Hydrates a materialized structured artifact only when a consumer opens it. */
  readArtifactJson(artifactId: string) {
    return this.call<{ value: unknown }>('readArtifactJson', { artifactId }).then((result) => result.value);
  }

  /** Updates the measured execution record after its catalog commit finished. */
  updateExecution(execution: ActionExecution) {
    return this.call<{ catalog: ProvenanceGraph; quota: any }>('updateExecution', { execution });
  }

  /** Writes a derived log and rebuilds its views. Returns the measured artifact. */
  putDerived(artifact: Artifact, execution?: unknown) {
    return this.call<{ catalog: ProvenanceGraph; quota: any; artifact: Artifact }>(
      'putDerived', { artifact, execution }
    );
  }

  /** Changes a log's event classifier; rebuilds its event view and its counts. */
  setClassifier(id: string, classifier: unknown) {
    return this.call<{ catalog: ProvenanceGraph; quota: any }>(
      'setClassifier', { id, classifier }
    );
  }

  remove(id: string) { return this.call('remove', { id }); }
  rename(id: string, name: string) { return this.call('rename', { id, name }); }
  /**
   * "Copy/Move to Promenade Compute" (`host/compute/relocate.ts`). `location`
   * of `null` clears it back to local; a `storage` patch is only given on an
   * actual move, replacing the evicted/rehydrated payload — a plain copy
   * leaves `storage` untouched, since the local data still fully exists.
   */
  relocateArtifact(id: string, patch: {
    location?: { engineId: string; remoteId: string } | null; storage?: unknown; meta?: Record<string, unknown>;
  }) {
    return this.call<{ catalog: ProvenanceGraph }>('relocateArtifact', { id, ...patch });
  }
  storageBreakdown() { return this.call<{ breakdown: StorageBreakdown }>('storageBreakdown'); }
  /** Rebuilds catalog entries for artifact directories the catalog lost. */
  recoverArtifacts() {
    return this.call<{
      fromSidecar: string[]; reconstructed: string[]; renamed: string[]; unreadable: string[];
      graph: ProvenanceGraph; breakdown: StorageBreakdown;
    }>('recoverArtifacts');
  }
  removeOrphanArtifactFiles() {
    return this.call<{ removed: string[]; breakdown: StorageBreakdown }>('removeOrphanArtifactFiles');
  }
  clearCacheStorage() {
    return this.call<{ cleared: string[]; breakdown: StorageBreakdown }>('clearCacheStorage');
  }
  tableFor(id: string, logical: string) {
    return this.call<{ table: string }>('tableFor', { id, logical });
  }

  /**
   * What is physically in one artifact's OPFS directory — not what the
   * catalog says its relations are. See `artifactFiles` in the data worker.
   */
  artifactFiles(id: string) {
    return this.call<{ entries: ArtifactFileEntry[] }>('artifactFiles', { id });
  }

  /**
   * Opens one file inside an artifact's directory: a Parquet file answers
   * with a queryable relation (plus its schema and Parquet metadata), any
   * other file with its bytes, capped.
   */
  artifactFile(id: string, path: string, maxBytes?: number) {
    return this.call<ArtifactFileOpen>('artifactFile', { id, path, maxBytes });
  }

  /** Wipes the active workspace. Caller reloads the page right after. */
  reset() { return this.call<{ ok: true }>('reset'); }

  listWorkspaces() {
    return this.call<{ workspaces: WorkspaceMeta[]; activeWorkspaceId: string }>('listWorkspaces');
  }
  createWorkspace(name: string) {
    return this.call<{ workspace: WorkspaceMeta; workspaces: WorkspaceMeta[] }>('createWorkspace', { name });
  }
  renameWorkspace(id: string, name: string) {
    return this.call<{ workspaces: WorkspaceMeta[] }>('renameWorkspace', { id, name });
  }
  /** Records which workspace the next boot should open. Caller reloads right after. */
  switchWorkspace(id: string) { return this.call<{ ok: true }>('switchWorkspace', { id }); }
  /** Deletes the active workspace. Caller switches to a remaining one and reloads right after. */
  deleteActiveWorkspace() {
    return this.call<{ workspaces: WorkspaceMeta[] }>('deleteActiveWorkspace');
  }

  /** Moves a root artifact, and everything derived from it, into another workspace. */
  moveArtifactToWorkspace(artifactId: string, destWorkspaceId: string) {
    return this.call<{ catalog: ProvenanceGraph; quota: any }>(
      'moveArtifactToWorkspace', { artifactId, destWorkspaceId }
    );
  }

  /** Gathers the active workspace's catalog, saved views and Parquet bytes for export. */
  exportWorkspaceData() {
    return this.call<{
      meta: WorkspaceMeta;
      artifacts: Record<string, Artifact>;
      executions: Record<string, ActionExecution>;
      views: SavedView[];
      files: Record<string, Uint8Array>;
    }>('exportWorkspaceData');
  }

  /** The counterpart of `exportWorkspaceData`: creates a new workspace from bundle contents. */
  importWorkspaceData(request: {
    name: string;
    artifacts: Record<string, Artifact>;
    executions: Record<string, ActionExecution>;
    views: SavedView[];
    files: Record<string, Uint8Array>;
  }) {
    return this.call<{ workspace: WorkspaceMeta; workspaces: WorkspaceMeta[] }>('importWorkspaceData', request);
  }
}

export const dataClient = new DataClient();

/**
 * File-name detection is deliberately conservative for plain `.csv`: OCEL's
 * compact form is `.ocel.csv`; a generic event table is treated as the
 * ProM-compatible CSV path.
 *
 * `pnml` is handled separately from the other two — it is a Petri net, not
 * an event log, so it never goes through `dataClient.import()`'s worker RPC
 * (there is no DuckDB table to build, no streaming to do): the caller reads
 * and parses it directly, the same way a freshly-mined net is small enough
 * to live in the artifact's own inline storage.
 */
export type ImportFormat = 'xes' | 'ocel-json' | 'ocel-xml' | 'ocel-sqlite' | 'ocel-csv' | 'prom-csv' | 'ocel-bundle';
export type OcelExportFormat = 'json' | 'xml' | 'sqlite' | 'csv' | 'bundle-csv' | 'bundle-parquet';
export type XesExportFormat = 'xes' | 'csv';

export function detectFormat(fileName: string): ImportFormat | null {
  const full = fileName.toLowerCase();
  const n = full.endsWith('.gz') ? full.slice(0, -3) : full;
  if (n.endsWith('.xes') || n.endsWith('.xes.xml')) return 'xes';
  // PNML is no longer detected here: it is now a manufacturing action
  // (`core.pnml.import`, core-actions.ts), reached through `fileImporterFor`
  // like any plugin-declared import, not a core log format in its own right.
  if (n.endsWith('.jsonocel') || n.endsWith('.json')) return 'ocel-json';
  if (n.endsWith('.xml') || n.endsWith('.xmlocel')) return 'ocel-xml';
  if (n.endsWith('.sqlite') || n.endsWith('.sqlite3') || n.endsWith('.db') || n.endsWith('.db3')) return 'ocel-sqlite';
  if (n.endsWith('.ocel.zip')) return 'ocel-bundle';
  if (n.endsWith('.ocel.csv')) return 'ocel-csv';
  if (n.endsWith('.csv')) return 'prom-csv';
  return null;
}
