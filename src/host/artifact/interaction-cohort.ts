import type { ActionExecution, Artifact } from './types';

/**
 * A source-bound, reusable population selected from an Interaction Atlas
 * field. It stores membership identifiers and the analytical definition, not
 * a second copy of any OCEL table.
 */
export const INTERACTION_COHORT_TYPE = 'ObjectCentricInteractionCohort';
export const INTERACTION_COHORT_SCHEMA_VERSION = 1;
export const INTERACTION_COHORT_INLINE_LIMIT = 8 * 1024 * 1024;
/**
 * A view-level protocol, rather than a screen-coordinate exchange. Consumers
 * receive source-bound event/object membership and, when present, the exact
 * discrete lifecycle-bin mask that produced it.
 */
export const INTERACTION_SELECTION_PROTOCOL = 'interaction-cohort-v1';

export interface ObjectCentricInteractionCohort {
  schemaVersion: 1;
  sourceArtifactId: string;
  selection: {
    coordinateSystem: 'lifecycle-phase-v1';
    pair: { a: string; b: string };
    phaseBounds: { minA: number; maxA: number; minB: number; maxB: number } | null;
    /** Optional non-rectangular lifecycle-bin selection.  Membership remains
     * authoritative; this records how an Atlas lasso defined it. */
    binMask?: { binCount: number; bins: number[] };
    filters: Record<string, unknown>;
  };
  members: {
    eventIds: string[];
    objectIds: string[];
    observationCount: number;
  };
}

/** True only for a cohort that represents an exact non-rectangular Atlas field. */
export function isLassoInteractionSelection(value: unknown, sourceArtifactId?: string): value is ObjectCentricInteractionCohort {
  try {
    return !!requireInteractionCohort(value, sourceArtifactId).selection.binMask;
  } catch {
    return false;
  }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}
function bounds(value: unknown): value is ObjectCentricInteractionCohort['selection']['phaseBounds'] {
  if (value === null) return true;
  const b = value as Record<string, unknown> | null;
  return !!b && ['minA', 'maxA', 'minB', 'maxB'].every((key) => typeof b[key] === 'number' && Number.isFinite(b[key]))
    && Number(b.minA) >= 0 && Number(b.maxA) <= 1 && Number(b.minB) >= 0 && Number(b.maxB) <= 1
    && Number(b.minA) <= Number(b.maxA) && Number(b.minB) <= Number(b.maxB);
}

function binMask(value: unknown): boolean {
  if (value === undefined) return true;
  const mask = value as { binCount?: unknown; bins?: unknown } | null;
  return !!mask && Number.isInteger(mask.binCount) && Number(mask.binCount) >= 8 && Number(mask.binCount) <= 80
    && Array.isArray(mask.bins) && mask.bins.every((bin) => Number.isInteger(bin) && Number(bin) >= 0 && Number(bin) < Number(mask.binCount) ** 2)
    && new Set(mask.bins).size === mask.bins.length;
}

/** Throws for malformed or cross-source interaction cohorts. */
export function requireInteractionCohort(value: unknown, sourceArtifactId?: string): ObjectCentricInteractionCohort {
  const cohort = value as Partial<ObjectCentricInteractionCohort> | null;
  if (!cohort || cohort.schemaVersion !== INTERACTION_COHORT_SCHEMA_VERSION || typeof cohort.sourceArtifactId !== 'string') {
    throw new Error('Interaction cohort must use schemaVersion 1 and name its source artifact.');
  }
  if (sourceArtifactId && cohort.sourceArtifactId !== sourceArtifactId) {
    throw new Error('Interaction cohort sourceArtifactId must match the artifact it was opened from.');
  }
  const selection = cohort.selection;
  if (!selection || selection.coordinateSystem !== 'lifecycle-phase-v1' || !selection.pair
    || typeof selection.pair.a !== 'string' || !selection.pair.a || typeof selection.pair.b !== 'string' || !selection.pair.b
    || !bounds(selection.phaseBounds) || !binMask(selection.binMask)
    || !selection.filters || typeof selection.filters !== 'object' || Array.isArray(selection.filters)) {
    throw new Error('Interaction cohort has an invalid analytical selection.');
  }
  const members = cohort.members;
  if (!members || !strings(members.eventIds) || !strings(members.objectIds)
    || !Number.isInteger(members.observationCount) || members.observationCount < 1) {
    throw new Error('Interaction cohort must have non-empty event and object membership and a positive observation count.');
  }
  if (new Set(members.eventIds).size !== members.eventIds.length || new Set(members.objectIds).size !== members.objectIds.length) {
    throw new Error('Interaction cohort membership identifiers must be unique.');
  }
  return cohort as ObjectCentricInteractionCohort;
}

function mint(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Pure construction for the narrowly-authorized Atlas cohort publish path. */
export function buildInteractionCohortArtifact(input: {
  source: Artifact;
  payload: unknown;
  name?: string;
  provider: string;
}): { artifact: Artifact; execution: ActionExecution } {
  if (input.source.type !== 'ObjectCentricEventLog') throw new Error('Interaction cohorts can only be derived from an object-centric event log.');
  const payload = requireInteractionCohort(input.payload, input.source.id);
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  const id = mint('a');
  const startedAt = new Date().toISOString();
  const execution: ActionExecution = {
    id: mint('x'), actionId: `${input.provider}.publishInteractionCohort`, actionVersion: '1',
    inputs: { source: [input.source.id] }, outputs: [id],
    params: { selection: payload.selection, schemaVersion: payload.schemaVersion },
    startedAt, durationMs: 0, runtime: { kind: 'core', version: 'plugin-view-bridge/1' },
  };
  return {
    artifact: {
      id, name: input.name?.trim() || `Interaction cohort · ${input.source.name}`,
      type: INTERACTION_COHORT_TYPE, createdAt: startedAt, storage: bytes > INTERACTION_COHORT_INLINE_LIMIT ? { kind: 'json', path: '' } : { kind: 'inline', value: payload },
      meta: { eventCount: payload.members.eventIds.length, objectCount: payload.members.objectIds.length, observationCount: payload.members.observationCount, selection: payload.selection, materialized: bytes > INTERACTION_COHORT_INLINE_LIMIT },
      producedBy: execution.id, inputs: [input.source.id],
    }, execution,
  };
}
