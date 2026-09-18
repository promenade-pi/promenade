import * as arrow from 'apache-arrow';
import type { ActionExecution } from './types';

/**
 * Turns hand-authored log rows into the Arrow relations a log-shaped
 * artifact's physical storage is built from.
 *
 * This is the non-Python half of what `promenade.publish_ocel()` already does
 * for notebooks (see `worker/notebook-worker.ts`): same target relations, same
 * "any extra column is an attribute" rule, same resulting artifact. The
 * difference is only who assembles the rows — a pandas DataFrame there, a
 * sandboxed view's editor here — which is why the conversion lives in its own
 * pure module instead of inside the frame bridge: a log a plugin authored has
 * to be validated *before* anything is written, and validation of "are these
 * rows a well-formed OCEL log" is worth testing without a worker, a frame or
 * DuckDB in the picture.
 *
 * Referential integrity is enforced here rather than left to the plugin.
 * A dangling E2O row would otherwise import happily and then show up as an
 * event with no objects — the kind of log that makes every object-centric
 * algorithm downstream quietly wrong instead of loudly broken.
 */

/** Physical relation name -> Arrow IPC bytes, as `materializeNotebookLog` expects. */
export type LogRelations = Record<string, Uint8Array>;

export interface AuthoredLogRequest {
  type: string;
  name: string;
  events: Array<Record<string, unknown>>;
  objects: Array<Record<string, unknown>>;
  e2o: Array<Record<string, unknown>>;
  o2o?: Array<Record<string, unknown>>;
  /**
   * Time-dependent object attribute values: `{ object_id, name, ts, value }`.
   *
   * OCEL 2.0's object attributes are not static by nature — an order's
   * `priority` can change, and the log records *when* it took each value. The
   * row-level attribute columns above can only express one value per object,
   * so a value history arrives separately, and a `ts` is what makes a row one
   * of these rather than a static value.
   *
   * Where both are given for the same (object, attribute), the timed values
   * win and the static one is dropped: an attribute is either static (one
   * value, no time) or time-dependent (its values with their times) — never a
   * static value plus a history that silently contradicts it. Time-dependence
   * in OCEL 2.0 is observed, not declared (see `ingest/ocel-json.ts`), so
   * keeping both would make the observation ambiguous.
   */
  objectChanges?: Array<Record<string, unknown>>;
  /** OCEL 2.0's declared object/event types, as an import would carry them. */
  semantics?: unknown;
  /**
   * The log this one was edited from, for provenance. The host checks it
   * against the artifact the publishing frame is actually bound to — a frame
   * cannot claim to derive from an artifact it was never given.
   */
  source?: string;
}

export interface AuthoredLogSummary {
  events: number;
  objects: number;
  e2o: number;
  o2o: number;
  eventAttributes: number;
  objectAttributes: number;
  /** How many of `objectAttributes` are timed rather than static. */
  timedObjectAttributes: number;
}

const EVENT_COLUMNS = new Set(['event_id', 'activity', 'ts']);
const OBJECT_COLUMNS = new Set(['object_id', 'object_type']);

function requireText(value: unknown, where: string): string {
  const s = value == null ? '' : String(value).trim();
  if (!s) throw new Error(`${where} is required.`);
  return s;
}

function optionalText(value: unknown): string | null {
  const s = value == null ? '' : String(value).trim();
  return s ? s : null;
}

/**
 * A cell's timestamp as epoch milliseconds.
 *
 * Milliseconds, not microseconds, because that is what every log-shaped
 * artifact in this app carries at rest: an imported log's `ts` reaches Parquet
 * as a millisecond-valued column, and the round trip through the Parquet
 * writer and DuckDB's reader preserves the raw integer rather than the unit
 * it was labeled with. A microsecond-valued column therefore reads back a
 * thousand times too large — timestamps land in the year 57983, with nothing
 * anywhere reporting an error, since every type involved still says
 * “TIMESTAMP”. Matching the import representation is what makes an authored
 * log genuinely indistinguishable from an imported one.
 */
function timestampMillis(value: unknown, where: string): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`${where}: “${String(value)}” is not a date/time.`);
  return ms;
}

function textVector(values: Array<string | null>) {
  return arrow.vectorFromArray(values, new arrow.Utf8());
}

function ipc(fields: Record<string, arrow.Vector>): Uint8Array {
  return arrow.tableToIPC(new arrow.Table(fields), 'stream');
}

interface AttributeRow { owner: string; name: string; value: string }

