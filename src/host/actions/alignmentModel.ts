import { dataClient } from '../data/client';
import { payloadOf, resultStore } from './results';

/**
 * The model shape `alignment-rs` expects — see the plugin's `ModelIn`.
 * Everything here is already resolved to ids; the kernel never sees a name.
 */
export interface AlignModelIn {
  placeCount: number;
  transitions: Array<{ activityId: number | null }>;
  placeToTransition: Array<[number, number]>;
  transitionToPlace: Array<[number, number]>;
  initialMarking: number[];
  finalMarking: number[];
  /** Self-contained, compact-id net for a replay renderer. Unlike a source
   * artifact payload, this travels inside the model contract itself. */
  visualModel: {
    places: Array<{ id: string }>;
    activities: number[];
    labels: Array<string | null>;
    placeToTransition: Array<[number, number]>;
    transitionToPlace: Array<[number, number]>;
    initialMarking: number[];
    finalMarking: number[];
  };
}

/**
 * The same activity-id assignment the generic WASM scan builds internally
 * (`wasm-plugin-worker.ts`'s `runScan`), computed here instead because it is
 * needed *before* the run() call — to resolve the model's transition labels
 * into this id space — while the scan that would otherwise produce it only
 * finishes inside the worker, after `finalize()` has already been called
 * with its params. A second query is simpler than restructuring the
 * two-stage contract around a plugin this is the only user of.
 */
export type AlignmentClassifier = 'activity' | 'activityLifecycle';
export const LIFECYCLE_SEPARATOR = '\u001f';

/** The classifier expression must remain identical to wasm-plugin-worker's
 * scan query: ids are resolved before the worker starts scanning. */
function classifierExpression(classifier: AlignmentClassifier) {
  return classifier === 'activityLifecycle'
    ? "activity || chr(31) || CASE lower(coalesce(lifecycle, '')) WHEN 'enqueue' THEN 'enqueue' WHEN 'start' THEN 'start' ELSE 'complete' END"
    : 'activity';
}

export async function activityIdMap(
  table: string,
  maxActivities: number,
  order: 'timestamp' | 'timestampNullsLast' | 'log' = 'timestamp',
  classifier: AlignmentClassifier = 'activity',
): Promise<Map<string, number>> {
  const expression = classifierExpression(classifier);
  const res = await dataClient.sql(`
    SELECT activity, CAST(row_number() OVER (ORDER BY n DESC, activity) - 1 AS INTEGER) AS aid
    FROM (SELECT ${expression} AS activity, COUNT(*) AS n FROM ${table}
          WHERE activity IS NOT NULL ${order === 'timestamp' ? 'AND ts IS NOT NULL' : ''} GROUP BY 1)
    QUALIFY aid < ${maxActivities}
  `);
  const map = new Map<string, number>();
  for (const r of res.toArray() as any[]) map.set(String(r.activity), Number(r.aid));
  return map;
}

/**
 * Turns every visible transition into an enqueue → start → complete chain.
 * This is a structural Petri-net transformation: each original input arc now
 * enters `enqueue`, each original output arc leaves `complete`, while silent
 * routing transitions remain untouched. Thus it preserves the source net's
 * choices, parallelism and loops instead of merely relabelling animation
 * frames. Lifecycle values absent from the log become silent model moves.
 */
export function buildLifecycleAlignModel(base: AlignModelIn, nameToId: Map<string, number>): AlignModelIn {
  const phase = (label: string, name: 'enqueue' | 'start' | 'complete') => `${label}${LIFECYCLE_SEPARATOR}${name}`;
  const transitions: AlignModelIn['transitions'] = [];
  const labels: Array<string | null> = [];
  const originalToStages = new Map<number, [number, number, number]>();
  const originalToSingle = new Map<number, number>();
  let placeCount = base.placeCount;

  base.transitions.forEach((transition, original) => {
    const label = base.visualModel.labels[original];
    // `base` was resolved against lifecycle-qualified log labels, hence its
    // plain activity ids are intentionally null here. The source visual label
    // — not that temporary id — is the authoritative visible/silent flag.
    if (!label) {
      originalToSingle.set(original, transitions.length);
      transitions.push({ activityId: null }); labels.push(null);
      return;
    }
    const enqueue = transitions.length;
    const start = enqueue + 1;
    const complete = enqueue + 2;
    originalToStages.set(original, [enqueue, start, complete]);
    for (const lifecycle of ['enqueue', 'start', 'complete'] as const) {
      const id = nameToId.get(phase(label, lifecycle));
      transitions.push({ activityId: id ?? null });
      // A lifecycle stage which has no event counterpart is a genuine silent
      // transition in the alignment, not a visible model deviation.
      labels.push(id == null ? null : `${label} · ${lifecycle}`);
    }
    placeCount += 2;
  });

  const placeToTransition: Array<[number, number]> = [];
  const transitionToPlace: Array<[number, number]> = [];
  for (const [place, original] of base.placeToTransition) {
    const stages = originalToStages.get(original);
    placeToTransition.push([place, stages ? stages[0] : originalToSingle.get(original)!]);
  }
  for (const [original, place] of base.transitionToPlace) {
    const stages = originalToStages.get(original);
    transitionToPlace.push([stages ? stages[2] : originalToSingle.get(original)!, place]);
  }
  // The two private places are allocated in the same original-transition
  // order as above, after the source net's places.
  let nextPlace = base.placeCount;
  for (const [original, stages] of originalToStages) {
    const first = nextPlace++, second = nextPlace++;
    placeToTransition.push([first, stages[1]], [second, stages[2]]);
    transitionToPlace.push([stages[0], first], [stages[1], second]);
  }
  return {
    placeCount, transitions, placeToTransition, transitionToPlace,
    initialMarking: base.initialMarking, finalMarking: base.finalMarking,
    visualModel: {
      places: Array.from({ length: placeCount }, (_, id) => ({ id: String(id) })),
      activities: transitions.map((_, id) => id), labels,
      placeToTransition, transitionToPlace,
      initialMarking: base.initialMarking, finalMarking: base.finalMarking,
    },
  };
}

