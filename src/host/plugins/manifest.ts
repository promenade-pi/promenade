import type { AgentNotes, ParamSchema, InputSlot, OutputSpec } from '../actions/types';
import type { ArtifactTypeId } from '../artifact/types';
// Extensioned on purpose: `host/relational/` is written to be importable
// directly by `node` (see its own header comments), which needs every hop
// in the chain — including this one — to resolve without a bundler.
import { parseProgram, validateProgram } from '../relational/sqlProfile.ts';
import { schemaFor } from '../relational/schemas.ts';
import { HOST_VALIDATED_TYPES } from '../artifact/publish-artifact.ts';

/**
 * Plugin package manifest.
 *
 * A `.pmplugin` is a plain zip with `manifest.json` at the root. Everything a
 * plugin contributes is *declared* here as data — artifact types, actions with
 * their parameter schemas, views. Installing a plugin therefore never executes
 * plugin code: the host reads the manifest, stores the files, and registers
 * what was declared. Code runs only when an action is invoked or a panel opens.
 */
export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  /** Legacy single-author field; `authors` is preferred. */
  author?: string;
  license?: string;
  description?: string;

  /**
   * Academic metadata.
   *
   * This is a research tool: a plugin is often the artifact of a paper.
   * Affiliation and a citation are therefore first-class manifest fields,
   * not README prose the host cannot show anywhere useful.
   */
  authors?: Array<{
    name: string;
    email?: string;
    affiliation?: string;
    orcid?: string;
  }>;
  /** How the author wants the plugin cited. */
  citation?: {
    text?: string;
    doi?: string;
    bibtex?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  keywords?: string[];

  /** Markdown shown when the plugin is selected. Defaults to README.md. */
  readme?: string;
  /** Further pages, typically under docs/. Images beside them are resolved. */
  docs?: Array<{ path: string; title: string }>;

  /**
   * `view` is a plugin that contributes only views — no actions, no kernel.
   *
   * It exists because a viewer and a producer should be separable: the
   * agreement is with the artifact *type*, not between the two plugins. A
   * view-only package has no manifest-level entry; each view names its own
   * script inside the package.
   *
   * `relational` is a plugin whose actions are Promenade Relational Programs
   * (SQL Profile v1 text) rather than compiled WASM or Python. It never
   * receives a DuckDB connection, an OPFS path or a physical table name —
   * see `host/relational/`. `apiVersion` is required for this runtime and is
   * the contract a relational action targets, independent of which backend
   * (today: DuckDB-Wasm) actually executes it.
   */
  /**
   * Package-wide default runtime. Optional the moment every action declares
   * its own `runtime` (see `actions[].runtime`) — required only as the
   * fallback for an action that does not. A single-runtime package (still
   * the common case, and every existing plugin) declares this once here
   * instead of repeating it per action; a package mixing runtimes (e.g. a
   * `relational` action projecting a log, feeding a `wasm` action that mines
   * it) either sets this to whichever runtime most of its actions share, or
   * omits it and has every action self-declare.
   */
  runtime?: 'wasm' | 'pyodide' | 'view' | 'relational';
  /** Relational only: the Promenade Relational API version this package's queries target. Currently only `"1"`. Per-action `apiVersion` overrides this. */
  apiVersion?: string;
  /** WASM: the JS glue. Pyodide: the .py module defining prepare/finalize. Package-wide default; a per-action `entry` overrides it. */
  entry?: string;
  /** WASM module inside the package. Package-wide default; a per-action `wasm` overrides it. */
  wasm?: string;
  /**
   * Promenade Compute: a second prebuilt binary for the same kernel, built
   * for `wasm32-wasip1` instead of `wasm32-unknown-unknown` — no wasm-bindgen
   * glue, driven by the engine's Wasmtime host directly (see
   * `compute/engine`). Optional: a `wasm` runtime action with no `compute`
   * block simply has no "Run on: Promenade Compute" option. Package-wide
   * default; a per-action `compute` overrides it.
   */
  compute?: { wasi?: string };
  /**
   * Pyodide only: the dependency closure, resolved by the host rather than pip.
   *
   * Installation runs with `deps=False`, because resolving a package's declared
   * metadata aborts on binary dependencies that are never actually loaded —
   * pm4py declares cvxopt, which has no wasm wheel and which pm4py runs fine
   * without. The cost of getting past that is that the package must name what
   * it needs. A stdlib-only plugin declares `[]` — the field is required on
   * every pyodide manifest, but its closure is allowed to be empty.
   */
  pythonDeps?: string[];

  artifactTypes?: Array<{
    id: ArtifactTypeId;
    label: string;
    shortLabel: string;
    /**
     * Broad visual family — the tree colours by this (`familyColorOf`, see
     * `host/artifact/registry.ts`).
     *
     * Optional, but worth declaring: the fallback is `result`, so without it
     * *every* plugin-contributed type is the same green, and a package that
     * contributes both a designed thing and an outcome (a questionnaire and
     * its responses, say) cannot tell them apart in the tree at all.
     */
    family?: 'log' | 'model' | 'result';
  }>;
  actions?: Array<{
    id: string;
    label: string;
    /**
     * One or two sentences on what this action does and produces.
     *
     * `label` is a button caption ("Alpha Miner (Classic)"); this is the
     * sentence that tells a reader — a person hovering the action row, or an
     * agent reading `promenade_list_actions` — what it is for. Optional, and
     * capped: see `AGENT_TEXT_LIMITS`.
     */
    description?: string;
    /**
     * Agent-facing notes: when to use this action, when not, example calls.
     * See `AgentNotes` and docs/promenade-agent-api.md.
     */
    agent?: AgentNotes;
    /**
     * Overrides the package-wide `runtime` for this one action — the
     * mechanism that lets a single package mix runtimes, e.g. a `relational`
     * projection action feeding a `wasm` mining action. Required if the
     * manifest declares no package-wide `runtime`; otherwise inherited.
     */
    runtime?: 'wasm' | 'pyodide' | 'relational';
    /** Overrides the package-wide `entry` for this action (`wasm`/`pyodide` only). */
    entry?: string;
    /** Overrides the package-wide `wasm` module for this action (`wasm` only). */
    wasm?: string;
    /** Overrides the package-wide `compute` block for this action (`wasm` only). */
    compute?: { wasi?: string };
    /** Overrides the package-wide `kernel` config for this action (`wasm` only). */
    kernel?: NonNullable<PluginManifest['kernel']>;
    /** Overrides the package-wide `apiVersion` for this action (`relational` only). */
    apiVersion?: string;
    /**
     * Pyodide: selects `prepare_<x>` / `finalize_<x>` in the module.
     *
     * This is what lets one package ship several actions — the Inductive Miner
     * ships discovery and a conversion — without the module inventing its own
     * dispatch, and without the host loading it twice.
     */
    entryPoint?: string;
    memory?: 'low' | 'medium' | 'high';
    /**
     * Not offered as a standalone, user-clickable action — only reachable
     * as another action's own `scans` prerequisite (see below) or via
     * `ActionContext.produce()`. For an action that exists purely to feed a
     * later stage (a log projection a wasm miner scans, say) and is
     * confusing or unsafe to run standalone against an unrelated input of
     * the same declared type — see `scans` — rather than something a
     * plugin author has to hide by convention. Still fully registered:
     * `produce()`'s own resolution (`actionRegistry.all()`) is unaffected,
     * only the Inspector's "Available actions" list filters it out.
     */
    internal?: boolean;
    /**
     * For an action whose real scan target differs from what the user
     * selects: this action's `inputs[0]` is what the user picks, but before
     * scanning, the host first produces (`ActionContext.produce()`,
     * resolved by type — see its own docs for the ambiguity this assumes
     * away) an artifact of this type FROM that selection, and scans that
     * instead. Lets "Discover OCPN" be selected directly on an
     * `ObjectCentricEventLog` while the actual wasm kernel scans the
     * `TraditionalEventLog` a separate, `internal` relational action
     * projects — one click, no user-visible intermediate action, and no
     * risk of the intermediate action being run standalone against an
     * unrelated log of the same type (which its own case-id encoding would
     * silently decode wrong). `wasm`/`pyodide` runtimes only.
     */
    scans?: ArtifactTypeId;
    /** Exact internal producer to use for `scans` when its output type is shared. */
    scanAction?: ActionId;
    /**
     * Set when this action downloads a file instead of producing an
     * artifact — its `run`/wasm `finalize` returns
     * `{exported: {bytes, filename, mime}}`. Declares no `outputs` (there is
     * no artifact type for a download); surfaced only in the artifact
     * tree's per-artifact "Export" submenu, never the Inspector's "Available
     * actions" list. See `ActionDef.exportsFile` in `host/actions/types.ts`.
     */
    exportsFile?: boolean;
    /**
     * Set when this action makes a new artifact out of nothing — no input
     * artifact, and no file to read one from. A generator of synthetic
     * models is the case: it has only its own parameters, and there is
     * nothing in the workspace it could be "applied to".
     *
     * Declared rather than inferred, because `inputs: []` on its own is far
     * more often a forgotten `inputs` than a deliberate generator, and the
     * two are indistinguishable from the outside. An action that reads a
     * `file` param (an importer) already says so by having one and needs
     * nothing here.
     *
     * The host surfaces such an action in the artifact tree's "New" menu
     * alongside standalone authoring views (`App.tsx`'s `standaloneActions`,
     * `RunActionDialog`), which is where something that creates rather than
     * transforms belongs.
     */
    standalone?: boolean;
    /** Generic model-side preparation requested before a WASM action runs. */
    modelTransform?: 'lifecycle';
    inputs: InputSlot[];
    outputs: OutputSpec[];
    params: ParamSchema;
    /**
     * Relational runtime only: the SQL Profile v1 program powering this
     * action, inline. An action producing a log-shaped artifact (see
     * `ActionContext.persistLog`) names its `-- @output` statements after
     * the output type's own logical relations — the public relational-API
     * vocabulary (`events`, `cases`, …; see `host/relational/schemas.ts`),
     * not the short physical names (`event`, `trace`) storage happens to use
     * internally. An action producing any other typed output maps
     * `-- @output` names to `outputs[].name` instead (see
     * `host/relational/engine.ts` and the reference action in
     * `host/actions/core-actions.ts`).
     */
    query?: string;
    /** Relational runtime only: alternative to `query` — a `.sql` file inside the package. Validated for presence only at install time; its SQL Profile compliance is checked on first execution. */
    queryFile?: string;
  }>;
  views?: Array<{
    id: string;
    label: string;
    kind?: 'native' | 'sandboxed';
    /** For `kind: "native"`: the host view this artifact type should use. */
    native?: string;
    /** For `kind: "sandboxed"`: the script inside the package. */
    entry?: string;
    appliesTo?: ArtifactTypeId[];
    params?: ParamSchema;
    /**
     * The view draws its own controls for `params` — a slider rail glued to
     * the diagram it filters, say — so the Inspector shows a pointer to the
     * panel instead of a second copy of the same controls. The params are
     * still host-owned state: they arrive through the `params` event and the
     * view writes them back with `promenade.setParams()`.
     */
    ownsControls?: boolean;
    /**
     * Opt in to the source-bound interaction-selection bridge. `interaction-
     * cohort-v1` supplies exact Atlas lasso cohorts only; the view decides how
     * their event/object membership maps to its own semantics.
     */
    interactionSelection?: 'interaction-cohort-v1';
    /** See `ViewDef.primary` (`host/views/registry.ts`) — this view stands
     * in as the artifact type's default rather than one choice among
     * several. At most one view per manifest should set this. */
    primary?: boolean;
    /**
     * Opt in to the run-bound live preview: when an action whose output type
     * this view `appliesTo` starts, the host opens a panel bound to the
     * pending run and streams the action's progress into it, swapping to the
     * real artifact when the run finishes. Sandboxed (`entry`) views only.
     *
     * Two channels, and a view should handle whichever its producers offer:
     * `liveFrame` carries the structured `ctx.progress` *data* an action may
     * emit (enough to reconstruct the pending result as it is built), and
     * `liveRunState` carries the coarse fraction/message every runtime
     * reports (enough for a standby animation, and all a wasm kernel — one
     * opaque call — can give). Runtime-agnostic on purpose: the declaration
     * is about an artifact type, not about how it happens to be computed.
     */
    livePreview?: boolean;
    /**
     * A panel that is not about an artifact (see `ViewDef.standalone`) — an
     * authoring surface, opened from the workspace's "New" affordance rather
     * than by selecting something. Declares no `appliesTo`: there is nothing
     * to apply to before the artifact it creates exists. Sandboxed (`entry`)
     * views only.
     */
    standalone?: boolean;
    /**
     * Artifact types this view may write via `promenade.publishLog()` — the
     * declaration that entitles a sandboxed authoring view to put a new
     * artifact in the catalog. Log-shaped types only (they are the ones
     * with a physical relation layout the host knows how to materialize);
     * the host validates the rows themselves either way.
     */
    publishes?: ArtifactTypeId[];
    /**
     * Opt in to reading the bound artifact's *stored files* —
     * `promenade.files()` and `promenade.openFile()`. A raw storage inspector
     * needs the file list itself, which no amount of SQL can produce: the
     * catalog's relations and what is on disk are different lists, and the
     * difference (a sidecar, an orphaned Parquet file, a materialized JSON
     * payload) is exactly what such a view exists to show.
     *
     * Declared rather than allowlisted for the same reason `publishes` is:
     * what entitles a frame is its own manifest, confirmed at install and
     * readable in the plugin manager, so the next plugin that needs this does
     * not need a change in the host. It widens nothing about *which* artifact
     * a frame can read — only the bound one, the same one `sql()` already
     * queries — and files are read-only either way.
     */
    readsFiles?: boolean;
    /**
     * Opt in to `promenade.deriveLog()` — proposing repair operations onto a
     * derived log of the source this view's artifact came from. See
     * `ViewDef.derivesLogs`; the host resolves the target, so this widens what
     * a view may *propose*, never what it may address.
     */
    derivesLogs?: boolean;
    /**
     * Opt in to reading the *workspace* — `promenade.workspace()` and the
     * `workspace` event, which report the open panels and the parameters
     * each one is currently showing.
     *
     * A panel cannot otherwise know that anything else is on screen, which
     * is fine for a view that draws one artifact and nothing else, and
     * impossible for a view whose whole job is about the other panels: a
     * questionnaire that asks "now filter the log to the three commonest
     * activities" has to be able to see whether the participant did.
     *
     * What crosses is ids, labels and view parameters — never artifact
     * contents, which stay behind `sql()` exactly as before. Read-only:
     * changing another panel still goes through `openView()`, which the
     * host has always been free to refuse.
     */
    readsWorkspace?: boolean;
    /**
     * Where this view prefers to open: as a column on that side of whatever
     * is on screen, rather than as a tab in the active group.
     *
     * A preference, not geometry — the host places it, and ignores this when
     * there is nothing to sit beside. It exists because "a tab in the active
     * group" is the wrong default for a panel whose whole purpose is to be
     * looked at *next to* something else: a questionnaire covering the
     * visualisation it is asking about is worse than useless, and the user
     * should not have to drag it into place every time.
     */
    dock?: 'left' | 'right';
  }>;

  /**
   * Artifact types this package can render or consume. Advisory metadata for
   * the plugin manager and the registry — the binding authority stays
   * `views[].appliesTo` and `actions[].inputs`.
   */
  consumes?: ArtifactTypeId[];

  /**
   * Other packages that pair well with this one. A hint, never a dependency:
   * the Inductive Miner recommends a process tree viewer and works without it,
   * and that viewer works with any other producer of the same type.
   */
  recommends?: Array<{ id: string; reason?: string }>;

  /** WASM only: which kernel class the worker drives, and how it is fed. */
  kernel?: {
    class: string;
    abi?: string;
    /**
     * How the event stream is ordered before it reaches the kernel.
     *
     * The default is `timestamp` — order by `(trace_idx, ts, event_idx)` and
     * skip events without a timestamp — which is what the first three kernels
     * were written against and what they keep.
     *
     * `log` orders by `(trace_idx, event_idx)` alone: the order the events were
     * recorded in. Algorithms whose reference implementation reads a log
     * sequentially need this, and it is the only option that works at all on a
     * log with no timestamps. The choice is not cosmetic — on a log whose
     * timestamps disagree with its recorded order, the two produce different
     * models — so it is declared per plugin rather than guessed. `timestampNullsLast`
     * matches the relational DFG reference exactly: dated events first, then
     * timestamp-less events, both with import order as the tie-breaker.
     */
    scan?: {
      order?: 'timestamp' | 'timestampNullsLast' | 'log';
      /**
       * Emit one synthetic row (activity `-1`) per case that has no surviving
       * events, so the kernel can see that the case exists.
       *
       * Off by default because most algorithms have nothing to say about an
       * empty trace, and a kernel that indexes an array by the activity id
       * would have to learn about `-1` first. The Inductive Miner needs it: an
       * empty trace is what tells it a block is optional.
       */
      includeEmptyTraces?: boolean;
      /**
       * How surviving activities are numbered: `frequency` (default,
       * most-frequent-first) or `firstAppearance` (order of first occurrence in
       * the log). The activity *limit* keeps the most frequent either way.
       *
       * This matters wherever an algorithm has to break a tie and falls back on
       * the activity id — the Inductive Miner does, in three places — because
       * then the numbering is part of the behavior, not an internal detail.
       */
      activityIds?: 'frequency' | 'firstAppearance';
      /**
       * `activityLifecycle` turns each log event into a lifecycle-specific
       * classifier value (`activity + U+001F + enqueue|start|complete`).
       * Missing/unknown lifecycle values are treated as `complete`, matching
       * the XES convention used by the lifecycle-expanded IVM model.
       */
      classifier?: 'activity' | 'activityLifecycle';
      /**
       * Also hand the kernel a dictionary-encoded `org:resource` column, as a
       * fourth `pushChunk` argument, with the names delivered up front by
       * `setResourceNames()`. Events with no resource carry `-1`.
       *
       * Off by default: the extra column costs a join and a transfer on every
       * chunk, and only an algorithm with an organizational perspective — the
       * Fuzzy Miner's originator correlation — has any use for it.
       */
      resource?: boolean;
    };
  };
}

