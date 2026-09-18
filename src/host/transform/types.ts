/**
 * Log transformations.
 *
 * Editing and filtering are the same thing structurally — both derive a new
 * log from an existing one — and both are declarative: an operation says
 * *what* changes, never which rows were touched by hand. That is what makes
 * a transformed log reproducible, re-parameterisable and comparable with its
 * source, and it is why nothing here mutates the original.
 *
 * The whole ordered list is one action producing one artifact. Splitting it
 * into one action per operation would put a node in the tree for every
 * keystroke of cleaning work; the list is the unit the user thinks in.
 *
 * Order is significant and stays explicit: renaming an activity and then
 * filtering on the new name is not the same plan as filtering first.
 */

/**
 * Which long-format value column a repair operation rewrites.
 *
 * The relational layer stores attributes long-format with a `value` column of
 * text, so one implementation covers event, object and case attributes; the
 * only difference is the table and the name of its key column (`key` on a
 * traditional log, `name` on OCEL). `qualifier` is the E2O/O2O column, which
 * has the same shape and the same class of defects.
 */
export type ValueScope = 'eventAttribute' | 'objectAttribute' | 'caseAttribute' | 'qualifier';

/** One pattern → new-type rule for `splitObjectType`, tried in array order. */
export interface ObjectSplitRule {
  mode: 'contains' | 'equals' | 'regex';
  value: string;
  target: string;
}

/** One source → target → qualifier relation with its own optional count range. */
export interface RelationCountCondition {
  /** Event activity for E2O; source object type for O2O. */
  sourceType: string;
  /** Related object type. */
  targetType: string;
  /** Empty string represents an unqualified relation. */
  qualifier: string;
  min?: number;
  max?: number;
}

