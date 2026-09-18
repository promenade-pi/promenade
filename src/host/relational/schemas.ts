import type { LogicalSchema } from './types.ts';

/**
 * Logical schemas for the two log artifact types.
 *
 * Columns and types are transcribed from what ingest actually produces —
 * `app/src/ingest/xes.ts` and `app/src/ingest/ocel-json.ts` — not invented
 * independently. A `TraditionalEventLog`'s `event_idx`/`trace_idx` are
 * ingest-assigned sequential integers; an `ObjectCentricEventLog`'s
 * `event_id`/`object_id` are the source file's own string identifiers. A
 * relational program that assumes one shape for the other fails to compile
 * against the wrong schema, which is the point of writing it down.
 *
 * `event.activity` is documented here even though physically it is a view
 * built by the classifier (`host/transform/classifier.ts`), not a stored
 * column: the classifier's whole purpose is that nothing downstream — this
 * schema included — has to know that.
 */

export const SCHEMA_VERSION = '1';

const TRADITIONAL_EVENT_LOG: LogicalSchema = {
  artifactType: 'TraditionalEventLog',
  schemaVersion: SCHEMA_VERSION,
  relations: [
    {
      name: 'events',
      description: 'One row per event, in an XES-derived case-centric log.',
      columns: [
        { name: 'event_idx', type: 'bigint', required: true, description: 'Ingest-assigned sequential id, unique within the log.' },
        { name: 'trace_idx', type: 'bigint', required: true, description: 'Ingest-assigned sequential id of the owning case.' },
        { name: 'activity', type: 'varchar', required: false, description: "The log's classifier, applied. Null only if the classifier itself yields null." },
        { name: 'ts', type: 'timestamp', required: false, description: 'Event timestamp; null on logs with no time information.' },
        { name: 'lifecycle', type: 'varchar', required: false, description: 'XES lifecycle transition, e.g. start/complete.' },
        { name: 'resource', type: 'varchar', required: false, description: 'XES org:resource, when present.' },
      ],
    },
    {
      name: 'event_attributes',
      description: 'Non-core XES attributes, long format: one row per (event, key).',
      columns: [
        { name: 'event_idx', type: 'bigint', required: true, description: 'References event.event_idx.' },
        { name: 'key', type: 'varchar', required: true, description: 'Attribute name.' },
        { name: 'type', type: 'varchar', required: true, description: "XES attribute type, e.g. 'string', 'int', 'date'." },
        { name: 'value', type: 'varchar', required: false, description: 'Attribute value, always as text; cast per `type` if needed.' },
      ],
    },
    {
      name: 'cases',
      description: 'One row per case (XES trace).',
      columns: [
        { name: 'trace_idx', type: 'bigint', required: true, description: 'Ingest-assigned sequential id, unique within the log.' },
        { name: 'case_id', type: 'varchar', required: false, description: 'The source XES concept:name of the trace, if declared.' },
      ],
    },
    {
      name: 'case_attributes',
      description: 'Non-core XES trace attributes, long format.',
      columns: [
        { name: 'trace_idx', type: 'bigint', required: true, description: 'References cases.trace_idx.' },
        { name: 'key', type: 'varchar', required: true, description: 'Attribute name.' },
        { name: 'type', type: 'varchar', required: true, description: 'XES attribute type.' },
        { name: 'value', type: 'varchar', required: false, description: 'Attribute value as text.' },
      ],
    },
  ],
};

