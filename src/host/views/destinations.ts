/**
 * Destinations — one vocabulary for "what can I do with this artifact".
 *
 * The Inspector answers that question with two lists: views (things already
 * renderable) and actions (things that must be computed first). That split is
 * a *host implementation* distinction — does this land in the provenance DAG?
 * — and it leaked into the user's mental model, which is why "why is the
 * metro map an artifact but the dotted chart a view?" is a question anyone
 * asks after five minutes. It has no good answer, because for the person
 * choosing, there is no difference: both end with a panel on screen.
 *
 * A `Destination` is that end state. Opening one either shows a view of the
 * artifact in hand, or runs an action and shows a view of what it produced;
 * which of the two it was is a badge on the card, not a section heading.
 *
 * Nothing here executes anything or knows about React. It reads the same two
 * registries the Inspector reads (`viewRegistry.forType`,
 * `actionRegistry.applicableTo`) and returns the union, so a plugin that
 * registers correctly is in the gallery with no further opt-in.
 */

import { actionRegistry } from '../actions/registry';
import type { ActionDef, InputSlot } from '../actions/types';
import { artifactTypes } from '../artifact/registry';
import type { Artifact, ArtifactTypeId } from '../artifact/types';
import { viewRegistry, type ViewDef } from './registry';
import { preferredProducer } from './galleryPrefs';

/**
 * What the user is trying to do, as a closed vocabulary.
 *
 * Closed on purpose: this is the gallery's grouping, and a free-text category
 * from an untrusted manifest would produce forty groups of one. Today every
 * value is *derived* (see `intentOf`); the intended next step is an optional
 * `intent` field in the manifest, validated against exactly this list, which
 * overrides the derivation for the cases structure cannot settle.
 */
export type Intent = 'inspect' | 'discover' | 'conformance' | 'performance' | 'compare' | 'transform' | 'export';

export const INTENT_ORDER: Intent[] = [
  'inspect', 'discover', 'conformance', 'performance', 'compare', 'transform', 'export',
];

export const INTENT_LABEL: Record<Intent, string> = {
  inspect: 'Explore & inspect',
  discover: 'Discover a model',
  conformance: 'Conformance & quality',
  performance: 'Performance',
  compare: 'Compare',
  transform: 'Transform the log',
  export: 'Export',
};

/** Why a destination cannot be opened against the current selection. */
export type Blocked =
  /** Another artifact has to be selected as well. Selecting one fixes it. */
  | { reason: 'missing'; labels: string[] }
  /** The input lacks a property the action needs. Selecting something else does not fix it. */
  | { reason: 'unmet'; capabilities: string[] }
  /** Declared in a manifest, but no implementation is registered. */
  | { reason: 'unimplemented' };

/**
 * One prerequisite the host produces before the destination's own action.
 *
 * Only ever one today (`reachableFrom` stops at depth 2): a chain the user
 * cannot read at a glance is worse than an action they cannot reach, and two
 * hops already covers the case this exists for — an OC-DFG, a flattened log,
 * a Petri net standing between a log and the thing someone actually wants.
 */
export interface ChainStep {
  /** The intermediate artifact type. */
  type: ArtifactTypeId;
  typeLabel: string;
  /** The producer the planner picked. Always explicit: `produce()` refuses ambiguity. */
  producerId: string;
  producerLabel: string;
  producerPlugin?: string;
  /** The destination action's input slot this fills. */
  slot: string;
  /** The producer's own inputs, resolved from the selection. */
  inputs: Record<string, string[]>;
  /** Other actions producing the same type from this selection, for a swap control. */
  alternatives: Array<{ id: string; label: string; pluginLabel?: string }>;
  /**
   * Who runs this step.
   *
   * `true` — the host planned it and `executeAction` produces it
   * (`ExecuteActionArgs.prerequisite`).
   * `false` — the action declared `scans` and produces it inside its own
   * runtime adapter, which also forwards the caller's parameters, so a knob
   * on the consumer can still tune the prerequisite. That is why such an
   * action is *not* converted to simply declaring the intermediate as its
   * input: "Discover metro map" has `noiseThreshold` and `minerVariant`
   * precisely so the net can be re-mined from the metro map's own panel, and
   * a host-planned prerequisite runs on its producer's defaults.
   *
   * Either way the user is shown the same thing, which is the point.
   */
  plannedByHost: boolean;
}

