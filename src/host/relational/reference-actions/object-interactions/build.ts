import type { RelationalResult } from '../../engine';

/**
 * The `ObjectInteractionGraph` artifact payload — the conversion/builder
 * layer combining four named relations (`object_type_summary`,
 * `type_interactions`, `e2o_qualifiers`, `o2o_relations`) into one typed
 * Artifact. `ObjectInteractionsView` reads this shape directly; nothing
 * downstream sees an Arrow table.
 */
export interface ObjectInteractionsPayload {
  objectTypes: Array<{
    objectType: string;
    objectCount: number;
    eventCount: number;
    avgEventsPerObject: number;
  }>;
  interactions: Array<{ typeA: string; typeB: string; sharedEvents: number }>;
  e2oQualifiers: Array<{ objectType: string; qualifier: string | null; n: number }>;
  o2oRelations: Array<{ sourceType: string; targetType: string; qualifier: string | null; n: number }>;
  stats: { objectTypes: number; interactions: number; e2oQualifiers: number; o2oRelations: number };
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v));

export function buildObjectInteractionsResult(result: RelationalResult): ObjectInteractionsPayload {
  const summaryTable = result.outputs.object_type_summary;
  const interactionsTable = result.outputs.type_interactions;
  const e2oTable = result.outputs.e2o_qualifiers;
  const o2oTable = result.outputs.o2o_relations;

  const objectTypes = summaryTable.toArray().map((r: any) => {
    const row = r.toJSON();
    return {
      objectType: String(row.object_type),
      objectCount: num(row.object_count),
      eventCount: num(row.event_count),
      avgEventsPerObject: Number(row.avg_events_per_object),
    };
  });

  const interactions = interactionsTable.toArray().map((r: any) => {
    const row = r.toJSON();
    return { typeA: String(row.type_a), typeB: String(row.type_b), sharedEvents: num(row.shared_events) };
  });

  const e2oQualifiers = e2oTable.toArray().map((r: any) => {
    const row = r.toJSON();
    return {
      objectType: String(row.object_type),
      qualifier: row.qualifier == null ? null : String(row.qualifier),
      n: num(row.n),
    };
  });

  const o2oRelations = o2oTable.toArray().map((r: any) => {
    const row = r.toJSON();
    return {
      sourceType: String(row.source_type),
      targetType: String(row.target_type),
      qualifier: row.qualifier == null ? null : String(row.qualifier),
      n: num(row.n),
    };
  });

  return {
    objectTypes,
    interactions,
    e2oQualifiers,
    o2oRelations,
    stats: {
      objectTypes: objectTypes.length,
      interactions: interactions.length,
      e2oQualifiers: e2oQualifiers.length,
      o2oRelations: o2oRelations.length,
    },
  };
}
