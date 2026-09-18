/**
 * OPFS layout, workspaces, and catalog persistence.
 *
 *   /workspaces.json                     workspace registry: [{id, name, createdAt}]
 *   /workspaces/<workspaceId>/catalog.json          the provenance DAG: artifacts + executions
 *   /workspaces/<workspaceId>/artifacts/<artifactId>/<table>.parquet   tabular data, zstd Parquet
 *   /workspaces/<workspaceId>/artifacts/<artifactId>/artifact.json     that artifact's own catalog entry
 *   /workspaces/<workspaceId>/staging/<name>        raw source files, deleted after ingest
 *   /workspaces/<workspaceId>/saved-views.json       that workspace's saved views
 *   /plugins/<id>/..., /plugins.json     installed plugins — global, not workspace-scoped
 *   /engine/session.db                   DuckDB OPFS-arming file — global, not real storage
 *
 * Parquet is the persistence layer, not a DuckDB database file. Milestone 0
 * established that `opfs://` DuckDB databases silently retain nothing: the
 * file is created, CHECKPOINT reports success, and the catalog is empty
 * after a reload. Parquet also compresses better than the source (28:1 on
 * BPI-2017, 45:1 on aoe2) and stays readable by a native DuckDB later.
 *
 * Plugins and the engine-arming file live outside any workspace's subtree on
 * purpose: they are app-wide, not tied to which workspace happens to be
 * open (see `ui/PluginsDialog.tsx`'s own note on this). Everything else —
 * the catalog, artifacts, staging, saved views — is per workspace.
 */

import type { ProvenanceGraph } from '../artifact/types';

export const DIR_ARTIFACTS = 'artifacts';
export const DIR_STAGING = 'staging';
export const CATALOG = 'catalog.json';
/** Last known-good catalog, used if a refresh interrupts a catalog write. */
export const CATALOG_BACKUP = 'catalog.backup.json';
/**
 * The catalog as it stood immediately before it last *lost* artifacts.
 *
 * `CATALOG_BACKUP` is one write behind, which is exactly one write too few
 * when the damaging write is followed by an innocent one — two saves after a
 * catalog is truncated, both copies agree and the old contents are gone.
 * This one only ever moves when artifacts disappear, so it survives any
 * number of subsequent writes and is still there when someone notices days
 * later. Deleting an artifact is also a loss by this definition; that is the
 * point, and the file is a few kilobytes.
 */
export const CATALOG_RESCUE = 'catalog.rescue.json';
/** Per-artifact copy of that artifact's catalog entry — see `writeArtifactSidecar`. */
export const ARTIFACT_SIDECAR = 'artifact.json';
/** Legacy flat-root filename, referenced only by the one-time migration below. */
const LEGACY_SAVED_VIEWS = 'saved-views.json';

const DIR_WORKSPACES = 'workspaces';
const WORKSPACES_INDEX = 'workspaces.json';
/**
 * Which workspace is active, persisted as an OPFS file rather than
 * `localStorage`: every workspace function here runs inside the data
 * worker (see `worker/data-worker.ts`), and `localStorage` is a `Window`
 * API a dedicated worker does not have.
 */
const ACTIVE_WORKSPACE_FILE = 'active-workspace.json';

export interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** The true, unscoped origin root — plugins, the engine file, and the workspace registry live here. */
export async function globalRoot() {
  return navigator.storage.getDirectory();
}

let activeWorkspaceId: string | null = null;

export function getActiveWorkspaceId(): string {
  if (!activeWorkspaceId) throw new Error('no active workspace set — call ensureWorkspaces() first');
  return activeWorkspaceId;
}

/**
 * Sets the active workspace id in memory only, with no OPFS write —
 * `saved-views.json` reads happen from the main thread too (see
 * `host/views/savedViews.ts`), which has its own separate copy of this
 * module's state from the data worker's. The worker already persists the
 * choice via `setActiveWorkspaceId()` below; the main thread only needs to
 * mirror it after `DataClient.boot()` resolves, not write it again.
 */