export interface Destination {
  /**
   * Stable across sessions and installs — it is what pins and recents are
   * keyed by, so it must not contain an artifact id or a version.
   */
  key: string;
  kind: 'view' | 'action' | 'export';
  /** What you end up looking at: the view's label, or the action's result view. */
  title: string;
  /** How you get there — the action's own label, when a step runs first. */
  via?: string;
  description?: string;
  provider: string;
  pluginLabel?: string;
  trusted: boolean;
  intent: Intent;
  viewId?: string;
  actionId?: string;
  /** The registered view that will render this action's output, if any. */
  resultViewId?: string;
  outputType?: ArtifactTypeId;
  /** True when the action produces a type nothing installed can draw. */
  noRenderer?: boolean;
  blocked?: Blocked;
  /** Which schematic represents this destination — see `ui/views/gallery-thumbs`. */
  thumb: string;
  /** How many settings the Inspector will offer afterwards. */
  paramCount: number;
  /** The artifact type's canonical view — shown first, labelled as the default. */
  primary?: boolean;
  /**
   * Prerequisites the host runs first. Empty for everything `destinationsFor`
   * returns; one entry for everything `reachableFrom` adds.
   */
  chain?: ChainStep[];
}

function familyOf(type: ArtifactTypeId | undefined): 'log' | 'model' | 'result' | undefined {
  if (!type) return undefined;
  return artifactTypes.get(type).family ?? 'result';
}

/**
 * Keyword fallback, used *only* where structure cannot decide.
 *
 * An action producing a `result` may be a conformance check, a performance
 * study or a plain report, and nothing in its declaration says which. This is
 * the stand-in until manifests declare `intent` themselves; it is deliberately
 * last, so a structural fact always wins over a word in a label.
 */
const KEYWORD_INTENT: Array<[RegExp, Intent]> = [
  [/conform|align|replay|fitness|precision|quality|gap|repair|diagnos/i, 'conformance'],
  [/performance|timing|spectrum|bottleneck|duration|friction|throughput/i, 'performance'],
  [/compar|equivalen|difference/i, 'compare'],
];

function keywordIntent(...text: Array<string | undefined>): Intent | undefined {
  const hay = text.filter(Boolean).join(' ');
  for (const [re, intent] of KEYWORD_INTENT) if (re.test(hay)) return intent;
  return undefined;
}

/**
 * An action's intent, from what it declares rather than what it is called.
 *
 * The order matters: `exportsFile` and "produces nothing" are unambiguous;
 * a log out of a log is a transformation whatever the label says; two
 * required slots of one type is a comparison by construction. Only when the
 * output is a bare `result` does the keyword pass get a say.
 */
export function intentOf(def: ActionDef): Intent {
  if (def.exportsFile) return 'export';
  const out = def.outputs[0]?.type;
  if (!out) return keywordIntent(def.label, def.description) ?? 'inspect';

  const sameTypeRequired = new Map<ArtifactTypeId, number>();
  for (const slot of def.inputs) {
    if (!slot.required) continue;
    sameTypeRequired.set(slot.type, (sameTypeRequired.get(slot.type) ?? 0) + 1);
  }
  if ([...sameTypeRequired.values()].some((n) => n > 1)) return 'compare';

  const fam = familyOf(out);
  if (fam === 'log') return 'transform';
  if (fam === 'model') return keywordIntent(def.label) ?? 'discover';
  return keywordIntent(def.label, def.description) ?? 'inspect';
}

export function intentOfView(def: ViewDef): Intent {
  return keywordIntent(def.label) ?? 'inspect';
}

