/**
 * The Promenade Agent API — types.
 *
 * One semantic API, several transports. The React UI, WebMCP
 * (`navigator.modelContext`), an MCP bridge relaying a tab's tools to a
 * desktop client, and a future Promenade Compute MCP server are all *callers*
 * of the same operations, not four separate implementations of them.
 *
 * The API is deliberately small and stable: a dozen meta-tools over the
 * artifact graph, the action registry, the view registry and the plugin
 * registry — not one tool per plugin. A workspace with two hundred installed
 * ProM-style plugins must not present an agent with two hundred tools; it
 * presents `list_actions` and `run_action`, and the plugin ecosystem stays a
 * *data* answer rather than a schema explosion.
 *
 * See docs/promenade-agent-api.md.
 */

import type { Artifact, ArtifactId, ProvenanceGraph } from '../artifact/types';

/**
 * What a call *does*, which is the only thing consent has to reason about.
 *
 * Deliberately coarser than the tool list: the user is asked to think about
 * kinds of consequence ("this will install foreign code", "this will delete
 * data"), not to memorise which of seventeen tool names is dangerous.
 */
export type AgentOp =
  /** Reads workspace state. No side effect at all. */
  | 'read'
  /** Changes what the user is looking at: opens a view, moves the selection. */
  | 'ui'
  /** Small, reversible metadata change — a rename. */
  | 'write'
  /** Spends real compute and writes an artifact: run an action, import a log. */
  | 'run'
  /** Installs or removes foreign code. */
  | 'install'
  /** Irreversibly removes data. */
  | 'destructive';

/**
 * How much an agent may do without asking.
 *
 * `ask` is the default because the interesting failure is not a malicious
 * agent, it is a confused one: a tab left open, a tool call the user did not
 * expect, and a workspace that quietly changed underneath them.
 */
export type AgentPolicy = 'off' | 'read' | 'ask' | 'allow';

/** Which transport made a call. Recorded on every journal entry. */
export type AgentSource = 'webmcp' | 'bridge' | 'ui';

export type ConsentDecision = 'once' | 'session' | 'deny';

export interface AgentToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface AgentTool {
  /** MCP tool name. Prefixed, because an agent sees more than one page's tools. */
  name: string;
  description: string;
  op: AgentOp;
  inputSchema: AgentToolSchema;
  /**
   * One line for the journal and the consent prompt, computed from the
   * arguments *before* the call runs. This is what makes "what is happening
   * right now" answerable in the UI without the user reading JSON.
   */
  summarize(args: Record<string, unknown>): string;
  /** May be synchronous; the dispatcher awaits either way. */
  run(args: Record<string, unknown>): unknown;
}

/** MCP-shaped result, so a bridge can relay it without translating. */
export interface AgentCallResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface AgentJournalEntry {
  id: string;
  at: number;
  source: AgentSource;
  tool: string;
  op: AgentOp;
  args: Record<string, unknown>;
  summary: string;
  state: 'pending' | 'ok' | 'error' | 'denied';
  durationMs?: number;
  /** Short, human-readable outcome — "3 artifacts", "installed 0.2.0". */
  outcome?: string;
  error?: string;
}

/**
 * What the host (App.tsx) has to provide.
 *
 * The provenance graph, the open tabs and the selection live in React state,
 * so the agent layer cannot own them — it borrows them through this binding.
 * Everything here is something the UI already does when a human clicks;
 * nothing in this interface is an agent-only code path, which is the point:
 * an agent-run action must land in the workspace exactly as a clicked one
 * does, or the two would drift.
 */
export interface AgentHost {
  getGraph(): ProvenanceGraph;
  getSelection(): ArtifactId[];
  setSelection(ids: ArtifactId[]): void;
  getOpenViews(): Array<{ artifactId: string; view: string; title: string }>;
  getWorkspace(): { id: string; name: string };
  openView(artifact: Artifact, viewId: string, params?: Record<string, unknown>): void;
  /** Resolves to the produced artifact's id, or undefined for a view-only action. */
  runAction(
    actionId: string,
    opts: {
      /** Undefined only for a manufacturing action (`inputs: []`) — its own
       * `file` param carries everything, so no artifact is ever selected. */
      input: Artifact | undefined;
      inputs?: Record<string, ArtifactId[]>;
      params?: Record<string, unknown>;
    },
  ): Promise<string | undefined>;
  /** The live-parameter loop: recompute one artifact in place. */
  recompute(artifact: Artifact, params: Record<string, unknown>): Promise<void>;
  renameArtifact(id: ArtifactId, name: string): Promise<void>;
  deleteArtifact(id: ArtifactId): Promise<void>;
  importSample(sampleId: string): Promise<string | undefined>;
  /** Re-reads the installed set after an install or removal. */
  pluginsChanged(): Promise<void>;
  removePlugin(id: string): Promise<void>;
}