/**
 * Artifact types a view may declare in `views[].publishes`. Log-shaped and
 * host-materialized: the row-to-storage conversion lives in
 * `host/artifact/publish-log.ts`, so a type only becomes publishable once
 * that module knows how to encode it — not merely once someone declares it.
 */
export const PUBLISHABLE_TYPES: ArtifactTypeId[] = ['ObjectCentricEventLog'];

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
}

type ManifestAction = NonNullable<PluginManifest['actions']>[number];

/**
 * Resolves what an action actually runs under: its own `runtime` override,
 * or the package-wide default. `undefined` means neither was declared — a
 * `validateManifest` error, never installed. The single place this
 * inheritance rule lives; `store.ts` and `runner.ts` call this instead of
 * re-deriving it.
 */
export function runtimeOf(m: PluginManifest, a: ManifestAction): 'wasm' | 'pyodide' | 'relational' | undefined {
  return a.runtime ?? (m.runtime === 'view' ? undefined : m.runtime);
}

/**
 * Human-readable package runtime metadata. Packages may assign runtimes per
 * action instead of declaring one package-wide default, so callers that show
 * package details must not read `m.runtime` directly.
 */
/**
 * Display labels for a set of actions, disambiguated where two collide.
 *
 * A package that offers one capability for two kinds of log declares two
 * actions under one label — Log Quality's `analyze-xes` / `analyze-ocel` is the
 * canonical case, and it is the right manifest: the host picks between them by
 * input type, and a user who has selected a log only ever sees the one that
 * applies. It is only a *list* of everything a package contributes that shows
 * both at once, where two identical rows read as a packaging mistake.
 *
 * The qualifier is the short label of whatever actually distinguishes them —
 * their input type first, their output type if the inputs match — so the pair
 * above reads "Analyze Log Quality (XES)" and "Analyze Log Quality (OCEL 2.0)".
 * Renaming the actions in the manifest would be the wrong fix: the label is
 * correct, and every other surface shows it unambiguously already.
 *
 * Nothing is appended when the labels do not collide, and nothing is invented
 * when no type tells them apart — a meaningless suffix is worse than a repeat.
 */