/**
 * Which schematic stands for a destination.
 *
 * Defaulted from the *artifact type*, not from the plugin: every miner that
 * produces an `AcceptingPetriNet` draws the same kind of picture, so every
 * one of them should get the Petri net schematic without shipping an asset.
 * Only a genuinely distinctive presentation — a metro map, a friction
 * terrain, a dotted chart — needs its own, and those are named here by view
 * or action id until a manifest can declare a `preview` of its own.
 *
 * Same idea as `ViewDef.nativeView`: a plugin producing a standard type
 * should not have to reimplement the visualization, nor the picture of it.
 */
const TYPE_THUMB: Record<string, string> = {
  ObjectCentricEventLog: 'table',
  TraditionalEventLog: 'table',
  DFG: 'dfg',
  OCDFG: 'ocdfg',
  CausalNet: 'dfg',
  FuzzyModel: 'dfg',
  OCDFGBackboneLayout: 'ocdfg',
  AcceptingPetriNet: 'petri',
  ObjectCentricPetriNet: 'ocpn',
  ProcessTree: 'tree',
  ObjectCentricProcessTree: 'tree',
  Bpmn: 'bpmn',
  AlignmentSet: 'align',
  ReplayDiagnostics: 'align',
  ObjectCentricReplayEvidence: 'replay',
  LocalProcessModelSet: 'lpm',
  LogQualityReport: 'report',
  CardinalityImpactReport: 'report',
  RelationGapEvaluation: 'gaps',
  RelationGapGraph: 'gaps',
  EventLogComparison: 'compare',
  OcpnComparison: 'compare',
  OCMetroMap: 'metro',
  OCVariantMetro: 'metro',
  OCVariantDFG: 'metro',
  OCStationMap: 'station',
  TotemModel: 'atlas',
  ObjectInteractionGraph: 'atlas',
  ObjectCentricInteractionCohort: 'atlas',
  VisualMinerReplay: 'replay',
  DirectlyFollowsVisualMinerReplay: 'replay',
  Script: 'code',
  Notebook: 'code',
  Survey: 'report',
  SurveyResponse: 'report',
};

/** Overrides, by view or action id, where the type's picture would be wrong. */
const ID_THUMB: Record<string, string> = {
  'run.promenade.dotted-chart.chart': 'dotted',
  'run.promenade.friction-topography.view': 'terrain',
  'run.promenade.performance-spectrum.view': 'spectrum',
  'run.promenade.synchronization-lens.view': 'spectrum',
  'run.promenade.interaction-atlas.view': 'atlas',
  'run.promenade.ocel-cases-variants.view': 'variants',
  'run.promenade.object-dynamics.overview': 'overview',
  'run.promenade.object-dynamics.multiplicity': 'hist',
  'run.promenade.object-dynamics.attribute-distribution': 'hist',
  'run.promenade.object-dynamics.activity-timing': 'spark',
  'run.promenade.object-dynamics.attribute-history': 'spark',
  'run.promenade.object-dynamics.lifecycle-repetition': 'variants',
  'run.promenade.object-dynamics.type-signatures': 'table',
  'run.promenade.ocel-builder.edit': 'edit',
  'run.promenade.fuzzy-miner.metricsView': 'hist',
  'run.promenade.raw-artifact-viewer.files': 'table',
  'core.logOverview': 'overview',
  'core.ocelot.overview': 'overview',
  'run.promenade.ocelot.overview': 'overview',
  'core.traceExplorer': 'variants',
  'core.provenance': 'dag',
  'core.scriptEditor': 'code',
  'core.notebook': 'code',
  'core.transformEditor': 'edit',
  'core.transformLog': 'edit',
  'core.flattenOcel': 'edit',
};

function thumbFor(id: string, type: ArtifactTypeId | undefined, intent: Intent): string {
  return ID_THUMB[id] ?? (type && TYPE_THUMB[type]) ?? (intent === 'export' ? 'export' : 'generic');
}

function paramCount(schema: { properties?: Record<string, unknown> } | undefined): number {
  return Object.keys(schema?.properties ?? {}).length;
}

