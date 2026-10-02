import * as arrow from 'apache-arrow';
import type { LogicalColumn } from '../relational/types.ts';

/**
 * Columnar rows -> the Arrow relations a **table-shaped** artifact is built
 * from.
 *
 * The dataset counterpart of `log-rows.ts`. That module exists because a
 * plugin could not otherwise *write* a log; this one exists because a plugin
 * could not otherwise write a **table** — and until now those were the only
 * two shapes of result a package could contribute besides an inline blob.
 * A feature matrix, a metrics table, a per-resource summary: each is data
 * someone wants to query, join, export and model on, and an inline blob is
 * none of those things.
 *
 * The difference from a log is where the schema comes from. A log's is the
 * host's (`relational/schemas.ts`) and is closed: a plugin may not invent a
 * column of a `TraditionalEventLog`. A table's is the *plugin's*, declared in
 * its manifest (`PluginManifest.artifactTypes[].table`) and passed in here, so
 * the host still checks what it writes without having to know in advance what
 * a feature is called.
 *
 * `open` relations take that one step further and allow columns the manifest
 * could not have named: one per activity in the log, say. Those are typed by
 * inspection (see `inferred`), which is the one place this module guesses —
 * and it guesses from the values rather than from the name, so the guess is
 * checkable and the same input always gives the same type.
 */

/** Relation name -> column name -> that column's values, one entry per row. */
export type TableColumns = Record<string, Record<string, ArrayLike<unknown>>>;

/** One relation of a plugin-declared table schema. */
export interface TableRelationSchema {
  name: string;
  open?: boolean;
  columns: Array<Pick<LogicalColumn, 'name' | 'type'> & { required?: boolean }>;
}

export interface BuiltTableRelations {
  /** Relation name -> Arrow IPC bytes. */
  relations: Record<string, Uint8Array>;
  /** Row counts per relation, for the caller's own stats. */
  counts: Record<string, number>;
  /** Every column actually written, per relation, declared and inferred alike. */
  columns: Record<string, string[]>;
}

/**
 * Timestamps cross as integer microseconds under `<name>_us`, exactly as in
 * `log-rows.ts` — the worker turns them into real `TIMESTAMP` columns. Kept
 * identical on purpose: two ways of spelling the same convention is how a
 * generated table and a generated log start to disagree about what a
 * timestamp is.
 */
export const TIMESTAMP_SUFFIX = '_us';

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

function vectorOf(
  type: LogicalColumn['type'], values: ArrayLike<unknown>, rows: number, required: boolean, where: string,
): { name: string; vector: arrow.Vector } | null {
  const at = (i: number) => (values as any)[i];
  const check = (v: unknown, i: number) => {
    if (required && (v === null || v === undefined)) {
      fail(`${where} is null at row ${i + 1} but every row must carry a value`);
    }
    return v;
  };

  switch (type) {
    case 'timestamp':
    case 'bigint':
    case 'integer': {
      const out = new Array<bigint | null>(rows);
      for (let i = 0; i < rows; i++) out[i] = asBigInt(check(at(i), i), `${where} row ${i + 1}`);
      return { name: '', vector: arrow.vectorFromArray(out, new arrow.Int64()) };
    }
    case 'double': {
      const out = new Array<number | null>(rows);
      for (let i = 0; i < rows; i++) {
        const v = check(at(i), i);
        if (v === null || v === undefined) { out[i] = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n)) {
          // NaN and Infinity survive a round trip through Parquet but mean
          // nothing to most readers, and a feature column full of them is a
          // bug upstream worth naming here rather than shipping.
          fail(`${where} row ${i + 1}: ${String(v)} is not a finite number`);
        }
        out[i] = n;
      }
      return { name: '', vector: arrow.vectorFromArray(out, new arrow.Float64()) };
    }
    case 'boolean': {
      const out = new Array<boolean | null>(rows);
      for (let i = 0; i < rows; i++) {
        const v = check(at(i), i);
        out[i] = v === null || v === undefined ? null : Boolean(v);
      }
      return { name: '', vector: arrow.vectorFromArray(out, new arrow.Bool()) };
    }
    case 'varchar': {
      const out = new Array<string | null>(rows);
      for (let i = 0; i < rows; i++) {
        const v = check(at(i), i);
        out[i] = v === null || v === undefined ? null : typeof v === 'string' ? v : String(v);
      }
      return { name: '', vector: arrow.vectorFromArray(out, new arrow.Utf8()) };
    }
    default:
      fail(`${where}: unsupported column type "${type}"`);
  }
}

/**
 * The type of a column the manifest did not declare, from what is in it.
 *
 * Deliberately narrow and value-driven: whole numbers are `bigint`, any other
 * finite number is `double`, booleans are `boolean`, and everything else —
 * including a column that is entirely null — is `varchar`. A mixed column
 * falls to `varchar` rather than being rejected, because an `open` relation's
 * whole purpose is columns the host was never told about, and refusing one at
 * this point would leave the plugin no way to name the problem.
 */
