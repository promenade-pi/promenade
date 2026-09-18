import type { RelationalInputBinding, RelationalProgram, RelationalStatement } from './types.ts';
import { PHYSICAL_LOGICAL_NAME, schemaFor } from './schemas.ts';
import {
  validateProgram, maskForScanning, extractFromJoinTargets, type SqlProfileViolation,
} from './sqlProfile.ts';
import { bindStatementParams, type BoundValue, type ParamTypeSchema } from './paramBinding.ts';

/**
 * Compiles a validated relational program into preparable DuckDB statements.
 *
 * No DuckDB object is ever created for a plugin's own named statements —
 * every `relation`/`output` statement becomes a CTE in one merged
 * `WITH ... SELECT * FROM <target>` query, computed fresh per request. This
 * is deliberate: it means there is nothing to namespace, collide or clean up
 * in DuckDB's shared catalog, which is a stronger isolation property than
 * "we remembered to DROP it afterwards" would have been. The one thing that
 * *is* a real, pre-existing DuckDB object is an artifact's own logical
 * relation view (`{log.events}` etc.) — those are read-only references the
 * host created when the artifact was mounted, never something this module
 * writes to.
 *
 * A statement's body may itself contain a `WITH` clause; nesting `WITH`
 * inside a CTE's parenthesised body is standard SQL, so merging never has to
 * parse or split an inner `WITH` — it only has to wrap each statement's
 * original text in `name AS ( ... )`.
 */

export interface CompileOptions {
  /** Resolves an input artifact's physical logical-table key to the DuckDB view name backing it. Owned by the caller (the worker), which is the only place that actually knows physical names. */
  physicalTableOf: (artifactId: string, physicalLogicalKey: string) => string;
  /** The action's declared parameter schema, keyed by parameter name. */
  declaredParams: Record<string, ParamTypeSchema>;
}

export interface CompiledStatement {
  name: string;
  kind: 'relation' | 'output';
  /** `WITH ... SELECT * FROM <name>`, `?`-parameterised and ready for `conn.prepare()`. */
  sql: string;
  values: BoundValue[];
}

export interface CompiledProgram {
  statements: CompiledStatement[];
}

export class RelationalCompileError extends Error {
  readonly violations: SqlProfileViolation[];
  constructor(message: string, violations: SqlProfileViolation[] = []) {
    super(message);
    this.violations = violations;
  }
}

/** `{role.relation}` -> physical DuckDB view name, for every input binding's declared logical relations. */
function buildInputPlaceholders(
  inputs: RelationalInputBinding[],
  physicalTableOf: CompileOptions['physicalTableOf']
): Map<string, string> {
  const map = new Map<string, string>();
  for (const input of inputs) {
    const schema = schemaFor(input.artifactType);
    if (!schema) {
      throw new RelationalCompileError(`no logical schema registered for artifact type "${input.artifactType}"`);
    }
    const physicalKeys = PHYSICAL_LOGICAL_NAME[input.artifactType] ?? {};
    for (const relation of schema.relations) {
      const physicalKey = physicalKeys[relation.name];
      if (!physicalKey) continue;
      map.set(`${input.role}.${relation.name}`, physicalTableOf(input.artifactId, physicalKey));
    }
  }
  return map;
}

/**
 * Bare FROM/JOIN targets that name another program statement — the
 * dependency edges of the compile DAG. Uses the same masked-text scan
 * `sqlProfile.ts` validates against, so a mention inside a comment or string
 * literal is not mistaken for a real reference here either.
 */
function referencedStatementNames(sql: string, known: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const t of extractFromJoinTargets(maskForScanning(sql))) {
    if (!t.braced && known.has(t.raw)) found.add(t.raw);
  }
  return found;
}

/** Transitive closure of statements `target` depends on, in a valid dependency order (deps before dependents). Does not include `target` itself. */
function transitiveDeps(target: string, byName: Map<string, RelationalStatement>): string[] {
  const known = new Set(byName.keys());
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const stmt = byName.get(name);
    if (!stmt) return;
    for (const dep of referencedStatementNames(stmt.sql, known)) {
      if (dep !== name) visit(dep);
    }
    order.push(name);
  };
  const targetStmt = byName.get(target);
  if (!targetStmt) throw new RelationalCompileError(`unknown statement "${target}"`);
  for (const dep of referencedStatementNames(targetStmt.sql, known)) visit(dep);
  return order;
}

/**
 * Resolves every `{role.relation}` in one statement's body to its physical
 * DuckDB view name. A bare prior-statement reference needs no resolution at
 * all — once wrapped in `name AS ( ... )` it is already a valid CTE name in
 * scope, so this only ever touches the dotted, braced form.
 */
function resolveRefs(sql: string, placeholders: ReadonlyMap<string, string>): string {
  return sql.replace(/\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (_all, token: string) => {
    const physical = placeholders.get(token);
    if (!physical) throw new RelationalCompileError(`"{${token}}" does not resolve to a bound input relation`);
    return physical;
  });
}

function compileTarget(
  targetName: string,
  byName: Map<string, RelationalStatement>,
  placeholders: ReadonlyMap<string, string>
): string {
  const deps = transitiveDeps(targetName, byName);
  const ctes = [...deps, targetName].map((name) => {
    const stmt = byName.get(name)!;
    return `${name} AS (\n${resolveRefs(stmt.sql, placeholders)}\n)`;
  });
  return `WITH ${ctes.join(',\n')}\nSELECT * FROM ${targetName}`;
}

/**
 * Validates and compiles a program against a set of input bindings.
 *
 * Returns one `CompiledStatement` per `output` statement (always) plus one
 * per name in `requestedRelations` (only on request — most executions need
 * nothing beyond their declared outputs).
 */
export function compileProgram(
  program: RelationalProgram,
  inputs: RelationalInputBinding[],
  params: Record<string, unknown>,
  requestedRelations: string[] | undefined,
  options: CompileOptions
): CompiledProgram {
  const inputPlaceholders = buildInputPlaceholders(inputs, options.physicalTableOf);

  const violations = validateProgram(program, new Set(inputPlaceholders.keys()));
  if (violations.length) {
    throw new RelationalCompileError(
      `relational program failed SQL Profile v1 validation:\n` +
      violations.map((v) => `  [${v.statement}] ${v.message}`).join('\n'),
      violations
    );
  }

  const byName = new Map(program.statements.map((s) => [s.name, s] as const));
  const targets = [
    ...program.statements.filter((s) => s.kind === 'output').map((s) => s.name),
    ...(requestedRelations ?? []),
  ];
  const seenTargets = new Set<string>();

  const compiled: CompiledStatement[] = [];
  for (const name of targets) {
    if (seenTargets.has(name)) continue; // a relation may be both an output dependency and explicitly requested
    seenTargets.add(name);
    const stmt = byName.get(name);
    if (!stmt) throw new RelationalCompileError(`requested relation "${name}" is not declared in this program`);

    const merged = compileTarget(name, byName, inputPlaceholders);
    const { sql, values } = bindStatementParams(merged, params, options.declaredParams);
    compiled.push({ name, kind: stmt.kind, sql, values });
  }

  return { statements: compiled };
}
