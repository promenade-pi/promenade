import type { RelationalResult } from '../../engine';

/**
 * The `DFG` artifact payload shape — kept identical to what
 * `core.discover.dfg` (the Rust/WASM kernel, see `host/actions/executor.ts`)
 * produces, so `DfgView` renders either without knowing which runtime
 * created it. This is the "Result -> Artifact mapping" conversion/builder
 * layer: raw relational results never reach the Artifact Registry directly.
 */
export interface DfgResultPayload {
  activities: string[];
  edges: Uint32Array;
  starts: Uint32Array;
  ends: Uint32Array;
  counts: Uint32Array;
  stats: {
    rows: number;
    cases: number;
    totalEdges: number;
    shownEdges: number;
    prepareMs: number;
    finalizeMs: number;
    reused: boolean;
    heapEstimate: number;
  };
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v));

/**
 * Combines the query's five named outputs (`activities`, `edges`, `starts`,
 * `ends`, `statistics`) into one `DfgResultPayload`. Activity ids are
 * assigned here, by descending frequency — the same numbering convention
 * `wasm-plugin-worker.ts`'s default `activityIds: 'frequency'` scan uses —
 * so a relational and a WASM discovery of the same log are directly
 * comparable edge-for-edge, not just visually similar.
 */
export function buildDfgResult(result: RelationalResult): DfgResultPayload {
  const activitiesTable = result.outputs.activities;
  const edgesTable = result.outputs.edges;
  const startsTable = result.outputs.starts;
  const endsTable = result.outputs.ends;
  const statsRow = result.outputs.statistics.get(0)!.toJSON() as any;

  const activities: string[] = [];
  const counts = new Uint32Array(activitiesTable.numRows);
  const idOf = new Map<string, number>();
  for (let i = 0; i < activitiesTable.numRows; i++) {
    const row = activitiesTable.get(i)!.toJSON() as any;
    activities[i] = String(row.activity);
    counts[i] = num(row.n);
    idOf.set(String(row.activity), i);
  }

  const edges = new Uint32Array(edgesTable.numRows * 3);
  for (let i = 0; i < edgesTable.numRows; i++) {
    const row = edgesTable.get(i)!.toJSON() as any;
    edges[i * 3] = idOf.get(String(row.src)) ?? 0;
    edges[i * 3 + 1] = idOf.get(String(row.dst)) ?? 0;
    edges[i * 3 + 2] = num(row.freq);
  }

  const packPairs = (t: typeof activitiesTable) => {
    const out = new Uint32Array(t.numRows * 2);
    for (let i = 0; i < t.numRows; i++) {
      const row = t.get(i)!.toJSON() as any;
      out[i * 2] = idOf.get(String(row.activity)) ?? 0;
      out[i * 2 + 1] = num(row.n);
    }
    return out;
  };

  return {
    activities,
    edges,
    starts: packPairs(startsTable),
    ends: packPairs(endsTable),
    counts,
    stats: {
      rows: num(statsRow.rows),
      cases: num(statsRow.cases),
      totalEdges: num(statsRow.total_edges),
      shownEdges: num(statsRow.shown_edges),
      prepareMs: result.stats.compileMs,
      finalizeMs: result.stats.executeMs,
      reused: false,
      heapEstimate: 0,
    },
  };
}
