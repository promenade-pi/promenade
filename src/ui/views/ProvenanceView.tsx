import { useEffect, useMemo } from 'react';
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  ReactFlowProvider, useNodesState, useReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ActionExecution, Artifact, ProvenanceGraph } from '../../host/artifact/types';
import { artifactTypes, familyColorOf, displayNameOf } from '../../host/artifact/registry';
import { artifactFocus } from '../../host/services/focus';
import { primaryParam } from '../../host/actions/registry';
import { actionRegistry } from '../../host/actions/registry';
import { fmtMs } from '../format';

/**
 * Provenance is a bipartite graph: artifacts and the executions that turn
 * inputs into outputs. React Flow provides the panning and zooming a
 * non-linear derivation needs; a minimap is intentionally omitted here.
 */

const COL = 300;
const ROW = 104;
const ARTIFACT_W = 230;
const ARTIFACT_H = 74;
const EXEC_W = 248;
const EXEC_H = 62;

type LayoutNode =
  | { kind: 'artifact'; id: string; artifact: Artifact; rank: number; x: number; y: number }
  | { kind: 'exec'; id: string; exec: ActionExecution; rank: number; x: number; y: number };

type ArtifactData = {
  artifact: Artifact;
  focused: boolean;
  color: string;
  typeLabel: string;
  [key: string]: unknown;
};
type ExecutionData = {
  exec: ActionExecution;
  label: string;
  detail: string;
  [key: string]: unknown;
};

function ClockIcon() {
  return <svg className="prov-clock" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M8 4.6v3.7l2.55 1.45" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function ArtifactNode({ data }: NodeProps<Node<ArtifactData>>) {
  const { artifact, focused, color, typeLabel } = data;
  return (
    <div className={`prov-artifact-node${focused ? ' is-focused' : ''}`} style={{ '--prov-color': color } as React.CSSProperties} title={artifact.name}>
      <Handle type="target" position={Position.Left} className="prov-handle" />
      <div className="prov-artifact-title">{displayNameOf(artifact)}</div>
      <div className="prov-artifact-subtitle">
        <span className="chip">{typeLabel}</span>
        {artifact.providerMissing && <span>plugin missing</span>}
      </div>
      <Handle type="source" position={Position.Right} className="prov-handle" />
    </div>
  );
}

function ExecutionNode({ data }: NodeProps<Node<ExecutionData>>) {
  return (
    <div className="prov-execution-node" title={data.label}>
      <Handle type="target" position={Position.Left} className="prov-handle" />
      <div className="prov-execution-title">{data.label}</div>
      <div className="prov-execution-subtitle" title={data.detail}>{data.detail}</div>
      <div className="prov-duration"><ClockIcon />{fmtMs(data.exec.durationMs)}</div>
      <Handle type="source" position={Position.Right} className="prov-handle" />
    </div>
  );
}

const nodeTypes = { artifact: ArtifactNode, execution: ExecutionNode };

function FitView({ nodeCount }: { nodeCount: number }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => fitView({ padding: 0.18, duration: 250, maxZoom: 1.25 }));
    return () => cancelAnimationFrame(frame);
  }, [fitView, nodeCount]);
  return null;
}

/**
 * `execution.inputs` (role -> artifact ids) plus a synthetic `notebook` role
 * when this execution came from a Python Notebook/Script cell
 * (`execution.params.notebook.id`, see `host/notebook/publish.ts`). The
 * notebook/script itself never appears in the real `inputs` — it's code
 * that ran, not data the action consumed — but it belongs in this diagram
 * for the same reason `host/artifact/types.ts`'s `displayParentId` pulls it
 * into the sidebar tree: it's the truer answer to "where did this come
 * from" than the log the code happened to query.
 */
function executionInputPairs(execution: ActionExecution): Array<{ role: string; id: string }> {
  const pairs: Array<{ role: string; id: string }> = [];
  for (const [role, ids] of Object.entries(execution.inputs)) for (const id of ids) pairs.push({ role, id });
  const params = execution.params as { notebook?: { id?: unknown } } | undefined;
  const notebookId = params?.notebook?.id;
  if (typeof notebookId === 'string') pairs.push({ role: 'notebook', id: notebookId });
  return pairs;
}