export function primeActiveWorkspaceId(id: string) {
  activeWorkspaceId = id;
}

export async function setActiveWorkspaceId(id: string): Promise<void> {
  activeWorkspaceId = id;
  const h = await (await globalRoot()).getFileHandle(ACTIVE_WORKSPACE_FILE, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify({ id })));
  await w.close();
}

async function readActiveWorkspaceId(): Promise<string | null> {
  try {
    const h = await (await globalRoot()).getFileHandle(ACTIVE_WORKSPACE_FILE);
    return JSON.parse(await (await h.getFile()).text())?.id ?? null;
  } catch { return null; }
}

async function workspacesDir(create = true) {
  return (await globalRoot()).getDirectoryHandle(DIR_WORKSPACES, { create });
}

/** The active workspace's own root directory, or an explicit `workspaceId`'s. */
export async function workspaceRoot(workspaceId: string = getActiveWorkspaceId(), create = true) {
  return (await workspacesDir(create)).getDirectoryHandle(workspaceId, { create });
}

export async function readWorkspaces(): Promise<WorkspaceMeta[]> {
  try {
    const h = await (await globalRoot()).getFileHandle(WORKSPACES_INDEX);
    const parsed = JSON.parse(await (await h.getFile()).text());
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function writeWorkspaces(list: WorkspaceMeta[]): Promise<void> {
  const h = await (await globalRoot()).getFileHandle(WORKSPACES_INDEX, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(list, null, 2)));
  await w.close();
}

/**
 * Moves a handle to a new parent, preferring the native OPFS move (same
 * storage cell, no byte copy) and falling back to a recursive copy-then-
 * nothing for engines that lack it — the caller is responsible for removing
 * the source afterwards in that case, since a partial fallback copy must not
 * silently delete data it never actually duplicated.
 */
async function moveHandle(handle: FileSystemHandle, parent: FileSystemDirectoryHandle, name = handle.name) {
  if (typeof (handle as any).move === 'function') {
    await (handle as any).move(parent, name);
    return;
  }
  if (handle.kind === 'file') {
    const src = handle as FileSystemFileHandle;
    const dst = await parent.getFileHandle(name, { create: true });
    const w = await dst.createWritable();
    await w.write(await (await src.getFile()).arrayBuffer());
    await w.close();
  } else {
    const src = handle as FileSystemDirectoryHandle;
    const dst = await parent.getDirectoryHandle(name, { create: true });
    for await (const [childName, child] of (src as any).entries()) {
      await moveHandle(child, dst, childName);
    }
  }
}

/**
 * First-boot setup, called once before anything reads the catalog.
 *
 * Reads `/workspaces.json` if present and resolves the active id (from
 * `/active-workspace.json`, falling back to the first entry). If the
 * registry is missing but a legacy flat-root catalog exists (a
 * pre-Workspaces install), migrates it into a single "My Workspace" rather
 * than discarding it. A registry-less, catalog-less root is a fresh
 * install and gets an empty "My Workspace" the same way — named for a
 * first-time user glancing at the switcher next to the logo, not "Default",
 * which reads as a placeholder nobody bothered to name.
 */
export async function ensureWorkspaces(): Promise<WorkspaceMeta[]> {
  const g = await globalRoot();
  let list = await readWorkspaces();

  if (list.length === 0) {
    const id = crypto.randomUUID();
    const created: WorkspaceMeta = { id, name: 'My Workspace', createdAt: new Date().toISOString() };
    const dest = await (await workspacesDir(true)).getDirectoryHandle(id, { create: true });

    for (const name of [CATALOG, CATALOG_BACKUP, CATALOG_RESCUE, LEGACY_SAVED_VIEWS]) {
      try { await moveHandle(await g.getFileHandle(name), dest, name); await g.removeEntry(name); }
      catch {}
    }
    for (const name of [DIR_ARTIFACTS, DIR_STAGING]) {
      try { await moveHandle(await g.getDirectoryHandle(name), dest, name); await g.removeEntry(name, { recursive: true }); }
      catch {}
    }

    list = [created];
    await writeWorkspaces(list);
  }

  let active = await readActiveWorkspaceId();
  if (!active || !list.some((w) => w.id === active)) active = list[0].id;
  await setActiveWorkspaceId(active);
  return list;
}

export async function createWorkspace(name: string): Promise<WorkspaceMeta> {
  const list = await readWorkspaces();
  const created: WorkspaceMeta = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
  await workspaceRoot(created.id, true);
  await writeWorkspaces([...list, created]);
  return created;
}

export async function renameWorkspace(id: string, name: string): Promise<WorkspaceMeta[]> {
  const next = (await readWorkspaces()).map((w) => (w.id === id ? { ...w, name } : w));
  await writeWorkspaces(next);
  return next;
}

/**
 * Removes a workspace's registry entry and its OPFS subtree. The caller must
 * ensure DuckDB has released any handles it holds inside that subtree first
 * — same requirement as `resetActiveWorkspace()`, since a directory with an
 * open access handle inside it fails to delete with NoModificationAllowedError.
 */
export async function deleteWorkspace(id: string): Promise<WorkspaceMeta[]> {
  const next = (await readWorkspaces()).filter((w) => w.id !== id);
  try { await (await workspacesDir(false)).removeEntry(id, { recursive: true }); } catch {}
  await writeWorkspaces(next);
  return next;
}

/**
 * Best-effort storage is evictable under pressure. An application whose
 * artifacts are expected to survive a reload has to ask.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function quota() {
  const e = await navigator.storage.estimate();
  let persisted = false;
  try { persisted = await navigator.storage.persisted(); } catch {}
  return { quota: e.quota ?? 0, usage: e.usage ?? 0, persisted };
}

export interface StorageBreakdown {
  quota: number;
  usage: number;
  persisted: boolean;
  opfs: {
    total: number;
    artifacts: number;
    activeArtifacts: number;
    orphanArtifacts: number;
    orphanArtifactDirectories: number;
    engine: number;
    plugins: number;
    staging: number;
    catalog: number;
    other: number;
    /** Combined bytes used by every workspace besides the active one. */
    otherWorkspaces: number;
  };
  cacheStorage: {
    bytes: number;
    entries: number;
    pyodideBytes: number;
    pyodideEntries: number;
    caches: Array<{ name: string; entries: number; bytes: number; pyodideBytes: number }>;
  };
  /** Storage the browser counts but the web platform cannot attribute to a folder/cache. */
  unclassified: number;
}

