/**
 * Workspace export/import bundle assembly — main-thread only.
 *
 * Deliberately not in the data worker: knowing which plugin (and which
 * currently-installed version) owns an artifact's producing action or a
 * saved view's renderer means asking `actionRegistry`/`viewRegistry`, and
 * those live only on the main thread (the worker never registers plugin
 * declarations — see the note in `worker/data-worker.ts`'s import block).
 * `host/plugins/store.ts`'s `listPluginFiles`/`readPluginFile` are likewise
 * main-thread-only, for the same reason `store.ts` cannot be imported into
 * the worker at all (it transitively imports `data/client.ts`, which spawns
 * the worker). The worker's own role stays narrow: gather and later write
 * back the catalog, saved views and Parquet bytes it already owns (see
 * `DataClient.exportWorkspaceData`/`importWorkspaceData`).
 */
import { zipSync, unzipSync } from 'fflate';
import { actionRegistry } from '../actions/registry';
import { listPluginFiles, readPluginFile, type InstalledPlugin } from '../plugins/store';
import type { Artifact, ActionExecution } from '../artifact/types';
import type { SavedView } from '../views/savedViews';
import type { WorkspaceMeta } from './opfs';

const BUNDLE_VERSION = 1;

export interface WorkspaceExportSource {
  meta: WorkspaceMeta;
  artifacts: Record<string, Artifact>;
  executions: Record<string, ActionExecution>;
  views: SavedView[];
  /** `<artifactId>/<table>.parquet` -> file bytes. */
  files: Record<string, Uint8Array>;
}

export interface WorkspacePluginUsage {
  /** Plugin id -> its currently-installed version, for every plugin that
   * produced something in this workspace. */
  pluginVersions: Record<string, string>;
  /** The ids among those that are locally-sourced — the only ones export can
   * meaningfully bundle, since a registry or bundled package is reproducible
   * from its own known source (see `PluginInstallSource`). */
  localPluginIds: string[];
}

/** Resolves which plugins produced this workspace's artifacts/views, and
 * which of those are local-only. */
export function pluginUsageOf(
  executions: Record<string, ActionExecution>, views: SavedView[], plugins: InstalledPlugin[]
): WorkspacePluginUsage {
  const pluginVersions: Record<string, string> = {};
  const stamp = (id: string | undefined) => {
    if (!id || id === 'core') return;
    const installed = plugins.find((p) => p.manifest.id === id);
    if (installed) pluginVersions[id] = installed.manifest.version;
  };
  for (const exec of Object.values(executions)) stamp(actionRegistry.get(exec.actionId)?.provider);
  for (const v of views) stamp(v.providerId);
  const localPluginIds = Object.keys(pluginVersions)
    .filter((id) => plugins.find((p) => p.manifest.id === id)?.source?.kind === 'local');
  return { pluginVersions, localPluginIds };
}

export async function buildWorkspaceBundle(
  source: WorkspaceExportSource, plugins: InstalledPlugin[], includeLocalPlugins: boolean
): Promise<Uint8Array> {
  const { pluginVersions, localPluginIds } = pluginUsageOf(source.executions, source.views, plugins);
  const encoder = new TextEncoder();

  const zipEntries: Record<string, Uint8Array> = {
    'workspace.json': encoder.encode(JSON.stringify({
      id: source.meta.id,
      name: source.meta.name,
      exportedAt: new Date().toISOString(),
      bundleVersion: BUNDLE_VERSION,
      artifacts: source.artifacts,
      executions: source.executions,
      pluginVersions,
    }, null, 2)),
    'saved-views.json': encoder.encode(JSON.stringify(source.views, null, 2)),
  };
  for (const [path, bytes] of Object.entries(source.files)) zipEntries[`artifacts/${path}`] = bytes;

  if (includeLocalPlugins) {
    for (const id of localPluginIds) {
      const names = await listPluginFiles(id);
      const entries: Record<string, Uint8Array> = {};
      for (const name of names) entries[name] = await readPluginFile(id, name);
      // Nested zip: a self-contained `.pmplugin` blob, so import can hand
      // it straight back to `installPackage()` unchanged.
      zipEntries[`plugins/${id}.pmplugin`] = zipSync(entries);
    }
  }

  return zipSync(zipEntries);
}

export interface ParsedWorkspaceBundle {
  name: string;
  artifacts: Record<string, Artifact>;
  executions: Record<string, ActionExecution>;
  views: SavedView[];
  /** `<artifactId>/<table>.parquet` -> file bytes, ready for `importWorkspaceData`. */
  files: Record<string, Uint8Array>;
  /** The versions the bundle was produced with — compared against what's
   * currently installed to flag missing/mismatched plugins before import. */
  pluginVersions: Record<string, string>;
  /** Plugin id -> `.pmplugin` package bytes, for plugins the export chose to
   * bundle because they were local-only. */
  localPlugins: Record<string, Uint8Array>;
}

export function parseWorkspaceBundle(bytes: Uint8Array): ParsedWorkspaceBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e: any) {
    throw new Error(`Not a readable workspace bundle: ${e.message}`);
  }
  const decoder = new TextDecoder();
  const workspaceJson = entries['workspace.json'];
  if (!workspaceJson) throw new Error('Not a Promenade workspace bundle: workspace.json is missing.');
  const meta = JSON.parse(decoder.decode(workspaceJson));

  const views: SavedView[] = entries['saved-views.json']
    ? JSON.parse(decoder.decode(entries['saved-views.json']))
    : [];

  const files: Record<string, Uint8Array> = {};
  const localPlugins: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    const artifactMatch = /^artifacts\/(.+)$/.exec(name);
    if (artifactMatch) { files[artifactMatch[1]] = data; continue; }
    const pluginMatch = /^plugins\/([^/]+)\.pmplugin$/.exec(name);
    if (pluginMatch) { localPlugins[pluginMatch[1]] = data; continue; }
  }

  return {
    name: typeof meta.name === 'string' && meta.name ? meta.name : 'Imported workspace',
    artifacts: meta.artifacts ?? {},
    executions: meta.executions ?? {},
    views,
    files,
    pluginVersions: meta.pluginVersions ?? {},
    localPlugins,
  };
}
