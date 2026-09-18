/**
 * The one path a tool call takes, whatever transport asked for it.
 *
 * Split out from the catalog so the part that decides *whether* a call may
 * happen has no dependency on the app at all — it can be exercised on its own,
 * with a stub tool, in a plain Node test. A permission model that can only be
 * checked by clicking through the UI is one nobody re-checks after a refactor.
 */

import type { AgentCallResult, AgentJournalEntry, AgentSource, AgentTool } from './types';
import { agentSession } from './session.ts';
import { decide, denyReason } from './policy.ts';

export function ok(value: unknown): AgentCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value ?? { ok: true }, null, 2) }],
    structuredContent: value ?? undefined,
  };
}

export function fail(message: string): AgentCallResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** A short outcome line for the journal — what the user reads, not the payload. */
function outcomeOf(tool: AgentTool, value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value.artifacts)) return `${value.total ?? value.artifacts.length} artifacts`;
  if (Array.isArray(value.actions)) return `${value.actions.length} actions`;
  if (Array.isArray(value.results)) return `${value.results.length} registry hits`;
  if (Array.isArray(value.plugins)) return `${value.plugins.length} plugins`;
  if (Array.isArray(value.rows)) return `${value.rowCount ?? value.rows.length} rows`;
  if (value.artifact?.name) return `→ ${value.artifact.name}`;
  if (tool.op === 'install' && value.version) return `${value.pluginId} ${value.version}`;
  if (value.viewId) return `opened ${value.viewId}`;
  return undefined;
}

export async function dispatch(
  tool: AgentTool, rawArgs: unknown, source: AgentSource,
): Promise<AgentCallResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  let summary = tool.name;
  try { summary = tool.summarize(args); } catch {}

  const verdict = decide(tool.op, agentSession.policy);
  let entry: AgentJournalEntry;

  if (verdict === 'deny') {
    entry = agentSession.begin({ source, tool: tool.name, op: tool.op, args, summary });
    const reason = denyReason(tool.op, agentSession.policy);
    agentSession.settle(entry.id, { state: 'denied', error: reason, durationMs: 0 });
    return fail(reason);
  }

  // A session grant is per tool, given by the user in the consent dialog. It
  // never widens the *policy*: lowering the setting clears every grant.
  if (verdict === 'ask' && !agentSession.hasGrant(tool.name)) {
    const { granted } = await agentSession.requestConsent({
      tool: tool.name, op: tool.op, source, summary, args,
    });
    if (!granted) {
      entry = agentSession.begin({ source, tool: tool.name, op: tool.op, args, summary });
      agentSession.settle(entry.id, {
        state: 'denied', error: 'The user declined this call.', durationMs: 0,
      });
      return fail(`The user declined: ${summary}.`);
    }
  }

  entry = agentSession.begin({ source, tool: tool.name, op: tool.op, args, summary });
  const started = Date.now();
  try {
    const value = await tool.run(args);
    agentSession.settle(entry.id, {
      state: 'ok', durationMs: Date.now() - started, outcome: outcomeOf(tool, value),
    });
    return ok(value);
  } catch (e: any) {
    const message = e?.message ?? String(e);
    agentSession.settle(entry.id, { state: 'error', durationMs: Date.now() - started, error: message });
    return fail(message);
  }
}
