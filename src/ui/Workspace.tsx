import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
// Dockview 8 split the framework-agnostic core (`dockview`) from the React
// bindings (`dockview-react`); the components live in the latter.
import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import type { Artifact, ProvenanceGraph } from '../host/artifact/types';
import { LogOverview } from './views/LogOverview';
import { ActivityTable } from './views/ActivityTable';
import { AttributeTable } from './views/AttributeTable';
import { TraceExplorer } from './views/TraceExplorer';
import { DfgView } from './views/DfgView';
import { CausalNetView } from './views/CausalNetView';
import { PetriNetView } from './views/PetriNetView';
import { AlignmentView } from './views/AlignmentView';
import { ReplayDiagnosticsView } from './views/ReplayDiagnosticsView';
import { OcdfgView } from './views/OcdfgView';
import { OcpnView } from './views/OcpnView';
import { ObjectInteractionsView } from './views/ObjectInteractionsView';
import { ScriptEditor } from './views/ScriptEditor';
import { NotebookView } from './views/NotebookView';
import { TransformEditor } from './views/TransformEditor';
import { ProvenanceView } from './views/ProvenanceView';
import { PluginDetails } from './views/PluginDetails';
import { GalleryView } from './views/GalleryView';
import { layoutForType, type LayoutNode } from '../host/services/layout';
import { panelFocus, panelFullscreen, type OpenPanel } from '../host/services/panels';
import { viewRegistry } from '../host/views/registry';
import { payloadOf } from '../host/actions/results';
import { liveRun } from '../host/actions/liveRun';
import { PluginPanel } from './PluginPanel';
import { PanelTab } from './PanelTab';
import { Breadcrumbs } from './Breadcrumbs';

export interface ActivePanel {
  panelId: string;
  tabId: string;
  view: string;
  artifactId: string;
  title: string;
}

export interface OpenTab {
  id: string;
  artifactId: string;
  view: string;
  title: string;
  /** View-level parameters, pushed into the panel (and into a plugin frame). */
  viewParams?: Record<string, unknown>;
  /**
   * Apply the artifact type's default arrangement instead of opening just
   * `view`. Set when the user opens an artifact generically; a request for one
   * specific view must not be answered with a whole layout.
   */
  useDefaultLayout?: boolean;
  /** Set when this tab is an opened saved view — the tab shows its own title. */
  savedViewId?: string;
  /**
   * A transient tab, shown in italics: workspace chrome the user is passing
   * through rather than a panel they chose to keep. The destination gallery
   * is the only one today — it re-points at whatever is selected instead of
   * opening a second copy, and closes once a destination is picked.
   *
   * Deliberately presentation-only. Nothing about persistence, focus or
   * layout branches on it; a preview tab is restored with the session like
   * any other, because a gallery left open is exactly where its user was.
   */
  preview?: boolean;
  /**
   * A run-bound live-preview panel (`ViewDef.livePreview`). `artifactId` is a
   * synthetic `live:<runId>` that is not in the catalog; the panel renders
   * against `liveRun` and is replaced by a real artifact tab when the run
   * finishes.
   */
  live?: boolean;
  /**
   * Another tab's id — this tab's panels open as a fresh column to its
   * right (`direction: 'right'`) instead of wherever `useDefaultLayout` or
   * the reopen-anchor logic would otherwise place them. The one thing
   * "Compare side by side" needs that opening two artifacts normally
   * doesn't already give: a deliberate side-by-side split, not two panels
   * landing in whatever group happens to be active.
   */
  splitFrom?: string;
  /**
   * Which side of `splitFrom` this tab opens on. Defaults to `'right'`, which
   * is what "Compare side by side" has always meant. `'left'` exists because
   * a panel that opens another one *for* the user — a questionnaire putting a
   * visualisation up next to itself — is usually the thing that should stay
   * on the right, where it started.
   */
  splitDirection?: 'left' | 'right';
}

/**
 * Dockable workspace.
 *
 * Panel geometry belongs to the host, always. Views receive an artifact id and
 * a params object; they never position themselves, never open panels, and
 * never draw outside their own rect. That constraint is what keeps the
 * eventual iframe-isolated plugin views a drop-in rather than a rewrite.
 *
 * Dockview is used because its layout serialises to and from JSON, which is
 * the same shape the LayoutDef model needs — the host can hand it a named
 * arrangement without translating between two notions of "layout".
 */

