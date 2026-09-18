/**
 * The `ProcessTree` payload contract.
 *
 * This file is the point of the whole exercise. A miner and a viewer must
 * agree on something, and the thing they agree on is the **artifact type** —
 * not each other. `ProcessTree` is the contract; the Inductive Miner knows it
 * produces one and knows nothing about who might draw it, and a viewer knows
 * it draws one and nothing about who produced it. That is what makes a second
 * tree-producing plugin work with the existing viewer on the day it is
 * installed, and a second viewer work with the existing miner.
 *
 * The type is registered in `core`, not by a plugin, for the same reason a
 * file format is not owned by one program: if the miner owned the type,
 * removing the miner would take the meaning of every tree in the workspace
 * with it.
 *
 * Shape notes:
 *  - A flat node array with index references, not nested objects. It clones
 *    cheaply across the sandboxed-view boundary and a viewer can walk it
 *    without recursion if it wants to.
 *  - `operator: null` and `label: null` together mean a silent (tau) leaf.
 *    pm4py represents it that way and so does every other tool worth
 *    interoperating with.
 */

export type ProcessTreeOperator =
  | 'sequence' | 'xor' | 'parallel' | 'loop' | 'or'
  | 'interleaving' | 'partialorder';

export interface ProcessTreeNode {
  /** Null for a leaf. */
  operator: ProcessTreeOperator | null;
  /** Activity name for a labeled leaf; null for an operator or a tau leaf. */
  label: string | null;
  children: number[];
}

export interface ProcessTreePayload {
  /** Index of the root node in `nodes`. */
  root: number;
  nodes: ProcessTreeNode[];
  /** Activity labels in the tree, for the color registry. */
  activities: string[];
  stats?: Record<string, unknown>;
}

/** Notation used by pm4py's `str(tree)` and readable enough to show a user. */
export const OPERATOR_SYMBOL: Record<ProcessTreeOperator, string> = {
  sequence: '→',
  xor: '×',
  parallel: '∧',
  loop: '↻',
  or: '∨',
  interleaving: '↔',
  partialorder: '⊑',
};

export const OPERATOR_NAME: Record<ProcessTreeOperator, string> = {
  sequence: 'Sequence',
  xor: 'Exclusive choice',
  parallel: 'Parallel',
  loop: 'Loop',
  or: 'Inclusive choice',
  interleaving: 'Interleaving',
  partialorder: 'Partial order',
};

/**
 * Validates a payload claiming to be a process tree.
 *
 * A type id is an assertion by whoever produced the artifact, and a plugin can
 * be wrong or malicious. A viewer that trusts the shape and then crashes takes
 * the panel down with it, so the host checks the contract at the boundary
 * rather than leaving every viewer to re-derive it.
 */
export function validateProcessTree(v: unknown): string | null {
  const p = v as ProcessTreePayload;
  if (!p || typeof p !== 'object') return 'not an object';
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) return 'no nodes';
  if (typeof p.root !== 'number' || !p.nodes[p.root]) return 'root out of range';
  for (let i = 0; i < p.nodes.length; i++) {
    const n = p.nodes[i];
    if (!n || typeof n !== 'object') return `node ${i} is not an object`;
    if (!Array.isArray(n.children)) return `node ${i} has no children array`;
    for (const c of n.children) {
      if (typeof c !== 'number' || !p.nodes[c]) return `node ${i} references node ${c}`;
      if (c === i) return `node ${i} is its own child`;
    }
    if (n.operator == null && n.children.length > 0) return `leaf ${i} has children`;
  }
  // Reachability doubles as a cycle check: a walk that revisits a node in a
  // structure this size is a cycle, and a cyclic "tree" hangs any renderer.
  const seen = new Set<number>();
  const stack = [p.root];
  while (stack.length) {
    const i = stack.pop()!;
    if (seen.has(i)) return 'cycle in the tree';
    seen.add(i);
    stack.push(...p.nodes[i].children);
  }
  return null;
}

/** Human-readable form, the same notation pm4py prints. */
export function formatProcessTree(p: ProcessTreePayload, at = p.root): string {
  const n = p.nodes[at];
  if (!n) return '?';
  if (n.operator == null) return n.label == null ? 'tau' : `'${n.label}'`;
  return `${OPERATOR_SYMBOL[n.operator]}( ${n.children.map((c) => formatProcessTree(p, c)).join(', ')} )`;
}
