/**
 * Action signature and registry types.
 *
 * Shaped directly by the Milestone 0 measurements. On aoe2 (2.37M events), a
 * naive re-run with a changed threshold costs 8.06 s, while the same threshold
 * change against a cached parameter-independent aggregate costs 2.5-9.4 ms.
 * A single `run()` therefore cannot deliver the live loop on object-centric
 * logs of realistic size, and the split is expressed in the API rather than
 * left to each plugin author to rediscover.
 */

import type { Artifact, ArtifactId, ArtifactTypeId, ExecutionTimingPhase } from '../artifact/types';

/** JSON Schema subset the host renders native controls from. */
export interface ParamSchema {
  type: 'object';
  properties: Record<string, ParamProperty>;
  required?: string[];
}

/**
 * Where a parameter's options come from.
 *
 * A static `enum` cannot express "pick an event type from this log" — the
 * values only exist once a log is imported, and aoe2 has 829 of them. Rather
 * than push such parameters into plugin-rendered UI, the schema declares a
 * query and the host renders the control.
 *
 * That keeps the properties a plugin-side picker would have to reinvent and
 * would get inconsistent anyway: shared colors from the color registry,
 * participation in the selection bus, one keyboard and theming behavior, and
 * a control that can sit in the inspector column and drive live recompute.
 */
export interface OptionSource {
  /** SQL run by the host. `{event}`, `{object}` … expand to table names. */
  sql: string;
  /** Column holding the value. Default: "value". */
  valueField?: string;
  /** Column holding the label. Default: same as valueField. */
  labelField?: string;
  /** Optional column with a frequency, shown beside each option. */
  countField?: string;
  /** Color registry domain, so options look the same as in every panel. */
  colorDomain?: 'objectType' | 'activity' | 'qualifier';
}

/**
 * When a parameter is shown at all.
 *
 * Some parameters are meaningless for the artifact in hand rather than merely
 * inapplicable in value: a metro map mined from a Petri net has no per-arc
 * counts, so its "edge labels" choice can never do anything; a noise
 * threshold means nothing unless the miner variant is the one that uses it.
 * Rendering such a control and explaining why it does nothing is worse than
 * not rendering it — the user is invited to act on something that cannot
 * work (`onlyFor` already does this for the coarser case of artifact *type*).
 *
 * Conditions are deliberately a tiny declarative form rather than an
 * expression language: a manifest is untrusted input, so anything evaluated
 * is attack surface and a compatibility burden. A condition names exactly
 * one source and one comparator.
 *
 *   { param: 'minerVariant', equals: 'IMf' }
 *   { artifactMeta: 'basis', equals: 'directlyFollows' }
 *   { artifactMeta: 'basis', oneOf: ['directlyFollows', 'hybrid'] }
 *
 * `param` reads another parameter's current value; `artifactMeta` reads the
 * input/viewed artifact's `meta`, which is where an action records small
 * facts about what it produced.
 */
export interface ParamCondition {
  /** Read another parameter's current value. Mutually exclusive with `artifactMeta`. */
  param?: string;
  /** Read a key from the input/viewed artifact's `meta`. */
  artifactMeta?: string;
  equals?: unknown;
  notEquals?: unknown;
  oneOf?: unknown[];
}

