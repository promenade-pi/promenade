/**
 * Data worker.
 *
 * Owns DuckDB, the streaming parsers and all OPFS writes. The main thread
 * never parses and never queries directly — which is what keeps import from
 * blocking the UI, and what makes `host.sql()` a real boundary rather than a
 * convention.
 */
import * as arrow from 'apache-arrow';
import { bootDuckDB, duckdb, type DuckHandle } from '../host/data/duck';
import { ingestXES } from '../ingest/xes';
import { encodeXes, encodeXesCsv, type XesLog } from '../ingest/xes-formats';
import { ingestOcelJson } from '../ingest/ocel-json';
import { encodeOcel, ingestOcelRecords, parseBundle, parseOcelCsv, parseOcelXml, parsePromCsv, type OcelLog } from '../ingest/ocel-formats';
import { encodeOcelSqlite, parseOcelSqlite } from '../ingest/ocel-sqlite';
import { fileSource, gzipFileSource } from '../ingest/lib/chunks';
import {
  artifactDir, readCatalog, writeCatalog, quota, requestPersistence,
  deleteArtifactFiles, pruneOrphanArtifactFiles, artifactSize, resetActiveWorkspace, DIR_ARTIFACTS,
  storageBreakdown, clearCacheStorage, ensureWorkspaces, readWorkspaces, createWorkspace,
  renameWorkspace, deleteWorkspace, setActiveWorkspaceId, getActiveWorkspaceId, workspaceRoot,
  moveArtifactDir, listArtifactDirectories, readArtifactSidecar,
} from '../host/data/opfs';
import { reconstructArtifact } from '../host/artifact/recover';
// `host/plugins/store.ts` is main-thread only: it transitively imports
// `host/data/client.ts`, which spawns this very worker at module scope.
// Plugin package assembly for export/import therefore happens on the main
// thread instead — this worker only ever moves catalog/Parquet/saved-view
// data, never plugin registry state.
import { listSavedViews, moveViewsForSources, type SavedView } from '../host/views/savedViews';
import { compilePlan } from '../host/transform/compile';
import { classifierSql } from '../host/transform/classifier';
import { descendantsOf, type Artifact, type ProvenanceGraph } from '../host/artifact/types';
import { compileProgram, RelationalCompileError, type CompiledStatement } from '../host/relational/compileProgram';
import { parseProgram } from '../host/relational/sqlProfile';
import { schemaFor, PHYSICAL_LOGICAL_NAME } from '../host/relational/schemas';
import type { RelationalInputBinding } from '../host/relational/types';
import type { ParamTypeSchema } from '../host/relational/paramBinding';

let duck: DuckHandle | null = null;
const registered = new Set<string>();
/** Logical DuckDB view -> BROWSER_FSACCESS filename, for explicit release. */
const registeredFiles = new Map<string, string>();

const post = (type: string, payload: unknown) => self.postMessage({ type, payload });
const log = (m: string) => post('log', m);

/** Table naming: one flat namespace, prefixed by artifact id. */
const tableName = (artifactId: string, logical: string) =>
  `${artifactId.replace(/[^a-zA-Z0-9_]/g, '_')}__${logical}`;

/**
 * Cap on how much of a non-Parquet artifact file crosses a boundary at once.
 *
 * These are sidecars and materialized JSON payloads — kilobytes as a rule,
 * but a payload for an inline artifact can be arbitrarily large, and the one
 * caller is a viewer that will only ever show the first screenful anyway.
 */
const MAX_RAW_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Validates a path *inside* one artifact's directory.
 *
 * The caller of `artifactFile` is sandboxed plugin code, so the path is
 * untrusted input: without this, `../` would walk out of the artifact and
 * `../../catalog.json` would read the whole workspace. Allowing only plain
 * relative segments of a known character set is a smaller thing to be right
 * about than trying to normalize a path and then check where it landed.
 */
function safeArtifactPath(path: unknown): string {
  const raw = String(path ?? '');
  const segments = raw.split('/');
  const ok = raw.length > 0 && raw.length <= 256 && segments.length <= 5
    && segments.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && s !== '.' && s !== '..');
  if (!ok) throw new Error(`not a valid path inside an artifact: ${raw}`);
  return raw;
}

/**
 * Mounts a Parquet file that is *not* one of the artifact's declared
 * relations — an orphan left by a dropped relation, or a file written beside
 * the catalog's knowledge of it.
 *
 * Kept in its own registry with its own view names so `remove`/`move`, which
 * release handles by walking the artifact's logical relations, can release
 * these too (`releaseRawMounts`) — an OPFS access handle DuckDB still holds
 * blocks the directory delete.
 */
const rawMounts = new Map<string, { relation: string; vname: string }>();