export function actionDisplayLabels(
  actions: Array<{
    id: string;
    label: string;
    inputs?: Array<{ type?: string }>;
    outputs?: Array<{ type?: string }>;
  }>,
  shortLabelOf: (typeId: string) => string | undefined
): Map<string, string> {
  const labels = new Map<string, string>();
  const byLabel = new Map<string, typeof actions>();
  for (const action of actions) {
    labels.set(action.id, action.label);
    const group = byLabel.get(action.label);
    if (group) group.push(action);
    else byLabel.set(action.label, [action]);
  }

  for (const [label, group] of byLabel) {
    if (group.length < 2) continue;
    // Inputs first: what an action consumes is what the user is choosing
    // between, and it is what the host itself dispatches on.
    for (const pick of [
      (a: (typeof actions)[number]) => a.inputs?.[0]?.type,
      (a: (typeof actions)[number]) => a.outputs?.[0]?.type,
    ]) {
      const qualifiers = group.map((a) => {
        const type = pick(a);
        return type ? shortLabelOf(type) : undefined;
      });
      const usable = qualifiers.every((q) => !!q) && new Set(qualifiers).size === group.length;
      if (!usable) continue;
      group.forEach((a, i) => labels.set(a.id, `${label} (${qualifiers[i]})`));
      break;
    }
  }
  return labels;
}