export type TransformOp = { /** Inactive operations stay in the plan but are not compiled. */ disabled?: boolean } & (
  | {
      kind: 'renameActivity';
      /** New operations require a new target label; see mergeActivities. */
      from: string;
      to: string;
      /** Older saved transforms used rename as merge; retain that behavior. */
      allowMerge?: boolean;
    }
  | {
      /** OCEL only: rename to a new object-type label. */
      kind: 'renameObjectType';
      from: string;
      to: string;
      allowMerge?: boolean;
    }
  | {
      /** Relabels selected activities into one existing/new activity label. */
      kind: 'mergeActivities';
      sources: string[];
      target: string;
    }
  | {
      /**
       * OCEL only: splits objects of one type into several, by matching a
       * per-object field against ordered rules. The first matching rule
       * wins; an object matching none keeps `source`.
       *
       * Attributes and relationships need no rewriting at all: both
       * `object_attr` and `e2o`/`o2o` are keyed by `object_id`, never
       * `object_type` — exactly the property `renameObjectType` already
       * relies on to leave them untouched.
       */
      kind: 'splitObjectType';
      source: string;
      /** '' matches the object's own id; any other value is an attribute name. */
      field: string;
      rules: ObjectSplitRule[];
    }
  | {
      /** OCEL only: relabels selected object types into one target label. */
      kind: 'mergeObjectTypes';
      sources: string[];
      target: string;
    }
  | {
      kind: 'filterEvents';
      column: 'activity' | 'lifecycle' | 'resource';
      op: 'is' | 'isNot' | 'contains';
      value: string;
    }
  | {
      /** Select multiple activities, optionally limited by relative frequency. */
      kind: 'filterActivities';
      values: string[];
      mode: 'include' | 'exclude';
      /** Percentage of the most frequent activity, 0–100. */
      minFrequency: number;
      maxFrequency: number;
    }
  | {
      /** OCEL only: retain a set of object types and their reachable events. */
      kind: 'filterObjectTypes';
      values: string[];
      mode: 'include' | 'exclude';
      minFrequency: number;
      maxFrequency: number;
    }
  | {
      /** Event attribute predicate; XES event attributes use the same shape. */
      kind: 'filterEventAttribute';
      key: string;
      mode: 'has' | 'equals' | 'contains' | 'numberRange';
      value: string;
      min?: number;
      max?: number;
    }
  | {
      /** Object attribute predicate; on XES this means a case attribute. */
      kind: 'filterObjectAttribute';
      key: string;
      mode: 'has' | 'equals' | 'contains' | 'numberRange';
      value: string;
      min?: number;
      max?: number;
    }
  | {
      /** OCEL only: retain events by per event-type/object-type E2O counts. */
      kind: 'filterE2oCount';
      conditions?: RelationCountCondition[];
      /** Legacy global count, kept so older saved transformations still run. */
      min?: number;
      max?: number;
    }
  | {
      /** OCEL only: retain objects by per type/direction/qualifier O2O counts. */
      kind: 'filterO2oCount';
      conditions?: RelationCountCondition[];
      /** Legacy total count, kept so older saved transformations still run. */
      min?: number;
      max?: number;
    }
  | {
      kind: 'timeRange';
      /** ISO date or datetime strings (DuckDB parses either); either bound may be omitted. */
      from?: string;
      to?: string;
    }
  | {
      kind: 'filterCases';
      /** Keeps or drops whole cases by what they contain. */
      mode: 'contains' | 'notContains';
      activity: string;
    }
  | {
      kind: 'variantMinCases';
      /** Drops cases whose activity sequence occurs in fewer than N cases. */
      minCases: number;
    }
  | {
      kind: 'removeAttribute';
      /** Legacy free-form edit, retained for older saved transforms. */
      scope: 'event' | 'trace';
      key: string;
    }
  | {
      /** Remove a selected set of attributes only from one event activity. */
      kind: 'removeEventAttributes';
      activity: string;
      keys: string[];
    }
  | {
      /** OCEL only: remove selected attributes only from one object type. */
      kind: 'removeObjectAttributes';
      objectType: string;
      keys: string[];
    }
  | {
      /** Traditional logs: remove a selected set of case attributes. */
      kind: 'removeCaseAttributes';
      keys: string[];
    }
  | {
      /**
       * Asserts an order on events that share a timestamp.
       *
       * This is the one operation here that does not repair data — it *adds*
       * an assertion the source did not make. Ties usually come from an
       * extraction that rounded away sub-second precision, so the true order
       * is unknown; downstream tooling nonetheless needs distinct timestamps
       * and will otherwise pick an order silently. Making the choice explicit,
       * ordered and revocable is the honest version of what analysts already
       * do by hand.
       *
       * Each tied group is spread across the interval to the *next distinct*
       * timestamp rather than stepped by a fixed amount, so a repair can never
       * push an event past a real one. A naive `+1ms` per tie does exactly
       * that whenever two genuine events sit less than a group's width apart,
       * which storage represents perfectly well: `ts` is a DuckDB `TIMESTAMP`
       * and ingest preserves the source's microseconds
       * (`ingest/lib/timestamp.ts`). Dividing the gap that is actually there
       * needs no assumption about the grid the source used.
       */
      kind: 'disambiguateEventOrder';
      /**
       * What decides the order within a tied group.
       *
       * `identifier` is the recorded sequence: `event_idx` on a traditional
       * log is ingest's file order, which is what "in order of appearance"
       * means. On OCEL there is no such column, so it is `event_id` ordered
       * naturally (embedded digits numerically), which is a weaker proxy.
       */
      tieBreak: 'identifier' | 'lifecycle' | 'attribute';
      /** Attribute whose value orders the group, when `tieBreak` is `attribute`. */
      attribute?: string;
      /** Largest step between two tied events, in microseconds. 1000 = 1ms. */
      stepMicroseconds: number;
    }
  | {
      /**
       * Timestamps outside a plausible range are either dropped with their
       * event or cleared to NULL. Clearing keeps the event's position in the
       * control flow while removing it from every duration; dropping removes
       * it entirely. Neither is more correct in general, which is why it asks.
       */
      kind: 'dropImplausibleTimestamps';
      mode: 'drop' | 'clear';
      minYear: number;
      maxYear: number;
    }
  | {
      /** Restores set semantics to the relation tables: identical tuples collapse. */
      kind: 'deduplicateRelations';
      /** OCEL only. Both relations by default. */
      scope: 'e2o' | 'o2o' | 'both';
    }
  | {
      /** OCEL only: drops O2O rows whose source and target are the same object. */
      kind: 'dropSelfRelations';
    }
  | {
      /**
       * OCEL only: drops relation rows referencing an event or object that
       * does not exist. This deletes the evidence of a broken extract, which
       * is why it is never applied automatically — but a log with dangling
       * references cannot be reasoned about at all.
       */
      kind: 'dropDanglingRelations';
    }
  | {
      /** OCEL only: drops objects no event ever references. */
      kind: 'dropOrphanObjects';
    }
  | {
      /** OCEL only: drops events with no object relationship at all. */
      kind: 'dropEventsWithoutObjects';
    }
  | {
      /** Traditional logs: drops cases that contain no events. */
      kind: 'dropEmptyCases';
    }
  | {
      /**
       * Collapses values that differ only in case or surrounding whitespace
       * onto the most frequent spelling in their group.
       *
       * Ties on frequency break lexicographically so the result does not
       * depend on row order — a transform must compile to the same log twice.
       */
      kind: 'canonicaliseValues';
      scope: ValueScope;
      /** Attribute names to canonicalise. Ignored — and not required — for `qualifier`. */
      names: string[];
    }
  | {
      /** Rewrites placeholder values ("N/A", "unknown", "-") to NULL. */
      kind: 'mapSentinelValues';
      scope: ValueScope;
      names: string[];
      /** Matched case-insensitively after trimming. */
      values: string[];
    }
  | {
      /**
       * Removes named attributes across a whole scope.
       *
       * `removeEventAttributes` and `removeObjectAttributes` remove an
       * attribute only from one activity or object type, which is the right
       * tool for a targeted edit and the wrong one for "this attribute is
       * empty everywhere". `removeAttribute` is the legacy single-key form and
       * cannot reach object attributes at all.
       */
      kind: 'removeAttributes';
      scope: Exclude<ValueScope, 'qualifier'>;
      names: string[];
    }
  | {
      /**
       * Replaces potentially personal values with a stable salted digest, or
       * removes the attribute outright. The digest is stable within the log
       * (so joins and distinct counts survive) and not reversible without the
       * salt, which is part of the plan and therefore visible and portable.
       */
      kind: 'pseudonymiseAttributes';
      scope: Exclude<ValueScope, 'qualifier'>;
      names: string[];
      mode: 'hash' | 'remove';
      salt: string;
    }
  | {
      /**
       * Object-centric → case-centric. Only valid as the first operation, and
       * only on an OCEL source: it does not filter a log, it changes what kind
       * of log this is.
       *
       * Each object of the chosen type becomes a case; the events related to it
       * become that case's events. This is the standard bridge, and it is lossy
       * in two well-known ways that the editor reports rather than hides:
       * an event related to several objects of the type is **duplicated**
       * (convergence), and an event related to none is **dropped**
       * (divergence).
       */
      kind: 'flattenByObjectType';
      objectType: string;
    });

