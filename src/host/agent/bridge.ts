/**
 * `window.promenadeAgent` — the same tools, reachable from the page.
 *
 * Two callers need this. A browser extension bridging WebMCP-style tools out to
 * a desktop MCP client (MCP-B and friends) can relay these descriptors 1:1
 * without native `navigator.modelContext` support. And a coding agent driving
 * the app during development can install a plugin, run an action and read the
 * result instead of clicking through the UI to do it.
 *
 * It is *not* a way around the user's setting: every call goes through the same
 * `callTool` dispatch, so the same policy, the same consent prompt and the same
 * journal apply. The bridge deliberately cannot change the policy — that is the
 * user's control, in the toolbar, and an agent that could raise its own
 * permissions would make the setting decorative.
 */

import { agentSession } from './session';
import { callTool, toolDescriptors } from './tools';
import { webMcpStatus } from './webmcp';

export interface PromenadeAgentBridge {
  readonly version: string;
  /** MCP tool descriptors, ready to relay. */
  listTools(): ReturnType<typeof toolDescriptors>;
  /** Calls one tool. Returns an MCP-shaped result; never throws. */
  callTool(name: string, args?: unknown): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  /** Convenience for scripting: resolves to the structured value, throws on error. */
  call(name: string, args?: unknown): Promise<unknown>;
  status(): {
    policy: string;
    webmcp: ReturnType<typeof webMcpStatus>;
    pendingConsent: number;
    busy: boolean;
  };
  journal(limit?: number): unknown[];
  subscribe(fn: () => void): () => void;
}

export const BRIDGE_VERSION = '1.0.0';

export function installBridge(): () => void {
  const bridge: PromenadeAgentBridge = {
    version: BRIDGE_VERSION,
    listTools: () => toolDescriptors(),
    callTool: (name, args) => callTool(name, args, 'bridge'),
    async call(name, args) {
      const result = await callTool(name, args, 'bridge');
      if (result.isError) throw new Error(result.content[0]?.text ?? 'tool call failed');
      return result.structuredContent ?? result.content[0]?.text ?? null;
    },
    status: () => ({
      policy: agentSession.policy,
      webmcp: webMcpStatus(),
      pendingConsent: agentSession.pending.length,
      busy: agentSession.busy,
    }),
    journal: (limit = 25) => agentSession.journal.slice(0, limit).map((e) => ({ ...e })),
    subscribe: (fn) => agentSession.subscribe(fn),
  };

  (window as any).promenadeAgent = bridge;
  return () => {
    if ((window as any).promenadeAgent === bridge) delete (window as any).promenadeAgent;
  };
}
