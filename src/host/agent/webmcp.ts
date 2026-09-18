/**
 * WebMCP adapter — `navigator.modelContext`.
 *
 * WebMCP is the browser-side half of MCP: a page declares real tools, and a
 * browser-integrated agent (or an extension bridging them out to a desktop MCP
 * client) calls them directly instead of reading screenshots and clicking
 * buttons. For Promenade that is exactly the missing layer, because the data an
 * agent would want — OPFS, DuckDB-Wasm, the artifact DAG, the installed
 * plugins — never leaves the tab. A remote MCP server would see none of it.
 *
 * This adapter is deliberately thin: it maps the catalog in `tools.ts` onto
 * whichever registration API the browser offers, and it takes the tools *away*
 * again when the user switches agent access off. That last part matters — with
 * the tools withdrawn, an agent is told the page offers nothing, rather than
 * being refused call by call.
 *
 * Spec: https://webmachinelearning.github.io/webmcp/docs/proposal.html
 */

import { agentTools, callTool } from './tools';
import { agentSession } from './session';
import { actionRegistry } from '../actions/registry';

interface ModelContext {
  registerTool?(tool: unknown): unknown;
  unregisterTool?(name: string): unknown;
  provideContext?(ctx: { tools: unknown[] }): unknown;
}

function modelContext(): ModelContext | null {
  const mc = (navigator as any)?.modelContext;
  return mc && typeof mc === 'object' ? (mc as ModelContext) : null;
}

export interface WebMcpStatus {
  /** Whether this browser exposes `navigator.modelContext` at all. */
  supported: boolean;
  registered: boolean;
  toolCount: number;
  method: 'provideContext' | 'registerTool' | null;
  note?: string;
}

let registered: string[] = [];
let method: WebMcpStatus['method'] = null;
let unsubscribeActions: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The one tool whose schema follows page state.
 *
 * Everything else is stable by design, but `actionId` is worth pinning to what
 * is actually installed right now: it turns "guess an id" into "pick from this
 * list", and it means installing a plugin visibly widens what the agent may do.
 */
function describe(tool: (typeof agentTools)[number]) {
  const inputSchema = tool.name === 'promenade_run_action'
    ? {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          actionId: {
            ...(tool.inputSchema.properties.actionId as object),
            enum: actionRegistry.all().filter((a) => !a.internal && a.implemented !== false)
              .map((a) => a.id).slice(0, 120),
          },
        },
      }
    : tool.inputSchema;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    annotations: {
      readOnlyHint: tool.op === 'read',
      destructiveHint: tool.op === 'destructive',
    },
    execute: async (args: unknown) => callTool(tool.name, args, 'webmcp'),
  };
}

export function registerWebMcpTools(): WebMcpStatus {
  const mc = modelContext();
  if (!mc) return { supported: false, registered: false, toolCount: 0, method: null };

  const descriptors = agentTools.map(describe);
  try {
    if (typeof mc.provideContext === 'function') {
      // Replaces the page's whole tool set in one call, which is what we want:
      // a refresh must not leave a previous registration's stale copy behind.
      mc.provideContext({ tools: descriptors });
      method = 'provideContext';
    } else if (typeof mc.registerTool === 'function') {
      for (const name of registered) { try { mc.unregisterTool?.(name); } catch {} }
      for (const d of descriptors) mc.registerTool(d);
      method = 'registerTool';
    } else {
      return {
        supported: true, registered: false, toolCount: 0, method: null,
        note: 'navigator.modelContext exists but offers neither provideContext nor registerTool.',
      };
    }
  } catch (e: any) {
    return {
      supported: true, registered: false, toolCount: 0, method: null,
      note: `registration failed: ${e?.message ?? e}`,
    };
  }

  registered = descriptors.map((d) => d.name);

  // Re-register when the installed action set changes, so the run_action enum
  // above keeps up with plugins installed during the session.
  unsubscribeActions ??= actionRegistry.subscribe(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (registered.length) registerWebMcpTools(); }, 250);
  });

  return { supported: true, registered: true, toolCount: registered.length, method };
}

export function unregisterWebMcpTools() {
  const mc = modelContext();
  if (mc) {
    try {
      if (typeof mc.unregisterTool === 'function') {
        for (const name of registered) mc.unregisterTool(name);
      } else if (typeof mc.provideContext === 'function') {
        mc.provideContext({ tools: [] });
      }
    } catch {}
  }
  registered = [];
  unsubscribeActions?.();
  unsubscribeActions = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}

export function webMcpStatus(): WebMcpStatus {
  const mc = modelContext();
  if (!mc) {
    return {
      supported: false, registered: false, toolCount: 0, method: null,
      note: 'This browser has no navigator.modelContext. The window.promenadeAgent bridge still works.',
    };
  }
  return { supported: true, registered: registered.length > 0, toolCount: registered.length, method };
}

/** Registration follows the user's setting: `off` really does take the tools away. */
export function syncWebMcp(): WebMcpStatus {
  if (agentSession.policy === 'off') {
    unregisterWebMcpTools();
    return { ...webMcpStatus(), note: 'Agent access is off; no tools are offered to this browser.' };
  }
  return registerWebMcpTools();
}
