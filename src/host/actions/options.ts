import { dataClient } from '../data/client';
import { hasTables } from '../artifact/tables';
import { tableOf } from '../../ui/views/tableName';
import type { OptionSource } from './types';
import type { Artifact, ProvenanceGraph } from '../artifact/types';

/**
 * Resolves data-bound parameter options.
 *
 * The host runs the query, not the plugin — that is what keeps such a control
 * renderable in the inspector column and drivable by live recompute.
 */

export interface Option {
  value: string;
  label: string;
  count?: number;
}

/**
 * Cached by (artifact, query).
 *
 * Options are re-read when the artifact changes, not on every keystroke: the
 * list of activities in a log does not move while the user is picking from it.
 */
const cache = new Map<string, Promise<Option[]>>();

/**
 * The artifact whose tables a parameter's options should be read from.
 *
 * For a derived artifact the answer is its *input*, not itself: "which
 * activities should the DFG include" is a question about the log, and a DFG
 * has no `event` table to ask.
 */
export function optionSourceArtifact(
  artifact: Artifact,
  graph: ProvenanceGraph
): Artifact | null {
  if (hasTables(artifact)) return artifact;
  const exec = artifact.producedBy ? graph.executions[artifact.producedBy] : null;
  const inputId = exec ? Object.values(exec.inputs).flat()[0] : null;
  return inputId ? graph.artifacts[inputId] ?? null : null;
}

export function loadOptions(source: OptionSource, artifact: Artifact): Promise<Option[]> {
  if (artifact.storage.kind !== 'parquet') return Promise.resolve([]);

  const tables = Object.fromEntries(
    Object.keys(artifact.storage.files).map((l) => [l, tableOf(artifact.id, l)])
  );

  // `{event}` and friends expand to physical view names, exactly as in a
  // plugin's own SQL.
  let sql = source.sql;
  for (const [logical, physical] of Object.entries(tables)) {
    sql = sql.split(`{${logical}}`).join(physical);
  }
  // A query naming a table this artifact does not have cannot be answered.
  if (/\{[a-z_]+\}/.test(sql)) return Promise.resolve([]);

  const key = `${artifact.id}::${sql}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const valueField = source.valueField ?? 'value';
  const labelField = source.labelField ?? valueField;

  const p = dataClient.sql(sql)
    .then((table) =>
      table.toArray().map((r: any) => {
        const row = r.toJSON();
        const raw = row[valueField];
        return {
          value: raw == null ? '' : String(raw),
          label: String(row[labelField] ?? raw ?? ''),
          count: source.countField != null && row[source.countField] != null
            ? Number(row[source.countField])
            : undefined,
        };
      })
    )
    .catch(() => [] as Option[]);

  cache.set(key, p);
  return p;
}

/** Dropped when an artifact is deleted, so a reused id cannot serve stale options. */
export function invalidateOptions(artifactId: string) {
  for (const k of [...cache.keys()]) {
    if (k.startsWith(`${artifactId}::`)) cache.delete(k);
  }
}
