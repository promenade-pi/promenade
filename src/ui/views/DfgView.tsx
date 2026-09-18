import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background, BaseEdge, ControlButton, Controls, MarkerType, MiniMap, Panel, Position,
  ReactFlow, ReactFlowProvider, Handle, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import ELK from 'elkjs/lib/elk-api.js';
// eslint-disable-next-line import/no-unresolved -- Vite worker import
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker';
import type { Artifact } from '../../host/artifact/types';
import { payloadOf, resultStore } from '../../host/actions/results';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { fmtCount, fmtMs } from '../format';
import { PercentFilter } from './PercentFilter';

const NODE_W = 176;
const NODE_H = 58;

/** The shared OCPN React-Flow preset. */
const elkOptions: Record<string, string> = {
  'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'SPLINES',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.separateConnectedComponents': 'true',
  'elk.spacing.nodeNode': '48', 'elk.spacing.edgeNode': '24', 'elk.spacing.edgeEdge': '16',
  'elk.spacing.componentComponent': '96', 'elk.layered.cycleBreaking.strategy': 'GREEDY',
  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.crossingMinimization.greedySwitch.activationThreshold': '40',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120', 'elk.layered.spacing.edgeNodeBetweenLayers': '36',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '18', 'elk.layered.thoroughness': '15',
  'elk.layered.unnecessaryBendpoints': 'false',
};

let elk: InstanceType<typeof ELK> | null = null;
function layout(graph: any) {
  elk ??= new ELK({ workerFactory: () => new ElkWorker() });
  return elk.layout(graph) as Promise<any>;
}

type RawEdge = { s: number; d: number; f: number };
type VisibleNode = { id: number; name: string; count: number };
type Model = { nodes: VisibleNode[]; edges: RawEdge[]; loops: RawEdge[]; maxFrequency: number };
type DfgData = { label: string; count: number; loop?: number; selected: boolean; color: string; [key: string]: unknown };
type DfgEdgeData = { path: string; color: string; width: number; dashed?: boolean; [key: string]: unknown };

function ActivityNode({ data }: NodeProps<Node<DfgData>>) {
  return <div className="dfg-flow-node" style={{ borderColor: data.selected ? 'var(--accent)' : data.color }} title={data.label}>
    <Handle type="target" position={Position.Left} style={hiddenHandle} />
    <strong>{data.label}</strong><span>{fmtCount(data.count)}</span>
    {data.loop != null && <em title={`${fmtCount(data.loop)} directly followed by itself`}>↻ {fmtCount(data.loop)}</em>}
    <Handle type="source" position={Position.Right} style={hiddenHandle} />
  </div>;
}

function DfgEdge({ data, markerEnd }: EdgeProps<Edge<DfgEdgeData>>) {
  if (!data?.path) return null;
  return <BaseEdge path={data.path} markerEnd={markerEnd} style={{
    stroke: data.color, strokeWidth: data.width, opacity: data.dashed ? .72 : .58,
    strokeDasharray: data.dashed ? '5 4' : undefined,
  }} />;
}

const hiddenHandle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;
const nodeTypes = { activity: ActivityNode };
const edgeTypes = { dfg: DfgEdge };

function sectionPath(section: any): string {
  const all = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].filter(Boolean);
  if (all.length < 2) return '';
  // ELK's SPLINES bends encode cubic control/anchor triples. Interpreting
  // every bend as a pass-through point is what creates routing spikes.
  const controls = [section.startPoint, ...(section.bendPoints ?? [])].filter(Boolean);
  if ((controls.length - 1) % 3 === 2) controls.push(section.endPoint);
  const point = (p: any) => `${p.x} ${p.y}`;
  if (controls.length >= 4 && (controls.length - 1) % 3 === 0) {
    let d = `M ${point(controls[0])}`;
    for (let i = 1; i < controls.length; i += 3) d += ` C ${point(controls[i])}, ${point(controls[i + 1])}, ${point(controls[i + 2])}`;
    return d;
  }
  return `M ${point(all[0])}` + all.slice(1).map((p: any) => ` L ${point(p)}`).join('');
}

function loopPath(node: { x: number; y: number; width?: number; height?: number }) {
  const w = node.width ?? NODE_W, h = node.height ?? NODE_H;
  const x = node.x + w - 7, y = node.y + h * .33;
  // In the React Flow SVG pane this cannot be clipped by a hand-computed
  // graph bounding box, unlike the former SVG implementation.
  return `M ${x} ${y} C ${x + 54} ${y - 34}, ${x + 54} ${y + 52}, ${x} ${y + h * .34}`;
}

