/**
 * Log capabilities.
 *
 * The artifact *type* says what a thing is; a capability says what is actually
 * in it. Those are different questions, and conflating them is a real defect:
 * `example-log.xes` has 15 096 events, every one with a timestamp and a
 * lifecycle value and **not one** with a resource. An organizational miner
 * declaring `inputs: [TraditionalEventLog]` is offered for that log today and
 * would return nothing — the action was applicable by type and useless in fact.
 *
 * This is also where the format-agnosticism has to end honestly. A plugin
 * should not ask "is this XES"; it should ask for the property it needs. A CSV
 * import with a resource column satisfies `event.resource` exactly as an XES
 * log with `org:resource` does, and a plugin that genuinely needs XES's own
 * declarations asks for `xes.semantics` rather than inspecting the file name.
 *
 * Capabilities are **observed, not declared**: they are computed from the data
 * at import and recomputed for a derived log, because a filter can remove the
 * last event that had a resource.
 */

export type Capability =
  // Traditional logs
  | 'event.timestamp'
  | 'event.lifecycle'
  | 'event.resource'
  | 'event.attributes'
  | 'case.attributes'
  | 'xes.semantics'
  | 'xes.classifiers'
  // Object-centric logs
  | 'objects'
  | 'e2o.qualifiers'
  | 'o2o'
  | 'object.attributes'
  | 'object.attributes.timeDependent'
  | 'ocel2.semantics';

export const CAPABILITY_LABEL: Record<Capability, string> = {
  'event.timestamp': 'event timestamps',
  'event.lifecycle': 'lifecycle values',
  'event.resource': 'a resource attribute',
  'event.attributes': 'event attributes',
  'case.attributes': 'case attributes',
  'xes.semantics': 'XES semantics',
  'xes.classifiers': 'declared XES classifiers',
  objects: 'objects',
  'e2o.qualifiers': 'qualified event-to-object relations',
  o2o: 'object-to-object relations',
  'object.attributes': 'object attributes',
  'object.attributes.timeDependent': 'time-dependent object attributes',
  'ocel2.semantics': 'OCEL 2.0 semantics',
};

/** Explains why an action cannot run, in the terms the user can act on. */
export function missingCapabilities(
  have: readonly string[] | undefined, need: readonly string[] | undefined
): string[] {
  if (!need?.length) return [];
  const has = new Set(have ?? []);
  return need.filter((c) => !has.has(c));
}

export function describeMissing(missing: readonly string[]): string {
  return missing
    .map((c) => CAPABILITY_LABEL[c as Capability] ?? c)
    .join(' and ');
}
