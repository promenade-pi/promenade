import { dataClient } from '../data/client';
import { tableOf, logicalTablesOf } from '../artifact/tables';
import { roleTableMap } from './roleTables';
import { schemaFor } from '../relational/schemas';
import { activityIdMap, buildAlignModel, buildLifecycleAlignModel, type AlignmentClassifier } from '../actions/alignmentModel';
import { loadOptions } from '../actions/options';
import { payloadOf } from '../actions/results';
import { pyodideRunner } from './pyodide-runner';
import { runnerFor } from './runner';
import { runOnComputeEngine } from './computeRuntime';
import { readPluginFile } from './store';
import { entryOf, type PluginManifest } from './manifest';
import { SupersededError } from '../actions/types';
import type { ActionContext, ActionOutcome } from '../actions/types';
import type { ArtifactId } from '../artifact/types';

/**
 * Generic runtime adapters for installed plugin actions.
 *
 * `store.ts`'s `registerPlugin` picks one of these per action, based on the
 * action's resolved runtime (`manifest.ts`'s `runtimeOf`) — the same generic
 * dispatch every installed plugin gets, wasm/pyodide/relational alike. No
 * plugin-specific code lives here; the one thing that looks plugin-specific
 * (the `AcceptingPetriNet` second-slot handling in `wasmActionRuntime`) is a
 * pre-existing exception already present before this file did — alignment is
 * the one action needing a second input transformed into a param, and there
 * is no way to express that generically without knowing what the second
 * input *means*, the same reason `ctx.persistLog` exists for the one case
 * (a log-shaped output) that *does* generalize.
 *
 * `wasmActionRuntime` also trusts an upstream fact over a user-supplied
 * param, generically: for every param the action declares, if the input
 * artifact's own `meta` has a same-named key, that meta value wins. This
 * exists because a wasm action can receive a log whose rows encode structure
 * (or auxiliary facts about the rows) a param alone cannot safely restate — a
 * multi-object-type projection's case-id scheme, or which (object type,
 * activity) pairs are variable, for two (see `plugins/ocpn-rs`) — trusting
 * whatever the artifact that actually produced the rows recorded is what
 * keeps a stale or mistaken param from silently deciding wrong. Any action
 * producing such a log sets the matching `meta` key when it persists it
 * (`ActionContext.persistLog`'s caller controls the returned artifact's
 * `meta` directly, and `relationalActionRuntime`'s own resolved-picker and
 * extra-`@output` meta below both write into that same space); an action
 * with no such upstream fact for a given param is unaffected.
 */

type ManifestAction = NonNullable<PluginManifest['actions']>[number];

function primaryInputId(action: ManifestAction, inputs: Record<string, ArtifactId[]>): ArtifactId | undefined {
  const slot = action.inputs[0]?.name;
  return slot ? inputs[slot]?.[0] : undefined;
}