function makeModel(data: any, activityPct: number, connectionPct: number): Model | null {
  // The Rust runner returns Uint32Arrays across the worker boundary, whereas
  // the relational reference action may return plain arrays. Both are valid
  // DFG payloads; `Array.isArray(edges)` accidentally rejected the former.
  if (!data || !Array.isArray(data.activities) || data.edges == null || typeof data.edges.length !== 'number') return null;
  const used = new Set<number>();
  const allEdges: RawEdge[] = [];
  for (let i = 0; i + 2 < data.edges.length; i += 3) {
    const edge = { s: Number(data.edges[i]), d: Number(data.edges[i + 1]), f: Number(data.edges[i + 2]) };
    if (!Number.isFinite(edge.s) || !Number.isFinite(edge.d) || !Number.isFinite(edge.f)) continue;
    used.add(edge.s); used.add(edge.d); allEdges.push(edge);
  }
  const counts = data.counts != null && typeof data.counts.length === 'number' ? data.counts : [];
  const rankedNodes = [...used].map((id) => ({ id, name: String(data.activities[id] ?? `#${id}`), count: Number(counts[id] ?? 0) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const nodes = rankedNodes.slice(0, Math.max(1, Math.round(rankedNodes.length * activityPct / 100)));
  const visible = new Set(nodes.map((node) => node.id));
  const visibleEdges = allEdges.filter((edge) => visible.has(edge.s) && visible.has(edge.d))
    .sort((a, b) => b.f - a.f || a.s - b.s || a.d - b.d);
  const kept = visibleEdges.slice(0, Math.max(0, Math.round(visibleEdges.length * connectionPct / 100)));
  return {
    nodes, edges: kept.filter((edge) => edge.s !== edge.d), loops: kept.filter((edge) => edge.s === edge.d),
    maxFrequency: Math.max(1, ...kept.map((edge) => edge.f)),
  };
}

function DfgFlow({ artifact, panelId, params, onParamChange }: {
  artifact: Artifact; panelId: string;
  params?: { activityPct?: number; connectionPct?: number };
  onParamChange?: (key: string, value: unknown) => void;
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const unsubscribe = resultStore.subscribe(() => force((n) => n + 1));
    return () => { unsubscribe(); };
  }, []);
  const [selection, setSelection] = useState<Selection>(selectionBus.get());
  useEffect(() => {
    const unsubscribe = selectionBus.subscribe(setSelection);
    return () => { unsubscribe(); };
  }, []);
  const activityPct = params?.activityPct ?? 100;
  const connectionPct = params?.connectionPct ?? 100;
  const data: any = payloadOf(artifact.id);
  const model = useMemo(() => makeModel(data, activityPct, connectionPct), [data, activityPct, connectionPct]);
  const [elkResult, setElkResult] = useState<any>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);

  const graph = useMemo(() => model && ({
    id: 'dfg', layoutOptions: elkOptions,
    children: model.nodes.map((node) => ({ id: `a-${node.id}`, width: NODE_W, height: NODE_H })),
    edges: model.edges.map((edge, index) => ({ id: `e-${index}`, sources: [`a-${edge.s}`], targets: [`a-${edge.d}`] })),
  }), [model]);
  useEffect(() => {
    let canceled = false;
    setElkResult(null);
    if (graph) layout(graph).then((result) => { if (!canceled) setElkResult(result); }).catch(() => { if (!canceled) setElkResult({ children: [], edges: [] }); });
    return () => { canceled = true; };
  }, [graph]);

  const nodes = useMemo<Node<DfgData>[]>(() => {
    if (!model || !elkResult?.children) return [];
    const loops = new Map(model.loops.map((edge) => [edge.s, edge.f]));
    const byId = new Map(model.nodes.map((node) => [node.id, node]));
    // React commits the new slider value before its layout effect clears the
    // old ELK result. For that one render the old layout can contain nodes
    // that the newly filtered model no longer has; omitting those stale
    // positions is correct and, crucially, keeps a rapid slider drag from
    // taking down the entire panel.
    return elkResult.children.flatMap((child: any) => {
      const id = Number(String(child.id).slice(2));
      const node = byId.get(id);
      if (!node) return [];
      const selected = selection.items.some((item) => item.kind === 'activity' && item.id === node.name);
      return [{ id: child.id, type: 'activity', position: { x: child.x, y: child.y }, width: NODE_W, height: NODE_H,
        data: { label: node.name, count: node.count, loop: loops.get(id), selected, color: colorRegistry.get('activity', node.name) } }];
    });
  }, [elkResult, model, selection]);

  const edges = useMemo<Edge<DfgEdgeData>[]>(() => {
    if (!model || !elkResult?.children) return [];
    const visibleIds = new Set(model.nodes.map((node) => node.id));
    const byId = new Map<string, any>((elkResult.edges ?? []).map((edge: any) => [edge.id, edge]));
    const normal = model.edges.flatMap((edge, index) => {
      if (!visibleIds.has(edge.s) || !visibleIds.has(edge.d)) return [];
      const section = byId.get(`e-${index}`)?.sections?.[0];
      const path = section ? sectionPath(section) : '';
      if (!path) return [];
      const fraction = edge.f / model.maxFrequency;
      return [{ id: `e-${index}`, source: `a-${edge.s}`, target: `a-${edge.d}`, type: 'dfg',
        data: { path, color: 'var(--text-dim)', width: .9 + fraction * 2.7 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-dim)', width: 14, height: 14 } }];
    });
    const position = new Map<number, any>((elkResult.children ?? []).map((node: any) => [Number(String(node.id).slice(2)), node]));
    const loops = model.loops.flatMap((edge) => {
      if (!visibleIds.has(edge.s)) return [];
      const node = position.get(edge.s); if (!node) return [];
      const fraction = edge.f / model.maxFrequency;
      return [{ id: `loop-${edge.s}`, source: `a-${edge.s}`, target: `a-${edge.s}`, type: 'dfg',
        data: { path: loopPath(node), color: 'var(--warn)', width: 1 + fraction * 2.5, dashed: true },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--warn)', width: 13, height: 13 } }];
    });
    return [...normal, ...loops];
  }, [elkResult, model]);

  const { fitView } = useReactFlow();
  const firstFit = useRef(true);
  useEffect(() => {
    if (!nodes.length) return;
    const frame = requestAnimationFrame(() => { fitView({ padding: .18, duration: firstFit.current ? 0 : 220 }); firstFit.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodes]);

  if (!data || !model) return <div className="view" style={{ color: 'var(--text-dim)' }}>No result yet.</div>;
  const stats = data.stats ?? {};
  return <div className="dfg-flow-view"><ReactFlow
    nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
    nodeOrigin={[0, 0]} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
    onNodeClick={(_, node) => {
      const name = (node.data as DfgData).label;
      const selected = selection.items.some((item) => item.kind === 'activity' && item.id === name);
      selectionBus.set(selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: name }], panelId);
    }}
    panOnDrag panOnScroll={false} zoomOnScroll zoomOnPinch zoomOnDoubleClick={false}
    minZoom={.03} maxZoom={4} onlyRenderVisibleElements proOptions={{ hideAttribution: true }}
  >
    <Background color="var(--border)" gap={20} size={1} />
    <Controls showInteractive={false}>
      <ControlButton onClick={() => setShowMiniMap((visible) => !visible)} title={showMiniMap ? 'Hide overview map' : 'Show overview map'}>
        {showMiniMap ? '▣' : '□'}
      </ControlButton>
    </Controls>
    {showMiniMap && <MiniMap pannable zoomable nodeColor={(node) => (node.data as DfgData).color} style={{ background: 'var(--bg-soft)' }} />}
    <Panel position="top-left" className="dfg-flow-stats">
      <span>{fmtCount(stats.shownEdges ?? edges.length)} / {fmtCount(stats.totalEdges ?? edges.length)} edges</span>
      <span>{fmtCount(stats.cases ?? 0)} cases</span><span>{fmtCount(stats.rows ?? 0)} events</span>
      <span className={stats.reused ? 'ok' : ''}>{stats.reused ? 'cached' : 'computed'} · prepare {fmtMs(stats.prepareMs ?? 0)} · filter <b>{fmtMs(stats.finalizeMs ?? 0)}</b></span>
    </Panel>
    {onParamChange && <Panel position="top-right" className="dfg-flow-rail">
      <PercentFilter label="Activities" value={activityPct} onChange={(value) => onParamChange('activityPct', value)} />
      <PercentFilter label="Connections" value={connectionPct} onChange={(value) => onParamChange('connectionPct', value)} />
    </Panel>}
  </ReactFlow></div>;
}

/** Directly-follows graph using the same React-Flow + ELK profile as OCPN. */
export function DfgView(props: { artifact: Artifact; panelId: string; params?: { activityPct?: number; connectionPct?: number }; onParamChange?: (key: string, value: unknown) => void }) {
  return <ReactFlowProvider><DfgFlow {...props} /></ReactFlowProvider>;
}
