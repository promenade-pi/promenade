import { useEffect, useMemo, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { fmtCount } from '../format';
import { layoutDfg, NODE_W, NODE_H } from './dfgLayout';
import { PercentFilter } from './PercentFilter';
import { ZoomControls } from './ZoomControls';
import { useZoom } from './useZoom';

interface OcdfgNodeRaw { objectType: string; activity: string; count: number; starts: number; ends: number }
interface OcdfgEdgeRaw { objectType: string; src: string; dst: string; freq: number }
interface OcdfgResultRaw {
  objectTypes: string[];
  nodes: OcdfgNodeRaw[];
  edges: OcdfgEdgeRaw[];
  stats: { objectTypes: number; activities: number; edges: number };
}

const slug = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '_');

/**
 * Object-centric directly-follows graph.
 *
 * One shared node layout — an activity is one box regardless of how many
 * object types pass through it — with one colored edge curve per (object
 * type, src, dst) triple, the standard OC-DFG convention (van der Aalst &
 * Berti's color-per-type). Reuses the plain DFG's own layered layout: the
 * ranking problem is identical, only the edge set is richer.
 *
 * Activities/Connections filter exactly like `core.dfgView` does — top-N%
 * of an already-fetched result, nothing recomputed — plus an object-type
 * checklist, since which relations even apply is a real question here that
 * a single-type DFG never has to ask.
 */