export function wasmActionRuntime(manifest: PluginManifest, action: ManifestAction) {
  return {
    async run(inputs: Record<string, ArtifactId[]>, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
      let logId = primaryInputId(action, inputs);
      // A manufacturing action -- `inputs: []`, everything it needs arrives
      // through its own `file`-typed param instead -- has no slot to bind at
      // all; only an action that actually declares one is missing something
      // by lacking `logId`.
      if (!logId && action.inputs.length > 0) {
        throw new Error(`action ${action.id}: no input bound to slot "${action.inputs[0]?.name}"`);
      }

      // An action may declare (`manifest.ts`'s `scans`) that what it actually
      // scans isn't what the user selected, but a projection of it — e.g.
      // "Discover OCPN" is picked directly on an ObjectCentricEventLog, but
      // needs the TraditionalEventLog a separate, `internal` relational
      // action projects. Producing that here, transparently, is what lets
      // the user click one action instead of two: no plugin-specific code,
      // just `ctx.produce()` (the same mechanism any action's own `run` can
      // call) driven by a declarative hint any installed action can set.
      if (action.scans && logId) {
        const primaryRole = action.inputs[0]?.name ?? 'log';
        // Every bound slot is forwarded, not only the primary one. A scan
        // stage usually needs just the log the user picked, and for those
        // this map has exactly one entry and nothing changes. But a stage
        // that projects from *all* of its consumer's inputs — a learning
        // graph built from a gapped log and the reference it came from —
        // cannot be expressed at all if the second slot is dropped here,
        // and the alternative is for such a plugin to ask the user to run
        // the hidden stage by hand. A produced action binds only the roles
        // its own manifest declares (`roleTableMap`), so a slot it does not
        // know about is ignored rather than misread.
        // The full incoming params, not just the ones this action declares:
        // the projection stage binds only the param names its own SQL
        // actually references (`bindStatementParams` looks them up by its
        // own declared schema, not the caller's), so passing everything is
        // how a param this action shares with its scan target (e.g.
        // `objectTypes`, picked on this action's own UI) actually reaches
        // it — the params object is the one thing `produce()` doesn't
        // otherwise give a hidden prerequisite stage any way to receive.
        logId = await ctx.produce(
          action.scans, { ...inputs, [primaryRole]: [logId] }, params, action.scanAction,
        );
      }

      // Most WASM actions scan a log.  Model-to-model actions are different:
      // their complete input is an inline payload, so forcing them through a
      // fictional event table both loses information and makes a Rust-only
      // conversion action impossible.  `value-finalize/1` is deliberately
      // small: it gives the kernel one JSON value and no SQL/data-worker
      // capability.  The normal scan-finalize ABI is unchanged.
      const valueFinalize = action.kernel?.abi === 'value-finalize/1';
      const table = valueFinalize || !logId ? '' : tableOf(logId, 'event');

      let runParams = params;
      const declaredParamNames = Object.keys(action.params.properties ?? {});
      if (declaredParamNames.length && logId) {
        const { catalog } = await dataClient.catalog();
        const upstreamMeta = catalog.artifacts[logId]?.meta ?? {};
        for (const name of declaredParamNames) {
          if (upstreamMeta[name] !== undefined) runParams = { ...runParams, [name]: upstreamMeta[name] };
        }
      }
      // A manufacturing action has no artifact to read a value from -- its
      // `runParams` already carries everything (e.g. a `file` param's text)
      // exactly as the caller built them.
      if (valueFinalize && logId) {
        const { catalog } = await dataClient.catalog();
        const artifact = catalog.artifacts[logId];
        if (!artifact) throw new Error(`action ${action.id}: input artifact "${logId}" not found`);
        const value = payloadOf(logId) ?? (artifact.storage.kind === 'inline' ? artifact.storage.value : null);
        if (value == null) throw new Error(`action ${action.id}: input artifact has no inline value`);
        // `inputMeta` alongside it, for the same reason the pyodide adapter
        // passes it (see `inputMeta` below): some facts about an artifact live
        // only in the catalog, never in its payload. The Alpha Miner's
        // `AcceptingPetriNet` is the case in point — bare activity ids in the
        // payload, their names in `meta.activityNames` — and a kernel that
        // cannot read them can only call the activities `#3`. Read-only, and
        // already this host's own vocabulary, so it widens no data access.
        runParams = { ...runParams, inputValue: value, inputMeta: artifact.meta ?? {} };
      }

      // Every bound input slot's inline payload, keyed by role — the door the
      // pyodide adapter has always had (`inputValues` below) and the wasm one
      // did not. An action that scans a log *and* needs a model to check it
      // against otherwise has no way to see the model at all: the scan ABI
      // feeds the kernel one event stream, and the only second input it ever
      // understood was the `AcceptingPetriNet` alignment special case further
      // down, which resolves the net into the log's own activity ids because
      // alignment needs exactly that.
      //
      // This is the general form: the payload as it is, by role, for a kernel
      // to interpret however its own artifact type requires (a declarative
      // model names its activities, so it maps them itself, against the names
      // `setActivityNames` already gave it). A slot bound to a log has no
      // inline payload and contributes `null`, exactly as in pyodide.
      if (action.inputs.length > 1) {
        const { catalog } = await dataClient.catalog();
        const inputValues = Object.fromEntries(
          action.inputs
            .map((slot) => [slot.name, (inputs[slot.name] ?? []).map((id) => {
              const artifact = catalog.artifacts[id];
              if (!artifact) throw new Error(`action ${action.id}: input artifact "${id}" not found`);
              return payloadOf(id) ?? (artifact.storage.kind === 'inline' ? artifact.storage.value : null);
            })] as const)
            .filter(([, values]) => values.length > 0)
        );
        runParams = { ...runParams, inputValues };
      }

      // "Run on: Promenade Compute" — set only when the user picked an
      // engine (`Inspector.tsx`) for an action whose manifest declares a
      // `compute.wasi` build. Everything above this point (scans projection,
      // upstream-meta merge) applies identically either way; everything
      // below (the AcceptingPetriNet model special case, the worker-based
      // runner) is the browser-only continuation. Stage 1's engine has no
      // equivalent for `value-finalize/1`, for a second model input, or for
      // any second input at all (`inputValues` above never reaches it), so
      // each falls back to the ordinary browser run rather than silently
      // misbehaving on the engine.
      if (ctx.compute && !valueFinalize && action.inputs.length < 2) {
        return runOnComputeEngine(manifest, action, logId, table, runParams, ctx);
      }

      // The one pre-existing, genuinely plugin-specific exception: alignment
      // needs a second (AcceptingPetriNet) input turned into a `model` param,
      // resolved in the log's own activity-id space. That only means anything
      // when there IS a log being scanned alongside it — a `value-finalize/1`
      // action has no log/table at all (`table` is `''` above), so when its
      // *sole* input happens to be `AcceptingPetriNet` (a Petri-net-to-BPMN
      // conversion, say) this must not also run: `inputValue` already carries
      // that whole input, and `activityIdMap` against an empty table name
      // built malformed SQL (`FROM  WHERE ...`) before this guard existed.
      let modelKey = '';
      const modelSlot = !valueFinalize && action.inputs.find((s) => s.type === 'AcceptingPetriNet');
      if (modelSlot) {
        const modelId = inputs[modelSlot.name]?.[0];
        if (modelId) {
          const { catalog } = await dataClient.catalog();
          const modelArtifact = catalog.artifacts[modelId];
          if (!modelArtifact) throw new Error(`action ${action.id}: input model "${modelId}" not found`);
          const scanOrder = action.kernel?.scan?.order ?? 'timestamp';
          const classifier: AlignmentClassifier = action.kernel?.scan?.classifier ?? 'activity';
          const nameToId = await activityIdMap(table, Number(params.maxActivities ?? 1000), scanOrder, classifier);
          const persistedActivities = Array.isArray(modelArtifact.meta.activityNames)
            ? modelArtifact.meta.activityNames.filter((name): name is string => typeof name === 'string')
            : [];
          const modelPayload = payloadOf(modelId) ??
            (modelArtifact.storage.kind === 'inline' ? modelArtifact.storage.value : null);
          const baseModel = buildAlignModel(modelId, nameToId, persistedActivities, modelPayload);
          const model = baseModel && action.modelTransform === 'lifecycle'
            ? buildLifecycleAlignModel(baseModel, nameToId)
            : baseModel;
          if (!model) {
            throw new Error(`action ${action.id}: the selected ${modelSlot.label} has no computed result to align against`);
          }
          // Keep the normalised id-only form for an algorithm, and make the
          // source payload available too. A renderer such as the Inductive
          // Visual Miner needs the original transition ids/labels after its
          // WASM kernel has finished the alignment; other kernels simply
          // ignore this extra parameter.
          runParams = { ...runParams, model, modelPayload };
          modelKey = `::${modelId}`;
        }
      }

      const out = await runnerFor(manifest, action).run({
        table, params: runParams,
        prepareKey: logId ? `${logId}${modelKey}:${params.maxActivities ?? ''}` : `no-input:${action.id}`,
        valueFinalize,
        signal: ctx.signal, onProgress: ctx.progress,
      });
      if (!out) throw new SupersededError(action.id);

      // An export action's kernel returns the file directly instead of an
      // artifact payload -- `{text|bytes, extension, mime}` -- so there is
      // no inline value, activities, or stats to carry into a catalog
      // entry that will never exist. The kernel only ever sees the bare
      // payload (`inputValue`), never the artifact's own name, so the host
      // composes the actual filename here -- the same sanitize-and-suffix
      // pattern every other export in this codebase (OCEL, XES, PNML) uses.
      if (action.exportsFile) {
        const result = out.result as { text?: string; bytes?: number[]; extension: string; mime: string };
        const { catalog } = await dataClient.catalog();
        const sourceName = (logId && catalog.artifacts[logId]?.name) || action.label;
        const filename = `${sourceName.replace(/[^A-Za-z0-9_.-]/g, '_')}${result.extension}`;
        return {
          exported: {
            bytes: result.bytes ? new Uint8Array(result.bytes) : (result.text ?? ''),
            filename,
            mime: result.mime,
          },
          runtimeVersion: `${manifest.id} ${manifest.version}`,
        };
      }

      const wasmPayload: any = out.result ?? {};

      // A kernel whose action declares a log-shaped output type returns the
      // log's *columns* rather than an inline payload, and the host writes
      // the storage (`ActionContext.persistLog`'s `rows` form). This is what
      // lets a plugin produce a log that did not exist before — a simulator
      // playing a model out into traces — rather than only reading one: an
      // inline blob is not a log, and nothing downstream could mine, query or
      // view it as one.
      //
      // Reached by manifest declaration alone, like every other branch here:
      // the declared output type having a logical schema *is* the signal, so
      // no plugin-specific code and no new manifest field is involved. What
      // the plugin may put in the catalog is still only rows, checked column
      // by column against that schema before anything is written.
      const outputType = action.outputs?.[0]?.type;
      if (outputType && schemaFor(outputType)) {
        const log = wasmPayload.log;
        if (!log || typeof log !== 'object') {
          throw new Error(
            `action ${action.id}: declares a ${outputType} output, so its kernel must return ` +
            `{ log: { <relation>: { <column>: [...] } } }`
          );
        }
        const artifact = await ctx.persistLog({
          type: outputType,
          name: typeof wasmPayload.name === 'string' && wasmPayload.name.trim()
            ? wasmPayload.name.trim()
            : action.label,
          rows: log,
          inputs,
          meta: { ...(wasmPayload.stats ?? {}) },
        });
        return { persisted: artifact, runtimeVersion: `${manifest.id} ${manifest.version}` };
      }

      // A kernel's own `stats` ride along into the artifact's `meta` (which
      // is how `executeAction` builds it), the same way the pyodide adapter
      // already does. That is the channel a plugin uses to record small facts
      // about what it produced — counts for the Statistics panel, and the
      // facts a `showWhen` condition can read.
      return {
        inline: {
          value: out.result,
          activities: out.activities,
          stats: { ...(wasmPayload?.stats ?? {}), ...out.timing },
        },
        runtimeVersion: `${manifest.id} ${manifest.version}`,
        benchmark: {
          cacheState: out.timing.reused || out.timing.bundleCached ? 'mixed' : 'cold',
          phases: [
            ...(out.timing.bundleMs != null ? [{
              id: 'wasm-bundle', label: 'Load WASM plugin', durationMs: out.timing.bundleMs,
              cached: out.timing.bundleCached,
              detail: out.timing.workerCold ? 'new worker' : undefined,
            }] : []),
            {
              id: 'prepare', label: 'Prepare / scan input', durationMs: out.timing.prepareMs,
              cached: out.timing.reused,
            },
            { id: 'compute', label: 'Compute result', durationMs: out.timing.finalizeMs },
          ],
        },
      };
    },
  };
}