async function mountRawParquet(id: string, path: string) {
  const key = `${id}/${path}`;
  const existing = rawMounts.get(key);
  if (existing) return existing;
  const { db, conn } = duck!;
  const segments = path.split('/');
  let dirHandle = await artifactDir(id, false);
  for (const segment of segments.slice(0, -1)) dirHandle = await dirHandle.getDirectoryHandle(segment);
  const handle = await dirHandle.getFileHandle(segments[segments.length - 1]);
  const safe = key.replace(/[^a-zA-Z0-9_]/g, '_');
  const vname = `raw_${safe}`;
  const relation = `raw__${safe}`;
  await db.registerFileHandle(vname, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
  await conn.query(`CREATE OR REPLACE VIEW ${relation} AS SELECT * FROM read_parquet('${vname}')`);
  const mount = { relation, vname };
  rawMounts.set(key, mount);
  return mount;
}

/** Drops the raw mounts for one artifact, releasing their OPFS handles. */
async function releaseRawMounts(id: string) {
  for (const [key, mount] of [...rawMounts]) {
    if (key !== id && !key.startsWith(`${id}/`)) continue;
    try { await duck?.conn.query(`DROP VIEW IF EXISTS ${mount.relation} CASCADE`); } catch {}
    try { await duck?.db.dropFile(mount.vname); } catch {}
    rawMounts.delete(key);
  }
}

/** The complete OCEL relation set, including relations that may be empty. */
const OCEL_RELATION_COLUMNS: Record<string, string> = {
  event: 'event_id VARCHAR, activity VARCHAR, ts TIMESTAMP',
  object: 'object_id VARCHAR, object_type VARCHAR',
  e2o: 'event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR',
  o2o: 'source_id VARCHAR, target_id VARCHAR, qualifier VARCHAR',
  event_attr: 'event_id VARCHAR, name VARCHAR, value VARCHAR',
  object_attr: 'object_id VARCHAR, name VARCHAR, value VARCHAR, ts TIMESTAMP',
};

function emptyRelationSelect(columns: string) {
  return columns.split(', ').map((column) => {
    const [name, ...type] = column.split(' ');
    return `CAST(NULL AS ${type.join(' ')}) AS ${name}`;
  }).join(', ');
}

/**
 * Writes a DuckDB table to Parquet in the artifact's OPFS directory.
 *
 * COPY must target a handle registered with BROWSER_FSACCESS; writing to a
 * virtual path and copying the buffer back out yields a 1-byte file.
 */
async function tableToParquet(artifactId: string, table: string, logical: string) {
  const { db, conn } = duck!;
  const dir = await artifactDir(artifactId);
  const fileName = `${logical}.parquet`;
  const handle = await dir.getFileHandle(fileName, { create: true });
  const vname = `${artifactId}_${logical}.parquet`;

  await db.registerFileHandle(vname, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
  await conn.query(
    `COPY (SELECT * FROM ${table}) TO '${vname}' (FORMAT parquet, COMPRESSION zstd)`
  );
  await db.flushFiles();
  await db.dropFile(vname);

  const bytes = (await (await dir.getFileHandle(fileName)).getFile()).size;
  log(`parquet ${logical}: ${bytes} bytes`);
  if (bytes === 0) throw new Error(`COPY produced an empty Parquet file for ${logical}`);
  return { file: `${DIR_ARTIFACTS}/${artifactId}/${fileName}`, logical, bytes };
}

/** A logical column type as DuckDB spells it, for the typed NULLs of an absent column. */
const DUCKDB_TYPE: Record<string, string> = {
  bigint: 'BIGINT', integer: 'INTEGER', varchar: 'VARCHAR',
  timestamp: 'TIMESTAMP', double: 'DOUBLE', boolean: 'BOOLEAN',
};

/**
 * The tail every "write a log from tables the caller supplied" path shares:
 * mount the freshly written Parquet files and describe what they contain.
 *
 * The shell artifact is a throwaway, never written to the catalog — see the
 * identical comment in `materializeRelationalLog`.
 */
async function mountAndSummarizeLog(id: string, targetType: string, files: Record<string, string>) {
  const shell: Artifact = {
    id, name: '', type: targetType, createdAt: new Date().toISOString(),
    storage: { kind: 'parquet', files }, meta: {}, producedBy: null, inputs: [],
  };
  await mountArtifact(shell);

  const kind = targetType === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
  const meta = {
    ...(await summarize(id, kind)),
    capabilities: await capabilitiesOf(id, kind, null),
  };
  return { storage: shell.storage, meta };
}

/**
 * Exposes an artifact's Parquet files as views.
 *
 * This is what "opening" an artifact means: register handles, create views.
 * Nothing is copied and nothing is decoded, so an open log costs a handle and
 * some metadata rather than its contents.
 */
/**
 * Last catalog read, kept so a derived log can find its source.
 *
 * Mounting is recursive — a transform may read another transform — and the
 * chain is resolved by id, not by a pointer, because the catalog is the only
 * place where artifact identity is authoritative.
 */
let catalogCache: ProvenanceGraph | null = null;

async function sourceBytes(source: { chunks(onProgress: (done: number) => void): AsyncIterable<Uint8Array> }, onProgress: (done: number, total: number) => void = () => {}) {
  const parts: Uint8Array[] = []; let size = 0;
  for await (const part of source.chunks((done) => onProgress(done, (source as any).size ?? 0))) { parts.push(part); size += part.byteLength; }
  const out = new Uint8Array(size); let at = 0; for (const part of parts) { out.set(part, at); at += part.byteLength; }
  return out;
}

/** Recreates only the interchange shape at the boundary; artifacts stay columnar internally. */
async function ocelLogOf(artifact: Artifact): Promise<OcelLog> {
  await mountArtifact(artifact);
  const t = (logical: string) => tableName(artifact.id, logical);
  const rows = async (sql: string) => (await duck!.conn.query(sql)).toArray().map((r: any) => r.toJSON());
  const semantics: any = artifact.meta?.semantics ?? {};
  const events = (await rows(`SELECT event_id, activity, ts FROM ${t('event')} ORDER BY event_id`)).map((e: any) => ({ id: String(e.event_id), type: String(e.activity), time: e.ts, attributes: [] as any[], relationships: [] as any[] }));
  const objects = (await rows(`SELECT object_id, object_type FROM ${t('object')} ORDER BY object_id`)).map((o: any) => ({ id: String(o.object_id), type: String(o.object_type), attributes: [] as any[], relationships: [] as any[] }));
  const byEvent = new Map(events.map((e: any) => [e.id, e])), byObject = new Map(objects.map((o: any) => [o.id, o]));
  try { for (const r of await rows(`SELECT * FROM ${t('event_attr')}`)) byEvent.get(String(r.event_id))?.attributes.push({ name: String(r.name), value: r.value }); } catch {}
  try { for (const r of await rows(`SELECT * FROM ${t('object_attr')}`)) byObject.get(String(r.object_id))?.attributes.push({ name: String(r.name), time: r.ts, value: r.value }); } catch {}
  try { for (const r of await rows(`SELECT * FROM ${t('e2o')}`)) byEvent.get(String(r.event_id))?.relationships.push({ objectId: String(r.object_id), qualifier: r.qualifier }); } catch {}
  try { for (const r of await rows(`SELECT * FROM ${t('o2o')}`)) byObject.get(String(r.source_id))?.relationships.push({ objectId: String(r.target_id), qualifier: r.qualifier }); } catch {}
  const declaredEvents = semantics.eventTypes ?? [], declaredObjects = semantics.objectTypes ?? [];
  const named = (declared: any[], records: any[]) => {
    const seen = new Set(declared.map((d) => d.name));
    const inferred = [...new Set(records.map((r) => r.type).filter((n) => !seen.has(n)))].sort();
    return [...declared, ...inferred.map((name) => ({ name, attributes: [] }))];
  };
  return { events, objects, eventTypes: named(declaredEvents, events), objectTypes: named(declaredObjects, objects) };
}

/** Recreates XES only at the explicit export boundary. */
async function xesLogOf(artifact: Artifact): Promise<XesLog> {
  await mountArtifact(artifact);
  const t = (logical: string) => tableName(artifact.id, logical);
  const rows = async (sql: string) => (await duck!.conn.query(sql)).toArray().map((r: any) => r.toJSON());
  const traces = (await rows(`SELECT trace_idx, case_id FROM ${t('trace')} ORDER BY trace_idx`)).map((trace: any) => ({ id: String(trace.trace_idx), caseId: trace.case_id, attributes: [] as any[] }));
  const byTrace = new Map(traces.map((trace: any) => [trace.id, trace]));
  const events = (await rows(`SELECT event_idx, trace_idx, activity, ts, lifecycle, resource FROM ${t('event')} ORDER BY event_idx`)).map((event: any) => ({ id: String(event.event_idx), traceId: String(event.trace_idx), activity: event.activity, time: event.ts, lifecycle: event.lifecycle, resource: event.resource, attributes: [] as any[] }));
  const byEvent = new Map(events.map((event: any) => [event.id, event]));
  try { for (const attr of await rows(`SELECT trace_idx, key, type, value FROM ${t('trace_attr')}`)) byTrace.get(String(attr.trace_idx))?.attributes.push(attr); } catch {}
  try { for (const attr of await rows(`SELECT event_idx, key, type, value FROM ${t('event_attr')}`)) byEvent.get(String(attr.event_idx))?.attributes.push(attr); } catch {}
  return { traces, events, semantics: artifact.meta?.semantics ?? {} };
}

async function mountArtifact(a: Artifact) {
  if (a.storage.kind === 'view') { await mountDerived(a); return; }
  if (a.storage.kind !== 'parquet') return;
  const { db, conn } = duck!;
  const dir = await artifactDir(a.id, false).catch(() => null);
  if (!dir) return;

  for (const [logical] of Object.entries(a.storage.files)) {
    const view = tableName(a.id, logical);
    if (registered.has(view)) continue;
    const fileName = `${logical}.parquet`;
    let handle: FileSystemFileHandle;
    try { handle = await dir.getFileHandle(fileName); } catch { continue; }
    const vname = `${a.id}_${fileName}`;
    await db.registerFileHandle(vname, handle, duckdb.DuckDBDataProtocol.BROWSER_FSACCESS, true);
    // The event table gets one level of indirection so the classifier has
    // somewhere to live. Everything else maps straight to its Parquet file.
    const target = logical === 'event' ? `${view}__src` : view;
    await conn.query(
      `CREATE OR REPLACE VIEW ${target} AS SELECT * FROM read_parquet('${vname}')`
    );
    registered.add(view);
    registeredFiles.set(view, vname);
  }

  // Older imports omitted Parquet files for relations with no rows. Mount
  // empty views for those artifacts too, so every OCEL log has the canonical
  // six-relation schema without requiring a re-import.
  if (a.type === 'ObjectCentricEventLog') {
    for (const [logical, columns] of Object.entries(OCEL_RELATION_COLUMNS)) {
      const view = tableName(a.id, logical);
      if (registered.has(view)) continue;
      await conn.query(`CREATE OR REPLACE VIEW ${view} AS SELECT ${emptyRelationSelect(columns)} WHERE FALSE`);
      registered.add(view);
    }
  }

  await applyClassifier(a);
}

/**
 * Defines the log's `event.activity` column from its classifier.
 *
 * Applied here rather than expanded into plugin SQL: a placeholder every
 * plugin has to remember to use is a placeholder some plugins forget, and
 * those would silently ignore the user's choice. Defining the column instead
 * means the Rust kernel, the pm4py plugin and every view see the classifier
 * without knowing it exists.
 */
async function applyClassifier(a: Artifact) {
  if (a.storage.kind !== 'parquet' || !a.storage.files.event) return;
  const { conn } = duck!;
  const view = tableName(a.id, 'event');
  const attr = a.storage.files.event_attr ? tableName(a.id, 'event_attr') : null;
  const sql = classifierSql(`${view}__src`, attr, (a.meta as any)?.classifier);
  await conn.query(`CREATE OR REPLACE VIEW ${view} AS ${sql}`);
}

/**
 * Rebuilds a derived log's views from its plan.
 *
 * Stage views from an earlier, longer plan are dropped first: `CREATE OR
 * REPLACE` only overwrites what the new plan happens to name again, and a
 * leftover stage would keep a reference to relations the plan no longer has.
 */
async function mountDerived(a: Artifact, previous?: Artifact) {
  if (a.storage.kind !== 'view') return;
  const { conn } = duck!;
  const plan = a.storage.plan;
  const parent = catalogCache?.artifacts[plan.source];
  if (!parent) throw new Error(`source log ${plan.source} is gone`);

  // The source may itself be derived; mount it first.
  await mountArtifact(parent);

  const parentTables: Record<string, string> = {};
  for (const l of logicalTables(parent)) parentTables[l] = tableName(parent.id, l);

  const safe = a.id.replace(/[^a-zA-Z0-9_]/g, '_');
  const stale = await conn.query(
    `SELECT view_name FROM duckdb_views() WHERE view_name LIKE '${safe}__s%'`
  );
  for (const r of stale.toArray()) {
    await conn.query(`DROP VIEW IF EXISTS ${(r as any).view_name} CASCADE`);
  }

  const { statements, tables } = compilePlan(a.id, parentTables, plan.ops);
  // A disabled/enabled flatten can change the artifact's logical schema. Drop
  // relations which belonged to the previous shape before publishing the new
  // one, otherwise an old `trace` view could remain queryable on an OCEL.
  const staleRelations = previous
    ? logicalTables(previous).filter((l) => !Object.prototype.hasOwnProperty.call(tables, l)) : [];
  for (const logical of staleRelations) {
    await conn.query(`DROP VIEW IF EXISTS ${tableName(a.id, logical)} CASCADE`);
    registered.delete(tableName(a.id, logical));
  }
  for (const sql of statements) await conn.query(sql);
  for (const l of Object.keys(tables)) registered.add(tableName(a.id, l));
}

/** Whether `a` reads from `sourceId`, directly or through other transforms. */
function dependsOn(g: ProvenanceGraph, a: Artifact, sourceId: string): boolean {
  const seen = new Set<string>();
  let cur: Artifact | undefined = a;
  while (cur && cur.storage.kind === 'view' && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.storage.plan.source === sourceId) return true;
    cur = g.artifacts[cur.storage.plan.source];
  }
  return false;
}

/** Logical table names of an artifact, whichever way it is stored. */
function logicalTables(a: Artifact): string[] {
  if (a.storage.kind === 'parquet') return Object.keys(a.storage.files);
  if (a.storage.kind === 'view') return a.storage.tables;
  return [];
}

/** Type-specific summary for the overview view; computed once at import. */
/**
 * Observes what a log actually contains.
 *
 * Recomputed for every artifact, including derived ones: a filter can remove
 * the last event that carried a resource, and an action offered on the strength
 * of a capability the log no longer has is worse than one that was never
 * offered.
 *
 * Each check is a single aggregate over a column, so this costs one pass per
 * property rather than a scan per plugin that wonders.
 */
async function capabilitiesOf(
  artifactId: string, kind: 'ocel' | 'xes', semantics: any
): Promise<string[]> {
  const { conn } = duck!;
  const t = (l: string) => tableName(artifactId, l);
  const caps: string[] = [];
  const count = async (sql: string) => {
    try { return Number((await conn.query(sql)).get(0)!.toJSON().n); }
    catch { return 0; }
  };
  // Attribute relations are optional physical tables: a source log with no
  // attributes never materialises one.  Do the cheap catalog lookup before
  // asking DuckDB to count it — catching the missing-table error still makes
  // DuckDB-Wasm print a noisy console error, which looks like a failed action
  // even though the capability probe recovered correctly.
  const hasTable = async (logical: string) => {
    const name = t(logical).replace(/'/g, "''");
    return Number((await conn.query(
      `SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name='${name}'`
    )).get(0)!.toJSON().n) > 0;
  };

  if (kind === 'xes') {
    if (await count(`SELECT COUNT(ts) AS n FROM ${t('event')}`)) caps.push('event.timestamp');
    if (await count(`SELECT COUNT(lifecycle) AS n FROM ${t('event')}`)) caps.push('event.lifecycle');
    if (await count(`SELECT COUNT(resource) AS n FROM ${t('event')}`)) caps.push('event.resource');
    if (await hasTable('event_attr') && await count(`SELECT COUNT(*) AS n FROM ${t('event_attr')}`)) caps.push('event.attributes');
    if (await hasTable('trace_attr') && await count(`SELECT COUNT(*) AS n FROM ${t('trace_attr')}`)) caps.push('case.attributes');
    if (semantics) caps.push('xes.semantics');
    if (semantics?.classifiers?.length) caps.push('xes.classifiers');
  } else {
    if (await count(`SELECT COUNT(ts) AS n FROM ${t('event')}`)) caps.push('event.timestamp');
    if (await count(`SELECT COUNT(*) AS n FROM ${t('object')}`)) caps.push('objects');
    if (await count(`SELECT COUNT(qualifier) AS n FROM ${t('e2o')}`)) caps.push('e2o.qualifiers');
    if (await count(`SELECT COUNT(*) AS n FROM ${t('o2o')}`)) caps.push('o2o');
    if (await hasTable('object_attr') && await count(`SELECT COUNT(*) AS n FROM ${t('object_attr')}`)) caps.push('object.attributes');
    // Time dependence is observed, not declared: an attribute is
    // time-dependent precisely when one object has more than one value for it.
    if (await hasTable('object_attr') && await count(
      `SELECT COUNT(*) AS n FROM (SELECT object_id, name FROM ${t('object_attr')}
       GROUP BY 1, 2 HAVING COUNT(*) > 1)`
    )) caps.push('object.attributes.timeDependent');
    if (await hasTable('event_attr') && await count(`SELECT COUNT(*) AS n FROM ${t('event_attr')}`)) caps.push('event.attributes');
    if (semantics) caps.push('ocel2.semantics');
  }
  return caps;
}

async function summarize(artifactId: string, kind: 'ocel' | 'xes') {
  const { conn } = duck!;
  const t = (l: string) => tableName(artifactId, l);
  const one = async (sql: string) => (await conn.query(sql)).get(0)!.toJSON() as any;

  if (kind === 'xes') {
    const c = await one(`
      SELECT COUNT(*) AS events, COUNT(DISTINCT trace_idx) AS traces,
             COUNT(DISTINCT activity) AS activities,
             MIN(ts) AS ts_min, MAX(ts) AS ts_max
      FROM ${t('event')}`);
    const acts = await conn.query(`
      SELECT activity, COUNT(*) AS n FROM ${t('event')}
      GROUP BY 1 ORDER BY n DESC LIMIT 100`);
    return {
      events: Number(c.events), traces: Number(c.traces),
      activities: Number(c.activities),
      timeRange: [c.ts_min, c.ts_max],
      topActivities: acts.toArray().map((r: any) => ({
        activity: r.activity, count: Number(r.n),
      })),
    };
  }

  const c = await one(`
    SELECT COUNT(*) AS events, COUNT(DISTINCT activity) AS activities,
           MIN(ts) AS ts_min, MAX(ts) AS ts_max
    FROM ${t('event')}`);
  const o = await one(`
    SELECT COUNT(*) AS objects, COUNT(DISTINCT object_type) AS objectTypes
    FROM ${t('object')}`);
  const acts = await conn.query(`
    SELECT activity, COUNT(*) AS n FROM ${t('event')}
    GROUP BY 1 ORDER BY n DESC LIMIT 100`);
  const otypes = await conn.query(`
    SELECT object_type, COUNT(*) AS n FROM ${t('object')}
    GROUP BY 1 ORDER BY n DESC LIMIT 100`);

  // Static vs time-dependent is observed, not declared: an object attribute is
  // time-dependent exactly when some object carries more than one value for it.
  //
  // Each source is queried separately. A sink that never received a row leaves
  // no table behind, so a log with no event attributes has no event_attr table
  // — and one combined query would fail entirely and report zero for
  // everything, including the attributes that are actually there.
  const attrs = { eventAttrs: 0, objectAttrs: 0, timeDependent: 0, staticAttrs: 0 };
  try {
    const a = await one(`SELECT COUNT(*) AS n FROM ${t('event_attr')}`);
    attrs.eventAttrs = Number(a.n);
  } catch { /* no event attributes in this log */ }
  try {
    const a = await one(`
      SELECT
        (SELECT COUNT(*) FROM ${t('object_attr')}) AS object_attrs,
        (SELECT COUNT(DISTINCT name) FROM (
           SELECT object_id, name FROM ${t('object_attr')}
           GROUP BY object_id, name HAVING COUNT(DISTINCT ts) > 1
         )) AS time_dependent,
        (SELECT COUNT(DISTINCT name) FROM ${t('object_attr')}) AS distinct_names`);
    attrs.objectAttrs = Number(a.object_attrs);
    attrs.timeDependent = Number(a.time_dependent);
    attrs.staticAttrs = Number(a.distinct_names) - Number(a.time_dependent);
  } catch { /* no object attributes in this log */ }

  return {
    events: Number(c.events), activities: Number(c.activities),
    objects: Number(o.objects), objectTypes: Number(o.objectTypes),
    timeRange: [c.ts_min, c.ts_max],
    ...attrs,
    topActivities: acts.toArray().map((r: any) => ({
      activity: r.activity, count: Number(r.n),
    })),
    objectTypeList: otypes.toArray().map((r: any) => ({
      objectType: r.object_type, count: Number(r.n),
    })),
  };
}

/**
 * Re-derives OCEL `semantics.objectTypes`/`eventTypes` (declared type names
 * plus their observed attribute types) live from an artifact's own tables.
 *
 * `semantics` is normally set once at ingest, from the log's own declared
 * types (`ocel-json.ts`, `ocel-formats.ts`). A transform-derived artifact is
 * created with `meta: {}` (`App.tsx`'s `onTransform`) and never acquires a
 * `semantics` afterwards — `putDerived` only ever spreads the existing,
 * absent value forward. Every OCEL-aware plugin view (Object Types, Objects,
 * Event Types, Events, Overview — see `plugins/ocelot`) reads its type list
 * from exactly that field, so a transformed log's Object Types view renders
 * empty even though the artifact's own `object`/`event` tables are correct
 * and fully queryable — confirmed by `discover-object-interactions`, which
 * queries those tables directly instead of trusting declared semantics, and
 * shows the transformed data just fine. This computes the same declared
 * shape as ingest (`{ name, attributes: [{ name, type }] }`), live, so a
 * transform's renamed/merged/split types keep the same plugins working.
 */
async function liveOcelSemantics(artifactId: string) {
  const { conn } = duck!;
  const t = (l: string) => tableName(artifactId, l);
  // A value's type is observed, not declared: it counts as the narrowest
  // type every one of its values actually parses as, the same convention
  // `summarize()`'s own time-dependent-attribute check already uses.
  const attrTypeExpr = (value: string) => `
    CASE
      WHEN COUNT(*) FILTER (WHERE TRY_CAST(${value} AS BIGINT) IS NOT NULL AND ${value} NOT LIKE '%.%') = COUNT(*) THEN 'integer'
      WHEN COUNT(*) FILTER (WHERE TRY_CAST(${value} AS DOUBLE) IS NOT NULL) = COUNT(*) THEN 'float'
      WHEN COUNT(*) FILTER (WHERE lower(${value}) IN ('true', 'false')) = COUNT(*) THEN 'boolean'
      WHEN COUNT(*) FILTER (WHERE TRY_CAST(${value} AS TIMESTAMP) IS NOT NULL) = COUNT(*) THEN 'time'
      ELSE 'string'
    END`;

  const typesOf = async (entityTable: string, entityColumn: string, attrTable: string, idColumn: string) => {
    const names = (await conn.query(
      `SELECT DISTINCT ${entityColumn} AS name FROM ${entityTable} WHERE ${entityColumn} IS NOT NULL ORDER BY 1 LIMIT 200`
    )).toArray().map((r: any) => String(r.name));
    const attrsByType = new Map<string, Array<{ name: string; type: string }>>();
    try {
      const rows = (await conn.query(`
        SELECT e.${entityColumn} AS type_name, a.name AS attr_name, ${attrTypeExpr('a.value')} AS attr_type
        FROM ${attrTable} a JOIN ${entityTable} e ON e.${idColumn} = a.${idColumn}
        GROUP BY 1, 2
      `)).toArray();
      for (const r of rows as any[]) {
        const list = attrsByType.get(String(r.type_name)) ?? [];
        list.push({ name: String(r.attr_name), type: String(r.attr_type) });
        attrsByType.set(String(r.type_name), list);
      }
    } catch { /* no attribute table for this log */ }
    return names.map((name) => ({ name, attributes: attrsByType.get(name) ?? [] }));
  };

  const [objectTypes, eventTypes] = await Promise.all([
    typesOf(t('object'), 'object_type', t('object_attr'), 'object_id'),
    typesOf(t('event'), 'activity', t('event_attr'), 'event_id'),
  ]);
  return { objectTypes, eventTypes, sourceFormat: 'json' as const };
}

/** One dedicated DuckDB connection per cancellable sandbox query. The normal
 * shared connection stays available for mounting, import, and host work. */
const cancellableSql = new Map<string, import('@duckdb/duckdb-wasm').AsyncDuckDBConnection>();

const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  async boot() {
    const workspaces = await ensureWorkspaces();
    duck = await bootDuckDB(log);
    const g = await readCatalog();
    catalogCache = g;
    // Do not delete orphaned OPFS directories on boot. A reload that catches
    // an interrupted catalog write may briefly fall back to an older
    // catalog; automatic cleanup here would then permanently erase source
    // data before the user can inspect or recover it. The explicit, counted
    // maintenance action remains the only deletion path.
    // Re-mount everything the catalog knows about, so artifacts are usable
    // immediately after a reload without re-importing anything.
    for (const a of Object.values(g.artifacts)) {
      // One unmountable artifact must not take the whole session down with it:
      // a derived log whose source was deleted is a broken artifact, not a
      // broken database.
      try { await mountArtifact(a); }
      catch (e: any) {
        // A derived log whose source was deleted is broken, not absent. It stays
        // in the tree with the reason attached, the same way an artifact whose
        // producing plugin is gone does.
        log(`mount ${a.id} failed: ${e.message}`);
        g.artifacts[a.id] = { ...a, unavailable: e.message };
      }
    }
    /**
     * Backfill for artifacts imported before capabilities existed.
     *
     * Recomputed rather than assumed: capabilities are observations, and an
     * artifact that has never been looked at has none — which would make every
     * capability-gated action unavailable on exactly the logs the user already
     * had.
     */
    let backfilled = false;
    for (const a of Object.values(g.artifacts)) {
      if ((a.meta as any)?.capabilities || !logicalTables(a).includes('event')) continue;
      try {
        const kind = a.type === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
        g.artifacts[a.id] = {
          ...a,
          meta: {
            ...a.meta,
            capabilities: await capabilitiesOf(a.id, kind, (a.meta as any)?.semantics),
          },
        };
        backfilled = true;
      } catch (e: any) { log(`capabilities ${a.id}: ${e.message}`); }
    }
    if (backfilled) await writeCatalog(g);

    return {
      report: duck.report, catalog: g, quota: await quota(),
      workspaces, activeWorkspaceId: getActiveWorkspaceId(),
    };
  },

  async catalog() {
    return { catalog: await readCatalog(), quota: await quota() };
  },

  async listWorkspaces() {
    return { workspaces: await readWorkspaces(), activeWorkspaceId: getActiveWorkspaceId() };
  },

  async createWorkspace({ name }: { name: string }) {
    const workspace = await createWorkspace(name);
    return { workspace, workspaces: await readWorkspaces() };
  },

  async renameWorkspace({ id, name }: { id: string; name: string }) {
    return { workspaces: await renameWorkspace(id, name) };
  },

  /** Switching is otherwise a full page reload — this just records which
   * workspace the next boot should open. */
  async switchWorkspace({ id }: { id: string }) {
    await setActiveWorkspaceId(id);
    return { ok: true };
  },

  /**
   * Deletes the active workspace. DuckDB must let go of every handle inside
   * it first — the same requirement `reset()` has, and for the same reason
   * (an open OPFS access handle blocks the removal). The caller switches to
   * a remaining workspace and reloads right after, same as `reset()`.
   */
  async deleteActiveWorkspace() {
    if (duck) {
      await duck.conn.close().catch(() => {});
      await duck.db.terminate().catch(() => {});
      duck = null;
    }
    registered.clear();
    registeredFiles.clear();
    rawMounts.clear();
    catalogCache = null;
    const workspaces = await deleteWorkspace(getActiveWorkspaceId());
    return { workspaces };
  },

  /**
   * Moves an artifact — and everything derived from it — into another
   * workspace's OPFS subtree and catalog. Unmounts it first (drop views,
   * release DuckDB's OPFS handles) exactly like `remove()` does, since a
   * held access handle blocks the directory move the same way it blocks a
   * delete.
   */
  async moveArtifactToWorkspace({ artifactId, destWorkspaceId }: { artifactId: string; destWorkspaceId: string }) {
    if (!duck) throw new Error('not booted');
    const sourceId = getActiveWorkspaceId();
    const g = await readCatalog();
    if (!g.artifacts[artifactId]) throw new Error('unknown artifact');
    const toMove = [artifactId, ...descendantsOf(g, artifactId)];

    for (const id of toMove) {
      const a = g.artifacts[id];
      if (!a) continue;
      await releaseRawMounts(id);
      const relations = a.type === 'ObjectCentricEventLog'
        ? new Set([...logicalTables(a), ...Object.keys(OCEL_RELATION_COLUMNS)])
        : new Set(logicalTables(a));
      for (const l of relations) {
        const view = tableName(id, l);
        try { await duck.conn.query(`DROP VIEW IF EXISTS ${view} CASCADE`); } catch {}
        try { await duck.conn.query(`DROP VIEW IF EXISTS ${view}__src CASCADE`); } catch {}
        const file = registeredFiles.get(view);
        if (file) {
          try { await duck.db.dropFile(file); } catch {}
          registeredFiles.delete(view);
        }
        registered.delete(view);
      }
    }

    const destCatalog = await readCatalog(destWorkspaceId);
    for (const id of toMove) {
      await moveArtifactDir(id, sourceId, destWorkspaceId);
      const a = g.artifacts[id];
      if (a) { destCatalog.artifacts[id] = a; delete g.artifacts[id]; }
    }
    for (const [execId, exec] of Object.entries(g.executions)) {
      if (!exec.outputs.some((oid) => toMove.includes(oid))) continue;
      destCatalog.executions[execId] = exec;
      delete g.executions[execId];
    }

    await writeCatalog(destCatalog, destWorkspaceId);
    await writeCatalog(g);
    await moveViewsForSources(new Set(toMove), sourceId, destWorkspaceId);

    return { catalog: g, quota: await quota() };
  },

  /**
   * Gathers everything an exported workspace bundle needs: the catalog,
   * saved views, and every artifact's Parquet bytes. Plugin package
   * assembly happens on the main thread (see the import at the top of this
   * file) — this only ever moves data this worker already owns.
   */
  async exportWorkspaceData() {
    const list = await readWorkspaces();
    const activeId = getActiveWorkspaceId();
    const meta = list.find((w) => w.id === activeId)!;
    const g = await readCatalog();
    const views = await listSavedViews();

    const files: Record<string, Uint8Array> = {};
    for (const a of Object.values(g.artifacts)) {
      if (a.storage.kind !== 'parquet') continue;
      const artifactsDir = await artifactDir(a.id, false).catch(() => null);
      if (!artifactsDir) continue;
      for (const logical of Object.keys(a.storage.files)) {
        try {
          const fh = await artifactsDir.getFileHandle(`${logical}.parquet`);
          files[`${a.id}/${logical}.parquet`] = new Uint8Array(await (await fh.getFile()).arrayBuffer());
        } catch {}
      }
    }
    return { meta, artifacts: g.artifacts, executions: g.executions, views, files };
  },

  /** The counterpart of `exportWorkspaceData`: creates a new workspace and
   * writes everything into its subtree. */
  async importWorkspaceData({ name, artifacts, executions, views, files }: {
    name: string; artifacts: Record<string, Artifact>; executions: Record<string, any>;
    views: SavedView[]; files: Record<string, Uint8Array>;
  }) {
    const list = await readWorkspaces();
    let finalName = name || 'Imported workspace';
    if (list.some((w) => w.name === finalName)) {
      let n = 2;
      while (list.some((w) => w.name === `${finalName} (${n})`)) n++;
      finalName = `${finalName} (${n})`;
    }
    const created = await createWorkspace(finalName);
    await writeCatalog({ artifacts, executions }, created.id);

    if (views.length) {
      const r = await workspaceRoot(created.id);
      const h = await r.getFileHandle('saved-views.json', { create: true });
      const idx = Object.fromEntries(views.map((v) => [v.id, v]));
      const w = await h.createWritable();
      await w.write(new TextEncoder().encode(JSON.stringify(idx, null, 2)));
      await w.close();
    }

    for (const [path, data] of Object.entries(files)) {
      const slash = path.indexOf('/');
      const artifactsDir = await artifactDir(path.slice(0, slash), true, created.id);
      const fh = await artifactsDir.getFileHandle(path.slice(slash + 1), { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
    }

    return { workspace: created, workspaces: await readWorkspaces() };
  },

  async storageBreakdown() {
    const g = await readCatalog();
    return { breakdown: await storageBreakdown(new Set(Object.keys(g.artifacts))) };
  },

  /**
   * Rebuilds catalog entries for artifact directories the catalog has lost.
   *
   * Losing the catalog used to mean losing the artifacts: the files stayed on
   * disk but nothing knew their name, type or provenance, so the Storage panel
   * called them orphans and offered to delete them. Two sources make them
   * recoverable — each artifact's own `artifact.json` sidecar, which restores
   * the entry exactly, and failing that the Parquet files themselves, whose
   * names are the logical tables and whose shape identifies the log kind.
   *
   * A reconstructed artifact is marked as such rather than passed off as
   * intact: what cannot be recovered from files alone is its name, its
   * provenance and its summary metadata, and pretending otherwise would be
   * worse than saying so.
   */
  async recoverArtifacts() {
    const g = await readCatalog();
    const dirs = await listArtifactDirectories();
    /**
     * Saved views are a third, accidental record of what an artifact was
     * called: a view's title defaults to its artifact's name. It restores
     * nothing structural, but "Sepsis Cases.xes.gz" beats "Recovered log
     * (a_mtk…)" for anyone trying to work out what they just got back — and it
     * costs one file read that is already on disk.
     */
    const namesFromViews = new Map<string, string>();
    try {
      for (const v of await listSavedViews()) {
        if (v.sourceArtifactId && v.title && !namesFromViews.has(v.sourceArtifactId)) {
          namesFromViews.set(v.sourceArtifactId, v.title);
        }
      }
    } catch { /* no saved views is not a recovery failure */ }
    const fromSidecar: string[] = [];
    const reconstructed: string[] = [];
    /** Of `reconstructed`, those whose original name a saved view still knew. */
    const renamed: string[] = [];
    const unreadable: string[] = [];

    for (const d of dirs) {
      if (g.artifacts[d.id]) continue;

      const sidecar = await readArtifactSidecar(d.id);
      if (sidecar) {
        g.artifacts[d.id] = sidecar.artifact;
        for (const e of sidecar.executions) {
          if (e?.id && !g.executions[e.id]) g.executions[e.id] = e;
        }
        fromSidecar.push(d.id);
        continue;
      }

      // The rule for reading a directory back into an entry lives in
      // `host/artifact/recover.ts`, where it can be tested without OPFS.
      const rebuilt = reconstructArtifact(d, {
        name: namesFromViews.get(d.id),
        artifactsDir: DIR_ARTIFACTS,
      });
      if (!rebuilt) { unreadable.push(d.id); continue; }
      g.artifacts[d.id] = rebuilt;
      reconstructed.push(d.id);
      if (namesFromViews.has(d.id)) renamed.push(d.id);
    }

    const restored = [...fromSidecar, ...reconstructed];
    for (const id of restored) {
      const a = g.artifacts[id];
      try { await mountArtifact(a); }
      catch (e: any) { g.artifacts[id] = { ...a, unavailable: e.message }; }
    }

    // A reconstructed log has no summary until something measures it; the
    // tree and the overview both read these counts.
    for (const id of reconstructed) {
      const a = g.artifacts[id];
      if (a.unavailable) continue;
      try {
        const kind = a.type === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
        a.meta = { ...a.meta, ...(await summarize(id, kind)), parquetBytes: await artifactSize(id) };
      } catch { /* an unsummarisable artifact is still worth having back */ }
    }

    if (restored.length) {
      catalogCache = g;
      await writeCatalog(g);
    }
    return {
      fromSidecar, reconstructed, renamed, unreadable,
      graph: g,
      breakdown: await storageBreakdown(new Set(Object.keys(g.artifacts))),
    };
  },

  async removeOrphanArtifactFiles() {
    const g = await readCatalog();
    const removed = await pruneOrphanArtifactFiles(new Set(Object.keys(g.artifacts)));
    return {
      removed,
      breakdown: await storageBreakdown(new Set(Object.keys(g.artifacts))),
    };
  },

  async clearCacheStorage() {
    const cleared = await clearCacheStorage();
    const g = await readCatalog();
    return {
      cleared,
      breakdown: await storageBreakdown(new Set(Object.keys(g.artifacts))),
    };
  },

  /**
   * Import: source file -> streaming parse -> DuckDB -> Parquet in OPFS.
   *
   * A one-off ETL with progress, not a "load". The File never becomes a
   * string: BPI-2017 at 552 MB already exceeds V8's ~512 MB string cap.
   */
  async import({ file, format, name }: { file: File; format: string; name: string }) {
    if (!duck) throw new Error('not booted');
    const t0 = performance.now();
    const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const source = file.name.toLowerCase().endsWith('.gz') ? gzipFileSource(file) : fileSource(file);
    const prefix = tableName(id, '').replace(/__$/, '');

    await requestPersistence();

    const onProgress = (a: number, b: number) =>
      post('progress', { id, phase: 'parse', done: a, total: b });

    let stats: any, semantics: any, logical: string[], kind: 'ocel' | 'xes';
    if (format === 'xes') {
      kind = 'xes';
      const r: any = await ingestXES({ source, conn: duck.conn, prefix, onProgress, log });
      stats = r.stats; semantics = r.semantics;
      logical = ['event', 'event_attr', 'trace', 'trace_attr'];
    } else if (format === 'ocel-json') {
      kind = 'ocel';
      const r: any = await ingestOcelJson({ source, conn: duck.conn, prefix, onProgress, log });
      stats = r.stats; semantics = r.semantics ?? null;
      logical = ['event', 'object', 'e2o', 'o2o', 'event_attr', 'object_attr'];
    } else {
      kind = 'ocel';
      let parsed: OcelLog;
      if (format === 'ocel-xml') parsed = await parseOcelXml(source.chunks((done: number) => onProgress(done, source.size)), onProgress, source.size);
      else if (format === 'ocel-sqlite') parsed = await parseOcelSqlite((await sourceBytes(source, onProgress)).buffer as ArrayBuffer);
      else if (format === 'ocel-csv') parsed = parseOcelCsv(new TextDecoder().decode(await sourceBytes(source, onProgress)));
      else if (format === 'prom-csv') parsed = parsePromCsv(new TextDecoder().decode(await sourceBytes(source, onProgress)));
      else if (format === 'ocel-bundle') parsed = await parseBundle(await sourceBytes(source, onProgress));
      else throw new Error(`unsupported import format: ${format}`);
      const sourceFormat: any = format === 'ocel-xml' ? 'xml' : format === 'ocel-sqlite' ? 'sqlite' : format === 'ocel-csv' ? 'csv' : format === 'prom-csv' ? 'prom-csv' : 'bundle-csv';
      const r: any = await ingestOcelRecords({ log: parsed, conn: duck.conn, prefix, sourceFormat, onProgress });
      stats = r.stats; semantics = r.semantics;
      logical = ['event', 'object', 'e2o', 'o2o', 'event_attr', 'object_attr'];
    }

    post('progress', { id, phase: 'parquet', done: 0, total: logical.length });
    const files: Record<string, string> = {};
    let i = 0;
    for (const l of logical) {
      const table = `${prefix}_${l}`;
      const exists = await duck.conn.query(
        `SELECT COUNT(*) AS n FROM duckdb_tables() WHERE table_name='${table}'`
      );
      if (Number(exists.get(0)!.toJSON().n) === 0) continue;
      const w = await tableToParquet(id, table, l);
      files[l] = w.file;
      post('progress', { id, phase: 'parquet', done: ++i, total: logical.length });
    }

    // Point the canonical view names at the Parquet files, then drop the
    // in-memory tables: from here on the artifact is its files.
    for (const l of Object.keys(files)) {
      await duck.conn.query(`DROP TABLE IF EXISTS ${prefix}_${l}`);
    }

    const artifact: Artifact = {
      id,
      name,
      type: kind === 'xes' ? 'TraditionalEventLog' : 'ObjectCentricEventLog',
      createdAt: new Date().toISOString(),
      storage: { kind: 'parquet', files },
      meta: {},
      producedBy: null,
      inputs: [],
    };

    await mountArtifact(artifact);
    artifact.meta = {
      ...(await summarize(id, kind)),
      capabilities: await capabilitiesOf(id, kind, semantics),
      sourceBytes: file.size,
      sourceFormat: format,
      semantics: semantics ?? null,
      parquetBytes: await artifactSize(id),
      importMs: Math.round(performance.now() - t0),
      rawStats: stats,
    };

    const g = await readCatalog();
    g.artifacts[id] = artifact;
    await writeCatalog(g);

    log(`imported ${name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    return { artifact, quota: await quota() };
  },

  /** OCEL export is intentionally an explicit boundary action, never a new artifact. */
  async exportOcel({ id, format }: { id: string; format: string }) {
    const g = await readCatalog(); const artifact = g.artifacts[id];
    if (!artifact || artifact.type !== 'ObjectCentricEventLog') throw new Error('Only object-centric event logs can be exported as OCEL.');
    const log = await ocelLogOf(artifact);
    const content = format === 'sqlite' ? await encodeOcelSqlite(log) : encodeOcel(log, format as any);
    return { content, format };
  },

  async exportXes({ id, format }: { id: string; format: 'xes' | 'csv' }) {
    const g = await readCatalog(); const artifact = g.artifacts[id];
    if (!artifact || artifact.type !== 'TraditionalEventLog') throw new Error('Only traditional event logs can be exported as XES or CSV.');
    const log = await xesLogOf(artifact);
    return { content: format === 'xes' ? encodeXes(log) : encodeXesCsv(log), format };
  },

  /**
   * The single data door.
   *
   * Everything downstream — views, actions, future plugins — reaches data
   * through here and gets Arrow back. Keeping this the only path is what lets
   * the same query later run against a native DuckDB over IPC unchanged.
   */
  /**
   * Persists an artifact and the execution that produced it.
   *
   * Until now the catalog was only written by import and remove, so anything
   * derived lived in memory and vanished with the tab. A script the user wrote
   * is work, not a transient view — it belongs in the catalog like any other
   * artifact.
   */
  /**
   * Writes a derived log and (re)builds its views.
   *
   * Separate from `putArtifact` because this one has to touch DuckDB: the
   * artifact *is* a query plan, so persisting it and mounting it are the same
   * operation, and the row counts it reports come from executing it.
   */
  async putDerived({ artifact, execution }: { artifact: Artifact; execution?: any }) {
    if (!duck) throw new Error('not booted');
    const g = await readCatalog();
    catalogCache = g;
    const previous = g.artifacts[artifact.id];
    g.artifacts[artifact.id] = artifact;
    if (execution) g.executions[execution.id] = execution;

    await mountDerived(artifact, previous);

    // A rebuild drops the stage views this artifact's dependents were reading,
    // so everything downstream is rebuilt too. Views are cheap; a stale
    // dependent is a wrong answer.
    for (const other of Object.values(g.artifacts)) {
      if (other.id === artifact.id || other.storage.kind !== 'view') continue;
      if (dependsOn(g, other, artifact.id)) {
        try { await mountDerived(other); } catch { /* reported when opened */ }
      }
    }

    const kind = artifact.type === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
    const summary = await summarize(artifact.id, kind);
    // `putDerived` is only ever called for transform/notebook/script-derived
    // artifacts (see the two `dataClient.putDerived` call sites in App.tsx) —
    // never for a freshly-ingested one, which sets real declared semantics
    // through a separate path and never reaches here. So there is no call
    // where `artifact.meta.semantics` already correctly describes the
    // *current* tables: it is either absent (first `putDerived` for this
    // artifact) or the previous edit's now-stale value (every edit after
    // that) — reusing it here read exactly that stale copy back on every op
    // change after the first. Recomputed unconditionally, the same way
    // `summary` already is on every call, so OCEL-aware plugin views (Object
    // Types, Objects, Event Types, Events, Overview) track each edit instead
    // of only ever reflecting the transform's very first state.
    const semantics = kind === 'ocel' ? await liveOcelSemantics(artifact.id) : null;
    const caps = await capabilitiesOf(artifact.id, kind, semantics);
    const stored: Artifact = {
      ...artifact,
      meta: { ...artifact.meta, ...summary, semantics, capabilities: caps },
    };
    g.artifacts[artifact.id] = stored;

    await writeCatalog(g);
    return { catalog: g, quota: await quota(), artifact: stored };
  },

  /**
   * Changes a log's event classifier and rebuilds everything that depends on it.
   *
   * The counts change too: merging activity with lifecycle turns one activity
   * into several, and a stale activity count would describe the labeling the
   * user just replaced.
   */
  async setClassifier({ id, classifier }: { id: string; classifier: any }) {
    if (!duck) throw new Error('not booted');
    const g = await readCatalog();
    catalogCache = g;
    const a = g.artifacts[id];
    if (!a) throw new Error('unknown artifact');

    const next: Artifact = {
      ...a,
      meta: { ...a.meta, classifier, rev: Date.now() },
    };
    g.artifacts[id] = next;
    await applyClassifier(next);

    const kind = next.type === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
    const summary = await summarize(id, kind);
    g.artifacts[id] = { ...next, meta: { ...next.meta, ...summary } };

    // A derived log reads the parent's event view, so its own views still
    // resolve — but its cached counts were computed under the old labeling.
    for (const other of Object.values(g.artifacts)) {
      if (other.storage.kind !== 'view' || !dependsOn(g, other, id)) continue;
      const k = other.type === 'ObjectCentricEventLog' ? 'ocel' : 'xes';
      try {
        const s2 = await summarize(other.id, k);
        g.artifacts[other.id] = {
          ...other, meta: { ...other.meta, ...s2, rev: Date.now() },
        };
      } catch { /* reported when the artifact is opened */ }
    }

    await writeCatalog(g);
    return { catalog: g, quota: await quota() };
  },

  async putArtifact({ artifact, execution }: { artifact: Artifact; execution?: any }) {
    const g = await readCatalog();
    catalogCache = g;
    g.artifacts[artifact.id] = artifact;
    if (execution) g.executions[execution.id] = execution;

    // Drop executions nothing points at any more. Re-saving an artifact
    // replaces its producing execution, and without this the DAG accumulates
    // nodes that produced a version of an artifact that no longer exists —
    // provenance that describes nothing is worse than no provenance.
    const referenced = new Set(
      Object.values(g.artifacts).map((a) => a.producedBy).filter(Boolean) as string[]
    );
    for (const id of Object.keys(g.executions)) {
      if (!referenced.has(id)) delete g.executions[id];
    }

    await writeCatalog(g);
    return { catalog: g, quota: await quota() };
  },

  /**
   * Persists a large structured result beside its artifact rather than
   * embedding it in catalog.json.  The caller still has to publish the
   * returned `{ kind: 'json' }` storage reference in one `putArtifact`
   * transaction; an unreferenced file is harmless and is pruned with the
   * rest of an abandoned artifact directory.
   */
  async materializeArtifactJson({ artifactId, value }: { artifactId: string; value: unknown }) {
    if (!artifactId) throw new Error('materializeArtifactJson requires an artifact id');
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    const dir = await artifactDir(artifactId);
    const file = await dir.getFileHandle('payload.json', { create: true });
    const writable = await file.createWritable();
    await writable.write(encoded);
    await writable.close();
    return { storage: { kind: 'json' as const, path: `${DIR_ARTIFACTS}/${artifactId}/payload.json` }, bytes: encoded.byteLength };
  },

  /** Reads the one structured payload owned by a materialized artifact. */
  async readArtifactJson({ artifactId }: { artifactId: string }) {
    if (!artifactId) throw new Error('readArtifactJson requires an artifact id');
    const dir = await artifactDir(artifactId, false);
    const file = await dir.getFileHandle('payload.json');
    return { value: JSON.parse(await (await file.getFile()).text()) };
  },

  /**
   * `putArtifact` has to write the execution before the write itself can be
   * timed.  Replace just that record afterwards so provenance keeps the real
   * click-to-finished-result measurement instead of an optimistic estimate.
   */
  async updateExecution({ execution }: { execution: any }) {
    const g = await readCatalog();
    if (!g.executions[execution?.id]) throw new Error('updateExecution: unknown execution');
    g.executions[execution.id] = execution;
    await writeCatalog(g);
    return { catalog: g, quota: await quota() };
  },

  async sql({ text }: { text: string }) {
    if (!duck) throw new Error('not booted');
    const table = await duck.conn.query(text);
    // Arrow IPC transfers as bytes; no row-by-row marshalling across threads.
    return { ipc: arrow.tableToIPC(table, 'stream') };
  },

  /**
   * `conn.send()` starts a DuckDB pending query, which is the one DuckDB-Wasm
   * query form that can be safely interrupted through `cancelSent()`. Results
   * are assembled in this worker exactly as the ordinary SQL endpoint does.
   */
  async sqlCancelable({ text, queryId }: { text: string; queryId: string }) {
    if (!duck) throw new Error('not booted');
    if (!queryId) throw new Error('sqlCancelable requires a query id');
    const conn = await duck.db.connect();
    cancellableSql.set(queryId, conn);
    try {
      const reader = await conn.send(text, true);
      const table = new arrow.Table(await reader.readAll());
      return { ipc: arrow.tableToIPC(table, 'stream') };
    } finally {
      cancellableSql.delete(queryId);
      await conn.close().catch(() => {});
    }
  },

  async cancelSql({ queryId }: { queryId: string }) {
    const conn = cancellableSql.get(queryId);
    return { canceled: conn ? await conn.cancelSent().catch(() => false) : false };
  },

  /**
   * Executes a Promenade Relational Program.
   *
   * This is the actual enforcement boundary for the SQL Profile — everything
   * `host/relational/sqlProfile.ts` and `compileProgram.ts` check is checked
   * again here, in the one place a plugin's SQL cannot route around it. The
   * main thread never gets a DuckDB connection or a physical table name; it
   * only ever gets Arrow IPC bytes back.
   *
   * The artifact type on each input binding is looked up from the catalog,
   * not trusted from the caller — a compromised or buggy main-thread caller
   * cannot claim an artifact is a type it is not to smuggle a wider logical
   * schema than the artifact actually has.
   */
  async relational({
    inputs, params, programSource, declaredParams, requestedRelations,
  }: {
    inputs: Array<{ role: string; artifactId: string }>;
    params: Record<string, unknown>;
    programSource: string;
    declaredParams: Record<string, ParamTypeSchema>;
    requestedRelations?: string[];
  }) {
    if (!duck) throw new Error('not booted');
    const g = await readCatalog();
    catalogCache = g;

    const bindings: RelationalInputBinding[] = [];
    for (const { role, artifactId } of inputs) {
      const artifact = g.artifacts[artifactId];
      if (!artifact) throw new Error(`relational: unknown input artifact "${artifactId}" (role "${role}")`);
      if (!schemaFor(artifact.type)) {
        throw new Error(`relational: artifact type "${artifact.type}" has no registered logical schema`);
      }
      // First touch this session mounts it, the same as opening any artifact.
      await mountArtifact(artifact);
      bindings.push({ role, artifactId, artifactType: artifact.type });
    }

    const program = parseProgram(programSource);

    const t0 = performance.now();
    let compiled;
    try {
      compiled = compileProgram(program, bindings, params, requestedRelations, {
        physicalTableOf: (id, logical) => tableName(id, logical),
        declaredParams,
      });
    } catch (e: any) {
      throw new Error(e instanceof RelationalCompileError ? e.message : String(e?.message ?? e));
    }
    const compileMs = performance.now() - t0;

    const t1 = performance.now();
    const outputs: Record<string, Uint8Array> = {};
    const relations: Record<string, Uint8Array> = {};
    const outputStats: Array<{ name: string; rowCount: number }> = [];
    const relationStats: Array<{ name: string; rowCount: number }> = [];

    for (const s of compiled.statements) {
      const stmt = await duck.conn.prepare(s.sql);
      let table;
      try {
        table = await stmt.query(...s.values);
      } finally {
        await stmt.close();
      }
      const ipc = arrow.tableToIPC(table, 'stream');
      if (s.kind === 'output') {
        outputs[s.name] = ipc;
        outputStats.push({ name: s.name, rowCount: table.numRows });
      } else {
        relations[s.name] = ipc;
        relationStats.push({ name: s.name, rowCount: table.numRows });
      }
    }
    const executeMs = performance.now() - t1;

    return {
      outputs, relations,
      stats: { outputs: outputStats, relations: relationStats, compileMs, executeMs },
      backend: { kind: 'duckdb-wasm', version: duckdb.PACKAGE_VERSION },
    };
  },

  /**
   * Materializes a `runtime: 'relational'` program's output as a new
   * artifact's physical storage — the generic capability `ActionContext
   * .persistLog` exposes to any relational action, not something built for
   * one plugin. A program's `output` result is Arrow data the moment it
   * leaves DuckDB (see `relational` above); this differs only in what
   * happens to that data next: instead of shipping it back to the main
   * thread as IPC, each logical relation matching a schema-declared name
   * (`event`, `trace`, …) is re-registered into this same connection
   * (`insertArrowTable` — no serialization needed, it never left the
   * worker) and copied to Parquet the same way `import` and `tableToParquet`
   * already do for every other log-shaped artifact.
   *
   * Deliberately does not touch the catalog — `putArtifact` (already
   * generic) does that, once, with the execution record attached, so a
   * persisted-log outcome and an inline outcome commit through the exact
   * same path.
   */
  async materializeRelationalLog({
    id, inputs, params, programSource, declaredParams, targetType,
  }: {
    id: string;
    inputs: Array<{ role: string; artifactId: string }>;
    params: Record<string, unknown>;
    programSource: string;
    declaredParams: Record<string, ParamTypeSchema>;
    targetType: string;
  }) {
    if (!duck) throw new Error('not booted');
    const g = await readCatalog();
    catalogCache = g;

    const schema = schemaFor(targetType);
    if (!schema) {
      throw new Error(`materializeRelationalLog: no logical schema registered for "${targetType}"`);
    }

    const bindings: RelationalInputBinding[] = [];
    for (const { role, artifactId } of inputs) {
      const a = g.artifacts[artifactId];
      if (!a) throw new Error(`materializeRelationalLog: unknown input artifact "${artifactId}" (role "${role}")`);
      if (!schemaFor(a.type)) {
        throw new Error(`materializeRelationalLog: artifact type "${a.type}" has no registered logical schema`);
      }
      await mountArtifact(a);
      bindings.push({ role, artifactId, artifactType: a.type });
    }

    const program = parseProgram(programSource);
    let compiled;
    try {
      compiled = compileProgram(program, bindings, params, undefined, {
        physicalTableOf: (aid, logical) => tableName(aid, logical),
        declaredParams,
      });
    } catch (e: any) {
      throw new Error(e instanceof RelationalCompileError ? e.message : String(e?.message ?? e));
    }
    const byName = new Map<string, CompiledStatement>(compiled.statements.map((s) => [s.name, s]));

    // `schema.relations` names are the public relational-API vocabulary
    // (`events`, `cases`, …) — what a program's own `-- @output` statements
    // are named, matching `{role.events}`-style placeholders elsewhere in
    // the same program. `Artifact.storage.files` and every physical table
    // lookup (`tableOf`, `mountArtifact`) instead key by the short physical
    // name (`event`, `trace`, …) — `PHYSICAL_LOGICAL_NAME` is the one place
    // that mapping is declared, so this reads it rather than guessing.
    const physicalKeys = PHYSICAL_LOGICAL_NAME[targetType] ?? {};

    // A relation with no matching `-- @output` is simply absent from the
    // result — the same as a source format that never wrote a table (an
    // XES import has no `object` table either).
    const files: Record<string, string> = {};
    for (const relation of schema.relations) {
      const stmt = byName.get(relation.name);
      if (!stmt) continue;
      const physical = physicalKeys[relation.name];
      if (!physical) continue; // declared in the schema but not storage-backed

      const prepared = await duck.conn.prepare(stmt.sql);
      let table;
      try { table = await prepared.query(...stmt.values); }
      finally { await prepared.close(); }

      const tmpName = `${tableName(id, physical)}__tmp`;
      await duck.conn.insertArrowTable(table, { name: tmpName, create: true });
      try {
        const w = await tableToParquet(id, tmpName, physical);
        files[physical] = w.file;
      } finally {
        await duck.conn.query(`DROP TABLE IF EXISTS ${tmpName}`);
      }
    }
    if (!files.event) {
      throw new Error('materializeRelationalLog: program produced no "event" relation');
    }

    // A throwaway shell, never written to the catalog — `mountArtifact`
    // only needs the shape, not a real, persisted artifact, to register the
    // views the summary/capability queries below read.
    const shell: Artifact = {
      id, name: '', type: targetType, createdAt: new Date().toISOString(),
      storage: { kind: 'parquet', files }, meta: {}, producedBy: null, inputs: [],
    };
    await mountArtifact(shell);

    const kind = targetType === 'ObjectCentricEventLog' ? 'ocel' : 'xes';

    // Any `-- @output` block not named after one of the schema's own
    // relations is not part of the log itself — it's auxiliary data a
    // program computed alongside it (a fact only derivable from the
    // *inputs* it had on hand here, not from the projected log a downstream
    // action later receives). Recorded into `meta` under its own output
    // name, as plain rows (each row's column values, in column order) —
    // generic storage for whatever a program chooses to compute, not a
    // shape chosen for any one program's needs. A downstream action can
    // recover it via `meta[name]`; see `wasmActionRuntime`'s upstream-meta
    // forwarding in `host/plugins/runtimeAdapters.ts`.
    const consumedNames = new Set(schema.relations.map((r) => r.name));
    const extra: Record<string, unknown[][]> = {};
    for (const [name, stmt] of byName) {
      if (consumedNames.has(name)) continue;
      const prepared = await duck.conn.prepare(stmt.sql);
      let table;
      try { table = await prepared.query(...stmt.values); }
      finally { await prepared.close(); }
      extra[name] = table.toArray().map((row: any) => Object.values(row.toJSON()));
    }

    // Declared OCEL semantics are re-derived from the tables just written, for
    // the same reason `putDerived` does it: `semantics` is normally set once at
    // ingest from the source file's own type declarations, and a log this
    // function creates has no source file to read them from. Every OCEL-aware
    // view (Object Types, Event Types, Overview) takes its type list from that
    // field alone, so leaving it null renders a perfectly good derived log as
    // "0 object types, 0 event types" over correct object and event counts —
    // which is exactly what a relational action producing an OCEL log used to
    // show. `putDerived` covers the transform path; this is the same gap on the
    // relational one, and it stayed hidden while every relational action
    // happened to output a `TraditionalEventLog`, which has no semantics.
    const semantics = kind === 'ocel' ? await liveOcelSemantics(id) : null;
    const meta = {
      ...(await summarize(id, kind)),
      semantics,
      capabilities: await capabilitiesOf(id, kind, semantics),
      ...extra,
    };

    return { storage: shell.storage, meta };
  },

  /**
   * The notebook-publishing counterpart of `materializeRelationalLog`
   * above: writes caller-supplied Arrow tables straight to Parquet under
   * `id`, one per physical relation, instead of getting them by executing a
   * SQL Profile v1 program first. `promenade.publish_event_log()` /
   * `publish_ocel()` (see `worker/notebook-worker.ts`) build these tables
   * in Python from whatever DataFrame the user computed — there is no SQL
   * program to compile, so this skips straight to the shared tail of that
   * function: insert each table, copy it to Parquet, mount the shell,
   * summarize. Missing optional relations (`event_attr`, `trace_attr`,
   * `o2o`, …) are simply absent from `relations` — `mountArtifact` already
   * tolerates that for every log-shaped artifact (an empty view for OCEL's
   * fixed six relations, a missing view the summary/capability queries
   * already catch for XES's optional two).
   */
  async materializeNotebookLog({
    id, targetType, relations,
  }: {
    id: string;
    targetType: string;
    relations: Record<string, Uint8Array>;
  }) {
    if (!duck) throw new Error('not booted');
    if (targetType !== 'TraditionalEventLog' && targetType !== 'ObjectCentricEventLog') {
      throw new Error(`materializeNotebookLog: unsupported targetType "${targetType}"`);
    }
    if (!relations.event) {
      throw new Error('materializeNotebookLog: an "event" relation is required');
    }

    const files: Record<string, string> = {};
    for (const [logical, ipc] of Object.entries(relations)) {
      const table = arrow.tableFromIPC(ipc);
      const tmpName = `${tableName(id, logical)}__tmp`;
      await duck.conn.insertArrowTable(table, { name: tmpName, create: true });
      try {
        const w = await tableToParquet(id, tmpName, logical);
        files[logical] = w.file;
      } finally {
        await duck.conn.query(`DROP TABLE IF EXISTS ${tmpName}`);
      }
    }

    return mountAndSummarizeLog(id, targetType, files);
  },

  /**
   * The third way a log gets written: from columns an action *computed*.
   *
   * `materializeRelationalLog` selects a log out of logs the workspace
   * already has, and `materializeNotebookLog` writes tables a notebook built
   * in Python. Neither covers an action whose output is not derivable from
   * its input by any query — a simulator playing a Petri net out into traces,
   * say, whose input is a model and whose output is data that did not exist
   * before. `host/artifact/log-rows.ts` validates such an action's columns
   * against the target type's logical schema and encodes them; this writes
   * them, and the two together are what `ActionContext.persistLog`'s `rows`
   * form is made of.
   *
   * The projection below is the difference from `materializeNotebookLog`, and
   * the reason this is not just a call to it: the incoming Arrow tables carry
   * timestamps as `<name>_us` BIGINT (epoch microseconds), and the physical
   * table is built from them with `make_timestamp()` — the same conversion
   * `ingest/xes.ts` performs, so a generated log and an imported one are
   * byte-for-byte comparable in the one place they could silently differ.
   * Declared columns the caller omitted are filled with typed NULLs, so every
   * physical table has the full shape readers expect regardless of which
   * optional columns the producer had anything to say about.
   */
  async materializeRowLog({
    id, targetType, relations,
  }: {
    id: string;
    targetType: string;
    relations: Record<string, Uint8Array>;
  }) {
    if (!duck) throw new Error('not booted');
    const schema = schemaFor(targetType);
    if (!schema) throw new Error(`materializeRowLog: no logical schema registered for "${targetType}"`);
    if (!relations.event) throw new Error('materializeRowLog: an "event" relation is required');

    const physicalOf = PHYSICAL_LOGICAL_NAME[targetType] ?? {};
    const logicalOf = new Map(Object.entries(physicalOf).map(([logical, physical]) => [physical, logical]));

    const files: Record<string, string> = {};
    for (const [physical, ipc] of Object.entries(relations)) {
      const relation = schema.relations.find((r) => r.name === logicalOf.get(physical));
      if (!relation) throw new Error(`materializeRowLog: "${physical}" is not a relation of ${targetType}`);

      const table = arrow.tableFromIPC(ipc);
      const present = new Set(table.schema.fields.map((f) => f.name));
      const tmpName = `${tableName(id, physical)}__tmp`;
      const projected = `${tmpName}__cast`;
      await duck.conn.insertArrowTable(table, { name: tmpName, create: true });
      try {
        const columns = relation.columns.map((c) => {
          if (c.type === 'timestamp') {
            const source = `${c.name}_us`;
            return present.has(source)
              ? `CASE WHEN ${source} IS NULL THEN NULL ELSE make_timestamp(${source}) END AS ${c.name}`
              : `CAST(NULL AS TIMESTAMP) AS ${c.name}`;
          }
          return present.has(c.name) ? c.name : `CAST(NULL AS ${DUCKDB_TYPE[c.type]}) AS ${c.name}`;
        });
        await duck.conn.query(
          `CREATE OR REPLACE TABLE ${projected} AS SELECT ${columns.join(', ')} FROM ${tmpName}`
        );
        const w = await tableToParquet(id, projected, physical);
        files[physical] = w.file;
      } finally {
        await duck.conn.query(`DROP TABLE IF EXISTS ${projected}`);
        await duck.conn.query(`DROP TABLE IF EXISTS ${tmpName}`);
      }
    }

    return mountAndSummarizeLog(id, targetType, files);
  },

  async remove({ id }: { id: string }) {
    const g = await readCatalog();
    /**
     * Cascades to every descendant, not just `id`.
     *
     * `DROP VIEW ... CASCADE` below already drops a descendant's views the
     * moment its ancestor's are dropped — DuckDB view dependencies follow the
     * same chain the catalog's `inputs` does. Deleting only `id` left every
     * descendant's *catalog entry* behind: a "healthy"-looking artifact
     * whose every query now fails with "table does not exist". Worse, the
     * artifact tree renders a derived artifact with no resolvable parent as
     * a new root, so deleting one root artifact used to look like it deleted
     * nothing at all — the tree stayed just as full, backfilled by orphans.
     */
    const toDelete = [id, ...descendantsOf(g, id)];

    for (const delId of toDelete) {
      const a = g.artifacts[delId];
      await releaseRawMounts(delId);
      if (a) {
        const relations = a.type === 'ObjectCentricEventLog'
          ? new Set([...logicalTables(a), ...Object.keys(OCEL_RELATION_COLUMNS)])
          : new Set(logicalTables(a));
        for (const l of relations) {
          const view = tableName(delId, l);
          try { await duck!.conn.query(`DROP VIEW IF EXISTS ${view} CASCADE`); } catch {}
          // `event` is a classifier wrapper over this source view; dropping
          // the wrapper alone leaves the Parquet reader (and its OPFS handle)
          // alive. Other logical tables have no such extra layer, so this is
          // harmlessly a no-op for them.
          try { await duck!.conn.query(`DROP VIEW IF EXISTS ${view}__src CASCADE`); } catch {}
          const file = registeredFiles.get(view);
          if (file) {
            try { await duck!.db.dropFile(file); } catch {}
            registeredFiles.delete(view);
          }
          registered.delete(view);
        }
        // Stage views of a transform plan are not reachable through the
        // logical names, so they are dropped by prefix.
        if (a.storage.kind === 'view') {
          const safe = delId.replace(/[^a-zA-Z0-9_]/g, '_');
          try {
            const stale = await duck!.conn.query(
              `SELECT view_name FROM duckdb_views() WHERE view_name LIKE '${safe}__s%'`
            );
            for (const r of stale.toArray()) {
              await duck!.conn.query(`DROP VIEW IF EXISTS ${(r as any).view_name} CASCADE`);
            }
          } catch {}
        }
      }
      delete g.artifacts[delId];
      await deleteArtifactFiles(delId);
    }

    // Same prune `putArtifact` already does after replacing an artifact: an
    // execution nothing points at any more is provenance for something that
    // no longer exists.
    const referenced = new Set(
      Object.values(g.artifacts).map((a) => a.producedBy).filter(Boolean) as string[]
    );
    for (const execId of Object.keys(g.executions)) {
      if (!referenced.has(execId)) delete g.executions[execId];
    }

    await writeCatalog(g);
    return { catalog: g, quota: await quota() };
  },

  async rename({ id, name }: { id: string; name: string }) {
    const g = await readCatalog();
    if (g.artifacts[id]) { g.artifacts[id].name = name; await writeCatalog(g); }
    return { catalog: g };
  },

  /** "Copy/Move to Promenade Compute" — see `host/compute/relocate.ts`. */
  async relocateArtifact(
    { id, location, storage, meta }: {
      id: string; location?: { engineId: string; remoteId: string } | null; storage?: any; meta?: Record<string, unknown>;
    }
  ) {
    const g = await readCatalog();
    const a = g.artifacts[id];
    if (a) {
      if (location === null) delete a.location;
      else if (location) a.location = location;
      if (storage) a.storage = storage;
      if (meta) a.meta = { ...a.meta, ...meta };
      await writeCatalog(g);
    }
    return { catalog: g };
  },

  async tableFor({ id, logical }: { id: string; logical: string }) {
    return { table: tableName(id, logical) };
  },

  /**
   * Every file physically present in one artifact's OPFS directory.
   *
   * The catalog says which *relations* an artifact has; this says what is on
   * disk, which is not the same list — a sidecar (`artifact.json`), a
   * materialized `payload.json`, and a Parquet file left behind by a relation
   * that has since been dropped all exist without appearing in
   * `storage.files`. A raw viewer that showed the catalog's list would be
   * describing the catalog, not the storage.
   *
   * `logical` is set where a file *is* one of the declared relations, so a
   * caller can tell "this is the log's event table" from "this is a file that
   * happens to sit next to it".
   */
  async artifactFiles({ id }: { id: string }) {
    if (!id) throw new Error('artifactFiles requires an artifact id');
    const g = await readCatalog();
    const a = g.artifacts[id];
    const declared = new Set(
      a?.storage?.kind === 'parquet' ? Object.keys(a.storage.files) : []
    );

    let root: FileSystemDirectoryHandle;
    // An artifact with no directory is not an error: an inline result or one
    // that lives on a compute engine has nothing here, and "nothing" is the
    // honest answer rather than a failure.
    try { root = await artifactDir(id, false); } catch { return { entries: [] }; }

    const entries: Array<{
      path: string; name: string; kind: 'file' | 'directory'; size: number; logical?: string;
    }> = [];

    const walk = async (handle: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      // A guard, not a real limit: artifact directories are flat today, and
      // an unbounded recursion here would be a hang rather than an error if
      // that ever stopped being true in a surprising way.
      if (depth > 4) return;
      const children: Array<[string, FileSystemHandle]> = [];
      for await (const pair of (handle as any).entries()) children.push(pair);
      children.sort(([an, ah], [bn, bh]) =>
        (ah.kind === bh.kind ? 0 : ah.kind === 'directory' ? -1 : 1) || an.localeCompare(bn));
      for (const [name, child] of children) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') {
          entries.push({ path, name, kind: 'directory', size: 0 });
          await walk(child as FileSystemDirectoryHandle, path, depth + 1);
          continue;
        }
        let size = 0;
        // A file whose size cannot be read is still present. Reporting it at
        // 0 bytes beats omitting it, which would claim it isn't there.
        try { size = (await (child as FileSystemFileHandle).getFile()).size; } catch {}
        const base = name.endsWith('.parquet') ? name.slice(0, -'.parquet'.length) : null;
        entries.push({
          path, name, kind: 'file', size,
          ...(base && declared.has(base) ? { logical: base } : {}),
        });
      }
    };
    await walk(root, '', 0);
    return { entries };
  },

  /**
   * Opens one file inside an artifact's directory.
   *
   * Parquet answers with a queryable relation rather than bytes: the file is
   * the reason DuckDB is here, and handing a caller 200 MB of column chunks
   * to parse itself would be absurd when a view over it costs a handle. Every
   * other file answers with its bytes, capped — the caller decodes.
   *
   * The relation for a declared relation file is the one the normal mount
   * already made, deliberately: registering the same OPFS file a second time
   * under a second name would mean two access handles on one file.
   */
  async artifactFile({ id, path, maxBytes }: { id: string; path: string; maxBytes?: number }) {
    if (!duck) throw new Error('not booted');
    if (!id) throw new Error('artifactFile requires an artifact id');
    const rel = safeArtifactPath(path);
    const g = await readCatalog();
    const a = g.artifacts[id];

    const segments = rel.split('/');
    let dirHandle = await artifactDir(id, false);
    for (const segment of segments.slice(0, -1)) {
      dirHandle = await dirHandle.getDirectoryHandle(segment);
    }
    const name = segments[segments.length - 1];
    const handle = await dirHandle.getFileHandle(name);
    const size = (await handle.getFile()).size;

    if (!name.endsWith('.parquet')) {
      const cap = Math.max(0, Math.min(maxBytes ?? MAX_RAW_FILE_BYTES, MAX_RAW_FILE_BYTES));
      const blob = await handle.getFile();
      const bytes = new Uint8Array(await blob.slice(0, cap).arrayBuffer());
      return { kind: 'bytes' as const, path: rel, size, bytes, truncated: size > bytes.byteLength };
    }

    const base = name.slice(0, -'.parquet'.length);
    const declared = a?.storage?.kind === 'parquet' && !!a.storage.files[base] && segments.length === 1;
    let relation: string;
    let vname: string | undefined;
    if (declared) {
      await mountArtifact(a!);
      const view = tableName(id, base);
      // `event` carries the classifier indirection; `__src` is the file
      // itself, which is what "raw" has to mean here.
      relation = base === 'event' ? `${view}__src` : view;
      vname = registeredFiles.get(view);
    } else {
      const mounted = await mountRawParquet(id, rel);
      relation = mounted.relation;
      vname = mounted.vname;
    }

    const rows = async (sql: string) => (await duck!.conn.query(sql)).toArray().map((r: any) => r.toJSON());
    const columns = (await rows(`DESCRIBE SELECT * FROM ${relation}`)).map((r: any) => ({
      name: String(r.column_name), type: String(r.column_type),
    }));

    let rowCount: number | null = null;
    let rowGroups: number | null = null;
    let createdBy: string | null = null;
    let compression: string | null = null;
    if (vname) {
      try {
        const [meta] = await rows(
          `SELECT num_rows, num_row_groups, created_by FROM parquet_file_metadata('${vname}')`
        );
        if (meta) {
          rowCount = Number(meta.num_rows);
          rowGroups = Number(meta.num_row_groups);
          createdBy = meta.created_by == null ? null : String(meta.created_by);
        }
        const codecs = await rows(
          `SELECT DISTINCT compression FROM parquet_metadata('${vname}') WHERE compression IS NOT NULL`
        );
        if (codecs.length) compression = codecs.map((c: any) => String(c.compression)).sort().join(', ');
      } catch { /* metadata is a nicety; the relation is the point */ }
    }
    if (rowCount == null) {
      const [counted] = await rows(`SELECT COUNT(*) AS n FROM ${relation}`);
      rowCount = Number(counted?.n ?? 0);
    }

    return {
      kind: 'parquet' as const, path: rel, size, relation,
      rows: rowCount, columns, rowGroups, createdBy, compression,
    };
  },

  /**
   * Wipes the active workspace: its catalog, artifacts, staging and saved
   * views. Installed plugins and other workspaces are untouched. The caller
   * reloads the page right after — a fresh worker with an empty `registered`
   * set and a fresh DuckDB connection is simpler and safer than trying to
   * unwind this worker's in-memory state to match files that no longer exist.
   *
   * DuckDB has to let go of its OPFS handles first: it holds an access handle
   * on `engine/session.db` and on every mounted artifact's Parquet files for
   * as long as the connection lives, and `removeEntry` on a directory with an
   * open handle inside it fails with NoModificationAllowedError.
   */
  async reset() {
    if (duck) {
      await duck.conn.close().catch(() => {});
      await duck.db.terminate().catch(() => {});
      duck = null;
    }
    registered.clear();
    registeredFiles.clear();
    rawMounts.clear();
    catalogCache = null;
    await resetActiveWorkspace();
    return { ok: true };
  },
};

self.onmessage = async (e: MessageEvent) => {
  const { id, cmd, args } = e.data;
  try {
    const h = HANDLERS[cmd];
    if (!h) throw new Error(`unknown cmd ${cmd}`);
    const payload: any = await h(args || {});
    // Transfer Arrow buffers rather than copying them — `sql` has one at
    // `payload.ipc`, `relational` has one per named output/relation.
    const transfer: Transferable[] = [];
    if (payload?.ipc) transfer.push(payload.ipc.buffer);
    for (const bucket of [payload?.outputs, payload?.relations]) {
      if (!bucket) continue;
      for (const bytes of Object.values(bucket) as Uint8Array[]) transfer.push(bytes.buffer);
    }
    (self as any).postMessage({ type: 'result', id, payload }, transfer);
  } catch (err: any) {
    self.postMessage({ type: 'error', id, error: String(err?.stack || err) });
  }
};