function inferred(values: ArrayLike<unknown>, rows: number): LogicalColumn['type'] {
  let seen = false;
  let allBoolean = true;
  let allNumber = true;
  let allInteger = true;
  for (let i = 0; i < rows; i++) {
    const v = (values as any)[i];
    if (v === null || v === undefined) continue;
    seen = true;
    if (typeof v !== 'boolean') allBoolean = false;
    if (typeof v === 'bigint') { allBoolean = false; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { allNumber = false; allInteger = false; continue; }
    if (!Number.isInteger(v)) allInteger = false;
  }
  if (!seen) return 'varchar';
  if (allBoolean) return 'boolean';
  if (allNumber && allInteger) return 'bigint';
  if (allNumber) return 'double';
  return 'varchar';
}

/**
 * Validates generated columns against a plugin-declared table schema and
 * encodes them as Arrow IPC, one table per relation.
 *
 * Throws — naming the relation, column and row — rather than returning a
 * partially valid table, for the same reason `buildLogRelations` does:
 * everything downstream treats what it is handed as already checked.
 */
export function buildTableRelations(
  targetType: string, schema: TableRelationSchema[], columns: TableColumns,
): BuiltTableRelations {
  if (!Array.isArray(schema) || schema.length === 0) {
    fail(`"${targetType}" is not a table-shaped artifact type, so it cannot be built from rows`);
  }
  const byName = new Map(schema.map((r) => [r.name, r]));

  const relations: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  const written: Record<string, string[]> = {};

  for (const [name, supplied] of Object.entries(columns)) {
    const relation = byName.get(name);
    if (!relation) {
      fail(
        `unknown relation "${name}" for ${targetType} — it declares ` +
        `${schema.map((r) => r.name).join(', ')}`
      );
    }
    if (!supplied || typeof supplied !== 'object') fail(`relation "${name}": expected an object of columns`);

    const declared = new Map(relation.columns.map((c) => [c.name, c]));
    if (!relation.open) {
      for (const key of Object.keys(supplied)) {
        if (!declared.has(key)) {
          fail(
            `relation "${name}": unknown column "${key}" — it declares ` +
            `${relation.columns.map((c) => c.name).join(', ')}. Declare the relation "open" if its ` +
            `columns cannot be known in advance.`
          );
        }
      }
    }

    // Every column of a relation describes the same rows, so the row count is
    // whatever the first supplied column has and every other column is then
    // checked against it.
    const first = Object.values(supplied)[0];
    const rows = first ? first.length : 0;
    counts[name] = rows;
    written[name] = [];
    if (rows === 0) {
      for (const column of relation.columns) {
        if (column.required !== false && supplied[column.name] === undefined) {
          fail(`relation "${name}": required column "${column.name}" is missing`);
        }
      }
      continue;
    }

    const fields: Record<string, arrow.Vector> = {};
    // Declared columns first and in declaration order, so the table a reader
    // opens starts with the columns the plugin promised rather than with
    // whichever inferred one happened to be first in an object.
    for (const column of relation.columns) {
      const values = supplied[column.name];
      if (values === undefined) {
        if (column.required !== false) fail(`relation "${name}": required column "${column.name}" is missing`);
        continue;
      }
      if (values.length !== rows) {
        fail(`relation "${name}": column "${column.name}" has ${values.length} values; the relation has ${rows} rows`);
      }
      const built = vectorOf(
        column.type, values, rows, column.required !== false, `relation "${name}" column "${column.name}"`,
      );
      if (!built) continue;
      const stored = column.type === 'timestamp' ? `${column.name}${TIMESTAMP_SUFFIX}` : column.name;
      fields[stored] = built.vector;
      written[name].push(stored);
    }

    if (relation.open) {
      for (const [key, values] of Object.entries(supplied)) {
        if (declared.has(key)) continue;
        // `<name>_us` is how a *declared* timestamp column crosses, and the
        // worker turns any column with that suffix into a real timestamp. An
        // undeclared column may therefore not wear it: `wait_us` meaning "a
        // duration in microseconds" would silently become a date in 1970.
        if (key.endsWith(TIMESTAMP_SUFFIX)) {
          fail(
            `relation "${name}": column "${key}" ends in "${TIMESTAMP_SUFFIX}", which is reserved for ` +
            `timestamps. Declare it as a timestamp column, or rename it.`
          );
        }
        if (values.length !== rows) {
          fail(`relation "${name}": column "${key}" has ${values.length} values; the relation has ${rows} rows`);
        }
        const built = vectorOf(
          inferred(values, rows), values, rows, false, `relation "${name}" column "${key}"`,
        );
        if (!built) continue;
        fields[key] = built.vector;
        written[name].push(key);
      }
    }

    relations[name] = arrow.tableToIPC(new arrow.Table(fields), 'stream');
  }

  if (Object.keys(relations).length === 0) {
    fail(`a ${targetType} needs at least one non-empty relation`);
  }
  return { relations, counts, columns: written };
}