/**
 * Extra columns become attribute rows, one per (owner, name) — the long
 * format both the OCEL ingest and `publish_ocel()` produce. Blank cells are
 * dropped rather than stored as empty strings: a half-filled grid column is
 * the normal state of a log being written by hand, and "this object has no
 * value for that attribute" is not the same claim as "its value is ''".
 */
function attributeRows(
  rows: Array<Record<string, unknown>>, ownerKey: string, reserved: Set<string>,
): AttributeRow[] {
  const out: AttributeRow[] = [];
  for (const row of rows) {
    const owner = String(row[ownerKey]).trim();
    for (const [key, raw] of Object.entries(row)) {
      if (reserved.has(key)) continue;
      const name = key.trim();
      if (!name) continue;
      const value = optionalText(raw);
      if (value === null) continue;
      out.push({ owner, name, value });
    }
  }
  return out;
}

/**
 * Validates authored rows and encodes them as Arrow IPC per relation.
 * Throws — with a message naming the offending row — rather than returning a
 * partially valid log: everything downstream of `materializeNotebookLog`
 * treats what it is handed as already-checked.
 */
export function buildAuthoredOcelRelations(
  request: AuthoredLogRequest,
): { relations: LogRelations; summary: AuthoredLogSummary } {
  if (request.type !== 'ObjectCentricEventLog') {
    throw new Error(`Authoring a “${request.type}” is not supported; only ObjectCentricEventLog.`);
  }
  if (!request.name?.trim()) throw new Error('The log needs a name.');
  if (!Array.isArray(request.events) || request.events.length === 0) {
    throw new Error('The log needs at least one event.');
  }
  if (!Array.isArray(request.objects)) throw new Error('The log needs an objects table.');
  if (!Array.isArray(request.e2o)) throw new Error('The log needs an event-to-object table.');

  const eventIds: Array<string | null> = [];
  const activities: Array<string | null> = [];
  const timestamps: Array<number | null> = [];
  const seenEvents = new Set<string>();
  request.events.forEach((row, i) => {
    const id = requireText(row.event_id, `Events row ${i + 1}: event_id`);
    if (seenEvents.has(id)) throw new Error(`Events row ${i + 1}: event id “${id}” is used twice.`);
    seenEvents.add(id);
    eventIds.push(id);
    activities.push(requireText(row.activity, `Events row ${i + 1}: activity`));
    timestamps.push(timestampMillis(row.ts, `Events row ${i + 1}`));
  });

  const objectIds: Array<string | null> = [];
  const objectTypes: Array<string | null> = [];
  const seenObjects = new Set<string>();
  request.objects.forEach((row, i) => {
    const id = requireText(row.object_id, `Objects row ${i + 1}: object_id`);
    if (seenObjects.has(id)) throw new Error(`Objects row ${i + 1}: object id “${id}” is used twice.`);
    seenObjects.add(id);
    objectIds.push(id);
    objectTypes.push(requireText(row.object_type, `Objects row ${i + 1}: object_type`));
  });

  const e2oEvent: Array<string | null> = [];
  const e2oObject: Array<string | null> = [];
  const e2oQualifier: Array<string | null> = [];
  const seenE2o = new Set<string>();
  request.e2o.forEach((row, i) => {
    const eventId = requireText(row.event_id, `E2O row ${i + 1}: event_id`);
    const objectId = requireText(row.object_id, `E2O row ${i + 1}: object_id`);
    if (!seenEvents.has(eventId)) throw new Error(`E2O row ${i + 1}: no event “${eventId}”.`);
    if (!seenObjects.has(objectId)) throw new Error(`E2O row ${i + 1}: no object “${objectId}”.`);
    const qualifier = optionalText(row.qualifier);
    // The same event may relate to the same object under two qualifiers, so
    // identity is the whole triple. An exact repeat is a duplicated grid row,
    // not a second relation, and would double every count computed from it.
    const key = `${eventId}${objectId}${qualifier ?? ''}`;
    if (seenE2o.has(key)) return;
    seenE2o.add(key);
    e2oEvent.push(eventId);
    e2oObject.push(objectId);
    e2oQualifier.push(qualifier);
  });

  const o2oSource: Array<string | null> = [];
  const o2oTarget: Array<string | null> = [];
  const o2oQualifier: Array<string | null> = [];
  const seenO2o = new Set<string>();
  (request.o2o ?? []).forEach((row, i) => {
    const sourceId = requireText(row.source_id, `O2O row ${i + 1}: source_id`);
    const targetId = requireText(row.target_id, `O2O row ${i + 1}: target_id`);
    if (!seenObjects.has(sourceId)) throw new Error(`O2O row ${i + 1}: no object “${sourceId}”.`);
    if (!seenObjects.has(targetId)) throw new Error(`O2O row ${i + 1}: no object “${targetId}”.`);
    const qualifier = optionalText(row.qualifier);
    const key = `${sourceId}${targetId}${qualifier ?? ''}`;
    if (seenO2o.has(key)) return;
    seenO2o.add(key);
    o2oSource.push(sourceId);
    o2oTarget.push(targetId);
    o2oQualifier.push(qualifier);
  });

  const eventAttrs = attributeRows(request.events, 'event_id', EVENT_COLUMNS);

  /**
   * Object attribute values, static and timed together — one relation, as
   * OCEL 2.0 has it, distinguished only by whether a row carries a `ts`.
   */
  const timed: Array<{ owner: string; name: string; value: string; ts: number }> = [];
  const timedKeys = new Set<string>();
  (request.objectChanges ?? []).forEach((row, i) => {
    const objectId = requireText(row.object_id, `Object change ${i + 1}: object_id`);
    const name = requireText(row.name, `Object change ${i + 1}: name`);
    if (!seenObjects.has(objectId)) throw new Error(`Object change ${i + 1}: no object “${objectId}”.`);
    // A value history without times is not a history — that is exactly what
    // the static attribute columns already are.
    const ts = timestampMillis(row.ts, `Object change ${i + 1}`);
    if (ts === null) throw new Error(`Object change ${i + 1}: a timed value needs a ts.`);
    const value = optionalText(row.value);
    if (value === null) throw new Error(`Object change ${i + 1}: a timed value needs a value.`);
    const key = `${objectId}${name}${ts}`;
    if (timedKeys.has(key)) return; // the same value at the same instant, twice
    timedKeys.add(key);
    timed.push({ owner: objectId, name, value, ts });
  });
  const hasHistory = new Set(timed.map((r) => `${r.owner}${r.name}`));
  const objectAttrs: Array<{ owner: string; name: string; value: string; ts: number | null }> = [
    ...attributeRows(request.objects, 'object_id', OBJECT_COLUMNS)
      // See `objectChanges`: timed values replace a static one outright.
      .filter((r) => !hasHistory.has(`${r.owner}${r.name}`))
      .map((r) => ({ ...r, ts: null })),
    ...timed,
  ];

  const relations: LogRelations = {
    event: ipc({
      event_id: textVector(eventIds),
      activity: textVector(activities),
      ts: arrow.vectorFromArray(timestamps, new arrow.TimestampMicrosecond()),  // see timestampMillis: values are ms
    }),
    object: ipc({
      object_id: textVector(objectIds),
      object_type: textVector(objectTypes),
    }),
    e2o: ipc({
      event_id: textVector(e2oEvent),
      object_id: textVector(e2oObject),
      qualifier: textVector(e2oQualifier),
    }),
    o2o: ipc({
      source_id: textVector(o2oSource),
      target_id: textVector(o2oTarget),
      qualifier: textVector(o2oQualifier),
    }),
  };
  if (eventAttrs.length) {
    relations.event_attr = ipc({
      event_id: textVector(eventAttrs.map((r) => r.owner)),
      name: textVector(eventAttrs.map((r) => r.name)),
      value: textVector(eventAttrs.map((r) => r.value)),
    });
  }
  if (objectAttrs.length) {
    // A static value carries a null `ts`; a timed one carries when it took
    // effect. Downstream code reads time-dependence off exactly that — an
    // object with several `ts` for one attribute has a value history — so no
    // separate flag is written, and none is needed.
    relations.object_attr = ipc({
      object_id: textVector(objectAttrs.map((r) => r.owner)),
      name: textVector(objectAttrs.map((r) => r.name)),
      value: textVector(objectAttrs.map((r) => r.value)),
      ts: arrow.vectorFromArray(objectAttrs.map((r) => r.ts), new arrow.TimestampMicrosecond()), // see timestampMillis: values are ms
    });
  }

  return {
    relations,
    summary: {
      events: eventIds.length,
      objects: objectIds.length,
      e2o: e2oEvent.length,
      o2o: o2oSource.length,
      eventAttributes: eventAttrs.length,
      objectAttributes: objectAttrs.length,
      timedObjectAttributes: timed.length,
    },
  };
}