async function entryBytes(handle: FileSystemHandle): Promise<number> {
  if (handle.kind === 'file') return (await (handle as FileSystemFileHandle).getFile()).size;
  let total = 0;
  for await (const [, child] of (handle as FileSystemDirectoryHandle as any).entries()) {
    total += await entryBytes(child);
  }
  return total;
}

const PYODIDE_URL = /pyodide|micropip|pypi|pm4py/i;

/**
 * Measures storage the application can actually inspect.  `estimate().usage`
 * is origin-wide, whereas OPFS and Cache Storage are independently enumerable.
 * Browser-managed HTTP cache is deliberately left in `unclassified`: websites
 * cannot enumerate or clear it, and pretending that every unknown byte is
 * Pyodide would be misleading.
 *
 * `artifacts`/`activeArtifacts`/`orphanArtifacts`/`staging`/`catalog` report
 * the active workspace only; `otherWorkspaces` is every other workspace's
 * subtree combined; `engine`/`plugins` are global, as they always were.
 */
export async function storageBreakdown(knownArtifactIds: Set<string>): Promise<StorageBreakdown> {
  const [q, g] = await Promise.all([quota(), globalRoot()]);
  const opfs = {
    total: 0, artifacts: 0, activeArtifacts: 0, orphanArtifacts: 0, orphanArtifactDirectories: 0,
    engine: 0, plugins: 0, staging: 0, catalog: 0, other: 0, otherWorkspaces: 0,
  };
  const activeId = getActiveWorkspaceId();

  for await (const [name, handle] of (g as any).entries()) {
    if (name === DIR_WORKSPACES && handle.kind === 'directory') {
      for await (const [wsId, wsHandle] of (handle as any).entries()) {
        const wsBytes = await entryBytes(wsHandle);
        opfs.total += wsBytes;
        if (wsId !== activeId) { opfs.otherWorkspaces += wsBytes; continue; }
        for await (const [wname, whandle] of (wsHandle as any).entries()) {
          const wb = await entryBytes(whandle);
          if (wname === DIR_ARTIFACTS && whandle.kind === 'directory') {
            opfs.artifacts = wb;
            for await (const [artifactId, child] of (whandle as any).entries()) {
              const childBytes = await entryBytes(child);
              if (knownArtifactIds.has(artifactId)) opfs.activeArtifacts += childBytes;
              else { opfs.orphanArtifacts += childBytes; opfs.orphanArtifactDirectories++; }
            }
          } else if (wname === DIR_STAGING) opfs.staging += wb;
          else if (wname === CATALOG || wname === CATALOG_BACKUP || wname === CATALOG_RESCUE) opfs.catalog += wb;
          else opfs.other += wb;
        }
      }
      continue;
    }
    const bytes = await entryBytes(handle);
    opfs.total += bytes;
    if (name === 'engine') opfs.engine += bytes;
    else if (name === 'plugins' || name === 'plugins.json') opfs.plugins += bytes;
    else opfs.other += bytes;
  }

  const cacheStorage: StorageBreakdown['cacheStorage'] = {
    bytes: 0, entries: 0, pyodideBytes: 0, pyodideEntries: 0, caches: [],
  };
  // Cache API is app-controlled. The normal browser HTTP cache is neither
  // enumerable nor clearable from a page, even when it contains Pyodide CDN
  // responses, so it remains in the unclassified estimate below.
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      let bytes = 0;
      let pyodideBytes = 0;
      for (const request of requests) {
        const response = await cache.match(request);
        const length = Number(response?.headers.get('content-length') ?? 0) || 0;
        bytes += length;
        if (PYODIDE_URL.test(request.url)) {
          pyodideBytes += length;
          cacheStorage.pyodideEntries++;
        }
      }
      cacheStorage.bytes += bytes;
      cacheStorage.entries += requests.length;
      cacheStorage.pyodideBytes += pyodideBytes;
      cacheStorage.caches.push({ name, entries: requests.length, bytes, pyodideBytes });
    }
  }
  cacheStorage.caches.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return {
    ...q,
    opfs,
    cacheStorage,
    unclassified: Math.max(0, q.usage - opfs.total - cacheStorage.bytes),
  };
}

