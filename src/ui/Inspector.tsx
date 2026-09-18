import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { logicalTablesOf } from '../host/artifact/tables';
import type { Artifact, ProvenanceGraph, ActionExecution } from '../host/artifact/types';
import { artifactTypes } from '../host/artifact/registry';
import { CAPABILITY_LABEL, describeMissing } from '../host/artifact/capabilities';
import { availableParts, describeClassifier } from '../host/transform/classifier';
import { actionRegistry } from '../host/actions/registry';
import { fmtBytes, fmtCount, fmtDate, fmtMs } from './format';
import { ParamControls } from './ParamControls';
import { optionSourceArtifact } from '../host/actions/options';
import { viewRegistry, hasConfigurableParams } from '../host/views/registry';
import type { SavedView } from '../host/views/savedViews';
import { destinationsFor } from '../host/views/destinations';
import { PluginIcon } from './PluginIcon';
import type { OpenPanel } from '../host/services/panels';
import {
  fetchRegistry, installFromRegistry, viewersFor, latestOf,
  configuredRegistries, type RegistryEntry, type RegistryIndex,
} from '../host/plugins/registry';


/**
 * Secondary artifact facts should not push the next useful operation below
 * the fold. Native disclosure keeps the sections keyboard-accessible and lets
 * the browser retain an intentionally opened section while the Inspector is
 * otherwise re-rendering.
 */
function CollapsibleInspectorSection({ title, children, className = '', defaultOpen = false }: {
  title: string;
  children: ReactNode;
  className?: string;
  /** Sets the native `<details>` element's initial state only — like
   * `defaultChecked`, the browser owns it from then on, so a user's own
   * toggle still sticks across re-renders. */
  defaultOpen?: boolean;
}) {
  return (
    <details className={`insp-sec insp-sec--collapsible ${className}`} open={defaultOpen || undefined}>
      <summary>
        <h4>{title}</h4>
        <span className="insp-sec-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="insp-sec-content">{children}</div>
    </details>
  );
}