export function runtimeLabel(m: PluginManifest): string | undefined {
  if (m.runtime) return m.runtime;
  const runtimes = new Set((m.actions ?? []).map((a) => runtimeOf(m, a)).filter(Boolean));
  return [...runtimes].join(' + ') || undefined;
}
export function entryOf(m: PluginManifest, a: ManifestAction): string | undefined {
  return a.entry ?? m.entry;
}
export function wasmOf(m: PluginManifest, a: ManifestAction): string | undefined {
  return a.wasm ?? m.wasm;
}
export function computeWasiOf(m: PluginManifest, a: ManifestAction): string | undefined {
  return a.compute?.wasi ?? m.compute?.wasi;
}
export function kernelOf(m: PluginManifest, a: ManifestAction): PluginManifest['kernel'] | undefined {
  return a.kernel ?? m.kernel;
}
export function apiVersionOf(m: PluginManifest, a: ManifestAction): string | undefined {
  return a.apiVersion ?? m.apiVersion;
}

/**
 * Validates one relational action's declaration and, when the program is
 * given inline (`query`, as opposed to `queryFile`), its SQL Profile v1
 * compliance — before a single byte reaches OPFS. A `queryFile` program is
 * checked for presence only here; its contents are validated by the worker
 * on first execution, the one point the check cannot be bypassed (see
 * `worker/data-worker.ts`'s `relational` command).
 *
 * `action.outputs` (typed Artifacts) and the program's `-- @output` names
 * (relations) are deliberately NOT required to correspond 1:1 in general. A
 * single Artifact is routinely built from several named relations that don't
 * share the output's own name — the reference DFG action combines
 * `activities`/`edges`/`starts`/`statistics` into one `DFG` artifact — and
 * that combination is host TS code, not something a manifest can usefully
 * declare without a full relation-to-field mapping DSL.
 *
 * One bounded exception: an action whose declared output type has a
 * registered logical schema (`TraditionalEventLog`, `ObjectCentricEventLog`)
 * is understood to produce that log directly via `ActionContext.persistLog`
 * — for that case, `-- @output` names ARE the mapping, one per logical
 * relation the schema declares (`events`, `cases`, …; see
 * `host/relational/schemas.ts` — the public relational-API names, not the
 * short physical ones storage uses internally) that the program wants
 * populated. No custom
 * builder is needed or possible for this case, which is what makes it
 * available to an installed (non-core) plugin at all.
 */
