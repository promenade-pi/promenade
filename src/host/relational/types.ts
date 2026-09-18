/**
 * The Promenade Relational API — the stable contract between a plugin/action
 * and tabular artifact data.
 *
 * This is the abstraction boundary the rest of `host/relational/` exists to
 * protect: a `relational` action's context exposes only these types, never a
 * DuckDB connection, an OPFS path or a Parquet filename. Everything below
 * this layer (`sqlProfile`, `compileProgram`, the worker's `relational`
 * command) is free to change — including replacing DuckDB entirely — without
 * moving anything declared here.
 *
 * Internal imports in this directory use explicit `.ts` extensions so the
 * pure-logic modules (schemas, sqlProfile, paramBinding, compileProgram) can
 * be exercised directly by `node` in `app/test/relational/`, the same way
 * `spike/test` runs against plain source with no build step. Vite/esbuild
 * resolve the same imports without any extra configuration.
 */

/** One column of a logical relation. Types are the DuckDB-portable subset a plugin may rely on. */
export interface LogicalColumn {
  name: string;
  type: 'bigint' | 'integer' | 'varchar' | 'timestamp' | 'double' | 'boolean';
  /** Whether every row of a well-formed artifact carries a non-null value. */
  required: boolean;
  description: string;
}

/** One logical relation an artifact type exposes, e.g. `TraditionalEventLog.event`. */
export interface LogicalRelation {
  name: string;
  columns: LogicalColumn[];
  description: string;
}

/** The full logical schema of one artifact type, versioned independently of storage. */
export interface LogicalSchema {
  artifactType: string;
  /** Bumped when a relation's columns change in a way a plugin's SQL could observe. */
  schemaVersion: string;
  relations: LogicalRelation[];
}

/** A declared input to a relational execution: a role name bound to one artifact. */
export interface RelationalInputBinding {
  /** The role a program's SQL refers to it by, e.g. `log` in `{log.events}`. */
  role: string;
  artifactId: string;
  artifactType: string;
}

/**
 * One named statement in a relational program.
 *
 * `relation` statements are named intermediate results — addressable by later
 * statements in the same program via `{name}`, and optionally returned to the
 * caller without being promoted to a Promenade Artifact. `output` statements
 * are the program's final, named results; an action's manifest maps these to
 * typed Artifact outputs.
 */
export interface RelationalStatement {
  name: string;
  kind: 'relation' | 'output';
  /** SQL Profile v1 text. May reference `{role.logical}` (an input), an earlier statement by its bare name (`FROM priorRelation`, like any CTE), and `:param` placeholders. */
  sql: string;
}

/** A parsed, ordered relational program — the compiled form of a plugin's `.sql` package file. */
export interface RelationalProgram {
  statements: RelationalStatement[];
}

/** A declared parameter's value, already validated against the action's manifest schema. */
export type ParamValue = string | number | boolean | string[] | number[] | null;

export interface RelationalExecutionRequest {
  /** Logical namespace per role, e.g. `{ log: artifact-123 }`. */
  inputs: RelationalInputBinding[];
  params: Record<string, ParamValue>;
  program: RelationalProgram;
  /**
   * Which named relations to materialise and return, beyond the program's
   * `output` statements. Absent means "outputs only" — most executions never
   * need an intermediate relation, and fetching one costs an Arrow round trip.
   */
  requestedRelations?: string[];
  /** Caps how many rows come back for a requested (non-output) relation, for inspection/debugging. */
  relationRowLimit?: number;
}

export interface RelationalRelationStats {
  name: string;
  rowCount: number;
}

export interface RelationalExecutionResult {
  /** Arrow IPC bytes per `output` statement name. */
  outputs: Record<string, Uint8Array>;
  /** Arrow IPC bytes per requested intermediate relation name. */
  relations: Record<string, Uint8Array>;
  stats: {
    outputs: RelationalRelationStats[];
    relations: RelationalRelationStats[];
    compileMs: number;
    executeMs: number;
  };
  /** Identifies the backend that ran this program, recorded into provenance. */
  backend: { kind: string; version: string };
}
