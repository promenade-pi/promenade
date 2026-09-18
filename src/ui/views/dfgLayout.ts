/**
 * Layered, top-down layout for a directly-follows graph.
 *
 * The naive predecessor of this file sorted activities by frequency into a
 * plain grid — readable for a handful of nodes, meaningless once the graph
 * has any real shape, and nothing like what a process miner expects from
 * this kind of tool.
 *
 * What ProM and pm4py actually render is a Graphviz `dot` layout: `dot`
 * implements the Sugiyama framework (Sugiyama, Tagawa & Toda 1981) — cycle
 * removal, rank assignment, crossing-reduction ordering, then coordinate
 * assignment (Gansner, Koutsofios, North & Vo 1993, "A Technique for
 * Drawing Directed Graphs", the paper behind `dot` itself). That is the
 * standard this file follows.
 *
 * One refinement, taken from Mennens, Scheepens & Westenberg's "A Stable
 * Graph Layout Algorithm for Processes" (EuroVis 2019): a generic ranking
 * algorithm ignores which edges are the process's actual main path and can
 * legitimately rank a rare exception above the common case. Rather than
 * their full log-driven global ranking (built directly from case variants,
 * with six sequence-merging cases — a good deal more machinery than a
 * client-side interactive view needs), the same idea is captured cheaply
 * here: cycle-breaking DFS starts from the log's real start activities and,
 * at each node, follows the highest-frequency outgoing edge first. The
 * common path claims "forward" status before any rare loop gets a chance
 * to, so rank ends up reading as "how far into the process this activity
 * typically sits" rather than an arbitrary traversal order.
 */

export interface DfgLayoutNode {
  id: number;
  name: string;
  count: number;
  rank: number;
  x: number;
  y: number;
}

export interface DfgLayoutEdge {
  s: number;
  d: number;
  f: number;
  /** Loops back rather than following the flow, so it is drawn, not just tinted, differently. */
  kind: 'forward' | 'back' | 'loop';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DfgLayoutResult {
  nodes: DfgLayoutNode[];
  edges: DfgLayoutEdge[];
  width: number;
  height: number;
}

export const NODE_W = 160;
export const NODE_H = 36;
const RANK_GAP = 74;
const COL_GAP = 34;
const PAD = 24;

export function layoutDfg(
  nodesIn: Array<{ id: number; name: string; count: number }>,
  edgesIn: Array<{ s: number; d: number; f: number }>,
  /** Activity id -> number of cases it started, for real activities only. */
  startCounts: Map<number, number>
): DfgLayoutResult {
  if (nodesIn.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const ids = nodesIn.map((n) => n.id);
  const idSet = new Set(ids);
  const byId = new Map(nodesIn.map((n) => [n.id, n]));

  const realEdges = edgesIn.filter((e) => e.s !== e.d && idSet.has(e.s) && idSet.has(e.d));
  const selfLoops = edgesIn.filter((e) => e.s === e.d && idSet.has(e.s));

  // Strongest connection first: the DFS below follows these in order, so a
  // frequent transition claims "forward" before a rare one gets the chance.
  const out = new Map<number, Array<{ to: number; f: number }>>(ids.map((id) => [id, []]));
  for (const e of realEdges) out.get(e.s)!.push({ to: e.d, f: e.f });
  for (const list of out.values()) list.sort((a, b) => b.f - a.f);

  // --- 1. Cycle removal + rank assignment ---------------------------------
  // A DFS tree edge can never close a cycle; only an edge back to a node
  // still on the stack can. This step folds cycle removal and rank
  // assignment into one pass: a node's rank is fixed the moment it is first
  // discovered, one below whichever node discovered it — so it is only ever
  // pulled down by the single path that actually found it first (real start
  // activities, most-observed first; strongest edge first), never by some
  // unrelated, much later edge that happens to also reach it. That
  // single-parent rule is also what keeps the graph acyclic without a
  // separate removal step: a node cannot be its own ancestor.
  //
  // An edge to an already-finished node (reached earlier by some other
  // path) does not get to move that rank — it is rendered later using
  // whichever direction the two final ranks actually have, forward or back.
  const state = new Map<number, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const rank = new Map<number, number>();
  const discoveryOrder: number[] = [];
  const dfs = (id: number, r: number) => {
    state.set(id, 1);
    rank.set(id, r);
    discoveryOrder.push(id);
    for (const { to } of out.get(id) ?? []) {
      if (state.get(to) === 0) dfs(to, r + 1);
    }
    state.set(id, 2);
  };
  const roots = ids
    .filter((id) => (startCounts.get(id) ?? 0) > 0)
    .sort((a, b) => (startCounts.get(b) ?? 0) - (startCounts.get(a) ?? 0));
  for (const id of roots) if (state.get(id) === 0) dfs(id, 0);
  // Any node the log never observed as a start (an orphaned sub-graph) still
  // needs a rank; visit the busiest ones first for a stable, sensible order.
  for (const id of [...ids].sort((a, b) => byId.get(b)!.count - byId.get(a)!.count)) {
    if (state.get(id) === 0) dfs(id, 0);
  }
  const maxRank = Math.max(0, ...ids.map((id) => rank.get(id)!));

  // --- 2. Node ordering (crossing reduction) ------------------------------
  // Seeded by DFS discovery order — already keeps causally related nodes
  // near each other — then refined with a handful of barycenter sweeps
  // against the fixed order of the adjacent rank, alternating direction.
  const ranksList: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of discoveryOrder) ranksList[rank.get(id)!].push(id);

  const neighborsOf = new Map<number, number[]>(ids.map((id) => [id, []]));
  for (const e of realEdges) {
    neighborsOf.get(e.s)!.push(e.d);
    neighborsOf.get(e.d)!.push(e.s);
  }
  const posIndex = (arr: number[]) => {
    const m = new Map<number, number>();
    arr.forEach((id, i) => m.set(id, i));
    return m;
  };
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const order = down
      ? ranksList.map((_, i) => i)
      : ranksList.map((_, i) => i).reverse();
    for (const r of order) {
      const neighborRank = down ? r - 1 : r + 1;
      if (neighborRank < 0 || neighborRank > maxRank) continue;
      const posPrev = posIndex(ranksList[neighborRank]);
      const scored = ranksList[r].map((id, i) => {
        const positions = (neighborsOf.get(id) ?? [])
          .map((n) => posPrev.get(n))
          .filter((p): p is number => p != null);
        const bary = positions.length
          ? positions.reduce((a, b) => a + b, 0) / positions.length
          : null;
        return { id, bary, i };
      });
      scored.sort((a, b) => {
        if (a.bary == null && b.bary == null) return a.i - b.i;
        if (a.bary == null) return 1;
        if (b.bary == null) return -1;
        return a.bary - b.bary || a.i - b.i;
      });
      ranksList[r] = scored.map((s) => s.id);
    }
  }