/** Clears Cache API entries for this origin; browser HTTP cache is unaffected. */
export async function clearCacheStorage(): Promise<string[]> {
  if (typeof caches === 'undefined') return [];
  const names = await caches.keys();
  for (const name of names) await caches.delete(name);
  return names;
}

async function dir(name: string, create = true, workspaceId?: string) {
  return (await workspaceRoot(workspaceId, create)).getDirectoryHandle(name, { create });
}

export async function artifactDir(id: string, create = true, workspaceId?: string) {
  return (await dir(DIR_ARTIFACTS, create, workspaceId)).getDirectoryHandle(id, { create });
}

/**
 * Moves one artifact's whole OPFS directory from one workspace to another —
 * the storage half of moving an artifact between workspaces. The caller is
 * responsible for releasing any DuckDB handles on the artifact's files
 * first, the same requirement `resetActiveWorkspace()` and
 * `deleteWorkspace()` have — an open access handle blocks a move the same
 * way it blocks a delete.
 */
export async function moveArtifactDir(id: string, fromWorkspaceId: string, toWorkspaceId: string): Promise<void> {
  const fromArtifacts = await dir(DIR_ARTIFACTS, false, fromWorkspaceId).catch(() => null);
  if (!fromArtifacts) return;
  let srcDir: FileSystemDirectoryHandle;
  try { srcDir = await fromArtifacts.getDirectoryHandle(id); } catch { return; }
  const toArtifacts = await dir(DIR_ARTIFACTS, true, toWorkspaceId);
  await moveHandle(srcDir, toArtifacts, id);
  if (typeof (srcDir as any).move !== 'function') {
    // The fallback path copies rather than moves; remove the source only
    // once the copy is confirmed complete.
    await fromArtifacts.removeEntry(id, { recursive: true });
  }
}