export interface ParamProperty {
  /**
   * `'file'` is the one variant that isn't ordinary structured data: the
   * host reads the user-picked file's text and passes it as this param's
   * plain string value — never a handle, never binary, matching every
   * other param here being something `structuredClone`/JSON can carry
   * as-is. It exists so a plugin action can manufacture a brand-new
   * artifact from a local file (an import) entirely through the ordinary
   * action/param system, instead of a new format needing a hand-written
   * branch in the host's own file-drop handler the way XES/PNML/OCEL do
   * today.
   */
  type: 'number' | 'integer' | 'string' | 'boolean' | 'array' | 'file';
  /** `type: 'file'` only: the file input's `accept` filter, e.g. ".bpmn,.xml". */
  accept?: string;
  title?: string;
  /** Alternative label when the source artifact is an OCEL log. */
  objectCentricTitle?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  /** Step for slider rendering; absent means the host picks one. */
  multipleOf?: number;
  /** Static choices, known at manifest time. */
  enum?: unknown[];
  /**
   * Display labels for `enum`, positionally.
   *
   * An enum value is an identifier the plugin's own code branches on, and the
   * good ones read badly in a dropdown: `workingTogether`, `IMf`, `pearson`.
   * Without this the control has to choose between a readable menu and a sane
   * wire value, and plugins were picking the identifier and living with the
   * menu. A label shorter or longer than the enum is ignored rather than
   * partially applied — a half-labelled dropdown is worse than an unlabelled
   * one, because it reads as if the unlabelled entries were different in kind.
   */
  enumLabels?: string[];
  /** Data-bound choices, resolved by the host against the input artifact. */
  optionsFrom?: OptionSource;
  /** Render this data-bound parameter only for these input artifact types. */
  onlyFor?: ArtifactTypeId[];
  /**
   * Render this parameter only while every listed condition holds (a single
   * condition may be given unwrapped). An unmet condition hides the control
   * entirely — it does not clear the stored value, so a parameter reappears
   * with what it had when its condition becomes true again.
   */
  showWhen?: ParamCondition | ParamCondition[];
  /** Use the first data-bound option when this view/action has no saved value. */
  defaultFromOptions?: 'first';
  /**
   * A host-owned compound control.  These are intentionally a small named
   * set, rather than arbitrary plugin UI: the control still lives in the
   * Inspector, uses the artifact metadata the host already has, and persists
   * through the normal one-parameter change path.
   */
  control?: 'timeRange' | 'timeRangeEnd';
  /** The companion end parameter for a `timeRange` control. */
  rangeEnd?: string;
  items?: ParamProperty;
  /**
   * Marks the parameter that identifies this result at a glance. Exactly one
   * per action may be primary; the host puts it in the tab title
   * ("OCPN v3 · θ 0.08").
   */
  primary?: boolean;
  /**
   * Declares that changing this parameter does NOT invalidate the expensive
   * stage. These are the parameters that can be driven at interactive rates;
   * the host may debounce them far more aggressively.
   */
  cheap?: boolean;
  /**
   * Caps this slider's effective maximum at the input artifact's own
   * `meta[key]` when that is smaller than `maximum` — for a count that is a
   * safety ceiling rather than a real choice (an event limit, say), the
   * schema's `maximum` has to be big enough for the largest log the host
   * ever sees, which makes it a meaningless upper bound on a smaller one.
   * `optionArtifact` is the artifact this is resolved against; see
   * `ParamControls.tsx`.
   */
  maxFrom?: string;
}

/**
 * What an action tells an *agent* about itself, beyond what the UI needs.
 *
 * The Inspector needs a label; an agent needs to know what the action is for,
 * when it is the wrong choice, and what a sensible call looks like. A plugin
 * is the only place that knowledge exists, so it is declared in the manifest
 * and carried here — see docs/promenade-agent-api.md.
 *
 * This is deliberately *descriptive data attached to a host-owned tool*, not
 * a plugin-defined tool: the wording comes from a package the host does not
 * vet, so it is passed on labeled as such, and it can never widen what an
 * agent is allowed to do. Every field is capped at install time, because
 * unbounded prose from a package is both a cost in the caller's context and
 * an injection surface.
 */
export interface AgentNotes {
  /** When this action is the right choice. */
  whenToUse?: string;
  /** When it is not — the limitation an agent would otherwise have to learn by running it. */
  notFor?: string;
  /** Short, concrete call sketches, e.g. "noiseThreshold 0.2 for a first look at a noisy log". */
  examples?: string[];
}

export interface InputSlot {
  /** Role name, e.g. "log", "model". Keys into ActionExecution.inputs. */
  name: string;
  type: ArtifactTypeId;
  required: boolean;
  /** Shown when the slot is unfilled: "also select an AcceptingPetriNet". */
  label: string;
  /**
   * Properties the artifact must actually have, beyond being of the right type.
   *
   * The type says what a thing is; a capability says what is in it. An
   * organizational miner declaring only `TraditionalEventLog` is offered for a
   * log without a single resource value and returns nothing — applicable by
   * type, useless in fact. Declaring `requires: ['event.resource']` makes the
   * host answer that before the user clicks.
   *
   * This is also how a plugin stays format-agnostic without pretending every
   * log is the same: it asks for the property, not for the format. A CSV import
   * with a resource column satisfies `event.resource` exactly as an XES log
   * with `org:resource` does — and a plugin that genuinely needs XES's own
   * declarations asks for `xes.semantics` instead of sniffing the source.
   */
  requires?: string[];
}