function validateRelationalAction(
  pluginId: string,
  a: NonNullable<PluginManifest['actions']>[number],
  files: Set<string>
): string[] {
  const errors: string[] = [];
  if (!a.query && !a.queryFile) {
    errors.push(`action ${a.id}: relational runtime needs "query" or "queryFile"`);
    return errors;
  }
  if (a.query && a.queryFile) {
    errors.push(`action ${a.id}: declare either "query" or "queryFile", not both`);
  }
  if (a.queryFile && !files.has(a.queryFile)) {
    errors.push(`action ${a.id}: queryFile not in package: ${a.queryFile}`);
  }
  if (!a.query) return errors;

  let program;
  try {
    program = parseProgram(a.query);
  } catch (e: any) {
    errors.push(`action ${a.id}: ${e.message}`);
    return errors;
  }

  const inputPlaceholders = new Set<string>();
  for (const slot of a.inputs ?? []) {
    for (const name of schemaFor(slot.type)?.relations.map((r) => r.name) ?? []) {
      inputPlaceholders.add(`${slot.name}.${name}`);
    }
  }
  for (const v of validateProgram(program, inputPlaceholders)) {
    errors.push(`action ${a.id}: [${v.statement}] ${v.message}`);
  }
  return errors;
}

/**
 * Caps on the free text a package may put in front of an agent.
 *
 * Not arbitrary tidiness: this text is written by a package the host does not
 * vet and is forwarded into a caller's context. Bounded fields keep a plugin
 * from spending someone else's context window, and keep "description" from
 * quietly becoming a place to smuggle instructions at length. A manifest that
 * exceeds them is rejected at install, so the author sees it rather than
 * discovering silent truncation later.
 */