export type TransformOpKind = TransformOp['kind'];

export interface TransformPlan {
  /** The log this plan reads from. Never modified. */
  source: string;
  ops: TransformOp[];
}

export const OP_LABEL: Record<TransformOpKind, string> = {
  flattenByObjectType: 'Flatten by object type',
  renameActivity: 'Rename activity',
  renameObjectType: 'Rename object type',
  mergeActivities: 'Merge activities',
  mergeObjectTypes: 'Merge object types',
  splitObjectType: 'Split object type',
  filterEvents: 'Filter events',
  filterActivities: 'Filter activities',
  filterObjectTypes: 'Filter object types',
  filterEventAttribute: 'Filter event attribute',
  filterObjectAttribute: 'Filter object / case attribute',
  filterE2oCount: 'Filter by E2O count',
  filterO2oCount: 'Filter by O2O count',
  timeRange: 'Time range',
  filterCases: 'Filter cases',
  variantMinCases: 'Filter by variant frequency',
  removeAttribute: 'Remove attribute',
  removeEventAttributes: 'Edit event attributes',
  removeObjectAttributes: 'Edit object attributes',
  removeCaseAttributes: 'Edit case attributes',
  removeAttributes: 'Remove attributes',
  disambiguateEventOrder: 'Disambiguate tied timestamps',
  dropImplausibleTimestamps: 'Repair implausible timestamps',
  deduplicateRelations: 'Deduplicate relations',
  dropSelfRelations: 'Drop self-referencing relations',
  dropDanglingRelations: 'Drop dangling relations',
  dropOrphanObjects: 'Drop objects without events',
  dropEventsWithoutObjects: 'Drop events without objects',
  dropEmptyCases: 'Drop empty cases',
  canonicaliseValues: 'Canonicalise values',
  mapSentinelValues: 'Clear sentinel values',
  pseudonymiseAttributes: 'Pseudonymise attributes',
};