// Native views register into the same registry the plugin manifests use, so
// the workspace resolves both through one lookup.
// OCEL's own Overview comes from the bundled OCEL 2.0 Inspector plugin (a
// `primary` view — see `ViewDef.primary`), so this native one is scoped down
// to the log type it's still the only Overview for. `primary: true` here
// mirrors that: opening a TraditionalEventLog opens straight into this
// dashboard, the same way opening an OCEL log opens straight into that
// plugin's, rather than a blank "Start" panel.
viewRegistry.register({
  id: 'core.logOverview', label: 'Overview', provider: 'core', trusted: true,
  appliesTo: ['TraditionalEventLog'], component: LogOverview, primary: true,
});
viewRegistry.register({
  id: 'core.activityTable', label: 'Activities', provider: 'core', trusted: true,
  appliesTo: ['ObjectCentricEventLog', 'TraditionalEventLog'], component: ActivityTable,
});
viewRegistry.register({
  id: 'core.attributeTable', label: 'Attributes', provider: 'core', trusted: true,
  appliesTo: ['ObjectCentricEventLog', 'TraditionalEventLog'], component: AttributeTable,
});
viewRegistry.register({
  // Case-centric only: "case" is a TraditionalEventLog concept. An OCEL log
  // gets one the same way every other case-centric view does, by flattening
  // first — this view isn't the place to reinvent that.
  id: 'core.traceExplorer', label: 'Cases & variants', provider: 'core', trusted: true,
  appliesTo: ['TraditionalEventLog'], component: TraceExplorer,
  // Coverage decides how many already-fetched, already-ranked rows are
  // shown — pure client-side filtering of one query's result, the same
  // reason the DFG/Causal Net percentile filters own their own control
  // instead of routing through the inspector.
  ownsControls: true,
  params: {
    type: 'object',
    properties: {
      coverage: {
        type: 'integer', title: 'Coverage', default: 95, minimum: 1, maximum: 100,
      },
    },
    required: ['coverage'],
  },
});
viewRegistry.register({
  id: 'core.dfgView', label: 'Directly-follows graph', provider: 'core', trusted: true,
  appliesTo: ['DFG'], component: DfgView,
  // Percentile thresholds over the already-fetched graph — pure client-side
  // filtering, nothing to recompute — so the view draws its own vertical
  // sliders next to the diagram rather than routing through the inspector.
  ownsControls: true,
  params: {
    type: 'object',
    properties: {
      activityPct: {
        type: 'integer', title: 'Activities', default: 100, minimum: 1, maximum: 100,
      },
      connectionPct: {
        type: 'integer', title: 'Connections', default: 100, minimum: 1, maximum: 100,
      },
    },
    required: ['activityPct', 'connectionPct'],
  },
});
viewRegistry.register({
  id: 'core.causalNetView', label: 'Causal net', provider: 'core', trusted: true,
  appliesTo: ['CausalNet'], component: CausalNetView,
  ownsControls: true,
  params: {
    type: 'object',
    properties: {
      activityPct: {
        type: 'integer', title: 'Activities', default: 100, minimum: 1, maximum: 100,
      },
      connectionPct: {
        type: 'integer', title: 'Connections', default: 100, minimum: 1, maximum: 100,
      },
    },
    required: ['activityPct', 'connectionPct'],
  },
});
viewRegistry.register({
  id: 'core.ocdfgView', label: 'Object-centric DFG', provider: 'core', trusted: true,
  // Temporarily hidden while the React Flow renderer is the maintained
  // OC-DFG presentation. Leave the implementation registered so old tabs
  // and saved views fail gracefully rather than becoming unknown views.
  disabled: true,
  appliesTo: ['OCDFG'], component: OcdfgView,
  ownsControls: true,
  params: {
    type: 'object',
    properties: {
      activityPct: {
        type: 'integer', title: 'Activities', default: 100, minimum: 1, maximum: 100,
      },
      connectionPct: {
        type: 'integer', title: 'Connections', default: 100, minimum: 1, maximum: 100,
      },
      objectTypes: {
        type: 'array', title: 'Object types', default: [], items: { type: 'string' },
      },
    },
    required: ['activityPct', 'connectionPct'],
  },
});
viewRegistry.register({
  id: 'core.petriNetView', label: 'Petri Net (old)', provider: 'core', trusted: true,
  // Preserved solely so existing panels and saved view references fail
  // gracefully. The maintained React Flow plugin is now the default.
  disabled: true,
  appliesTo: ['AcceptingPetriNet'], component: PetriNetView,
});
viewRegistry.register({
  id: 'core.ocpnView', label: 'Object-centric Petri net', provider: 'core', trusted: true,
  // Temporarily hidden while the React Flow renderer is the maintained OCPN
  // presentation; keep it registered so legacy tabs degrade gracefully.
  disabled: true,
  appliesTo: ['ObjectCentricPetriNet'], component: OcpnView,
  // Object-type visibility and layout settings are view state, glued to the
  // diagram they affect — the same reason `core.ocdfgView` owns its own
  // controls instead of routing through the generic inspector form.
  ownsControls: true,
  params: {
    type: 'object',
    properties: {
      hiddenObjectTypes: {
        type: 'array', title: 'Hidden object types', default: [], items: { type: 'string' },
      },
      showSilent: {
        type: 'boolean', title: 'Show silent transitions', default: true,
      },
      direction: {
        type: 'string', title: 'Layout direction', enum: ['RIGHT', 'DOWN'], default: 'RIGHT',
      },
      edgeRouting: {
        type: 'string', title: 'Edge routing', enum: ['SPLINES', 'ORTHOGONAL', 'POLYLINE'], default: 'SPLINES',
      },
    },
    required: [],
  },
});
viewRegistry.register({
  id: 'core.objectInteractionsView', label: 'Object interactions', provider: 'core', trusted: true,
  appliesTo: ['ObjectInteractionGraph'], component: ObjectInteractionsView,
});
viewRegistry.register({
  id: 'core.alignmentView', label: 'Alignment explorer', provider: 'core', trusted: true,
  appliesTo: ['AlignmentSet'], component: AlignmentView,
});
viewRegistry.register({
  id: 'core.replayDiagnosticsView', label: 'Replay diagnostics', provider: 'core', trusted: true,
  appliesTo: ['ReplayDiagnostics'], component: ReplayDiagnosticsView,
});
viewRegistry.register({
  // No appliesTo: provenance is meaningful for every artifact type.
  id: 'core.provenance', label: 'Provenance', provider: 'core', trusted: true,
  component: ProvenanceView,
});
viewRegistry.register({
  id: 'core.pluginDetails', label: 'Plugin', provider: 'core', trusted: true,
  standalone: true, component: PluginDetails,
});
// The destination gallery. `chrome: true` keeps it out of every "which view
// should this artifact open in" answer (see `ViewDef.chrome`) while leaving
// it a perfectly ordinary artifact-bound panel to open by id.
viewRegistry.register({
  id: 'core.gallery', label: 'Explore', provider: 'core', trusted: true,
  chrome: true, component: GalleryView,
});
viewRegistry.register({
  id: 'core.transformEditor', label: 'Transformations', provider: 'core', trusted: true,
  appliesTo: ['ObjectCentricEventLog', 'TraditionalEventLog'],
  // Only a derived log has a plan to edit; the source log has nothing to show.
  appliesWhen: (a) => a.storage.kind === 'view',
  component: TransformEditor,
});
viewRegistry.register({
  id: 'core.scriptEditor', label: 'Python script', provider: 'core', trusted: true,
  appliesTo: ['ObjectCentricEventLog', 'TraditionalEventLog', 'Script'],
  component: ScriptEditor,
});
viewRegistry.register({
  // No appliesTo, deliberately: a notebook is a workspace tool over
  // *any* artifact, the same reason core.provenance has none — an
  // AcceptingPetriNet or a ProcessTree gets `promenade.current_artifact()`
  // even though only TraditionalEventLog/ObjectCentricEventLog also get the
  // `log` alias (see docs/python-notebook.md). Also handles `Notebook`
  // itself, the same way `core.scriptEditor` below doubles as the reopen
  // view for a saved `Script` artifact.
  id: 'core.notebook', label: 'Python notebook', provider: 'core', trusted: true,
  // Manages its own cells/outputs/kernel entirely in its own state; there is
  // nothing here for the generic inspector `ParamControls` to draw.
  ownsControls: true,
  component: NotebookView,
});

