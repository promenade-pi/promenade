// Extensioned imports, and no dependency on `../data/client` or any runtime
// module: this file is imported directly by `node --test` (see
// `app/test/plugins/role-table-map.test.ts`), so every hop must resolve
// without a bundler.
import { tableOf, logicalTablesOf } from '../artifact/tables.ts';
import type { PluginManifest } from './manifest.ts';
import type { ArtifactId, Artifact } from '../artifact/types.ts';

type ManifestAction = NonNullable<PluginManifest['actions']>[number];

/**
 * SQL-placeholder → physical-table-name map handed to a pyodide action.
 *
 * The primary input keeps its bare logical names (`{event}`, `{object}`) so a
 * single-input plugin is unchanged. On top of that, every declared slot — the
 * primary included — also gets namespaced keys `{<slot>__<logical>}`, so a
 * two-input action can write `SELECT … FROM {candidate__event}`. A log input
 * carries no inline payload, so `ctx.inputs[slot]` is `null` for it; this map
 * is the only way such an action reaches the second log's rows.
 *
 * The `__` separator (not `.`) is deliberate: `str.format` in the worker's
 * `_Ctx.sql` treats a dotted key as attribute access and would raise `KeyError`.
 */
export function roleTableMap(
  action: Pick<ManifestAction, 'inputs'>,
  inputs: Record<string, ArtifactId[]>,
  catalog: { artifacts: Record<string, Artifact | undefined> },
): Record<string, string> {
  const tables: Record<string, string> = {};
  const primaryId = inputs[action.inputs[0]?.name ?? '']?.[0];
  for (const slot of action.inputs) {
    for (const id of inputs[slot.name] ?? []) {
      const art = catalog.artifacts[id];
      if (!art) continue;
      for (const logical of logicalTablesOf(art)) {
        tables[`${slot.name}__${logical}`] = tableOf(id, logical);
        if (id === primaryId) tables[logical] = tableOf(id, logical);
      }
    }
  }
  return tables;
}
