import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataClient, detectFormat, type ImportProgress } from './host/data/client';
import { AnotherTabError } from './host/data/singleWriter';
import { AnotherTabGate } from './ui/AnotherTabGate';
import { artifactTypes } from './host/artifact/registry';
import { colorRegistry } from './host/services/colors';
import { selectionBus } from './host/services/selection';
import { artifactFocus } from './host/services/focus';
import { panelFocus, type OpenPanel } from './host/services/panels';
import { workspaceState } from './host/services/workspaceState';
import { actionRegistry, defaultParams } from './host/actions/registry';
import { registerCoreActions } from './host/actions/core-actions';
import { executeAction } from './host/actions/executeAction';
import { debounce } from './host/actions/executor';
import { resultStore, payloadOf } from './host/actions/results';
import { liveRun } from './host/actions/liveRun';
import { viewRegistry, hasPersistableViewState } from './host/views/registry';
import { listSavedViews, upsertView, removeViewsForSources, renameSavedView, removeSavedView, removeSavedViews, duplicateSavedView, type SavedView } from './host/views/savedViews';
import { readOpenTabs, writeOpenTabs } from './host/views/openTabs';
import type { Destination } from './host/views/destinations';
import { noteOpened } from './host/views/galleryPrefs';
import type { NotebookDocument } from './host/notebook/document';
import { installPackage, listInstalled, restoreInstalled, removePlugin, type InstalledPlugin } from './host/plugins/store';
import { compareVersions, configuredRegistries, fetchRegistry, installFromRegistry, latestOf, type RegistryIndex } from './host/plugins/registry';
import { disposeRunnersFor } from './host/plugins/runner';
import {
  descendantsOf, type ArtifactId, type Artifact, type ActionExecution, type ProvenanceGraph,
} from './host/artifact/types';
import { insertOpOrdered, type TransformOp } from './host/transform/types';
import { importOperations } from './host/transform/serialization';
import { ArtifactTree } from './ui/ArtifactTree';
import { SidePanel } from './ui/SidePanel';
import { PluginsDialog } from './ui/PluginsDialog';
import { usePluginUpdates } from './host/plugins/useUpdates';
import { Inspector } from './ui/Inspector';
import { Workspace, type OpenTab, type ActivePanel } from './ui/Workspace';
import { StartScreen } from './ui/StartScreen';
import { ResetWorkspaceDialog } from './ui/ResetWorkspaceDialog';
import { StorageDetailsDialog } from './ui/StorageDetailsDialog';
import { ComputeEnginesDialog, ComputeIcon, ComputeStatusPopover } from './ui/ComputeEngines';
import { HelpMenu } from './ui/HelpMenu';
import { WelcomeDialog } from './ui/WelcomeDialog';
import { Tour } from './ui/Tour';
import { PluginsNudge } from './ui/PluginsNudge';
import { FeedbackDialog } from './ui/FeedbackDialog';
import { listEngines, refreshEngine, type ComputeEngine } from './host/compute/engines';
import { copyArtifactToEngine, moveArtifactToEngine, moveArtifactToBrowser } from './host/compute/relocate';
import { SampleLogsDialog, SAMPLE_LOGS, type SampleLog } from './ui/SampleLogsDialog';
import { RunActionDialog } from './ui/RunActionDialog';
import { BrandLogo } from './ui/BrandLogo';
import { AgentControl } from './ui/AgentControl';
import { bindAgentHost, startAgentLayer } from './host/agent';
import { WorkspaceSwitcher } from './ui/WorkspaceSwitcher';
import { ExportWorkspaceDialog } from './ui/ExportWorkspaceDialog';
import { ImportWorkspaceDialog } from './ui/ImportWorkspaceDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { buildWorkspaceBundle, parseWorkspaceBundle, pluginUsageOf, type ParsedWorkspaceBundle } from './host/data/workspaceBundle';
import { fmtBytes } from './ui/format';
import { primeActiveWorkspaceId, type StorageBreakdown, type WorkspaceMeta } from './host/data/opfs';

registerCoreActions();

/**
 * Views that ship installed by default, into every new workspace, no user
 * action required — the Dotted Chart example (a worked demonstration of the
 * sandboxed third-party view boundary) and the OCEL 2.0 Inspector
 * (`run.promenade.ocelot`; object-centric log exploration ported from
 * Ocelot — type graphs, paginated objects/events tables, per-object
 * lifecycle and relations, and the `primary` OCEL Overview). These are
 * fetched from the configured registry like any other install, not shipped
 * in the app bundle — so publishing a new version means updating the
 * registry, not rebuilding and redeploying the app. The id lets the boot
 * effect tell "already seeded, maybe needs upgrading" from "first run"
 * without installing it a second time on every reload.
 */
const BUNDLED_SEED_PLUGINS = [
  'run.promenade.dotted-chart',
  'run.promenade.ocelot',
  // Log comparison (and, from Phase 2, the transformation editor). Seeded into
  // every workspace: comparing two logs for equivalence is a basic operation
  // on a pair of imports, not a specialist add-on.
  'run.promenade.event-log-transformations',
];
/**
 * Views that ship with the app only as upgrades. Unlike the Dotted Chart
 * example they are not seeded into a new workspace; however, an installed
 * older version should not remain on an obsolete renderer forever. Also
 * registry-fetched, not bundled — see `BUNDLED_SEED_PLUGINS` above.
 */
const BUNDLED_PLUGIN_UPDATES = [
  'run.promenade.petrinet-layered',
  // Upgrade the first IVM package in place: v0.2 removes the heavyweight
  // Pyodide/pm4py replay path in favor of the browser-native Rust/WASM
  // alignment kernel, and fixes the missing idle edge paths in its viewer.
  'run.promenade.inductive-visual-miner',
];

/**
 * One-time cleanup for a workspace created before `executeAction.ts` started
 * naming a new derived artifact after its type ("Log Quality Report")
 * instead of "<action> · <source>" — `displayNameOf` used to paper over that
 * in the tree by showing the type's noun instead of the stored name, which
 * is exactly the inconsistency (tree shows one thing, Inspector shows
 * another, and renaming only ever fixed the latter) that dropping the
 * override exposes for artifacts nobody has renamed since.
 *
 * Deliberately narrow: only a name that still matches *exactly* what the old
 * convention would have produced is rewritten. Anything the user typed
 * themselves — even a name that happens to contain " · " — is left alone.
 */
function migratedDefaultName(a: Artifact, g: ProvenanceGraph): string | null {
  if (!a.producedBy) return null;
  const exec = g.executions[a.producedBy];
  if (!exec) return null;
  const action = actionRegistry.get(exec.actionId);
  if (!action) return null;
  let oldDefault = action.label.replace(/\s*\(.*\)$/, '');
  const primarySlot = action.inputs[0]?.name;
  const primaryId = primarySlot ? exec.inputs[primarySlot]?.[0] : undefined;
  const primary = primaryId ? g.artifacts[primaryId] : undefined;
  if (primary) oldDefault = `${oldDefault} · ${primary.name.replace(/\.[^.]+$/, '')}`;
  if (a.name !== oldDefault) return null;
  const fresh = artifactTypes.get(a.type).label;
  return fresh !== a.name ? fresh : null;
}

/**
 * Every currently-registered "manufacturing action" — one with `inputs: []`
 * — that declares a `file`-typed param, alongside the extensions its own
 * `accept` claims. This is what lets the plain Import control hand a file
 * off to whichever installed plugin can make something of it (BPMN 2.0 XML
 * via `run.promenade.bpmn.import`, say) instead of only ever recognizing the
 * core log formats `detectFormat` knows about — the same mechanism
 * `RunActionDialog`'s standalone-action buttons already use, just reached
 * from a dropped file instead of an explicit "Discover a process from…"
 * click.
 */
function fileImporters(): Array<{ actionId: string; paramKey: string; extensions: string[] }> {
  const out: Array<{ actionId: string; paramKey: string; extensions: string[] }> = [];
  for (const def of actionRegistry.all()) {
    if (def.inputs.length !== 0 || def.implemented === false) continue;
    for (const [key, prop] of Object.entries(def.params.properties)) {
      if (prop.type !== 'file' || !prop.accept) continue;
      out.push({
        actionId: def.id, paramKey: key,
        extensions: prop.accept.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      });
    }
  }
  return out;
}

/** The first registered manufacturing action whose file param accepts this
 * filename's extension — first match wins, the same "whichever registered
 * first" tie-break every other type/view resolution in this file already
 * uses when more than one candidate could plausibly apply. */
function fileImporterFor(filename: string): { actionId: string; paramKey: string } | null {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext) return null;
  for (const importer of fileImporters()) {
    if (importer.extensions.includes(ext)) return importer;
  }
  return null;
}

// The `run` implementations for every core action — `computeOcdfg`,
// `runDiscoverDfg`, `runDiscoverDfgSql`, `runDiscoverObjectInteractions` —
// now live in `host/actions/coreCompute.ts`, attached directly to their
// `ActionDef`s in `core-actions.ts`. `onRun`/`runRecompute` below no longer
// know any of them exist; they call `executeAction()` uniformly for every
// action, core or installed.