/**
 * What `run`/`finalize` hands back to the executor.
 *
 * Three shapes an action's result can take in this codebase: `inline` — a
 * small computed blob (a mined model, a DFG, an alignment set) the executor
 * wraps into an artifact itself, the same way every existing action's
 * hand-written commit code already does; `persisted` — an artifact an
 * action *had* to build itself because it involves physical storage the
 * executor has no business constructing generically (a materialized log —
 * see `ctx.persistLog`); or `exported` — a file leaving the app entirely,
 * for a `def.exportsFile` action (see `ExportedFile` in `executeAction.ts`),
 * never wrapped into an artifact at all. Exactly one is set.
 */
export interface ActionOutcome {
  inline?: {
    value: unknown;
    /** Seeds `colorRegistry`'s `activity` domain, when present. */
    activities?: string[];
    /** Seeds `colorRegistry`'s `objectType` domain, when present. */
    objectTypes?: string[];
    stats?: Record<string, unknown>;
  };
  persisted?: Artifact;
  exported?: { bytes: Uint8Array | string; filename: string; mime: string };
  /** Execution environment label recorded into provenance, e.g. "promenade-dfg 0.1.0". */
  runtimeVersion?: string;
  /** Relational actions only: threaded onto `ActionExecution.programDigest`/`.relationalApiVersion`. */
  programDigest?: string;
  relationalApiVersion?: string;
  /**
   * Runtime-provided benchmark phases. The executor adds host overhead and
   * catalog persistence, then records the complete timeline on provenance.
   */
  benchmark?: {
    phases: ExecutionTimingPhase[];
    cacheState?: 'cold' | 'warm' | 'mixed';
  };
}

export interface ActionContext {
  /** Mandatory. The host debounces and discards superseded runs. */
  signal: AbortSignal;
  /**
   * Reports progress. `data`, when present, is a structured frame batch
   * forwarded to a live-preview view of this action's output type while the
   * run is still going (see `liveRun`); the pyodide bridge JSON-serialises it.
   */
  progress: (fraction: number, message?: string, data?: unknown) => void;
  log: (message: string) => void;
  /**
   * The only data door. Plugins never touch OPFS and never deserialise an
   * artifact; a plugin that iterates over events is written wrong. Keeping
   * this the sole access path is also what lets the same plugin run later
   * against a native DuckDB over IPC.
   */
  sql: (query: string) => Promise<import('apache-arrow').Table>;
  /**
   * Nested execution goes through the artifact graph, never through a direct
   * call to another plugin. The host resolves (by output type, against the
   * given inputs — see `ActionRegistry.applicableTo`), executes, and records
   * a provenance node with this call's own execution as `parentExecutionId`.
   * A direct call would be invisible work: not cacheable, not cancellable,
   * not reproducible.
   */
  produce: (
    type: ArtifactTypeId,
    inputs: Record<string, ArtifactId[]>,
    params: Record<string, unknown>,
    /** Exact producer when more than one action emits `type`. */
    producerId?: ActionId
  ) => Promise<ArtifactId>;
  /**
   * Materializes a log-shaped output as a real, physically-stored, queryable
   * artifact — the one thing an action cannot build through `sql()` alone,
   * because a query result is Arrow data, not a DuckDB object another
   * action's generic table scan can point at.
   *
   * `type` must be a registered logical-schema type (`TraditionalEventLog` /
   * `ObjectCentricEventLog` today — see `host/relational/schemas.ts`). The
   * log itself arrives one of two ways, and exactly one must be given:
   *
   * - `programSource` — a SQL Profile v1 program declaring one `-- @output
   *   <relation>` statement per logical relation of `type`'s schema that this
   *   call wants populated. This is how a `relational` action produces a log
   *   *derived* from logs the workspace already has; relations with no
   *   matching output are simply absent from the result, the same as an XES
   *   import having no `object` table.
   * - `rows` — the log's columns, keyed by logical relation and column name
   *   (`{ events: { event_idx, trace_idx, activity, ts, … }, cases: { … } }`),
   *   for an action whose output is not a selection over anything: a
   *   simulator playing a model out into traces has no source log to query,
   *   and nothing it emits could be written as SQL over its input. The host
   *   validates every column against the logical schema and writes the
   *   storage itself (`host/artifact/log-rows.ts`), so a package can put rows
   *   into the catalog but never storage of its own devising. Timestamps are
   *   epoch microseconds.
   *
   * This is generic infrastructure, not any one plugin's: both forms are
   * reached by manifest declaration alone (`runtimeAdapters.ts`), so any
   * installed action whose declared output type has a logical schema can use
   * them.
   */
  persistLog: (opts: {
    type: ArtifactTypeId;
    name: string;
    /** A SQL Profile v1 program. Mutually exclusive with `rows`. */
    programSource?: string;
    /** Logical relation -> column -> values. Mutually exclusive with `programSource`. */
    rows?: Record<string, Record<string, ArrayLike<unknown>>>;
    inputs: Record<string, ArtifactId[]>;
    /** Overrides the enclosing `run()` call's own params for this program's
     * `:name` bindings — for a caller that has to resolve one before binding
     * it (an empty picker selection into its real value; see
     * `host/plugins/runtimeAdapters.ts`'s `relationalActionRuntime`).
     * Defaults to the same params `run()` itself was called with. */
    params?: Record<string, unknown>;
    /**
     * A producer's own facts about what it generated (the seed it used, how
     * many cases deadlocked), merged over the summary the host computes from
     * the written tables — the same space `showWhen` conditions and
     * downstream actions already read artifact facts from.
     */
    meta?: Record<string, unknown>;
  }) => Promise<Artifact>;
  /**
   * Set only when the user picked a Promenade Compute engine from the
   * "Run on" control (`Inspector.tsx`) instead of the default browser
   * runtime. `wasmActionRuntime` (`host/plugins/runtimeAdapters.ts`) is the
   * only reader: an action whose manifest declares no `compute.wasi` build
   * ignores this and runs in-browser as always, so setting it never breaks
   * a plugin that hasn't opted in.
   */
  compute?: { engineId: string; endpoint: string };
}

