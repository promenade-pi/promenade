import { unzipSync } from 'fflate';
import { validateManifest, runtimeOf, computeWasiOf, type PluginManifest } from './manifest';
import { artifactTypes } from '../artifact/registry';
import { actionRegistry } from '../actions/registry';
import { viewRegistry } from '../views/registry';
import { wasmActionRuntime, pyodideActionRuntime, relationalActionRuntime } from './runtimeAdapters';
import { disposeRunnersFor } from './runner';
import type { ActionDef } from '../actions/types';

/**
 * Installed plugin store.
 *
 * Packages live in OPFS under /plugins/<id>/, alongside the record of what
 * they contributed. Installing registers declarations; removing withdraws
 * them — except artifact types, which are never withdrawn, only marked as
 * having no provider. That is what keeps an artifact of a removed plugin's
 * type visible in the tree instead of vanishing.
 */

export interface InstalledPlugin {
  manifest: PluginManifest;
  installedAt: string;
  /** Byte size of the package on disk. */
  bytes: number;
  /**
   * Where this particular package archive came from.  This is deliberately
   * provenance rather than a trust decision: registry archives are still
   * foreign code, but knowing their source lets the UI distinguish a package
   * someone imported from one fetched and checksum-verified from a registry.
   *
   * Older workspaces have no `source` field.  Consumers must therefore keep
   * treating it as unknown instead of retroactively guessing "local".
   */
  source?: PluginInstallSource;
}

export type PluginInstallSource =
  | { kind: 'local' }
  | { kind: 'registry'; name: string; url: string }
  | { kind: 'bundled' }
  | { kind: 'url'; url: string };

const DIR = 'plugins';
const INDEX = 'plugins.json';

async function root() { return navigator.storage.getDirectory(); }
async function pluginDir(id: string, create = true) {
  return (await (await root()).getDirectoryHandle(DIR, { create })).getDirectoryHandle(id, { create });
}

async function readIndex(): Promise<Record<string, InstalledPlugin>> {
  try {
    const h = await (await root()).getFileHandle(INDEX);
    return JSON.parse(await (await h.getFile()).text());
  } catch { return {}; }
}

async function writeIndex(idx: Record<string, InstalledPlugin>) {
  const h = await (await root()).getFileHandle(INDEX, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(idx, null, 2)));
  await w.close();
}

export interface InstallResult {
  ok: boolean;
  errors: string[];
  plugin?: InstalledPlugin;
}

export interface PreviewResult {
  ok: boolean;
  errors: string[];
  manifest?: PluginManifest;
  /** The package's files, in memory. Nothing here has touched OPFS. */
  entries?: Record<string, Uint8Array>;
}

/**
 * Unzips and validates a package without installing it.
 *
 * Shared by `installPackage` and the registry preview: a package the user
 * has not committed to installing yet — a registry browse — still needs to
 * be readable, so its README can be shown before the "Install" button is
 * pressed. Nothing here writes to OPFS or registers anything with the host.
 */
export function previewPackage(bytes: Uint8Array): PreviewResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e: any) {
    return { ok: false, errors: [`not a readable zip: ${e.message}`] };
  }

  const names = new Set(Object.keys(entries).filter((n) => !n.endsWith('/')));
  if (!names.has('manifest.json')) {
    return { ok: false, errors: ['manifest.json missing at the package root'] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
  } catch (e: any) {
    return { ok: false, errors: [`manifest.json is not valid JSON: ${e.message}`] };
  }

  const v = validateManifest(raw, names);
  if (!v.ok || !v.manifest) return { ok: false, errors: v.errors };
  return { ok: true, errors: [], manifest: v.manifest, entries };
}

/**
 * Installs a `.pmplugin` package.
 *
 * Everything is validated before a single byte is written: a package that
 * fails leaves no trace, rather than a directory of files with nothing
 * registered against them.
 */
export async function installPackage(
  bytes: Uint8Array,
  source: PluginInstallSource = { kind: 'local' }
): Promise<InstallResult> {
  const preview = previewPackage(bytes);
  if (!preview.ok || !preview.manifest || !preview.entries) {
    return { ok: false, errors: preview.errors };
  }
  const manifest = preview.manifest;
  const entries = preview.entries;

  const existing = await readIndex();
  if (existing[manifest.id]) {
    // Replace rather than refuse: reinstalling a newer build is the common case.
    await removePlugin(manifest.id, { keepIndex: true });
  }

  const dir = await pluginDir(manifest.id);
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    // Subdirectories are preserved — a docs/ folder with images beside it is
    // the whole point — but the path is checked first: no absolute paths, no
    // `..`, nothing that could write outside the plugin's own directory.
    const parts = name.split('/').filter((p) => p && p !== '.');
    if (name.startsWith('/') || parts.some((p) => p === '..')) continue;

    let target = dir;
    for (const seg of parts.slice(0, -1)) {
      target = await target.getDirectoryHandle(seg, { create: true });
    }
    const fh = await target.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  const plugin: InstalledPlugin = {
    manifest,
    installedAt: new Date().toISOString(),
    bytes: bytes.byteLength,
    source,
  };
  const idx = await readIndex();
  idx[manifest.id] = plugin;
  await writeIndex(idx);

  registerPlugin(manifest);
  return { ok: true, errors: [], plugin };
}

