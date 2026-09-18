/**
 * Rank-and-stack layout for an accepting Petri net.
 *
 * Shared by the Petri net view and the replay-diagnostics view, which draw
 * the same net for different reasons: one decorates it with how often each
 * transition fired, the other with where a replay had to invent or abandon
 * tokens. They have to agree on where a place *is* — a reader moving between
 * the two tabs is looking for the same node in the same spot — so the
 * geometry lives here rather than being written twice and drifting.
 *
 * Deliberately not a graph layout engine: ranks come from a simple
 * longest-path relaxation and nodes stack within their rank. Enough to read
 * the structure of a discovered model, and no dependency.
 */

/** Both net shapes this codebase produces — see `alignmentModel.ts`. */
export interface PetriNetPayload {
  places: Array<{ id: string; kind?: string }>;
  activities?: number[];
  labels?: Array<string | null>;
  place_to_transition?: Array<[number, number]>;
  transition_to_place?: Array<[number, number]>;
  initial_marking?: number[];
  final_marking?: number[];
  /** Producer-specific summary counts; each miner reports a different set. */
  stats?: Record<string, any>;
}

export interface PetriNetLayout {
  net: PetriNetPayload;
  /** `null` for a silent transition — nothing to name, colour or count. */
  labelOf: (transition: number) => string | null;
  key: (kind: 'p' | 't', i: number) => string;
  pos: Map<string, { x: number; y: number }>;
  p2t: Array<[number, number]>;
  t2p: Array<[number, number]>;
  width: number;
  height: number;
}

/** Node geometry, exported so a decoration can be placed against it. */
export const PLACE_R = 12;
export const PLACE_CY = 13;
export const TRANSITION_W = 46;
export const TRANSITION_H = 34;
export const TRANSITION_CY = 17;

export function layoutPetriNet(net: PetriNetPayload, names: string[]): PetriNetLayout | null {
  if (!net || !Array.isArray(net.places)) return null;

  // Two shapes share this artifact type — see `alignmentModel.ts`'s
  // `buildAlignModel` and `pnml.ts`'s `normalize` for the same split.
  // Alpha Miner (Rust/WASM): no silent transitions, and the activity id
  // doubles as the transition id, so `names[a]` is the label. pm4py's
  // inductive miner: `net.activities` is a bare 0..n transition index — not
  // an id into `names` — and the real per-transition label (`null` for a
  // silent/tau transition) lives in the parallel `net.labels`. Indexing
  // `names` with a pm4py transition id would silently succeed (arrays
  // tolerate any numeric key) and print the raw index instead of the
  // activity name, which is why this has to branch rather than fall back.
  const labels: Array<string | null> | null = Array.isArray(net.labels) ? net.labels : null;
  const labelOf = (a: number): string | null => (labels ? labels[a] ?? null : (names[a] ?? `#${a}`));

  const placeCount = net.places.length;
  const activities = net.activities ?? [];
  const rank = new Map<string, number>();
  const key = (kind: 'p' | 't', i: number) => `${kind}${i}`;
  rank.set(key('p', 0), 0);

  const p2t: Array<[number, number]> = net.place_to_transition ?? [];
  const t2p: Array<[number, number]> = net.transition_to_place ?? [];
  for (let pass = 0; pass < placeCount + activities.length + 2; pass++) {
    let changed = false;
    for (const [p, t] of p2t) {
      const r = rank.get(key('p', p));
      if (r != null && (rank.get(key('t', t)) ?? -1) < r + 1) {
        rank.set(key('t', t), r + 1); changed = true;
      }
    }
    for (const [t, p] of t2p) {
      const r = rank.get(key('t', t));
      if (r != null && (rank.get(key('p', p)) ?? -1) < r + 1) {
        rank.set(key('p', p), r + 1); changed = true;
      }
    }
    if (!changed) break;
  }

  const cols = new Map<number, string[]>();
  const push = (k: string) => {
    const r = rank.get(k) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r)!.push(k);
  };
  for (let i = 0; i < placeCount; i++) push(key('p', i));
  for (const a of activities) push(key('t', a));

  const pos = new Map<string, { x: number; y: number }>();
  const COL = 150, ROW = 54;
  let maxRow = 0;
  for (const [r, keys] of [...cols].sort((a, b) => a[0] - b[0])) {
    keys.forEach((k, i) => pos.set(k, { x: 24 + r * COL, y: 34 + i * ROW }));
    maxRow = Math.max(maxRow, keys.length);
  }

  return {
    net, labelOf, key, pos, p2t, t2p,
    width: 40 + (Math.max(...[...cols.keys()]) + 1) * COL,
    height: 50 + maxRow * ROW,
  };
}