/**
 * One artifact's own copy of its catalog entry, written beside its data.
 *
 * The catalog is a single file describing every artifact, which makes it a
 * single point of failure: lose it and perfectly good Parquet becomes an
 * unnamed, untyped directory that the Storage panel calls an orphan and offers
 * to delete. The sidecar is the second, *distributed* copy — it lives inside
 * the directory it describes, so it cannot be lost independently of the data
 * it belongs to, and `recoverArtifacts()` can rebuild the whole catalog from
 * the artifacts directory alone.
 *
 * It carries the producing execution too, because provenance is what makes a
 * recovered artifact more than a loose file: without it a derived artifact
 * comes back with no parent and no record of what made it.
 */
export interface ArtifactSidecar {
  schemaVersion: 1;
  savedAt: string;
  artifact: ProvenanceGraph['artifacts'][string];
  executions: ProvenanceGraph['executions'][string][];
}

export async function writeArtifactSidecar(
  artifact: ArtifactSidecar['artifact'],
  executions: ArtifactSidecar['executions'],
  workspaceId?: string
): Promise<void> {
  const payload: ArtifactSidecar = {
    schemaVersion: 1, savedAt: new Date().toISOString(), artifact, executions,
  };
  const d = await artifactDir(artifact.id, true, workspaceId);
  const h = await d.getFileHandle(ARTIFACT_SIDECAR, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(payload)));
  await w.close();
}

export async function readArtifactSidecar(
  id: string, workspaceId?: string
): Promise<ArtifactSidecar | null> {
  try {
    const d = await artifactDir(id, false, workspaceId);
    const text = await (await (await d.getFileHandle(ARTIFACT_SIDECAR)).getFile()).text();
    const parsed = JSON.parse(text) as ArtifactSidecar;
    return parsed?.artifact?.id ? parsed : null;
  } catch { return null; }
}

/**
 * Every artifact directory on disk, with the files in it — what recovery reads
 * when a directory has no sidecar and has to be reconstructed from its Parquet
 * files alone.
 */
export async function listArtifactDirectories(
  workspaceId?: string
): Promise<Array<{ id: string; files: string[]; bytes: number }>> {
  const out: Array<{ id: string; files: string[]; bytes: number }> = [];
  let root: FileSystemDirectoryHandle;
  try { root = await dir(DIR_ARTIFACTS, false, workspaceId); } catch { return out; }
  for await (const [id, handle] of (root as any).entries()) {
    if (handle.kind !== 'directory') continue;
    const files: string[] = [];
    let bytes = 0;
    for await (const [fname, fhandle] of (handle as any).entries()) {
      if (fhandle.kind !== 'file') continue;
      files.push(fname);
      try { bytes += (await fhandle.getFile()).size; } catch { /* unreadable is still present */ }
    }
    out.push({ id, files, bytes });
  }
  return out;
}