export function App() {
  const [graph, setGraph] = useState<ProvenanceGraph>({ artifacts: {}, executions: {} });
  const [selected, setSelected] = useState<string[]>([]);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [quota, setQuota] = useState<{ quota: number; usage: number; persisted: boolean }>();
  const [booted, setBooted] = useState(false);
  const [bootReport, setBootReport] = useState<any>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anotherTab, setAnotherTab] = useState(false);
  const [running, setRunning] = useState(false);
  // What the in-flight action is called, for the busy indicator. A wasm/core
  // action reports no progress, so without this the only cue that a long
  // "Discover …" run is still going is the grayed-out buttons.
  const [runningLabel, setRunningLabel] = useState('');
  const [liveParams, setLiveParams] = useState<Record<string, unknown> | null>(null);
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  // Nobody has installed anything of their own yet — still just what the
  // workspace was seeded with (`BUNDLED_SEED_PLUGINS`, fetched from the
  // registry at boot like any other install, so `source.kind` alone can't
  // tell a deliberate install apart from a seeded one). Used to keep
  // nudging toward the Plugins browser until that changes.
  const onlyBundledPlugins = plugins.length > 0
    && plugins.every((p) => BUNDLED_SEED_PLUGINS.includes(p.manifest.id));
  const { updates: pluginUpdates, indexes: registryIndexes } = usePluginUpdates(plugins);
  // An installed plugin has no "experimental" field of its own — that flag
  // lives on the registry entry it came from — same cross-reference
  // `PluginList`'s Browse/Installed lists compute, reused here so the
  // Inspector's Views/Actions rows can carry the same badge.
  const experimentalPluginIds = useMemo(() => {
    const ids = new Set<string>();
    for (const index of registryIndexes) {
      for (const entry of index.plugins) {
        if ((entry as any).experimental) ids.add(entry.id);
      }
    }
    return ids;
  }, [registryIndexes]);
  const [pyStatus, setPyStatus] = useState<string>('');
  const [pluginsDialogOpen, setPluginsDialogOpen] = useState(false);
  const [pluginsDialogInitialTab, setPluginsDialogInitialTab] = useState<'installed' | 'browse'>('installed');
  const [tourActive, setTourActive] = useState(false);
  /**
   * Which of the topbar's own popover controls (AI, Compute, Help) is open —
   * each used to own that boolean itself, so opening one never closed
   * another and two could sit open over each other at once. One flag,
   * shared by all three, is what actually makes them mutually exclusive.
   */
  const [openTopbarPanel, setOpenTopbarPanel] = useState<'ai' | 'compute' | 'help' | null>(null);
  const computeMenuOpen = openTopbarPanel === 'compute';
  const setComputeMenuOpen = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setOpenTopbarPanel((prev) => {
      const wasOpen = prev === 'compute';
      const nextOpen = typeof next === 'function' ? next(wasOpen) : next;
      return nextOpen ? 'compute' : (wasOpen ? null : prev);
    });
  }, []);
  const [computeEnginesDialogOpen, setComputeEnginesDialogOpen] = useState(false);
  /** Absent or 'true' means "show it" — so a first-ever launch (no key yet)
   * opens the dialog without needing a separate "has this run before" flag. */
  const [welcomeShowOnStartup, setWelcomeShowOnStartup] = useState(() => {
    try { return localStorage.getItem('promenade.welcome.showOnStartup') !== 'false'; } catch { return true; }
  });
  const [welcomeDialogOpen, setWelcomeDialogOpen] = useState(welcomeShowOnStartup);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const onWelcomeShowOnStartupChange = useCallback((value: boolean) => {
    setWelcomeShowOnStartup(value);
    try { localStorage.setItem('promenade.welcome.showOnStartup', String(value)); } catch {}
  }, []);
  /** Feeds the Inspector's per-action "Run on" picker. Refreshed on load and
   * whenever the engines dialog closes (add/remove/status may have changed). */
  const [computeEngines, setComputeEngines] = useState<ComputeEngine[]>(() => listEngines());
  const refreshComputeEngines = useCallback(() => {
    const current = listEngines();
    setComputeEngines(current);
    Promise.all(current.map((e) => refreshEngine(e.id))).then(() => setComputeEngines(listEngines()));
  }, []);
  useEffect(() => { refreshComputeEngines(); }, [refreshComputeEngines]);
  const [sampleLogsOpen, setSampleLogsOpen] = useState(false);
  /** Which panel the inspector's View section belongs to. */
  const [activePanel, setActivePanel] = useState<ActivePanel | null>(null);
  // Read by `dockPlacement` from inside stable callbacks, which is why it is a
  // ref: a callback that depends on the active panel is a callback whose
  // identity changes on every panel switch, and those reach plugin frames
  // through panel params that are fixed at creation.
  const activePanelRef = useRef(activePanel);
  activePanelRef.current = activePanel;
  /**
   * The tab that was focused when this workspace was last saved — consumed
   * once, by `Workspace`, to re-focus that panel after boot recreates it.
   * Not reset back to `undefined` after consumption: `Workspace`'s own
   * one-shot ref guard is what stops it from re-firing.
   */
  const [restoreActiveTabId, setRestoreActiveTabId] = useState<string | undefined>(undefined);
  /**
   * Guards `persistOpenTabsDebounced` below against the boot-time restore
   * race: `tabs` starts at `[]` and the very first render already qualifies
   * for the persistence effect, so without this a workspace's remembered
   * arrangement would be overwritten with emptiness the instant the debounce
   * timer fires, if that happens to land before the OPFS read (below)
   * resolves and calls `setTabs`.
   */
  const tabsRestoredRef = useRef(false);
  /**
   * Whether anything has actually opened, closed or deleted a tab yet this
   * session — distinct from `tabs.length === 0`, which is also true the
   * instant a genuinely-empty session closes its very last tab. Without this,
   * the boot-time restore below (`readOpenTabs().then(...)`) — an OPFS read
   * that can take a real, human-noticeable moment — would see that same
   * `tabs.length === 0` a few seconds later and conclude "nothing has
   * opened yet, safe to restore," silently bringing back a tab (or a view)
   * the user had just closed or deleted while the read was still in flight.
   * Set by the one effect below the very first time `tabs` actually changes
   * for any reason after mount; the restore's own `setTabs` call is exempt
   * by construction, since its guard reads this ref *before* that call runs.
   */
  const tabsEverMutatedRef = useRef(false);
  const isFirstTabsRenderRef = useRef(true);
  useEffect(() => {
    if (isFirstTabsRenderRef.current) { isFirstTabsRenderRef.current = false; return; }
    tabsEverMutatedRef.current = true;
  }, [tabs]);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  /** Mutually exclusive with `selected`: the tree shows one or the other.
   * Multi-select, so several saved views can be deleted in one gesture; the
   * inspector's per-view settings show only when exactly one is selected. */
  const [selectedSavedViewIds, setSelectedSavedViewIds] = useState<string[]>([]);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [storageDetailsOpen, setStorageDetailsOpen] = useState(false);
  const [storageDetails, setStorageDetails] = useState<StorageBreakdown | null>(null);
  const [storageDetailsLoading, setStorageDetailsLoading] = useState(false);
  const [unusedMaterializations, setUnusedMaterializations] = useState(0);
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>('');
  const [exportWorkspaceOpen, setExportWorkspaceOpen] = useState(false);
  const [importBundle, setImportBundle] = useState<ParsedWorkspaceBundle | null>(null);
  /** Set when opening an artifact or saved view whose recorded plugin version
   * differs from what's currently installed — gates the open behind a warning. */
  const [pendingMismatch, setPendingMismatch] = useState<
    | { kind: 'artifact'; key: string; artifact: Artifact; pluginId: string; recorded: string; installed: string }
    | { kind: 'savedView'; key: string; sv: SavedView; pluginId: string; recorded: string; installed: string }
    | null
  >(null);
  /**
   * Version mismatches the user has already accepted, for this session.
   *
   * The warning is worth showing once: it says results may differ from when
   * the artifact was made, which is a thing to know before reading it. It is
   * not worth showing again on every reopen — closing a tab and opening the
   * same artifact again asked the same question over and over, and a prompt
   * that always appears is one people learn to dismiss without reading.
   *
   * Keyed by the *pair* of versions, not just the artifact, so upgrading the
   * plugin again is a genuinely new mismatch and asks once more. A `ref`, not
   * state: nothing renders from it, and it is deliberately not persisted —
   * "for this session" is the promise, and a reload is a fair place to say it
   * again.
   */
  const acceptedMismatches = useRef<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const workspaceFileInput = useRef<HTMLInputElement>(null);
  /** Aborts the in-flight run when a new one supersedes it. */
  const inFlight = useRef<AbortController | null>(null);

  // The recompute closure needs the current graph without re-creating itself
  // on every graph change, which would reset the debounce timers mid-drag.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /**
   * Which panels are on screen, reported by the workspace.
   *
   * Not derivable from `tabs`: opening one artifact can produce a whole
   * arrangement, and closing one of its panels leaves the tab standing. The
   * inspector needs the real list to say which views are already visible.
   */
  const [openPanels, setOpenPanels] = useState<OpenPanel[]>([]);
  const openPanelsRef = useRef(openPanels);
  openPanelsRef.current = openPanels;
  /**
   * `<Workspace>` only mounts while `tabs` is non-empty (see the
   * `tabs.length === 0 ? <StartScreen> : <Workspace>` switch below) — closing
   * the last tab unmounts it, dockview and all, without ever getting a
   * chance to report that every panel is gone. Left alone, `openPanels`
   * (and therefore `openPanelsRef`, which `openView` et al. trust to answer
   * "is this already open?") would go on holding a ghost entry for a panel
   * that no longer exists. `openView`'s "already open → focus it" branch
   * would then match that ghost and call `panelFocus.request()` on an id
   * nothing is listening for any more — a silent no-op, so reopening the
   * very last view you closed appeared to do nothing at all.
   */
  useEffect(() => {
    if (tabs.length === 0 && openPanelsRef.current.length > 0) setOpenPanels([]);
  }, [tabs]);

  /**
   * Publishes the on-screen arrangement for `promenade.workspace()`.
   *
   * Both halves only exist here: dockview reports the panels, `tabs` holds
   * the parameters each one is showing. A frame that declares
   * `readsWorkspace` reads the join through `workspaceState`, the same way
   * it reads colours through the colour registry — a service, not a prop
   * threaded through dockview's panel params (which are fixed at panel
   * creation and would go stale on the very first slider drag).
   *
   * `workspaceState.set` drops an unchanged snapshot, so a parameter being
   * dragged does not turn into one postMessage per animation frame.
   */
  useEffect(() => {
    const byTab = new Map(tabs.map((t) => [t.id, t]));
    workspaceState.set(openPanels.map((p) => {
      const artifact = graph.artifacts[p.artifactId];
      const def = viewRegistry.get(p.view);
      return {
        panelId: p.panelId,
        artifactId: p.artifactId,
        artifactName: artifact?.name ?? '',
        artifactType: artifact?.type ?? '',
        viewId: p.view,
        viewLabel: def?.label ?? p.view,
        params: byTab.get(p.panelId.split('#')[0])?.viewParams ?? {},
        active: activePanel?.panelId === p.panelId,
      };
    }));
  }, [openPanels, tabs, graph, activePanel]);
  /**
   * Which view an artifact was last shown through, session-only — not the
   * saved-view store, which only remembers a view *with configurable
   * params* (nothing else about it would survive a reload). This is purely
   * "double-click should reopen whichever of an artifact's several views I
   * was just looking at", which matters even for a view with no params of
   * its own — two competing Petri net renderers, say — and today's
   * alternative (`openArtifact`'s "first view registered for this type")
   * picks whichever view happened to install first, forever, regardless of
   * which one the user actually last opened.
   */
  const lastViewForArtifactRef = useRef<Record<string, string>>({});
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** The recompute closure is created once; the Python path is read through a ref. */
  const runPythonPluginRef = useRef<any>(null);

  /**
   * Handlers the Agent API binding calls.
   *
   * Read through refs so the binding effect runs exactly once — re-binding on
   * every render would tear down and re-register the WebMCP tool set several
   * times a second.
   */
  const onRunRef = useRef<any>(null);
  const openViewRef = useRef<any>(null);
  const runRecomputeRef = useRef<any>(null);
  const onRenameArtifactRef = useRef<any>(null);
  const onRemoveRef = useRef<any>(null);
  const onRemovePluginRef = useRef<any>(null);
  const onImportSampleRef = useRef<any>(null);
  const activeWorkspaceIdRef = useRef('');
  const workspacesRef = useRef<WorkspaceMeta[]>([]);

  useEffect(() => {
    // Dev affordance: lets the host API be exercised directly, e.g. to check a
    // plugin's output against a pure-SQL reference.
    if (import.meta.env.DEV) {
      (globalThis as any).__host = { dataClient, resultStore, selectionBus, colorRegistry };
    }

    // The Dotted Chart example is seeded as a real installed plugin on first
    // boot — not a permanent fixture the host merely renders — so it shows up
    // in Plugins > Installed with its own README and author, and can be
    // removed like any other package. Later boots also upgrade it in place
    // when the bundled package is newer than what is installed, the same
    // way the Plugins panel's own update button works — otherwise a build
    // that changes this example would leave every existing session on
    // whatever version it happened to install first. `restoreInstalled` is
    // what actually re-registers everything from the stored index.
    // Named so the boot handler below can wait on it too: the artifact-name
    // migration needs `actionRegistry` populated with plugin actions (not
    // just core ones) before it can reconstruct what an old default name
    // would have been.
    const pluginsSeeded = (async () => {
      const already = await listInstalled();

      // Both seed lists above are resolved against the first configured
      // registry rather than a bundled file — an unreachable registry (e.g.
      // dev server offline, or a mis-set registry URL) must never block
      // boot, so this whole block is best-effort like the old fetch was.
      let index: RegistryIndex | null = null;
      try {
        index = await fetchRegistry(configuredRegistries()[0]);
      } catch { /* seeding is best-effort; the app works without it */ }

      if (index) {
        for (const id of BUNDLED_SEED_PLUGINS) {
          const existing = already.find((p) => p.manifest.id === id);
          const entry = index.plugins.find((e) => e.id === id);
          const latest = entry && latestOf(entry);
          if (!entry || !latest) continue;
          if (existing && compareVersions(latest.version, existing.manifest.version) <= 0) continue;
          try { await installFromRegistry(index, entry, latest); }
          catch { /* seeding is best-effort; the app works without it */ }
        }

        // A renderer the user has explicitly installed is part of their
        // workspace, so update its bundled replacement in place. Do not seed
        // these into a blank workspace: a specialized alternate view should be
        // an intentional choice, not surprise tree clutter.
        for (const id of BUNDLED_PLUGIN_UPDATES) {
          const installed = already.find((p) => p.manifest.id === id);
          if (!installed) continue;
          const entry = index.plugins.find((e) => e.id === id);
          const latest = entry && latestOf(entry);
          if (!entry || !latest) continue;
          if (compareVersions(latest.version, installed.manifest.version) <= 0) continue;
          try { await installFromRegistry(index, entry, latest); }
          catch { /* an unavailable bundled upgrade must never block boot */ }
        }
      }
      setPlugins(await restoreInstalled());
    })();

    // A view can ask the host to focus another artifact; the host decides what
    // that means. Views never set the selection themselves.
    const unfocus = artifactFocus.subscribe((id) => setSelected([id]));

    dataClient.onProgress(setProgress);
    dataClient.boot().then(async (r) => {
      // Saved views are read directly from OPFS on the main thread (see
      // `host/views/savedViews.ts`), which has its own copy of `opfs.ts`'s
      // module state separate from the data worker's — it has to be told
      // which workspace is active before it can resolve `workspaceRoot()`.
      primeActiveWorkspaceId(r.activeWorkspaceId);
      setWorkspaces(r.workspaces);
      setActiveWorkspaceId(r.activeWorkspaceId);
      listSavedViews().then(setSavedViews);
      // Same OPFS-on-the-main-thread reasoning as saved views, just above.
      // Restores whatever arrangement of tabs this workspace last had open —
      // dropped only for a tab whose artifact or view no longer exists,
      // exactly the same checks `openView`/`PanelHost` already make when
      // asked to open one. Skipped entirely once anything has genuinely
      // touched `tabs` this session (`tabsEverMutatedRef`) — an OPFS read can
      // take long enough that a user who opened, closed or deleted something
      // while it was still in flight would otherwise see that action quietly
      // undone (or, if it happened to leave `tabs` empty, silently replaced
      // by whatever this workspace looked like before) the moment the read
      // finally resolved.
      readOpenTabs().then((state) => {
        const restored = state.tabs.filter((t: any) => {
          if (!t?.id || t.live) return false;
          const def = viewRegistry.get(t.view);
          if (!def || def.disabled) return false;
          return def.standalone || !!r.catalog.artifacts[t.artifactId];
        }) as unknown as OpenTab[];
        if (restored.length > 0 && !tabsEverMutatedRef.current) {
          setTabs((current) => (tabsEverMutatedRef.current || current.length > 0 ? current : restored));
          if (state.activeTabId && restored.some((t) => t.id === state.activeTabId)) {
            setRestoreActiveTabId(state.activeTabId);
          }
        }
        tabsRestoredRef.current = true;
      }).catch(() => { tabsRestoredRef.current = true; });

      setGraph(r.catalog);
      setQuota(r.quota);
      setBootReport(r.report);
      setBooted(true);
      // The tree's maintenance menu shows the same safe-cleanup candidates as
      // Storage details: OPFS artifact directories no catalog entry owns.
      void dataClient.storageBreakdown().then(({ breakdown }) => {
        setUnusedMaterializations(breakdown.opfs.orphanArtifactDirectories);
      }).catch(() => {});
      // Colors are assigned once, centrally, from the artifacts that already
      // exist, so a reopened log keeps the palette it had.
      for (const a of Object.values(r.catalog.artifacts)) {
        seedColors(a);
        // Views read results from the store, not from the catalog, so a
        // reloaded artifact has to be put back where they look for it.
        if (a.storage.kind === 'inline' && a.storage.value != null) {
          resultStore.set(a.id, a.storage.value);
        }
      }

      // See `migratedDefaultName`'s doc comment. Waits on `pluginsSeeded` so
      // a plugin-provided action (e.g. a Pyodide analysis) is registered
      // before its label is needed to recognize the old default it once
      // produced — best-effort and never blocks boot on failure.
      try {
        await pluginsSeeded;
        for (const a of Object.values(r.catalog.artifacts) as Artifact[]) {
          const fresh = migratedDefaultName(a, r.catalog);
          if (!fresh) continue;
          const renamed: any = await dataClient.rename(a.id, fresh);
          setGraph(renamed.catalog);
        }
      } catch { /* cosmetic cleanup; a failed rename just keeps the old name */ }
    }).catch((e) => {
      if (e instanceof AnotherTabError) setAnotherTab(true);
      else setError(String(e));
    });

    return () => { unfocus(); };
  }, []);

  const artifacts = useMemo(() => Object.values(graph.artifacts), [graph]);
  const selectedArtifacts = useMemo(
    () => selected.map((id) => graph.artifacts[id]).filter(Boolean),
    [selected, graph]
  );

  /** Which locally-installed plugins produced something in this workspace —
   * computed from state already on hand, so the export dialog can show it
   * instantly instead of waiting on a worker round trip. */
  const exportLocalPlugins = useMemo(() => {
    const { localPluginIds } = pluginUsageOf(graph.executions, savedViews, plugins);
    return localPluginIds.map((id) => ({
      id, name: plugins.find((p) => p.manifest.id === id)?.manifest.name ?? id,
    }));
  }, [graph, savedViews, plugins]);

  const onImport = useCallback(async (files: FileList | readonly File[] | null) => {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files)) {
      // A plugin package goes through the same Import control as a log: the
      // user is bringing something into the workspace either way.
      if (file.name.endsWith('.pmplugin') || (file.name.endsWith('.zip') && !file.name.toLowerCase().endsWith('.ocel.zip'))) {
        const res = await installPackage(new Uint8Array(await file.arrayBuffer()));
        if (!res.ok) setError(`${file.name}: ${res.errors.join('; ')}`);
        else setPlugins(await listInstalled());
        continue;
      }

      const format = detectFormat(file.name);
      if (!format) {
        // Not a core log format — offer it to whichever installed plugin's
        // manufacturing action claims this extension (BPMN 2.0 XML via
        // `run.promenade.bpmn.import`, say) before giving up on it.
        const importer = fileImporterFor(file.name);
        if (importer) {
          setImporting(file.name);
          try {
            const text = await file.text();
            await onRun(importer.actionId, undefined, undefined, { inputs: {}, params: { [importer.paramKey]: text } });
          } catch (e: any) {
            setError(`${file.name}: ${e.message}`);
          } finally {
            setImporting(null);
            setProgress(null);
          }
          continue;
        }
        setError(`${file.name}: unsupported format. Use XES, PNML, OCEL JSON/XML/SQLite, .ocel.csv, a ProM-style event-table CSV, .ocel.zip, or a format an installed plugin can import (e.g. BPMN 2.0 XML).`);
        continue;
      }

      setImporting(file.name);
      try {
        const { artifact, quota } = await dataClient.import(file, format, file.name);
        setGraph((g) => ({ ...g, artifacts: { ...g.artifacts, [artifact.id]: artifact } }));
        setQuota(quota);
        seedColors(artifact);
        setSelected([artifact.id]);
        openArtifact(artifact);
      } catch (e: any) {
        setError(`${file.name}: ${e.message}`);
      } finally {
        setImporting(null);
        setProgress(null);
      }
    }
  }, []);

  /** Download a curated public sample, then use the regular local-file path.
   * The importer remains the only code that decides which formats are valid
   * and the remote host never receives a database or storage capability. */
  const onImportSample = useCallback(async (sample: SampleLog) => {
    setError(null);
    setImporting(`downloading ${sample.name}`);
    try {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const blob = await response.blob();
      await onImport([new File([blob], sample.fileName, { type: blob.type || 'application/octet-stream' })]);
    } catch (e: any) {
      setError(`Could not download ${sample.name}: ${e.message ?? e}`);
      setImporting(null);
      throw e;
    }
  }, [onImport]);

  /**
   * Runs any `exportsFile` action (first- or third-party — `core.export.ocel`
   * and a plugin's own `run.promenade.bpmn.export-xml` go through exactly
   * this one path) and triggers the browser download. The generalized
   * counterpart to the `onExportOcel`/`onExportXes` handlers this replaces:
   * those were two hand-written per-format cases; this is data-driven off
   * whatever `exportActionsFor(artifact)` finds installed.
   */
  const onExportAction = useCallback(async (actionId: string, artifact: Artifact, params: Record<string, unknown>) => {
    const def = actionRegistry.get(actionId);
    if (!def) return;
    const slot = def.inputs[0]?.name;
    if (!slot) return;
    const ctrl = new AbortController();
    try {
      const result = await executeAction({ actionId, inputs: { [slot]: [artifact.id] }, params, signal: ctrl.signal });
      if (!result || !('filename' in result)) return; // aborted, or (shouldn't happen) not an export action
      const bytes = typeof result.bytes === 'string' ? new TextEncoder().encode(result.bytes) : result.bytes;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: result.mime }));
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(`Could not export ${artifact.name}: ${e.message}`);
    }
  }, []);

  /**
   * Opens one view of an artifact, or brings it forward when it is already
   * open. This is how a view closed by accident comes back: the default
   * arrangement is applied once, when the artifact is opened, and re-applying
   * it wholesale would resurrect panels the user closed on purpose.
   */
  /**
   * Creates a derived log and opens its plan editor.
   *
   * The new artifact starts with an empty plan, so it is initially identical to
   * its source and costs nothing: a plan is a set of DuckDB views, not a copy.
   */
  /**
   * The log types a transformation plan can read. A derived log is always one
   * of these, and so is the source of any repair.
   */
  const LOG_TYPES = useMemo(() => new Set(['TraditionalEventLog', 'ObjectCentricEventLog']), []);

  /** Opens the transformation editor on a derived log, or focuses it if open. */
  const openTransformEditor = useCallback((artifact: Artifact) => {
    const tabId = `${artifact.id}:core.transformEditor`;
    setTabs((t) => (t.some((tab) => tab.id === tabId) ? t : [...t, {
      id: tabId, artifactId: artifact.id,
      view: 'core.transformEditor', title: artifact.name,
    }]));
    persistViewParams(artifact.id, 'core.transformEditor',
      defaultParams(viewRegistry.get('core.transformEditor')?.params ?? { type: 'object', properties: {} }));
  }, []);

  /**
   * Creates a derived log: a plan over `input`, never a copy of it.
   *
   * Shared by the manual "Transform" affordance and by `promenade.deriveLog()`,
   * so a plan proposed by a plugin is the same kind of artifact, with the same
   * provenance edge, as one a user started by hand.
   */
  const createDerivedLog = useCallback(async (
    input: Artifact,
    ops: TransformOp[],
    opts?: {
      name?: string;
      meta?: Record<string, unknown>;
      seed?: { type: string; tables: string[] };
    }
  ): Promise<Artifact> => {
    const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const execId = `x_${Date.now().toString(36)}`;
    const tables = opts?.seed?.tables ?? (input.storage.kind === 'parquet'
      ? Object.keys(input.storage.files)
      : input.storage.kind === 'view' ? input.storage.tables : []);
    const flattening = !!opts?.seed;

    const execution: ActionExecution = {
      id: execId,
      actionId: flattening ? 'core.flattenOcel' : 'core.transformLog',
      actionVersion: '0.1.0',
      inputs: { log: [input.id] },
      outputs: [id],
      params: { ops },
      startedAt: new Date().toISOString(),
      durationMs: 0,
      runtime: { kind: 'core', version: 'duckdb-views' },
    };
    const artifact: Artifact = {
      id,
      name: opts?.name ?? `Transformed · ${input.name.replace(/\.[^.]+$/, '')}`,
      // Same type as the input unless the plan changes it: a filtered log is
      // still a log, so every downstream action and view applies unchanged.
      type: opts?.seed?.type ?? input.type,
      createdAt: new Date().toISOString(),
      storage: { kind: 'view', plan: { source: input.id, ops }, tables },
      meta: { ...(opts?.meta ?? {}) },
      producedBy: execId,
      inputs: [input.id],
    };

    const r = await dataClient.putDerived(artifact, execution);
    setGraph(r.catalog);
    setQuota(r.quota);
    setSelected([id]);
    openTransformEditor(artifact);
    return artifact;
  }, [openTransformEditor]);

  const onTransform = useCallback(async (
    input: Artifact,
    /**
     * Set when the plan changes what kind of log this is — flattening produces
     * a traditional log from an object-centric one, so neither the type nor the
     * table set can be inherited from the input.
     */
    seed?: { type: string; tables: string[]; ops: TransformOp[]; name: string }
  ) => {
    try {
      await createDerivedLog(input, seed?.ops ?? [], seed && {
        name: seed.name, seed: { type: seed.type, tables: seed.tables },
      });
    } catch (e: any) {
      setError(`Transform: ${e.message}`);
    }
  }, [createDerivedLog]);

  /**
   * Applies an edited plan.
   *
   * Rebuilding is recreating views and running three aggregates, so this can
   * follow editing directly — there is no expensive stage to protect. The
   * execution's params are updated in place: the plan *is* the parameters, and
   * a second node per keystroke would be provenance describing nothing.
   */
  const onPlanChange = useCallback(async (artifact: Artifact, ops: TransformOp[]) => {
    if (artifact.storage.kind !== 'view') return;
    const source = graphRef.current.artifacts[artifact.storage.plan.source];
    // Flattening is a structural operation: turning its first step off changes
    // the derived artifact back to the source log's shape, rather than leaving
    // a case-centric artifact that points at object-centric tables.
    const flattening = ops[0]?.kind === 'flattenByObjectType' && !ops[0].disabled;
    const sourceTables = source?.storage.kind === 'parquet' ? Object.keys(source.storage.files)
      : source?.storage.kind === 'view' ? source.storage.tables : artifact.storage.tables;
    const next: Artifact = {
      ...artifact,
      type: flattening ? 'TraditionalEventLog' : (source?.type ?? artifact.type),
      storage: {
        ...artifact.storage,
        plan: { ...artifact.storage.plan, ops },
        tables: flattening ? ['event', 'event_attr', 'trace', 'trace_attr'] : sourceTables,
      },
      // Forces open panels to re-query: the SQL text is unchanged, only the
      // view behind the table name is different.
      meta: { ...artifact.meta, rev: Date.now() },
    };
    const exec = artifact.producedBy ? graphRef.current.executions[artifact.producedBy] : null;
    try {
      const r = await dataClient.putDerived(
        next, exec ? {
          ...exec,
          actionId: flattening ? 'core.flattenOcel' : 'core.transformLog',
          params: { ops },
        } : undefined
      );
      setGraph(r.catalog);
      setQuota(r.quota);
    } catch (e: any) {
      setError(`Transform: ${e.message}`);
    }
  }, []);

  /**
   * Changes how a log's events are labeled.
   *
   * Not a transformation: it derives no new artifact, it redefines the
   * `activity` column of this log's event view. Everything open re-reads it,
   * which is what `rev` in the metadata is for.
   */
  const onClassifierChange = useCallback(async (a: Artifact, classifier: unknown) => {
    try {
      const r: any = await dataClient.setClassifier(a.id, classifier);
      setGraph(r.catalog);
      setQuota(r.quota);
      for (const art of Object.values(r.catalog.artifacts) as Artifact[]) seedColors(art);
    } catch (e: any) {
      setError(`Classifier: ${e.message}`);
    }
  }, []);

  /**
   * Creates-or-updates the one SavedView record for (sourceArtifactId, view),
   * then tags whichever tab is showing it with the record's id — that is what
   * makes the tab pick up a custom title after a rename (see PanelTab).
   *
   * Called immediately (not debounced) the moment a view tab is created, so
   * its tree row exists before any parameter is touched; called through
   * `persistViewParamsDebounced` from live parameter edits.
   */
  const persistViewParams = useCallback(
    (sourceArtifactId: string, view: string, state: Record<string, unknown>, savedViewId?: string) => {
      const def = viewRegistry.get(view);
      // A parameterless built-in panel adds nothing to the tree, but a
      // sandboxed plugin renderer is itself a meaningful view choice and
      // must remain discoverable/reopenable once opened.
      if (!hasPersistableViewState(def)) return;
      const title = def?.label ?? view;
      // `savedViewId`, when given, targets that exact record — otherwise
      // this falls back to the (artifact, view) pair, which is only
      // unambiguous while at most one saved view exists for it. A tab
      // showing one of several duplicated views always knows its own id by
      // the time it has live params to persist (`persistViewParams` tagged
      // it with one on creation, just below), so this only matters for the
      // handful of callers still passing the bare pair.
      const providerId = def?.provider && def.provider !== 'core' ? def.provider : undefined;
      const providerVersion = providerId
        ? pluginsRef.current.find((p) => p.manifest.id === providerId)?.manifest.version
        : undefined;
      upsertView({ id: savedViewId, sourceArtifactId, view, state, title, providerId, providerVersion }).then((sv) => {
        setSavedViews((vs) => (vs.some((v) => v.id === sv.id)
          ? vs.map((v) => (v.id === sv.id ? sv : v))
          : [...vs, sv]));
        setTabs((t) => t.map((tab) => (tab.artifactId === sourceArtifactId && tab.view === view && !tab.savedViewId)
          ? { ...tab, savedViewId: sv.id }
          : tab));
      });
    },
    []
  );
  const persistViewParamsDebounced = useMemo(() => debounce(persistViewParams, 500), [persistViewParams]);

  /**
   * Remembers this workspace's own arrangement — which tabs are open,
   * showing which view with which parameters, and which one is focused —
   * so a reload (or reopening the app later) picks up where it left off
   * instead of landing on the empty start screen. A live-preview tab is
   * dropped: it is bound to a run that no longer exists once the page is
   * gone, and restoring it would just show a permanently-stuck placeholder.
   */
  const persistOpenTabsDebounced = useMemo(
    () => debounce((t: OpenTab[], activeTabId: string | undefined) => {
      void writeOpenTabs({ tabs: t.filter((x) => !x.live) as unknown as Record<string, unknown>[], activeTabId });
    }, 500),
    []
  );
  useEffect(() => {
    if (!tabsRestoredRef.current) return;
    persistOpenTabsDebounced(tabs, activePanel?.tabId);
  }, [tabs, activePanel?.tabId, persistOpenTabsDebounced]);

  /**
   * Lets a view that owns its controls (`ViewDef.ownsControls`) push its own
   * parameter changes, addressed by tab rather than by workspace focus —
   * unlike `onViewParamChange` below, the panel doesn't need to be active for
   * its own slider to work.
   */
  /**
   * `promenade.setParams({a, b, c})` reaches here as three separate calls,
   * one per key (`PluginPanel.tsx`'s `onPortMessage` loops `Object.keys`) —
   * a single click that patches several params at once (e.g. Object
   * Dynamics · Multiplicity's matrix cells, switching `mode` + `activity` +
   * `objectType` together) used to fire all three in one synchronous burst.
   * Reading `tabsRef.current` once per call and computing `next` from that
   * *outside* the updater meant each call's `next` was based on the same
   * pre-click snapshot; three `setTabs` calls in a row each fully replacing
   * `viewParams` meant only the *last* key survived, discarding the other
   * two — the visible symptom was an instant switch to detail followed by
   * an immediate snap back once the host echoed the (incomplete) params
   * back down, reading as a flicker that did nothing. Computing `next`
   * *inside* the functional updater fixes it: React threads a burst of
   * `setTabs` calls in one tick through each other correctly, so the third
   * call's `x.viewParams` already reflects the first two.
   */
  const onTabParamChange = useCallback((tabId: string, key: string, value: unknown) => {
    setTabs((t) => t.map((x) => {
      if (x.id !== tabId) return x;
      const next = { ...(x.viewParams ?? {}), [key]: value };
      persistViewParamsDebounced(x.artifactId, x.view, next, x.savedViewId);
      return { ...x, viewParams: next };
    }));
  }, [persistViewParamsDebounced]);

  /**
   * Turns a view's `dock` preference into the tab fields that express it.
   *
   * Anchored to whatever is active, which is the panel the user was just
   * looking at and therefore the thing they expect the new one to appear
   * beside. With nothing active there is nothing to sit beside, and the
   * absent fields let the panel fill the space as it always did.
   */
  const dockPlacement = useCallback((def: { dock?: 'left' | 'right' } | undefined) => {
    const anchor = activePanelRef.current?.tabId;
    if (!def?.dock || !anchor) return {};
    return { splitFrom: anchor, splitDirection: def.dock };
  }, []);

  const openView = useCallback((
    a: Artifact, viewId: string, initialParams?: Record<string, unknown>, title?: string,
    opts?: {
      /**
       * Whether this counts as the user picking a new "home" view for this
       * artifact — the thing `openArtifact` (clicking the artifact itself)
       * reopens next time. Defaults to true for every ordinary opener (the
       * Inspector's Views list, the tree, a saved view). Cross-view
       * navigation from *inside* another view of the same artifact
       * (`promenade.openView()`) passes `false`: following a link to
       * "Object Types" from Overview is a peek at a sibling view, not a
       * decision that this artifact should open to Object Types from now
       * on — without this, the very first such link permanently demoted
       * the `primary` view, and since the demoted-to view was already open,
       * every later attempt to get back to it (from the tree, or the same
       * link again) just re-focused the panel already on screen — a
       * silent no-op indistinguishable from "nothing happens."
       */
      rememberAsLastView?: boolean;
      /**
       * Open beside an existing panel instead of wherever a new tab would
       * land. Only `promenade.openView`'s placement hint sets this: a panel
       * that opens another panel *for* the user means "next to me", and
       * without it the new one arrives as a tab on top of the opener.
       */
      placement?: { beside: 'left' | 'right'; fromPanelId: string };
    }
  ) => {
    if (viewRegistry.get(viewId)?.disabled) return;
    if (opts?.rememberAsLastView !== false) lastViewForArtifactRef.current[a.id] = viewId;
    const open = openPanelsRef.current.find((p) => p.artifactId === a.id && p.view === viewId);
    if (open) {
      panelFocus.request(open.panelId);
      // Cross-view navigation redirects an already-open target instead of
      // just bringing stale content forward — e.g. clicking a second
      // "Object Relationships" chip in Events, for a different object,
      // while the Objects view from the first click is still open. Scoped
      // to that one path (the same `rememberAsLastView: false` marker):
      // reopening an already-open *saved* view must go on leaving whatever
      // live params the user has since tweaked alone, not snap them back
      // to the saved snapshot just because the row was clicked again.
      if (initialParams && opts?.rememberAsLastView === false) {
        const openTabId = open.panelId.split('#')[0];
        setTabs((t) => t.map((x) => (x.id === openTabId
          ? { ...x, viewParams: { ...(x.viewParams ?? {}), ...initialParams } }
          : x)));
      }
      return;
    }
    const tabId = `${a.id}:${viewId}`;
    // Checked against the *current* state through the ref, for two reasons.
    //
    // The updater is not it: React does not run a `setTabs` updater
    // synchronously, so a flag set inside one and read on the next line is
    // not reliably set yet.
    //
    // The closure is not it either, and that one was a real bug. This
    // callback reaches a sandboxed view through dockview's panel params,
    // which are fixed when the panel is created and only selectively
    // refreshed afterwards — so the `tabs` a plugin's `openView()` closes
    // over is the array as it stood when *that panel* opened. A view that
    // opens a companion panel, has the user close it, and offers to reopen
    // it therefore asked about a tab list where the panel was still open,
    // concluded there was nothing to do, and did nothing at all.
    const isNew = !tabsRef.current.some((x) => x.id === tabId);
    if (isNew) {
      // `initialParams` is how a persisted view's saved state reaches its
      // tab — without it, reopening one always fell back to the view's
      // registry defaults and silently discarded whatever was saved.
      const viewParams = initialParams
        ?? defaultParams(viewRegistry.get(viewId)?.params ?? { type: 'object', properties: {} });
      // Falls back to the view's own label, not the artifact's name: once
      // `persistViewParams` (just below) tags this tab with a `savedViewId`,
      // `PanelTab` starts reading its title from exactly this field instead
      // of the view registry — seeding it with the artifact's name left a
      // freshly opened "Object Types" tab flip to the log's own name a
      // moment later, the instant the saved-view record round-tripped.
      const fallbackTitle = viewRegistry.get(viewId)?.label ?? a.name;
      // A placement hint names the *panel* that asked; tabs are what carry
      // the split, and a panel id is `${tabId}#${seq}`.
      const splitFrom = opts?.placement?.fromPanelId.split('#')[0];
      setTabs((t) => [...t, {
        id: tabId, artifactId: a.id, view: viewId, title: title ?? fallbackTitle, viewParams,
        // An explicit request from the opening panel wins over the view's own
        // standing preference: `beside` names a specific panel to sit next to,
        // `dock` only says which side it likes.
        ...(splitFrom && splitFrom !== tabId
          ? { splitFrom, splitDirection: opts!.placement!.beside }
          : dockPlacement(viewRegistry.get(viewId))),
      }]);
      // Only a brand-new tab needs seeding — an existing one was already
      // persisted when it was first created, and re-persisting here would
      // stomp whatever the user has since edited.
      persistViewParams(a.id, viewId, viewParams);
    }
  }, [persistViewParams, dockPlacement]);

  /**
   * The one opener a sandboxed view's own `promenade.openView()` ever
   * reaches (via `Workspace`'s `onOpenView` → `PanelHost`'s
   * `resolveOpenView`) — every other opener (the Inspector's Views list,
   * the tree, a saved view) keeps calling `openView` directly, so only a
   * link followed from *inside* another view of the same artifact is
   * exempted from becoming its new "home" view.
   */
  const openViewFromPlugin = useCallback((
    a: Artifact, viewId: string, initialParams?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string }
  ) => {
    openView(a, viewId, initialParams, undefined, { rememberAsLastView: false, placement });
  }, [openView]);

  /**
   * Browser back/forward across panel switches. The app has no client-side
   * routing to hang a URL off of, so the URL itself never changes — only
   * `history.state` carries which panel to restore. Every genuine
   * `activePanel` change (opening a view, or clicking an already-open tab)
   * pushes one entry; a ref, not state, suppresses the push that would
   * otherwise fire when *this effect's own popstate handler* is the one
   * moving `activePanel`, which would otherwise turn every "back" into an
   * immediate matching "forward" push and trap the user on one entry.
   *
   * `lastPushedKeyRef` dedupes *consecutive* pushes for the same panel —
   * dockview fires its active-panel-changed callback more than once for a
   * single switch (panel creation, then focus), and without this a single
   * "open a view" click landed two (or more) identical entries, so one
   * "back" press only moved from one of them to the other and looked like
   * back/forward did nothing at all.
   */
  const restoringHistoryRef = useRef(false);
  const lastPushedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoringHistoryRef.current) { restoringHistoryRef.current = false; return; }
    if (!activePanel) return;
    const key = `${activePanel.artifactId}:${activePanel.view}`;
    if (key === lastPushedKeyRef.current) return;
    lastPushedKeyRef.current = key;
    window.history.pushState({ artifactId: activePanel.artifactId, view: activePanel.view }, '');
  }, [activePanel]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const state = e.state as { artifactId?: string; view?: string } | null;
      if (!state?.artifactId || !state.view) return;
      const a = graphRef.current.artifacts[state.artifactId];
      // The artifact this history entry pointed to is gone (removed,
      // never persisted across a reload) — nothing sensible to restore,
      // so leave the current panel showing rather than opening nothing.
      if (!a) return;
      lastPushedKeyRef.current = `${state.artifactId}:${state.view}`;
      restoringHistoryRef.current = true;
      openView(a, state.view);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openView]);

  /**
   * Opens one specific saved-view record.
   *
   * While it is the only saved view for its (artifact, view) pair — the
   * overwhelming common case — this defers straight to `openView`, so it
   * shares a tab/panel with the Inspector's "Open this view" button and any
   * other opener of that pair, exactly as before duplication existed. Only
   * once a sibling exists (a duplicated view: two Dotted Charts on the same
   * log, say) does it switch to a tab keyed by the saved view's own id, so
   * two duplicates — and the original — can stay open side by side instead
   * of colliding on one panel.
   */
  const openSavedViewImpl = useCallback((sv: SavedView) => {
    const a = graph.artifacts[sv.sourceArtifactId];
    if (!a) return;
    const hasSiblings = savedViews.some((v) =>
      v.id !== sv.id && v.sourceArtifactId === sv.sourceArtifactId && v.view === sv.view);
    if (!hasSiblings) { openView(a, sv.view, sv.state, sv.title); return; }

    if (viewRegistry.get(sv.view)?.disabled) return;
    lastViewForArtifactRef.current[a.id] = sv.view;
    const open = openPanelsRef.current.find((p) => p.savedViewId === sv.id);
    if (open) { panelFocus.request(open.panelId); return; }
    const tabId = `sv_${sv.id}`;
    const isNew = !tabs.some((x) => x.id === tabId);
    if (isNew) {
      setTabs((t) => [...t, {
        id: tabId, artifactId: a.id, view: sv.view, title: sv.title,
        viewParams: sv.state, savedViewId: sv.id,
      }]);
    }
  }, [graph, savedViews, tabs, openView]);

  /**
   * Whether a saved view's recorded plugin version differs from what's
   * currently installed — `null` for a core view, an unstamped older
   * record, or a plugin no longer installed at all (that's the separate,
   * already-handled `providerMissing` state, not a version mismatch).
   */
  const savedViewMismatch = useCallback((sv: SavedView) => {
    if (!sv.providerId || !sv.providerVersion) return null;
    const installed = plugins.find((p) => p.manifest.id === sv.providerId);
    if (!installed || installed.manifest.version === sv.providerVersion) return null;
    return { pluginId: sv.providerId, recorded: sv.providerVersion, installed: installed.manifest.version };
  }, [plugins]);

  const openSavedView = useCallback((sv: SavedView) => {
    const mismatch = savedViewMismatch(sv);
    const key = mismatch && `savedView:${sv.id}:${mismatch.recorded}>${mismatch.installed}`;
    if (mismatch && key && !acceptedMismatches.current.has(key)) {
      setPendingMismatch({ kind: 'savedView', key, sv, ...mismatch });
      return;
    }
    openSavedViewImpl(sv);
  }, [openSavedViewImpl, savedViewMismatch]);

  const onDuplicateSavedView = useCallback(async (id: string) => {
    const sv = await duplicateSavedView(id);
    setSavedViews((vs) => [...vs, sv]);
    openSavedViewImpl(sv);
  }, [openSavedViewImpl]);

  const openArtifactImpl = useCallback((a: Artifact) => {
    const candidates = viewRegistry.forType(a.type, a).filter((v) => v.component || v.entry || v.nativeView);
    // A declared `primary` view (see `ViewDef.primary`) is the type's
    // canonical one — Ocelot's Overview for an OCEL log, say — and always
    // wins here, full stop. "Last shown through" is only for breaking a tie
    // between competing renderers of equal standing (two Petri net
    // implementations, neither declared canonical) so that whichever one
    // installed first doesn't win forever regardless of which one the user
    // actually chose. It must not out-rank an explicit `primary`: opening a
    // *different* view of the same artifact (Object Types, say) is not the
    // user declaring that view the artifact's new home, and letting it act
    // that way meant double-clicking the artifact — or reopening it any
    // other way — silently stopped landing on Overview for the rest of the
    // session the moment any other view had been looked at even once.
    const lastId = lastViewForArtifactRef.current[a.id];
    const view = candidates.find((v) => v.primary)
      ?? (lastId && candidates.find((v) => v.id === lastId))
      ?? candidates[0];
    if (!view) return;
    lastViewForArtifactRef.current[a.id] = view.id;

    const open = openPanelsRef.current.find((p) => p.artifactId === a.id && p.view === view.id);
    if (open) { panelFocus.request(open.panelId); return; }
    const isNew = !tabs.some((x) => x.artifactId === a.id && x.view === view.id);
    if (isNew) {
      // Restore whatever was saved for this (artifact, view) pair, if
      // anything — otherwise reopening always fell back to bare defaults.
      const saved = savedViews.find((v) => v.sourceArtifactId === a.id && v.view === view.id);
      const viewParams = saved?.state
        ?? defaultParams(view.params ?? { type: 'object', properties: {} });
      // The view's own label, not the artifact's name — see `openView`'s
      // matching comment. `view` is primary as often as not (nothing to
      // persist, so no flip either way), but `lastId` above can just as
      // well resolve to a secondary view, which does get persisted and
      // would otherwise flip its tab to the log's name a moment later.
      setTabs((t) => [...t, {
        id: `${a.id}:${view.id}`, artifactId: a.id,
        view: view.id, title: view.label,
        viewParams, useDefaultLayout: true,
      }]);
      persistViewParams(a.id, view.id, viewParams);
    }
  }, [tabs, savedViews, persistViewParams]);

  /**
   * Whether the plugin that produced this artifact was a different version
   * than what's currently installed. Looked up through the live
   * `actionRegistry` rather than the `plugins` list, so a same-id action
   * still registered by a newer/older install of the plugin resolves
   * correctly without needing its own id-matching heuristic.
   */
  const artifactMismatch = useCallback((a: Artifact) => {
    if (!a.producedBy) return null;
    const exec = graph.executions[a.producedBy];
    if (!exec) return null;
    const def = actionRegistry.get(exec.actionId);
    if (!def || def.version === exec.actionVersion) return null;
    return { pluginId: def.provider, recorded: exec.actionVersion, installed: def.version };
  }, [graph]);

  const openArtifact = useCallback((a: Artifact) => {
    const mismatch = artifactMismatch(a);
    const key = mismatch && `artifact:${a.id}:${mismatch.recorded}>${mismatch.installed}`;
    if (mismatch && key && !acceptedMismatches.current.has(key)) {
      setPendingMismatch({ kind: 'artifact', key, artifact: a, ...mismatch });
      return;
    }
    openArtifactImpl(a);
  }, [openArtifactImpl, artifactMismatch]);

  /**
   * Opens a standalone plugin panel — a view that is not about an artifact
   * because the artifact it makes does not exist yet (`ViewDef.standalone`).
   * Its tab is keyed by the view rather than by an artifact, so asking twice
   * returns to the editor already open instead of starting a second one with
   * a half-typed log in it.
   */
  const openStandaloneView = useCallback((viewId: string) => {
    const def = viewRegistry.get(viewId);
    if (!def?.standalone || def.disabled) return;
    const tabId = `new:${viewId}`;
    const open = openPanelsRef.current.find((p) => p.view === viewId && p.artifactId === tabId);
    if (open) { panelFocus.request(open.panelId); return; }
    if (tabsRef.current.some((t) => t.id === tabId)) return;
    setTabs((t) => [...t, {
      id: tabId, artifactId: tabId, view: viewId, title: def.label,
      viewParams: defaultParams(def.params ?? { type: 'object', properties: {} }),
      ...dockPlacement(def),
    }]);
  }, [dockPlacement]);

  /** Standalone authoring panels contributed by installed plugins. */
  const authoringViews = useMemo(
    () => viewRegistry.all().filter((v) => v.standalone && v.entry && !v.disabled),
    [plugins]
  );

  /**
   * Manufacturing actions (`inputs: []`) contributed by installed plugins —
   * the action-side counterpart to `authoringViews`: no artifact exists yet,
   * so there is nothing to select and no `Inspector` row could ever apply.
   * `RunActionDialog` collects its params (typically a `file` one) instead
   * of a sandboxed view doing so, since these actions are plain host UI, not
   * plugin-supplied iframe code.
   */
  const standaloneActions = useMemo(() => {
    // A manufacturing action with a `file` param is already reachable
    // through the plain Import control (`fileImporterFor`) — its own button
    // here would just be a second way to do the exact same thing, the one
    // difference being it can't be reached by simply dropping the file.
    const fileImporterIds = new Set(fileImporters().map((i) => i.actionId));
    return actionRegistry.all().filter((a) => a.inputs.length === 0 && a.implemented !== false && !fileImporterIds.has(a.id));
  }, [plugins]);
  const [runActionDialogId, setRunActionDialogId] = useState<string | null>(null);

  /** The file picker's own `accept` filter has to list a plugin's import
   * extensions too, or the browser's file dialog hides them before
   * `onImport` ever gets a chance to route them to `fileImporterFor`. */
  const importAccept = useMemo(() => {
    const core = [
      '.xes', '.xes.gz', '.gz', '.json', '.jsonocel', '.xml', '.xmlocel',
      '.sqlite', '.sqlite3', '.db', '.db3', '.csv', '.ocel.zip', '.pnml',
      '.pmplugin', '.zip',
    ];
    const extra = fileImporters().flatMap((i) => i.extensions);
    return [...new Set([...core, ...extra])].join(',');
  }, [plugins]);

  /**
   * A log a standalone authoring view just published. The catalog is
   * already committed (`onGraphUpdated`); what is left is the same tail every
   * import runs — colors seeded, the artifact selected, its default view
   * opened — so an authored log arrives exactly as an imported one does.
   */
  const onPublishedArtifact = useCallback((a: Artifact) => {
    seedColors(a);
    setSelected([a.id]);
    openArtifactImpl(a);
  }, [openArtifactImpl]);

  /**
   * Backs `promenade.deriveLog()` — a view proposing repairs for the log its
   * own artifact was computed from.
   *
   * Three decisions live here rather than in the calling view, because all
   * three are about the catalog:
   *
   *   - *What* the repairs apply to. Never what the caller says: the source is
   *     resolved from the bound artifact's provenance, so a report can only
   *     ever propose fixes for the log it analysed.
   *   - *Where* they land. One derived log per source collects them, found by
   *     `meta.repairOf`, so five clicked fixes make one artifact with five
   *     steps instead of five artifacts. The source is never modified.
   *   - *In what order*. `insertOpOrdered` places each operation at its phase,
   *     because click order is not execution order — canonicalising before
   *     deduplicating is what makes duplicates visible, and the timestamp
   *     assertion has to come after every filter.
   */
  const onDeriveLog = useCallback(async (boundArtifactId: string, proposed: unknown[]) => {
    const graph = graphRef.current;
    const bound = graph.artifacts[boundArtifactId];
    if (!bound) throw new Error('This panel is not bound to an artifact.');

    // The log this artifact was computed from. A report's input is the log; a
    // log opened directly is its own source.
    const source = LOG_TYPES.has(bound.type)
      ? bound
      : bound.inputs.map((id) => graph.artifacts[id]).find((a) => a && LOG_TYPES.has(a.type));
    if (!source) {
      throw new Error('This artifact was not computed from an event log, so there is nothing to repair.');
    }

    // Validate before writing anything: a malformed operation from a plugin
    // must not reach the compiler, and `importOperations` is already the
    // single place that knows every operation's shape.
    let ops: TransformOp[];
    try {
      ops = importOperations(JSON.stringify(proposed));
    } catch (e: any) {
      throw new Error(`Rejected proposed repairs: ${e.message}`);
    }

    const existing = Object.values(graph.artifacts).find(
      (a) => a.storage.kind === 'view' && a.meta?.repairOf === source.id
    );

    if (existing && existing.storage.kind === 'view') {
      let next = existing.storage.plan.ops;
      for (const op of ops) next = insertOpOrdered(next, op);
      await onPlanChange(existing, next);
      openTransformEditor(existing);
      return { id: existing.id, name: existing.name, applied: ops.length };
    }

    let seeded: TransformOp[] = [];
    for (const op of ops) seeded = insertOpOrdered(seeded, op);
    const created = await createDerivedLog(source, seeded, {
      name: `Repaired · ${source.name.replace(/\.[^.]+$/, '')}`,
      meta: { repairOf: source.id },
    });
    return { id: created.id, name: created.name, applied: ops.length };
  }, [onPlanChange, createDerivedLog, openTransformEditor, LOG_TYPES]);

  /**
   * Opens every artifact in `toCompare`'s own default view in a fresh row of
   * splits — always new tabs, never reusing one already open elsewhere. An
   * artifact already open in some unrelated arrangement is not where the
   * user meant "put these side by side"; making that unambiguous by always
   * creating a new column keeps the result predictable at the cost of
   * occasionally leaving a duplicate panel around, which closing is one click.
   */
  const onCompare = useCallback((toCompare: Artifact[]) => {
    if (toCompare.length < 2) return;
    const stamp = Date.now().toString(36);
    const newTabs: OpenTab[] = [];
    let prevId: string | null = null;
    toCompare.forEach((a, i) => {
      const compareCandidates = viewRegistry.forType(a.type, a).filter((v) => v.component || v.entry || v.nativeView);
      const view = compareCandidates.find((v) => v.primary) ?? compareCandidates[0];
      if (!view) return;
      const saved = savedViews.find((v) => v.sourceArtifactId === a.id && v.view === view.id);
      const viewParams = saved?.state ?? defaultParams(view.params ?? { type: 'object', properties: {} });
      const tabId = `cmp_${stamp}_${i}`;
      newTabs.push({
        id: tabId, artifactId: a.id, view: view.id, title: a.name,
        viewParams, useDefaultLayout: true, splitFrom: prevId ?? undefined,
      });
      prevId = tabId;
    });
    if (newTabs.length < 2) return;
    setTabs((t) => [...t, ...newTabs]);
    for (const nt of newTabs) persistViewParams(nt.artifactId, nt.view, nt.viewParams!);
  }, [savedViews, persistViewParams]);

  /**
   * Runs an action and records it in the provenance DAG.
   *
   * A thin wrapper around `executeAction()` — the actual work (which
   * runtime, which worker, how a result becomes an artifact) lives there and
   * in each `ActionDef.run`, not here. This function's only remaining job is
   * what only the UI can do: resolve which selected artifacts fill which
   * declared input slots, then reflect the result into React state.
   */
  const onRun = useCallback(async (
    actionId: string,
    /**
     * Undefined only for a manufacturing action (`inputs: []`) run with no
     * artifact selected — every read below either filters `input` out when
     * falsy (the multi-slot resolution's `allSelected` array) or is gated
     * behind a condition that a zero-input `wasm` action never satisfies
     * (`isPyodide`'s live-preview block), so this never needs its own guard.
     */
    input: Artifact | undefined,
    engine?: { engineId: string; endpoint: string },
    /**
     * Caller-resolved inputs and parameters.
     *
     * The UI never passes this: a click resolves its slots from the selection
     * below, and takes the declared defaults. The Agent API does, because a
     * tool call names its inputs and parameters explicitly instead of
     * depending on what happens to be selected. Everything after the
     * resolution is deliberately shared — an agent-run action has to land in
     * the workspace exactly as a clicked one does, provenance, opened view
     * and all, or the two paths would drift apart.
     */
    override?: {
      inputs?: Record<string, ArtifactId[]>;
      params?: Record<string, unknown>;
      /**
       * A prerequisite the host produces before this action runs — set only
       * by the gallery's reachability planner, for an action the user reached
       * through something it cannot consume directly. The named slot is
       * deliberately left unresolved below and bound by `executeAction`.
       */
      prerequisite?: {
        type: string; producerId: string; inputs: Record<string, ArtifactId[]>; slot: string;
      };
    },
  ): Promise<string | undefined> => {
    const def = actionRegistry.get(actionId);
    if (!def) return undefined;
    const params = { ...defaultParams(def.params), ...(override?.params ?? {}) };

    // View-opening actions produce no artifact and leave no provenance node:
    // the DAG records computation, not what the user happened to look at.
    if (def.opensView) {
      const tabId = `${input.id}:${def.opensView}`;
      const isNew = !tabsRef.current.some((x) => x.id === tabId);
      if (isNew) {
        setTabs((t) => [...t, {
          id: tabId,
          artifactId: input.id,
          view: def.opensView!,
          title: `${def.label} · ${input.name}`,
          viewParams: params,
        }]);
        persistViewParams(input.id, def.opensView, params);
      }
      return undefined;
    }

    if (actionId === 'core.transformLog') { await onTransform(input); return undefined; }
    if (actionId === 'core.flattenOcel') {
      await onTransform(input, {
        type: 'TraditionalEventLog',
        tables: ['event', 'event_attr', 'trace', 'trace_attr'],
        ops: [{ kind: 'flattenByObjectType', objectType: String(params.objectType ?? '') }],
        // The case notion is picked in the editor, so it may not exist yet;
        // a name containing "undefined" would outlive the moment it was true.
        name: `Flattened · ${input.name.replace(/\.[^.]+$/, '')}`,
      });
      return undefined;
    }

    setRunning(true);
    setRunningLabel(def.label);
    setError(null);

    // Supersede any run still going: the newest request wins.
    inFlight.current?.abort();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    const isPyodide = def.runtime === 'pyodide';
    setPyStatus(isPyodide ? 'Starting Python runtime…' : '');

    // Set once a live-preview run is started; cleared when the panel hands
    // off (to the real artifact tab, or on failure).
    let liveViewRunId = '';
    let liveTabTimer: ReturnType<typeof setTimeout> | undefined;
    const dropLiveTab = (state: 'done' | 'error') => {
      clearTimeout(liveTabTimer);
      if (!liveViewRunId) return;
      liveRun.finish(liveViewRunId, state);
      setTabs((t) => t.filter((x) => x.id !== `live:${liveViewRunId}`));
      liveRun.clear(liveViewRunId);
    };

    try {
      // Multi-slot resolution: which selected artifact fills which declared
      // input slot. A UI concern only — `executeAction` (and any nested
      // `produce()` call inside it) only ever sees the resolved role -> id
      // map, never the multi-selection or the provenance graph it came from.
      // `input` is whichever artifact the user clicked first, which says
      // nothing about which slot it fills for a multi-slot action — the
      // Petri Net may well have been clicked before the log.
      const resolvedInputs = override?.inputs;
      const allSelected = [input, ...selectedRef.current.map((id) => graphRef.current.artifacts[id])]
        .filter((a): a is Artifact => !!a)
        .filter((a, index, items) => items.findIndex((other) => other.id === a.id) === index);
      const claimed = new Set<ArtifactId>();
      const inputs: Record<string, ArtifactId[]> = {};
      for (const slot of resolvedInputs ? [] : def.inputs) {
        // Slot order is meaningful when two slots share a type: the clicked
        // artifact fills the first role (e.g. baseline), the other selected
        // artifact fills the next (candidate).  This replaces the former
        // AcceptingPetriNet-specific two-input special case.
        const value = allSelected.find((artifact) =>
          !claimed.has(artifact.id) && artifact.type === slot.type,
        );
        if (!value) {
          // The planner fills this one itself; there is nothing for the user
          // to select and nothing to complain about.
          if (override?.prerequisite?.slot === slot.name) { inputs[slot.name] = []; continue; }
          if (slot.required) throw new Error(`${def.label}: also select ${slot.label}`);
          inputs[slot.name] = [];
          continue;
        }
        claimed.add(value.id);
        inputs[slot.name] = [value.id];
      }
      const runInputs = resolvedInputs ?? inputs;

      // An action whose output type has a live-preview view gets a run-bound
      // panel: it opens now, animates the action's progress, and is swapped
      // for the real artifact tab on completion. `liveViewRunId` stays '' for
      // every other run.
      //
      // Deliberately not restricted to pyodide. A view opts in per artifact
      // type, not per runtime, and the two things a live panel needs — a
      // pending output type and coarse progress — every runtime has. What
      // differs is only how much the panel can show: a pyodide action that
      // emits `ctx.progress` *data* can reconstruct the pending result, while
      // a wasm kernel (one opaque call, `value-finalize/1` especially) can
      // offer nothing but "still working" — which is precisely the case where
      // the alternative is an empty screen and a top-bar bar for a minute.
      const outputType = def.outputs?.[0]?.type;
      const liveView = outputType
        ? viewRegistry.forType(outputType).find((v) => v.livePreview && v.entry)
        : undefined;
      if (liveView && outputType) {
        liveViewRunId = `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const seed = {
          inputs: Object.fromEntries(Object.entries(runInputs).map(([slot, ids]) => [
            slot,
            ids[0] ? (payloadOf(ids[0]) ?? (graphRef.current.artifacts[ids[0]]?.storage as any)?.value ?? null) : null,
          ])),
        };
        liveRun.start(liveViewRunId, actionId, outputType, seed);
        const liveTabId = `live:${liveViewRunId}`;
        // The run is recorded at once, but its *panel* only opens if the run
        // is still going a moment later. A discovery that finishes in half a
        // second would otherwise flash a tab open and shut on every click,
        // which is worse than the wait it was meant to fill. Nothing is lost
        // by waiting: frames accumulate in `liveRun` meanwhile and
        // `PluginPanel` replays the whole backlog when the panel handshakes.
        liveTabTimer = setTimeout(() => {
          setTabs((t) => [...t, {
            id: liveTabId, artifactId: liveTabId, view: liveView.id,
            title: `${def.label} · ${input.name}`, live: true,
          }]);
        }, 400);
      }

      const result = await executeAction({
        actionId, inputs: runInputs, params, signal: ctrl.signal,
        prerequisite: override?.prerequisite as any,
        // Every runtime's progress reaches the busy indicator and any live
        // panel, not just pyodide's: the wasm worker already reports its
        // chunked scan ("120000 / 250000 events"), and dropping it was the
        // reason a long wasm action showed nothing but an indeterminate bar.
        onProgress: (fraction, message, data) => {
          const known = Number.isFinite(fraction);
          const pct = known ? `${Math.round(fraction * 100)}% · ` : '';
          setPyStatus(`${pct}${message || (isPyodide ? 'Running Python…' : 'Working…')}`);
          if (liveViewRunId) {
            liveRun.progress(liveViewRunId, known ? fraction : null, message ?? '');
            if (data) liveRun.frame(liveViewRunId, data);
          }
        },
        engine,
      });
      if (!result) { dropLiveTab('error'); return undefined; } // superseded or canceled
      // `onRun` is for producing an artifact — an `exportsFile` action never
      // reaches here (it's excluded from `applicableTo`/the Inspector list
      // and is only ever run via `onExportAction`), so this always holds.
      if (!('artifact' in result)) throw new Error(`${def.label}: exported a file, not an artifact`);
      dropLiveTab('done');

      setGraph(result.catalog);
      setQuota(result.quota);
      setLiveParams(params);
      setSelected([result.artifact.id]);
      // Open the first installed renderer that explicitly claims this
      // artifact type. Plugin renderers use `entry` rather than a native
      // component, so they must participate here too. Generic utility views
      // such as Provenance deliberately do not become an artifact's default.
      const postRunCandidates = viewRegistry.forType(result.artifact.type, result.artifact)
        .filter((v) => !!v.appliesTo && (v.component || v.entry || v.nativeView));
      const view = postRunCandidates.find((v) => v.primary) ?? postRunCandidates[0];
      if (view) {
        lastViewForArtifactRef.current[result.artifact.id] = view.id;
        setTabs((t) => [...t, {
          id: `${result.artifact.id}:${view.id}`, artifactId: result.artifact.id, view: view.id, title: result.artifact.name,
        }]);
        persistViewParams(result.artifact.id, view.id, defaultParams(view.params ?? { type: 'object', properties: {} }));
      }
      return result.artifact.id;
    } catch (e: any) {
      dropLiveTab('error');
      setError(`${def.label}: ${e.message}`);
      // Rethrown for a caller that asked for this run explicitly (the Agent
      // API): the banner tells the user, the exception tells the agent. A
      // click has no caller to catch it, and `onRun` is awaited nowhere in
      // the UI, so nothing changes for it.
      if (override) throw e;
    } finally {
      // A superseded run is aborted asynchronously. It must not erase the
      // progress message belonging to the newer Python action.
      if (inFlight.current === ctrl) {
        setRunning(false);
        setRunningLabel('');
        setPyStatus('');
      }
    }
  }, []);

  /**
   * Abandon whatever action is running.
   *
   * The same `AbortController` a superseding run would have used, so this is
   * the mechanism that already existed rather than a second one: every
   * runtime honours it (the wasm runner raises the worker's abort flag and
   * discards the worker if the kernel does not stop within 500ms; pyodide and
   * the relational path check `signal.aborted` between stages), `executeAction`
   * resolves to `null`, and `onRun`'s own `finally` clears the busy state and
   * closes any live-preview panel. Nothing is left half-written: an artifact
   * is only put in the catalog after the run completes.
   */
  const onCancelRun = useCallback(() => {
    inFlight.current?.abort();
    setPyStatus('Canceling…');
  }, []);

  /**
   * The live loop.
   *
   * A cheap parameter reuses the plugin's cached expensive stage, so this
   * costs single-digit milliseconds and can follow a slider drag. An expensive
   * parameter invalidates that cache, so it is debounced harder and the
   * in-flight run is discarded.
   */
  /**
   * The destination gallery's tab id — one per workspace, deliberately fixed.
   *
   * The gallery is a *preview* tab in the editor sense: clicking a second
   * artifact re-points the one that is open rather than opening another, so
   * walking the tree never leaves a trail of galleries behind. Re-pointing
   * works because `Workspace`'s param-sync effect already pushes a changed
   * `artifactId` into a live panel (a scratchpad becoming a `Script` needs
   * the same thing), so nothing has to be closed and reopened to retarget it.
   */
  const GALLERY_TAB = 'gallery';

  const openGallery = useCallback((a: Artifact) => {
    const existing = tabsRef.current.find((t) => t.id === GALLERY_TAB);
    if (existing) {
      if (existing.artifactId !== a.id) {
        setTabs((t) => t.map((x) => (x.id === GALLERY_TAB ? { ...x, artifactId: a.id } : x)));
      }
      const panel = openPanelsRef.current.find((x) => x.panelId.split('#')[0] === GALLERY_TAB);
      if (panel) panelFocus.request(panel.panelId);
      return;
    }
    setTabs((t) => [...t, {
      id: GALLERY_TAB, artifactId: a.id, view: 'core.gallery', title: 'Explore', preview: true,
    }]);
  }, []);

  /**
   * Opens one gallery card.
   *
   * The gallery does not know whether a card is a view or an action — that is
   * the point of the `Destination` vocabulary — so the branch lives here,
   * beside the three openers it delegates to. Each one is the *same* function
   * the Inspector and the tree already call, so a destination opened from the
   * gallery lands in the workspace identically to one opened the old way,
   * provenance and saved-view records included.
   *
   * The gallery tab then closes, which is what makes a preview tab read as
   * having *become* the result rather than as a menu left lying open. An
   * export is the exception: it downloads a file and opens no panel, so
   * closing the gallery would leave the user staring at whatever was behind
   * it with no sign anything happened.
   */
  const onOpenDestination = useCallback((
    d: Destination, a: Artifact,
    /**
     * Set only when the user filled in the card's settings dialog first.
     * Absent means "the declared defaults", which is the gallery's normal
     * one-click contract.
     */
    params?: Record<string, unknown>,
  ) => {
    noteOpened(d.key);
    const closeGallery = () => setTabs((t) => t.filter((x) => x.id !== GALLERY_TAB));
    if (d.kind === 'export' && d.actionId) {
      void onExportAction(d.actionId, a, {
        ...defaultParams(actionRegistry.get(d.actionId)!.params), ...(params ?? {}),
      });
      return;
    }
    if (d.kind === 'view' && d.viewId) {
      openView(a, d.viewId, params);
      closeGallery();
      return;
    }
    if (d.actionId) {
      // Only a host-planned step is the host's to run. An action that declares
      // `scans` produces its own prerequisite inside its runtime adapter, and
      // handing it a second one here would mine the same model twice.
      const step = d.chain?.find((c) => c.plannedByHost);
      void onRun(d.actionId, a, undefined, (step || params) ? {
        ...(params ? { params } : {}),
        ...(step ? {
          prerequisite: {
            type: step.type, producerId: step.producerId, inputs: step.inputs, slot: step.slot,
          },
        } : {}),
      } : undefined);
      closeGallery();
    }
  }, [openView, onRun, onExportAction]);

  /**
   * The rest of the selection, for the gallery's own applicability check.
   * Memoised so the param-sync effect that pushes it into the panel does not
   * re-run on every unrelated render.
   */
  const gallerySelection = useMemo(() => selected, [selected.join(',')]);

  const onParamChange = useCallback((artifact: Artifact, key: string, value: unknown, cheap: boolean) => {
    setLiveParams((prev) => {
      // `prev` is only this session's live edits, which is empty on the very
      // first drag after selecting an artifact restored from a previous
      // session (or after switching away and back) — the Inspector already
      // falls back to `exec.params` to *display* that case correctly, but a
      // plain `prev ?? {}` here would still send Python only the one key
      // just touched, dropping every other required param. The producing
      // execution's own params are the base every live edit builds on.
      const exec = artifact.producedBy ? graphRef.current.executions[artifact.producedBy] : null;
      const next = { ...(exec?.params ?? {}), ...(prev ?? {}), [key]: value };
      scheduleRecompute(artifact, next, cheap);
      return next;
    });
  }, []);

  /**
   * Recomputes one artifact against `params` and commits the result in
   * place — same artifact id, same execution id (`executeAction`'s `reuse`).
   *
   * Shared by the live param-edit loop (debounced, below) and the explicit
   * "Recompute" action on a stale artifact (immediate). Either way, the
   * artifacts *derived from* this one are not touched — their own results
   * still reflect this artifact's previous output, so they are marked
   * `stale` rather than silently left to look current. Recomputing an
   * entire downstream chain automatically would re-run every expensive
   * stage on every keystroke of the topmost slider; marking-and-letting-the-
   * user-decide is the same trade the live loop already makes for the one
   * artifact it does recompute (cheap vs. costly debounce), just one level
   * up the graph.
   */
  const runRecompute = useCallback(async (artifact: Artifact, params: Record<string, unknown>, explicit = false) => {
    const exec = artifact.producedBy ? graphRef.current.executions[artifact.producedBy] : null;
    if (!exec) return;
    // Only the explicit "Recompute" button shows the busy indicator; a live
    // slider drag recomputes many times a second and must not flash it.
    if (explicit) { setRunning(true); setRunningLabel('Recompute'); }
    try {
      const ctrl = new AbortController();
      const result = await executeAction({
        actionId: exec.actionId, inputs: exec.inputs, params,
        signal: ctrl.signal, reuse: artifact,
      });
      if (!result) return; // superseded
      // Recomputing an already-produced artifact in place — an `exportsFile`
      // action never produced one to begin with, so this always holds.
      if (!('artifact' in result)) throw new Error('recompute: exported a file, not an artifact');

      // Computed before the graph updates below, so it reads the pre-update
      // edge set — the same one this artifact's own new result was just
      // derived within, not one a concurrent edit could have changed.
      const affected = descendantsOf(graphRef.current, artifact.id);
      setGraph(() => {
        const artifacts = { ...result.catalog.artifacts };
        for (const id of affected) {
          if (artifacts[id]) artifacts[id] = { ...artifacts[id], stale: true };
        }
        return { artifacts, executions: result.catalog.executions };
      });
      setQuota(result.quota);
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (explicit) { setRunning(false); setRunningLabel(''); }
    }
  }, []);


  const scheduleRecompute = useMemo(() => {
    const cheapDebounced = debounce(runRecompute, 16);   // follows the drag
    const costlyDebounced = debounce(runRecompute, 350); // wait for the drag to settle
    return (a: Artifact, p: Record<string, unknown>, cheap: boolean) =>
      (cheap ? cheapDebounced : costlyDebounced)(a, p);
  }, [runRecompute]);

  /** The stale artifact's own "Recompute" button — re-runs it against its
   *  last-used params, immediately, no debounce. */
  const onRecompute = useCallback((artifact: Artifact) => {
    const exec = artifact.producedBy ? graphRef.current.executions[artifact.producedBy] : null;
    if (!exec) return;
    runRecompute(artifact, exec.params, true);
  }, [runRecompute]);


  const onRemovePlugin = useCallback(async (id: string) => {
    disposeRunnersFor(id);
    await removePlugin(id);
    setPlugins(await listInstalled());
    setTabs((t) => t.filter((x) => x.id !== `plugin:${id}`));
    // Artifacts of the removed plugin's types stay, flagged.
    setGraph((g) => ({
      ...g,
      artifacts: Object.fromEntries(Object.entries(g.artifacts).map(([k, a]) => {
        const ex = a.producedBy ? g.executions[a.producedBy] : null;
        return [k, ex && ex.actionId.startsWith(id) ? { ...a, providerMissing: true } : a];
      })),
    }));
  }, []);

  /**
   * Persists the scratchpad as a `Script` artifact.
   *
   * A script the user wrote is work, not a transient view: it gets a provenance
   * node like any other derivation, with the log it was written against as its
   * input. Saving an already-saved script updates it in place rather than
   * accumulating near-duplicates in the tree.
   */
  const onSaveScript = useCallback(async (code: string, input: Artifact, nameOverride?: string) => {
    const existing = input.type === 'Script';
    const logId = existing ? (input.inputs?.[0] ?? '') : input.id;
    const log = graphRef.current.artifacts[logId];
    const id = existing ? input.id : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    // Re-saving replaces the execution rather than adding one. A new id per
    // save would leave the old node in the DAG with nothing pointing at it —
    // the graph would grow an orphan for every keystroke session.
    const execId = (existing && input.producedBy) || `x_${Date.now().toString(36)}`;

    const execution: ActionExecution = {
      id: execId,
      actionId: 'core.scriptEditor',
      actionVersion: '1',
      inputs: { log: logId ? [logId] : [] },
      outputs: [id],
      params: {},
      startedAt: new Date().toISOString(),
      durationMs: 0,
      runtime: { kind: 'core', version: 'editor' },
    };
    const artifact: Artifact = {
      ...(existing ? input : {}),
      id,
      name: existing ? input.name
        : (nameOverride?.trim() || `Script · ${(log?.name ?? '').replace(/\.[^.]+$/, '')}`),
      type: 'Script',
      createdAt: existing ? input.createdAt : new Date().toISOString(),
      storage: { kind: 'inline', value: { code } },
      meta: { lines: code.split('\n').length },
      producedBy: execId,
      inputs: logId ? [logId] : [],
    };

    const r: any = await dataClient.putArtifact(artifact, execution);
    setGraph(r.catalog);
    setQuota(r.quota);
    // Re-point the editor tab at the saved artifact so a further save updates
    // it instead of creating a second one.
    if (!existing) {
      setTabs((t) => t.map((x) =>
        x.artifactId === input.id && x.view === 'core.scriptEditor'
          ? { ...x, artifactId: id, title: artifact.name }
          : x));
      setSelected([id]);
    }
    // Published-from-an-unsaved-script provenance needs the freshly persisted
    // artifact back — `r.catalog` is the canonical post-write copy, `artifact`
    // the local fallback if the catalog write somehow didn't round-trip it.
    return (r.catalog?.artifacts?.[id] as Artifact | undefined) ?? artifact;
  }, []);

  /**
   * Persists a notebook as a `Notebook` artifact — harmonized with
   * `onSaveScript` above, field for field: same re-save-replaces-the-
   * execution behavior, same input-log resolution, same tab-repointing on
   * first save. The notebook's own cells (code, markdown, outputs) are the
   * artifact's inline payload, the same way a `Script` artifact's payload
   * is its code. See docs/python-notebook.md, "Persistence".
   */
  const onSaveNotebook = useCallback(async (doc: NotebookDocument, input: Artifact, nameOverride?: string) => {
    const existing = input.type === 'Notebook';
    const logId = existing ? (input.inputs?.[0] ?? '') : input.id;
    const id = existing ? input.id : `nb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const execId = (existing && input.producedBy) || `x_${Date.now().toString(36)}`;

    const execution: ActionExecution = {
      id: execId,
      actionId: 'core.notebook',
      actionVersion: '1',
      inputs: { log: logId ? [logId] : [] },
      outputs: [id],
      params: {},
      startedAt: new Date().toISOString(),
      durationMs: 0,
      runtime: { kind: 'core', version: 'editor' },
    };
    const artifact: Artifact = {
      ...(existing ? input : {}),
      id,
      name: existing ? input.name : (nameOverride?.trim() || doc.title),
      type: 'Notebook',
      createdAt: existing ? input.createdAt : new Date().toISOString(),
      storage: { kind: 'inline', value: doc },
      meta: { cells: doc.cells.length },
      producedBy: execId,
      inputs: logId ? [logId] : [],
    };

    const r: any = await dataClient.putArtifact(artifact, execution);
    setGraph(r.catalog);
    setQuota(r.quota);
    if (!existing) {
      setTabs((t) => t.map((x) =>
        x.artifactId === input.id && x.view === 'core.notebook'
          ? { ...x, artifactId: id, title: artifact.name }
          : x));
      setSelected([id]);
    }
    return (r.catalog?.artifacts?.[id] as Artifact | undefined) ?? artifact;
  }, []);

  /** Reconciles tabs, selection and saved views against a post-delete
   *  catalog — shared by single and bulk deletion. `before` is the
   *  catalog as it stood before the deletion(s), so every id missing from
   *  `catalog` (the clicked artifact *and* everything the worker cascaded)
   *  gets its views cleaned up. */
  const reconcileAfterRemoval = useCallback(async (before: ProvenanceGraph, catalog: any, quota: any) => {
    const removedIds = new Set(
      Object.keys(before.artifacts).filter((aid) => !catalog.artifacts[aid])
    );
    if (removedIds.size) {
      await removeViewsForSources(removedIds);
      setSavedViews((vs) => vs.filter((v) => !removedIds.has(v.sourceArtifactId)));
    }
    setGraph(catalog);
    setQuota(quota);
    setTabs((t) => t.filter((x) => catalog.artifacts[x.artifactId]));
    setSelected((s) => s.filter((x) => catalog.artifacts[x]));
  }, []);

  const onRemove = useCallback(async (id: string) => {
    const before = graphRef.current;
    try {
      const r: any = await dataClient.remove(id);
      await reconcileAfterRemoval(before, r.catalog, r.quota);
    } catch (e: any) {
      setError(`Delete artifact: ${e.message ?? e}`);
    }
  }, [reconcileAfterRemoval]);

  /** Deletes several artifacts in one gesture (multi-select + Backspace).
   *  Sequential on purpose: each `remove` cascades to descendants, so an id
   *  later in the list may already be gone — the catalog check skips it
   *  rather than erroring. */
  const onRemoveMany = useCallback(async (ids: string[]) => {
    const before = graphRef.current;
    let catalog: any = before;
    let quota: any = null;
    try {
      for (const id of ids) {
        if (!catalog.artifacts[id]) continue;
        const r: any = await dataClient.remove(id);
        catalog = r.catalog;
        quota = r.quota;
      }
      if (quota == null) return; // nothing was actually deleted
      await reconcileAfterRemoval(before, catalog, quota);
    } catch (e: any) {
      setError(`Delete artifacts: ${e.message ?? e}`);
    }
  }, [reconcileAfterRemoval]);

  /** Renames an artifact's own record — distinct from `onRenameSavedView`,
   * which renames a saved parameterised view of one. */
  const onRenameArtifact = useCallback(async (id: string, name: string) => {
    try {
      const r: any = await dataClient.rename(id, name);
      setGraph(r.catalog);
    } catch (e: any) {
      setError(`Rename artifact: ${e.message ?? e}`);
    }
  }, []);

  /** Moves a root artifact — and everything derived from it — into another
   * workspace. Its tabs/selection/saved views close out of the current
   * workspace the same way `onRemove`'s do, since the data really is gone
   * from here now, just not deleted. */
  const onMoveArtifactToWorkspace = useCallback(async (artifactId: string, destWorkspaceId: string) => {
    try {
      const r: any = await dataClient.moveArtifactToWorkspace(artifactId, destWorkspaceId);
      const movedIds = new Set(
        Object.keys(graphRef.current.artifacts).filter((aid) => !r.catalog.artifacts[aid])
      );
      setGraph(r.catalog);
      setQuota(r.quota);
      if (movedIds.size) {
        setSavedViews((vs) => vs.filter((v) => !movedIds.has(v.sourceArtifactId)));
        setTabs((t) => t.filter((x) => !movedIds.has(x.artifactId)));
        setSelected((s) => s.filter((x) => !movedIds.has(x)));
      }
    } catch (e: any) {
      setError(`Move artifact: ${e.message ?? e}`);
    }
  }, []);

  const onRelocateArtifact = useCallback(async (
    artifact: Artifact, kind: 'copy' | 'move-to-engine' | 'move-to-browser', engine: ComputeEngine,
  ) => {
    try {
      const fn = kind === 'copy' ? copyArtifactToEngine : kind === 'move-to-engine' ? moveArtifactToEngine : moveArtifactToBrowser;
      const catalog = await fn(artifact, engine);
      setGraph(catalog);
    } catch (e: any) {
      const verb = kind === 'copy' ? 'Copy to Promenade Compute' : kind === 'move-to-engine' ? 'Move to Promenade Compute' : 'Move to Browser';
      setError(`${verb}: ${e.message ?? e}`);
    }
  }, []);

  const onSwitchWorkspace = useCallback(async (id: string) => {
    try { await dataClient.switchWorkspace(id); window.location.reload(); }
    catch (e: any) { setError(`Switch workspace: ${e.message ?? e}`); }
  }, []);

  const onCreateWorkspace = useCallback(async (name: string) => {
    try {
      const { workspace } = await dataClient.createWorkspace(name);
      await dataClient.switchWorkspace(workspace.id);
      window.location.reload();
    } catch (e: any) { setError(`Create workspace: ${e.message ?? e}`); }
  }, []);

  const onRenameWorkspace = useCallback(async (name: string) => {
    try {
      const { workspaces: next } = await dataClient.renameWorkspace(activeWorkspaceId, name);
      setWorkspaces(next);
    } catch (e: any) { setError(`Rename workspace: ${e.message ?? e}`); }
  }, [activeWorkspaceId]);

  const onDeleteWorkspace = useCallback(async () => {
    try {
      const { workspaces: remaining } = await dataClient.deleteActiveWorkspace();
      if (remaining[0]) await dataClient.switchWorkspace(remaining[0].id);
      window.location.reload();
    } catch (e: any) { setError(`Delete workspace: ${e.message ?? e}`); }
  }, []);

  const onExportWorkspace = useCallback(async (includeLocalPlugins: boolean) => {
    try {
      const data = await dataClient.exportWorkspaceData();
      const bytes = await buildWorkspaceBundle(data, plugins, includeLocalPlugins);
      const a = document.createElement('a');
      const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/zip' }));
      a.download = `${data.meta.name.replace(/[^A-Za-z0-9_.-]/g, '_')}.pmworkspace`;
      a.click(); URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(`Export workspace: ${e.message ?? e}`);
    } finally {
      setExportWorkspaceOpen(false);
    }
  }, [plugins]);

  const onImportWorkspaceFile = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setImportBundle(parseWorkspaceBundle(bytes));
    } catch (e: any) {
      setError(`Import workspace: ${e.message ?? e}`);
    }
  }, []);

  const onConfirmImportWorkspace = useCallback(async (name: string, installLocalPlugins: boolean) => {
    if (!importBundle) return;
    try {
      if (installLocalPlugins) {
        for (const [id, bytes] of Object.entries(importBundle.localPlugins)) {
          const res = await installPackage(bytes, { kind: 'local' });
          if (!res.ok) setError(`${id}: ${res.errors.join('; ')}`);
        }
      }
      const { workspace } = await dataClient.importWorkspaceData({
        name,
        artifacts: importBundle.artifacts,
        executions: importBundle.executions,
        views: importBundle.views,
        files: importBundle.files,
      });
      await dataClient.switchWorkspace(workspace.id);
      window.location.reload();
    } catch (e: any) {
      setError(`Import workspace: ${e.message ?? e}`);
    } finally {
      setImportBundle(null);
    }
  }, [importBundle]);

  /** Wipes OPFS and reloads — the only way to a state that actually matches
   * an empty worker, rather than trying to unwind everything this tab has
   * cached in memory to match it. */
  const onConfirmReset = useCallback(async () => {
    await dataClient.reset();
    window.location.reload();
  }, []);

  const applyStorageBreakdown = useCallback((breakdown: StorageBreakdown) => {
    setStorageDetails(breakdown);
    setQuota({ quota: breakdown.quota, usage: breakdown.usage, persisted: breakdown.persisted });
    setUnusedMaterializations(breakdown.opfs.orphanArtifactDirectories);
  }, []);

  const refreshStorageDetails = useCallback(async () => {
    setStorageDetailsLoading(true);
    try {
      const { breakdown } = await dataClient.storageBreakdown();
      applyStorageBreakdown(breakdown);
    } catch (e: any) {
      setError(`Storage details: ${e.message ?? e}`);
    } finally {
      setStorageDetailsLoading(false);
    }
  }, [applyStorageBreakdown]);

  const openStorageDetails = useCallback(() => {
    setStorageDetailsOpen(true);
    void refreshStorageDetails();
  }, [refreshStorageDetails]);

  /**
   * Puts artifact directories the catalog has lost back into the catalog,
   * and into the tree, without the user having to re-import anything.
   */
  const recoverOrphanArtifacts = useCallback(async (): Promise<string> => {
    try {
      const r = await dataClient.recoverArtifacts();
      applyStorageBreakdown(r.breakdown);
      const restored = r.fromSidecar.length + r.reconstructed.length;
      if (restored) setGraph(r.graph);
      if (!restored) {
        return r.unreadable.length
          ? `Nothing to recover: ${r.unreadable.length} orphaned director${r.unreadable.length === 1 ? 'y holds' : 'ies hold'} no readable artifact files.`
          : 'Nothing to recover — every artifact directory already has a catalog entry.';
      }
      const parts = [`Recovered ${restored} artifact${restored === 1 ? '' : 's'}`];
      if (r.fromSidecar.length) parts.push(`${r.fromSidecar.length} fully, from their own saved entries`);
      if (r.reconstructed.length) {
        const named = r.renamed.length;
        parts.push(
          `${r.reconstructed.length} rebuilt from their files, without provenance`
          + (named === r.reconstructed.length ? ' (names restored from saved views)'
            : named ? ` (${named} name${named === 1 ? '' : 's'} restored from saved views)`
              : ' or names')
        );
      }
      if (r.unreadable.length) parts.push(`${r.unreadable.length} could not be read`);
      return `${parts.join(' — ')}.`;
    } catch (e: any) {
      setError(`Recover orphaned artifacts: ${e.message ?? e}`);
      return 'Recovery failed; see the error above.';
    }
  }, [applyStorageBreakdown]);

  const removeOrphanArtifactFiles = useCallback(async () => {
    try {
      const { breakdown } = await dataClient.removeOrphanArtifactFiles();
      applyStorageBreakdown(breakdown);
    } catch (e: any) {
      setError(`Remove orphaned artifact files: ${e.message ?? e}`);
    }
  }, [applyStorageBreakdown]);

  const clearCacheStorage = useCallback(async () => {
    try {
      const { breakdown } = await dataClient.clearCacheStorage();
      applyStorageBreakdown(breakdown);
    } catch (e: any) {
      setError(`Clear Cache Storage: ${e.message ?? e}`);
    }
  }, [applyStorageBreakdown]);

  /** Selecting saved views and selecting an artifact are mutually exclusive. */
  const onSelectSavedViews = useCallback((ids: string[]) => {
    setSelectedSavedViewIds(ids);
    if (ids.length > 0) setSelected([]);
  }, []);

  const onOpenSavedView = useCallback((sv: SavedView) => {
    if (!graph.artifacts[sv.sourceArtifactId]) return;
    // `openSavedView` seeds the tab with `sv.state`/`sv.title` so reopening
    // shows what was last saved (and possibly renamed) as, not the
    // registry's bare defaults — and gives a duplicated view its own panel
    // instead of colliding with its sibling's.
    openSavedView(sv);
    setSelected([sv.sourceArtifactId]);
    setSelectedSavedViewIds([]);
  }, [graph, openSavedView]);

  const onRenameSavedView = useCallback(async (id: string, title: string) => {
    await renameSavedView(id, title);
    setSavedViews((v) => v.map((sv) => (sv.id === id ? { ...sv, title } : sv)));
    // An already-open tab's label is pushed the same way its params are —
    // otherwise a rename shows up in the tree but not on the panel showing
    // that exact view.
    setTabs((t) => t.map((tab) => (tab.savedViewId === id ? { ...tab, title } : tab)));
  }, []);

  const onRemoveSavedView = useCallback(async (id: string) => {
    await removeSavedView(id);
    setSavedViews((v) => v.filter((sv) => sv.id !== id));
    setSelectedSavedViewIds((cur) => cur.filter((x) => x !== id));
    setTabs((t) => t.filter((x) => x.savedViewId !== id));
  }, []);

  const onRemoveManySavedViews = useCallback(async (ids: string[]) => {
    await removeSavedViews(ids);
    const gone = new Set(ids);
    setSavedViews((v) => v.filter((sv) => !gone.has(sv.id)));
    setSelectedSavedViewIds((cur) => cur.filter((x) => !gone.has(x)));
    setTabs((t) => t.filter((x) => !x.savedViewId || !gone.has(x.savedViewId)));
  }, []);

  /**
   * The Promenade Agent API's host binding.
   *
   * The provenance graph, the open tabs and the selection live in this
   * component's state, so the agent layer borrows them through a binding
   * rather than keeping a second copy. Every callback here is one the UI
   * already uses for a click — deliberately, so an agent cannot reach a code
   * path a human never takes. See docs/promenade-agent-api.md.
   */
  useEffect(() => {
    const unbind = bindAgentHost({
      getGraph: () => graphRef.current,
      getSelection: () => selectedRef.current,
      setSelection: (ids) => { setSelected(ids); if (ids.length) setSelectedSavedViewIds([]); },
      getOpenViews: () => tabsRef.current.map((t) => ({
        artifactId: t.artifactId, view: t.view, title: t.title,
      })),
      getWorkspace: () => ({
        id: activeWorkspaceIdRef.current,
        name: workspacesRef.current.find((w) => w.id === activeWorkspaceIdRef.current)?.name ?? 'Workspace',
      }),
      openView: (artifact, viewId, params) => openViewRef.current(artifact, viewId, params),
      runAction: (actionId, opts) => onRunRef.current(actionId, opts.input, undefined, {
        inputs: opts.inputs, params: opts.params,
      }),
      recompute: (artifact, params) => runRecomputeRef.current(artifact, params, true),
      renameArtifact: (id, name) => onRenameArtifactRef.current(id, name),
      deleteArtifact: (id) => onRemoveRef.current(id),
      importSample: async (sampleId) => {
        const sample = SAMPLE_LOGS.find((s) => s.id === sampleId);
        if (!sample) throw new Error(`unknown sample '${sampleId}'`);
        const before = new Set(Object.keys(graphRef.current.artifacts));
        await onImportSampleRef.current(sample);
        // The import resolves before React has committed the new catalog,
        // so the id is found by watching the graph rather than by reading it
        // once — otherwise the caller is told "imported" with nothing to show.
        const deadline = Date.now() + 5000;
        for (;;) {
          const fresh = Object.keys(graphRef.current.artifacts).find((id) => !before.has(id));
          if (fresh || Date.now() > deadline) return fresh;
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      pluginsChanged: async () => { setPlugins(await listInstalled()); },
      removePlugin: (id) => onRemovePluginRef.current(id),
    });
    const stop = startAgentLayer();
    return () => { stop(); unbind(); };
  }, []);

  const selectedSavedView = selectedSavedViewIds.length === 1
    ? savedViews.find((v) => v.id === selectedSavedViewIds[0]) ?? null
    : null;

  onRunRef.current = onRun;
  openViewRef.current = openView;
  runRecomputeRef.current = runRecompute;
  onRenameArtifactRef.current = onRenameArtifact;
  onRemoveRef.current = onRemove;
  onRemovePluginRef.current = onRemovePlugin;
  onImportSampleRef.current = onImportSample;
  activeWorkspaceIdRef.current = activeWorkspaceId;
  workspacesRef.current = workspaces;

  const usedPct = quota?.quota ? (quota.usage / quota.quota) * 100 : 0;

  // Fullscreen plugin views live inside the browser's fullscreen element, so
  // the normal right rail is intentionally outside it. Supply the same
  // inspector content for the overlay to slide in on demand.
  const renderFullscreenInspector = () => (
    <Inspector
      artifacts={selectedArtifacts}
      graph={graph}
      selectedSavedView={selectedSavedView}
      openPanels={openPanels}
      onOpenView={openView}
      onRun={onRun}
      computeEngines={computeEngines}
      liveParams={selected.length === 1 && graph.artifacts[selected[0]]?.producedBy ? liveParams : null}
      onParamChange={onParamChange}
      running={running}
      plugins={plugins}
      onPluginsChanged={async () => setPlugins(await listInstalled())}
      onClassifierChange={onClassifierChange}
      experimentalPluginIds={experimentalPluginIds}
      activePanel={activePanel ? {
        title: activePanel.title,
        view: activePanel.view,
        values: tabs.find((t) => t.id === activePanel.tabId)?.viewParams ?? {},
        artifactId: activePanel.artifactId,
      } : null}
      onCompare={onCompare}
      onRecompute={onRecompute}
      onExplore={openGallery}
      onViewParamChange={(key, value) => {
        if (!activePanel) return;
        const tab = tabs.find((t) => t.id === activePanel.tabId);
        const next = { ...(tab?.viewParams ?? {}), [key]: value };
        setTabs((t) => t.map((x) => x.id === activePanel.tabId
          ? { ...x, viewParams: next }
          : x));
        persistViewParamsDebounced(activePanel.artifactId, activePanel.view, next, tab?.savedViewId);
      }}
      onSavedViewParamChange={(key, value) => {
        if (!selectedSavedView) return;
        const sv = selectedSavedView;
        const next = { ...sv.state, [key]: value };
        setSavedViews((vs) => vs.map((v) => (v.id === sv.id ? { ...v, state: next } : v)));
        // Keyed by the specific tab tagged with this saved view's id when one
        // exists — matching by (artifactId, view) alone would touch every
        // tab sharing that pair, including any other duplicated view.
        setTabs((t) => t.map((tab) => (tab.savedViewId
          ? tab.savedViewId === sv.id
          : tab.artifactId === sv.sourceArtifactId && tab.view === sv.view)
          ? { ...tab, viewParams: next }
          : tab));
        persistViewParamsDebounced(sv.sourceArtifactId, sv.view, next, sv.id);
      }}
    />
  );

  if (anotherTab) return <AnotherTabGate />;

  return (
    <div className="app">
      <div className="topbar">
        {running && <div className="busy-bar" role="progressbar" aria-label={`${runningLabel || 'Working'}…`} />}
        <BrandLogo height={34} />

        {workspaces.length > 0 && (
          <WorkspaceSwitcher
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onRename={onRenameWorkspace}
            onDelete={onDeleteWorkspace}
            onExport={() => setExportWorkspaceOpen(true)}
            onImport={() => workspaceFileInput.current?.click()}
          />
        )}
        <input
          ref={workspaceFileInput} type="file" hidden accept=".pmworkspace,.zip"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onImportWorkspaceFile(f); e.target.value = ''; }}
        />

        <div className="spacer" />

        {importing && (
          <div className="import-progress">
            <div className="import-status" title={importing}>
              {progress?.phase === 'parquet' ? 'writing Parquet' : 'parsing'} · {importing}
            </div>
            <div className="progress">
              <div style={{
                width: progress ? `${(progress.done / Math.max(1, progress.total)) * 100}%` : '0%',
              }} />
            </div>
          </div>
        )}

        {running && (
          <span className="busy-indicator" title={pyStatus || `Running ${runningLabel || 'action'}…`}>
            <span className="busy-spinner" />
            <span className="busy-text">{pyStatus || `${runningLabel || 'Working'}…`}</span>
            <button
              className="busy-cancel"
              onClick={onCancelRun}
              title={`Cancel ${runningLabel || 'this action'}`}
            >
              Cancel
            </button>
          </span>
        )}

        <input
          ref={fileInput} type="file" hidden multiple
          accept={importAccept}
          onChange={(e) => onImport(e.target.files)}
        />
        {/* Import now lives as the big button atop the Artifacts panel, and
            the storage meter it used to sit next to moved under Plugins —
            left commented out rather than deleted per request. */}
        {/* <button className="primary" disabled={!booted || !!importing}
                onClick={() => fileInput.current?.click()}>
          Import
        </button> */}

        <button
          className="topbar-icon-btn"
          data-tour="plugins-btn"
          onClick={() => { setPluginsDialogInitialTab('installed'); setPluginsDialogOpen(true); }}
          title="Plugins"
          aria-label="Plugins"
        >
          <PackageIcon />
          <span>Plugins</span>
          {pluginUpdates.length > 0 && (
            <span className="topbar-badge">{pluginUpdates.length}</span>
          )}
        </button>

        <AgentControl
          open={openTopbarPanel === 'ai'}
          onOpenChange={(open) => setOpenTopbarPanel(open ? 'ai' : (p) => (p === 'ai' ? null : p))}
        />

        <div className="compute-topbar-control" onMouseDown={(event) => event.stopPropagation()}>
          <button
            className={`compute-topbar-button${computeMenuOpen ? ' is-open' : ''}`}
            onClick={() => setComputeMenuOpen((open) => !open)}
            title="Promenade Compute"
            aria-label="Promenade Compute"
            aria-expanded={computeMenuOpen}
          >
            <span className="compute-topbar-icon-wrap">
              <ComputeIcon />
              <span className="compute-topbar-status" />
            </span>
            <span>Compute</span>
          </button>
          {computeMenuOpen && (
            <ComputeStatusPopover
              report={bootReport}
              onClose={() => setComputeMenuOpen(false)}
              onManage={() => {
                setComputeMenuOpen(false);
                setComputeEnginesDialogOpen(true);
              }}
            />
          )}
        </div>

        <HelpMenu
          open={openTopbarPanel === 'help'}
          onOpenChange={(open) => setOpenTopbarPanel(open ? 'help' : (p) => (p === 'help' ? null : p))}
          onOpenWelcome={() => setWelcomeDialogOpen(true)}
          onOpenFeedback={() => setFeedbackDialogOpen(true)}
        />
      </div>

      {error && <div style={{ padding: '6px 14px' }} className="err">{error}</div>}

      <div className="body">
        <SidePanel side="left" title="Artifacts" defaultWidth={268}
                   minWidth={200} storageKey="promenade.left">
        <div className="artifacts">
          <ArtifactTree
            graph={graph}
            selected={selected}
            onSelect={(ids) => { setSelected(ids); if (ids.length > 0) setSelectedSavedViewIds([]); }}
            onOpen={openArtifact}
            onExportAction={onExportAction}
            onRemove={onRemove}
            onRemoveMany={onRemoveMany}
            onRenameArtifact={onRenameArtifact}
            onImport={() => fileInput.current?.click()}
            onFilesDropped={onImport}
            onSampleLogs={() => setSampleLogsOpen(true)}
            authoringViews={authoringViews.map((v) => ({ id: v.id, label: v.label }))}
            onOpenAuthoringView={openStandaloneView}
            standaloneActions={standaloneActions.map((a) => ({ id: a.id, label: a.label }))}
            onOpenStandaloneAction={setRunActionDialogId}
            savedViews={savedViews}
            selectedSavedViews={selectedSavedViewIds}
            onSelectSavedViews={onSelectSavedViews}
            onOpenSavedView={onOpenSavedView}
            onRenameSavedView={onRenameSavedView}
            onRemoveSavedView={onRemoveSavedView}
            onRemoveManySavedViews={onRemoveManySavedViews}
            onDuplicateSavedView={onDuplicateSavedView}
            unusedMaterializations={unusedMaterializations}
            onCleanupUnusedMaterializations={removeOrphanArtifactFiles}
            otherWorkspaces={workspaces.filter((w) => w.id !== activeWorkspaceId)}
            onMoveToWorkspace={onMoveArtifactToWorkspace}
            computeEngines={computeEngines}
            onRelocateArtifact={onRelocateArtifact}
            onOpenView={openView}
            onRunAction={onRun}
            onExplore={openGallery}
          />

          {quota && (
            <button
              type="button"
              className="storage-meter-footer"
              onClick={openStorageDetails}
              title={`${quota.persisted ? 'persistent' : 'best-effort (evictable)'} · show storage details`}
              aria-label="Show storage details"
            >
              <div className="storage-bar"><div style={{ width: `${usedPct}%` }} /></div>
              <span>{fmtBytes(quota.usage)} / {fmtBytes(quota.quota)}</span>
            </button>
          )}
        </div>
        </SidePanel>

        <div className="workspace">
          {tabs.length === 0
            ? <StartScreen booted={booted} onPickFile={() => fileInput.current?.click()} />
            : <Workspace
                tabs={tabs}
                graph={graph}
                onTabsChange={setTabs}
                onFocus={(id) => setSelected([id])}
                onActivePanel={setActivePanel}
                onSaveScript={onSaveScript}
                onPlanChange={onPlanChange}
                onOpenPanels={setOpenPanels}
                onTabParamChange={onTabParamChange}
                renderFullscreenInspector={renderFullscreenInspector}
                onOpenArtifact={openArtifact}
                onFocusArtifact={(id) => setSelected([id])}
                onGraphUpdated={setGraph}
                onPublishedArtifact={onPublishedArtifact}
                onDeriveLog={onDeriveLog}
                onSaveNotebook={onSaveNotebook}
                onOpenView={openViewFromPlugin}
                restoreActiveTabId={restoreActiveTabId}
                plugins={plugins}
                onOpenDestination={onOpenDestination}
                extraSelection={gallerySelection}
                experimentalPluginIds={experimentalPluginIds}
              />}
        </div>

        <SidePanel side="right" title="Inspector" defaultWidth={320}
                   minWidth={240} storageKey="promenade.right">
        <Inspector
          artifacts={selectedArtifacts}
          graph={graph}
          selectedSavedView={selectedSavedView}
          openPanels={openPanels}
          onOpenView={openView}
          onRun={onRun}
      computeEngines={computeEngines}
          liveParams={selected.length === 1 && graph.artifacts[selected[0]]?.producedBy ? liveParams : null}
          onParamChange={onParamChange}
          running={running}
          plugins={plugins}
          onPluginsChanged={async () => setPlugins(await listInstalled())}
          onClassifierChange={onClassifierChange}
          experimentalPluginIds={experimentalPluginIds}
          activePanel={activePanel ? {
            title: activePanel.title,
            view: activePanel.view,
            values: tabs.find((t) => t.id === activePanel.tabId)?.viewParams ?? {},
            artifactId: activePanel.artifactId,
          } : null}
          onCompare={onCompare}
          onRecompute={onRecompute}
          onExplore={openGallery}
          onViewParamChange={(key, value) => {
            // The tab owns its view parameters; the workspace pushes the change
            // into the panel, which forwards it to a sandboxed frame if there
            // is one. The inspector never talks to a panel directly.
            if (!activePanel) return;
            const next = { ...(tabs.find((t) => t.id === activePanel.tabId)?.viewParams ?? {}), [key]: value };
            setTabs((t) => t.map((tab) => tab.id === activePanel.tabId
              ? { ...tab, viewParams: next }
              : tab));
            persistViewParamsDebounced(activePanel.artifactId, activePanel.view, next);
          }}
          onSavedViewParamChange={(key, value) => {
            // Same shape as onViewParamChange, but keyed off the tree's saved
            // view selection instead of workspace focus — a view's own
            // options should be editable by selecting it in the tree, without
            // first having to bring its panel into focus.
            if (!selectedSavedView) return;
            const sv = selectedSavedView;
            const next = { ...sv.state, [key]: value };
            setSavedViews((vs) => vs.map((v) => (v.id === sv.id ? { ...v, state: next } : v)));
            setTabs((t) => t.map((tab) => (tab.artifactId === sv.sourceArtifactId && tab.view === sv.view)
              ? { ...tab, viewParams: next }
              : tab));
            persistViewParamsDebounced(sv.sourceArtifactId, sv.view, next);
          }}
        />
        </SidePanel>
      </div>

      {showResetDialog && (
        <ResetWorkspaceDialog
          onCancel={() => setShowResetDialog(false)}
          onConfirm={onConfirmReset}
        />
      )}

      {storageDetailsOpen && (
        <StorageDetailsDialog
          breakdown={storageDetails}
          loading={storageDetailsLoading}
          onClose={() => setStorageDetailsOpen(false)}
          onRefresh={() => void refreshStorageDetails()}
          onRecoverOrphans={recoverOrphanArtifacts}
          onRemoveOrphans={removeOrphanArtifactFiles}
          onClearCacheStorage={clearCacheStorage}
          onResetWorkspace={() => {
            setStorageDetailsOpen(false);
            setShowResetDialog(true);
          }}
        />
      )}

      {computeEnginesDialogOpen && (
        <ComputeEnginesDialog onClose={() => { setComputeEnginesDialogOpen(false); refreshComputeEngines(); }} />
      )}

      {welcomeDialogOpen && (
        <WelcomeDialog
          showOnStartup={welcomeShowOnStartup}
          onShowOnStartupChange={onWelcomeShowOnStartupChange}
          onClose={() => setWelcomeDialogOpen(false)}
          onTakeTour={() => { setWelcomeDialogOpen(false); setTourActive(true); }}
        />
      )}

      {tourActive && (
        <Tour
          onClose={() => setTourActive(false)}
          steps={[
            {
              target: () => document.querySelector<HTMLElement>('[data-tour="artifact-browser"]'),
              title: 'Your Artifact browser',
              body: 'Everything you import or produce — logs, models, views — lands here as one tree you can navigate and reorganize.',
              placement: 'right',
            },
            {
              target: () => document.querySelector<HTMLElement>('[data-tour="sample-logs-btn"]'),
              title: 'No data yet? Start with a sample',
              body: 'Pick one of the bundled example event logs to get something on screen right away, before importing your own.',
              placement: 'right',
            },
            {
              target: () => document.querySelector<HTMLElement>('[data-tour="plugins-btn"]'),
              title: 'The Plugin browser',
              body: 'Importers, algorithms, and visualizations all arrive as plugins. Open this any time to see what’s installed or add more.',
              placement: 'bottom',
            },
            {
              target: () => document.querySelector<HTMLElement>('[data-tour="install-all-btn"]'),
              title: 'Get the full toolkit',
              body: 'This grabs every plugin listed in the registry that you don’t already have installed — the fastest way to set up.',
              placement: 'bottom',
              onEnter: () => { setPluginsDialogInitialTab('browse'); setPluginsDialogOpen(true); },
              primaryLabel: 'Install all',
              onPrimary: (advance) => {
                const btn = document.querySelector<HTMLButtonElement>('[data-tour="install-all-btn"]');
                if (btn) btn.click();
                advance();
              },
            },
          ]}
        />
      )}

      {onlyBundledPlugins && !welcomeDialogOpen && !tourActive && !pluginsDialogOpen && (
        <PluginsNudge onOpen={() => { setPluginsDialogInitialTab('browse'); setPluginsDialogOpen(true); }} />
      )}

      {feedbackDialogOpen && (
        <FeedbackDialog plugins={plugins} onClose={() => setFeedbackDialogOpen(false)} />
      )}

      {sampleLogsOpen && (
        <SampleLogsDialog
          onClose={() => setSampleLogsOpen(false)}
          onImport={onImportSample}
          disabled={!booted || !!importing}
        />
      )}

      {runActionDialogId && (
        <RunActionDialog
          actionId={runActionDialogId}
          onClose={() => setRunActionDialogId(null)}
          onRun={(actionId, params) => onRun(actionId, undefined, undefined, { inputs: {}, params })}
        />
      )}

      {pluginsDialogOpen && (
        <PluginsDialog
          plugins={plugins}
          onClose={() => setPluginsDialogOpen(false)}
          onImport={() => fileInput.current?.click()}
          onFilesDropped={onImport}
          onRemove={onRemovePlugin}
          onInstalled={async () => setPlugins(await listInstalled())}
          initialTab={pluginsDialogInitialTab}
        />
      )}

      {exportWorkspaceOpen && (
        <ExportWorkspaceDialog
          workspaceName={workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? ''}
          artifactCount={Object.keys(graph.artifacts).length}
          localPlugins={exportLocalPlugins}
          onCancel={() => setExportWorkspaceOpen(false)}
          onExport={onExportWorkspace}
        />
      )}

      {importBundle && (
        <ImportWorkspaceDialog
          bundle={importBundle}
          installedPlugins={plugins}
          onCancel={() => setImportBundle(null)}
          onImport={onConfirmImportWorkspace}
        />
      )}

      {pendingMismatch && (
        <ConfirmDialog
          title="Different plugin version"
          message={`This ${pendingMismatch.kind === 'artifact' ? 'artifact' : 'view'} was created with `
            + `${pendingMismatch.pluginId} v${pendingMismatch.recorded}, but v${pendingMismatch.installed} `
            + `is currently installed. Results may look different from when this was made.`}
          confirmLabel="Open anyway"
          // Cancel does not record acceptance: the user declined to open it,
          // so they have not taken on the risk the warning describes.
          onCancel={() => setPendingMismatch(null)}
          onConfirm={() => {
            const m = pendingMismatch;
            acceptedMismatches.current.add(m.key);
            setPendingMismatch(null);
            if (m.kind === 'artifact') openArtifactImpl(m.artifact);
            else openSavedViewImpl(m.sv);
          }}
        />
      )}
    </div>
  );
}

function PackageIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M8 1.5 L14 4.5 V11.5 L8 14.5 L2 11.5 V4.5 Z M2 4.5 L8 7.5 L14 4.5 M8 7.5 V14.5"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  );
}

/** Seeds the color registry from an artifact's summary, in a stable order. */
function seedColors(a: Artifact) {
  const m: any = a.meta ?? {};
  if (Array.isArray(m.objectTypeList)) {
    colorRegistry.seed('objectType', m.objectTypeList.map((o: any) => o.objectType));
  }
  if (Array.isArray(m.topActivities)) {
    colorRegistry.seed('activity', m.topActivities.map((x: any) => x.activity));
  }
}
