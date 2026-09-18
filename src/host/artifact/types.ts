/**
 * The artifact model.
 *
 * An artifact is a named, typed, addressable piece of data with a recorded
 * origin. It is deliberately NOT the data itself: an open artifact is a
 * storage reference plus metadata, never its contents on the JS heap.
 */

import type { TransformPlan } from '../transform/types';

/** Stable identifier. Content-addressed where the content is deterministic. */
export type ArtifactId = string;
export type ArtifactTypeId = string;
export type ActionId = string;

/**
 * Artifact types are registered, never hard-coded into a union.
 *
 * Types contributed by plugins must stay registered even after the plugin is
 * gone, otherwise an artifact of that type would vanish from the tree or
 * become silently unusable. Removal downgrades an artifact to
 * `providerMissing`, which the UI shows explicitly.
 */
export interface ArtifactTypeDef {
  id: ArtifactTypeId;
  /** Shown in the tree and the type chip, e.g. "OCEL 2.0", "OC-PN". */
  label: string;
  shortLabel: string;
  /** Which plugin contributed the type; `core` for built-ins. */
  provider: string;
  /** Whether the defining plugin is currently installed. */
  providerInstalled: boolean;
  /** Optional JSON Schema describing this type's `meta` payload. */
  metaSchema?: unknown;
  /**
   * Broad visual family — log, model, or result — so the tree can color by
   * "kind of thing" instead of by exact type. A dozen exact-type colors
   * carries no meaning a viewer can hold in their head; three families do.
   * Missing (a plugin-contributed type that never set one) falls back to
   * 'result', the generic bucket.
   */
  family?: 'log' | 'model' | 'result';
}

export type StorageRef =
  | { kind: 'parquet'; files: Record<string, string> } // logical table -> OPFS path
  | { kind: 'json'; path: string }
  | { kind: 'inline'; value: unknown } // small artifacts: models, markings
  /**
   * A derived log: a query plan over another artifact, not a copy.
   *
   * An imported log's tables are already DuckDB views over Parquet, so a
   * transformed log is one more view in the same chain and costs no storage at
   * all. Materialising it — writing the result back out as Parquet — is a
   * separate, explicit step, needed when a chain gets deep enough that
   * re-executing it on every query is the wrong trade.
   */
  | { kind: 'view'; plan: TransformPlan; tables: string[] };

/**
 * Provenance is a DAG, not a parent pointer.
 *
 * Multi-input and multi-output are first class:
 *   Inductive Miner: TraditionalEventLog -> ProcessTree + AcceptingPetriNet
 *   Alignment:       EventLog + AcceptingPetriNet -> AlignmentSet
 *
 * Each execution is one node; the artifacts it consumed and produced are its
 * edges. Nested `host.produce()` calls append nodes here rather than hiding
 * inside a call stack.
 */
export interface ActionExecution {
  id: string;
  actionId: ActionId;
  actionVersion: string;
  /** Role name -> artifact ids, so multi-input signatures stay legible. */
  inputs: Record<string, ArtifactId[]>;
  outputs: ArtifactId[];
  params: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  /**
   * End-to-end benchmark breakdown captured for this concrete execution.
   *
   * `durationMs` remains the one comparable wall-clock number.  The phases
   * explain it without making a renderer know whether the action happened to
   * be SQL, WASM, or Python.
   */
  timing?: ExecutionTiming;
  /**
   * The execution environment, recorded because two runtimes are two failure
   * surfaces: `pyodide 0.28` and `CPython 3.12` can differ in floating point
   * and iteration order, and a result is not reproducible without knowing
   * which produced it.
   */
  runtime: { kind: 'wasm' | 'pyodide' | 'native' | 'core' | 'relational' | 'compute'; version: string };
  /** Set when this execution was triggered by another action, not the user. */
  parentExecutionId?: string;
  /**
   * Relational executions only. `relationalApiVersion` is the Promenade
   * Relational API version the action's program targets (today: `"1"`) —
   * the contract that stays fixed if `runtime.version` (the DuckDB-Wasm
   * build) changes. `programDigest` identifies the exact program text that
   * ran, so two executions of the same action can be told apart even when
   * neither `actionVersion` nor `params` differ (a packaged `.sql` file was
   * edited without bumping the plugin version).
   */
  relationalApiVersion?: string;
  programDigest?: string;
}

export interface ExecutionTimingPhase {
  /** Stable machine-readable key, e.g. `pyodide-load` or `compute`. */
  id: string;
  /** User-facing phase name. */
  label: string;
  durationMs: number;
  /** A phase may be a cache hit rather than newly performed work. */
  cached?: boolean;
  /** Small reproducibility facts, such as which packages were installed. */
  detail?: string;
}

export interface ExecutionTiming {
  /** The measured click-to-persist wall-clock time. */
  totalMs: number;
  /** `cold` means a runtime or its dependencies were brought up in this run. */
  cacheState: 'cold' | 'warm' | 'mixed';
  phases: ExecutionTimingPhase[];
}

export interface Artifact {
  id: ArtifactId;
  name: string;
  type: ArtifactTypeId;
  createdAt: string;
  storage: StorageRef;

  /** Type-specific summary: counts, time range, activity list. */
  meta: Record<string, unknown>;

  /**
   * Null for imported artifacts (roots of the DAG). Otherwise the execution
   * that produced it - which is also what the inspector re-runs live when a
   * parameter changes.
   */
  producedBy: string | null;

