/**
 * The `ObjectCentricPetriNet` payload contract.
 *
 * Same role `process-tree.ts` plays for `ProcessTree`: this is the thing a
 * discovery action and a viewer agree on, not each other. The type is
 * registered in `core` (`registry.ts`) for the same reason — removing the
 * discovery action should degrade the artifact, not erase the meaning of
 * every OCPN already in the workspace.
 *
 * Mirrors `ocpn-core`'s Rust model field-for-field (see
 * `plugins/ocpn-rs/crates/ocpn-core/src/lib.rs`) — this file and that one are
 * the same contract in two languages, not two independent schemas that
 * happen to agree today.
 *
 * Shape notes:
 *  - No layout coordinates anywhere. Layout is view state, computed by the
 *    graph view at render time (see `OcpnView.tsx` / `ocpn-layout-worker.ts`),
 *    never persisted into the artifact.
 *  - Every id is a deterministic function of what the node means, not a
 *    generation counter — a labeled transition's id is a pure function of
 *    its activity label, so two object types independently discovering a
 *    transition for the same activity produce the *same* id. That is the
 *    merge mechanism, not an accident this validator has to guard against.
 */

export type OcpnPlaceKind = 'normal' | 'source' | 'sink';

export interface OcpnPlace {
  id: string;
  objectType: string;
  kind: OcpnPlaceKind;
}

export interface OcpnTransition {
  id: string;
  /** `null` for a silent (tau) transition. */
  activity: string | null;
  /** Every object type this transition participates in — more than one
   * entry means the discovery merge shared it across object types. */
  objectTypes: string[];
}

export type OcpnNodeRef =
  | { kind: 'place'; id: string }
  | { kind: 'transition'; id: string };

export interface OcpnArc {
  id: string;
  source: OcpnNodeRef;
  target: OcpnNodeRef;
  objectType: string;
  /** A single firing can consume/produce more than one token of this
   * object type at once. See `docs/algorithm.md` for exactly how this is
   * derived — it is symmetric across the arcs into and out of one
   * transition for one object type, not direction-specific. */
  variable: boolean;
}

export interface OcpnObjectTypeStats {
  places: number;
  transitions: number;
  arcs: number;
  silentTransitions: number;
  variableArcs: number;
  traces: number;
  events: number;
}

export interface OcpnSkippedObjectType {
  objectType: string;
  reason: string;
}

export interface OcpnMetadata {
  perObjectType: Record<string, OcpnObjectTypeStats>;
  skippedObjectTypes: OcpnSkippedObjectType[];
  parameters: {
    variant: 'IM' | 'IMf';
    noiseThreshold: number;
    objectTypes: string[];
  };
}

export interface OcpnPayload {
  objectTypes: string[];
  places: OcpnPlace[];
  transitions: OcpnTransition[];
  arcs: OcpnArc[];
  metadata: OcpnMetadata;
}

/**
 * Validates a payload claiming to be an OCPN — the same boundary check
 * `validateProcessTree` performs for `ProcessTree`. A discovery bug should
 * fail loudly here, at the artifact boundary, rather than reach a viewer
 * that trusts the shape and crashes on it.
 */
export function validateOcpn(v: unknown): string | null {
  const p = v as OcpnPayload;
  if (!p || typeof p !== 'object') return 'not an object';
  if (!Array.isArray(p.objectTypes)) return 'no objectTypes';
  if (!Array.isArray(p.places)) return 'no places';
  if (!Array.isArray(p.transitions)) return 'no transitions';
  if (!Array.isArray(p.arcs)) return 'no arcs';

  const types = new Set(p.objectTypes);
  const placeIx = new Map(p.places.map((pl) => [pl.id, pl]));
  const transitionIx = new Map(p.transitions.map((t) => [t.id, t]));

  for (const pl of p.places) {
    if (!types.has(pl.objectType)) return `place ${pl.id} has undeclared object type ${pl.objectType}`;
  }
  for (const t of p.transitions) {
    for (const ot of t.objectTypes) {
      if (!types.has(ot)) return `transition ${t.id} has undeclared object type ${ot}`;
    }
    if (t.activity == null && t.objectTypes.length !== 1) {
      return `silent transition ${t.id} must belong to exactly one object type`;
    }
  }
  for (const a of p.arcs) {
    if (!types.has(a.objectType)) return `arc ${a.id} has undeclared object type ${a.objectType}`;
    if ((a.source.kind === 'place') === (a.target.kind === 'place')) {
      return `arc ${a.id} does not alternate place/transition`;
    }
    for (const end of [a.source, a.target]) {
      if (end.kind === 'place') {
        const pl = placeIx.get(end.id);
        if (!pl) return `arc ${a.id} references unknown place ${end.id}`;
        if (pl.objectType !== a.objectType) {
          return `arc ${a.id} object type ${a.objectType} does not match place ${end.id} object type ${pl.objectType}`;
        }
      } else {
        const t = transitionIx.get(end.id);
        if (!t) return `arc ${a.id} references unknown transition ${end.id}`;
        if (!t.objectTypes.includes(a.objectType)) {
          return `arc ${a.id} object type ${a.objectType} not among transition ${end.id}'s object types`;
        }
      }
    }
  }

  return null;
}

/** Summary line for the inspector / tab title, e.g. "3 object types · 14 places · 9 transitions". */
export function summarizeOcpn(p: OcpnPayload): string {
  return `${p.objectTypes.length} object type${p.objectTypes.length === 1 ? '' : 's'} · `
    + `${p.places.length} places · ${p.transitions.length} transitions · ${p.arcs.length} arcs`;
}