/**
 * Backs a sandboxed view's `promenade.openView()`. Resolves the target
 * artifact and view against the live catalog — a sandboxed frame only
 * ever hands over ids, never object references — then defers to the same
 * `onOpenView`/`onOpenArtifact` the tree and Inspector already use, so
 * "already open? focus it instead" stays defined in exactly one place.
 * Shared by the docked panel (`PanelHost`) and its fullscreen twin
 * (`FullscreenPluginView`) — both host the same kind of frame and owe it
 * the same answer.
 */
function resolveOpenView(
  graph: ProvenanceGraph,
  openArtifactFn: ((a: Artifact) => void) | undefined,
  openViewFn: ((
    a: Artifact, v: string, p?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string },
  ) => void) | undefined,
  targetId: string, viewId?: string, targetParams?: Record<string, unknown>,
  placement?: { beside: 'left' | 'right'; fromPanelId: string }
): { ok: boolean; error?: string } {
  const target = graph.artifacts[targetId];
  if (!target) return { ok: false, error: `No artifact with id "${targetId}".` };
  if (!viewId) {
    if (!openArtifactFn) return { ok: false, error: 'Opening views is not available here.' };
    openArtifactFn(target);
    return { ok: true };
  }
  const targetDef = viewRegistry.get(viewId);
  if (!targetDef || targetDef.disabled) return { ok: false, error: `No such view "${viewId}".` };
  if (!openViewFn) return { ok: false, error: 'Opening views is not available here.' };
  openViewFn(target, viewId, targetParams, placement);
  return { ok: true };
}

function PanelHost(props: IDockviewPanelProps<{
  artifactId: string; view: string; graph: ProvenanceGraph; viewParams?: Record<string, unknown>;
}>) {
  const { artifactId, view, graph, viewParams } = props.params;
  const def = viewRegistry.get(view);
  if (!def) {
    return <div className="view"><div className="err">No view registered for “{view}”.</div></div>;
  }
  if (def.disabled) {
    return <div className="view"><div className="why">This view is temporarily disabled.</div></div>;
  }

  const handleOpenView = (
    targetId: string, viewId?: string, targetParams?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string },
  ) =>
    resolveOpenView(
      graph,
      (props.params as any).onOpenArtifact,
      (props.params as any).onOpenView,
      targetId, viewId, targetParams, placement
    );
  // Standalone panels are not bound to an artifact and must not be dropped
  // when none is selected. With no artifact there is no derivation chain, so
  // they get no breadcrumb bar either.
  if (def.standalone && def.component) {
    const S = def.component;
    return <S {...(viewParams ?? {})} panelId={props.api.id} />;
  }

  // A sandboxed standalone view — an authoring surface. Same frame, same
  // bridge; it just has no catalog artifact behind it, so it gets the same
  // kind of synthetic stub the live-preview panel below does. Its tables are
  // empty, which is the honest description: there is nothing to query yet,
  // and what it produces it produces through `promenade.publishLog()`.
  if (def.standalone && def.entry) {
    const blank: Artifact = {
      id: artifactId, name: def.label, type: '', createdAt: new Date().toISOString(),
      storage: { kind: 'inline', value: null }, meta: {}, producedBy: null, inputs: [],
    };
    return (
      <div className="view" style={{ height: '100%' }}>
        <PluginPanel
          artifact={blank}
          panelId={props.api.id}
          cacheKey={`${artifactId}:${view}`}
          entry={def.entry}
          viewId={def.id}
          params={viewParams}
          provider={def.provider}
          publishes={def.publishes}
          readsWorkspace={def.readsWorkspace}
          onParamChange={(props.params as any).onParamChange}
          onGraphUpdated={(props.params as any).onGraphUpdated}
          onPublishedArtifact={(props.params as any).onPublishedArtifact}
          onOpenView={handleOpenView}
        />
      </div>
    );
  }

  // A run-bound live-preview panel: no catalog artifact yet. Render the
  // sandboxed view against `liveRun` with a synthetic, value-less artifact.
  if (artifactId.startsWith('live:') && def.entry) {
    const snap = liveRun.current();
    if (!snap || `live:${snap.runId}` !== artifactId) {
      return <div className="view"><div className="why">The replay finished — its result opened in a new tab.</div></div>;
    }
    const synthetic: Artifact = {
      id: artifactId, name: 'Replaying…', type: snap.outputType,
      createdAt: new Date().toISOString(), storage: { kind: 'inline', value: snap.seed },
      meta: {}, producedBy: null, inputs: [],
    };
    return (
      <div className="view" style={{ height: '100%' }}>
        <PluginPanel
          artifact={synthetic}
          panelId={props.api.id}
          cacheKey={`${artifactId}:${view}`}
          entry={def.entry}
          viewId={def.id}
          params={viewParams}
          inlineValue={snap.seed}
          provider={def.provider}
          live
        />
      </div>
    );
  }

  const artifact = graph.artifacts[artifactId];
  if (!artifact) return <div className="view">Artifact no longer exists.</div>;

  const body = (() => {
    // A manifest may delegate to a host view rather than ship a renderer.
    if (def.nativeView) {
      const target = viewRegistry.get(def.nativeView);
      if (target?.disabled) {
        return <div className="view"><div className="why">This view is temporarily disabled.</div></div>;
      }
      if (target?.component) {
        const T = target.component;
        return <T artifact={artifact} graph={graph} panelId={props.api.id} />;
      }
      return <div className="view"><div className="err">
        This artifact's view (“{def.nativeView}”) is not available in this build.
      </div></div>;
    }

    // Sandboxed plugin view: same panel chrome, isolated body.
    if (def.entry) {
      return (
        <PluginPanel
          artifact={artifact}
          panelId={props.api.id}
          // Stable across a close-then-reopen, unlike `props.api.id` (a
          // fresh id every time dockview creates a panel) — this is what
          // lets `promenade.cachedState()` actually find anything on a
          // reopen instead of missing every single time.
          cacheKey={`${artifactId}:${view}`}
          entry={def.entry}
          viewId={def.id}
          params={viewParams}
          // Results of the current session live in the result store; a
          // reloaded one has been rehydrated into it from the catalog.
          inlineValue={payloadOf(artifact.id)}
          // A sandboxed view is exactly as entitled to push its own param
          // changes as a native `ownsControls` view (line 331 below) — same
          // callback, same tab-addressed update.
          onParamChange={(props.params as any).onParamChange}
          onGraphUpdated={(props.params as any).onGraphUpdated}
          // A view's `publishes` declaration holds wherever the view is
          // opened. An editing surface for an existing artifact is exactly as
          // entitled to publish as the standalone authoring panel below is —
          // and it is the case where provenance actually has a source to
          // record.
          publishes={def.publishes}
          // Same reasoning as `publishes`: the manifest's declaration is what
          // entitles the frame, so it holds wherever the view is opened.
          readsFiles={def.readsFiles}
          readsWorkspace={def.readsWorkspace}
          derivesLogs={def.derivesLogs}
          onPublishedArtifact={(props.params as any).onPublishedArtifact}
          onDeriveLog={(props.params as any).onDeriveLog}
          onOpenView={handleOpenView}
          provider={def.provider}
          sourceArtifact={artifact.inputs.length === 1 ? graph.artifacts[artifact.inputs[0]] : undefined}
          comparisonCohorts={def.provider === 'run.promenade.interaction-atlas'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricInteractionCohort'
              && candidate.inputs.includes(artifact.type === 'ObjectCentricEventLog' ? artifact.id : artifact.inputs[0] ?? ''))
            : undefined}
          interactionSelections={def.interactionSelection === 'interaction-cohort-v1'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricInteractionCohort'
              && candidate.inputs.includes(artifact.type === 'ObjectCentricEventLog' ? artifact.id : artifact.inputs[0] ?? '')
              && !!(candidate.meta as any)?.selection?.binMask)
            : undefined}
          replayEvidence={def.provider === 'run.promenade.interaction-atlas'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricReplayEvidence'
              && candidate.inputs.includes(artifact.type === 'ObjectCentricEventLog' ? artifact.id : artifact.inputs[0] ?? ''))
            : undefined}
        />
      );
    }
    const View = def.component!;
    return (
      <View
        artifact={artifact}
        graph={graph}
        panelId={props.api.id}
        params={viewParams}
        // `onSave` is one prop shared by every native view, but "save what,
        // as which artifact type" differs per view — ScriptEditor and
        // NotebookView each expect a differently-shaped callback, so the
        // underlying function is picked by view id rather than assumed.
        onSave={def.id === 'core.notebook' ? (props.params as any).onSaveNotebook : (props.params as any).onSaveScript}
        onPlanChange={(props.params as any).onPlanChange}
        // Only meaningful to a view declaring `ownsControls` — every other
        // view already gets its params pushed one-way and has no use for it.
        onParamChange={(props.params as any).onParamChange}
        onOpenArtifact={(props.params as any).onOpenArtifact}
        onFocusArtifact={(props.params as any).onFocusArtifact}
        onGraphUpdated={(props.params as any).onGraphUpdated}
        // Only the gallery reads these two: what the workspace has installed
        // (for the plugin name on a card) and the one callback that turns a
        // card into either an opened view or a started run. Passed here
        // rather than through a second panel component, so a chrome panel
        // keeps the ordinary breadcrumb and artifact binding.
        plugins={(props.params as any).plugins}
        onOpenDestination={(props.params as any).onOpenDestination}
        extraSelection={(props.params as any).extraSelection}
        experimentalPluginIds={(props.params as any).experimentalPluginIds}
      />
    );
  })();

  return (
    <div className="panel-shell">
      <Breadcrumbs artifact={artifact} graph={graph} viewLabel={def.label} />
      <div className="panel-body">{body}</div>
    </div>
  );
}