/**
 * Normalises an AcceptingPetriNet artifact's result into `AlignModelIn`,
 * resolving every transition's label into the log's own activity id space
 * (`nameToId`). Two different miners in this codebase produce two different
 * net shapes, and alignment has to read both:
 *
 *  - Inductive Miner (pyodide): `activities` is a bare `0..n` transition
 *    index, a parallel `labels[i]` array names transition `i` (`null` for a
 *    silent one), and the arc lists already reference that index.
 *  - Alpha Miner (Rust/WASM): no silent transitions and no duplicate
 *    labels, so the activity id doubles as the transition id, and the arc
 *    lists reference it directly rather than a compacted position.
 *
 * Returns `null` if the artifact has no result yet — the caller reports that
 * rather than sending a broken model into the kernel. Inline outputs are
 * deliberately read through `payloadOf()`: during a live run the result store
 * holds the runner envelope (`{ result, activities, stats }`), while after a
 * browser reload it is rehydrated from the catalog's *bare* storage value.
 * Both representations describe the same model.
 *
 * `persistedActivities` retains the scanner's id-to-name table for models
 * such as Alpha Miner whose payload stores numeric activity ids rather than
 * labels. It is persisted in artifact metadata, since the runner envelope is
 * intentionally not part of the model payload.
 * `persistedPayload` is the catalog fallback for the short interval before
 * boot-time result-store rehydration has completed.
 */
export function buildAlignModel(
  modelArtifactId: string,
  nameToId: Map<string, number>,
  persistedActivities: string[] = [],
  persistedPayload?: unknown,
): AlignModelIn | null {
  const stored: any = resultStore.get(modelArtifactId);
  const net: any = payloadOf(modelArtifactId) ?? persistedPayload;
  if (!net || typeof net !== 'object') return null;
  const modelNames: string[] = Array.isArray(stored?.activities)
    ? stored.activities
    : persistedActivities;

  let transitions: Array<{ activityId: number | null }>;
  let placeToTransition: Array<[number, number]>;
  let transitionToPlace: Array<[number, number]>;
  let visualLabels: Array<string | null>;

  if (Array.isArray(net.labels)) {
    visualLabels = net.labels.map((label: unknown) => typeof label === 'string' ? label : null);
    transitions = net.labels.map((label: string | null) => ({
      activityId: label == null ? null : (nameToId.get(label) ?? null),
    }));
    placeToTransition = net.place_to_transition ?? [];
    transitionToPlace = net.transition_to_place ?? [];
  } else {
    const acts: number[] = net.activities ?? [];
    // Alpha Miner's arcs reference the raw activity id, not a position in
    // `acts` — remapped to a compact 0..n transition index for the kernel.
    const transitionIndexOf = new Map<number, number>();
    acts.forEach((a, i) => transitionIndexOf.set(a, i));
    transitions = acts.map((a) => ({
      activityId: nameToId.get(modelNames[a] ?? '') ?? null,
    }));
    visualLabels = acts.map((a) => modelNames[a] ?? `#${a}`);
    placeToTransition = (net.place_to_transition ?? [])
      .map(([p, t]: [number, number]): [number, number] => [p, transitionIndexOf.get(t) ?? -1])
      .filter(([, t]: [number, number]) => t >= 0);
    transitionToPlace = (net.transition_to_place ?? [])
      .map(([t, p]: [number, number]): [number, number] => [transitionIndexOf.get(t) ?? -1, p])
      .filter(([t]: [number, number]) => t >= 0);
  }

  const placeCount = net.places?.length ?? 0;
  const initialMarking = net.initial_marking ?? [];
  const finalMarking = net.final_marking ?? [];
  return {
    placeCount,
    transitions,
    placeToTransition,
    transitionToPlace,
    initialMarking,
    finalMarking,
    visualModel: {
      places: Array.from({ length: placeCount }, (_, id) => ({ id: String(id) })),
      activities: transitions.map((_, id) => id),
      labels: visualLabels,
      placeToTransition,
      transitionToPlace,
      initialMarking,
      finalMarking,
    },
  };
}