export async function readCatalog(workspaceId?: string): Promise<ProvenanceGraph> {
  const read = async (name: string): Promise<ProvenanceGraph> => {
    const h = await (await workspaceRoot(workspaceId)).getFileHandle(name);
    const text = await (await h.getFile()).text();
    const parsed = JSON.parse(text);
    return { artifacts: parsed.artifacts ?? {}, executions: parsed.executions ?? {} };
  };
  try {
    return await read(CATALOG);
  } catch (mainError) {
    // `createWritable()` replaces the file contents. A tab reload at exactly
    // the wrong moment must not turn a momentary partial JSON file into a
    // permanently empty workspace on the next boot.
    try { return await read(CATALOG_BACKUP); }
    catch { return { artifacts: {}, executions: {} }; }
  }
}

/**
 * Serializes `writeCatalog` per workspace.
 *
 * `putDerived` runs on every keystroke of an unthrottled editor (e.g. the
 * Transform editor's rule inputs), and each call reads the catalog,
 * recomputes, and writes it back. Two overlapping calls both reaching the
 * `createSyncAccessHandle()` branch below throw `NoModificationAllowedError`
 * — access handles are exclusive, and nothing upstream serializes calls into
 * this function. A promise-chain queue, keyed by workspace so unrelated
 * workspaces' writes don't wait on each other, guarantees only one write is
 * ever in flight per workspace — the same single-flight idea `DataClient
 * .boot()` already uses for the analogous double-mount race, just queuing
 * every call through rather than collapsing duplicates, since unlike a boot
 * each write carries genuinely new data and must still run.
 */
const writeCatalogQueues = new Map<string, Promise<void>>();