export const AGENT_TEXT_LIMITS = {
  description: 600,
  whenToUse: 400,
  notFor: 400,
  examples: 5,
  example: 200,
} as const;

function validateAgentText(
  where: string, a: { description?: unknown; agent?: unknown },
): string[] {
  const errors: string[] = [];
  const str = (value: unknown, field: string, max: number) => {
    if (value === undefined) return;
    if (typeof value !== 'string') { errors.push(`${where}: "${field}" must be a string`); return; }
    if (value.length > max) {
      errors.push(`${where}: "${field}" is ${value.length} characters; the limit is ${max}`);
    }
  };

  str(a.description, 'description', AGENT_TEXT_LIMITS.description);
  if (a.agent === undefined) return errors;
  if (typeof a.agent !== 'object' || a.agent === null || Array.isArray(a.agent)) {
    errors.push(`${where}: "agent" must be an object`);
    return errors;
  }
  const agent = a.agent as AgentNotes & Record<string, unknown>;
  str(agent.whenToUse, 'agent.whenToUse', AGENT_TEXT_LIMITS.whenToUse);
  str(agent.notFor, 'agent.notFor', AGENT_TEXT_LIMITS.notFor);
  const unknown = Object.keys(agent).filter((k) => !['whenToUse', 'notFor', 'examples'].includes(k));
  if (unknown.length) {
    // Refused rather than ignored: a misspelled key is a note the author
    // believes they shipped and an agent will never see.
    errors.push(`${where}: unknown "agent" field(s): ${unknown.join(', ')}`);
  }
  if (agent.examples !== undefined) {
    if (!Array.isArray(agent.examples)) {
      errors.push(`${where}: "agent.examples" must be an array of strings`);
    } else {
      if (agent.examples.length > AGENT_TEXT_LIMITS.examples) {
        errors.push(`${where}: "agent.examples" has ${agent.examples.length} entries; the limit is ${AGENT_TEXT_LIMITS.examples}`);
      }
      agent.examples.forEach((e, i) => str(e, `agent.examples[${i}]`, AGENT_TEXT_LIMITS.example));
    }
  }
  return errors;
}

/**
 * Validates a manifest before anything is stored or registered.
 *
 * Rejecting early matters more than it looks: a half-registered plugin leaves
 * artifact types and actions pointing at files that were never written.
 */