/**
 * The view that would render an action's output, if one is installed.
 *
 * Prefers the type's `primary` view for exactly the reason `openArtifact`
 * does: opening the result should land where opening the artifact would.
 */
function resultViewFor(type: ArtifactTypeId | undefined): ViewDef | undefined {
  if (!type) return undefined;
  const candidates = viewRegistry.forType(type)
    // `forType` deliberately keeps views with no `appliesTo` — Provenance
    // applies to everything — ordered after the ones that name the type. That
    // is right for "which views can I open", and wrong here: a catch-all is
    // never what an action *produced*, so without this a discovery action
    // whose renderer isn't installed came back named "Provenance" instead of
    // reporting honestly that nothing can draw its output.
    .filter((v) => v.appliesTo?.includes(type))
    .filter((v) => v.component || v.entry || v.nativeView);
  return candidates.find((v) => v.primary) ?? candidates[0];
}

function slotLabels(slots: InputSlot[]): string[] {
  // Two slots can share a label on purpose (`transformLog` calls both of its
  // alternatives "a log"), so it is the label that must be unique here.
  return [...new Set(slots.map((s) => s.label))];
}

export interface DestinationOptions {
  /** Resolves a provider id to the plugin's display name, for the card's byline. */
  pluginLabel?: (provider: string) => string;
}

/**
 * Everything the current selection can lead to, in one list.
 *
 * `selection[0]` is the artifact the gallery is bound to; the rest matter
 * only for actions with more than one required slot, which is why the whole
 * selection is passed to `applicableTo` rather than just the first artifact.
 */
