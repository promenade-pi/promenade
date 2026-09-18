import { useEffect, useMemo, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { fmtCount, fmtMs } from '../format';
import { layoutDfg, NODE_W, NODE_H } from './dfgLayout';
import { PercentFilter } from './PercentFilter';
import { ZoomControls } from './ZoomControls';
import { useZoom } from './useZoom';

interface CausalEdgeRaw {
  s: number; d: number; freq: number; dependency: number;
  split_group: number; join_group: number;
}
interface CausalNetRaw {
  activities: number[];
  edges: CausalEdgeRaw[];
  start_activities: number[];
  activity_counts: number[];
  stats: {
    activities: number; edges: number; and_splits: number; and_joins: number;
    dependency_threshold: number; min_frequency: number; truncated: boolean;
  };
}

/**
 * Causal net, as produced by the Heuristics Miner.
 *
 * Reuses the DFG view's layered layout — a causal net is exactly a DFG's
 * shape, activities and weighted directed edges — and adds one thing a DFG
 * doesn't have: a small gateway marker wherever a node's surviving edges
 * span more than one AND/XOR group, the same convention ProM's own
 * Heuristics Miner canvas uses (a joining arc at a concurrent split/join,
 * nothing drawn for an exclusive one).
 */
export function CausalNetView({
  artifact, panelId, params, onParamChange,
}: {
  artifact: Artifact;
  panelId: string;
  params?: { activityPct?: number; connectionPct?: number };
  onParamChange?: (key: string, value: unknown) => void;
}) {
  const [, force] = useState(0);
  useEffect(() => resultStore.subscribe(() => force((n) => n + 1)), []);
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);
  const { zoom, zoomIn, zoomOut, reset, onWheel } = useZoom();

  const res: any = resultStore.get(artifact.id);
  const activityPct = params?.activityPct ?? 100;
  const connectionPct = params?.connectionPct ?? 100;

  const ranked = useMemo(() => {
    if (!res?.result) return null;
    const net: CausalNetRaw = res.result;
    const names: string[] = res.activities ?? [];

    const allNodes = net.activities
      .map((id) => ({ id, name: names[id] ?? `#${id}`, count: net.activity_counts[id] ?? 0 }))
      .sort((a, b) => b.count - a.count);
    const allEdges = [...net.edges].sort((a, b) => b.freq - a.freq);
    const startCounts = new Map(net.start_activities.map((id) => [id, net.activity_counts[id] ?? 1]));

    return { allNodes, allEdges, startCounts, stats: net.stats };
  }, [res]);

  const view = useMemo(() => {
    if (!ranked) return null;
    const { allNodes, allEdges, startCounts } = ranked;

    const nodes = allNodes.slice(0, Math.max(1, Math.round(allNodes.length * activityPct / 100)));
    const visible = new Set(nodes.map((n) => n.id));
    const amongVisible = allEdges.filter((e) => visible.has(e.s) && visible.has(e.d));
    const edgeList = amongVisible.slice(0, Math.max(0, Math.round(amongVisible.length * connectionPct / 100)));

    // A gateway belongs to a node the moment its surviving edges span more
    // than one group — computed on the filtered set, so hiding a branch
    // with the sliders correctly stops claiming a split that isn't shown.
    const splitGroups = new Map<number, Set<number>>();
    const joinGroups = new Map<number, Set<number>>();
    const meta = new Map<string, CausalEdgeRaw>();
    for (const e of edgeList) {
      meta.set(`${e.s}-${e.d}`, e);
      if (!splitGroups.has(e.s)) splitGroups.set(e.s, new Set());
      splitGroups.get(e.s)!.add(e.split_group);
      if (!joinGroups.has(e.d)) joinGroups.set(e.d, new Set());
      joinGroups.get(e.d)!.add(e.join_group);
    }
    const andSplit = new Set([...splitGroups].filter(([, g]) => g.size > 1).map(([id]) => id));
    const andJoin = new Set([...joinGroups].filter(([, g]) => g.size > 1).map(([id]) => id));

    const maxF = edgeList[0]?.freq ?? 1;
    const layout = layoutDfg(nodes, edgeList.map((e) => ({ s: e.s, d: e.d, f: e.freq })), startCounts);
    return { ...layout, maxF, meta, andSplit, andJoin };
  }, [ranked, activityPct, connectionPct]);

  if (!res || !view || !ranked) {
    return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;
  }

  const { stats } = ranked;
  const isSel = (name: string) => sel.items.some((i) => i.kind === 'activity' && i.id === name);
  const selfLoopOf = new Map<number, CausalEdgeRaw>();
  for (const e of view.edges) if (e.kind === 'loop') {
    const m = view.meta.get(`${e.s}-${e.d}`);
    if (m) selfLoopOf.set(e.s, m);
  }

  return (
    <div className="dfg-layout">
      <div className="dfg-canvas" onWheel={onWheel}>
        <div className="dfg-stats">
          <span>{fmtCount(stats.edges)} dependencies</span>
          <span>{fmtCount(stats.and_splits)} AND-splits</span>
          <span>{fmtCount(stats.and_joins)} AND-joins</span>
          <span>threshold {stats.dependency_threshold.toFixed(2)}</span>
          {res.timing && (
            <span className={res.timing.reused ? 'ok' : ''}>
              {res.timing.reused ? 'cached' : 'computed'} · prepare {fmtMs(res.timing.prepareMs)} · mine{' '}
              <b>{res.timing.finalizeMs < 1
                ? `${res.timing.finalizeMs.toFixed(2)} ms` : fmtMs(res.timing.finalizeMs)}</b>
            </span>
          )}
          {stats.truncated && <span style={{ color: 'var(--warn)' }}>activity limit reached — net is partial</span>}
        </div>

        <svg
          viewBox={`0 0 ${view.width} ${view.height}`}
          width={view.width * zoom}
          height={view.height * zoom}
        >
          <defs>
            <marker id="cn-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--text-dim)" />
            </marker>
            <marker id="cn-arrow-back" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--warn)" />
            </marker>
          </defs>

          {view.edges.slice(0, 400).map((e, i) => {
            const width = 0.4 + (e.f / view.maxF) * 3;
            const opacity = 0.18 + (e.f / view.maxF) * 0.5;
            const m = view.meta.get(`${e.s}-${e.d}`);
            const title = m ? `${fmtCount(m.freq)} · dependency ${m.dependency.toFixed(2)}` : undefined;

            if (e.kind === 'forward') {
              const midY = (e.y1 + e.y2) / 2;
              return (
                <path key={i}
                  d={`M ${e.x1} ${e.y1} C ${e.x1} ${midY}, ${e.x2} ${midY}, ${e.x2} ${e.y2}`}
                  fill="none" stroke="var(--text-dim)" strokeWidth={width} opacity={opacity}
                  markerEnd="url(#cn-arrow)">
                  {title && <title>{title}</title>}
                </path>
              );
            }
            if (e.kind === 'back') {
              const bow = Math.max(50, Math.abs(e.y2 - e.y1) * 0.35);
              return (
                <path key={i}
                  d={`M ${e.x1} ${e.y1} C ${e.x1 + bow} ${e.y1}, ${e.x2 + bow} ${e.y2}, ${e.x2} ${e.y2}`}
                  fill="none" stroke="var(--warn)" strokeWidth={width} opacity={Math.max(opacity, 0.45)}
                  strokeDasharray="4 3" markerEnd="url(#cn-arrow-back)">
                  {title && <title>{title}</title>}
                </path>
              );
            }
            return null;
          })}

          {view.nodes.map((n) => {
            const selected = isSel(n.name);
            const split = view.andSplit.has(n.id);
            const join = view.andJoin.has(n.id);
            const loop = selfLoopOf.get(n.id);
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                 onClick={() => selectionBus.set(
                   selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: n.name }],
                   panelId
                 )}>
                <rect
                  width={NODE_W} height={NODE_H} rx={5}
                  fill="var(--bg)"
                  stroke={selected ? 'var(--accent)' : colorRegistry.get('activity', n.name)}
                  strokeWidth={selected ? 2.5 : 1.5}
                />
                <text x={8} y={15} fontSize={10.5} fill="var(--text)">
                  {n.name.length > 20 ? n.name.slice(0, 19) + '…' : n.name}
                </text>
                <text x={8} y={28} fontSize={9.5} fill="var(--text-dim)">
                  {fmtCount(n.count)}
                </text>
                {/* AND gateway: ProM's own convention is a joining arc at a
                    concurrent split/join and nothing at an exclusive one, so
                    only the AND case gets a marker at all. */}
                {join && (
                  <g transform="translate(0,-6)">
                    <title>AND-join: waits for every incoming branch</title>
                    <circle cx={NODE_W / 2} cy={0} r={6} fill="var(--bg)" stroke="var(--ok)" strokeWidth={1.4} />
                    <path d={`M ${NODE_W / 2 - 3} 0 H ${NODE_W / 2 + 3} M ${NODE_W / 2} -3 V 3`}
                          stroke="var(--ok)" strokeWidth={1.4} />
                  </g>
                )}
                {split && (
                  <g transform={`translate(0,${NODE_H + 6})`}>
                    <title>AND-split: triggers every outgoing branch</title>
                    <circle cx={NODE_W / 2} cy={0} r={6} fill="var(--bg)" stroke="var(--ok)" strokeWidth={1.4} />
                    <path d={`M ${NODE_W / 2 - 3} 0 H ${NODE_W / 2 + 3} M ${NODE_W / 2} -3 V 3`}
                          stroke="var(--ok)" strokeWidth={1.4} />
                  </g>
                )}
                {loop && (
                  <g transform={`translate(${NODE_W - 15},9)`}>
                    <title>{`${fmtCount(loop.freq)} · dependency ${loop.dependency.toFixed(2)} — directly followed by itself`}</title>
                    <path
                      d="M -4.5 -1.5 A 4.5 4.5 0 1 1 -4.5 1.8"
                      fill="none" stroke="var(--warn)" strokeWidth={1.4}
                    />
                    <path d="M -7.5 0.5 L -4.3 -2 L -2 1.2 Z" fill="var(--warn)" />
                  </g>
                )}
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
        </div>
      )}
    </div>
  );
}