/** Which of the two mental purposes an operation serves. Grouping only. */
export const OP_GROUP: Record<TransformOpKind, 'Edit' | 'Filter' | 'Structure' | 'Repair'> = {
  flattenByObjectType: 'Structure',
  renameActivity: 'Edit',
  renameObjectType: 'Edit',
  mergeActivities: 'Edit',
  mergeObjectTypes: 'Edit',
  splitObjectType: 'Edit',
  removeAttribute: 'Edit',
  removeEventAttributes: 'Edit',
  removeObjectAttributes: 'Edit',
  removeCaseAttributes: 'Edit',
  filterEvents: 'Filter',
  filterActivities: 'Filter',
  filterObjectTypes: 'Filter',
  filterEventAttribute: 'Filter',
  filterObjectAttribute: 'Filter',
  filterE2oCount: 'Filter',
  filterO2oCount: 'Filter',
  timeRange: 'Filter',
  filterCases: 'Filter',
  variantMinCases: 'Filter',
  removeAttributes: 'Repair',
  disambiguateEventOrder: 'Repair',
  dropImplausibleTimestamps: 'Repair',
  deduplicateRelations: 'Repair',
  dropSelfRelations: 'Repair',
  dropDanglingRelations: 'Repair',
  dropOrphanObjects: 'Repair',
  dropEventsWithoutObjects: 'Repair',
  dropEmptyCases: 'Repair',
  canonicaliseValues: 'Repair',
  mapSentinelValues: 'Repair',
  pseudonymiseAttributes: 'Repair',
};

/**
 * The placeholder values `mapSentinelValues` clears by default.
 *
 * Deliberately the same list the Log Quality plugin's `ATTR-SENTINEL-VALUES`
 * check detects, so the fix it proposes covers exactly what it reported.
 * Matched case-insensitively after trimming, and editable per operation —
 * "unknown" is a real answer in some domains.
 */
export const DEFAULT_SENTINELS = ['n/a', 'na', 'null', 'none', 'unknown', '-', '?', '9999', '99999'];

export const SCOPE_LABEL: Record<ValueScope, string> = {
  eventAttribute: 'event attributes',
  objectAttribute: 'object attributes',
  caseAttribute: 'case attributes',
  qualifier: 'relation qualifiers',
};

/**
 * Where a repair belongs in the pipeline, low to high.
 *
 * Repairs interact, and click order is not execution order. Canonicalising
 * spellings before deduplicating is what makes the duplicates visible;
 * clearing sentinels before removing always-empty attributes is what makes
 * them empty; dropping dangling relations before orphan objects is what makes
 * the orphans appear. And the timestamp assertion has to run after every
 * filter, because "in order of appearance" is a statement about the events
 * that actually survived.
 *
 * `insertOpOrdered` uses this to place a proposed repair. Hand-built plans are
 * never reordered — the editor's ↑/↓ stay authoritative for anything the user
 * arranged themselves.
 */