export function destinationsFor(selection: Artifact[], opts: DestinationOptions = {}): Destination[] {
  const subject = selection[0];
  if (!subject) return [];
  const name = opts.pluginLabel ?? ((p: string) => p);
  const out: Destination[] = [];
  /** Views already offered directly, to suppress the actions that merely open them. */
  const offeredViews = new Set<string>();

  for (const v of viewRegistry.forType(subject.type, subject)) {
    if (!v.component && !v.entry && !v.nativeView) continue;
    offeredViews.add(v.id);
    const intent = intentOfView(v);
    out.push({
      key: `view:${v.id}`,
      kind: 'view',
      title: v.label,
      provider: v.provider,
      pluginLabel: name(v.provider),
      trusted: v.trusted,
      intent,
      viewId: v.id,
      outputType: subject.type,
      thumb: thumbFor(v.id, subject.type, intent),
      paramCount: paramCount(v.params),
      primary: v.primary,
    });
  }

  for (const entry of actionRegistry.applicableTo(selection)) {
    const { action, applicable, missing, unmet } = entry;
    // An `opensView` action produces nothing and records nothing — it *is*
    // "open this view", which is already a card. Two cards reading "Python
    // script", one of them a view and one an action, describe one destination
    // and are exactly the distinction the gallery exists to stop exposing.
    // Kept when the view it opens is not otherwise offered for this type, in
    // which case the action is the only way in.
    if (action.opensView && offeredViews.has(action.opensView)) continue;
    // The gallery is about *this* artifact. `applicableTo` answers for the
    // whole selection, so with a second artifact selected it also returns
    // actions that consume only that one — an OCEL's miners showing up in an
    // OC-DFG's gallery. A second selection may only ever *unblock* a card
    // (filling an action's other slot), never introduce one.
    if (!action.inputs.some((slot) => slot.type === subject.type)) continue;
    const outputType = action.outputs[0]?.type;
    const resultView = resultViewFor(outputType);
    const intent = intentOf(action);
    /**
     * A prerequisite the action produces for itself. Purely descriptive here:
     * nothing about how it runs changes, and it is never offered to
     * `executeAction` as a host `prerequisite` — the adapter has already done
     * it by the time that would matter.
     */
    /**
     * Only when the prerequisite is a real, user-facing artifact.
     *
     * Several plugins scan an `internal` projection instead — a
     * case-id-encoded log only their own kernel can read, documented as
     * unsafe to run standalone. Naming one on the card would answer "what
     * does this do" with an implementation detail and invite the reader to
     * go looking for an artifact they must not use: "Discover OCPN" is not
     * meaningfully *via a XES log*. An internal step stays where `internal`
     * puts everything else — out of sight.
     */
    const scanProducer = action.scanAction ? actionRegistry.get(action.scanAction) : undefined;
    const declaredStep: ChainStep[] | undefined = (action.scans && scanProducer && !scanProducer.internal) ? [{
      type: action.scans,
      typeLabel: artifactTypes.get(action.scans).shortLabel,
      producerId: scanProducer.id,
      producerLabel: scanProducer.label,
      producerPlugin: name(scanProducer.provider),
      slot: action.inputs[0]?.name ?? 'log',
      inputs: {},
      alternatives: [],
      plannedByHost: false,
    }] : undefined;
    const blocked: Blocked | undefined =
      action.implemented === false ? { reason: 'unimplemented' }
        : unmet.length ? { reason: 'unmet', capabilities: [...new Set(unmet.flatMap((u) => u.capabilities))] }
        : !applicable ? { reason: 'missing', labels: slotLabels(missing) }
        : undefined;
    out.push({
      key: `action:${action.id}`,
      kind: 'action',
      // The card is named after what you end up looking at — "Metro map",
      // not "Discover metro map". Two exceptions, both cases where that name
      // says nothing: no renderer is installed, and a transformation, whose
      // output is another log and whose result view is therefore always the
      // same generic "Overview" — there, what the action *did* is the only
      // thing that distinguishes one card from the next.
      title: (intent === 'transform' ? action.label : resultView?.label) ?? action.label,
      via: action.label,
      description: action.description,
      provider: action.provider,
      pluginLabel: name(action.provider),
      trusted: action.trusted,
      intent,
      actionId: action.id,
      resultViewId: resultView?.id,
      outputType,
      noRenderer: !!outputType && !resultView,
      blocked,
      thumb: thumbFor(action.id, outputType, intent),
      paramCount: paramCount(action.params),
      chain: declaredStep,
    });
  }

  for (const action of actionRegistry.exportActionsFor(subject)) {
    out.push({
      key: `export:${action.id}`,
      kind: 'export',
      title: action.label,
      description: action.description,
      provider: action.provider,
      pluginLabel: name(action.provider),
      trusted: action.trusted,
      intent: 'export',
      actionId: action.id,
      thumb: thumbFor(action.id, undefined, 'export'),
      paramCount: paramCount(action.params),
    });
  }

  return out;
}

/** Groups destinations by intent, in a fixed order, dropping empty groups. */
export function byIntent(items: Destination[]): Array<{ intent: Intent; label: string; items: Destination[] }> {
  return INTENT_ORDER
    .map((intent) => ({ intent, label: INTENT_LABEL[intent], items: items.filter((d) => d.intent === intent) }))
    .filter((g) => g.items.length > 0);
}

/**
 * Whether the host can run this action on its declared defaults alone.
 *
 * The planner's contract is that it supplies a prerequisite the user did not
 * ask for, using `defaultParams()`. That is only defensible when every
 * required choice has a declared answer. `core.flattenOcel` is the case that
 * makes the rule concrete: its required `objectType` — which object type
 * becomes the case — has no default, and correctly so, because there is no
 * defensible default. Pick `order` and you get one process; pick `item` and
 * you get a different one from the same log. A chain that silently chose
 * would hide the single most consequential assumption in the result.
 *
 * `defaultFromOptions` deliberately does not count: it is resolved by the
 * Inspector against live data (`ParamControls`), not by `defaultParams`, so a
 * headless prerequisite would still run with the value unset.
 */
function runnableOnDefaults(def: ActionDef): boolean {
  return (def.params.required ?? []).every(
    (key) => def.params.properties[key]?.default !== undefined,
  );
}