/**
 * The provenance of a log published *from* another log — what "Edit log"
 * produces.
 *
 * An edited log is a derived artifact, not a second root: the DAG should say
 * which log it came from, or the two sit side by side in the tree with nothing
 * relating them and no way to tell which was the original. The execution is
 * recorded like the other sandbox publish paths (`kind: 'core'`,
 * `plugin-view-bridge/1`) — the edit happened in a plugin frame, but the write
 * is the host's.
 *
 * `source` must be the artifact the publishing frame is bound to. The caller
 * passes that artifact, so a frame cannot claim to derive from a log it was
 * never handed.
 */
export function buildEditedLogExecution(input: {
  source: { id: string; type: string };
  claimedSource: unknown;
  outputId: string;
  provider: string;
  summary: AuthoredLogSummary;
}): ActionExecution {
  const claimed = String(input.claimedSource ?? '').trim();
  if (claimed !== input.source.id) {
    throw new Error('An edited log can only be derived from the artifact this view is bound to.');
  }
  if (input.source.type !== 'ObjectCentricEventLog') {
    throw new Error('Only an object-centric event log can be edited into a new one.');
  }
  return {
    id: `x_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    actionId: `${input.provider}.editLog`,
    actionVersion: '1',
    inputs: { source: [input.source.id] },
    outputs: [input.outputId],
    params: {},
    startedAt: new Date().toISOString(),
    durationMs: 0,
    runtime: { kind: 'core', version: 'plugin-view-bridge/1' },
  };
}

/** The attribute value types OCEL 2.0 declares (see `OCEL2Semantics`). */
const ATTRIBUTE_TYPES = ['string', 'integer', 'float', 'boolean', 'time'];

function declaredTypes(value: unknown, where: string): Array<{ name: string; attributes: Array<{ name: string; type: string }> }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${where} must be a list of declared types.`);
  const seen = new Set<string>();
  return value.map((entry: any, i) => {
    const name = requireText(entry?.name, `${where}[${i}]: name`);
    if (seen.has(name)) throw new Error(`${where}: “${name}” is declared twice.`);
    seen.add(name);
    const attributes = entry?.attributes === undefined ? [] : entry.attributes;
    if (!Array.isArray(attributes)) throw new Error(`${where} “${name}”: attributes must be a list.`);
    const attrNames = new Set<string>();
    return {
      name,
      attributes: attributes.map((attr: any, j: number) => {
        const attrName = requireText(attr?.name, `${where} “${name}”: attribute[${j}] name`);
        if (attrNames.has(attrName)) throw new Error(`${where} “${name}”: attribute “${attrName}” is declared twice.`);
        attrNames.add(attrName);
        const type = String(attr?.type ?? 'string');
        if (!ATTRIBUTE_TYPES.includes(type)) {
          throw new Error(`${where} “${name}”: attribute “${attrName}” has unknown type “${type}” (${ATTRIBUTE_TYPES.join(', ')}).`);
        }
        return { name: attrName, type };
      }),
    };
  });
}