export const OP_PHASE: Record<TransformOpKind, number> = {
  flattenByObjectType: 0,
  canonicaliseValues: 1,
  mapSentinelValues: 1,
  renameActivity: 2,
  renameObjectType: 2,
  mergeActivities: 2,
  mergeObjectTypes: 2,
  splitObjectType: 2,
  deduplicateRelations: 3,
  dropDanglingRelations: 4,
  dropSelfRelations: 4,
  dropOrphanObjects: 5,
  dropEventsWithoutObjects: 5,
  dropEmptyCases: 5,
  pseudonymiseAttributes: 6,
  removeAttributes: 6,
  removeAttribute: 6,
  removeEventAttributes: 6,
  removeObjectAttributes: 6,
  removeCaseAttributes: 6,
  filterEvents: 7,
  filterActivities: 7,
  filterObjectTypes: 7,
  filterEventAttribute: 7,
  filterObjectAttribute: 7,
  filterE2oCount: 7,
  filterO2oCount: 7,
  timeRange: 7,
  filterCases: 7,
  variantMinCases: 7,
  dropImplausibleTimestamps: 8,
  disambiguateEventOrder: 9,
};

/**
 * Inserts a proposed repair at its phase position, after every operation of an
 * earlier or equal phase. Equal phases keep insertion order, so two repairs
 * proposed in the order the report lists them stay in that order.
 */
export function insertOpOrdered(ops: TransformOp[], op: TransformOp): TransformOp[] {
  const phase = OP_PHASE[op.kind];
  let at = ops.length;
  for (let i = 0; i < ops.length; i++) {
    if (OP_PHASE[ops[i].kind] > phase) { at = i; break; }
  }
  return [...ops.slice(0, at), op, ...ops.slice(at)];
}

export function newOp(kind: TransformOpKind): TransformOp {
  switch (kind) {
    case 'renameActivity': return { kind, from: '', to: '', allowMerge: false };
    case 'renameObjectType': return { kind, from: '', to: '', allowMerge: false };
    case 'mergeActivities': return { kind, sources: [], target: '' };
    case 'mergeObjectTypes': return { kind, sources: [], target: '' };
    case 'splitObjectType': return { kind, source: '', field: '', rules: [] };
    case 'filterEvents': return { kind, column: 'activity', op: 'is', value: '' };
    case 'filterActivities': return { kind, values: [], mode: 'include', minFrequency: 0, maxFrequency: 100 };
    case 'filterObjectTypes': return { kind, values: [], mode: 'include', minFrequency: 0, maxFrequency: 100 };
    case 'filterEventAttribute': return { kind, key: '', mode: 'has', value: '' };
    case 'filterObjectAttribute': return { kind, key: '', mode: 'has', value: '' };
    case 'filterE2oCount': return { kind };
    case 'filterO2oCount': return { kind };
    case 'timeRange': return { kind };
    case 'filterCases': return { kind, mode: 'contains', activity: '' };
    case 'variantMinCases': return { kind, minCases: 2 };
    case 'removeAttribute': return { kind, scope: 'event', key: '' };
    case 'removeEventAttributes': return { kind, activity: '', keys: [] };
    case 'removeObjectAttributes': return { kind, objectType: '', keys: [] };
    case 'removeCaseAttributes': return { kind, keys: [] };
    case 'flattenByObjectType': return { kind, objectType: '' };
    case 'disambiguateEventOrder': return { kind, tieBreak: 'identifier', stepMicroseconds: 1000 };
    case 'dropImplausibleTimestamps': return { kind, mode: 'clear', minYear: 1972, maxYear: 2099 };
    case 'deduplicateRelations': return { kind, scope: 'both' };
    case 'dropSelfRelations': return { kind };
    case 'dropDanglingRelations': return { kind };
    case 'dropOrphanObjects': return { kind };
    case 'dropEventsWithoutObjects': return { kind };
    case 'dropEmptyCases': return { kind };
    case 'canonicaliseValues': return { kind, scope: 'eventAttribute', names: [] };
    case 'mapSentinelValues': return { kind, scope: 'eventAttribute', names: [], values: [...DEFAULT_SENTINELS] };
    case 'pseudonymiseAttributes': return { kind, scope: 'eventAttribute', names: [], mode: 'hash', salt: 'promenade' };
    case 'removeAttributes': return { kind, scope: 'eventAttribute', names: [] };
  }
}

