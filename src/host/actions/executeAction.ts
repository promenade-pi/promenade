import { dataClient } from '../data/client';
import { artifactTypes } from '../artifact/registry';
import { actionRegistry, defaultParams } from './registry';
import { resultStore } from './results';
import { colorRegistry } from '../services/colors';
import { paramTypeSchemasFrom } from '../relational/paramBinding';
import { buildLogRelations } from '../artifact/log-rows';
import { SupersededError } from './types';
import type { ActionContext, ActionDef, ActionOutcome } from './types';
import type {
  Artifact, ArtifactId, ArtifactTypeId, ActionExecution, ProvenanceGraph,
  ExecutionTiming, ExecutionTimingPhase,
} from '../artifact/types';

/**
 * The one place an action actually runs.
 *
 * Both the top-level "user clicked Discover X" path (`App.tsx`'s `onRun`/
 * `runNow`, now a thin wrapper) and `ActionContext.produce()`'s nested calls
 * go through this function — the whole point of `produce()` being real
 * rather than an unused interface is that it is not a second, parallel
 * execution path with its own artifact-building and provenance logic.
 */

export interface ExecuteActionArgs {
  actionId: string;
  /** Role name -> bound artifact ids, already resolved by the caller (the
   * UI's multi-selection slot matching for a top-level call; the calling
   * action's own choice for a nested `produce()` call). */
  inputs: Record<string, ArtifactId[]>;
  params: Record<string, unknown>;
  signal: AbortSignal;
  onProgress?: (fraction: number, message?: string, data?: unknown) => void;
  /** Set for a nested `produce()`-triggered execution. */
  parentExecutionId?: string;
  /**
   * Set for a live-recompute call: reuses this artifact's own id and its
   * `producedBy` execution id instead of minting new ones, so "recompute
   * with new params" updates the artifact in place rather than creating a
   * sibling. Only meaningful for an `inline` outcome — nothing produces a
   * `persisted` result on the live-recompute path today.
   */
  reuse?: Artifact;
  /** Set when the user picked a Promenade Compute engine to run this action
   * on, instead of the default browser runtime — see `ActionContext.compute`. */
  engine?: { engineId: string; endpoint: string };
  /**
   * A prerequisite the *host* supplies, for an action the user reached
   * through something it cannot consume directly — "Backbone layout" chosen
   * on an OCEL, which actually needs the OC-DFG in between.
   *
   * This is the generic form of what `scans`/`scanAction` do per-plugin
   * (`host/plugins/manifest.ts`), and it goes through the same door: it is
   * produced by `ctx.produce()`, so it is a nested execution with this one
   * as its `parentExecutionId`, which means it is cached, cancellable,
   * recorded in provenance, hidden from the tree, and — since the adoption
   * check in `produce()` — shared with anything else that needed the same
   * thing. None of that would be true of a host that simply ran two actions
   * back to back.
   *
   * The planner always names `producerId`: `produce()` refuses an ambiguous
   * output type on purpose, and choosing between two producers is a question
   * for the person, not for a resolution rule.
   */
  prerequisite?: {
    type: ArtifactTypeId;
    producerId: string;
    /** The user's own selection — the prerequisite's inputs, not this action's. */
    inputs: Record<string, ArtifactId[]>;
    /** This action's input slot the produced artifact binds to. */
    slot: string;
  };
}

export interface ExecuteActionResult {
  artifact: Artifact;
  execution: ActionExecution;
  catalog: ProvenanceGraph;
  // Matches `dataClient`'s own loose typing for this field throughout.
  quota: any;
}

/**
 * What a `def.exportsFile` action hands back instead of an artifact — a
 * file to download, never entered into provenance or the catalog at all
 * (not even as a hidden node): unlike `opensView`, there is no artifact on
 * either side of this, just bytes leaving the app.
 */
