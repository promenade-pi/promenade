import type { Artifact } from './types';

/**
 * The logical tables an artifact exposes, whichever way it is stored.
 *
 * Callers used to test `storage.kind === 'parquet'` directly, which quietly
 * meant "imported log" — and a derived log, which is a set of DuckDB views
 * rather than files, then looked like an artifact with no data at all. The
 * distinction that matters to a consumer is whether there are tables to query,
 * not how they are backed.
 */
export function logicalTablesOf(a: Artifact | null | undefined): string[] {
  if (!a) return [];
  if (a.storage.kind === 'parquet') return Object.keys(a.storage.files);
  if (a.storage.kind === 'view') return a.storage.tables;
  return [];
}

export function hasTables(a: Artifact | null | undefined): boolean {
  return logicalTablesOf(a).length > 0;
}

/**
 * Mirrors the worker's table naming so a caller can build SQL without a
 * round trip. Kept in one place because it is a contract between the two
 * sides — the host layer's own copy; `ui/views/tableName.ts` re-exports this
 * rather than duplicating it, since views were the only callers before the
 * generic runtime adapters (`host/plugins/runtimeAdapters.ts`) needed it too.
 */
export function tableOf(artifactId: string, logical: string): string {
  return `${artifactId.replace(/[^a-zA-Z0-9_]/g, '_')}__${logical}`;
}
