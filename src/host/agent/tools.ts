/**
 * The tool catalog and the one dispatch path every transport goes through.
 *
 * Two design decisions are load-bearing here.
 *
 * **Few, stable meta-tools.** Promenade's capabilities live in installed
 * plugins, and there may eventually be hundreds. Registering one tool per
 * plugin action would make the tool list a moving target the size of the
 * ecosystem. Instead the tools are the *host's* vocabulary — list actions, read
 * a parameter schema, run one, adjust it — and the plugin ecosystem is data
 * those tools return. An agent trained before a plugin existed can still use it.
 *
 * **One dispatch.** Consent and journaling are applied here, not in each
 * adapter, so a new transport (an MCP bridge, a notebook, an in-app assistant)
 * cannot arrive without them.
 */

import type { AgentCallResult, AgentSource, AgentTool, AgentToolSchema } from './types';
import { promenadeApi } from './api';
import { dispatch, fail } from './dispatch';

type Args = Record<string, unknown>;

function schema(properties: Record<string, unknown>, required: string[] = []): AgentToolSchema {
  return { type: 'object', properties, required };
}

const artifactId = { type: 'string', description: 'Artifact id from promenade_list_artifacts.' };

/**
 * The catalog.
 *
 * Descriptions are written for a reader who has never seen Promenade: they say
 * what the thing is in process-mining terms, and where the next step lives.
 */
