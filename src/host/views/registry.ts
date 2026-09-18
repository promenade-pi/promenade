import type { ArtifactTypeId } from '../artifact/types';
import type { ParamSchema } from '../actions/types';

/**
 * View registry.
 *
 * Native views and sandboxed plugin views are registered the same way and
 * resolved the same way, so the workspace never branches on "is this ours".
 * The only difference is how the panel body is produced: a React component
 * in-process, or an iframe with an entry URL.
 */
export interface ViewDef {
  id: string;
  label: string;
  provider: string;
  /**
   * Temporary feature flag. Disabled views stay registered so a previously
   * open panel can fail gracefully, but are omitted from artifact view
   * choices and saved-view rows until re-enabled.
   */
  disabled?: boolean;
  /** False marks foreign code; the UI shows it before the user clicks. */
  trusted: boolean;
  appliesTo?: ArtifactTypeId[];
  /**
   * A second, value-level condition on top of the type.
   *
   * The transform editor applies to a *derived* log, and "derived" is a
   * property of the artifact, not of its type — a filtered log is still a
   * TraditionalEventLog, which is exactly what makes every downstream action
   * work on it unchanged. Core-only: a plugin manifest is JSON and cannot
   * carry a predicate.
   */
  appliesWhen?: (a: { storage: { kind: string } }) => boolean;
  params?: ParamSchema;
  /** Source-bound cross-view interaction selection protocol requested by this view. */
  interactionSelection?: 'interaction-cohort-v1';
  /**
   * True when the view renders its own controls for `params` instead of the
   * host doing it generically in the inspector.
   *
   * `params` still governs the contract either way — defaults, what gets
   * auto-persisted into a saved view, what shows as a tree row — only who
   * *draws* the control changes. A checkbox or a dropdown is fine coming from
   * the inspector's generic `ParamControls`; a vertical slider glued to the
   * edge of a diagram, with the diagram filtering live as it's dragged, is
   * not something a JSON Schema can describe well enough to render at a
   * distance. Such a view receives `params`/`onParamChange` as props (an
   * in-process `component`) or over the same postMessage bridge it already
   * has (a sandboxed `entry`), and the inspector shows identity only.
   */
  ownsControls?: boolean;
  /**
   * True for panels that are not about an artifact — the plugin details page
   * is the first. Such a view receives only its `viewParams`.
   *
   * A sandboxed (`entry`) standalone view is how a plugin contributes an
   * authoring surface: there is nothing to select before a log exists, so a
   * view that *creates* an artifact cannot be a view *of* one. It opens from
   * the workspace's "New" affordance rather than from an artifact, and gets a
   * synthetic, table-less artifact stub the same way a live-preview panel
   * does.
   */
  standalone?: boolean;
  /**
   * Workspace chrome rather than a renderer of the artifact.
   *
   * The destination gallery is bound to an artifact exactly as an ordinary
   * view is — it needs to know whose destinations to list — but it is not one
   * of the answers to "what should opening this artifact show". Listing it as
   * a view choice would be circular (a card in the gallery, opening the
   * gallery), and letting it win `openArtifact`'s candidate-picking for a
   * type nothing else can draw would replace a straight answer with a menu.
   * So it is excluded from `forType` entirely and resolved only by id.
   *
   * Distinct from `standalone`, which means "not about an artifact at all"
   * and gets a synthetic, table-less stub; a chrome view gets the real one.
   */
  chrome?: boolean;
  /**
   * Artifact types this view may write to the catalog via
   * `promenade.publishLog()`.
   *
   * Publishing is a declared capability, not a provider allowlist: what
   * entitles a frame to create an artifact is its own manifest, which the
   * user consented to at install and can read in the plugin manager. The
   * host still validates every row before anything is written (see
   * `host/artifact/publish-log.ts`) — a declaration buys the plugin the
   * right to ask, never the right to be believed.
   */
  publishes?: ArtifactTypeId[];
  /**
   * The view may read the bound artifact's stored files (`promenade.files()`,
   * `promenade.openFile()`).
   *
   * A declared capability, like `publishes`, not a provider allowlist. The
   * file list is the one thing about an artifact that `sql()` cannot answer:
   * the catalog knows its relations, OPFS knows its files, and a storage
   * inspector is about the difference. Read-only, and scoped to the artifact
   * the frame is already bound to.
   */
  readsFiles?: boolean;
  /**
   * Opt in to proposing log repairs — `promenade.deriveLog(ops)`.
   *
   * Declared, like `publishes` and `readsFiles`, and deliberately narrower
   * than either: it does not let a view write an artifact of its choosing. It
   * lets a view append operations to a derived log whose source is the log its
   * own bound artifact was computed from, which the host resolves — the view
   * never names the target. A quality report proposing a fix for the log it
   * just analysed is the whole of what this permits.
   */
  derivesLogs?: boolean;
  /**
   * The view may read which panels are open and what parameters they are
   * showing (`promenade.workspace()`, the `workspace` event).
   *
   * Declared, like `publishes` and `readsFiles`. Read-only and content-free:
   * ids, labels and view parameters, never a row of anybody's data. It is
   * what a panel whose subject is the *other* panels needs — a questionnaire
   * checking that the participant actually filtered the log.
   */
  readsWorkspace?: boolean;
  /**
   * Where this view prefers to open — a column on that side rather than a tab
   * in the active group. A preference the host honours when there is
   * something to sit beside; panel geometry stays the host's.
   */
  dock?: 'left' | 'right';
  /**
   * This view *is* the artifact, not one alternative among several — an
   * Overview supplied by a bundled inspector plugin, say, standing in for
   * what used to be a core view. Three consequences follow from that one
   * idea: candidate-picking (`openArtifact` and friends) prefers it over
   * plain registration order, so opening the artifact reliably lands here
   * without depending on when this view happened to register relative to
   * others; the Inspector's "Views" list omits it, since listing it as a
   * choice would just be pointing at the panel already on screen; and
   * `hasPersistableViewState` treats it as unpersistable, so it never
   * becomes its own saved-view/tree row either — there is nothing to choose
   * between, so nothing to remember a choice about. At most one view per
   * artifact type should set this.
   */
  primary?: boolean;
  /** Set for in-process views. */
  component?: React.ComponentType<any>;
  /** Set for sandboxed plugin views: the script loaded inside the frame. */
  entry?: string;
  /**
   * The view can render a run-bound live preview: when an action whose output
   * type it `appliesTo` starts — any runtime — the host opens a panel for the
   * pending run and streams the action's progress into it (`liveRun`).
   */
  livePreview?: boolean;
  /**
   * Set when a manifest points at a host-provided view instead of shipping
   * its own renderer — a plugin that produces a standard artifact type should
   * not have to reimplement its visualization.
   */
  nativeView?: string;
}

