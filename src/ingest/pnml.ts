/**
 * PNML (ISO/IEC 15909-2) import/export for `AcceptingPetriNet`.
 *
 * A PNML file is small — a few KB even for a large discovered net — so this
 * runs on the main thread with the browser's own `DOMParser`, unlike XES/OCEL
 * import: those are streamed through a worker because a real log is
 * megabytes of events, not because parsing structured XML needs one.
 *
 * Scope, stated rather than silently approximated:
 *  - A transition counts as silent (no `activityId`) when it has no
 *    `<name>`, or carries a ProM-style `<toolspecific><visible>false`
 *    marker — the two conventions actually seen in the wild.
 *  - Final marking: an explicit `<finalmarkings>` block (ProM's own export
 *    extension) is used if present; otherwise every sink place (no outgoing
 *    arc) is treated as final, which is exactly right for a workflow net
 *    with one explicit end place and only an approximation for anything
 *    stranger.
 */

import type { OcpnPayload } from '../host/artifact/ocpn';
export interface ParsedPnml {
  places: Array<{ id: string; name: string }>;
  transitions: Array<{ id: string; name: string | null }>;
  arcs: Array<{ source: string; target: string }>;
  /** Place ids. */
  initialMarking: string[];
  finalMarking: string[];
}

export function parsePnml(xml: string): ParsedPnml {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('not well-formed XML');
  }
  const net = doc.querySelector('net');
  if (!net) throw new Error('no <net> element — not a PNML file');

  const textOf = (el: Element): string | null => {
    const t = el.querySelector(':scope > name > text') ?? el.querySelector(':scope > text');
    const s = t?.textContent?.trim();
    return s ? s : null;
  };

  const places: Array<{ id: string; name: string }> = [];
  const initialMarking: string[] = [];
  for (const p of Array.from(net.querySelectorAll('place'))) {
    const id = p.getAttribute('id');
    if (!id) continue;
    places.push({ id, name: textOf(p) ?? id });
    const im = p.querySelector(':scope > initialMarking > text');
    if (im && Number(im.textContent) > 0) initialMarking.push(id);
  }

  const transitions: Array<{ id: string; name: string | null }> = [];
  for (const t of Array.from(net.querySelectorAll('transition'))) {
    const id = t.getAttribute('id');
    if (!id) continue;
    const toolspec = t.querySelector('toolspecific');
    const invisible = toolspec?.querySelector('visible')?.textContent?.trim() === 'false'
      || toolspec?.querySelector('invisible')?.textContent?.trim() === 'true';
    transitions.push({ id, name: invisible ? null : textOf(t) });
  }

  const arcs: Array<{ source: string; target: string }> = [];
  for (const a of Array.from(net.querySelectorAll('arc'))) {
    const source = a.getAttribute('source');
    const target = a.getAttribute('target');
    if (source && target) arcs.push({ source, target });
  }

  if (places.length === 0) throw new Error('no places found');
  if (transitions.length === 0) throw new Error('no transitions found');

  let finalMarking: string[] = [];
  const fmPlaces = net.querySelectorAll('finalmarkings marking place');
  if (fmPlaces.length > 0) {
    finalMarking = Array.from(fmPlaces)
      .map((p) => p.getAttribute('idref'))
      .filter((x): x is string => !!x);
  } else {
    const hasOutgoing = new Set(arcs.map((a) => a.source));
    finalMarking = places.filter((p) => !hasOutgoing.has(p.id)).map((p) => p.id);
  }

  return { places, transitions, arcs, initialMarking, finalMarking };
}

/** The Inductive-Miner-shaped `AcceptingPetriNet` result — see PetriNetView
 *  and `buildAlignModel` for the two shapes this codebase has to read. */
export interface AcceptingPetriNetResult {
  activities: number[];
  labels: Array<string | null>;
  places: Array<{ id: string; inputs: number[]; outputs: number[]; kind: 'initial' | 'final' | 'derived' }>;
  place_to_transition: Array<[number, number]>;
  transition_to_place: Array<[number, number]>;
  initial_marking: number[];
  final_marking: number[];
  start_activities: number[];
  end_activities: number[];
  stats: { places: number; transitions: number; arcs: number; silent_transitions: number };
}

/** `names[i]` is what every view already expects for transition `i` —
 *  `net.labels[i]`, with a silent transition standing for itself. */