export function validateManifest(raw: unknown, files: Set<string>): ValidationResult {
  const errors: string[] = [];
  const m = raw as PluginManifest;

  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (m.manifestVersion !== 1) errors.push(`unsupported manifestVersion: ${m.manifestVersion}`);
  if (!m.id || !/^[a-z0-9][a-z0-9.\-]*$/i.test(m.id)) errors.push('missing or invalid id');
  if (!m.name) errors.push('missing name');
  if (!m.version) errors.push('missing version');
  if (m.runtime !== undefined
      && m.runtime !== 'wasm' && m.runtime !== 'pyodide'
      && m.runtime !== 'view' && m.runtime !== 'relational') {
    errors.push(`unsupported runtime: ${m.runtime}`);
  }

  if (m.runtime === 'view') {
    // A view-only package has no single entry and declares no actions at
    // all — a package that also computes something needs a real runtime for
    // that action, declared on the action itself (see `runtimeOf`), not
    // "view" at the package level.
    if (m.entry) errors.push('view runtime: manifest-level entry is not used');
    if (!m.views?.length) errors.push('view runtime: no views declared');
    if (m.actions?.length) {
      errors.push('view runtime: actions need their own wasm/pyodide/relational runtime — set "runtime" per action, or drop the package-level "view"');
    }
  } else {
    if (!m.actions?.length) errors.push('no actions declared');
    for (const a of m.actions ?? []) {
      if (!runtimeOf(m, a)) {
        errors.push(`action ${a.id}: no runtime — declare a package-wide "runtime", or "runtime" on the action itself`);
      }
    }
    // A manifest-level `entry` is the fallback `entryOf()` hands to any wasm
    // or pyodide action that names none of its own. Relational actions never
    // read it. Declaring one a package has no use for is a copy-paste from
    // another manifest, not a harmless extra: the author believes some file
    // is being loaded, and nothing ever loads it.
    //
    // The test is per-package rather than per-runtime on purpose — a package
    // mixing a `relational` action with a `pyodide` one legitimately keeps
    // its script at the manifest level, so "relational package with an entry"
    // is not by itself the mistake.
    if (m.entry && !(m.actions ?? []).some((a) => {
      const rt = runtimeOf(m, a);
      return rt === 'wasm' || rt === 'pyodide';
    })) {
      errors.push('manifest-level entry is not used: no wasm or pyodide action can load it');
    }
  }


/**
 * `showWhen` is a contract, so a broken one is refused at install rather than
 * silently ignored at render — a condition that never holds would hide a
 * control with no way for the author to tell.
 */
function validateShowWhen(where: string, params: ParamSchema | undefined): string[] {
  const errors: string[] = [];
  const props = params?.properties ?? {};
  for (const [key, p] of Object.entries(props)) {
    if (!p.showWhen) continue;
    const conds = Array.isArray(p.showWhen) ? p.showWhen : [p.showWhen];
    if (!conds.length) errors.push(`${where}: parameter "${key}" has an empty showWhen`);
    for (const c of conds) {
      if (!c || typeof c !== 'object') {
        errors.push(`${where}: parameter "${key}" has a showWhen entry that is not an object`);
        continue;
      }
      const sources = ['param', 'artifactMeta'].filter((k) => typeof (c as any)[k] === 'string');
      if (sources.length !== 1) {
        errors.push(`${where}: parameter "${key}" showWhen must name exactly one of "param" or "artifactMeta"`);
      }
      const comparators = ['equals', 'notEquals', 'oneOf'].filter((k) => (c as any)[k] !== undefined);
      if (comparators.length !== 1) {
        errors.push(`${where}: parameter "${key}" showWhen needs exactly one of "equals", "notEquals" or "oneOf"`);
      }
      if (c.oneOf !== undefined && !Array.isArray(c.oneOf)) {
        errors.push(`${where}: parameter "${key}" showWhen "oneOf" must be an array`);
      }
      // A typo'd parameter name would just never match, hiding the control
      // for good; catching it here is the whole point of validating.
      if (typeof c.param === 'string') {
        if (!(c.param in props)) errors.push(`${where}: parameter "${key}" showWhen references unknown parameter "${c.param}"`);
        else if (c.param === key) errors.push(`${where}: parameter "${key}" showWhen refers to itself`);
      }
    }
  }
  return errors;
}

  for (const a of m.actions ?? []) {
    if (!a.id?.startsWith(m.id)) {
      // Namespacing keeps two plugins from claiming the same action id.
      errors.push(`action id must be namespaced under "${m.id}": ${a.id}`);
    }
    errors.push(...validateAgentText(`action ${a.id}`, a));
    if (!a.params || a.params.type !== 'object') {
      errors.push(`action ${a.id}: params must be a JSON Schema object`);
    }
    // A manufacturing action legitimately has no artifact inputs at all:
    // its own data comes from a `file` param instead (an import action), or
    // it makes something out of nothing and says so (`standalone`, e.g. a
    // generator of synthetic models). The check still catches the ordinary
    // mistake of forgetting `inputs`, which is what an action with neither
    // is far more likely to be.
    const hasFileParam = Object.values(a.params?.properties ?? {}).some((p) => p.type === 'file');
    if (!a.inputs?.length && !hasFileParam && !a.standalone) {
      errors.push(
        `action ${a.id}: no inputs declared — add "standalone": true if it genuinely makes an artifact from nothing`
      );
    }
    let primaries = 0;
    for (const p of Object.values(a.params?.properties ?? {})) if (p.primary) primaries++;
    if (primaries > 1) errors.push(`action ${a.id}: more than one primary parameter`);
    errors.push(...validateShowWhen(`action ${a.id}`, a.params));

    const rt = runtimeOf(m, a);
    if (rt === 'wasm') {
      const entry = entryOf(m, a);
      const wasm = wasmOf(m, a);
      const kernel = kernelOf(m, a);
      if (!entry) errors.push(`action ${a.id}: wasm runtime needs "entry" (on the action, or the package)`);
      else if (!files.has(entry)) errors.push(`action ${a.id}: entry not in package: ${entry}`);
      if (!wasm) errors.push(`action ${a.id}: wasm runtime needs "wasm" (on the action, or the package)`);
      else if (!files.has(wasm)) errors.push(`action ${a.id}: wasm module not in package: ${wasm}`);
      if (!kernel?.class) errors.push(`action ${a.id}: wasm runtime needs a kernel class (on the action, or the package)`);
    } else if (rt === 'pyodide') {
      const entry = entryOf(m, a);
      if (!entry) errors.push(`action ${a.id}: pyodide runtime needs "entry" (on the action, or the package)`);
      else if (!files.has(entry)) errors.push(`action ${a.id}: entry not in package: ${entry}`);
      else if (!entry.endsWith('.py')) errors.push(`action ${a.id}: pyodide entry must be a .py module, got ${entry}`);
      // Not fatal to check here since it's package-wide either way, but
      // reported per action so a mixed-runtime package's error points at
      // the action that actually needs it. An explicit empty array is a
      // valid declaration: the closure is stdlib-only. Omitting the field
      // is the error — "not declared" must not read the same as "no deps".
      if (!Array.isArray(m.pythonDeps)) {
        errors.push(`action ${a.id}: pyodide runtime needs "pythonDeps" listing the dependency closure (use [] for a stdlib-only plugin)`);
      }
    } else if (rt === 'relational') {
      const apiVersion = apiVersionOf(m, a);
      if (apiVersion !== '1') errors.push(`action ${a.id}: unsupported apiVersion: ${apiVersion}`);
      errors.push(...validateRelationalAction(m.id, a, files));
    }
  }

  const FAMILIES = ['log', 'model', 'result'];
  for (const t of m.artifactTypes ?? []) {
    if (t.family !== undefined && !FAMILIES.includes(t.family)) {
      errors.push(`artifact type ${t.id}: unknown family "${t.family}" — one of ${FAMILIES.join(', ')}`);
    }
  }

  for (const v of m.views ?? []) {
    if (!v.id?.startsWith(m.id)) {
      errors.push(`view id must be namespaced under "${m.id}": ${v.id}`);
    }
    // A sandboxed view's script must be in the package. Without this the view
    // registers and then fails to load at the moment a panel opens, which is
    // the worst possible time to find out.
    if (v.kind !== 'native' && v.entry && !files.has(v.entry)) {
      errors.push(`view ${v.id}: entry not in package: ${v.entry}`);
    }
    if (v.kind === 'native' && !v.native) {
      errors.push(`view ${v.id}: kind "native" needs a native view id`);
    }
    if (v.kind !== 'native' && !v.entry && !v.native) {
      errors.push(`view ${v.id}: neither an entry nor a native view`);
    }
    if (v.interactionSelection !== undefined && v.interactionSelection !== 'interaction-cohort-v1') {
      errors.push(`view ${v.id}: unsupported interactionSelection protocol: ${v.interactionSelection}`);
    }
    if (v.livePreview && (v.kind === 'native' || !v.entry)) {
      errors.push(`view ${v.id}: livePreview needs a sandboxed entry`);
    }
    if (v.livePreview && !v.appliesTo?.length) {
      errors.push(`view ${v.id}: livePreview needs "appliesTo" to match against an action's output`);
    }
    if (v.standalone && (v.kind === 'native' || !v.entry)) {
      errors.push(`view ${v.id}: a standalone view needs a sandboxed entry`);
    }
    if (v.readsFiles && (v.kind === 'native' || !v.entry)) {
      errors.push(`view ${v.id}: readsFiles needs a sandboxed entry`);
    }
    if (v.readsWorkspace && (v.kind === 'native' || !v.entry)) {
      errors.push(`view ${v.id}: readsWorkspace needs a sandboxed entry`);
    }
    // A standalone panel has no artifact, so there is no directory to read —
    // the declaration could only ever resolve to nothing.
    if (v.readsFiles && v.standalone) {
      errors.push(`view ${v.id}: a standalone view has no artifact, so it cannot declare "readsFiles"`);
    }
    // Declaring both would be a contradiction, not a wider net: a panel
    // either renders a selected artifact or it doesn't have one.
    if (v.standalone && v.appliesTo?.length) {
      errors.push(`view ${v.id}: a standalone view has no artifact, so it cannot declare "appliesTo"`);
    }
    for (const type of v.publishes ?? []) {
      // Two ways a type is publishable, and they answer different questions.
      //
      // A log-shaped type is publishable because the *host* knows how to
      // turn rows into storage for it (`publish-log.ts`) — which is why that
      // list is closed and short.
      //
      // A type the package declares itself is publishable because it is the
      // package's own: it defined the type, so nothing about writing one is
      // the host's business beyond validating the envelope, and the payload
      // is opaque JSON either way (`publish-artifact.ts`). What this rule
      // buys is the thing that matters — a plugin can never publish someone
      // *else's* type, so no manifest can put a forged `AcceptingPetriNet`
      // or a fake OCEL into the catalog.
      //
      // The third way is the narrow exception `HOST_VALIDATED_TYPES` opens: a
      // core type whose payload the host can check structurally on every
      // publish. An editor's whole purpose is to produce a core type and it
      // can never own one, so without this the rule would not be preventing
      // forgery, only authoring. The two gates have to agree — a manifest
      // that installs and then cannot publish, or one that is refused for a
      // type the host would accept, is the same rule written twice.
      const ownType = (m.artifactTypes ?? []).some((t) => t.id === type);
      const hostValidated = Object.prototype.hasOwnProperty.call(HOST_VALIDATED_TYPES, type);
      if (!PUBLISHABLE_TYPES.includes(type) && !ownType && !hostValidated) {
        errors.push(
          `view ${v.id}: cannot publish "${type}" — a view may publish a log-shaped type `
          + `(${PUBLISHABLE_TYPES.join(', ')}), a core type the host validates `
          + `(${Object.keys(HOST_VALIDATED_TYPES).join(', ')}), or an artifact type this package declares itself`
        );
      }
    }
    errors.push(...validateShowWhen(`view ${v.id}`, v.params));
  }
  // `primary` means "this view *is* the artifact" — see `ViewDef.primary` in
  // `host/views/registry.ts`, and the per-type lookups that read it
  // (`viewRegistry.forType(type).find(v => v.primary)`). So the rule is one
  // primary per *artifact type*, not one per package: a package contributing
  // two types (a model and the report of checking it) is entitled to a
  // primary view for each, and the older package-wide check refused exactly
  // that for no reason the host's own semantics could name.
  const primaryOf = new Map<ArtifactTypeId, string[]>();
  for (const v of (m.views ?? []).filter((view) => view.primary)) {
    for (const type of v.appliesTo ?? []) {
      primaryOf.set(type, [...(primaryOf.get(type) ?? []), v.id]);
    }
  }
  for (const [type, ids] of primaryOf) {
    if (ids.length > 1) {
      errors.push(`at most one view per artifact type may be "primary": ${ids.join(', ')} all claim "${type}"`);
    }
  }

  return { ok: errors.length === 0, errors, manifest: errors.length ? undefined : m };
}
