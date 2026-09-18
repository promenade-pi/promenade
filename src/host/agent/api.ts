/**
 * The Promenade Agent API.
 *
 * The semantic layer every agent transport calls. Nothing here knows about
 * MCP, WebMCP or JSON-RPC — that is `tools.ts` and the adapters beside it.
 * Nothing here decides whether a call is allowed either; consent is applied
 * once, at the dispatch boundary, so a new transport cannot accidentally
 * arrive without it.
 *
 * The vocabulary is Promenade's own: artifacts, actions, views, plugins.
 * That is deliberate — an agent that has learned "list applicable actions, read
 * the parameter schema, run one, adjust a parameter" has learned the whole
 * plugin ecosystem, including plugins written after the agent was trained.
 */

import type { Artifact, ArtifactId } from '../artifact/types';
import { artifactTypes } from '../artifact/registry';
import { actionRegistry, defaultParams } from '../actions/registry';
import { viewRegistry, isViewEnabled } from '../views/registry';
import { logicalTablesOf, tableOf } from '../artifact/tables';
import { buildQuerySql } from '../notebook/query';
import { dataClient } from '../data/client';
import { listInstalled, listPluginFiles, readPluginFile } from '../plugins/store';
import {
  configuredRegistries, fetchRegistry, findUpdates, installFromRegistry,
  latestOf, compareVersions,
  type RegistryEntry, type RegistryIndex,
} from '../plugins/registry';
import { SAMPLE_LOGS } from '../../ui/SampleLogsDialog';
import { agentHost } from './host';
import { agentSession } from './session';

/* ------------------------------------------------------------------ */
/* Shaping helpers                                                     */
/* ------------------------------------------------------------------ */

const MAX_ARRAY = 40;
const MAX_STRING = 800;

/**
 * Caps a value before it leaves for an agent.
 *
 * An artifact's `meta` can hold a log's entire activity list; a model payload
 * can be megabytes. Sending that verbatim wastes the caller's context on data
 * it did not ask for — the agent can always query for more, precisely.
 */
function trim(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  }
  if (typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => trim(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `… ${value.length - MAX_ARRAY} more of ${value.length}`] : head;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = trim(v, depth + 1);
  return out;
}

/**
 * Waits for a just-produced artifact to appear in the graph.
 *
 * The host's callbacks resolve when the work is done, but the graph this layer
 * reads is React state — which has not necessarily re-rendered by the time the
 * promise settles. Without this, an agent's own run reported back an artifact
 * id and nothing else, one tick before the same artifact was fully there.
 */
async function settledArtifact(id: ArtifactId, timeoutMs = 2000): Promise<Artifact | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = agentHost().getGraph().artifacts[id];
    if (a) return a;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One committed render, for a change made in place (a recompute). */
async function afterRender() {
  await new Promise((r) => setTimeout(r, 60));
}

function artifactOr404(id: ArtifactId): Artifact {
  const a = agentHost().getGraph().artifacts[id];
  if (!a) {
    const known = Object.values(agentHost().getGraph().artifacts).slice(0, 8)
      .map((x) => `${x.id} (${x.name})`).join(', ');
    throw new Error(`No artifact '${id}'. Call promenade_list_artifacts first. Known: ${known || 'none'}`);
  }
  return a;
}

function summarize(a: Artifact) {
  const g = agentHost().getGraph();
  const exec = a.producedBy ? g.executions[a.producedBy] : null;
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    typeLabel: artifactTypes.get(a.type).label,
    createdAt: a.createdAt,
    producedByAction: exec?.actionId ?? null,
    inputs: a.inputs ?? [],
    stale: a.stale ?? false,
    unavailable: a.unavailable,
    providerMissing: a.providerMissing ?? false,
    queryable: logicalTablesOf(a).length > 0,
  };
}