export function toAcceptingPetriNet(p: ParsedPnml): { net: AcceptingPetriNetResult; names: string[] } {
  const placeIndex = new Map(p.places.map((pl, i) => [pl.id, i]));
  const transIndex = new Map(p.transitions.map((t, i) => [t.id, i]));

  const placeToTransition: Array<[number, number]> = [];
  const transitionToPlace: Array<[number, number]> = [];
  const placeInputs: number[][] = p.places.map(() => []);
  const placeOutputs: number[][] = p.places.map(() => []);

  for (const arc of p.arcs) {
    const fromPlace = placeIndex.get(arc.source);
    const toTrans = transIndex.get(arc.target);
    if (fromPlace != null && toTrans != null) {
      placeToTransition.push([fromPlace, toTrans]);
      placeOutputs[fromPlace].push(toTrans);
      continue;
    }
    const fromTrans = transIndex.get(arc.source);
    const toPlace = placeIndex.get(arc.target);
    if (fromTrans != null && toPlace != null) {
      transitionToPlace.push([fromTrans, toPlace]);
      placeInputs[toPlace].push(fromTrans);
    }
  }

  const initialSet = new Set(p.initialMarking);
  const finalSet = new Set(p.finalMarking);
  const places = p.places.map((pl, i) => ({
    id: pl.id,
    inputs: placeInputs[i],
    outputs: placeOutputs[i],
    kind: (initialSet.has(pl.id) ? 'initial' : finalSet.has(pl.id) ? 'final' : 'derived') as
      'initial' | 'final' | 'derived',
  }));

  const labels = p.transitions.map((t) => t.name);
  const names = labels.map((l) => l ?? 'τ');

  const net: AcceptingPetriNetResult = {
    activities: p.transitions.map((_, i) => i),
    labels,
    places,
    place_to_transition: placeToTransition,
    transition_to_place: transitionToPlace,
    initial_marking: p.initialMarking.map((id) => placeIndex.get(id)!),
    final_marking: p.finalMarking.map((id) => placeIndex.get(id)!),
    start_activities: [],
    end_activities: [],
    stats: {
      places: p.places.length,
      transitions: p.transitions.length,
      arcs: p.arcs.length,
      silent_transitions: labels.filter((l) => l == null).length,
    },
  };
  return { net, names };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

interface Normalized {
  placeCount: number;
  placeIds: string[];
  transitionLabels: Array<string | null>;
  placeToTransition: Array<[number, number]>;
  transitionToPlace: Array<[number, number]>;
  initialMarking: number[];
  finalMarking: number[];
}

/** Reads either of this codebase's two `AcceptingPetriNet` shapes — see
 *  `host/actions/alignmentModel.ts`'s `buildAlignModel` for the same split. */
function normalize(net: any, names: string[]): Normalized {
  const placeIds: string[] = (net.places ?? []).map((p: any, i: number) => p.id ?? `p${i}`);
  if (Array.isArray(net.labels)) {
    return {
      placeCount: net.places?.length ?? 0,
      placeIds,
      transitionLabels: net.labels,
      placeToTransition: net.place_to_transition ?? [],
      transitionToPlace: net.transition_to_place ?? [],
      initialMarking: net.initial_marking ?? [],
      finalMarking: net.final_marking ?? [],
    };
  }
  // Alpha Miner shape: the activity id doubles as the transition id, and the
  // arc lists reference it directly rather than a compacted position.
  const acts: number[] = net.activities ?? [];
  const transitionIndexOf = new Map<number, number>();
  acts.forEach((a, i) => transitionIndexOf.set(a, i));
  return {
    placeCount: net.places?.length ?? 0,
    placeIds,
    transitionLabels: acts.map((a) => names[a] ?? `t${a}`),
    placeToTransition: (net.place_to_transition ?? [])
      .map(([p, t]: [number, number]): [number, number] => [p, transitionIndexOf.get(t) ?? -1])
      .filter(([, t]: [number, number]) => t >= 0),
    transitionToPlace: (net.transition_to_place ?? [])
      .map(([t, p]: [number, number]): [number, number] => [transitionIndexOf.get(t) ?? -1, p])
      .filter(([t]: [number, number]) => t >= 0),
    initialMarking: net.initial_marking ?? [],
    finalMarking: net.final_marking ?? [],
  };
}

/** Serialises an `AcceptingPetriNet` result (either shape) to PNML text. */
export function toPnml(net: any, names: string[], netName: string): string {
  const n = normalize(net, names);
  const placeId = (i: number) => n.placeIds[i] ?? `p${i}`;
  const transId = (i: number) => `t${i}`;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<pnml>',
    `  <net id="${xmlEscape(netName)}" type="http://www.pnml.org/version-2009/grammar/ptnet">`,
    '    <page id="page1">',
  ];

  const initialSet = new Set(n.initialMarking);
  for (let i = 0; i < n.placeCount; i++) {
    lines.push(`      <place id="${xmlEscape(placeId(i))}">`);
    lines.push(`        <name><text>${xmlEscape(placeId(i))}</text></name>`);
    if (initialSet.has(i)) lines.push('        <initialMarking><text>1</text></initialMarking>');
    lines.push('      </place>');
  }

  n.transitionLabels.forEach((label, i) => {
    lines.push(`      <transition id="${transId(i)}">`);
    if (label != null) {
      lines.push(`        <name><text>${xmlEscape(label)}</text></name>`);
    } else {
      lines.push('        <name><text>tau</text></name>');
      lines.push('        <toolspecific tool="Promenade" version="1.0"><visible>false</visible></toolspecific>');
    }
    lines.push('      </transition>');
  });

  let arcId = 0;
  for (const [p, t] of n.placeToTransition) {
    lines.push(`      <arc id="a${arcId++}" source="${xmlEscape(placeId(p))}" target="${transId(t)}"/>`);
  }
  for (const [t, p] of n.transitionToPlace) {
    lines.push(`      <arc id="a${arcId++}" source="${transId(t)}" target="${xmlEscape(placeId(p))}"/>`);
  }

  lines.push('    </page>');
  if (n.finalMarking.length > 0) {
    lines.push('    <finalmarkings>', '      <marking>');
    for (const p of n.finalMarking) {
      lines.push(`        <place idref="${xmlEscape(placeId(p))}"><text>1</text></place>`);
    }
    lines.push('      </marking>', '    </finalmarkings>');
  }
  lines.push('  </net>', '</pnml>');
  return lines.join('\n');
}

