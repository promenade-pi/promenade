/**
 * Evidence contract for an OCEL replay against one concrete OCPN.
 *
 * An OCPN alone describes permitted behavior.  It cannot establish whether
 * an event was replayed, nor does it define an expected frequency.  Atlas
 * consumes this artifact — never a bare OCPN — for model-aware rendering.
 */
export const OCEL_OCPN_REPLAY_EVIDENCE_TYPE = 'ObjectCentricReplayEvidence';
export const OCEL_OCPN_REPLAY_EVIDENCE_SCHEMA_VERSION = 1;

export interface ReplayEventEvidence {
  eventId: string;
  /** Fraction of the event's object bindings replayed by the model, [0,1]. */
  support: number;
  logMoves: number;
  modelMoves: number;
}

export interface ExpectedInteractionField {
  pair: { a: string; b: string };
  binCount: number;
  /** Expected non-negative interaction mass in row-major lifecycle bins. */
  mass: number[];
  /** The population over which the mass was estimated. */
  population: 'replayed-events';
}

export interface ObjectCentricReplayEvidence {
  schemaVersion: 1;
  sourceArtifactId: string;
  modelArtifactId: string;
  coordinateSystem: 'lifecycle-phase-v1';
  replay: {
    engineId: string;
    engineVersion: string;
    ordering: 'timestamp-total-order-v1';
    completed: true;
  };
  events: ReplayEventEvidence[];
  /** Omitted means support is available but residuals are intentionally not. */
  expectedFields?: ExpectedInteractionField[];
}

function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

/** Validates the narrow input contract before model-aware Atlas code can read it. */
export function requireObjectCentricReplayEvidence(value: unknown, sourceArtifactId?: string): ObjectCentricReplayEvidence {
  const evidence = value as Partial<ObjectCentricReplayEvidence> | null;
  if (!evidence || evidence.schemaVersion !== OCEL_OCPN_REPLAY_EVIDENCE_SCHEMA_VERSION
    || !id(evidence.sourceArtifactId) || !id(evidence.modelArtifactId)
    || evidence.coordinateSystem !== 'lifecycle-phase-v1') {
    throw new Error('Object-centric replay evidence must use schemaVersion 1 and bind one source OCEL and OCPN model.');
  }
  if (sourceArtifactId && evidence.sourceArtifactId !== sourceArtifactId) {
    throw new Error('Replay evidence sourceArtifactId must match the Atlas source artifact.');
  }
  const replay = evidence.replay;
  if (!replay || !id(replay.engineId) || !id(replay.engineVersion) || replay.ordering !== 'timestamp-total-order-v1' || replay.completed !== true) {
    throw new Error('Replay evidence must identify a completed, deterministically ordered replay engine.');
  }
  if (!Array.isArray(evidence.events) || !evidence.events.length) throw new Error('Replay evidence must include event-level support.');
  const events = new Set<string>();
  for (const event of evidence.events) {
    if (!event || !id(event.eventId) || events.has(event.eventId) || !Number.isFinite(event.support)
      || event.support < 0 || event.support > 1 || !Number.isInteger(event.logMoves) || event.logMoves < 0
      || !Number.isInteger(event.modelMoves) || event.modelMoves < 0) {
      throw new Error('Replay evidence contains invalid event support.');
    }
    events.add(event.eventId);
  }
  if (evidence.expectedFields !== undefined) {
    if (!Array.isArray(evidence.expectedFields)) throw new Error('Replay expected fields must be an array.');
    const pairs = new Set<string>();
    for (const field of evidence.expectedFields) {
      const key = field?.pair ? `${field.pair.a}\u0000${field.pair.b}` : '';
      if (!field || !id(field.pair?.a) || !id(field.pair?.b) || !Number.isInteger(field.binCount)
        || field.binCount < 8 || field.binCount > 80 || field.population !== 'replayed-events'
        || !Array.isArray(field.mass) || field.mass.length !== field.binCount * field.binCount
        || field.mass.some((mass) => !Number.isFinite(mass) || mass < 0) || pairs.has(key)) {
        throw new Error('Replay evidence contains an invalid expected interaction field.');
      }
      pairs.add(key);
    }
  }
  return evidence as ObjectCentricReplayEvidence;
}
