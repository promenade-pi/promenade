import * as arrow from 'apache-arrow';
import { schemaFor, PHYSICAL_LOGICAL_NAME } from '../relational/schemas.ts';
import type { LogicalColumn } from '../relational/types.ts';

/**
 * Columnar log rows -> the Arrow relations a log-shaped artifact's physical
 * storage is built from.
 *
 * The third and last way a log gets into this workspace, after import and
 * `ActionContext.persistLog`'s SQL program. Those two both start from data the
 * host already has; this one starts from data an action *computed* — a
 * simulator playing a Petri net out into traces has no source log to select
 * from, and nothing it produces can be expressed as a query over its input.
 * Without this such an action can only return an inline blob, which no miner,
 * no view and no SQL can read as a log.
 *
 * What keeps that from being a forgery door is that the plugin hands over
 * *rows*, never storage: every column is declared in the target type's logical
 * schema (`host/relational/schemas.ts`), checked here, and written by the host.
 * A package cannot put a structurally invalid log into the catalog any more
 * than a view's `promenade.publishLog()` can (`publish-log.ts`, the
 * object-centric authoring counterpart of this module — same rule, different
 * input shape: hand-authored grids there, generated columns here).
 *
 * Columnar rather than row-wise because the producer is a program: a
 * WASM kernel emitting six typed arrays crosses the boundary once, where
 * 200 000 little `{event_idx, trace_idx, …}` objects would be allocated twice
 * and discarded immediately.
 *
 * Relations and columns are named by the *logical* schema — `events`, `cases`,
 * `ts` — which is the vocabulary a plugin author reads in the relational API
 * docs. The physical names storage uses (`event`, `trace`) are applied on the
 * way out, and timestamps leave here as `<name>_us` BIGINT columns of epoch
 * microseconds: see `TIMESTAMP_SUFFIX`.
 */

/** Logical relation name -> column name -> that column's values, one entry per row. */
export type LogColumns = Record<string, Record<string, ArrayLike<unknown>>>;

/**
 * Timestamps cross as integer microseconds under `<name>_us`, and the worker
 * turns them into real `TIMESTAMP` columns with `make_timestamp()` — exactly
 * what XES ingest does (`ingest/xes.ts`), which is the point: a generated log
 * and an imported one have to be indistinguishable at rest, and the one place
 * they could silently differ is the unit a timestamp column is actually
 * stored in. Arrow's JS timestamp vectors are the wrong tool for that
 * specifically — their stored unit does not always follow the declared one —
 * so this path never builds one.
 */
export const TIMESTAMP_SUFFIX = '_us';

export interface BuiltLogRelations {
  /** Physical relation name (`event`, `trace`, …) -> Arrow IPC bytes. */
  relations: Record<string, Uint8Array>;
  /** Row counts per physical relation, for the caller's own stats. */
  counts: Record<string, number>;
}

function fail(message: string): never {
  throw new Error(message);
}

function asBigInt(value: unknown, where: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      fail(`${where}: expected a whole number, got ${value}`);
    }
    return BigInt(value);
  }
  fail(`${where}: expected a number, got ${typeof value}`);
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * One declared column as an Arrow vector, or `null` when the caller did not
 * supply it at all.
 *
 * A missing *optional* column is normal — a log with no resources has no
 * `resource` values to send — and the worker fills it with nulls so the
 * physical table still has the shape every reader expects. A missing
 * *required* one is refused here rather than discovered later as a column of
 * nulls that no error ever mentioned.
 */