/** A persisted timing record, deliberately shown next to the provenance it explains. */
function BenchmarkTimeline({ execution }: { execution: ActionExecution }) {
  const timing = execution.timing;
  if (!timing) {
    return <div className="why benchmark-legacy">No phase breakdown was recorded for this older run.</div>;
  }
  const total = Math.max(timing.totalMs, 0.1);
  return (
    <div className="benchmark-timeline">
      <div className="benchmark-heading">
        <span>End-to-end benchmark</span>
        <span className={`benchmark-cache ${timing.cacheState}`}>{timing.cacheState} cache</span>
      </div>
      {timing.phases.map((phase, index) => (
        <div className="benchmark-phase" key={`${phase.id}-${index}`}>
          <div className="benchmark-phase-row">
            <span title={phase.detail}>{phase.label}{phase.cached ? ' · cached' : ''}</span>
            <b>{fmtMs(phase.durationMs)}</b>
          </div>
          <div className="benchmark-bar-track">
            <span style={{ width: `${Math.max(1, Math.min(100, (phase.durationMs / total) * 100))}%` }} />
          </div>
          {phase.detail && <div className="benchmark-detail">{phase.detail}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Results that used the selected source directly form a fair, inspectable
 * baseline. It avoids pretending timings through different preprocessors are
 * interchangeable while still making Rust/SQL/pm4py alternatives comparable.
 */
function BenchmarkComparison({ source, graph }: { source: Artifact; graph: ProvenanceGraph }) {
  const runs = Object.values(graph.executions)
    .filter((execution) => Object.values(execution.inputs).flat().includes(source.id))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  if (!runs.length) return null;
  return (
    <CollapsibleInspectorSection title="Benchmark runs" className="benchmark-comparison">
      <div className="why">Direct runs on this artifact. Compare cold and warm cache runs separately.</div>
      <div className="benchmark-runs">
        {runs.map((run) => {
          const action = actionRegistry.get(run.actionId);
          return (
            <div className="benchmark-run" key={run.id} title={run.startedAt}>
              <span>{action?.label ?? run.actionId}</span>
              <span>{fmtMs(run.durationMs)}</span>
              <small>{run.runtime.kind}{run.timing ? ` · ${run.timing.cacheState}` : ''}</small>
            </div>
          );
        })}
      </div>
    </CollapsibleInspectorSection>
  );
}

/**
 * Context inspector.
 *
 * For Milestone 1 it shows identity, statistics, provenance and applicable
 * actions. The parameter controls are rendered from each action's JSON Schema
 * rather than supplied by the action, which is the precondition for live
 * recompute later: a plugin that ships its own parameter UI cannot sit in this
 * column and cannot be re-run on every keystroke.
 */
export function Inspector({
  artifacts, graph, onRun, liveParams, onParamChange, running,
  plugins, activePanel, onViewParamChange, onPluginsChanged, onClassifierChange,
  openPanels, onOpenView, selectedSavedView, onSavedViewParamChange,
  onCompare, onRecompute, computeEngines, experimentalPluginIds, onExplore,
}: {
  artifacts: Artifact[];
  graph: ProvenanceGraph;
  /** A saved view selected in the tree — shown instead of an artifact. */
  selectedSavedView?: SavedView | null;
  onRun: (actionId: string, artifact: Artifact, engine?: { engineId: string; endpoint: string }) => void;
  /** Configured Promenade Compute engines — feeds the "Run on" picker next to
   * a `computeEligible` action. Absent or empty just hides the picker. */
  computeEngines?: Array<{ id: string; name: string; endpoint: string; status: string }>;
  liveParams: Record<string, unknown> | null;
  onParamChange: (artifact: Artifact, key: string, value: unknown, cheap: boolean) => void;
  running: boolean;
  /** Installed plugins — read only, to flag results produced by an older version. */
  plugins: Array<{ manifest: any; bytes: number }>;
  /** Called after a plugin is installed from the inspector's suggestion. */
  onPluginsChanged?: () => void;
  onClassifierChange: (artifact: Artifact, classifier: unknown) => Promise<void> | void;
  /** The panel the user is looking at, and its current view parameters. */
  activePanel: { title: string; view: string; values: Record<string, unknown>; artifactId: string } | null;
  onViewParamChange: (key: string, value: unknown) => void;
  /** Edits the selected saved view's own settings — independent of workspace focus. */
  onSavedViewParamChange: (key: string, value: unknown) => void;
  /** Panels currently on screen, used to mark which views are already visible. */
  openPanels: OpenPanel[];
  onOpenView: (artifact: Artifact, viewId: string) => void;
  /** Opens every selected artifact's default view in a fresh side-by-side split. */
  onCompare?: (artifacts: Artifact[]) => void;
  /** Re-runs a stale artifact's producing action against its last params. */
  onRecompute?: (artifact: Artifact) => void;
  /** Plugin ids flagged `experimental` by a configured registry — same flag,
   * same cross-reference `PluginList`'s Browse/Installed lists compute, just
   * applied to the Views/Actions rows a view or action's own plugin backs. */
  experimentalPluginIds?: Set<string>;
  /**
   * Opens the destination gallery. The two lists below stay — they are the
   * fast path once you know the name of what you want — but with 40 plugins
   * contributing around a hundred views and actions, scanning two alphabetical
   * columns is no longer a way to *discover* anything, and this is the way out
   * of them.
   */
  onExplore?: (artifact: Artifact) => void;
}) {
  /**
   * Neither registry is component state, so installing or removing a plugin
   * mid-session — which mutates `viewRegistry`/`actionRegistry` directly —
   * would otherwise leave an already-mounted Inspector showing whatever
   * views/actions were applicable at mount time. Forcing a re-render on
   * their `emit()` is what makes the "Views" and "Available actions"
   * sections live, the same way `resultStore.subscribe` does for the view
   * panels (see e.g. DfgView.tsx).
   */
  const [registryTick, setRegistryTick] = useState(0);
  useEffect(() => {
    const unsubView = viewRegistry.subscribe(() => setRegistryTick((n) => n + 1));
    const unsubAction = actionRegistry.subscribe(() => setRegistryTick((n) => n + 1));
    return () => { unsubView(); unsubAction(); };
  }, []);

  /** actionId -> 'browser' | engineId, for the "Run on" picker below. */
  const [runOn, setRunOn] = useState<Record<string, string>>({});

  /**
   * `opensView` actions are excluded: they derive nothing, they only put a
   * panel on screen, which is what the Views section is for. Listing them in
   * both places made "Python script" and "Show provenance" appear twice, in a
   * list whose other entries all produce an artifact.
   */
  const applicable = useMemo(
    () => actionRegistry.applicableTo(artifacts)
      .filter(({ action }) => !action.opensView)
      // Alphabetical, not registration order — which plugin happened to
      // install first is not a sort key a user could ever predict, and this
      // list only grows as more plugins are added.
      .sort((a, b) => a.action.label.localeCompare(b.action.label)),
    [artifacts, registryTick]
  );
  const [actionQuery, setActionQuery] = useState('');

  /**
   * The plugin name behind a `provider` id, for disambiguating two entries
   * that display the same label.
   *
   * Two plugins can each legitimately contribute something called "Petri
   * net" — a viewer and a miner's own recommended view of what it produces,
   * say — and nothing here should have to know that could happen. What must
   * not happen is the two rows sitting side by side with no way to tell them
   * apart, so the label gains the plugin's name (not its `provider` id,
   * which is neither) whenever it collides with a sibling in the same list.
   */
  const pluginName = (provider: string) =>
    provider === 'core' ? 'Promenade' : (plugins.find((p: any) => p.manifest.id === provider)?.manifest.name ?? provider);

  /** A label suffix, only for entries whose label is not unique in `items`. */
  function disambiguator<T>(items: T[], labelOf: (t: T) => string, providerOf: (t: T) => string) {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(labelOf(it), (counts.get(labelOf(it)) ?? 0) + 1);
    return (it: T) => (counts.get(labelOf(it)) ?? 0) > 1 ? pluginName(providerOf(it)) : null;
  }

  /**
   * A saved view is not an artifact — it has no provenance, no statistics,
   * no storage — so it gets its own small render path entirely, rather than
   * a few extra fields bolted onto the artifact one below. What it has is a
   * renderer, a plugin that provides that renderer, the artifact it reads,
   * and the settings it was saved with.
   */
  if (selectedSavedView) {
    const sv = selectedSavedView;
    const def = viewRegistry.get(sv.view);
    const source = graph.artifacts[sv.sourceArtifactId];
    const hasParams = hasConfigurableParams(def);
    return (
      <div className="inspector">
        <div className="insp-title">{sv.title}</div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>Saved view</div>

        {/* Live, not a settings dump: this is the same two-way binding the
            algorithm's own parameters get when the producing artifact is
            selected, just scoped to how the result is drawn rather than how
            it was computed. First, since it's what you came here to change.
            Skipped when the view draws its own controls — a vertical slider
            glued to the diagram it filters, say — so the setting isn't
            edited in two places with two different feels. */}
        {hasParams && !def?.ownsControls && (
          <div className="insp-sec">
            <h4>Options</h4>
            <ParamControls
              schema={def!.params!}
              values={sv.state}
              optionArtifact={source ?? null}
              onChange={(k, v) => onSavedViewParamChange(k, v)}
            />
          </div>
        )}
        {hasParams && def?.ownsControls && (
          <div className="why" style={{ marginBottom: 2 }}>Configured on the panel itself.</div>
        )}

        <div className="insp-sec">
          <h4>View</h4>
          <div className="kv"><span>Renderer</span><span>{def?.label ?? sv.view}</span></div>
        </div>

        {def && (
          <div className="insp-sec">
            <h4>Provided by</h4>
            <div className="kv">
              <span>Plugin</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                {pluginName(def.provider)}
                {!def.trusted && <PluginIcon provider={def.provider} plugins={plugins} />}
              </span>
            </div>
          </div>
        )}

        <div className="insp-sec">
          <h4>Source</h4>
          <div className="kv"><span>Artifact</span><span>{source?.name ?? sv.sourceArtifactId}</span></div>
        </div>
      </div>
    );
  }

  /**
   * Settings of the panel currently in focus.
   *
   * Kept apart from the artifact's provenance on purpose: "where did this come
   * from" is a property of the artifact and is the same in every panel showing
   * it, while "how am I looking at it" belongs to the panel. Two panels on one
   * artifact have one answer to the first question and two to the second, so
   * the section is labeled with the panel it belongs to.
   */
  const viewSection = (() => {
    if (!activePanel) return null;
    const def = viewRegistry.get(activePanel.view);
    const schema = def?.params;
    const hasParams = hasConfigurableParams(def);
    // Rendered even for a view with no params: it's the panel's identity
    // card (which renderer, which plugin) regardless of whether there's
    // anything to configure. Parameter edits persist automatically — there
    // is no "Save view…" step to give a home to here any more.
    return (
      <div className="insp-sec">
        <h4>View</h4>
        <div className="insp-panelref">
          <div className="insp-panelref-title">
            <span>{def?.label ?? activePanel.view}</span>
            {def && !def.trusted && (
              <PluginIcon provider={def.provider} plugins={plugins} />
            )}
          </div>
          <div className="insp-panelref-sub">{activePanel.title}</div>
        </div>
        {hasParams && def?.ownsControls && (
          <div className="why">Configured on the panel itself.</div>
        )}
        {hasParams && !def?.ownsControls && (
          <ParamControls
            schema={schema!}
            values={activePanel.values}
            // A focused tab can outlive a tree selection (or be focused while
            // another artifact is selected). Compound controls such as the
            // dotted chart's time range must therefore read metadata from the
            // panel's actual source, not whichever artifact happens to be
            // first in the Inspector selection.
            optionArtifact={graph.artifacts[activePanel.artifactId] ?? artifacts[0] ?? null}
            onChange={(k, v) => onViewParamChange(k, v)}
          />
        )}
      </div>
    );
  })();

  if (artifacts.length === 0) {
    return (
      <div className="inspector">
        <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
          Select an artifact to inspect it.
        </div>

        {viewSection}
      </div>
    );
  }

  const a = artifacts[0];
  const def = artifactTypes.get(a.type);
  const meta: any = a.meta ?? {};
  const exec = a.producedBy ? graph.executions[a.producedBy] : null;

  return (
    <div className="inspector">
      <div className="insp-title">{a.name}</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 2 }}>
        <span className="chip">{def.shortLabel}</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{def.label}</span>
      </div>

      {a.providerMissing && (
        <div className="err" style={{ marginTop: 8 }}>
          The plugin that produced this artifact is not installed. The data is
          intact and still queryable, but it cannot be recomputed.
        </div>
      )}

      {/* An input upstream was recomputed after this artifact's own last
          run — its result still reflects that input's *previous* output.
          Recompute is a deliberate click, not automatic: cascading through
          an arbitrary chain on every keystroke of an upstream slider would
          re-run every expensive stage along it, every time. */}
      {a.stale && !a.providerMissing && (
        <div className="stale-banner" style={{ marginTop: 8 }}>
          <span>Out of date — an input changed since this was computed.</span>
          <button
            disabled={running || !exec}
            onClick={() => onRecompute?.(a)}
          >
            Recompute
          </button>
        </div>
      )}

      {/* The panel actually on screen comes first: it is what the user is
          looking at right now, and the artifact's own provenance/statistics
          are reference material underneath it, not the other way round. */}
      {viewSection}

      {/* The producing action's own parameters, as live controls — above
          "Produced by" and open by default: they're the thing most worth
          seeing/changing about a produced artifact, not a fact buried a
          click behind a collapsible that (being a plain native `<details>`)
          starts closed on every fresh selection. Changing one recomputes
          the artifact and updates every open view — no dialog, no Run
          button, no navigation. This is the reason the action signature is
          a pure function with a cached expensive stage. */}
      {exec && (() => {
        const paramDef = actionRegistry.get(exec.actionId);
        return (
          <CollapsibleInspectorSection key={`${a.id}-parameters`} title="Parameters" defaultOpen>
            {paramDef ? (
              <>
                <ParamControls
                  schema={paramDef.params}
                  values={liveParams ?? exec.params}
                  disabled={running}
                  // Options come from the input log, not from the derived
                  // artifact: a DFG has no event table to query.
                  optionArtifact={optionSourceArtifact(a, graph)}
                  onChange={(k, v, cheap) => onParamChange(a, k, v, cheap)}
                />
                {running && <div className="param-hint">recomputing…</div>}
              </>
            ) : (
              <div className="why">Producing plugin not installed — parameters cannot be edited.</div>
            )}
          </CollapsibleInspectorSection>
        );
      })()}

      <CollapsibleInspectorSection key={`${a.id}-produced-by`} title="Produced by">
        {exec ? (
          <>
            <div className="kv"><span>Action</span><span>{exec.actionId}</span></div>
            <div className="kv"><span>Runtime</span><span>{exec.runtime.kind} {exec.runtime.version}</span></div>
            {(() => {
              // Reproducibility, not tidiness: a result produced by 0.1.0 is a
              // result from 0.1.0, even after 0.2.0 is installed. Recomputing
              // it now could legitimately differ, so the divergence is shown
              // rather than silently resolved.
              const now = plugins.find((pl: any) =>
                (pl.manifest.actions ?? []).some((a: any) => a.id === exec.actionId));
              if (!now || now.manifest.version === exec.actionVersion) return null;
              return (
                <div className="why" style={{ marginTop: 4 }}>
                  Produced by v{exec.actionVersion}; v{now.manifest.version} is now
                  installed. Changing a parameter recomputes it with the new version.
                </div>
              );
            })()}
            <div className="kv"><span>Duration</span><span>{fmtMs(exec.durationMs)}</span></div>
            <div className="kv"><span>Inputs</span><span>
              {Object.values(exec.inputs).flat().map((id) => graph.artifacts[id]?.name ?? id).join(', ')}
            </span></div>
            <BenchmarkTimeline execution={exec} />
          </>
        ) : (
          <div className="kv">
            <span>Origin</span>
            <span>Imported ({String(meta.sourceFormat ?? 'unknown')})</span>
          </div>
        )}
      </CollapsibleInspectorSection>

      {a.producedBy == null && <BenchmarkComparison source={a} graph={graph} />}

      <CollapsibleInspectorSection key={`${a.id}-statistics`} title="Statistics">
        {meta.events != null && (
          <div className="kv">
            <span>Events</span>
            <span>
              {meta.truncated && meta.totalEvents != null
                ? `${fmtCount(meta.events)} of ${fmtCount(meta.totalEvents)}`
                : fmtCount(meta.events)}
            </span>
          </div>
        )}
        {meta.truncated && (
          <div className="why" style={{ color: 'var(--warn)', marginTop: -2, marginBottom: 4 }}>
            Event limit reached — mined from a prefix of the log, not all of
            it. Behavior past the cutoff (an infrequent activity, most
            visibly) can be missing from the result. Raise "Event limit" and
            recompute for the full log.
          </div>
        )}
        {meta.objects != null && <div className="kv"><span>Objects</span><span>{fmtCount(meta.objects)}</span></div>}
        {meta.traces != null && <div className="kv"><span>Traces</span><span>{fmtCount(meta.traces)}</span></div>}
        {meta.activities != null && <div className="kv"><span>Activities</span><span>{fmtCount(meta.activities)}</span></div>}
        {meta.objectTypes != null && <div className="kv"><span>Object types</span><span>{fmtCount(meta.objectTypes)}</span></div>}
        {meta.timeRange && (
          <div className="kv">
            <span>Time range</span>
            <span>{fmtDate(meta.timeRange[0])} → {fmtDate(meta.timeRange[1])}</span>
          </div>
        )}
      </CollapsibleInspectorSection>

      <CollapsibleInspectorSection key={`${a.id}-storage`} title="Storage">
        {/* A derived log stores nothing: it is a query plan over its source.
            Showing empty source/Parquet rows would suggest data went missing. */}
        {a.storage.kind === 'view' ? (
          <>
            <div className="kv"><span>Kind</span><span>view · not materialised</span></div>
            <div className="kv"><span>Bytes</span><span>0</span></div>
            <div className="kv">
              <span>Operations</span>
              <span>{a.storage.plan.ops.length}</span>
            </div>
          </>
        ) : (
        <>
        <div className="kv"><span>Source</span><span>{fmtBytes(meta.sourceBytes)}</span></div>
        <div className="kv"><span>Parquet</span><span>{fmtBytes(meta.parquetBytes)}</span></div>
        {meta.sourceBytes > 0 && meta.parquetBytes > 0 && (
          <div className="kv">
            <span>Compression</span>
            <span>{(meta.sourceBytes / meta.parquetBytes).toFixed(1)} : 1</span>
          </div>
        )}
        <div className="kv"><span>Import time</span><span>{fmtMs(meta.importMs)}</span></div>
        </>
        )}
      </CollapsibleInspectorSection>

      {/* Traditional logs only: an OCEL event has no lifecycle or resource
          column, so there is nothing to choose and a control with a single
          immutable option is noise. */}
      {a.storage.kind === 'parquet' && a.type === 'TraditionalEventLog' && (
        <ClassifierSection artifact={a} onChange={onClassifierChange} />
      )}

      {((a.meta as any)?.capabilities ?? []).length > 0 && (
        <CollapsibleInspectorSection key={`${a.id}-contains`} title="Contains">
          {/* Observed, not declared: this is what the data actually has, which
              is what decides whether an action can do anything with it. */}
          <div className="cap-list">
            {((a.meta as any).capabilities as string[]).map((c) => (
              <span className="chip" key={c}>{CAPABILITY_LABEL[c as never] ?? c}</span>
            ))}
          </div>
        </CollapsibleInspectorSection>
      )}

      {logicalTablesOf(a).length > 0 && (
        <CollapsibleInspectorSection key={`${a.id}-tables`} title="Tables">
          {logicalTablesOf(a).map((l) => (
            <div className="kv" key={l}>
              <span>{l}</span>
              <span>{a.storage.kind === 'view' ? 'view' : 'parquet'}</span>
            </div>
          ))}
        </CollapsibleInspectorSection>
      )}

      {onExplore && (
        <button type="button" className="insp-explore" onClick={() => onExplore(a)}>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <rect x="1.4" y="1.4" width="3.8" height="3.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="6.8" y="1.4" width="3.8" height="3.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1.4" y="6.8" width="3.8" height="3.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="6.8" y="6.8" width="3.8" height="3.8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </svg>
          Explore all {destinationsFor([a]).length} destinations
        </button>
      )}

      <div className="insp-sec">
        <h4>Views</h4>
        <MissingViewHint artifact={a} plugins={plugins} onInstalled={onPluginsChanged} />
        {/* A closed panel would otherwise only come back by closing every
            remaining panel of the artifact and opening it again, because the
            default arrangement is applied on open and never re-applied. */}
        {(() => {
          const views = viewRegistry.forType(a.type, a)
            .filter((v) => !v.standalone && !v.primary && (v.component || v.entry || v.nativeView))
            .sort((x, y) => x.label.localeCompare(y.label));
          const disambiguate = disambiguator(views, (v) => v.label, (v) => v.provider);
          return views.map((v) => {
            const open = openPanels.some((p) => p.artifactId === a.id && p.view === v.id);
            const from = disambiguate(v);
            return (
              <button
                key={v.id}
                className={`action-row${open ? ' action-row--open' : ''}`}
                onClick={() => onOpenView(a, v.id)}
                title={open ? 'Bring this panel forward' : 'Open this view'}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 550, display: 'flex', alignItems: 'center', gap: 5 }}>
                    {v.label}
                    {from && <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> · {from}</span>}
                    {(!v.trusted || experimentalPluginIds?.has(v.provider)) && (
                      <PluginIcon provider={v.provider} plugins={plugins} experimental={experimentalPluginIds?.has(v.provider)} />
                    )}
                  </div>
                </div>
                <span className="action-chevron" aria-hidden="true">›</span>
              </button>
            );
          });
        })()}
      </div>

      <div className="insp-sec">
        <h4>Available actions</h4>
        {applicable.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>None for this type.</div>
        )}
        {/* Only past a handful of entries — below that, scanning is faster
            than typing, and an input box that filters down to itself the
            moment you start looking for something short is its own kind of
            annoying. */}
        {applicable.length > 6 && (
          <input
            type="search"
            className="insp-action-search"
            placeholder="Filter actions…"
            value={actionQuery}
            onChange={(e) => setActionQuery(e.target.value)}
          />
        )}
        {(() => {
          const q = actionQuery.trim().toLowerCase();
          const shown = q
            ? applicable.filter(({ action }) => action.label.toLowerCase().includes(q)
                || action.provider.toLowerCase().includes(q))
            : applicable;
          if (q && shown.length === 0) {
            return <div style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Nothing matches “{actionQuery}”.</div>;
          }
          const disambiguate = disambiguator(shown, ({ action }) => action.label, ({ action }) => action.provider);
          return shown.map((entry) => {
            const { action, applicable: ok, missing, unmet } = entry;
            const from = disambiguate(entry);
            const reachableEngines = (computeEngines ?? []).filter((e) => e.status !== 'unreachable');
            const showEnginePicker = action.computeEligible && reachableEngines.length > 0;
            const selected = runOn[action.id] ?? 'browser';
            const engine = selected !== 'browser' ? reachableEngines.find((e) => e.id === selected) : undefined;
            const row = (
              <button
                key={showEnginePicker ? undefined : action.id}
                className={`action-row${ok ? '' : ' blocked'}`}
                disabled={!ok || running || !action.implemented}
                onClick={() => onRun(action.id, a, engine ? { engineId: engine.id, endpoint: engine.endpoint } : undefined)}
                title={[
                  // The action's own sentence, when its author wrote one
                  // (`actions[].description` in the manifest). Same text the
                  // Agent API forwards — one description, two readers, rather
                  // than prose that only an agent ever sees.
                  action.description,
                  !action.implemented ? 'Declared, but no implementation registered yet'
                    : ok ? 'Run this action'
                    : (unmet ?? []).length
                      ? `Needs ${describeMissing(unmet.flatMap((u) => u.capabilities))}`
                      : 'Select the missing input first',
                ].filter(Boolean).join('\n\n')}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 550, display: 'flex', alignItems: 'center', gap: 5 }}>
                    {action.label}
                    {from && <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}> · {from}</span>}
                    {/* Third-party code is marked here, in the action list, so
                        the user knows before the click that isolated foreign
                        code runs — the hover spells out which plugin and
                        which version. */}
                    {(!action.trusted || experimentalPluginIds?.has(action.provider)) && (
                      <PluginIcon
                        provider={action.provider} runtime={action.runtime} plugins={plugins}
                        experimental={experimentalPluginIds?.has(action.provider)}
                      />
                    )}
                  </div>
                  {!ok && missing.length > 0 && (
                    <div className="why">
                      {/* Two slots can share a label on purpose — `transformLog`
                          accepts either a TraditionalEventLog or an
                          ObjectCentricEventLog and calls both "a log" — so the
                          label, not the slot, is what must be unique here. */}
                      also select {[...new Set(missing.map((m) => m.label))].join(' and ')}
                    </div>
                  )}
                  {/* A property the log does not have. Selecting something else
                      cannot fix it, so the wording must not suggest it can. */}
                  {(unmet ?? []).map((u) => (
                    <div className="why" key={u.slot.name}>
                      this log has no {describeMissing(u.capabilities)}
                    </div>
                  ))}
                </div>
                <span className="action-chevron" aria-hidden="true">›</span>
              </button>
            );
            if (!showEnginePicker) return row;
            return (
              <div className="action-row-flex" key={action.id}>
                {row}
                <select
                  className="action-row-engine-select"
                  value={selected}
                  disabled={running}
                  title="Run on"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRunOn((prev) => ({ ...prev, [action.id]: e.target.value }))}
                >
                  <option value="browser">Browser</option>
                  {reachableEngines.map((eng) => (
                    <option key={eng.id} value={eng.id}>{eng.name}</option>
                  ))}
                </select>
              </div>
            );
          });
        })()}
      </div>

      {artifacts.length > 1 && (
        <div className="insp-sec">
          <h4>Selection</h4>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 8 }}>
            {artifacts.length} artifacts selected — multi-input actions resolve
            their slots from this set.
          </div>
          {onCompare && (
            <button style={{ width: '100%' }} onClick={() => onCompare(artifacts)}>
              Compare side by side
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Offers a viewer from the registry when nothing installed can draw a type.
 *
 * This is the payoff of typing artifacts rather than wiring plugins to each
 * other. The Inductive Miner declares it produces a `ProcessTree` and knows
 * nothing about who might draw one; a viewer declares it consumes a
 * `ProcessTree` and knows nothing about who produced it. The host notices the
 * gap and the registry fills it — so a second miner of the same type gets the
 * suggestion for free, and a second viewer competes on equal terms.
 *
 * Only offered, never installed automatically: fetching and running third-party
 * code is the user's decision, and an artifact with no viewer is inconvenient,
 * not broken.
 */
function MissingViewHint({
  artifact, plugins, onInstalled,
}: {
  artifact: Artifact;
  plugins: Array<{ manifest: any; bytes: number }>;
  onInstalled?: () => void;
}) {
  const [index, setIndex] = useState<RegistryIndex | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const installedIds = new Set(plugins.map((p) => p.manifest.id));
  const hasViewer = viewRegistry
    .forType(artifact.type, artifact)
    .some((v) => v.appliesTo && (v.component || v.entry || v.nativeView));

  useEffect(() => {
    if (hasViewer) return;
    let canceled = false;
    (async () => {
      for (const url of configuredRegistries()) {
        try {
          const idx = await fetchRegistry(url);
          if (!canceled) { setIndex(idx); return; }
        } catch { /* a registry being down is not this panel's problem */ }
      }
    })();
    return () => { canceled = true; };
  }, [hasViewer, artifact.type]);

  if (hasViewer) return null;
  const candidates: RegistryEntry[] = viewersFor(index, artifact.type, installedIds);
  const typeLabel = artifactTypes.get(artifact.type).label;

  if (candidates.length === 0) {
    return (
      <div className="why" style={{ marginBottom: 6 }}>
        Nothing installed can draw a {typeLabel}.
      </div>
    );
  }

  return (
    <div className="insp-suggest">
      <div className="insp-suggest-head">
        No viewer installed for {typeLabel} — available in the registry:
      </div>
      {candidates.map((c) => (
        <div className="action-row" key={c.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 550 }}>{c.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              {c.id} · v{latestOf(c)?.version}
            </div>
          </div>
          <button
            className="primary"
            disabled={busy === c.id}
            onClick={async () => {
              setBusy(c.id);
              setNote(null);
              try {
                const v = latestOf(c);
                if (!v) throw new Error('no version published');
                const r = await installFromRegistry(index!, c, v);
                if (!r.ok) throw new Error(r.errors.join('; '));
                onInstalled?.();
                setNote(`${c.name} installed.`);
              } catch (e: any) {
                setNote(`install failed: ${e.message}`);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === c.id ? 'Installing…' : 'Install'}
          </button>
        </div>
      ))}
      {note && <div className="why">{note}</div>}
    </div>
  );
}

/**
 * The event classifier, as a log property rather than an XES detail.
 *
 * It sits in the inspector, not in the transform editor, because it is not a
 * transformation: it does not derive a new log, it decides how *this* log's
 * events are labeled. Changing it redefines one view, and every open panel
 * and every plugin sees the new labeling without knowing a classifier exists.
 *
 * Only parts the log actually has are offered — lifecycle appears for a log
 * with lifecycle values and not otherwise, which is the same observed-capability
 * rule the action list uses.
 */
function ClassifierSection({
  artifact, onChange,
}: {
  artifact: Artifact;
  onChange: (artifact: Artifact, classifier: unknown) => Promise<void> | void;
}) {
  const meta = artifact.meta as any;
  const current: string[] = meta?.classifier?.parts ?? ['activity'];
  const caps: string[] = meta?.capabilities ?? [];
  const parts = availableParts(caps);
  const [busy, setBusy] = useState(false);

  const toggle = async (part: string) => {
    const next = current.includes(part)
      ? current.filter((p) => p !== part)
      : [...current, part];
    // An empty classifier would leave every event unlabelled; the base
    // activity is the floor, not a choice.
    if (next.length === 0) return;
    setBusy(true);
    try { await onChange(artifact, { parts: next }); } finally { setBusy(false); }
  };

  return (
    <CollapsibleInspectorSection title="Classifier">
      <div className="cap-list">
        {parts.map((p) => (
          <label key={p} className={'cls-part' + (current.includes(p) ? ' on' : '')}>
            <input
              type="checkbox"
              disabled={busy || (current.length === 1 && current[0] === p)}
              checked={current.includes(p)}
              onChange={() => toggle(p)}
            />
            {p}
          </label>
        ))}
      </div>
      <div className="why" style={{ marginTop: 4 }}>
        Events are labeled <code>{describeClassifier({ parts: current })}</code>.
        {' '}Every plugin and view reads this labeling as <code>activity</code>.
      </div>
    </CollapsibleInspectorSection>
  );
}