/**
 * Capabilities this artifact lacks for the slot a producer would fill from it.
 *
 * The direct path gets this from `actionRegistry.applicableTo`, which is why a
 * Social Network card correctly greys out on a log with no `org:resource`. The
 * planner builds its producer list from shapes alone, and a chain is only as
 * runnable as its first step: without this, "Organizational model, based on
 * SNA" offered itself on a log whose SNA step could not run, and said so only
 * by failing when clicked.
 *
 * Returns the empty array when the producer is fine, so the caller can treat a
 * non-empty result as both "do not prefer this" and "here is the reason".
 */
function unmetForProducer(def: ActionDef, subject: Artifact): string[] {
  const have = new Set<string>(((subject.meta as any)?.capabilities ?? []) as string[]);
  const lacking = new Set<string>();
  for (const slot of def.inputs) {
    if (!slot.required || slot.type !== subject.type) continue;
    for (const c of slot.requires ?? []) if (!have.has(c)) lacking.add(c);
  }
  return [...lacking];
}

/**
 * Destinations one prerequisite away — the reachability planner.
 *
 * `destinationsFor` answers "what consumes this artifact". That is the reason
 * "Discover metro map" is one click on an OCEL while "Backbone layout" is not
 * reachable at all: the metro map's author wrote a `scans` declaration and the
 * backbone layout's author declared `inputs: [OCDFG]` and stopped. Both are
 * correct manifests; only one of them was rewarded for it.
 *
 * So the host plans the hop instead of each plugin arranging its own. For every
 * type reachable in one action from the selection, every action consuming
 * *that* type becomes a destination carrying the step it needs — executed
 * through `ExecuteActionArgs.prerequisite`, which is `ctx.produce()` and
 * therefore cached, cancellable, adopted if it already exists, and recorded in
 * provenance with the intermediate hidden from the tree.
 *
 * Depth is fixed at two. Three hops is where a gallery stops describing work
 * the user can check and starts guessing on their behalf.
 */
