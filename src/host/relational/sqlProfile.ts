import type { RelationalProgram, RelationalStatement } from './types.ts';

/**
 * Promenade Relational SQL Profile v1.
 *
 * A deliberately small, practical guard — not a SQL parser and not an
 * attempt at standard compliance (see `docs/relational-api.md`). It exists
 * to keep untrusted `runtime: 'relational'` plugin SQL inside a portable
 * subset and away from engine/filesystem/network surface, at the one point
 * that actually matters: this module's checks are re-run by the data worker
 * itself (`worker/data-worker.ts`'s `relational` command) immediately before
 * execution, so a compromised or buggy caller in the main thread cannot skip
 * them.
 *
 * Rules:
 *  - A program is a sequence of named statements, each introduced by a
 *    `-- @relation <name>` or `-- @output <name>` marker comment. This is the
 *    "small multi-statement DSL around SQL" the task favors over inventing a
 *    block syntax: every line is still SQL a human or an OCPQ compiler can
 *    read directly.
 *  - Each statement is exactly one `SELECT`/`WITH` query. No DDL, DML,
 *    session, transaction, extension, attach, or filesystem statement is
 *    permitted anywhere in the profile.
 *  - An input relation is referenced through `{role.relation}` (braces,
 *    always containing a dot). Every other named relation a program can see —
 *    an earlier `-- @relation`/`-- @output` statement, or a CTE the statement
 *    declares for itself — is referenced the ordinary bare SQL way (`FROM
 *    root`), because once compiled it *is* an ordinary CTE (see
 *    `compileProgram.ts`). A bare identifier that is neither is rejected:
 *    that is what keeps a plugin from guessing or reaching for a physical
 *    table name — nothing outside `{role.relation}` can name a DuckDB object.
 *  - User parameters are never spliced into the text; see `paramBinding.ts`.
 *  - Keyword/function blocklist checks, and the FROM/JOIN scan, run against
 *    the statement with string literals and `--` comments blanked out first.
 *    Neither ever executes as SQL, so scanning them finds nothing but false
 *    positives — an activity literally named "Create Order" or a comment
 *    that happens to contain the word "set" must not make a query illegal.
 */

export interface SqlProfileViolation {
  statement: string;
  message: string;
}

/** Statements this profile permits nowhere in a program. Checked case-insensitively, word-bounded. */
export const FORBIDDEN_KEYWORDS = [
  'PRAGMA', 'INSTALL', 'LOAD', 'ATTACH', 'DETACH', 'COPY', 'EXPORT', 'IMPORT',
  'CALL', 'EXECUTE', 'PREPARE', 'DEALLOCATE',
  'CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'SET', 'RESET', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'VACUUM', 'CHECKPOINT', 'EXPLAIN', 'ANALYZE', 'USE',
] as const;

/** Table/scalar functions this profile forbids — filesystem, extension, network and catalog-introspection surface. */
export const FORBIDDEN_CALLS = [
  'read_parquet', 'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto',
  'read_ndjson', 'read_ndjson_auto', 'read_text', 'read_blob', 'glob',
  'scan_arrow_ipc', 'sqlite_scan', 'sqlite_attach', 'postgres_scan',
  'postgres_attach', 'mysql_scan', 'mysql_attach', 'iceberg_scan',
  'iceberg_metadata', 'delta_scan', 'parquet_scan', 'parquet_metadata',
  'duckdb_extensions', 'duckdb_functions', 'duckdb_tables', 'duckdb_views',
  'duckdb_columns', 'duckdb_settings', 'pragma_version', 'pragma_database_list',
  'getenv', 'current_setting', 'current_database', 'current_schema',
] as const;