const OBJECT_CENTRIC_EVENT_LOG: LogicalSchema = {
  artifactType: 'ObjectCentricEventLog',
  schemaVersion: SCHEMA_VERSION,
  relations: [
    {
      name: 'events',
      description: 'One row per event, in an OCEL 2.0 log.',
      columns: [
        { name: 'event_id', type: 'varchar', required: true, description: "The source file's own event identifier." },
        { name: 'activity', type: 'varchar', required: true, description: 'Event type / activity name.' },
        { name: 'ts', type: 'timestamp', required: false, description: 'Event timestamp.' },
      ],
    },
    {
      name: 'objects',
      description: 'One row per object.',
      columns: [
        { name: 'object_id', type: 'varchar', required: true, description: "The source file's own object identifier." },
        { name: 'object_type', type: 'varchar', required: true, description: 'Object type.' },
      ],
    },
    {
      name: 'event_object',
      description: 'Event-to-object relationships (E2O), with optional qualifier.',
      columns: [
        { name: 'event_id', type: 'varchar', required: true, description: 'References events.event_id.' },
        { name: 'object_id', type: 'varchar', required: true, description: 'References objects.object_id.' },
        { name: 'qualifier', type: 'varchar', required: false, description: 'OCEL 2.0 qualifier for this relationship, when declared.' },
      ],
    },
    {
      name: 'object_object',
      description: 'Object-to-object relationships (O2O), with optional qualifier.',
      columns: [
        { name: 'source_id', type: 'varchar', required: true, description: 'References objects.object_id.' },
        { name: 'target_id', type: 'varchar', required: true, description: 'References objects.object_id.' },
        { name: 'qualifier', type: 'varchar', required: false, description: 'OCEL 2.0 qualifier for this relationship, when declared.' },
      ],
    },
    {
      name: 'event_attributes',
      description: 'Event attributes, long format: one row per (event, name). Events carry their own timestamp.',
      columns: [
        { name: 'event_id', type: 'varchar', required: true, description: 'References events.event_id.' },
        { name: 'name', type: 'varchar', required: true, description: 'Attribute name.' },
        { name: 'value', type: 'varchar', required: false, description: 'Attribute value as text.' },
      ],
    },
    {
      name: 'object_attributes',
      description: 'Object attributes, long format, with the OCEL 2.0 per-value timestamp. Static and time-dependent attributes are not separated: an attribute is time-dependent precisely when an object carries more than one value for it.',
      columns: [
        { name: 'object_id', type: 'varchar', required: true, description: 'References objects.object_id.' },
        { name: 'name', type: 'varchar', required: true, description: 'Attribute name.' },
        { name: 'value', type: 'varchar', required: false, description: 'Attribute value as text.' },
        { name: 'ts', type: 'timestamp', required: false, description: 'The timestamp OCEL 2.0 attaches to this value.' },
      ],
    },
  ],
};

export const LOGICAL_SCHEMAS: Record<string, LogicalSchema> = {
  TraditionalEventLog: TRADITIONAL_EVENT_LOG,
  ObjectCentricEventLog: OBJECT_CENTRIC_EVENT_LOG,
};

/**
 * Maps a logical relation name (as it appears in `{role.logical}`) to the
 * physical logical-table key `host/artifact/tables.ts` and the worker's
 * `tableName()` already use. The two vocabularies differ on purpose: this
 * module's names are the plugin-facing, documented API
 * (`log.events`/`log.event_object`); the physical layer's names
 * (`event`/`e2o`) predate this API and renaming them would be a needless
 * breaking change to every existing core view and plugin.
 */
export const PHYSICAL_LOGICAL_NAME: Record<string, Record<string, string>> = {
  TraditionalEventLog: {
    events: 'event',
    event_attributes: 'event_attr',
    cases: 'trace',
    case_attributes: 'trace_attr',
  },
  ObjectCentricEventLog: {
    events: 'event',
    objects: 'object',
    event_object: 'e2o',
    object_object: 'o2o',
    event_attributes: 'event_attr',
    object_attributes: 'object_attr',
  },
};

export function schemaFor(artifactType: string): LogicalSchema | null {
  return LOGICAL_SCHEMAS[artifactType] ?? null;
}

export function relationNamesOf(artifactType: string): string[] {
  return schemaFor(artifactType)?.relations.map((r) => r.name) ?? [];
}