export interface ExportedFile {
  bytes: Uint8Array | string;
  filename: string;
  mime: string;
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Canonical forms for the "has this exact thing been produced already?"
 * comparison in `produce()`. Key order is not meaningful in either record,
 * so both are sorted before they are stringified; artifact ids inside one
 * role *are* ordered (a slot's bindings are positional) and are left alone.
 */
function sortedInputs(inputs: Record<string, ArtifactId[]>): Array<[string, ArtifactId[]]> {
  return Object.entries(inputs).filter(([, ids]) => ids.length > 0).sort(([a], [b]) => a.localeCompare(b));
}

function sortedParams(params: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
}

/** Every action currently declaring an output of `type`, with a real `run`. */
function producersOf(type: ArtifactTypeId): ActionDef[] {
  return actionRegistry.all().filter((a) => a.run && a.outputs.some((o) => o.type === type));
}

/**
 * Normalises per-runtime telemetry into one comparable benchmark timeline.
 * Runtime timings intentionally remain their own phases; the remainder is
 * labeled host orchestration instead of silently vanishing into "compute".
 */
function benchmarkTiming(
  outcome: Awaited<ReturnType<NonNullable<ActionDef['run']>>>,
  runMs: number,
  commitMs: number,
  totalMs: number,
): ExecutionTiming {
  const supplied = outcome.benchmark;
  const phases: ExecutionTimingPhase[] = [...(supplied?.phases ?? [])]
    .filter((phase) => Number.isFinite(phase.durationMs) && phase.durationMs >= 0);
  const accounted = phases.reduce((sum, phase) => sum + phase.durationMs, 0);
  const overhead = Math.max(0, runMs - accounted);
  if (!supplied || overhead > 0.5) {
    phases.push({
      id: 'host', label: supplied ? 'Host orchestration' : 'Action execution', durationMs: supplied ? overhead : runMs,
    });
  }
  phases.push({ id: 'commit', label: 'Persist result & provenance', durationMs: commitMs });
  return {
    totalMs,
    cacheState: supplied?.cacheState ?? 'warm',
    phases,
  };
}

export async function executeAction(args: ExecuteActionArgs): Promise<ExecuteActionResult | ExportedFile | null> {
  if (args.signal.aborted) return null;

  const def = actionRegistry.get(args.actionId);
  if (!def) throw new Error(`unknown action "${args.actionId}"`);
  if (!def.run) throw new Error(`action "${args.actionId}" has no runtime implementation`);

  const t0 = performance.now();
  const execId = args.reuse?.producedBy ?? newId('x');
  const declaredParams = paramTypeSchemasFrom(def.params.properties as any);

  const ctx: ActionContext = {
    signal: args.signal,
    progress: (f, m, data) => args.onProgress?.(f, m, data),
    log: (m) => console.debug(`[${args.actionId}]`, m),
    sql: (text) => dataClient.sql(text),
    compute: args.engine,

    produce: async (type, produceInputs, produceParams, producerId) => {
      const candidates = producersOf(type).filter((candidate) => !producerId || candidate.id === producerId);
      if (candidates.length === 0) {
        throw new Error(producerId
          ? `produce(${type}): action "${producerId}" does not declare this output`
          : `produce(${type}): no action declares this output`);
      }
      if (candidates.length > 1) {
        throw new Error(
          `produce(${type}): ambiguous — ${candidates.length} actions declare this output ` +
          `(${candidates.map((c) => c.id).join(', ')})`
        );
      }

      // Reuse this exact nested slot's own previous artifact across a
      // recompute of the *outer* execution, instead of minting a fresh one
      // on every parameter change — a scanAction-produced intermediary (the
      // OCPN "Discover metro map" scans on its way to an OCEL, say) would
      // otherwise multiply once per slider tick even though only the outer
      // artifact is nominally being "recomputed in place"
      // (`App.tsx#runRecompute`'s own `reuse` convention only ever covers
      // the one artifact it was called for, not whatever a nested
      // `produce()` inside its `run()` mints along the way). `execId` stays
      // stable across every recompute of the outer artifact (it *is*
      // `args.reuse.producedBy` when reusing — see below), so the nested
      // execution this same `produce()` call created last time is always
      // findable by `parentExecutionId === execId`; reusing its artifact
      // recurses correctly through any further nested `produce()` calls
      // inside *that* action's own `run()`, since each one keys off its own
      // stable execId the identical way. A brand-new top-level run (no
      // `args.reuse`) still gets a brand-new nested chain, same as before —
      // there is no prior execution to find, and nothing has recomputed in
      // place yet.
      let reuse: Artifact | undefined;
      const { catalog: currentCatalog } = await dataClient.catalog();
      if (args.reuse) {
        const priorExec = Object.values(currentCatalog.executions).find(
          (e) => e.parentExecutionId === execId && e.actionId === candidates[0].id,
        );
        const priorArtifactId = priorExec?.outputs[0];
        reuse = priorArtifactId ? currentCatalog.artifacts[priorArtifactId] : undefined;
      }

      /**
       * Adopt an identical artifact instead of computing a second one.
       *
       * The `reuse` branch above only covers *this* execution's own prior
       * nested run. It says nothing about an artifact some other execution
       * already produced from the same action, the same inputs and the same
       * parameters — which is exactly what happens the moment two things
       * need the same prerequisite: discover a metro map and then a backbone
       * layout on one log, and without this the workspace holds two
       * identical OC-DFGs, each with its own storage and its own recompute.
       *
       * Deliberately exact: same action, same params, same inputs in the
       * same roles. Anything looser would silently hand back a result the
       * caller did not ask for. Only artifacts still in the catalog qualify,
       * and a `stale` one is skipped — its inputs have changed since, so it
       * is not the artifact these inputs would produce now.
       */
      if (!reuse) {
        const wanted = JSON.stringify([
          candidates[0].id, sortedInputs(produceInputs), sortedParams(produceParams),
        ]);
        for (const e of Object.values(currentCatalog.executions)) {
          if (e.actionId !== candidates[0].id) continue;
          if (JSON.stringify([e.actionId, sortedInputs(e.inputs), sortedParams(e.params)]) !== wanted) continue;
          const existing = currentCatalog.artifacts[e.outputs[0]];
          if (existing && !existing.stale) return existing.id;
        }
      }

      const nested = await executeAction({
        actionId: candidates[0].id, inputs: produceInputs, params: produceParams,
        signal: args.signal, onProgress: args.onProgress, parentExecutionId: execId, reuse,
        engine: args.engine,
      });
      if (!nested) throw new Error(`produce(${type}): nested action did not complete`);
      // `candidates` only ever names an action with a real `outputs` entry
      // for `type` (`producersOf`) -- an `exportsFile` action declares none,
      // so it can never be `candidates[0]` and this is always the produced-
      // artifact shape, never `ExportedFile`.
      if (!('artifact' in nested)) throw new Error(`produce(${type}): "${candidates[0].id}" exported a file instead of producing an artifact`);
      return nested.artifact.id;
    },

    persistLog: async ({
      type, name, programSource, rows, inputs: logInputs, params: overrideParams, meta: extraMeta,
    }) => {
      if (!programSource === !rows) {
        throw new Error('persistLog: give either a SQL program or rows, not both or neither');
      }
      const id = newId('a');
      // Two ways to get the tables, one artifact shape out. `rows` skips the
      // relational compiler entirely — there is no program to bind params
      // into and no input to read — so the branch is only about *where the
      // tables come from*; everything about the resulting artifact is the
      // same either way.
      const { storage, meta } = rows
        ? await dataClient.materializeRowLog({
            id, targetType: type, relations: buildLogRelations(type, rows).relations,
          })
        : await dataClient.materializeRelationalLog({
            id,
            inputs: Object.entries(logInputs)
              .flatMap(([role, ids]) => ids.map((artifactId) => ({ role, artifactId }))),
            params: overrideParams ?? args.params, programSource: programSource!,
            declaredParams, targetType: type,
          });
      return {
        id, name, type, createdAt: new Date().toISOString(),
        storage: storage as Artifact['storage'], meta: { ...meta, ...(extraMeta ?? {}) },
        producedBy: null, inputs: Object.values(logInputs).flat(),
      };
    },
  };

  /**
   * The inputs `run` actually sees. Identical to `args.inputs` for every
   * ordinary call; a planner-supplied prerequisite is produced first and
   * bound into its slot here, so the action itself never learns that it was
   * reached through a chain — from its side this is an ordinary invocation
   * with its declared input present.
   */
  let runInputs = args.inputs;
  if (args.prerequisite) {
    const producer = actionRegistry.get(args.prerequisite.producerId);
    if (!producer) throw new Error(`prerequisite: unknown action "${args.prerequisite.producerId}"`);
    const midId = await ctx.produce(
      args.prerequisite.type,
      args.prerequisite.inputs,
      // The producer's own declared defaults. `executeAction` does not apply
      // them itself (its callers do), so an empty object here would run the
      // prerequisite with no parameters at all.
      defaultParams(producer.params),
      args.prerequisite.producerId,
    );
    if (args.signal.aborted) return null;
    runInputs = { ...args.inputs, [args.prerequisite.slot]: [midId] };
  }

  const actionStarted = performance.now();
  // A superseded run joins the abort case rather than raising: both mean "a
  // newer request owns this, do not report it", and `null` is what every
  // caller already checks for. Raising instead put a run nobody was waiting
  // for into the error banner, where it stayed.
  let outcome: ActionOutcome;
  try {
    outcome = await def.run(runInputs, args.params, ctx);
  } catch (e) {
    if (e instanceof SupersededError) return null;
    throw e;
  }
  const actionMs = performance.now() - actionStarted;
  if (args.signal.aborted) return null;

  // A `def.exportsFile` action's whole point is to leave nothing behind in
  // the workspace -- no artifact, no execution, no provenance node. Return
  // its file straight to the caller before any of that machinery runs.
  if (outcome.exported) {
    return outcome.exported;
  }

  let artifact: Artifact;
  if (outcome.persisted) {
    artifact = { ...outcome.persisted, producedBy: execId };
  } else if (outcome.inline) {
    const outputType = def.outputs[0]?.type;
    if (!outputType) throw new Error(`action "${args.actionId}" declares no output type`);

    // Named after what the artifact *is* ("Log Quality Report"), not what
    // produced it ("Analyze Log Quality · mc_ocel") — the action and the
    // source are already recorded as this artifact's provenance and shown
    // alongside it in the tree, so baking them into the identity slot too
    // just repeated them. A recompute keeps the artifact's existing name.
    const name = args.reuse?.name ?? artifactTypes.get(outputType).label;

    const value = outcome.inline.value;
    let inlineBytes = Infinity;
    try { inlineBytes = JSON.stringify(value, (_k, v) => (v instanceof Uint32Array ? [...v] : v)).length; }
    catch { /* non-serializable value: never inlined */ }

    const outId = args.reuse?.id ?? newId('d');
    artifact = {
      id: outId,
      name,
      type: outputType,
      createdAt: args.reuse?.createdAt ?? new Date().toISOString(),
      storage: inlineBytes < 2_000_000 ? { kind: 'inline', value } : { kind: 'inline', value: null },
      meta: {
        ...(outcome.inline.stats ?? {}),
        // The bare inline payload is what opens in a view after a reload.
        // Numeric-transition Petri nets additionally need this id-to-name
        // table for future alignment, so retain it with the artifact rather
        // than depending on the ephemeral runner envelope.
        ...(outputType === 'AcceptingPetriNet' && outcome.inline.activities?.length
          ? { activityNames: outcome.inline.activities }
          : {}),
      },
      producedBy: execId,
      inputs: Object.values(args.inputs).flat(),
    };
    resultStore.set(outId, {
      result: value,
      activities: outcome.inline.activities ?? [],
      stats: outcome.inline.stats ?? {},
    } as any);
    if (outcome.inline.objectTypes) colorRegistry.seed('objectType', outcome.inline.objectTypes);
    if (outcome.inline.activities) colorRegistry.seed('activity', outcome.inline.activities);
  } else {
    throw new Error(`action "${args.actionId}" returned neither an inline nor a persisted outcome`);
  }

  // An `internal` action (see `ActionDef.internal`) exists purely to feed a
  // later stage — its own output is still a real, fully provenanced artifact
  // (still queryable, still shown in Provenance), it just has no reason to
  // occupy its own row in the artifact tree the way a user-run action's
  // result does. `ArtifactTree.tsx` reads this same `meta.hidden` key to
  // reparent such an artifact's own children under its nearest visible
  // ancestor instead of under it.
  //
  // The same reasoning applies to *any* execution `produce()` triggered
  // (`args.parentExecutionId` set), regardless of whether the action itself
  // is `internal` — a scanAction-produced intermediary (the OCPN "Discover
  // metro map" scans on its way to an OCEL, say) is an action a user *can*
  // also run directly, and should show up when they do; it just shouldn't
  // earn a row here purely because some other action's `run()` needed it
  // along the way. Keying off "was this call nested" rather than "is this
  // action always internal" is what lets the same action serve both roles
  // correctly depending on how it was actually invoked this time.
  if (def.internal || args.parentExecutionId) artifact.meta = { ...artifact.meta, hidden: true };

  // The execution is committed once before that commit can itself be timed;
  // it is then replaced atomically by `updateExecution` with the completed
  // timeline. This preserves the exact click-to-finished-result number.
  const execution: ActionExecution = {
    id: execId,
    actionId: args.actionId,
    actionVersion: def.version,
    // What actually fed the action, prerequisite included — provenance that
    // recorded the user's click instead would claim this layout was computed
    // from a log, which is not reproducible and not true.
    inputs: runInputs,
    outputs: [artifact.id],
    params: args.params,
    startedAt: new Date(Date.now() - Math.round(performance.now() - t0)).toISOString(),
    durationMs: performance.now() - t0,
    // A compute-engine run keeps `def.runtime` ('wasm') as the *declared*
    // runtime — the manifest didn't change — but `args.engine` names which
    // concrete environment this one execution actually ran in, same idea as
    // `outcome.runtimeVersion` already recording "(Promenade Compute)".
    runtime: { kind: args.engine ? 'compute' : def.runtime, version: outcome.runtimeVersion ?? def.provider },
    parentExecutionId: args.parentExecutionId,
    relationalApiVersion: outcome.relationalApiVersion,
    programDigest: outcome.programDigest,
  };

  const commitStarted = performance.now();
  const r: any = await dataClient.putArtifact(artifact, execution);
  const commitMs = performance.now() - commitStarted;
  const totalMs = performance.now() - t0;
  execution.durationMs = totalMs;
  execution.timing = benchmarkTiming(outcome, actionMs, commitMs, totalMs);
  const updated = await dataClient.updateExecution(execution);
  return { artifact, execution, catalog: updated.catalog, quota: updated.quota };
}