/**
 * The declared-types block an authored log carries in `meta.semantics`, in
 * the same shape an OCEL 2.0 import produces (`OCEL2Semantics`).
 *
 * A plugin that has a schema states it — an editor that made the user declare
 * event and object types with typed attributes knows more than the rows do,
 * and that knowledge is exactly what `meta.semantics` is for. It is validated
 * like everything else crossing this boundary: an attribute whose declared
 * type is not one OCEL 2.0 has would otherwise sit in the catalog looking
 * authoritative. Absent a declaration, the types present in the rows are the
 * declaration — with no attribute types, since a grid cell's text says
 * nothing about whether it was meant as an integer.
 */
export function authoredSemantics(request: AuthoredLogRequest): unknown {
  const declared = request.semantics as any;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    return {
      eventTypes: declaredTypes(declared.eventTypes, 'semantics.eventTypes'),
      objectTypes: declaredTypes(declared.objectTypes, 'semantics.objectTypes'),
      sourceFormat: 'json',
    };
  }
  if (request.semantics !== undefined) throw new Error('semantics must be an object with eventTypes and objectTypes.');
  const objectTypes = [...new Set(request.objects.map((r) => String(r.object_type ?? '').trim()).filter(Boolean))];
  const eventTypes = [...new Set(request.events.map((r) => String(r.activity ?? '').trim()).filter(Boolean))];
  return {
    objectTypes: objectTypes.map((name) => ({ name, attributes: [] })),
    eventTypes: eventTypes.map((name) => ({ name, attributes: [] })),
    sourceFormat: 'json',
  };
}