function vectorFor(
  column: LogicalColumn, values: ArrayLike<unknown> | undefined, rows: number, where: string,
): { name: string; vector: arrow.Vector } | null {
  if (values === undefined) {
    if (column.required) fail(`${where}: required column "${column.name}" is missing`);
    return null;
  }
  if (values.length !== rows) {
    fail(`${where}: column "${column.name}" has ${values.length} values; the relation has ${rows} rows`);
  }
  const at = (i: number) => (values as any)[i];
  const check = (v: unknown, i: number) => {
    if (column.required && (v === null || v === undefined)) {
      fail(`${where}: column "${column.name}" is null at row ${i + 1} but every row must carry a value`);
    }
    return v;
  };

  switch (column.type) {
    case 'timestamp': {
      const out = new Array<bigint | null>(rows);
      for (let i = 0; i < rows; i++) {
        out[i] = asBigInt(check(at(i), i), `${where}: column "${column.name}" row ${i + 1}`);
      }
      return {
        name: `${column.name}${TIMESTAMP_SUFFIX}`,
        vector: arrow.vectorFromArray(out, new arrow.Int64()),
      };
    }
    case 'bigint':
    case 'integer': {
      const out = new Array<bigint | null>(rows);
      for (let i = 0; i < rows; i++) {
        out[i] = asBigInt(check(at(i), i), `${where}: column "${column.name}" row ${i + 1}`);
      }
      return { name: column.name, vector: arrow.vectorFromArray(out, new arrow.Int64()) };
    }
    case 'varchar': {
      const out = new Array<string | null>(rows);
      for (let i = 0; i < rows; i++) out[i] = asText(check(at(i), i));
      return { name: column.name, vector: arrow.vectorFromArray(out, new arrow.Utf8()) };
    }
    case 'double': {
      const out = new Array<number | null>(rows);
      for (let i = 0; i < rows; i++) {
        const v = check(at(i), i);
        out[i] = v === null || v === undefined ? null : Number(v);
      }
      return { name: column.name, vector: arrow.vectorFromArray(out, new arrow.Float64()) };
    }
    case 'boolean': {
      const out = new Array<boolean | null>(rows);
      for (let i = 0; i < rows; i++) {
        const v = check(at(i), i);
        out[i] = v === null || v === undefined ? null : Boolean(v);
      }
      return { name: column.name, vector: arrow.vectorFromArray(out, new arrow.Bool()) };
    }
    default:
      fail(`${where}: column "${column.name}" has unsupported type "${(column as LogicalColumn).type}"`);
  }
}

/**
 * Validates generated columns against a log type's logical schema and encodes
 * them as Arrow IPC, one table per physical relation.
 *
 * Throws — naming the relation, column and row — rather than returning a
 * partially valid log, for the same reason `buildAuthoredOcelRelations` does:
 * everything downstream treats what it is handed as already checked.
 *
 * A relation with no rows is omitted entirely rather than written empty, which
 * is what a real import does too (`ingest/xes.ts` writes no `trace_attr` file
 * for a log that has no trace attributes).
 */
export function buildLogRelations(targetType: string, columns: LogColumns): BuiltLogRelations {
  const schema = schemaFor(targetType);
  if (!schema) {
    fail(`"${targetType}" is not a log-shaped artifact type, so it cannot be built from rows`);
  }
  const physicalOf = PHYSICAL_LOGICAL_NAME[targetType] ?? {};
  const byName = new Map(schema.relations.map((r) => [r.name, r]));

  const relations: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};

  for (const [name, supplied] of Object.entries(columns)) {
    const relation = byName.get(name);
    if (!relation) {
      fail(
        `unknown relation "${name}" for ${targetType} — it declares ` +
        `${schema.relations.map((r) => r.name).join(', ')}`
      );
    }
    const physical = physicalOf[name];
    if (!physical) fail(`relation "${name}" of ${targetType} has no physical storage`);
    if (!supplied || typeof supplied !== 'object') fail(`relation "${name}": expected an object of columns`);

    const declared = new Set(relation.columns.map((c) => c.name));
    for (const key of Object.keys(supplied)) {
      if (!declared.has(key)) {
        fail(
          `relation "${name}": unknown column "${key}" — it declares ` +
          `${relation.columns.map((c) => c.name).join(', ')}`
        );
      }
    }

    // Every column of a relation describes the same rows, so the row count is
    // whatever the first supplied column has and every other column is then
    // checked against it. A relation with no columns at all has no rows.
    const first = Object.values(supplied)[0];
    const rows = first ? first.length : 0;
    counts[physical] = rows;
    if (rows === 0) continue;

    const fields: Record<string, arrow.Vector> = {};
    for (const column of relation.columns) {
      const built = vectorFor(column, supplied[column.name], rows, `relation "${name}"`);
      if (built) fields[built.name] = built.vector;
    }
    relations[physical] = arrow.tableToIPC(new arrow.Table(fields), 'stream');
  }

  // `event` is the one relation nothing downstream can do without: it is what
  // `mountArtifact` builds the classifier view over, and a log without it is
  // an artifact every query fails against.
  const eventRelation = physicalOf.events;
  if (!eventRelation || !relations[eventRelation]) {
    fail(`a ${targetType} needs a non-empty "events" relation`);
  }

  return { relations, counts };
}
