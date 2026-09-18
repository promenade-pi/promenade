import type { AgentHost } from './types';

/**
 * The host binding.
 *
 * App.tsx calls `bindAgentHost` once, with the same callbacks its own UI uses.
 * Everything else in this directory reaches the workspace only through here,
 * which is what keeps the agent layer from growing a second, divergent copy of
 * "how an action is run" or "how a view is opened".
 */

let host: AgentHost | null = null;
const listeners = new Set<() => void>();

export function bindAgentHost(h: AgentHost) {
  host = h;
  for (const l of [...listeners]) l();
  return () => { if (host === h) { host = null; for (const l of [...listeners]) l(); } };
}

export function agentHostOrNull(): AgentHost | null { return host; }

export function agentHost(): AgentHost {
  if (!host) throw new Error('Promenade is still starting up; no workspace is attached yet.');
  return host;
}

export function onHostChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