function paramSummary(schema: { properties?: Record<string, any> } | undefined) {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(schema?.properties ?? {})) {
    out[key] = trim({
      type: p.type,
      title: p.title,
      description: p.description,
      default: p.default,
      minimum: p.minimum,
      maximum: p.maximum,
      enum: p.enum,
      // A data-bound parameter has no fixed option list at manifest time; the
      // agent needs to know that rather than see an empty enum and assume
      // free text is fine.
      optionsFromLog: p.optionsFrom ? true : undefined,
      cheap: p.cheap || undefined,
      primary: p.primary || undefined,
    });
  }
  return out;
}

function viewsFor(a: Artifact) {
  return viewRegistry.forType(a.type, a).filter((v) => isViewEnabled(v) && !v.standalone);
}

/**
 * Which view "open this artifact" means.
 *
 * The same rule the host applies after a run: a view that explicitly claims
 * the type and can actually render it wins, `primary` first. Without the
 * `appliesTo` test, generic utility views (Provenance applies to everything)
 * sort in among the real renderers and an agent opening a Petri net gets a
 * provenance diagram.
 */
function defaultViewFor(a: Artifact) {
  const claimed = viewsFor(a).filter((v) => !!v.appliesTo && (v.component || v.entry || v.nativeView));
  return claimed.find((v) => v.primary) ?? claimed[0];
}

/* ------------------------------------------------------------------ */
/* Registry access (cached)                                            */
/* ------------------------------------------------------------------ */

let indexCache: { at: number; indexes: RegistryIndex[] } | null = null;

async function registryIndexes(force = false): Promise<RegistryIndex[]> {
  if (!force && indexCache && Date.now() - indexCache.at < 60_000) return indexCache.indexes;
  const indexes: RegistryIndex[] = [];
  for (const url of configuredRegistries()) {
    try { indexes.push(await fetchRegistry(url)); } catch {}
  }
  indexCache = { at: Date.now(), indexes };
  return indexes;
}

function entryView(entry: RegistryEntry, index: RegistryIndex, installedVersion?: string) {
  const latest = latestOf(entry);
  return {
    pluginId: entry.id,
    name: entry.name,
    description: entry.description,
    keywords: entry.keywords ?? [],
    produces: entry.provides ?? [],
    // `renders` is the exact claim (derived from the package's views);
    // `consumes` is the older, looser field kept for hand-written entries.
    renders: entry.renders ?? entry.consumes ?? [],
    accepts: entry.accepts ?? [],
    /** Per-action detail, when the index carries it. */
    actions: (entry.actions ?? [])
      .filter((a) => !a.internal)
      .map((a) => ({
        actionId: a.id, label: a.label, description: a.description,
        inputs: a.inputs, outputs: a.outputs,
      })),
    experimental: entry.experimental ?? false,
    latestVersion: latest?.version,
    changelog: latest?.changelog,
    registry: index.name,
    installed: !!installedVersion,
    installedVersion,
    updateAvailable: !!(installedVersion && latest
      && compareVersions(latest.version, installedVersion) > 0),
  };
}

/* ------------------------------------------------------------------ */
/* Parameter handling                                                  */
/* ------------------------------------------------------------------ */

/**
 * Merges caller-supplied parameters onto the schema defaults.
 *
 * Unknown keys are an error rather than a silent no-op: an agent that
 * misspells `noiseThreshold` and gets a plausible-looking result back has been
 * given a wrong answer, which is worse than being told it asked wrongly.
 */
function mergeParams(
  schema: { properties?: Record<string, any> } | undefined,
  supplied: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const merged = defaultParams((schema ?? { type: 'object', properties: {} }) as any);
  for (const [key, raw] of Object.entries(supplied ?? {})) {
    const p = props[key];
    if (!p) {
      const known = Object.keys(props).join(', ') || 'none';
      throw new Error(`${label}: unknown parameter '${key}'. Accepted: ${known}`);
    }
    let value: unknown = raw;
    if ((p.type === 'number' || p.type === 'integer') && typeof raw === 'string' && raw.trim() !== '') {
      value = Number(raw);
    }
    if (p.type === 'boolean' && typeof raw === 'string') value = raw === 'true';
    if ((p.type === 'number' || p.type === 'integer') && typeof value === 'number') {
      if (p.minimum !== undefined && value < p.minimum) {
        throw new Error(`${label}: '${key}' must be >= ${p.minimum}`);
      }
      if (p.maximum !== undefined && value > p.maximum) {
        throw new Error(`${label}: '${key}' must be <= ${p.maximum}`);
      }
    }
    if (Array.isArray(p.enum) && !p.enum.includes(value as any)) {
      throw new Error(`${label}: '${key}' must be one of ${JSON.stringify(p.enum)}`);
    }
    merged[key] = value;
  }
  return merged;
}