/** One-line summary for the operation list and the artifact subtitle. */
export function describeOp(op: TransformOp): string {
  switch (op.kind) {
    case 'renameActivity':
      return `“${op.from || '…'}” → “${op.to || '…'}”`;
    case 'renameObjectType':
      return `“${op.from || '…'}” → “${op.to || '…'}”`;
    case 'mergeActivities':
    case 'mergeObjectTypes':
      return `${op.sources.length} label${op.sources.length === 1 ? '' : 's'} → “${op.target || '…'}”`;
    case 'splitObjectType': {
      const n = op.rules.filter((r) => r.value && r.target).length;
      return `“${op.source || '…'}” → ${n} rule${n === 1 ? '' : 's'}`;
    }
    case 'filterEvents':
      return `${op.column} ${op.op === 'is' ? '=' : op.op === 'isNot' ? '≠' : '⊃'} “${op.value}”`;
    case 'filterActivities':
      return `${op.mode} ${op.values.length ? op.values.length + ' selected' : `${op.minFrequency}–${op.maxFrequency}% frequency`}`;
    case 'filterObjectTypes':
      return `${op.mode} ${op.values.length ? op.values.length + ' selected' : `${op.minFrequency}–${op.maxFrequency}% frequency`}`;
    case 'filterEventAttribute':
    case 'filterObjectAttribute':
      return `${op.key || '…'} · ${op.mode === 'numberRange' ? `${op.min ?? '…'}–${op.max ?? '…'}` : op.mode}`;
    case 'filterE2oCount':
    case 'filterO2oCount':
      return op.conditions?.length
        ? `${op.conditions.length} relation${op.conditions.length === 1 ? '' : 's'} constrained`
        : `${op.min ?? 0}–${op.max ?? '∞'} relationships`;
    case 'timeRange':
      return [op.from ? op.from.replace('T', ' ') : '…', op.to ? op.to.replace('T', ' ') : '…'].join(' → ');
    case 'filterCases':
      return `${op.mode === 'contains' ? 'contains' : 'does not contain'} “${op.activity}”`;
    case 'variantMinCases':
      return `variant occurs in ≥ ${op.minCases} cases`;
    case 'removeAttribute':
      return `${op.scope}.${op.key || '…'}`;
    case 'removeEventAttributes':
      return `${op.activity || '…'} · ${op.keys.length} attribute${op.keys.length === 1 ? '' : 's'} removed`;
    case 'removeObjectAttributes':
      return `${op.objectType || '…'} · ${op.keys.length} attribute${op.keys.length === 1 ? '' : 's'} removed`;
    case 'removeCaseAttributes':
      return `${op.keys.length} case attribute${op.keys.length === 1 ? '' : 's'} removed`;
    case 'flattenByObjectType':
      return `one case per “${op.objectType || '…'}”`;
    case 'disambiguateEventOrder': {
      const by = op.tieBreak === 'attribute' ? `“${op.attribute || '…'}”` : op.tieBreak;
      return `assert order by ${by}, ≤ ${op.stepMicroseconds} µs apart`;
    }
    case 'dropImplausibleTimestamps':
      return `${op.mode === 'drop' ? 'drop event' : 'clear timestamp'} outside ${op.minYear}–${op.maxYear}`;
    case 'deduplicateRelations':
      return op.scope === 'both' ? 'E2O and O2O' : op.scope.toUpperCase();
    case 'dropSelfRelations': return 'O2O source = target';
    case 'dropDanglingRelations': return 'unknown event or object references';
    case 'dropOrphanObjects': return 'objects with no event';
    case 'dropEventsWithoutObjects': return 'events with no object';
    case 'dropEmptyCases': return 'cases with no events';
    case 'canonicaliseValues':
      return op.scope === 'qualifier'
        ? 'all relation qualifiers'
        : `${SCOPE_LABEL[op.scope]} · ${op.names.length} selected`;
    case 'mapSentinelValues':
      return `${SCOPE_LABEL[op.scope]} · ${op.values.length} placeholder${op.values.length === 1 ? '' : 's'} → NULL`;
    case 'pseudonymiseAttributes':
      return `${SCOPE_LABEL[op.scope]} · ${op.names.length} ${op.mode === 'hash' ? 'hashed' : 'removed'}`;
    case 'removeAttributes':
      return `${SCOPE_LABEL[op.scope]} · ${op.names.length} removed`;
  }
}