/**
 * Writes an `ObjectCentricPetriNet` as PNML.
 *
 * PNML has no object-centric grammar. Its standard P/T grammar is uncoloured —
 * a place is a place, with no notion of the object type whose lifecycle it
 * belongs to — and the high-level (symmetric net) grammar describes colour
 * *sorts* and inscriptions, which an OCPN discovered from a log does not have:
 * there are no colour-set definitions, no guards, no variable bindings, only
 * "this place, this arc and this transition belong to object type X".
 *
 * So this does what every other tool in this space does, including the OCPN
 * Studio export that prompted it: emit a **structurally valid P/T net** and
 * carry what the standard cannot say in a `<toolspecific>` block. The result
 * degrades in the right direction — a generic PNML reader opens the net,
 * draws every place, transition and arc, and simply does not see the object
 * types; a reader that knows the tool recovers all of it.
 *
 * Deliberately no `<graphics>` positions. An OCPN artifact carries no layout
 * (see `host/artifact/ocpn.ts` — layout is view state, recomputed at render
 * time), and inventing coordinates here would bake one viewer's arrangement
 * into an interchange file as though it were data.
 */
export function ocpnToPnml(payload: OcpnPayload, netName: string): string {
  const esc = xmlEscape;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<pnml xmlns="http://www.pnml.org/version-2009/grammar/pnml">',
    `  <net id="${esc(netName)}" type="http://www.pnml.org/version-2009/grammar/ptnet">`,
    `    <name><text>${esc(netName)}</text></name>`,
    '    <toolspecific tool="promenade" version="1.0">',
    '      <objectCentric>',
    '        <objectTypes>',
    ...payload.objectTypes.map((t) => `          <objectType>${esc(t)}</objectType>`),
    '        </objectTypes>',
    '      </objectCentric>',
    '    </toolspecific>',
    '    <page id="page1">',
  ];

  for (const place of payload.places) {
    lines.push(`      <place id="${esc(place.id)}">`);
    lines.push(`        <name><text>${esc(place.objectType)}</text></name>`);
    // A source place is where a token of its object type enters, which is the
    // closest thing an OCPN has to an initial marking.
    if (place.kind === 'source') lines.push('        <initialMarking><text>1</text></initialMarking>');
    lines.push('        <toolspecific tool="promenade" version="1.0">');
    lines.push(`          <objectType>${esc(place.objectType)}</objectType>`);
    lines.push(`          <kind>${esc(place.kind)}</kind>`);
    lines.push('        </toolspecific>');
    lines.push('      </place>');
  }

  for (const transition of payload.transitions) {
    lines.push(`      <transition id="${esc(transition.id)}">`);
    lines.push(`        <name><text>${esc(transition.activity ?? 'tau')}</text></name>`);
    lines.push('        <toolspecific tool="promenade" version="1.0">');
    // A transition shared by several object types is the discovery merge, and
    // is the one piece of structure a P/T reader cannot infer from the arcs
    // alone once the object types are gone.
    lines.push(`          <objectTypes>${esc(transition.objectTypes.join(','))}</objectTypes>`);
    if (transition.activity == null) lines.push('          <silent>true</silent>');
    lines.push('        </toolspecific>');
    lines.push('      </transition>');
  }

  for (const arc of payload.arcs) {
    lines.push(`      <arc id="${esc(arc.id)}" source="${esc(arc.source.id)}" target="${esc(arc.target.id)}">`);
    // The inscription is where a coloured-net tool puts its arc expression;
    // the object type is the only inscription an OCPN has.
    lines.push(`        <inscription><text>${esc(arc.objectType)}</text></inscription>`);
    lines.push('        <toolspecific tool="promenade" version="1.0">');
    lines.push(`          <objectType>${esc(arc.objectType)}</objectType>`);
    // "One firing may move more than one token of this type" — the variable
    // arc. A P/T reader sees a plain arc, which is the honest degradation:
    // the multiplicity is not a fixed weight and cannot be written as one.
    if (arc.variable) lines.push('          <variable>true</variable>');
    lines.push('        </toolspecific>');
    lines.push('      </arc>');
  }

  lines.push('    </page>');
  lines.push('  </net>');
  lines.push('</pnml>');
  return lines.join('\n');
}