/** Fills declared input slots from artifact ids, the way a click does. */
function resolveSlots(
  def: { inputs: Array<{ name: string; type: string; required: boolean; label: string }>; label: string },
  ids: ArtifactId[],
): Record<string, ArtifactId[]> {
  const chosen = ids.map(artifactOr404);
  const claimed = new Set<ArtifactId>();
  const inputs: Record<string, ArtifactId[]> = {};
  for (const slot of def.inputs) {
    const match = chosen.find((a) => !claimed.has(a.id) && a.type === slot.type);
    if (!match) {
      if (slot.required) {
        throw new Error(
          `${def.label} also needs ${slot.label} (an artifact of type ${slot.type}). `
          + `Pass its id in artifactIds.`,
        );
      }
      inputs[slot.name] = [];
      continue;
    }
    claimed.add(match.id);
    inputs[slot.name] = [match.id];
  }
  return inputs;
}

/* ------------------------------------------------------------------ */
/* Arrow → JSON                                                        */
/* ------------------------------------------------------------------ */

function rowsOf(table: any, limit: number) {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of table) {
    if (rows.length >= limit) break;
    const obj = typeof row?.toJSON === 'function' ? row.toJSON() : { ...row };
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      clean[k] = typeof v === 'bigint'
        ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v))
        : (v instanceof Date ? v.toISOString() : trim(v, 3));
    }
    rows.push(clean);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* The API                                                             */
/* ------------------------------------------------------------------ */