/** Registers a manifest's declarations. No plugin code runs here. */
export function registerPlugin(m: PluginManifest) {
  /**
   * Drop any worker still running this plugin's *previous* build.
   *
   * `runnerFor` caches a `WasmPluginRunner` per `pluginId::actionId` — no
   * version — and each runner keeps the glue and `.wasm` bytes it read from
   * OPFS in `loaded`, which `terminate()` deliberately does not clear. So an
   * upgrade in place used to write the new module to disk and re-register
   * everything declarative (label, params, description all updated, which is
   * what made it look like it had worked) while the action went on executing
   * the old compiled kernel — until the tab was reloaded, or the plugin
   * removed, which was the one path that disposed runners.
   *
   * Keying the cache by version would not be enough: reinstalling the *same*
   * version with rebuilt bytes is the normal plugin-development loop, and it
   * has the identical problem. Re-registering a manifest is the honest signal
   * — it means this package is now authoritative, whatever it says its
   * version is.
   *
   * Cheap and safe to do unconditionally: a fresh install or a session
   * restore has no runners to dispose, and a disposed runner is recreated
   * lazily on the next run.
   */
  disposeRunnersFor(m.id);
  for (const t of m.artifactTypes ?? []) {
    artifactTypes.register({ ...t, provider: m.id, providerInstalled: true });
  }

  for (const a of m.actions ?? []) {
    const runtime = runtimeOf(m, a);
    // `validateManifest` already rejected a manifest where this is
    // unresolvable — installing one that somehow slipped through leaves the
    // action declared but non-executable, which is the honest state for
    // data the host cannot make sense of, not a reason to refuse the rest
    // of the package.
    const adapter = runtime === 'wasm' ? wasmActionRuntime(m, a)
      : runtime === 'pyodide' ? pyodideActionRuntime(m, a)
      : runtime === 'relational' ? relationalActionRuntime(m, a)
      : undefined;

    const def: ActionDef = {
      id: a.id,
      label: a.label,
      // The package's own words about what this action is for. Carried as
      // data, marked untrusted by `trusted: false` below — see AgentNotes.
      description: a.description,
      agent: a.agent,
      version: m.version,
      provider: m.id,
      trusted: false, // installed from a package: foreign code
      runtime: runtime ?? 'wasm',
      memory: a.memory,
      internal: a.internal,
      exportsFile: a.exportsFile,
      // Declarative only here — `runtimeAdapters` still does the producing.
      scans: a.scans,
      scanAction: a.scanAction,
      implemented: !!adapter,
      inputs: a.inputs,
      outputs: a.outputs,
      params: a.params,
      run: adapter?.run,
      computeEligible: runtime === 'wasm' && !!computeWasiOf(m, a),
    };
    actionRegistry.register(def);
  }

  for (const v of m.views ?? []) {
    viewRegistry.register({
      id: v.id,
      label: v.label,
      provider: m.id,
      trusted: false,
      appliesTo: v.appliesTo,
      params: v.params,
      ownsControls: v.ownsControls,
      interactionSelection: v.interactionSelection,
      primary: v.primary,
      livePreview: v.livePreview,
      standalone: v.standalone,
      publishes: v.publishes,
      readsFiles: v.readsFiles,
      readsWorkspace: v.readsWorkspace,
      derivesLogs: v.derivesLogs,
      dock: v.dock,
      // A manifest may point at a host view rather than ship its own; the
      // Alpha Miner does this for the Petri net renderer.
      nativeView: v.native,
      // `kind` is optional: a view that names an entry is sandboxed whether or
      // not it says so. Requiring the word meant a valid manifest registered a
      // view with no renderer at all.
      entry: v.kind !== 'native' && v.entry
        // Preserve subdirectories. A package may keep a view beside its own
        // assets (for example `view/plugin.js`); stripping the path silently
        // turns that valid declaration into a missing root `plugin.js`.
        ? `opfs:${m.id}/${v.entry}`
        : undefined,
    });
  }
}

export async function listInstalled(): Promise<InstalledPlugin[]> {
  return Object.values(await readIndex());
}

/** Re-registers everything on start. Reads only the index, not the packages. */
export async function restoreInstalled(): Promise<InstalledPlugin[]> {
  const all = Object.values(await readIndex());
  for (const p of all) registerPlugin(p.manifest);
  return all;
}

/**
 * Removes a plugin.
 *
 * Actions and views are withdrawn, but the artifact types it contributed stay
 * registered and are flagged as having no provider. Artifacts of those types
 * remain in the tree, still queryable, visibly marked as not recomputable.
 */
export async function removePlugin(id: string, opts: { keepIndex?: boolean } = {}) {
  const idx = await readIndex();
  const p = idx[id];
  if (p) {
    for (const a of p.manifest.actions ?? []) actionRegistry.unregister(a.id);
    for (const v of p.manifest.views ?? []) viewRegistry.unregister(v.id);
    artifactTypes.markProviderRemoved(id);
  }
  try {
    await (await (await root()).getDirectoryHandle(DIR)).removeEntry(id, { recursive: true });
  } catch {}
  if (!opts.keepIndex) {
    delete idx[id];
    await writeIndex(idx);
  }
}

/** Reads a file out of an installed package, for the runtime to load. */
export async function readPluginFile(id: string, name: string): Promise<Uint8Array> {
  let dir = await pluginDir(id, false);
  const parts = name.split('/').filter((p) => p && p !== '.' && p !== '..');
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  return new Uint8Array(await (await fh.getFile()).arrayBuffer());
}

/** Lists a package's files, so the details panel can show what shipped. */
export async function listPluginFiles(id: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: any, path: string) => {
    for await (const [name, h] of dir.entries()) {
      const p = path ? `${path}/${name}` : name;
      if (h.kind === 'file') out.push(p);
      else await walk(h, p);
    }
  };
  try { await walk(await pluginDir(id, false), prefix); } catch {}
  return out.sort();
}