export function pyodideActionRuntime(manifest: PluginManifest, action: ManifestAction) {
  return {
    async run(inputs: Record<string, ArtifactId[]>, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
      const inputId = primaryInputId(action, inputs);
      if (!inputId) throw new Error(`action ${action.id}: no input bound to slot "${action.inputs[0]?.name}"`);

      const entry = entryOf(manifest, action);
      if (!entry) throw new Error(`action ${action.id}: pyodide runtime missing entry`);
      const source = new TextDecoder().decode(await readPluginFile(manifest.id, entry));

      const { catalog } = await dataClient.catalog();
      const inputArtifact = catalog.artifacts[inputId];
      if (!inputArtifact) throw new Error(`action ${action.id}: input artifact "${inputId}" not found`);
      // The primary input owns the bare `{event}` aliases for backwards
      // compatibility; every declared slot (primary included) also gets
      // `{<slot>__<logical>}` keys, so a two-input action can query the
      // secondary log's tables directly — see `roleTableMap`.
      const tables = roleTableMap(action, inputs, catalog);
      // Preserve every input role for Python actions.  Inline model artifacts
      // have no tables and are received through `ctx.inputs`; a log input has
      // no inline payload, so its `ctx.inputs` entry is `null` and the plugin
      // reads it through the namespaced SQL placeholders instead.
      const inputValues = Object.fromEntries(Object.entries(inputs).map(([role, ids]) => [
        role,
        ids.map((id) => {
          const artifact = catalog.artifacts[id];
          if (!artifact) throw new Error(`action ${action.id}: input artifact "${id}" not found`);
          return payloadOf(id) ?? (artifact.storage as any).value ?? null;
        }),
      ]));
      // The declared metadata of each input artifact, by role.
      //
      // A plugin can read an artifact's *rows* through `ctx.sql()` and its
      // inline payload through `ctx.inputs`, but never what the catalog
      // records *about* it — and some facts exist only there. A derived log's
      // transformation plan is the case that forced this: a log whose event
      // order was asserted by a repair is indistinguishable from one whose
      // order was recorded, by inspection of the timestamps alone. The host
      // knows; without this the plugin cannot.
      //
      // Read-only and already the host's own vocabulary (`showWhen` conditions
      // address the same `artifactMeta`), so this widens no access to data.
      const inputMeta = Object.fromEntries(Object.entries(inputs).map(([role, ids]) => [
        role,
        ids.map((id) => ({
          ...(catalog.artifacts[id]?.meta ?? {}),
          // Not part of `meta`, but the same class of fact and the one a
          // plugin most often needs: how this artifact came to exist.
          storageKind: catalog.artifacts[id]?.storage.kind ?? null,
          transformOps: catalog.artifacts[id]?.storage.kind === 'view'
            ? (catalog.artifacts[id]!.storage as any).plan.ops.filter((op: any) => !op.disabled)
            : [],
        })),
      ]));
      const inputKey = Object.entries(inputs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([role, ids]) => `${role}:${ids.join(',')}`)
        .join('|');

      const out = await pyodideRunner.run({
        source, deps: manifest.pythonDeps ?? [], tables, params,
        entryPoint: action.entryPoint,
        // An action whose input is not a log (a process tree, say) gets its
        // input handed over as a value — `ctx.sql()`-equivalent table access
        // stays the only door for actual table data.
        inputValue: payloadOf(inputId) ?? (inputArtifact.storage as any).value ?? null,
        inputValues,
        inputArtifactIds: inputs,
        inputMeta,
        prepareKey: `${inputKey}:${action.id}:${params.maxEvents ?? ''}`,
        signal: ctx.signal, onProgress: ctx.progress,
      });
      if (!out) throw new SupersededError(action.id);

      const payload: any = out.result ?? {};
      return {
        inline: {
          value: out.result,
          activities: Array.isArray(payload.activities) ? payload.activities : [],
          stats: { ...(payload.stats ?? {}), ...out.timing },
        },
        runtimeVersion: 'pyodide',
        benchmark: {
          cacheState: out.timing.coldRuntime || (out.timing.installed?.length ?? 0) > 0
            ? 'cold'
            : (out.timing.reused ? 'warm' : 'mixed'),
          phases: [
            ...(out.timing.runtimeMs > 0 ? [{
              id: 'pyodide-runtime', label: 'Start Pyodide runtime', durationMs: out.timing.runtimeMs,
              detail: 'cold start',
            }] : []),
            ...(out.timing.dependencyMs > 0 ? [{
              id: 'python-dependencies', label: 'Install Python packages', durationMs: out.timing.dependencyMs,
              detail: Array.isArray(out.timing.installed) && out.timing.installed.length
                ? out.timing.installed.join(', ')
                : 'Pyodide packages',
            }] : []),
            ...(out.timing.bridgeMs > 0 ? [{
              id: 'python-bridge', label: 'Initialize Python data bridge', durationMs: out.timing.bridgeMs,
            }] : []),
            ...(out.timing.sourceMs > 0 ? [{
              id: 'python-plugin', label: 'Load Python plugin', durationMs: out.timing.sourceMs,
              cached: !out.timing.sourceReloaded,
            }] : []),
            {
              id: 'prepare', label: 'Prepare / read input', durationMs: out.timing.prepareMs,
              cached: out.timing.reused,
            },
            { id: 'compute', label: 'Compute result', durationMs: out.timing.finalizeMs },
          ],
        },
      };
    },
  };
}