/**
 * A full-window presentation of a sandboxed plugin view. The normal docked
 * panel stays mounted underneath, which preserves its place in the layout;
 * the fullscreen frame is deliberately an independent frame with the same
 * artifact and parameters.
 */
function FullscreenPluginView({
  artifact, panelId, cacheKey, entry, params, onParamChange, onGraphUpdated, provider, sourceArtifact, comparisonCohorts, interactionSelections, replayEvidence, publishes, readsFiles, readsWorkspace, fullscreenViewId, onOpenView, inspector, onExit,
}: {
  artifact: import('../host/artifact/types').Artifact;
  panelId: string;
  cacheKey?: string;
  entry: string;
  params?: Record<string, unknown>;
  onParamChange?: (key: string, value: unknown) => void;
  onGraphUpdated?: (catalog: ProvenanceGraph) => void;
  provider?: string;
  sourceArtifact?: import('../host/artifact/types').Artifact;
  comparisonCohorts?: import('../host/artifact/types').Artifact[];
  interactionSelections?: import('../host/artifact/types').Artifact[];
  replayEvidence?: import('../host/artifact/types').Artifact[];
  // The manifest's capability declarations hold in the fullscreen twin
  // exactly as they do in the docked panel — it is the same view, and the
  // frame would otherwise silently lose them the moment it is expanded.
  publishes?: string[];
  readsFiles?: boolean;
  readsWorkspace?: boolean;
  fullscreenViewId?: string;
  onOpenView?: (
    artifactId: string, viewId?: string, viewParams?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string },
  ) => { ok: boolean; error?: string };
  inspector?: ReactNode;
  onExit: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const [showInspector, setShowInspector] = useState(false);

  // This runs as the context-menu command is committed, preserving its user
  // activation for browsers that require it for the Fullscreen API. When the
  // API is unavailable or blocked, the fixed overlay remains a full-window
  // fallback within the application.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    void element.requestFullscreen?.().catch(() => {});

    const onFullscreenChange = () => {
      if (document.fullscreenElement !== element) exitRef.current();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement === element) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') exitRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Full screen plugin view"
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, background: 'var(--bg)',
        display: 'flex', minWidth: 0, minHeight: 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <PluginPanel
          artifact={artifact}
          panelId={`${panelId}:fullscreen`}
          cacheKey={cacheKey}
          entry={entry}
          viewId={fullscreenViewId}
          params={params}
          inlineValue={payloadOf(artifact.id)}
          onParamChange={onParamChange}
          onGraphUpdated={onGraphUpdated}
          provider={provider}
          sourceArtifact={sourceArtifact}
          comparisonCohorts={comparisonCohorts}
          interactionSelections={interactionSelections}
          replayEvidence={replayEvidence}
          publishes={publishes}
          readsFiles={readsFiles}
          readsWorkspace={readsWorkspace}
          onOpenView={onOpenView}
        />
      </div>
      {inspector && (
        <aside
          aria-label="Inspector"
          style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 2,
            width: 360, maxWidth: 'min(90vw, 360px)', background: 'var(--bg)',
            borderLeft: '1px solid var(--border)', boxShadow: '0 0 16px rgb(0 0 0 / 18%)',
            display: 'flex', flexDirection: 'column',
            transform: showInspector ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 160ms ease-out',
            pointerEvents: showInspector ? 'auto' : 'none',
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid var(--border)',
          }}>
            <strong>Inspector</strong>
            <button type="button" onClick={() => setShowInspector(false)}>Hide</button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{inspector}</div>
        </aside>
      )}
      {inspector && (
        <button
          type="button"
          onClick={() => setShowInspector((shown) => !shown)}
          aria-label={showInspector ? 'Hide inspector' : 'Show inspector'}
          title={showInspector ? 'Hide inspector' : 'Show inspector'}
          style={{
            position: 'absolute', top: 54, right: showInspector ? 372 : 12, zIndex: 3,
            border: '1px solid var(--border)', borderRadius: 5,
            background: 'var(--bg)', color: 'var(--text)', padding: '6px 10px',
            boxShadow: '0 1px 4px rgb(0 0 0 / 20%)', cursor: 'pointer',
          }}
        >
          {showInspector ? 'Hide Inspector' : 'Show Inspector'}
        </button>
      )}
      <button
        type="button"
        onClick={onExit}
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
        style={{
          position: 'absolute', top: 12, right: showInspector ? 372 : 12, zIndex: 3,
          border: '1px solid var(--border)', borderRadius: 5,
          background: 'var(--bg)', color: 'var(--text)', padding: '6px 10px',
          boxShadow: '0 1px 4px rgb(0 0 0 / 20%)', cursor: 'pointer',
        }}
      >
        Exit Full Screen
      </button>
    </div>
  );
}