function provenanceLayout(artifact: Artifact, graph: ProvenanceGraph) {
  const artifactIds = new Set<string>();
  const execIds = new Set<string>();
  const walkUp = (id: string) => {
    if (artifactIds.has(id)) return;
    artifactIds.add(id);
    const producerId = graph.artifacts[id]?.producedBy;
    const execution = producerId ? graph.executions[producerId] : null;
    if (!execution) return;
    execIds.add(execution.id);
    for (const { id: input } of executionInputPairs(execution)) walkUp(input);
  };
  const walkDown = (id: string) => {
    for (const execution of Object.values(graph.executions)) {
      if (!executionInputPairs(execution).some((p) => p.id === id)) continue;
      execIds.add(execution.id);
      for (const output of execution.outputs) {
        if (artifactIds.has(output)) continue;
        artifactIds.add(output);
        walkDown(output);
      }
    }
  };
  walkUp(artifact.id);
  walkDown(artifact.id);

  const key = (kind: 'a' | 'e', id: string) => `${kind}:${id}`;
  const rank = new Map<string, number>();
  for (const id of artifactIds) rank.set(key('a', id), 0);
  for (let pass = 0; pass < artifactIds.size + execIds.size + 2; pass++) {
    let changed = false;
    for (const id of execIds) {
      const execution = graph.executions[id];
      const inputs = executionInputPairs(execution).map((p) => p.id).filter((input) => artifactIds.has(input));
      const r = Math.max(-1, ...inputs.map((input) => rank.get(key('a', input)) ?? 0)) + 1;
      if ((rank.get(key('e', id)) ?? -1) < r) { rank.set(key('e', id), r); changed = true; }
      for (const output of execution.outputs) {
        if (!artifactIds.has(output)) continue;
        if ((rank.get(key('a', output)) ?? -1) < r + 1) { rank.set(key('a', output), r + 1); changed = true; }
      }
    }
    if (!changed) break;
  }

  const byRank = new Map<number, string[]>();
  const add = (entry: string) => {
    const r = rank.get(entry) ?? 0;
    const list = byRank.get(r) ?? [];
    list.push(entry);
    byRank.set(r, list);
  };
  for (const id of artifactIds) add(key('a', id));
  for (const id of execIds) add(key('e', id));

  const layoutNodes = new Map<string, LayoutNode>();
  for (const [r, entries] of [...byRank].sort(([a], [b]) => a - b)) {
    entries.sort((a, b) => a.localeCompare(b));
    entries.forEach((entry, index) => {
      const kind = entry.slice(0, 1) as 'a' | 'e';
      const id = entry.slice(2);
      const x = 20 + r * COL;
      const y = 20 + index * ROW;
      layoutNodes.set(entry, kind === 'a'
        ? { kind: 'artifact', id, artifact: graph.artifacts[id], rank: r, x, y }
        : { kind: 'exec', id, exec: graph.executions[id], rank: r, x, y });
    });
  }

  const nodes: Node[] = [...layoutNodes.values()].map((item) => {
    if (item.kind === 'artifact') {
      const type = artifactTypes.get(item.artifact.type);
      return {
        id: `a:${item.id}`, type: 'artifact', position: { x: item.x, y: item.y }, width: ARTIFACT_W, height: ARTIFACT_H,
        data: { artifact: item.artifact, focused: item.id === artifact.id, color: familyColorOf(item.artifact.type), typeLabel: type.shortLabel } satisfies ArtifactData,
      };
    }
    const definition = actionRegistry.get(item.exec.actionId);
    const parameter = definition ? primaryParam(definition.params) : null;
    const parameterValue = parameter != null ? item.exec.params?.[parameter] : null;
    const detail = [item.exec.runtime.kind, parameter != null && parameterValue != null
      ? `${(definition!.params.properties[parameter].title ?? parameter).toLowerCase()} ${String(parameterValue)}` : ''].filter(Boolean).join(' · ');
    return {
      id: `e:${item.id}`, type: 'execution', position: { x: item.x, y: item.y }, width: EXEC_W, height: EXEC_H,
      data: { exec: item.exec, label: definition?.label ?? item.exec.actionId, detail } satisfies ExecutionData,
    };
  });

  const edges: Edge[] = [];
  for (const executionId of execIds) {
    const execution = graph.executions[executionId];
    for (const { role, id: input } of executionInputPairs(execution)) {
      if (!layoutNodes.has(key('a', input))) continue;
      edges.push({
        id: `in:${input}:${executionId}:${role}`, source: `a:${input}`, target: `e:${executionId}`, label: role,
        labelStyle: { fill: 'var(--text-dim)', fontSize: 10 }, labelBgStyle: { fill: 'var(--bg)', fillOpacity: .88 }, labelBgPadding: [3, 2], labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-dim)', width: 14, height: 14 }, style: { stroke: 'var(--text-dim)', strokeWidth: 1.5, opacity: .66 },
      });
    }
    for (const output of execution.outputs) {
      if (!layoutNodes.has(key('a', output))) continue;
      edges.push({
        id: `out:${executionId}:${output}`, source: `e:${executionId}`, target: `a:${output}`,
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-dim)', width: 14, height: 14 }, style: { stroke: 'var(--text-dim)', strokeWidth: 1.5, opacity: .66 },
      });
    }
  }
  return { nodes, edges, artifactCount: artifactIds.size, executionCount: execIds.size };
}

function ProvenanceFlow({ artifact, graph }: { artifact: Artifact; graph: ProvenanceGraph }) {
  const layout = useMemo(() => provenanceLayout(artifact, graph), [artifact, graph]);
  // React Flow treats supplied nodes as controlled. Keeping their state here
  // is what makes a user's drag update the rendered position instead of
  // snapping back to the computed provenance layout on the next frame.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(layout.nodes);
  useEffect(() => { setNodes(layout.nodes); }, [layout.nodes, setNodes]);
  if (layout.nodes.length <= 1) return <div className="view" style={{ color: 'var(--text-dim)' }}>This artifact was imported and nothing derives from it yet — its provenance is a single node.</div>;
  return (
    <div className="prov-flow-view">
      <div className="prov-flow-stats"><span>{layout.artifactCount} artifacts</span><span>{layout.executionCount} executions</span><span>Drag to explore · click an artifact to select it</span></div>
      <ReactFlow
        nodes={nodes} edges={layout.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
        fitView fitViewOptions={{ padding: 0.18, maxZoom: 1.25 }} minZoom={0.15} maxZoom={2}
        nodesDraggable panOnDrag selectionOnDrag={false} elementsSelectable
        onNodeClick={(_event, node) => { const data = node.data as Partial<ArtifactData>; if (data.artifact) artifactFocus.request(data.artifact.id); }}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="var(--border)" />
        <Controls showInteractive={false} />
        <FitView nodeCount={layout.nodes.length} />
      </ReactFlow>
    </div>
  );
}

export function ProvenanceView({ artifact, graph }: { artifact: Artifact; graph: ProvenanceGraph; panelId: string }) {
  return <ReactFlowProvider><ProvenanceFlow artifact={artifact} graph={graph} /></ReactFlowProvider>;
}