export function relationalActionRuntime(manifest: PluginManifest, action: ManifestAction) {
  return {
    async run(inputs: Record<string, ArtifactId[]>, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionOutcome> {
      let programSource = action.query;
      if (!programSource && action.queryFile) {
        programSource = new TextDecoder().decode(await readPluginFile(manifest.id, action.queryFile));
      }
      if (!programSource) throw new Error(`action ${action.id}: no query or queryFile`);

      const outputType = action.outputs[0]?.type;
      const schema = outputType ? schemaFor(outputType) : undefined;

      if (schema) {
        // A picker param left empty conventionally means "everything" —
        // resolved here, before the SQL ever binds it, rather than in the
        // query text: an empty bound list is exactly the shape DuckDB-Wasm's
        // parameter binding cannot type-infer on its own ("Invalid column
        // type encountered"), so every relational action gets a real,
        // non-empty list to bind regardless of what the user picked. The
        // resolved list is also recorded into the new artifact's `meta`,
        // generically, for any downstream action that trusts an upstream
        // fact over a param — see `wasmActionRuntime`'s `objectTypes` rule
        // above; this is the other half of that contract, not something
        // specific to one plugin's params.
        let boundParams = params;
        const resolvedMeta: Record<string, unknown> = {};
        for (const [name, prop] of Object.entries(action.params.properties ?? {})) {
          const bound = params[name];
          if (!prop.optionsFrom || !Array.isArray(bound) || bound.length > 0) continue;
          const primaryId = inputs[action.inputs[0]?.name ?? '']?.[0];
          const { catalog } = await dataClient.catalog();
          const primaryArtifact = primaryId ? catalog.artifacts[primaryId] : undefined;
          if (!primaryArtifact) continue;
          const options = await loadOptions(prop.optionsFrom, primaryArtifact);
          const resolved = options.map((o) => o.value);
          resolvedMeta[name] = resolved;
          boundParams = { ...boundParams, [name]: resolved };
        }

        const artifact = await ctx.persistLog({
          type: outputType!, name: action.label, programSource, inputs, params: boundParams,
        });
        return {
          persisted: Object.keys(resolvedMeta).length
            ? { ...artifact, meta: { ...artifact.meta, ...resolvedMeta } }
            : artifact,
          runtimeVersion: 'duckdb-wasm',
        };
      }

      // No custom builder is possible for an installed (non-core) package —
      // see `manifest.ts`'s note on `validateRelationalAction` — so a
      // non-log-shaped output stays out of scope rather than being silently
      // mishandled.
      throw new Error(
        `action ${action.id}: output type "${outputType}" has no registered logical schema — only a ` +
        `log-shaped output (a type with a logical schema, e.g. TraditionalEventLog) can be produced ` +
        `by an installed relational action today`
      );
    },
  };
}