  /** Denormalised for cheap tree rendering; authoritative edges live on the execution. */
  inputs: ArtifactId[];

  /** Set when the artifact's type or producing plugin is no longer installed. */
  providerMissing?: boolean;

  /**
   * Set when an ancestor was recomputed after this artifact — its own
   * result still reflects the ancestor's *previous* output. Recompute is
   * not automatic: a chain several actions deep would otherwise re-run
   * every expensive stage on every keystroke of the topmost slider. The
   * user re-runs a stale artifact explicitly, one step at a time.
   */
  stale?: boolean;

  /**
   * Why the artifact could not be made queryable this session — a derived log
   * whose source was deleted, for instance. It stays in the tree with the
   * reason shown rather than disappearing, because silently dropping an
   * artifact is worse than showing a broken one.
   */
  unavailable?: string;

  /**
   * Where this artifact's canonical storage currently lives. Absent (or
   * `'local'`) means the usual OPFS/inline storage above is authoritative.
   * A remote pointer means `storage` was evicted (its `value`/`files`
   * emptied) after "Move to Promenade Compute" relocated the data —
   * "Move to Browser" is the inverse, and clears this back to undefined.
   * Set and read only by `host/compute/relocate.ts`; nothing else needs to
   * know an artifact isn't local (view rendering and `payloadOf` don't
   * change) since Stage 1 relocation only ever touches inline artifacts,
   * never anything a running action reads through `ctx.sql`.
   */
  location?: { engineId: string; remoteId: string };
}

/** Format-level semantics, kept out of the generic data model on purpose. */
export interface XESSemantics {
  extensions: Array<{ name: string; prefix: string; uri: string }>;
  classifiers: Array<{ name: string; scope: string; keys: string }>;
  globals: Record<string, Array<{ key: string; type: string; value: string }>>;
  logAttrs: Array<{ key: string; type: string; value: string }>;
}

export interface OCEL2Semantics {
  objectTypes: Array<{ name: string; attributes: Array<{ name: string; type: string }> }>;
  eventTypes: Array<{ name: string; attributes: Array<{ name: string; type: string }> }>;
  sourceFormat: 'json' | 'sqlite' | 'xml';
}

/** The DAG, materialised for the provenance panel and for cycle detection. */
export interface ProvenanceGraph {
  artifacts: Record<ArtifactId, Artifact>;
  executions: Record<string, ActionExecution>;
}

export function ancestorsOf(g: ProvenanceGraph, id: ArtifactId): Set<ArtifactId> {
  const seen = new Set<ArtifactId>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const parent of g.artifacts[cur]?.inputs ?? []) {
      if (!seen.has(parent)) { seen.add(parent); stack.push(parent); }
    }
  }
  return seen;
}

/**
 * The other direction from `ancestorsOf`: every artifact that names `id`,
 * directly or transitively, among its `inputs`. Deleting an artifact has to
 * walk this way, not that one — an artifact derived from a deleted one is
 * not left standing on its own, it is left pointing at nothing.
 */
export function descendantsOf(g: ProvenanceGraph, id: ArtifactId): Set<ArtifactId> {
  const seen = new Set<ArtifactId>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const a of Object.values(g.artifacts)) {
      if (seen.has(a.id) || a.id === id) continue;
      if (a.inputs?.includes(cur)) { seen.add(a.id); queue.push(a.id); }
    }
  }
  return seen;
}

/**
 * The single artifact to nest `a` under in a display (tree, breadcrumb,
 * provenance diagram) — a different question from "what did the execution
 * actually consume" (that's `inputs`/`ancestorsOf`/`descendantsOf`, and
 * stays untouched: a notebook-published artifact's `inputs[0]` genuinely is
 * the log its code queried, which SQL table resolution elsewhere still
 * relies on).
 *
 * An artifact published from inside a Python Notebook or Script cell
 * (`promenade.publish()`/`publish_event_log()`/`publish_ocel()`) records the
 * producing Notebook/Script artifact's id on its execution
 * (`execution.params.notebook.id`, see `host/notebook/publish.ts`'s
 * `buildExecution()`). That is a truer "where does this belong" than
 * `inputs[0]` — the bound log is a data source the code happened to read,
 * not what the user would look for it under; two notebooks run against the
 * same log would otherwise dump all their outputs as siblings under that
 * log with no way to tell which notebook made which.
 */
export function displayParentId(g: ProvenanceGraph, a: Artifact): ArtifactId | undefined {
  const exec = a.producedBy ? g.executions[a.producedBy] : undefined;
  const params = exec?.params as { notebook?: { id?: unknown } } | undefined;
  const notebookId = params?.notebook?.id;
  if (typeof notebookId === 'string' && notebookId !== a.id && g.artifacts[notebookId]) {
    return notebookId;
  }
  return a.inputs?.[0];
}

/**
 * Guards `host.produce()` against a plugin asking for something that depends
 * on its own output. Nesting goes through the artifact graph, so a cycle here
 * is a real cycle, not a recursion depth accident.
 */
export function wouldCycle(
  g: ProvenanceGraph, output: ArtifactId, inputs: ArtifactId[]
): boolean {
  if (inputs.includes(output)) return true;
  return inputs.some((i) => i === output || ancestorsOf(g, i).has(output));
}