export interface OutputSpec {
  name: string;
  type: ArtifactTypeId;
}

/**
 * One implementation per action: `run(inputs, params, ctx)`.
 *
 * There is deliberately no separate host-level "expensive prepare, cheap
 * finalize" split here, even though a live parameter control needs exactly
 * that distinction for some actions. That caching already has an owner
 * closer to the actual cost: `WasmPluginRunner`/the wasm worker cache the
 * scan stage internally, keyed by their own `prepareKey`, and `run` is
 * called on every parameter change regardless — cheap when the cache hits,
 * expensive when it doesn't, exactly the behavior a two-stage host-level
 * contract would have added a second, redundant caching layer on top of. An
 * action whose own runtime has nothing like that (a plain SQL query, a
 * cheap relational program) simply repeats the full — and already cheap —
 * work on every call. `ParamProperty.cheap` still drives the UI's debounce
 * timing independently of any of this.
 */
export interface ActionDef {
  id: string;
  label: string;
  version: string;
  provider: string;
  /** Distinguishes first-party from third-party in the action list, before the click. */
  trusted: boolean;
  runtime: 'core' | 'wasm' | 'pyodide' | 'relational';
  inputs: InputSlot[];
  outputs: OutputSpec[];
  params: ParamSchema;

  /** Declared resource appetite; `high` keeps the host from relocating it. */
  memory?: 'low' | 'medium' | 'high';

  /**
   * One or two sentences on what this action does, from its own author.
   *
   * Distinct from `label`, which is a button caption. Surfaced to agents by
   * `promenade_list_actions` and as the tooltip on the Inspector's action row.
   */
  description?: string;
  /** Agent-facing notes; see `AgentNotes`. */
  agent?: AgentNotes;

  /**
   * Whether an implementation is actually wired up. Declared-but-unimplemented
   * actions stay visible so the applicability rules and inspector layout are
   * exercised against the real vocabulary rather than a single example.
   */
  implemented?: boolean;

  /**
   * Set when the action opens a view instead of producing an artifact.
   * Keeps "show me this" out of the provenance DAG, which records computation,
   * not what the user happened to look at.
   */
  opensView?: string;