export function writeCatalog(g: ProvenanceGraph, workspaceId?: string): Promise<void> {
  const key = workspaceId ?? '';
  const previous = writeCatalogQueues.get(key) ?? Promise.resolve();
  const next = previous.then(() => writeCatalogNow(g, workspaceId), () => writeCatalogNow(g, workspaceId));
  // Queued on a settled (not rejected) promise, so one failed write does not
  // permanently wedge every write queued behind it.
  writeCatalogQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function writeCatalogNow(g: ProvenanceGraph, workspaceId?: string): Promise<void> {
  const r = await workspaceRoot(workspaceId);
  const data = new TextEncoder().encode(JSON.stringify(g, null, 2));
  // Preserve the complete old document before replacing it. The catalog is
  // small metadata, so this costs little and is much safer than eagerly
  // pruning the only copy of a source log when a browser kills a write.
  let before: ProvenanceGraph | null = null;
  try {
    // `getFile()` returns a promise, and the missing await here meant this
    // whole block threw `arrayBuffer is not a function` on every single write
    // — silently, into the catch below. The backup this comment promises was
    // never once written; the first catalog loss had nothing to fall back on.
    const file = await (await r.getFileHandle(CATALOG)).getFile();
    const previous = new Uint8Array(await file.arrayBuffer());
    if (previous.byteLength) {
      const backup = await r.getFileHandle(CATALOG_BACKUP, { create: true });
      const w = await backup.createWritable();
      await w.write(previous); await w.close();
      try {
        const parsed = JSON.parse(new TextDecoder().decode(previous));
        before = { artifacts: parsed.artifacts ?? {}, executions: parsed.executions ?? {} };
      } catch { /* an unparseable previous catalog is exactly what the backup is for */ }

      // Losing artifacts is the one catalog change worth keeping a copy of
      // beyond the next write — see CATALOG_RESCUE.
      const lost = before && Object.keys(before.artifacts)
        .some((id) => !(id in g.artifacts));
      if (lost) {
        const rescue = await r.getFileHandle(CATALOG_RESCUE, { create: true });
        const rw = await rescue.createWritable();
        await rw.write(previous); await rw.close();
      }
    }
  } catch { /* First write has no previous catalog to preserve. */ }

  const h = await r.getFileHandle(CATALOG, { create: true });
  // Sync access handles are worker-only; createWritable keeps this callable
  // from the main thread too, and the catalog is small.
  if ('createSyncAccessHandle' in h && typeof self.importScripts === 'function') {
    const sah = await (h as any).createSyncAccessHandle();
    sah.truncate(0); sah.write(data, { at: 0 }); sah.flush(); sah.close();
  } else {
    const w = await h.createWritable();
    await w.write(data); await w.close();
  }

  await refreshSidecars(g, before, workspaceId);
}

/**
 * Keeps each artifact's sidecar in step with the catalog, writing only the
 * entries that actually changed.
 *
 * Doing this from the catalog write rather than from each mutation site
 * means there is nowhere an artifact can be created, renamed or re-run and
 * quietly miss its sidecar — and a sidecar that went missing (or predates this
 * mechanism) is written the next time anything about that artifact changes.
 * A failure here must never fail the catalog write: the catalog is the
 * primary record and the sidecar is the insurance.
 */
async function refreshSidecars(
  g: ProvenanceGraph, before: ProvenanceGraph | null, workspaceId?: string
): Promise<void> {
  const executionsFor = (a: ProvenanceGraph['artifacts'][string]) =>
    (a.producedBy && g.executions[a.producedBy] ? [g.executions[a.producedBy]] : []);
  for (const a of Object.values(g.artifacts)) {
    const previous = before?.artifacts[a.id];
    if (previous && JSON.stringify(previous) === JSON.stringify(a)) continue;
    try { await writeArtifactSidecar(a, executionsFor(a), workspaceId); }
    catch { /* insurance, never an obstacle */ }
  }
}

export async function deleteArtifactFiles(id: string, workspaceId?: string): Promise<void> {
  try {
    const d = await dir(DIR_ARTIFACTS, false, workspaceId);
    await d.removeEntry(id, { recursive: true });
  } catch (e: any) {
    // An already-absent directory is a successful delete. Anything else
    // (notably an OPFS access handle still held by DuckDB) must reach the
    // caller instead of silently leaving an orphan behind.
    if (e?.name === 'NotFoundError') return;
    throw e;
  }
}

/** Removes directories that no longer have an artifact catalog entry. */
export async function pruneOrphanArtifactFiles(knownIds: Set<string>): Promise<string[]> {
  let artifacts: FileSystemDirectoryHandle;
  try { artifacts = await dir(DIR_ARTIFACTS, false); }
  catch (e: any) {
    if (e?.name === 'NotFoundError') return [];
    throw e;
  }

  const removed: string[] = [];
  for await (const [name, handle] of (artifacts as any).entries()) {
    if (handle.kind !== 'directory' || knownIds.has(name)) continue;
    await artifacts.removeEntry(name, { recursive: true });
    removed.push(name);
  }
  return removed;
}

/** Byte size of everything under an artifact, for the tree and storage meter. */
export async function artifactSize(id: string, workspaceId?: string): Promise<number> {
  let total = 0;
  try {
    const d = await artifactDir(id, false, workspaceId);
    for await (const [, h] of (d as any).entries()) {
      if (h.kind === 'file') total += (await h.getFile()).size;
    }
  } catch {}
  return total;
}

export async function listStaging(): Promise<string[]> {
  const out: string[] = [];
  try {
    const d = await dir(DIR_STAGING, false);
    for await (const [name] of (d as any).entries()) out.push(name);
  } catch {}
  return out;
}

export async function clearStaging(): Promise<void> {
  try { await (await workspaceRoot()).removeEntry(DIR_STAGING, { recursive: true }); } catch {}
}

/**
 * Wipes the active workspace's own subtree: its catalog, every artifact's
 * Parquet files, staging, and saved views. Installed plugins, the engine
 * arming file, other workspaces, and the workspace registry itself are
 * untouched. The escape hatch for a workspace whose catalog has gone
 * inconsistent (a root deleted before cascade-delete existed, an
 * interrupted write) — there is no partial-repair path, so starting over is
 * the recovery.
 */
export async function resetActiveWorkspace(): Promise<void> {
  const r = await workspaceRoot();
  for await (const [name] of (r as any).entries()) {
    await r.removeEntry(name, { recursive: true });
  }
}
