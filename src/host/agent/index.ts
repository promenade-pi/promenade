/**
 * The agent layer's start-up.
 *
 * App.tsx binds the host, then calls `startAgentLayer()`. The bridge is always
 * installed (it enforces the policy rather than replacing it); WebMCP
 * registration follows the policy, so switching agent access off withdraws the
 * tools instead of leaving them there to refuse every call.
 */

import { agentSession } from './session';
import { installBridge } from './bridge';
import { syncWebMcp, unregisterWebMcpTools } from './webmcp';

export function startAgentLayer(): () => void {
  const removeBridge = installBridge();
  let last = agentSession.policy;
  syncWebMcp();
  const unsubscribe = agentSession.subscribe(() => {
    if (agentSession.policy === last) return;
    last = agentSession.policy;
    syncWebMcp();
  });
  return () => {
    unsubscribe();
    unregisterWebMcpTools();
    removeBridge();
  };
}

export { agentSession } from './session';
export { bindAgentHost } from './host';
export { agentTools, callTool, toolDescriptors } from './tools';
export { promenadeApi } from './api';
export { webMcpStatus, syncWebMcp } from './webmcp';
export { decide, loadPolicy, POLICY_LABEL, OP_LABEL } from './policy';
export type { AgentPolicy, AgentOp, AgentJournalEntry, AgentHost } from './types';