  // --- 3. Coordinate assignment -------------------------------------------
  // Evenly spaced initially, then nudged toward the median x of each node's
  // neighbors (a simplified stand-in for Gansner et al.'s priority method)
  // so chains straighten out instead of staying at their seeded index.
  const x = new Map<number, number>();
  for (const rankArr of ranksList) rankArr.forEach((id, i) => x.set(id, PAD + i * (NODE_W + COL_GAP)));
  for (let it = 0; it < 3; it++) {
    for (const rankArr of ranksList) {
      const desired = rankArr.map((id) => {
        const xs = (neighborsOf.get(id) ?? [])
          .map((n) => x.get(n))
          .filter((v): v is number => v != null)
          .sort((a, b) => a - b);
        if (!xs.length) return x.get(id)!;
        const mid = xs.length >> 1;
        return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
      });
      let prev = PAD - (NODE_W + COL_GAP);
      rankArr.forEach((id, i) => {
        const v = Math.max(desired[i], prev + NODE_W + COL_GAP);
        x.set(id, v);
        prev = v;
      });
    }
  }

  // --- 3b. Center each rank on a shared vertical axis ---------------------
  // The packing above starts every rank flush against `PAD`, so a lone root
  // sits at the far left while a wider rank beneath it fans out to the
  // right — non-overlapping, but visually lopsided rather than the balanced
  // tree shape a process diagram is expected to have. This recenters each
  // rank around the diagram's own horizontal midpoint, independent of how
  // the view container happens to scroll or crop it.
  {
    let globalMinX = Infinity, globalMaxX = -Infinity;
    for (const v of x.values()) {
      globalMinX = Math.min(globalMinX, v);
      globalMaxX = Math.max(globalMaxX, v + NODE_W);
    }
    const globalMid = (globalMinX + globalMaxX) / 2;
    for (const rankArr of ranksList) {
      if (!rankArr.length) continue;
      const xsInRank = rankArr.map((id) => x.get(id)!);
      const rankMid = (Math.min(...xsInRank) + Math.max(...xsInRank) + NODE_W) / 2;
      const shift = globalMid - rankMid;
      for (const id of rankArr) x.set(id, x.get(id)! + shift);
    }
    // Recentering can push the leftmost node past `PAD` or short of it —
    // renormalise so the diagram's own left edge lands back there.
    let minX = Infinity;
    for (const v of x.values()) minX = Math.min(minX, v);
    const norm = PAD - minX;
    for (const [id, v] of x) x.set(id, v + norm);
  }

  const nodes: DfgLayoutNode[] = ids.map((id) => {
    const n = byId.get(id)!;
    const r = rank.get(id)!;
    return { id, name: n.name, count: n.count, rank: r, x: x.get(id)!, y: PAD + r * (NODE_H + RANK_GAP) };
  });
  const nodeAt = new Map(nodes.map((n) => [n.id, n]));

  const edges: DfgLayoutEdge[] = [];
  for (const e of realEdges) {
    const a = nodeAt.get(e.s)!, b = nodeAt.get(e.d)!;
    if (b.rank > a.rank) {
      edges.push({
        s: e.s, d: e.d, f: e.f, kind: 'forward',
        x1: a.x + NODE_W / 2, y1: a.y + NODE_H,
        x2: b.x + NODE_W / 2, y2: b.y,
      });
    } else {
      // Not part of the ranking DAG (or, rarely, lands on the same rank
      // anyway) — drawn as a loop bowing out from the right side rather
      // than a top-to-bottom connector that would point the wrong way.
      edges.push({
        s: e.s, d: e.d, f: e.f, kind: 'back',
        x1: a.x + NODE_W, y1: a.y + NODE_H / 2,
        x2: b.x + NODE_W, y2: b.y + NODE_H / 2,
      });
    }
  }
  for (const e of selfLoops) {
    const a = nodeAt.get(e.s);
    if (!a) continue;
    edges.push({ s: e.s, d: e.d, f: e.f, kind: 'loop', x1: a.x, y1: a.y, x2: a.x, y2: a.y });
  }

  const maxX = nodes.reduce((m, n) => Math.max(m, n.x + NODE_W), 0);
  return {
    nodes, edges,
    width: maxX + PAD,
    height: PAD + (maxRank + 1) * (NODE_H + RANK_GAP),
  };
}
