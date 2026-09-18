import type { Artifact, ArtifactTypeDef, ArtifactTypeId } from './types';

/**
 * Artifact type registry.
 *
 * Types registered by plugins must persist even after the plugin is removed,
 * otherwise an artifact of that type would either disappear from the tree or
 * become silently unusable. Removing a plugin marks its types
 * `providerInstalled: false`; the artifacts stay, visibly degraded.
 */
export class ArtifactTypeRegistry {
  private types = new Map<ArtifactTypeId, ArtifactTypeDef>();
  private listeners = new Set<() => void>();

  register(def: ArtifactTypeDef) {
    // Merged, not replaced: a plugin's manifest re-declares a core type it
    // produces (id, label, shortLabel) without repeating fields it has no
    // opinion on, like `family` — a full replace would silently blow those
    // away the moment the plugin installs and re-registers.
    const prev = this.types.get(def.id);
    this.types.set(def.id, { ...prev, ...def, providerInstalled: true });
    this.emit();
  }

  /** Keeps the definition, flags the provider gone. Never deletes. */
  markProviderRemoved(provider: string) {
    for (const [id, t] of this.types) {
      if (t.provider === provider) this.types.set(id, { ...t, providerInstalled: false });
    }
    this.emit();
  }

  get(id: ArtifactTypeId): ArtifactTypeDef {
    return this.types.get(id) ?? {
      // An artifact whose type was never registered in this session still has
      // to render. It is shown as unknown rather than dropped.
      id,
      label: id,
      shortLabel: id.slice(0, 8).toUpperCase(),
      provider: 'unknown',
      providerInstalled: false,
    };
  }

  all() { return [...this.types.values()]; }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }
}

export const artifactTypes = new ArtifactTypeRegistry();

/**
 * Core types. Only the two log types are implemented; the rest are declared
 * so the registry, the action slots and the provenance DAG already speak in
 * the vocabulary the later milestones need.
 */
const CORE: Array<Omit<ArtifactTypeDef, 'providerInstalled'>> = [
  { id: 'ObjectCentricEventLog', label: 'Object-Centric Event Log', shortLabel: 'OCEL 2.0', provider: 'core', family: 'log' },
  { id: 'TraditionalEventLog', label: 'Traditional Event Log', shortLabel: 'XES', provider: 'core', family: 'log' },
  { id: 'DFG', label: 'Directly-Follows Graph', shortLabel: 'DFG', provider: 'core', family: 'model' },
  { id: 'OCDFG', label: 'Object-Centric DFG', shortLabel: 'OC-DFG', provider: 'core', family: 'model' },
  // Weighted directed edges over activities, plus AND/XOR split-join
  // grouping — a DFG's shape with dependency-thresholded, noise-tolerant
  // edges instead of raw frequency ones. See the Heuristics Miner plugin.
  { id: 'CausalNet', label: 'Causal Net', shortLabel: 'C-NET', provider: 'core', family: 'model' },
  // PetriNet + InitialMarking + FinalMarking collapsed into one artifact: three
  // provenance nodes for one discovery result is noise, and the markings are
  // meaningless without the net.
  { id: 'AcceptingPetriNet', label: 'Accepting Petri Net', shortLabel: 'APN', provider: 'core', family: 'model' },
  { id: 'ObjectCentricPetriNet', label: 'Object-Centric Petri Net', shortLabel: 'OCPN', provider: 'core', family: 'model' },
  { id: 'ProcessTree', label: 'Process Tree', shortLabel: 'PT', provider: 'core', family: 'model' },
  { id: 'Bpmn', label: 'BPMN Diagram', shortLabel: 'BPMN', provider: 'core', family: 'model' },
  { id: 'AlignmentSet', label: 'Alignment Set', shortLabel: 'ALIGN', provider: 'core', family: 'result' },
  { id: 'ObjectCentricExecutionPartition', label: 'OCEL execution partition', shortLabel: 'OC-PART', provider: 'core', family: 'result' },
  { id: 'ObjectCentricInteractionCohort', label: 'OCEL interaction cohort', shortLabel: 'OC-COHORT', provider: 'core', family: 'result' },
  { id: 'ObjectCentricReplayEvidence', label: 'OCEL/OCPN replay evidence', shortLabel: 'OC-REPLAY', provider: 'core', family: 'result' },
  // A saved script is an artifact like any other: it has an input log, a
  // provenance entry, and content worth keeping.
  { id: 'Script', label: 'Python Script', shortLabel: 'PY', provider: 'core', family: 'result' },
  // A saved notebook, harmonized with Script on the same reasoning: it has
  // an input log, a provenance entry, and cells worth keeping. Its own
  // *published* results (see docs/python-notebook.md) are separate,
  // independent artifacts already — this type is the saved notebook
  // document itself, not a wrapper around what it produced.
  { id: 'Notebook', label: 'Python Notebook', shortLabel: 'NB', provider: 'core', family: 'result' },
];

for (const t of CORE) artifactTypes.register(t as ArtifactTypeDef);

/**
 * Family color — three buckets, not one per exact type. Reuses the same
 * Okabe-Ito entries the color registry's palette starts with, so the tree's
 * family colors read as the same "house style" as everything else, rather
 * than a second, competing color system.
 */
const FAMILY_COLOR: Record<'log' | 'model' | 'result', string> = {
  log: '#0072B2',
  model: '#8E6C8A',
  result: '#009E73',
};

export function familyColorOf(type: ArtifactTypeId): string {
  return FAMILY_COLOR[artifactTypes.get(type).family ?? 'result'];
}

/**
 * What a tree row (or any other artifact-first UI) should call this artifact.
 *
 * Always the stored name — the same one shown in the Inspector, the
 * breadcrumbs, and every other artifact-first surface. A derived artifact
 * used to get this overridden to its type's own noun ("Causal Net", "Process
 * Tree") at *display* time, on top of a stored name baked at creation as
 * "<action> · <source>" — which meant renaming a derived artifact changed
 * what the Inspector called it but not what the tree did, since the tree
 * never looked at `name` in the first place. `executeAction.ts` now gives a
 * new derived artifact that same type-noun default directly as its `name`,
 * so there is nothing left for a display-time override to add — this is
 * just `a.name`, consistently, everywhere.
 */
export function displayNameOf(a: Artifact): string {
  return a.name;
}
