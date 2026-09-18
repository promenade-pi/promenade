import type { AgentOp, AgentPolicy } from './types';

/**
 * The consent rules, as one pure function.
 *
 * Kept apart from anything that touches the DOM or storage so the rule set is
 * testable on its own — a permission model that can only be exercised by
 * clicking through the app is a permission model nobody re-checks after a
 * refactor.
 */
export type Verdict = 'allow' | 'ask' | 'deny';

export function decide(op: AgentOp, policy: AgentPolicy): Verdict {
  if (policy === 'off') return 'deny';
  if (op === 'read' || op === 'ui') return 'allow';
  if (policy === 'read') return 'deny';
  // `allow` is "don't interrupt me", not "delete without asking": an
  // irreversible removal is the one case where a wrong guess by an agent
  // cannot be undone by re-running anything, so it keeps its prompt.
  if (op === 'destructive') return 'ask';
  return policy === 'allow' ? 'allow' : 'ask';
}

/** Why a `deny` happened, in words an agent can act on. */
export function denyReason(op: AgentOp, policy: AgentPolicy): string {
  if (policy === 'off') {
    return 'Agent access to this Promenade workspace is switched off. '
      + 'The user can enable it from the Agent control in the toolbar.';
  }
  return `Agent access is set to read-only, so the '${op}' operation is refused. `
    + 'The user can raise this to "ask before changes" from the Agent control in the toolbar.';
}

const KEY = 'promenade.agent.policy';

/**
 * Default policy.
 *
 * Development builds default to `allow` because the agent driving them is the
 * developer's own coding assistant automating what they would otherwise click
 * through; a deployed build defaults to `ask`, where the agent is a stranger
 * to the workspace. Both are journaled, and both are one click away from any
 * other setting.
 */
export function defaultPolicy(): AgentPolicy {
  try {
    // Written as the literal Vite replaces at build time. Node (where this
    // module is unit-tested) has no `import.meta.env` at all, so the property
    // read throws and the safe default stands.
    return import.meta.env.DEV ? 'allow' : 'ask';
  } catch {
    return 'ask';
  }
}

export function loadPolicy(): AgentPolicy {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'off' || raw === 'read' || raw === 'ask' || raw === 'allow') return raw;
  } catch {}
  return defaultPolicy();
}

export function savePolicy(p: AgentPolicy) {
  try { localStorage.setItem(KEY, p); } catch {}
}

export const POLICY_LABEL: Record<AgentPolicy, string> = {
  off: 'Off',
  read: 'Read-only',
  ask: 'Ask before changes',
  allow: 'Allow (deletes still ask)',
};

export const OP_LABEL: Record<AgentOp, string> = {
  read: 'reads',
  ui: 'shows',
  write: 'renames',
  run: 'computes',
  install: 'installs code',
  destructive: 'deletes',
};