export const promenadeApi = {
  /** The entry point: what this workspace is and what can be done next. */
  async overview() {
    const host = agentHost();
    const g = host.getGraph();
    const artifacts = Object.values(g.artifacts);
    const byType: Record<string, number> = {};
    for (const a of artifacts) byType[a.type] = (byType[a.type] ?? 0) + 1;
    const plugins = await listInstalled();
    return {
      workspace: host.getWorkspace(),
      artifactCount: artifacts.length,
      artifactsByType: byType,
      recentArtifacts: [...artifacts]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 8).map(summarize),
      selection: host.getSelection(),
      openViews: host.getOpenViews(),
      installedPlugins: plugins.map((p) => ({ id: p.manifest.id, version: p.manifest.version })),
      registeredActions: actionRegistry.all().filter((a) => !a.internal).length,
      agentPolicy: agentSession.policy,
      nextSteps: artifacts.length === 0
        ? ['The workspace is empty. promenade_list_sample_logs then promenade_import_sample_log, '
           + 'or ask the user to import their own log.']
        : ['promenade_list_actions with an artifactId shows what can be run on it.',
           'promenade_search_plugins finds a plugin for something no installed action covers.'],
    };
  },

  listArtifacts(args: { type?: string; query?: string; limit?: number }) {
    const all = Object.values(agentHost().getGraph().artifacts);
    const q = args.query?.toLowerCase();
    const filtered = all.filter((a) =>
      (!args.type || a.type === args.type)
      && (!q || a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)));
    const limit = Math.min(Math.max(1, args.limit ?? 50), 200);
    return {
      total: filtered.length,
      artifacts: filtered
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(summarize),
    };
  },

  getArtifact(args: { artifactId: string }) {
    const a = artifactOr404(args.artifactId);
    const g = agentHost().getGraph();
    const exec = a.producedBy ? g.executions[a.producedBy] : null;
    const def = exec ? actionRegistry.get(exec.actionId) : undefined;
    const logical = logicalTablesOf(a);
    return {
      ...summarize(a),
      meta: trim(a.meta),
      storage: a.storage.kind,
      tables: logical.map((name) => ({ logical: name, sql: tableOf(a.id, name) })),
      provenance: exec ? {
        executionId: exec.id,
        actionId: exec.actionId,
        actionLabel: def?.label ?? exec.actionId,
        actionDescription: def?.description,
        actionVersion: exec.actionVersion,
        params: trim(exec.params),
        runtime: exec.runtime,
        durationMs: exec.durationMs,
        inputs: exec.inputs,
        /** What `promenade_set_parameters` may change on this artifact. */
        adjustableParams: def ? paramSummary(def.params) : {},
      } : null,
      views: viewsFor(a).map((v) => ({
        viewId: v.id, label: v.label, provider: v.provider,
        primary: !!v.primary, isDefault: v.id === defaultViewFor(a)?.id,
      })),
      derivedArtifacts: Object.values(g.artifacts)
        .filter((x) => (x.inputs ?? []).includes(a.id)).map((x) => x.id),
    };
  },

  listActions(args: { artifactIds?: string[] }) {
    const ids = args.artifactIds?.length ? args.artifactIds : agentHost().getSelection();
    const artifacts = ids.map(artifactOr404);
    if (!artifacts.length) {
      return {
        note: 'No artifact given and nothing is selected — pass artifactIds.',
        actions: [],
      };
    }
    const rows = actionRegistry.applicableTo(artifacts).map(({ action, applicable, missing, unmet }) => ({
      actionId: action.id,
      label: action.label,
      description: action.description,
      whenToUse: action.agent?.whenToUse,
      notFor: action.agent?.notFor,
      examples: action.agent?.examples,
      /**
       * Where the prose above comes from. A plugin's manifest is not vetted
       * by the host, so its text is passed on labeled rather than presented
       * as the host's own. It describes; it never authorises.
       */
      textFrom: action.trusted ? 'host' : `plugin ${action.provider} (unverified)`,
      provider: action.provider,
      runtime: action.runtime,
      applicable: applicable && action.implemented !== false,
      outputs: (action.outputs ?? []).map((o) => o.type),
      params: paramSummary(action.params),
      missingInputs: missing.map((s) => ({ slot: s.name, type: s.type, hint: s.label })),
      unmetRequirements: unmet.map((u) => ({ slot: u.slot.name, needs: u.capabilities })),
      opensView: action.opensView,
      notImplemented: action.implemented === false || undefined,
    }));
    return {
      forArtifacts: artifacts.map((a) => ({ id: a.id, type: a.type })),
      actions: rows.sort((a, b) => Number(b.applicable) - Number(a.applicable)),
    };
  },

  async runAction(args: {
    actionId: string;
    artifactIds?: string[];
    params?: Record<string, unknown>;
    openView?: boolean;
  }) {
    const def = actionRegistry.get(args.actionId);
    if (!def) {
      const near = actionRegistry.all()
        .filter((a) => !a.internal && a.id.toLowerCase().includes(args.actionId.toLowerCase().split('.').pop() ?? ''))
        .slice(0, 5).map((a) => a.id);
      throw new Error(
        `No action '${args.actionId}' is registered.`
        + (near.length ? ` Did you mean: ${near.join(', ')}?` : '')
        + ' Use promenade_list_actions, or promenade_search_plugins to find a plugin that provides it.',
      );
    }
    if (def.implemented === false) {
      throw new Error(`'${def.label}' is declared but has no runnable implementation in this build.`);
    }
    const ids = args.artifactIds?.length ? args.artifactIds : agentHost().getSelection();
    // A manufacturing action (`inputs: []`) has nothing to select in the
    // first place -- its own `file` param carries everything.
    if (!ids.length && def.inputs.length > 0) {
      throw new Error(`${def.label}: pass artifactIds (nothing is selected).`);
    }
    const inputs = resolveSlots(def as any, ids);
    const params = mergeParams(def.params, args.params, def.label);
    const primary = ids.length
      ? artifactOr404(Object.values(inputs).flat()[0] ?? ids[0])
      : undefined;

    const started = Date.now();
    const producedId = await agentHost().runAction(def.id, { input: primary, inputs, params });
    if (!producedId) {
      return {
        actionId: def.id,
        ran: true,
        durationMs: Date.now() - started,
        note: def.opensView
          ? `'${def.label}' opens a view rather than producing an artifact; it is now on screen.`
          : 'The run produced no artifact (it was superseded or canceled).',
      };
    }
    const produced = await settledArtifact(producedId);
    return {
      actionId: def.id,
      durationMs: Date.now() - started,
      params: trim(params),
      artifact: produced ? { ...summarize(produced), meta: trim(produced.meta) } : { id: producedId },
    };
  },

  async setParameters(args: { artifactId: string; params: Record<string, unknown> }) {
    const a = artifactOr404(args.artifactId);
    const g = agentHost().getGraph();
    const exec = a.producedBy ? g.executions[a.producedBy] : null;
    if (!exec) throw new Error(`'${a.name}' was imported, not computed — it has no parameters.`);
    const def = actionRegistry.get(exec.actionId);
    if (!def) throw new Error(`The action '${exec.actionId}' that produced this artifact is not installed.`);
    // The producing execution's own parameters are the base, so a caller may
    // send only the one it wants to move — the same contract the Inspector's
    // sliders use.
    const params = { ...exec.params, ...mergeParams(def.params, args.params, def.label) };
    await agentHost().recompute(a, params);
    await afterRender();
    const after = agentHost().getGraph().artifacts[a.id] ?? a;
    return {
      artifactId: a.id,
      actionId: exec.actionId,
      params: trim(params),
      meta: trim(after.meta),
      note: 'Artifacts derived from this one are now marked stale; recompute them explicitly if needed.',
    };
  },

  listViews(args: { artifactId: string }) {
    const a = artifactOr404(args.artifactId);
    const candidates = viewsFor(a);
    return {
      artifactId: a.id,
      defaultViewId: defaultViewFor(a)?.id ?? null,
      views: candidates.map((v) => ({
        viewId: v.id, label: v.label, provider: v.provider,
        primary: !!v.primary, params: paramSummary(v.params),
      })),
    };
  },

  openView(args: { artifactId: string; viewId?: string; params?: Record<string, unknown> }) {
    const a = artifactOr404(args.artifactId);
    const candidates = viewsFor(a);
    const view = args.viewId
      ? candidates.find((v) => v.id === args.viewId)
      : defaultViewFor(a);
    if (!view) {
      // No renderer for this type is a real, actionable gap rather than a
      // reason to open something generic: a provenance diagram is not an
      // answer to "show me this Petri net". The registry knows who could
      // render it, so say so.
      throw new Error(
        args.viewId
          ? `No view '${args.viewId}' applies to a ${a.type}. Available: ${candidates.map((v) => v.id).join(', ') || 'none'}`
          : `Nothing installed can render a ${a.type}. Call promenade_search_plugins with `
            + `forArtifactType: "${a.type}" to find a viewer, then promenade_install_plugin. `
            + `Generic panels that would still open: ${candidates.map((v) => v.id).join(', ') || 'none'}.`,
      );
    }
    const params = args.params ? mergeParams(view.params, args.params, view.label) : undefined;
    agentHost().openView(a, view.id, params);
    agentHost().setSelection([a.id]);
    return { artifactId: a.id, viewId: view.id, label: view.label, opened: true };
  },

  selectArtifacts(args: { artifactIds: string[] }) {
    const ids = args.artifactIds.map((id) => artifactOr404(id).id);
    agentHost().setSelection(ids);
    return { selection: ids };
  },

  async query(args: { artifactId: string; op: string; columns?: string[]; limit?: number }) {
    const a = artifactOr404(args.artifactId);
    const limit = Math.min(Math.max(1, args.limit ?? 50), 1000);
    const sql = buildQuerySql(a, { artifactId: a.id, op: args.op as any, columns: args.columns, limit });
    const table = await dataClient.sql(sql);
    const rows = rowsOf(table, limit);
    return { artifactId: a.id, op: args.op, rowCount: rows.length, rows };
  },

  async sql(args: { sql: string; limit?: number }) {
    const text = args.sql.trim().replace(/;\s*$/, '');
    if (text.includes(';')) throw new Error('One statement at a time, please.');
    if (!/^\s*(with|select|describe|summarize|explain|show|pragma)\b/i.test(text)) {
      throw new Error('Only read queries are allowed here (SELECT / WITH / DESCRIBE / SUMMARIZE / SHOW).');
    }
    if (/\b(attach|copy|create|insert|update|delete|drop|alter|install|load|export|import)\b/i.test(text)) {
      throw new Error('That statement writes or loads something; the agent SQL door is read-only.');
    }
    const limit = Math.min(Math.max(1, args.limit ?? 100), 1000);
    const wrapped = /^\s*(with|select)\b/i.test(text)
      ? `SELECT * FROM (${text}) AS agent_query LIMIT ${limit}`
      : text;
    const table = await dataClient.sql(wrapped);
    const rows = rowsOf(table, limit);
    return { rowCount: rows.length, rows };
  },

  /* ---------------- plugins ---------------- */

  async listPlugins() {
    const installed = await listInstalled();
    const indexes = await registryIndexes();
    const updates = await findUpdates(indexes);
    return {
      plugins: installed.map((p) => ({
        pluginId: p.manifest.id,
        name: p.manifest.name ?? p.manifest.id,
        version: p.manifest.version,
        source: p.source?.kind ?? 'unknown',
        actions: (p.manifest.actions ?? []).map((a) => ({ actionId: a.id, label: a.label })),
        views: (p.manifest.views ?? []).map((v) => ({ viewId: v.id, label: v.label })),
        artifactTypes: (p.manifest.artifactTypes ?? []).map((t) => t.id),
        updateTo: updates.find((u) => u.entry.id === p.manifest.id)?.version.version,
      })),
      registries: indexes.map((i) => ({ name: i.name, url: i.sourceUrl, entries: i.plugins.length })),
    };
  },

  /**
   * A plugin's own documentation, out of the installed package.
   *
   * Every `.pmplugin` already ships its README and any `docs/` pages — that is
   * where an author explains the method, its assumptions and its citation. The
   * host had no way to hand that to a caller, so an agent had to infer a
   * plugin's semantics from ids and types. This needs no new manifest surface
   * at all; it reads what is already in the package.
   *
   * Deliberately restricted to Markdown that is actually in the package: this
   * is a documentation door, not a way to read a plugin's binaries or source.
   */
  async pluginDocs(args: { pluginId: string; path?: string }) {
    const installed = await listInstalled();
    const p = installed.find((x) => x.manifest.id === args.pluginId);
    if (!p) {
      throw new Error(
        `'${args.pluginId}' is not installed. promenade_list_plugins shows what is, `
        + 'promenade_search_plugins what could be.',
      );
    }
    const m = p.manifest;
    const files = new Set(await listPluginFiles(args.pluginId));
    const seen = new Set<string>();
    const declared: Array<{ path: string; title: string }> = [];
    for (const page of [
      { path: m.readme ?? 'README.md', title: 'README' },
      ...(m.docs ?? []).map((d) => ({ path: d.path, title: d.title })),
      // A changelog is worth offering whether or not the manifest lists it as
      // a docs page — several packages do both, hence the dedupe.
      { path: 'CHANGELOG.md', title: 'Changelog' },
    ]) {
      if (!files.has(page.path) || seen.has(page.path)) continue;
      seen.add(page.path);
      declared.push(page);
    }
    // A package may ship Markdown it never declared; listing it is more
    // useful than pretending the pages are exactly what the manifest names.
    const extra = [...files]
      .filter((f) => f.toLowerCase().endsWith('.md') && !seen.has(f))
      .map((f) => ({ path: f, title: f }));
    const pages = [...declared, ...extra];

    const wanted = args.path ?? pages[0]?.path;
    let content: string | undefined;
    let truncated = false;
    if (wanted) {
      if (!pages.some((pg) => pg.path === wanted)) {
        throw new Error(
          `'${wanted}' is not one of this package's documentation pages: `
          + `${pages.map((pg) => pg.path).join(', ') || 'none'}`,
        );
      }
      const raw = new TextDecoder().decode(await readPluginFile(args.pluginId, wanted));
      truncated = raw.length > 20_000;
      content = truncated ? `${raw.slice(0, 20_000)}\n\n… truncated (${raw.length} characters)` : raw;
    }

    return {
      pluginId: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      authors: m.authors ?? (m.author ? [{ name: m.author }] : []),
      citation: m.citation,
      homepage: m.homepage,
      license: m.license,
      actions: (m.actions ?? []).map((a) => ({
        actionId: a.id, label: a.label, description: a.description, agent: a.agent,
      })),
      pages,
      page: wanted ?? null,
      content,
      truncated: truncated || undefined,
      textFrom: `plugin ${m.id} (unverified)`,
    };
  },

  /**
   * Registry search — "which plugin would do this?".
   *
   * The registry already carries what an agent needs to answer that without
   * installing anything: what a package produces, what it can render, and what
   * it is about. `forArtifactType` is the question the host itself asks when
   * an artifact has no viewer, and it is the same one here.
   */
  async searchPlugins(args: {
    query?: string;
    forArtifactType?: string;
    produces?: string;
    includeInstalled?: boolean;
    limit?: number;
  }) {
    const indexes = await registryIndexes();
    const installed = await listInstalled();
    const installedVersions = new Map(installed.map((p) => [p.manifest.id, p.manifest.version]));
    const q = args.query?.toLowerCase().trim();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];

    const scored: Array<{ score: number; row: ReturnType<typeof entryView>; why: string[] }> = [];
    for (const index of indexes) {
      for (const entry of index.plugins) {
        const installedVersion = installedVersions.get(entry.id);
        if (installedVersion && !args.includeInstalled && !args.forArtifactType) continue;
        const why: string[] = [];
        let score = 0;
        if (args.forArtifactType) {
          const renders = entry.renders ?? entry.consumes ?? [];
          if (renders.includes(args.forArtifactType)) { score += 6; why.push(`renders ${args.forArtifactType}`); }
          if ((entry.provides ?? []).includes(args.forArtifactType)) { score += 4; why.push(`produces ${args.forArtifactType}`); }
          if ((entry.accepts ?? []).includes(args.forArtifactType)) { score += 2; why.push(`has an action taking ${args.forArtifactType}`); }
          if (!why.length) continue;
        }
        if (args.produces) {
          if (!(entry.provides ?? []).includes(args.produces)) continue;
          score += 6; why.push(`produces ${args.produces}`);
        }
        if (terms.length) {
          const haystack = [entry.id, entry.name, entry.description ?? '', ...(entry.keywords ?? []),
            ...(entry.provides ?? []), ...(entry.consumes ?? []), ...(entry.renders ?? []),
            ...(entry.accepts ?? [])].join(' ').toLowerCase();
          const hits = terms.filter((t) => haystack.includes(t));
          // Action-level text is what makes a package with five actions
          // distinguishable from outside: a match there is worth more than one
          // in the package blurb, and it can say *which* action matched.
          const actionHits = (entry.actions ?? []).filter((a) => {
            const text = `${a.id} ${a.label} ${a.description ?? ''} `
              + `${(a.inputs ?? []).join(' ')} ${(a.outputs ?? []).join(' ')}`;
            return terms.some((t) => text.toLowerCase().includes(t));
          });
          if (!hits.length && !actionHits.length && !why.length) continue;
          score += hits.length * 2 + actionHits.length * 3;
          if (hits.length) why.push(`matches ${hits.join(', ')}`);
          for (const a of actionHits.slice(0, 3)) why.push(`action "${a.label}"`);
        }
        if (!terms.length && !args.forArtifactType && !args.produces) score += 1;
        scored.push({ score, row: entryView(entry, index, installedVersion), why });
      }
    }
    scored.sort((a, b) => b.score - a.score || Number(a.row.experimental) - Number(b.row.experimental));
    const limit = Math.min(Math.max(1, args.limit ?? 12), 50);
    return {
      registries: indexes.map((i) => i.name),
      results: scored.slice(0, limit).map(({ row, why }) => ({ ...row, why })),
      note: indexes.length ? undefined : 'No plugin registry is reachable from this workspace.',
    };
  },

  async installPlugin(args: { pluginId: string; version?: string }) {
    const indexes = await registryIndexes(true);
    for (const index of indexes) {
      const entry = index.plugins.find((e) => e.id === args.pluginId);
      if (!entry) continue;
      const version = args.version
        ? entry.versions.find((v) => v.version === args.version)
        : latestOf(entry);
      if (!version) {
        throw new Error(
          `${args.pluginId} has no version ${args.version}. Available: `
          + entry.versions.map((v) => v.version).join(', '),
        );
      }
      const result = await installFromRegistry(index, entry, version);
      if (!result.ok) throw new Error(result.errors.join('; '));
      await agentHost().pluginsChanged();
      const m = result.plugin!.manifest;
      return {
        pluginId: m.id,
        version: m.version,
        registry: index.name,
        // What the workspace can do *now* that it could not a moment ago —
        // the only part of an install an agent can act on.
        newActions: (m.actions ?? []).map((a) => ({ actionId: a.id, label: a.label })),
        newViews: (m.views ?? []).map((v) => ({ viewId: v.id, label: v.label })),
        newArtifactTypes: (m.artifactTypes ?? []).map((t) => t.id),
      };
    }
    throw new Error(
      `No registry offers '${args.pluginId}'. Use promenade_search_plugins to see what is available.`,
    );
  },

  async removePlugin(args: { pluginId: string }) {
    const installed = await listInstalled();
    if (!installed.some((p) => p.manifest.id === args.pluginId)) {
      throw new Error(`'${args.pluginId}' is not installed.`);
    }
    await agentHost().removePlugin(args.pluginId);
    return {
      pluginId: args.pluginId,
      removed: true,
      note: 'Artifacts of this plugin\'s types stay in the workspace, flagged as not recomputable.',
    };
  },

  /* ---------------- data in ---------------- */

  listSampleLogs() {
    return {
      samples: SAMPLE_LOGS.map((s) => ({
        sampleId: s.id, name: s.name, format: s.format, size: s.size,
        category: s.category, description: s.description, large: !!s.large,
      })),
    };
  },

  async importSampleLog(args: { sampleId: string }) {
    const sample = SAMPLE_LOGS.find((s) => s.id === args.sampleId);
    if (!sample) {
      throw new Error(`No sample '${args.sampleId}'. Call promenade_list_sample_logs.`);
    }
    const id = await agentHost().importSample(sample.id);
    const a = id ? await settledArtifact(id) : undefined;
    return {
      sampleId: sample.id,
      artifact: a ? { ...summarize(a), meta: trim(a.meta) } : { id, name: sample.name },
    };
  },

  /* ---------------- housekeeping ---------------- */

  async renameArtifact(args: { artifactId: string; name: string }) {
    const a = artifactOr404(args.artifactId);
    const name = args.name.trim();
    if (!name) throw new Error('A name cannot be empty.');
    await agentHost().renameArtifact(a.id, name);
    await afterRender();
    return { artifactId: a.id, name };
  },

  async deleteArtifact(args: { artifactId: string }) {
    const a = artifactOr404(args.artifactId);
    const g = agentHost().getGraph();
    const cascade = Object.values(g.artifacts).filter((x) => (x.inputs ?? []).includes(a.id)).length;
    await agentHost().deleteArtifact(a.id);
    // Read-back consistency: a caller that lists artifacts on the next line
    // should not still see what it just deleted.
    await afterRender();
    return { artifactId: a.id, deleted: true, alsoRemovedDerived: cascade };
  },
};

export type PromenadeApi = typeof promenadeApi;
