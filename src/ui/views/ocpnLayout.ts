/**
 * ELK graph construction and layout client for the OCPN view.
 *
 * Layout is view state, computed here at render time — never persisted into
 * the artifact (see `host/artifact/ocpn.ts`'s module docs). This file is the
 * only place that translates an `OcpnPayload` into coordinates.
 */
import type { OcpnPayload } from '../../host/artifact/ocpn';

export const PLACE_R = 14;
export const TRANS_W = 130;
export const TRANS_H = 34;

export type LayoutDirection = 'RIGHT' | 'DOWN';
export type EdgeRouting = 'SPLINES' | 'ORTHOGONAL' | 'POLYLINE';

/**
 * Recommended layered-layout configuration (see `docs/elk-configuration.md`
 * for the rationale behind each option).
 *
 * `elk.partitioning.activate` plus a source=0 / internal=1 / sink=2 tier
 * per node is the one OCPN-specific layout hint applied: it pins each object
 * type's entry point toward the left and its exit point toward the right,
 * without attempting a full per-object-type lane assignment (deliberately —
 * see `docs/algorithm.md`'s "Known differences" section for why that is left
 * for a later iteration rather than risking a layout heuristic that
 * contradicts the net's actual semantics).
 */
export function elkLayoutOptions(direction: LayoutDirection, edgeRouting: EdgeRouting): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': edgeRouting,
    'elk.layered.cycleBreaking.strategy': 'GREEDY',
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.spacing.nodeNodeBetweenLayers': '74',
    'elk.spacing.nodeNode': '40',
    'elk.spacing.edgeNode': '20',
    'elk.spacing.edgeEdge': '12',
    'elk.partitioning.activate': 'true',
  };
}

export interface ElkGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: Array<{ id: string; width: number; height: number; layoutOptions?: Record<string, string> }>;
  edges: Array<{ id: string; sources: string[]; targets: string[] }>;
}

export function buildElkGraph(
  net: OcpnPayload,
  visibleTypes: Set<string>,
  showSilent: boolean,
  direction: LayoutDirection,
  edgeRouting: EdgeRouting
): ElkGraph {
  const hiddenPlaces = new Set(
    net.places.filter((p) => !visibleTypes.has(p.objectType)).map((p) => p.id)
  );
  const hiddenTransitions = new Set(
    net.transitions
      .filter((t) => (t.activity == null && !showSilent) || t.objectTypes.every((ot) => !visibleTypes.has(ot)))
      .map((t) => t.id)
  );

  const children: ElkGraph['children'] = [];
  for (const p of net.places) {
    if (hiddenPlaces.has(p.id)) continue;
    children.push({
      id: p.id,
      width: PLACE_R * 2,
      height: PLACE_R * 2,
      layoutOptions: { 'elk.partitioning.partition': p.kind === 'source' ? '0' : p.kind === 'sink' ? '2' : '1' },
    });
  }
  for (const t of net.transitions) {
    if (hiddenTransitions.has(t.id)) continue;
    children.push({
      id: t.id,
      width: t.activity == null ? 24 : TRANS_W,
      height: t.activity == null ? TRANS_H : TRANS_H,
      layoutOptions: { 'elk.partitioning.partition': '1' },
    });
  }

  const nodeIds = new Set(children.map((c) => c.id));
  const edges: ElkGraph['edges'] = [];
  for (const a of net.arcs) {
    if (!visibleTypes.has(a.objectType)) continue;
    if (!nodeIds.has(a.source.id) || !nodeIds.has(a.target.id)) continue;
    edges.push({ id: a.id, sources: [a.source.id], targets: [a.target.id] });
  }

  return { id: 'root', layoutOptions: elkLayoutOptions(direction, edgeRouting), children, edges };
}

// ------------------------------------------------------------- worker client

interface ElkLayoutResultNode { id: string; x: number; y: number; width: number; height: number }
interface ElkSection {
  startPoint: { x: number; y: number };
  bendPoints?: Array<{ x: number; y: number }>;
  endPoint: { x: number; y: number };
}
interface ElkLayoutResultEdge {
  id: string;
  sections?: ElkSection[];
}
export interface ElkLayoutResult {
  children?: ElkLayoutResultNode[];
  edges?: ElkLayoutResultEdge[];
  width?: number;
  height?: number;
}

/**
 * ELK already ships its own worker-offload mechanism — `elk-api.js` is a
 * thin promise wrapper that talks over `postMessage` to whatever worker its
 * `workerFactory` constructs, and `elk-worker.min.js` is the actual
 * layout engine. Handing it a real Vite-bundled Worker (via the `?worker`
 * import, the same mechanism that builds `ocpn-plugin-worker.ts` into its
 * own chunk) is what keeps `layout()` off the main thread — a second,
 * hand-rolled `postMessage` wrapper around it would just be a worker
 * wrapping a worker. (`elkjs/lib/elk.bundled.js`, the all-in-one browser
 * build, looks tempting here but its default constructor tries to build its
 * *own* worker from a Node-oriented fallback path that does not survive
 * bundling — `elk-api.js` + an explicit `workerFactory` sidesteps that
 * entirely and is elkjs's documented way to integrate with a bundler.)
 */
import ELK from 'elkjs/lib/elk-api.js';
// eslint-disable-next-line import/no-unresolved -- Vite's worker-import suffix
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';

let elk: InstanceType<typeof ELK> | null = null;
function ensureElk() {
  if (!elk) elk = new ELK({ workerFactory: () => new ElkWorker() });
  return elk;
}

/** Runs ELK layout, off the main thread. Every call is independent — the
 * caller is responsible for ignoring a response that arrived after a newer
 * request was already sent (see `OcpnView`'s generation counter). */
export function layoutOcpn(graph: ElkGraph): Promise<ElkLayoutResult> {
  return ensureElk().layout(graph) as Promise<ElkLayoutResult>;
}

/** Piecewise-smooth path through an ELK edge section's points — the same
 * "curve through the midpoints" technique `OcdfgView` uses for its own
 * hand-rolled edges, generalised to however many bend points ELK returned. */
export function pathFromSection(section: ElkSection): string {
  const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  if (pts.length < 2) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x} ${pts[i].y}`;
  }
  return d;
}