/**
 * An operation with an empty required field is skipped rather than applied.
 *
 * A half-typed rename would otherwise silently rewrite every event whose
 * activity equals the empty string — and while an operation is being filled
 * in, that state is the norm, not the exception.
 */
export function isComplete(op: TransformOp): boolean {
  switch (op.kind) {
    case 'renameActivity': return !!op.from && !!op.to;
    case 'renameObjectType': return !!op.from && !!op.to;
    case 'mergeActivities': return op.sources.length > 0 && !!op.target;
    case 'mergeObjectTypes': return op.sources.length > 0 && !!op.target;
    case 'splitObjectType': return !!op.source && op.rules.some((r) => !!r.value && !!r.target);
    case 'filterEvents': return op.value.length > 0;
    case 'filterActivities': return op.values.length > 0 || op.minFrequency > 0 || op.maxFrequency < 100;
    case 'filterObjectTypes': return op.values.length > 0 || op.minFrequency > 0 || op.maxFrequency < 100;
    case 'filterEventAttribute':
    case 'filterObjectAttribute':
      return !!op.key && (op.mode === 'has' || op.mode === 'numberRange'
        ? op.min != null || op.max != null || op.mode === 'has'
        : !!op.value);
    case 'filterE2oCount': return !!op.conditions?.some((c) => c.min != null || c.max != null) || op.min != null || op.max != null;
    case 'filterO2oCount': return !!op.conditions?.some((c) => c.min != null || c.max != null) || op.min != null || op.max != null;
    case 'timeRange': return !!(op.from || op.to);
    case 'filterCases': return !!op.activity;
    case 'variantMinCases': return op.minCases > 1;
    case 'removeAttribute': return !!op.key;
    case 'removeEventAttributes': return !!op.activity && op.keys.length > 0;
    case 'removeObjectAttributes': return !!op.objectType && op.keys.length > 0;
    case 'removeCaseAttributes': return op.keys.length > 0;
    case 'flattenByObjectType': return !!op.objectType;
    case 'disambiguateEventOrder':
      return op.stepMicroseconds > 0 && (op.tieBreak !== 'attribute' || !!op.attribute);
    case 'dropImplausibleTimestamps': return op.minYear <= op.maxYear;
    // These take no parameters at all: adding one *is* filling it in.
    case 'deduplicateRelations':
    case 'dropSelfRelations':
    case 'dropDanglingRelations':
    case 'dropOrphanObjects':
    case 'dropEventsWithoutObjects':
    case 'dropEmptyCases':
      return true;
    case 'canonicaliseValues': return op.scope === 'qualifier' || op.names.length > 0;
    case 'mapSentinelValues': return op.names.length > 0 && op.values.length > 0;
    case 'pseudonymiseAttributes': return op.names.length > 0;
    case 'removeAttributes': return op.names.length > 0;
  }
}
