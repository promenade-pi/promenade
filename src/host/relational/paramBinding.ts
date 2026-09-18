/**
 * Safe parameter binding for Relational SQL Profile v1 statements.
 *
 * A statement refers to a parameter as `:name` — never string-concatenated.
 * `toPositionalSql()` rewrites every `:name` to DuckDB's `?` positional
 * placeholder and returns the matching value order; the worker then runs the
 * statement through `AsyncDuckDBConnection.prepare()` +
 * `AsyncPreparedStatement.query(...values)`, DuckDB-wasm's own bound-parameter
 * API. Values never touch the SQL text.
 *
 * Scanning is string-literal-aware so `'a:b'` or a `::CAST` do not get
 * mistaken for a parameter reference — but this is a scanner, not a parser;
 * see `docs/relational-api.md` for the profile's known limitations.
 */

export interface ParamOccurrence { name: string; start: number; end: number }

/**
 * `:name` occurrences outside single-quoted string literals and `--` comments.
 * `::` (DuckDB's cast operator) is never matched.
 *
 * Comments are skipped for the same reason strings are, and the reason is not
 * that a parameter reference inside one would be bound — it is that an
 * apostrophe inside one flips the string-literal parity for everything after
 * it. A program whose comment says "the notebook's protocol" then has its
 * *real* string literals read as code and its code read as strings, and the
 * failure surfaces as a parameter the action never declared. `maskForScanning`
 * in `sqlProfile.ts` has always skipped comments; this scanner not doing so
 * meant the validator and the binder disagreed about where the strings are.
 */
export function scanParamOccurrences(sql: string): ParamOccurrence[] {
  const occ: ParamOccurrence[] = [];
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      if (c === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; }
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === "'") { inString = true; i++; continue; }
    if (c === ':' && sql[i - 1] !== ':') {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
      if (m) {
        occ.push({ name: m[0], start: i, end: i + 1 + m[0].length });
        i = i + 1 + m[0].length;
        continue;
      }
    }
    i++;
  }
  return occ;
}

export function extractParamNames(sql: string): string[] {
  return [...new Set(scanParamOccurrences(sql).map((o) => o.name))];
}

/** Rewrites every `:name` to `?`, returning the ordered list of names a caller must supply values for, in bind order. */
export function toPositionalSql(sql: string): { sql: string; order: string[] } {
  const occ = scanParamOccurrences(sql);
  if (!occ.length) return { sql, order: [] };
  let out = '';
  let cursor = 0;
  const order: string[] = [];
  for (const o of occ) {
    out += sql.slice(cursor, o.start) + '?';
    order.push(o.name);
    cursor = o.end;
  }
  out += sql.slice(cursor);
  return { sql: out, order };
}

/** The subset of `ParamProperty` (see `host/actions/types.ts`) needed to validate and coerce a bound value. */
export interface ParamTypeSchema {
  type: 'number' | 'integer' | 'string' | 'boolean' | 'array';
  items?: { type: 'number' | 'integer' | 'string' };
}

export type BoundValue = string | number | boolean | string[] | number[];

/**
 * Narrows an action manifest's `ParamSchema.properties` (which carries UI
 * concerns this module has no use for — `title`, `default`, `optionsFrom`,
 * `primary`, `cheap`…) down to what parameter binding needs. Every relational
 * action's `executeRelational()` call needs this, so it lives here rather
 * than being rebuilt per call site.
 */
export function paramTypeSchemasFrom(
  properties: Record<string, { type: string; items?: { type: string } }>
): Record<string, ParamTypeSchema> {
  const out: Record<string, ParamTypeSchema> = {};
  for (const [name, p] of Object.entries(properties)) {
    out[name] = {
      type: p.type as ParamTypeSchema['type'],
      items: p.items ? { type: p.items.type as 'number' | 'integer' | 'string' } : undefined,
    };
  }
  return out;
}

/**
 * Validates `raw` against the manifest's declared type and returns the value
 * to bind. Rejects silently-wrong types (`"10"` for an `integer` parameter)
 * rather than coercing them, because a coercion that "just works" here is a
 * coercion a SQL injection payload could also trigger.
 */
export function coerceParamValue(name: string, raw: unknown, schema: ParamTypeSchema): BoundValue {
  switch (schema.type) {
    case 'integer':
      if (typeof raw !== 'number' || !Number.isInteger(raw)) {
        throw new Error(`parameter "${name}" must be an integer, got ${JSON.stringify(raw)}`);
      }
      return raw;
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        throw new Error(`parameter "${name}" must be a number, got ${JSON.stringify(raw)}`);
      }
      return raw;
    case 'boolean':
      if (typeof raw !== 'boolean') {
        throw new Error(`parameter "${name}" must be a boolean, got ${JSON.stringify(raw)}`);
      }
      return raw;
    case 'string':
      if (typeof raw !== 'string') {
        throw new Error(`parameter "${name}" must be a string, got ${JSON.stringify(raw)}`);
      }
      return raw;
    case 'array': {
      if (!Array.isArray(raw)) {
        throw new Error(`parameter "${name}" must be an array, got ${JSON.stringify(raw)}`);
      }
      const itemType = schema.items?.type ?? 'string';
      for (const v of raw) {
        if (itemType === 'string' && typeof v !== 'string') {
          throw new Error(`parameter "${name}": every element must be a string`);
        }
        if ((itemType === 'number' || itemType === 'integer') && typeof v !== 'number') {
          throw new Error(`parameter "${name}": every element must be a number`);
        }
      }
      // DuckDB-Wasm's prepared-statement binding has no LIST-typed bound
      // parameter — only scalars. An array param is therefore bound as one
      // delimited string (U+001F, the ASCII "unit separator" — a control
      // character no real value is expected to contain) and reconstituted
      // in SQL via `string_split(:name, chr(31))`. Every relational action
      // using an array param needs that same call; it is not specific to
      // whichever action reads this.
      return (raw as unknown[]).map(String).join('');
    }
  }
}

/**
 * Binds one statement's `:name` references to validated values.
 *
 * `declaredParams` is the action manifest's parameter schema — a statement
 * may only reference a parameter the manifest declares, so a plugin cannot
 * invent an untyped, unvalidated bind target at query time.
 */
export function bindStatementParams(
  sql: string,
  values: Record<string, unknown>,
  declaredParams: Record<string, ParamTypeSchema>
): { sql: string; values: BoundValue[] } {
  const { sql: positional, order } = toPositionalSql(sql);
  const bound = order.map((name) => {
    const schema = declaredParams[name];
    if (!schema) {
      throw new Error(`":${name}" is not a declared parameter of this action`);
    }
    if (!(name in values)) {
      throw new Error(`missing value for parameter ":${name}"`);
    }
    return coerceParamValue(name, values[name], schema);
  });
  return { sql: positional, values: bound };
}