export function OcdfgView({
  artifact, panelId, params, onParamChange,
}: {
  artifact: Artifact;
  panelId: string;
  params?: { activityPct?: number; connectionPct?: number; objectTypes?: string[] };
  onParamChange?: (key: string, value: unknown) => void;
}) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);
  const { zoom, zoomIn, zoomOut, reset, onWheel } = useZoom();

  const res: any = resultStore.get(artifact.id);
  const data: OcdfgResultRaw | null = res?.result ?? null;

  const activityPct = params?.activityPct ?? 100;
  const connectionPct = params?.connectionPct ?? 100;
  // Empty/undefined reads as "every type" — the same convention the
  // activity filter elsewhere in this app uses for "nothing chosen".
  const chosenTypes = params?.objectTypes;
  const visibleTypes = useMemo(() => (
    data ? new Set(chosenTypes && chosenTypes.length > 0 ? chosenTypes : data.objectTypes) : new Set<string>()
  ), [data, chosenTypes]);

  const view = useMemo(() => {
    if (!data) return null;

    const count = new Map<string, number>();
    const starts = new Map<string, number>();
    for (const n of data.nodes) {
      if (!visibleTypes.has(n.objectType)) continue;
      count.set(n.activity, (count.get(n.activity) ?? 0) + n.count);
      starts.set(n.activity, (starts.get(n.activity) ?? 0) + n.starts);
    }
    const allNodes = [...count.entries()]
      .map(([name, c], i) => ({ id: i, name, count: c }))
      .sort((a, b) => b.count - a.count);
    const nodes = allNodes.slice(0, Math.max(1, Math.round(allNodes.length * activityPct / 100)));
    const visibleIds = new Set(nodes.map((n) => n.id));
    const idOf = new Map(nodes.map((n) => [n.name, n.id]));

    const edgesByType = data.edges.filter((e) => visibleTypes.has(e.objectType));
    // One aggregated edge per (src, dst) purely to drive layout ranking —
    // rendering below walks `edgesByType` again for the real, per-type curves.
    const agg = new Map<string, { s: number; d: number; f: number }>();
    for (const e of edgesByType) {
      const s = idOf.get(e.src), d = idOf.get(e.dst);
      if (s == null || d == null || !visibleIds.has(s) || !visibleIds.has(d)) continue;
      const key = `${s}-${d}`;
      const cur = agg.get(key);
      if (cur) cur.f += e.freq; else agg.set(key, { s, d, f: e.freq });
    }
    const aggEdges = [...agg.values()].sort((a, b) => b.f - a.f);
    const keptAgg = aggEdges.slice(0, Math.max(0, Math.round(aggEdges.length * connectionPct / 100)));
    const keptPairs = new Set(keptAgg.map((e) => `${e.s}-${e.d}`));

    const startCounts = new Map<number, number>();
    for (const [name, c] of starts) { const id = idOf.get(name); if (id != null && c > 0) startCounts.set(id, c); }

    const layout = layoutDfg(nodes, keptAgg, startCounts);
    const posOf = new Map(layout.nodes.map((n) => [n.name, n]));

    // The real per-type edges: only those whose aggregated (src,dst) pair
    // survived the connection filter above.
    const renderEdges = edgesByType.filter((e) => {
      const s = idOf.get(e.src), d = idOf.get(e.dst);
      return s != null && d != null && s !== d && keptPairs.has(`${s}-${d}`);
    });
    const maxFreq = Math.max(1, ...renderEdges.map((e) => e.freq));

    return { layout, posOf, renderEdges, maxFreq, allNodesCount: allNodes.length, allEdgesCount: edgesByType.length };
  }, [data, visibleTypes, activityPct, connectionPct]);

  if (!data || !view) {
    return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;
  }

  const isSel = (name: string) => sel.items.some((i) => i.kind === 'activity' && i.id === name);

  return (
    <div className="dfg-layout">
      <div className="dfg-canvas" onWheel={onWheel}>
        <div className="dfg-stats">
          <span>{fmtCount(data.stats.objectTypes)} object types</span>
          <span>{fmtCount(view.layout.nodes.length)} / {fmtCount(view.allNodesCount)} activities</span>
          <span>{fmtCount(view.renderEdges.length)} / {fmtCount(view.allEdgesCount)} edges</span>
        </div>

        <svg
          viewBox={`0 0 ${view.layout.width} ${view.layout.height}`}
          width={view.layout.width * zoom}
          height={view.layout.height * zoom}
        >
          <defs>
            {data.objectTypes.map((ot) => (
              <marker key={ot} id={`ocdfg-arrow-${slug(ot)}`} viewBox="0 0 8 8" refX="7" refY="4"
                      markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 8 4 L 0 8 z" fill={colorRegistry.get('objectType', ot)} />
              </marker>
            ))}
          </defs>

          {view.renderEdges.map((e, i) => {
            const a = view.posOf.get(e.src), b = view.posOf.get(e.dst);
            if (!a || !b) return null;
            const color = colorRegistry.get('objectType', e.objectType);
            const width = 0.5 + (e.freq / view.maxFreq) * 2.5;
            const opacity = 0.3 + (e.freq / view.maxFreq) * 0.55;
            const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
            const x2 = b.x + NODE_W / 2, y2 = b.y;
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none" stroke={color} strokeWidth={width} opacity={opacity}
                markerEnd={`url(#ocdfg-arrow-${slug(e.objectType)})`}
              >
                <title>{`${e.objectType}: ${e.src} → ${e.dst} (${fmtCount(e.freq)})`}</title>
              </path>
            );
          })}

          {view.layout.nodes.map((n) => {
            const selected = isSel(n.name);
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                 onClick={() => selectionBus.set(
                   selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: n.name }], panelId
                 )}>
                <rect width={NODE_W} height={NODE_H} rx={5} fill="var(--bg)"
                      stroke={selected ? 'var(--accent)' : 'var(--border)'}
                      strokeWidth={selected ? 2.5 : 1.5} />
                <text x={8} y={15} fontSize={10.5} fill="var(--text)">
                  {n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name}
                </text>
                <text x={8} y={28} fontSize={9.5} fill="var(--text-dim)">
                  {fmtCount(n.count)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />

      {onParamChange && (
        <div className="dfg-rail">
          <PercentFilter
            label="Activities" value={activityPct}
            onChange={(v) => onParamChange('activityPct', v)}
          />
          <PercentFilter
            label="Connections" value={connectionPct}
            onChange={(v) => onParamChange('connectionPct', v)}
          />
          <div className="ocdfg-types">
            {data.objectTypes.map((ot) => {
              const active = visibleTypes.has(ot);
              return (
                <label key={ot} className="ocdfg-type-row">
                  <input
                    type="checkbox" checked={active}
                    onChange={() => {
                      const next = new Set(visibleTypes);
                      active ? next.delete(ot) : next.add(ot);
                      onParamChange('objectTypes', next.size === data!.objectTypes.length ? [] : [...next]);
                    }}
                  />
                  <span className="swatch" style={{ background: colorRegistry.get('objectType', ot) }} />
                  {ot}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