/** Allowed constructs, for documentation and for the profile's own tests. Not exhaustive; anything not forbidden and DuckDB-standard-SQL-shaped is permitted. */
export const SQL_PROFILE_V1 = {
  statementForms: ['SELECT', 'WITH … SELECT'] as const,
  clauses: ['WHERE', 'JOIN', 'LEFT JOIN', 'UNION', 'UNION ALL', 'GROUP BY', 'HAVING', 'ORDER BY', 'CASE', 'QUALIFY'] as const,
  aggregates: ['COUNT', 'SUM', 'MIN', 'MAX', 'AVG'] as const,
  windowFunctions: ['ROW_NUMBER', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE'] as const,
  forbiddenKeywords: FORBIDDEN_KEYWORDS,
  forbiddenCalls: FORBIDDEN_CALLS,
};

const MARKER_RE = /^--\s*@(relation|output)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/;

/**
 * Parses `-- @relation name` / `-- @output name` marker comments into an
 * ordered program. Deliberately regex/line-based rather than a real SQL
 * tokenizer — the markers are full-line comments by construction, so a line
 * scan cannot misfire on SQL content the way a substring search could.
 */
export function parseProgram(source: string): RelationalProgram {
  const lines = source.split(/\r\n|\r|\n/);
  const statements: RelationalStatement[] = [];
  let current: { name: string; kind: 'relation' | 'output'; lines: string[] } | null = null;

  const finish = (c: { name: string; kind: 'relation' | 'output'; lines: string[] }): RelationalStatement =>
    ({ name: c.name, kind: c.kind, sql: c.lines.join('\n').trim() });

  for (const line of lines) {
    const m = MARKER_RE.exec(line.trim());
    if (m) {
      if (current) statements.push(finish(current));
      current = { kind: m[1] as 'relation' | 'output', name: m[2], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else if (line.trim().length && !line.trim().startsWith('--')) {
      throw new Error(
        `relational program: statement text before the first "-- @relation"/"-- @output" marker: "${line.trim().slice(0, 60)}"`
      );
    }
  }
  if (current) statements.push(finish(current));

  if (!statements.length) throw new Error('relational program: no statements declared');
  if (!statements.some((s) => s.kind === 'output')) {
    throw new Error('relational program: at least one "-- @output" statement is required');
  }
  const seen = new Set<string>();
  for (const s of statements) {
    if (seen.has(s.name)) throw new Error(`relational program: duplicate statement name "${s.name}"`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) {
      throw new Error(`relational program: invalid statement name "${s.name}"`);
    }
    seen.add(s.name);
  }
  return { statements };
}

/**
 * Blanks out single-quoted string literals and `--` line comments, replacing
 * their content with spaces (never removing text, so every offset in the
 * result still lines up with `sql`). Every structural check below —
 * keyword/call blocklists, the "starts with SELECT/WITH" check, the
 * single-statement check, and the FROM/JOIN scan — runs against this masked
 * text, because none of those three kinds of content ever execute as SQL.
 */
export function maskForScanning(sql: string): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      if (c === "'") {
        if (sql[i + 1] === "'") { out += '  '; i += 2; continue; }
        inString = false;
        out += ' ';
        i++;
        continue;
      }
      out += ' ';
      i++;
      continue;
    }
    if (c === "'") { inString = true; out += ' '; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Semicolons in the masked (comment/string-free) text. */
function findTopLevelSemicolons(masked: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === ';') positions.push(i);
  return positions;
}

/** CTE names a statement declares itself, e.g. `WITH foo AS (...)`, `, bar AS (...)`. */
export function extractCteNames(masked: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bWITH\s+|,\s*)([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) names.add(m[1].toLowerCase());
  return names;
}

export interface FromJoinTarget { raw: string; braced: boolean }

/**
 * Every FROM/JOIN target: `{role.relation}` (an input, always braced and
 * dotted), or a bare identifier — legal only as a CTE the statement declares
 * or an earlier program statement, checked by the caller.
 */
export function extractFromJoinTargets(masked: string): FromJoinTarget[] {
  const targets: FromJoinTarget[] = [];
  const re = /\b(?:FROM|JOIN)\s+(\{[A-Za-z_][A-Za-z0-9_.]*\}|[A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const raw = m[1];
    targets.push({ raw, braced: raw.startsWith('{') });
  }
  return targets;
}

/**
 * Validates one statement against the profile.
 *
 * `allowedPlaceholders` is the set of legal `{...}` contents at this point in
 * the program: every declared input's `role.relation` plus the name of every
 * statement declared earlier. Passing it in (rather than recomputing it) is
 * what makes forward references a violation — a statement can only build on
 * what already exists, the same ordering rule `transform/compile.ts` already
 * enforces for its own staged views.
 */
export function validateStatement(
  stmt: RelationalStatement,
  allowedPlaceholders: ReadonlySet<string>
): SqlProfileViolation[] {
  const violations: SqlProfileViolation[] = [];
  const sql = stmt.sql;

  if (!sql.trim()) {
    return [{ statement: stmt.name, message: 'empty statement' }];
  }

  const masked = maskForScanning(sql);

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(masked)) {
      violations.push({ statement: stmt.name, message: `forbidden keyword: ${kw}` });
    }
  }
  for (const fn of FORBIDDEN_CALLS) {
    if (new RegExp(`\\b${fn}\\s*\\(`, 'i').test(masked)) {
      violations.push({ statement: stmt.name, message: `forbidden function: ${fn}()` });
    }
  }

  if (!/^\s*(SELECT|WITH)\b/i.test(masked.trim())) {
    violations.push({ statement: stmt.name, message: 'statement must begin with SELECT or WITH' });
  }

  const semis = findTopLevelSemicolons(masked);
  const trimmedEnd = masked.trimEnd();
  const trailingOnly = semis.length === 0 || (semis.length === 1 && semis[0] === trimmedEnd.length - 1);
  if (!trailingOnly) {
    violations.push({ statement: stmt.name, message: 'exactly one statement is allowed per block; remove the extra ";"' });
  }

  const cteNames = extractCteNames(masked);
  for (const t of extractFromJoinTargets(masked)) {
    if (t.braced) {
      const inner = t.raw.slice(1, -1);
      if (!inner.includes('.')) {
        violations.push({
          statement: stmt.name,
          message: `"{${inner}}" is invalid — braces are only for "{role.relation}" input references; reference an earlier statement "${inner}" by its bare name, not in braces`,
        });
      } else if (!allowedPlaceholders.has(inner)) {
        violations.push({ statement: stmt.name, message: `"{${inner}}" is not a declared input relation` });
      }
    } else if (!cteNames.has(t.raw.toLowerCase()) && !allowedPlaceholders.has(t.raw)) {
      violations.push({
        statement: stmt.name,
        message: `bare table reference "${t.raw}" is not allowed — use "{role.relation}" for an input, or name an earlier "-- @relation"/"-- @output" statement`,
      });
    }
  }

  return violations;
}

/**
 * Validates a whole program in order, growing the allowed-placeholder set as
 * each statement is accepted. `inputPlaceholders` is every `role.relation`
 * the caller has bound, e.g. `{"log.events", "log.cases", ...}`.
 */
export function validateProgram(
  program: RelationalProgram,
  inputPlaceholders: ReadonlySet<string>
): SqlProfileViolation[] {
  const violations: SqlProfileViolation[] = [];
  const declared = new Set(inputPlaceholders);
  for (const stmt of program.statements) {
    violations.push(...validateStatement(stmt, declared));
    declared.add(stmt.name);
  }
  return violations;
}