export const agentTools: AgentTool[] = [
  {
    name: 'promenade_overview',
    op: 'read',
    description:
      'Start here. Summarizes the open Promenade workspace: how many artifacts (event logs, '
      + 'process models, analysis results) it holds, what is selected, which views are open, '
      + 'which plugins are installed, and what to do next.',
    inputSchema: schema({}),
    summarize: () => 'read the workspace overview',
    run: () => promenadeApi.overview(),
  },
  {
    name: 'promenade_list_artifacts',
    op: 'read',
    description:
      'Lists artifacts in the workspace. An artifact is a named, typed piece of data with '
      + 'recorded provenance — an imported event log, a discovered model, an analysis result.',
    inputSchema: schema({
      type: { type: 'string', description: 'Filter by artifact type, e.g. ObjectCentricEventLog, AcceptingPetriNet.' },
      query: { type: 'string', description: 'Substring match on name or id.' },
      limit: { type: 'number', description: 'Default 50, max 200.' },
    }),
    summarize: (a) => `list artifacts${a.type ? ` of type ${a.type}` : ''}`,
    run: (a) => promenadeApi.listArtifacts(a as any),
  },
  {
    name: 'promenade_get_artifact',
    op: 'read',
    description:
      'Everything about one artifact: its metadata, how it was produced (action, parameters, '
      + 'runtime), which parameters can still be adjusted, which views can render it, which '
      + 'SQL tables it exposes, and what was derived from it.',
    inputSchema: schema({ artifactId }, ['artifactId']),
    summarize: (a) => `read artifact ${a.artifactId}`,
    run: (a) => promenadeApi.getArtifact(a as any),
  },
  {
    name: 'promenade_list_actions',
    op: 'read',
    description:
      'Which actions apply to the given artifacts, with their parameter schemas. Actions come '
      + 'from installed plugins (miners, conformance checkers, transformations) plus the host '
      + 'itself. Also reports what an action is still missing — e.g. an alignment needs both a '
      + 'log and a Petri net selected.',
    inputSchema: schema({
      artifactIds: { type: 'array', items: { type: 'string' }, description: 'Defaults to the current selection.' },
    }),
    summarize: (a) => `list applicable actions${(a.artifactIds as string[])?.length ? ` for ${(a.artifactIds as string[]).join(', ')}` : ''}`,
    run: (a) => promenadeApi.listActions(a as any),
  },
  {
    name: 'promenade_run_action',
    op: 'run',
    description:
      'Runs one action and records it in the provenance graph, exactly as clicking it would: '
      + 'the result becomes a new artifact and its view opens. Read the parameter schema from '
      + 'promenade_list_actions first; omitted parameters take their declared defaults.',
    inputSchema: schema({
      actionId: { type: 'string', description: 'Action id, e.g. core.discover.dfg.' },
      artifactIds: {
        type: 'array', items: { type: 'string' },
        description: 'Input artifacts, in the order the action\'s input slots should be filled. '
          + 'Defaults to the current selection.',
      },
      params: { type: 'object', description: 'Parameter values; unknown keys are rejected.' },
    }, ['actionId']),
    summarize: (a) => `run ${a.actionId}${(a.artifactIds as string[])?.length ? ` on ${(a.artifactIds as string[]).join(', ')}` : ''}`,
    run: (a) => promenadeApi.runAction(a as any),
  },
  {
    name: 'promenade_set_parameters',
    op: 'run',
    description:
      'Re-runs an existing artifact with different parameters, in place — the same live loop the '
      + 'inspector sliders drive. The artifact keeps its id and every open view of it updates. '
      + 'Use this to tune a result (a noise threshold, a filter) instead of running the action again.',
    inputSchema: schema({
      artifactId,
      params: { type: 'object', description: 'Only the parameters to change; the rest keep their current values.' },
    }, ['artifactId', 'params']),
    summarize: (a) => `re-run ${a.artifactId} with ${JSON.stringify(a.params ?? {})}`,
    run: (a) => promenadeApi.setParameters(a as any),
  },
  {
    name: 'promenade_list_views',
    op: 'read',
    description: 'Views that can render an artifact, with the parameters each view accepts.',
    inputSchema: schema({ artifactId }, ['artifactId']),
    summarize: (a) => `list views for ${a.artifactId}`,
    run: (a) => promenadeApi.listViews(a as any),
  },
  {
    name: 'promenade_open_view',
    op: 'ui',
    description:
      'Opens an artifact in a view panel so the user can see it. Without a viewId the artifact\'s '
      + 'primary view is used.',
    inputSchema: schema({
      artifactId,
      viewId: { type: 'string' },
      params: { type: 'object', description: 'Initial view parameters.' },
    }, ['artifactId']),
    summarize: (a) => `open ${a.artifactId}${a.viewId ? ` in ${a.viewId}` : ''}`,
    run: async (a) => promenadeApi.openView(a as any),
  },
  {
    name: 'promenade_select_artifacts',
    op: 'ui',
    description:
      'Sets the workspace selection, so the user sees which artifacts are being worked on and '
      + 'multi-input actions have their inputs picked out.',
    inputSchema: schema({
      artifactIds: { type: 'array', items: { type: 'string' } },
    }, ['artifactIds']),
    summarize: (a) => `select ${(a.artifactIds as string[])?.join(', ')}`,
    run: async (a) => promenadeApi.selectArtifacts(a as any),
  },
  {
    name: 'promenade_query',
    op: 'read',
    description:
      'Reads rows out of a log artifact through a named, safe query: events, cases, variants, '
      + 'activities, attributes (traditional logs) or objects, e2o, o2o, event_attributes, '
      + 'object_attributes (object-centric logs).',
    inputSchema: schema({
      artifactId,
      op: {
        type: 'string',
        enum: ['events', 'cases', 'variants', 'activities', 'attributes',
          'objects', 'e2o', 'o2o', 'event_attributes', 'object_attributes'],
      },
      columns: { type: 'array', items: { type: 'string' } },
      limit: { type: 'number', description: 'Default 50, max 1000.' },
    }, ['artifactId', 'op']),
    summarize: (a) => `query ${a.op} of ${a.artifactId}`,
    run: (a) => promenadeApi.query(a as any),
  },
  {
    name: 'promenade_sql',
    op: 'read',
    description:
      'Runs one read-only DuckDB query against the workspace. Physical table names come from '
      + 'promenade_get_artifact (`tables[].sql`). Writes, ATTACH, COPY and extension loading are refused.',
    inputSchema: schema({
      sql: { type: 'string' },
      limit: { type: 'number', description: 'Row cap, default 100, max 1000.' },
    }, ['sql']),
    summarize: (a) => `SQL: ${String(a.sql ?? '').replace(/\s+/g, ' ').slice(0, 90)}`,
    run: (a) => promenadeApi.sql(a as any),
  },
  {
    name: 'promenade_list_plugins',
    op: 'read',
    description:
      'Installed plugins with their versions, the actions and views each contributes, and '
      + 'whether a registry offers a newer build.',
    inputSchema: schema({}),
    summarize: () => 'list installed plugins',
    run: () => promenadeApi.listPlugins(),
  },
  {
    name: 'promenade_plugin_docs',
    op: 'read',
    description:
      'An installed plugin\'s own documentation — README, docs/ pages, changelog — plus its '
      + 'authors, citation and the actions it contributes. This is where a plugin author explains '
      + 'the method, its assumptions and its limits; read it before running an unfamiliar action.',
    inputSchema: schema({
      pluginId: { type: 'string' },
      path: { type: 'string', description: 'One of the pages listed by a previous call. Defaults to the README.' },
    }, ['pluginId']),
    summarize: (a) => `read docs of ${a.pluginId}${a.path ? ` (${a.path})` : ''}`,
    run: (a) => promenadeApi.pluginDocs(a as any),
  },
  {
    name: 'promenade_search_plugins',
    op: 'read',
    description:
      'Searches the configured plugin registries for a package that would do what is being asked '
      + '— by keyword, by the artifact type it can render (forArtifactType), or by what it '
      + 'produces. Matches the individual actions a package contributes, not just its blurb, and '
      + 'returns them with their input and output types, so a package can be judged before it is '
      + 'installed. Use this whenever no installed action covers the request.',
    inputSchema: schema({
      query: { type: 'string', description: 'Free text, e.g. "petri net conformance" or "object-centric".' },
      forArtifactType: { type: 'string', description: 'Find plugins that can render or produce this artifact type.' },
      produces: { type: 'string', description: 'Find plugins producing this artifact type.' },
      includeInstalled: { type: 'boolean' },
      limit: { type: 'number' },
    }),
    summarize: (a) => `search plugin registry for ${a.query ?? a.forArtifactType ?? a.produces ?? 'everything'}`,
    run: (a) => promenadeApi.searchPlugins(a as any),
  },
  {
    name: 'promenade_install_plugin',
    op: 'install',
    description:
      'Installs a plugin from a configured registry (checksum-verified) and registers its actions, '
      + 'views and artifact types immediately. Returns what became available.',
    inputSchema: schema({
      pluginId: { type: 'string' },
      version: { type: 'string', description: 'Defaults to the newest version.' },
    }, ['pluginId']),
    summarize: (a) => `install plugin ${a.pluginId}${a.version ? `@${a.version}` : ''}`,
    run: (a) => promenadeApi.installPlugin(a as any),
  },
  {
    name: 'promenade_remove_plugin',
    op: 'destructive',
    description:
      'Removes an installed plugin. Artifacts of its types stay in the workspace, flagged as no '
      + 'longer recomputable.',
    inputSchema: schema({ pluginId: { type: 'string' } }, ['pluginId']),
    summarize: (a) => `remove plugin ${a.pluginId}`,
    run: (a) => promenadeApi.removePlugin(a as any),
  },
  {
    name: 'promenade_list_sample_logs',
    op: 'read',
    description: 'Public sample event logs Promenade can import directly, for an empty workspace or a demo.',
    inputSchema: schema({}),
    summarize: () => 'list sample logs',
    run: async () => promenadeApi.listSampleLogs(),
  },
  {
    name: 'promenade_import_sample_log',
    op: 'run',
    description: 'Downloads and imports one sample event log, producing a log artifact.',
    inputSchema: schema({ sampleId: { type: 'string' } }, ['sampleId']),
    summarize: (a) => `import sample log ${a.sampleId}`,
    run: (a) => promenadeApi.importSampleLog(a as any),
  },
  {
    name: 'promenade_rename_artifact',
    op: 'write',
    description: 'Renames an artifact.',
    inputSchema: schema({ artifactId, name: { type: 'string' } }, ['artifactId', 'name']),
    summarize: (a) => `rename ${a.artifactId} to "${a.name}"`,
    run: (a) => promenadeApi.renameArtifact(a as any),
  },
  {
    name: 'promenade_delete_artifact',
    op: 'destructive',
    description:
      'Deletes an artifact and everything derived from it. Irreversible; always confirmed by the user.',
    inputSchema: schema({ artifactId }, ['artifactId']),
    summarize: (a) => `delete artifact ${a.artifactId} and everything derived from it`,
    run: (a) => promenadeApi.deleteArtifact(a as any),
  },
];

export function toolByName(name: string): AgentTool | undefined {
  return agentTools.find((t) => t.name === name);
}

/** MCP-shaped descriptors, for WebMCP and for any bridge relaying them. */
export function toolDescriptors() {
  return agentTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    /** Non-standard but honest: what this call would do to the workspace. */
    annotations: {
      readOnlyHint: t.op === 'read',
      destructiveHint: t.op === 'destructive',
      promenadeOp: t.op,
    },
  }));
}

/**
 * The single entry point. Resolves the tool, then hands it to `dispatch`,
 * which is where consent and journaling live.
 */
export async function callTool(
  name: string, rawArgs: unknown, source: AgentSource,
): Promise<AgentCallResult> {
  const tool = toolByName(name);
  if (!tool) return fail(`Unknown tool '${name}'. Available: ${agentTools.map((t) => t.name).join(', ')}`);
  return dispatch(tool, rawArgs, source);
}