/** The layout leaf a view belongs to, or undefined if the tree does not name it. */
function leafContaining(
  node: LayoutNode | undefined,
  view: string
): Extract<LayoutNode, { panels: unknown }> | undefined {
  if (!node) return undefined;
  if ('panels' in node) return node.panels.some((p) => p.view === view) ? node : undefined;
  for (const c of node.children) {
    const hit = leafContaining(c, view);
    if (hit) return hit;
  }
  return undefined;
}

export function Workspace({
  tabs, graph, onTabsChange, onFocus, onActivePanel, onSaveScript, onPlanChange, onOpenPanels,
  onTabParamChange, renderFullscreenInspector, onOpenArtifact, onFocusArtifact, onGraphUpdated, onPublishedArtifact, onDeriveLog, onSaveNotebook, onOpenView,
  restoreActiveTabId, plugins, onOpenDestination, extraSelection, experimentalPluginIds,
}: {
  tabs: OpenTab[];
  graph: ProvenanceGraph;
  onTabsChange: (t: OpenTab[]) => void;
  onFocus: (artifactId: string) => void;
  /**
   * Which panel the user is looking at.
   *
   * Reported separately from the artifact because two panels can show the same
   * artifact through different views — and then "which inspector" is a question
   * about the panel, not about the artifact.
   */
  onActivePanel: (p: ActivePanel | null) => void;
  onSaveScript?: (code: string, input: any, nameOverride?: string) => Promise<any> | void;
  onPlanChange?: (artifact: any, ops: any[]) => Promise<void> | void;
  /** Opens an artifact's view — the same function the Inspector uses. Notebook's "Open" button after a publish reuses it, rather than inventing a second way to open an artifact. */
  onOpenArtifact?: (a: any) => void;
  /** Selects an artifact in the tree, without necessarily opening a panel for it. */
  onFocusArtifact?: (id: string) => void;
  /** Pushes a freshly-committed catalog (e.g. after `promenade.publish()`) into app state. */
  onGraphUpdated?: (catalog: ProvenanceGraph) => void;
  /** An artifact a standalone authoring view just published: select it and open it. */
  onPublishedArtifact?: (a: Artifact) => void;
  /** Backs `promenade.deriveLog()` for sandboxed views that declare `derivesLogs`. */
  onDeriveLog?: (
    boundArtifactId: string, ops: unknown[]
  ) => Promise<{ id: string; name: string; applied: number }>;
  /** Persists a notebook as a `Notebook` artifact — the notebook analog of `onSaveScript`. */
  onSaveNotebook?: (doc: any, artifact: any, nameOverride?: string) => Promise<any> | void;
  /**
   * Opens a specific view for a specific artifact — the same function the
   * Inspector's "Open this view" uses. Backs `promenade.openView()`, so a
   * sandboxed view can jump to another view of the same (or a different)
   * artifact instead of only ever being a dead end for cross-view
   * navigation.
   */
  onOpenView?: (
    a: Artifact, viewId: string, initialParams?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string },
  ) => void;
  /** Installed plugins, so a gallery card can name the package behind it. */
  plugins?: Array<{ manifest: any }>;
  /** Plugin ids a registry flags `experimental`, for the card's own badge. */
  experimentalPluginIds?: Set<string>;
  /**
   * Opens one gallery destination. The gallery deliberately does not know
   * whether a card is a view or an action — that is the whole point of the
   * `Destination` vocabulary — so the decision, and the preview-tab policy
   * around it, stays in `App`.
   */
  onOpenDestination?: (d: any, artifact: Artifact, params?: Record<string, unknown>) => void;
  /**
   * Artifact ids selected alongside the gallery's own, so a two-input action
   * ("Compare OCPNs") reports itself as available rather than blocked.
   */
  extraSelection?: string[];
  /**
   * Every panel currently on screen. The rest of the shell cannot derive this
   * from `tabs`: one tab can open a whole default arrangement, and closing one
   * of its panels leaves the tab standing.
   */
  onOpenPanels?: (p: OpenPanel[]) => void;
  /**
   * Lets a view that owns its controls (`ViewDef.ownsControls`) push its own
   * parameter changes, the same way the inspector does for every other view —
   * just addressed by the panel's tab instead of by whichever panel has
   * workspace focus.
   */
  onTabParamChange?: (tabId: string, key: string, value: unknown) => void;
  /** App-owned inspector content for the fullscreen overlay. */
  renderFullscreenInspector?: () => ReactNode;
  /**
   * The tab that was focused when this workspace was last saved. Consumed
   * once — the moment that tab's first panel exists, it is made active and
   * never revisited — so it only affects the initial restore, never a later
   * unrelated re-render that happens to still carry the same value.
   */
  restoreActiveTabId?: string;
}) {
  const apiRef = useRef<DockviewReadyEvent['api'] | null>(null);
  const [fullscreenPanelId, setFullscreenPanelId] = useState<string | null>(null);

  const graphRef = useRef(graph);
  graphRef.current = graph;
  /**
   * The panel-removal subscription is made once, at `onReady`, so a handler
   * closing over `tabs` would see the first render's snapshot forever. Read
   * through a ref instead.
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // The workspace only mounts once a tab exists, so `onReady` fires *after*
  // the first panel-sync effect would have run. Tracking readiness as state
  // re-runs that effect once the API is actually available.
  const [ready, setReady] = useState(false);

  const reportPanels = useRef<() => void>(() => {});
  reportPanels.current = () => {
    const api = apiRef.current;
    if (!api || !onOpenPanels) return;
    onOpenPanels(api.panels.map((p) => ({
      panelId: p.id,
      artifactId: (p.params as any)?.artifactId ?? '',
      view: (p.params as any)?.view ?? '',
      savedViewId: (p.params as any)?.savedViewId,
    })));
  };

  /**
   * Re-derives "which panel is active" straight from the docking api,
   * rather than trusting whatever payload a particular event carries —
   * every caller below just wants the ground truth re-read, not that one
   * event's own value. `activePanel` genuinely is up to date the moment any
   * of these fire (verified directly against dockview-core); what is not
   * reliable is *which* event actually notifies of a plain tab-strip click
   * within an already-active group — see `onReady`.
   */
  const reportActivePanel = useRef<() => void>(() => {});
  reportActivePanel.current = () => {
    const act = apiRef.current?.activePanel;
    const a = (act?.params as any)?.artifactId;
    // A chrome panel is *about* the selection and must not also set it. The
    // gallery re-points at whatever is selected, so focusing it would report
    // the artifact it is currently bound to and snap the selection back to
    // it — a loop that made selecting a second artifact impossible while the
    // gallery was in front. Every other panel is bound to one artifact for
    // its whole life, so this only ever excludes chrome.
    const chrome = viewRegistry.get((act?.params as any)?.view)?.chrome;
    if (a && !chrome) onFocus(a);
    // `act.id`, not `act.api.id` — same reasoning as the panel handed to
    // `onDidActivePanelChange` itself: no api reference riding along.
    onActivePanel(act?.id ? {
      panelId: act.id,
      tabId: act.id.split('#')[0],
      view: (act.params as any)?.view ?? '',
      artifactId: a ?? '',
      title: act.title ?? '',
    } : null);
  };

  // Asking for a panel is a request to the host, not something the requester
  // may do itself — the docking API stays inside this component.
  useEffect(() => panelFocus.subscribe((id) => {
    apiRef.current?.getPanel(id)?.api.setActive();
  }), []);

  useEffect(() => panelFullscreen.subscribe((id) => {
    // A view can only ask while its source panel exists, but resolving the id
    // here also makes a stale menu click harmless.
    if (apiRef.current?.getPanel(id)) setFullscreenPanelId(id);
  }), []);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    event.api.onDidAddPanel(() => reportPanels.current());
    /**
     * Two sources for the same fact. dockview's own top-level
     * `onDidActivePanelChange` misses a plain tab-strip click that stays
     * within the already-active group — checked directly against
     * dockview-core: the *group's* own `onDidActivePanelChange` fires
     * correctly for exactly that case (with `origin: 'user'`), but the
     * component-level event's forwarding gate silently drops it, since
     * nothing about the *active group* changed. Without the group-level
     * subscription too, neither the Inspector nor the remembered "last
     * active tab" ever noticed an ordinary click between two tabs already
     * open in the same group — which reads as "it doesn't remember which
     * tab I had open" on the next reload, since nothing was ever asked to
     * persist a change that, from here, looked like it never happened.
     * Every current group gets one now; `onDidAddGroup` covers a later
     * manual split creating a new one.
     */
    event.api.onDidActivePanelChange(() => reportActivePanel.current());
    const attachGroupActiveListener = (g: { api: { onDidActivePanelChange: (fn: () => void) => void } }) =>
      g.api.onDidActivePanelChange(() => reportActivePanel.current());
    for (const g of event.api.groups) attachGroupActiveListener(g);
    event.api.onDidAddGroup((g) => attachGroupActiveListener(g));
    /**
     * Closing a panel has to reach React's tab state, or the state keeps tabs
     * the user already closed and the next panel-sync re-adds every one of
     * them. Dockview 8's React bindings expose no `onDidRemovePanel` prop —
     * passing one is silently ignored — so the event is taken from the api.
     */
    event.api.onDidRemovePanel((p) => {
      setFullscreenPanelId((current) => current === p.id ? null : current);
      const tabId = p.id.split('#')[0];
      // Only close the logical tab when its last panel is gone. The panel being
      // removed can still be listed here, so it is excluded explicitly.
      const remaining = event.api.panels
        .filter((x) => x.id !== p.id && x.id.startsWith(tabId + '#'));
      if (remaining.length === 0) {
        // Closing several panels in one synchronous burst (a tab's context
        // menu "Close Others"/"Close All") fires this handler once per panel
        // before React re-renders Workspace even once. `tabsRef.current` is
        // otherwise only refreshed on render, so a second removal in the same
        // burst would filter the *pre-burst* list and hand React a value that
        // still contains the tab the first removal just took out — React
        // batches same-tick `setState` calls to the latest value, so that
        // stale array would win and silently resurrect it. Writing the ref
        // synchronously keeps every removal in the burst building on the last.
        const next = tabsRef.current.filter((t) => t.id !== tabId);
        tabsRef.current = next;
        onTabsChange(next);
      }
      reportPanels.current();
    });

    setReady(true);
    // Dev affordance: the docking API is otherwise only reachable through
    // drag interaction, which makes layout behavior awkward to verify.
    if (import.meta.env.DEV) (globalThis as any).__dockview = event.api;
  };

  // Opening an artifact applies the default arrangement for its type. No mode
  // switch and nothing to explain: the user simply lands on a useful set of
  // panels, and any subsequent drag overrides it.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    for (const tab of tabs) {
      // Reconciled against the api's own panel list rather than a side set:
      // Dockview can be re-instantiated (StrictMode does exactly this), and a
      // separate "already added" set then describes a dockview that no longer
      // exists, so the new one never receives any panels.
      const artifact = graphRef.current.artifacts[tab.artifactId];
      const layout = tab.useDefaultLayout && artifact ? layoutForType(artifact.type) : undefined;
      const root: LayoutNode = layout?.root
        ?? { panels: [{ view: tab.view, artifact: '$primary' }] };

      if (api.getPanel(`${tab.id}#0`)) continue;

      // A deliberate split takes priority over every other anchor — it is
      // the one signal that came from the user asking for this exact
      // arrangement, not from a default this tab happens to fall under.
      const splitAnchor = tab.splitFrom ? api.getPanel(`${tab.splitFrom}#0`)?.id ?? null : null;
      const splitDirection = tab.splitDirection ?? 'right';

      /**
       * Where a single re-opened view lands.
       *
       * Without a hint it lands in whatever group happens to be active, which
       * for a view the user just closed is almost never where it was. The
       * artifact type's default layout already says which views belong
       * together, so a re-opened "Activities" rejoins the group that still
       * holds its leaf sibling "Attributes" — and only falls back to the
       * active group when no sibling is on screen.
       */
      const reopenAnchor = (() => {
        if (tab.useDefaultLayout || !artifact) return null;
        const leaf = leafContaining(layoutForType(artifact.type)?.root, tab.view);
        if (!leaf) return null;
        const siblings = new Set(leaf.panels.map((p) => p.view));
        const open = api.panels.find((p) =>
          (p.params as any)?.artifactId === tab.artifactId &&
          siblings.has((p.params as any)?.view));
        return open?.id ?? null;
      })();

      let seq = 0;
      /**
       * Walks the layout tree instead of a flattened panel list, so grouping
       * survives: panels inside one leaf become tabs of a single group, and
       * splits become actual splits. Flattening loses that and tabs unrelated
       * panels together.
       *
       * Returns the id of the node's first panel, which is what the next
       * sibling anchors against.
       */
      const addNode = (
        node: LayoutNode,
        anchor: string | null,
        direction: 'below' | 'left' | 'right' | 'within'
      ): string | null => {
        if ('panels' in node) {
          let firstId: string | null = null;
          node.panels.forEach((spec) => {
            // `view: '$primary'` mirrors the existing `artifact: '$primary'`
            // sentinel: a layout that wants "whatever this artifact type's
            // canonical view is" without hardcoding an id resolves it here,
            // the same way `openArtifact`'s own candidate-picking does (a
            // `primary`-flagged view first, else plain registration order).
            // A bundled layout can then apply to any type with a suitable
            // view — including one only a plugin, installed later, supplies
            // — instead of naming one specific view's id, core or not.
            const resolvedView = spec.view === '$primary'
              ? (viewRegistry.forType(artifact.type, artifact).find((v) => v.primary)
                  ?? viewRegistry.forType(artifact.type, artifact)[0])?.id
              : spec.view;
            if (!resolvedView) return;
            const panelId = `${tab.id}#${seq++}`;
            api.addPanel({
              id: panelId,
              component: 'host',
              title: tab.title,
              // A sandboxed plugin view's iframe cannot tolerate dockview's
              // default `onlyWhenVisible` rendering: switching tabs away and
              // back reparents the panel's content DOM into a fresh location
              // in the layout, and moving an `<iframe>` element to a new DOM
              // position makes the browser reload its document — wiping the
              // plugin's entire JS state (any layout it computed, its
              // pan/zoom position, selection) for no reason a plain tab
              // switch should cause. `renderer: 'always'` is dockview's own
              // documented per-panel opt-out: it keeps the content parented
              // in a stable overlay container instead of being detached and
              // re-appended on every tab switch. Every other view (no
              // `entry`, so no iframe) keeps the default, which is the
              // cheaper choice when nothing inside a panel cares whether its
              // DOM node moves.
              renderer: viewRegistry.get(resolvedView)?.entry ? 'always' : undefined,
              params: {
                artifactId: tab.artifactId,
                view: resolvedView,
                graph: graphRef.current,
                viewParams: tab.viewParams ?? spec.params,
                onSaveScript,
                onPlanChange,
                onParamChange: onTabParamChange
                  ? (key: string, value: unknown) => onTabParamChange(tab.id, key, value)
                  : undefined,
                savedViewId: tab.savedViewId,
                preview: tab.preview,
                onOpenArtifact,
                onFocusArtifact,
                onGraphUpdated,
                onPublishedArtifact,
                onDeriveLog,
                onSaveNotebook,
                onOpenView,
                plugins,
                onOpenDestination,
                extraSelection,
                experimentalPluginIds,
              },
              position: firstId
                ? { referencePanel: firstId, direction: 'within' }
                : anchor
                  ? { referencePanel: anchor, direction }
                  : undefined,
            });
            if (!firstId) firstId = panelId;
          });
          // Leave the leaf's first panel active rather than its last.
          if (firstId) api.getPanel(firstId)?.api.setActive();
          return firstId;
        }

        const childDir = node.split === 'row' ? 'right' : 'below';
        let first: string | null = null;
        let cursor = anchor;
        node.children.forEach((child, i) => {
          const id = addNode(child, cursor, i === 0 ? direction : childDir);
          if (i === 0) first = id;
          if (id) cursor = id;
        });
        return first;
      };

      if (splitAnchor) {
        addNode(root, splitAnchor, splitDirection);
      } else {
        addNode(root, reopenAnchor, reopenAnchor ? 'within' : 'below');
      }
    }

    // Drop panels for artifacts that were closed or deleted.
    for (const panel of api.panels) {
      const tabId = panel.id.split('#')[0];
      if (!tabs.some((t) => t.id === tabId)) api.removePanel(panel);
    }

    // Report the active panel from the api as well as from the events above.
    // `onDidActivePanelChange` does not fire for the first panel — it becomes
    // active as it is added, before there is a change to observe — so relying
    // on the event alone leaves the inspector without a panel until the user
    // clicks a second one.
    reportActivePanel.current();
  }, [tabs, ready]);

  // Keep panel params in sync so views see fresh artifact metadata — and, for
  // the gallery, a current plugin list and tree selection. Neither is known
  // when its panel is created, and the gallery is the one panel whose content
  // changes when something *outside* it does (a plugin is installed, a second
  // artifact is selected), so it cannot be left with the params it opened with.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      panel.api.updateParameters({
        ...panel.params, graph, plugins, extraSelection, onOpenDestination, experimentalPluginIds,
      });
    }
  }, [graph, plugins, extraSelection, onOpenDestination, experimentalPluginIds]);

  // Push view parameters edited in the inspector back into their panel. The
  // panel is the owner of its own settings; the inspector only edits them.
  //
  // The artifact binding is pushed the same way. A tab can be re-pointed at a
  // different artifact without being reopened — saving a scratchpad turns it
  // into a `Script` artifact — and a panel left on the old id would keep
  // producing new artifacts on every save.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const tab = tabs.find((t) => t.id === panel.id.split('#')[0]);
      if (!tab) continue;
      const next: Record<string, unknown> = {};
      if (tab.viewParams && panel.params?.viewParams !== tab.viewParams) {
        next.viewParams = tab.viewParams;
      }
      if (panel.params?.artifactId !== tab.artifactId) next.artifactId = tab.artifactId;
      // `persistViewParams` resolves after the tab already exists (an OPFS
      // round-trip) and patches this in asynchronously — pushed through here
      // like everything else the tab owns, not set once at creation.
      if (tab.savedViewId && panel.params?.savedViewId !== tab.savedViewId) {
        next.savedViewId = tab.savedViewId;
      }
      if (Object.keys(next).length) panel.api.updateParameters({ ...panel.params, ...next });
      // Dockview's own panel title, not a params field — renaming a saved
      // view has to reach it through `setTitle`, the same way opening one
      // with a custom name does at creation. `setTitle` alone updates the
      // model but doesn't itself prompt PanelTab (which reads `props.api.title`)
      // to re-render when nothing else changed this tick — a no-op-valued
      // `updateParameters` call is what actually triggers that.
      if (tab.title && panel.title !== tab.title) {
        panel.api.setTitle(tab.title);
        panel.api.updateParameters({ ...panel.params });
      }
    }
  }, [tabs, ready]);

  /**
   * Re-focuses whichever tab was active when this workspace was last saved,
   * the moment its first panel actually exists — which can be a render or
   * two after `restoreActiveTabId` first arrives, since the panel-sync
   * effect above is what creates it. Guarded so a restore only ever happens
   * once: without it, this would re-focus that same tab every time some
   * unrelated `tabs` change (opening or closing anything else) happened to
   * re-run this effect while `restoreActiveTabId` was still set.
   */
  const restoredFocusRef = useRef(false);
  useEffect(() => {
    if (restoredFocusRef.current || !ready || !restoreActiveTabId) return;
    const panel = apiRef.current?.getPanel(`${restoreActiveTabId}#0`);
    if (!panel) return;
    panel.api.setActive();
    restoredFocusRef.current = true;
  }, [tabs, ready, restoreActiveTabId]);

  const fullscreenPanel = fullscreenPanelId ? apiRef.current?.getPanel(fullscreenPanelId) : undefined;
  const fullscreenView = fullscreenPanel ? viewRegistry.get((fullscreenPanel.params as any)?.view) : undefined;
  const fullscreenArtifact = fullscreenPanel
    ? graph.artifacts[(fullscreenPanel.params as any)?.artifactId]
    : undefined;

  return (
    <>
      <DockviewReact
        // Dockview's light theme as the structural base — strip height, radii,
        // sash metrics. Its colours are remapped onto the app's tokens in
        // `styles.css`, so this stays put in dark mode too.
        className="dockview-theme-light"
        components={{ host: PanelHost }}
        defaultTabComponent={PanelTab}
        onReady={onReady}
        // dockview's own tab context menu (`getTabContextMenuItems`) needs the
        // "ContextMenu" module from dockview-enterprise, a separately licensed
        // package this project does not depend on. PanelTab renders its own
        // menu instead, built on the same public panel/group API.
      />
      {fullscreenPanel && fullscreenView?.entry && fullscreenArtifact && (
        <FullscreenPluginView
          artifact={fullscreenArtifact}
          panelId={fullscreenPanel.id}
          // Same key the docked panel underneath uses — the point is to
          // share its cache, not keep a second one.
          cacheKey={`${fullscreenArtifact.id}:${(fullscreenPanel.params as any)?.view}`}
          entry={fullscreenView.entry}
          params={(fullscreenPanel.params as any)?.viewParams}
          // The docked panel underneath was created with this same
          // tab-bound callback (`addPanel`'s `params.onParamChange`, above)
          // — reused rather than re-derived so both frames of the same tab
          // always agree on how to commit a param change.
          onParamChange={(fullscreenPanel.params as any)?.onParamChange}
          onGraphUpdated={onGraphUpdated}
          publishes={fullscreenView.publishes}
          readsFiles={fullscreenView.readsFiles}
          readsWorkspace={fullscreenView.readsWorkspace}
          fullscreenViewId={fullscreenView.id}
          onOpenView={(targetId, viewId, targetParams, placement) =>
            resolveOpenView(graph, onOpenArtifact, onOpenView, targetId, viewId, targetParams, placement)}
          provider={fullscreenView.provider}
          sourceArtifact={fullscreenArtifact.inputs.length === 1 ? graph.artifacts[fullscreenArtifact.inputs[0]] : undefined}
          comparisonCohorts={fullscreenView.provider === 'run.promenade.interaction-atlas'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricInteractionCohort'
              && candidate.inputs.includes(fullscreenArtifact.type === 'ObjectCentricEventLog' ? fullscreenArtifact.id : fullscreenArtifact.inputs[0] ?? ''))
            : undefined}
          interactionSelections={fullscreenView.interactionSelection === 'interaction-cohort-v1'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricInteractionCohort'
              && candidate.inputs.includes(fullscreenArtifact.type === 'ObjectCentricEventLog' ? fullscreenArtifact.id : fullscreenArtifact.inputs[0] ?? '')
              && !!(candidate.meta as any)?.selection?.binMask)
            : undefined}
          replayEvidence={fullscreenView.provider === 'run.promenade.interaction-atlas'
            ? Object.values(graph.artifacts).filter((candidate) => candidate.type === 'ObjectCentricReplayEvidence'
              && candidate.inputs.includes(fullscreenArtifact.type === 'ObjectCentricEventLog' ? fullscreenArtifact.id : fullscreenArtifact.inputs[0] ?? ''))
            : undefined}
          inspector={renderFullscreenInspector?.()}
          onExit={() => setFullscreenPanelId(null)}
        />
      )}
    </>
  );
}
