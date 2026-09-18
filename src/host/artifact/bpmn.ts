/**
 * The `Bpmn` payload contract.
 *
 * Same role `ocpn.ts` plays for `ObjectCentricPetriNet` and `process-tree.ts`
 * plays for `ProcessTree`: this is the thing a conversion action and a viewer
 * agree on, not each other. Registered in `core` (`registry.ts`) so removing
 * the BPMN plugin degrades an existing diagram instead of erasing what it
 * meant.
 *
 * Mirrors `bpmn-core`'s Rust model field-for-field (see
 * `plugins/bpmn-rs/crates/bpmn-core/src/lib.rs`) — this file and that one are
 * the same contract in two languages, not two independent schemas that
 * happen to agree today.
 *
 * Scope, stated rather than silently approximated: pure control-flow BPMN
 * only — tasks, start/end events, exclusive/parallel/inclusive gateways,
 * sequence flows. No pools/lanes, message flows, sub-processes, or
 * boundary/timer events; none of the four conversions this type exists for
 * (Petri net <-> BPMN, process tree <-> BPMN) need them, and an importer maps
 * anything richer down into this subset with a recorded warning rather than
 * inventing fields nothing else reads.
 *
 * Shape notes:
 *  - No layout coordinates anywhere. Layout is view state, computed by the
 *    graph view at render time, never persisted into the artifact — same
 *    convention as `OcpnPayload`.
 */

export type BpmnNodeKind =
  | 'task'
  | 'startEvent'
  | 'endEvent'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway';

export interface BpmnNode {
  id: string;
  kind: BpmnNodeKind;
  /** Activity name for a task; null for every other kind. */
  label: string | null;
}

export interface BpmnFlow {
  id: string;
  source: string;
  target: string;
  /** Condition expression text, e.g. on a flow leaving an exclusive gateway. */
  label?: string | null;
}

export interface BpmnMetadata {
  sourceType: 'AcceptingPetriNet' | 'ProcessTree' | 'import' | null;
  /**
   * False when a Petri-net-sourced diagram isn't block-structured (the
   * source net wasn't a sound free-choice WF-net) — the diagram is still a
   * valid, behavior-preserving translation, just not the clean single
   * XOR/AND block structure a structured net would have produced.
   */
  structured: boolean;
  /** Human-readable notes about anything approximated, downgraded, or dropped. */
  warnings: string[];
}

export interface BpmnPayload {
  nodes: BpmnNode[];
  flows: BpmnFlow[];
  metadata: BpmnMetadata;
}

const NODE_KINDS: ReadonlySet<string> = new Set<BpmnNodeKind>([
  'task', 'startEvent', 'endEvent', 'exclusiveGateway', 'parallelGateway', 'inclusiveGateway',
]);

/**
 * Validates a payload claiming to be a BPMN diagram — the same boundary
 * check `validateOcpn`/`validateProcessTree` perform for their own types. A
 * conversion or import bug should fail loudly here, at the artifact
 * boundary, rather than reach a viewer that trusts the shape and crashes.
 */
export function validateBpmn(v: unknown): string | null {
  const p = v as BpmnPayload;
  if (!p || typeof p !== 'object') return 'not an object';
  if (!Array.isArray(p.nodes)) return 'no nodes';
  if (!Array.isArray(p.flows)) return 'no flows';
  if (!p.metadata || typeof p.metadata !== 'object') return 'no metadata';

  const nodeIx = new Map(p.nodes.map((n) => [n.id, n]));
  if (nodeIx.size !== p.nodes.length) return 'duplicate node id';

  for (const n of p.nodes) {
    if (!NODE_KINDS.has(n.kind)) return `node ${n.id} has unknown kind ${n.kind}`;
    if (n.kind === 'task' ? n.label == null : n.label != null) {
      return `node ${n.id} (${n.kind}) has an inconsistent label`;
    }
  }
  for (const f of p.flows) {
    if (!nodeIx.has(f.source)) return `flow ${f.id} references unknown source ${f.source}`;
    if (!nodeIx.has(f.target)) return `flow ${f.id} references unknown target ${f.target}`;
  }

  const starts = p.nodes.filter((n) => n.kind === 'startEvent');
  const ends = p.nodes.filter((n) => n.kind === 'endEvent');
  if (starts.length === 0) return 'no start event';
  if (ends.length === 0) return 'no end event';

  return null;
}

/** Summary line for the inspector / tab title, e.g. "12 nodes · 14 flows". */
export function summarizeBpmn(p: BpmnPayload): string {
  const tasks = p.nodes.filter((n) => n.kind === 'task').length;
  const gateways = p.nodes.filter((n) => n.kind.endsWith('Gateway')).length;
  return `${tasks} task${tasks === 1 ? '' : 's'} · ${gateways} gateway${gateways === 1 ? '' : 's'} · ${p.flows.length} flow${p.flows.length === 1 ? '' : 's'}`;
}