  /**
   * Set when the action downloads a file instead of producing an artifact —
   * `run`/`finalize` returns `ActionOutcome.exported`, and `executeAction`
   * hands that straight back with no artifact, execution, or provenance
   * node at all (stronger than `opensView`'s exclusion: there is nothing on
   * either side of this for the DAG to record). Declares no `outputs` — an
   * export has no artifact type, so `producersOf()` naturally never
   * resolves one as a `produce()` target. Surfaced only in the artifact
   * tree's per-artifact "Export" submenu (`exportActionsFor` in
   * `registry.ts`), never in the Inspector's "Available actions" list.
   */
  exportsFile?: boolean;

  /**
   * Not offered as a standalone entry in the Inspector's "Available
   * actions" list — only reachable via `ActionContext.produce()`, or (for
   * an installed action) as another action's own `scans` prerequisite (see
   * `host/plugins/manifest.ts`). Registration is otherwise unaffected:
   * `producersOf()`/`produce()` still see it, since it still has a real
   * `run`. For an action that exists purely to feed a later stage and is
   * confusing or unsafe to run standalone (a log projection whose case-id
   * encoding a later wasm scan depends on, say).
   */
  internal?: boolean;

  /**
   * Runs the action. Called on the initial invocation and again, with new
   * `params`, on every live parameter change — an action whose runtime has
   * its own expensive-stage cache (wasm's scan, notably) stays fast on the
   * hot path for exactly that reason, not because this function is called
   * any differently.
   */
  run?: (
    inputs: Record<string, ArtifactId[]>,
    params: Record<string, unknown>,
    ctx: ActionContext
  ) => Promise<ActionOutcome>;

  /**
   * The prerequisite this action produces and scans for itself, from the
   * manifest's `scans`/`scanAction` (see `host/plugins/manifest.ts`).
   *
   * Carried here purely so registry-driven UI can *describe* it. The
   * mechanism is unchanged and still lives in the runtime adapter: a
   * declaring action is offered wherever its own `inputs` say, and produces
   * the intermediate itself. Without this, such an action was indistinguishable
   * from a single-step one in the gallery — "Discover metro map" quietly mined
   * an Object-Centric Petri Net on the way and said nothing about it, while an
   * identical chain the *host* planned announced itself as two steps. Two
   * mechanisms are fine; two different stories told to the user about the same
   * thing are not.
   */
  scans?: ArtifactTypeId;
  /** The exact producer for `scans`, when its output type has several. */
  scanAction?: string;

  /**
   * Set (by `store.ts`'s `registerPlugin`) when this is a `wasm` action whose
   * manifest declares a `compute.wasi` build — the only signal the
   * Inspector's "Run on" control (`Inspector.tsx`) needs to decide whether to
   * offer a Promenade Compute engine at all for this action.
   */
  computeEligible?: boolean;
}

/** Applicability, including the partially-satisfied case the UI must express. */
export interface Applicability {
  action: ActionDef;
  applicable: boolean;
  /** Slots still needing a selection, e.g. "also select an AcceptingPetriNet". */
  missing: InputSlot[];
  /**
   * Slots whose artifact is of the right type but lacks a required property.
   *
   * Kept apart from `missing` because the two ask different things of the
   * user: one is "select something else as well", the other is "this log
   * cannot serve this action" — and no amount of selecting fixes the second.
   */
  unmet: Array<{ slot: InputSlot; capabilities: string[] }>;
}

/**
 * A run that a newer request replaced before it finished.
 *
 * Not a failure: the host deliberately supersedes an in-flight run whenever a
 * newer one starts — a slider drag does it many times a second — and the newer
 * run is the one whose result the user is waiting for. `executeAction` turns
 * this into a `null` result, which is the "nothing to report" signal every
 * caller already handles.
 *
 * It exists as a type rather than a message so callers never have to match on
 * prose. Before it did, a superseded run raised an ordinary `Error`, every
 * caller treated it as a real one, and a fast drag left a permanent
 * "superseded by a newer request" banner on screen describing a run nobody had
 * asked about — while the run that *was* asked about had already succeeded.
 */
export class SupersededError extends Error {
  constructor(actionId: string) {
    super(`action ${actionId}: superseded by a newer request`);
    this.name = 'SupersededError';
  }
}