/**
 * Whether a view has anything worth configuring.
 *
 * A view with no params is always the same panel every time — "Overview",
 * the core "Petri net" renderer. There is nothing about it a saved-view
 * record could remember, so auto-persisting one would just be a tree row
 * that says nothing more than the artifact it sits under already does.
 */
export function hasConfigurableParams(def: ViewDef | undefined): boolean {
  return !!def?.params && Object.keys(def.params.properties ?? {}).length > 0;
}

export function isViewEnabled(def: ViewDef | undefined): boolean {
  return !!def && !def.disabled;
}

/**
 * Whether opening a view should create a row beneath its artifact.
 *
 * A parameterless built-in panel (Overview, a table, etc.) has no state to
 * recall, so a tree row would merely duplicate the artifact. A sandboxed
 * plugin renderer is different: choosing it is meaningful state in its own
 * right, even when its manifest declares no parameters. Keeping that row
 * makes an alternate renderer such as "OCPN (React Flow)" discoverable and
 * reopenable from the artifact tree.
 */
export function hasPersistableViewState(def: ViewDef | undefined): boolean {
  return isViewEnabled(def) && !def?.primary && (hasConfigurableParams(def) || !!def?.entry);
}

class ViewRegistry {
  private views = new Map<string, ViewDef>();
  private listeners = new Set<() => void>();

  register(v: ViewDef) {
    this.views.set(v.id, v);
    this.emit();
  }

  get(id: string) { return this.views.get(id); }

  unregister(id: string) { this.views.delete(id); this.emit(); }
  all() { return [...this.views.values()]; }

  /**
   * Views usable for an artifact type, the ones that name the type first.
   *
   * A view without `appliesTo` (provenance, say) is applicable to everything,
   * which makes it a poor answer to "what should opening this artifact show".
   * Ordering keeps it available without letting it win by registration order.
   */
  forType(type: ArtifactTypeId, artifact?: { storage: { kind: string } }) {
    const usable = this.all().filter((v) =>
      !v.disabled &&
      // A standalone panel is not a view of anything, so it is never an
      // answer to "what should opening this artifact show" — and unlike the
      // Inspector's own list, this is the path that picks a default view,
      // where a stray candidate with no `appliesTo` would silently win.
      !v.standalone &&
      // Chrome is bound to an artifact but is not a way of looking at it —
      // see `ViewDef.chrome`.
      !v.chrome &&
      // A manifest can expose a host renderer through `nativeView`. It is an
      // alias, not an independent implementation, so disabling the host view
      // must disable every alias too (notably OCPN discovery's native viewer).
      !(v.nativeView && this.get(v.nativeView)?.disabled) &&
      (!v.appliesTo || v.appliesTo.includes(type)) &&
      (!v.appliesWhen || (artifact ? v.appliesWhen(artifact) : false)));
    const ordered = [
      ...usable.filter((v) => v.appliesTo),
      ...usable.filter((v) => !v.appliesTo),
    ];
    /**
     * Several manifests pointing `nativeView` at the same host view — every
     * miner that produces `AcceptingPetriNet` recommends `core.petriNetView`
     * this way — are all describing the *same* visualization, not competing
     * ones. Opening any of them renders the identical panel, so only the
     * first (core wins on registration order) survives; the rest would just
     * be duplicate rows in the Views list for a distinction that isn't real.
     * A view that ships its own renderer (`component`/`entry`) is always its
     * own identity and is never collapsed.
     */
    const seen = new Set<string>();
    return ordered.filter((v) => {
      const key = v.nativeView ?? v.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }
}

export const viewRegistry = new ViewRegistry();