export function reachableFrom(selection: Artifact[], opts: DestinationOptions = {}): Destination[] {
  const subject = selection[0];
  if (!subject) return [];
  const name = opts.pluginLabel ?? ((p: string) => p);
  const usable = actionRegistry.all().filter((a) => a.run && !a.exportsFile && a.implemented !== false);

  /** Producers of each intermediate type, from the subject, best first. */
  const producers = new Map<ArtifactTypeId, ActionDef[]>();
  for (const a of usable) {
    // Never a producer the host cannot fully parameterise itself — see
    // `runnableOnDefaults`.
    if (!runnableOnDefaults(a)) continue;
    // Never an `internal` action. Its own documentation is the reason: it
    // exists to feed one particular later stage and is "confusing or unsafe
    // to run standalone against an unrelated input of the same declared
    // type" — a projection whose case-id encoding only its own miner knows
    // how to read. Planning a chain through one is exactly that mistake,
    // made automatically. `internal` stays reachable the way it was designed
    // to be: through its own plugin's `scans`, or an explicit `produce()`.
    if (a.internal) continue;
    // The producer has to be satisfiable by the selection alone: a
    // prerequisite that itself needs a second artifact is not a prerequisite
    // the host can quietly supply.
    if (!a.inputs.some((slot) => slot.required && slot.type === subject.type)) continue;
    if (a.inputs.some((slot) => slot.required && slot.type !== subject.type)) continue;
    for (const out of a.outputs) {
      if (out.type === subject.type) continue;
      if (!producers.has(out.type)) producers.set(out.type, []);
      producers.get(out.type)!.push(a);
    }
  }

  /** Producers this artifact cannot actually feed, and what they lack. */
  const unmet = new Map<ActionDef, string[]>();
  for (const list of producers.values()) {
    for (const a of list) {
      const lacking = unmetForProducer(a, subject);
      if (lacking.length) unmet.set(a, lacking);
    }
  }

  for (const [type, list] of producers) {
    // A producer this artifact cannot feed sorts last, not out: another
    // producer of the same type may be runnable, and if none is, the card is
    // still worth showing greyed out with the reason rather than vanishing.
    // Then first-party before third-party, then the one with fewest knobs — a
    // prerequisite the user did not ask for should be the least surprising
    // thing that satisfies the type.
    list.sort((x, y) =>
      (unmet.has(x) ? 1 : 0) - (unmet.has(y) ? 1 : 0)
      || (x.trusted ? 0 : 1) - (y.trusted ? 0 : 1)
      || Object.keys(x.params.properties).length - Object.keys(y.params.properties).length
      || x.label.localeCompare(y.label));
    // …but a producer the user picked for this type outranks all of it. The
    // sort is a default, not an authority (see `preferredProducer`). A stale
    // preference — the plugin was removed since — simply does not match and
    // the default stands.
    const chosen = preferredProducer(type);
    const at = chosen ? list.findIndex((a) => a.id === chosen) : -1;
    // …unless this artifact cannot feed it. A preference is a choice between
    // producers that work, not a reason to plan a step that cannot run.
    if (at > 0 && !unmet.has(list[at])) list.unshift(...list.splice(at, 1));
  }

  const direct = new Set(destinationsFor(selection, opts).map((d) => d.actionId).filter(Boolean));
  const out: Destination[] = [];
  const seen = new Set<string>();

  for (const [mid, ranked] of producers) {
    const via = ranked[0];
    for (const action of usable) {
      if (action.internal || direct.has(action.id) || seen.has(action.id)) continue;
      // An action that produces its own prerequisite already is a chain. A
      // planned route to it would be a second, different one.
      if (action.scans) continue;
      // Already one hop away: a chain to something the selection reaches
      // directly is a longer route to the same place.
      if (action.inputs.some((slot) => slot.type === subject.type)) continue;
      const slot = action.inputs.find((s) => s.required && s.type === mid);
      if (!slot) continue;
      // A slot demanding capabilities *of the intermediate* cannot be judged:
      // the artifact does not exist yet, and capabilities are observed rather
      // than declared. Planning past that would be guessing, so it is left to
      // the user to produce the intermediate and see for themselves.
      if (slot.requires?.length) continue;
      // Every *other* required slot must be fillable by the selection, or the
      // card is blocked for a reason the chain cannot fix.
      const others = action.inputs.filter((s) => s.required && s !== slot);
      const available = new Set(selection.map((a) => a.type));
      if (others.some((s) => !available.has(s.type))) continue;

      const outputType = action.outputs[0]?.type;
      const resultView = resultViewFor(outputType);
      const intent = intentOf(action);
      const viaSlot = via.inputs.find((s) => s.required && s.type === subject.type)!;
      const viaLacks = unmet.get(via) ?? [];
      seen.add(action.id);
      out.push({
        key: `chain:${action.id}`,
        kind: 'action',
        title: (intent === 'transform' ? action.label : resultView?.label) ?? action.label,
        via: action.label,
        description: action.description,
        provider: action.provider,
        pluginLabel: name(action.provider),
        trusted: action.trusted,
        intent,
        actionId: action.id,
        resultViewId: resultView?.id,
        outputType,
        noRenderer: !!outputType && !resultView,
        thumb: thumbFor(action.id, outputType, intent),
        paramCount: paramCount(action.params),
        // A chain is only as runnable as its first step, and it is blocked for
        // the same reason and in the same words the producer's own card is.
        blocked: viaLacks.length ? { reason: 'unmet', capabilities: viaLacks } : undefined,
        chain: [{
          type: mid,
          typeLabel: artifactTypes.get(mid).shortLabel,
          producerId: via.id,
          producerLabel: via.label,
          producerPlugin: name(via.provider),
          slot: slot.name,
          inputs: { [viaSlot.name]: [subject.id] },
          alternatives: ranked.slice(1).map((r) => ({
            id: r.id, label: r.label, pluginLabel: name(r.provider),
          })),
          plannedByHost: true,
        }],
      });
    }
  }
  return out;
}
