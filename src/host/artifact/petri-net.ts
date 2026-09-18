/**
 * The `AcceptingPetriNet` payload contract, as a boundary check.
 *
 * Same role `validateOcpn` plays for `ObjectCentricPetriNet` and
 * `validateProcessTree` for `ProcessTree`. The shape itself is
 * `AcceptingPetriNetResult` in `ingest/pnml.ts` — the type is deliberately not
 * imported here: this file exists to check data crossing a trust boundary, and
 * a structural check written against a compile-time type tends to drift into
 * assuming the type. Everything below is checked against the wire, not the
 * declaration.
 *
 * Indices, not ids: a place names its neighbours by transition *index*, so the
 * cheapest way for a forged or buggy payload to reach a viewer is an index
 * that is out of range. Every viewer then reads `labels[i]` of `undefined` and
 * renders something that looks like a model and is not one.
 */
export function validateAcceptingPetriNet(v: unknown): string | null {
  const p = v as {
    labels?: unknown; places?: unknown;
    place_to_transition?: unknown; transition_to_place?: unknown;
    initial_marking?: unknown; final_marking?: unknown;
  };
  if (!p || typeof p !== 'object') return 'not an object';
  if (!Array.isArray(p.labels)) return 'no labels';
  if (!Array.isArray(p.places)) return 'no places';

  const transitionCount = p.labels.length;
  const placeCount = p.places.length;

  for (const [i, label] of p.labels.entries()) {
    if (label !== null && typeof label !== 'string') return `labels[${i}] is neither a string nor null`;
  }

  const pair = (name: string, value: unknown, firstMax: number, secondMax: number): string | null => {
    if (!Array.isArray(value)) return `no ${name}`;
    for (const [i, entry] of value.entries()) {
      if (!Array.isArray(entry) || entry.length !== 2) return `${name}[${i}] is not a pair`;
      const [a, b] = entry as [unknown, unknown];
      if (!Number.isInteger(a) || (a as number) < 0 || (a as number) >= firstMax) return `${name}[${i}] has an out-of-range source`;
      if (!Number.isInteger(b) || (b as number) < 0 || (b as number) >= secondMax) return `${name}[${i}] has an out-of-range target`;
    }
    return null;
  };
  const arcs = pair('place_to_transition', p.place_to_transition, placeCount, transitionCount)
    ?? pair('transition_to_place', p.transition_to_place, transitionCount, placeCount);
  if (arcs) return arcs;

  const marking = (name: string, value: unknown): string | null => {
    if (!Array.isArray(value)) return `no ${name}`;
    for (const [i, x] of value.entries()) {
      if (!Number.isInteger(x) || (x as number) < 0 || (x as number) >= placeCount) return `${name}[${i}] is not a place index`;
    }
    return null;
  };
  const markings = marking('initial_marking', p.initial_marking) ?? marking('final_marking', p.final_marking);
  if (markings) return markings;

  for (const [i, place] of (p.places as unknown[]).entries()) {
    const pl = place as { id?: unknown; inputs?: unknown; outputs?: unknown };
    if (!pl || typeof pl !== 'object') return `places[${i}] is not an object`;
    if (typeof pl.id !== 'string' || !pl.id) return `places[${i}] has no id`;
    for (const key of ['inputs', 'outputs'] as const) {
      if (!Array.isArray(pl[key])) return `places[${i}].${key} is not an array`;
      for (const t of pl[key] as unknown[]) {
        if (!Number.isInteger(t) || (t as number) < 0 || (t as number) >= transitionCount) {
          return `places[${i}].${key} names a transition that does not exist`;
        }
      }
    }
  }

  const ids = new Set((p.places as Array<{ id: string }>).map((pl) => pl.id));
  if (ids.size !== placeCount) return 'two places share an id';
  return null;
}
