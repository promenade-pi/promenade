import type { AgentJournalEntry, AgentPolicy, AgentSource, AgentOp, ConsentDecision } from './types';
import { loadPolicy, savePolicy } from './policy.ts';

/**
 * Agent session state: the policy, the activity journal, and the pending
 * consent questions.
 *
 * This is the part of the design the user actually sees. An agent acting on a
 * workspace through a tab the user has open is only acceptable if the tab
 * keeps saying what is going on — so every call is journaled, whether it was
 * allowed silently or confirmed, and the journal is the same object the
 * toolbar indicator renders from.
 */

const MAX_ENTRIES = 200;

export interface ConsentRequest {
  id: string;
  tool: string;
  op: AgentOp;
  source: AgentSource;
  summary: string;
  args: Record<string, unknown>;
  answer(decision: ConsentDecision): void;
}

class AgentSession {
  private policyValue: AgentPolicy = loadPolicy();
  private entries: AgentJournalEntry[] = [];
  private pendingConsent: ConsentRequest[] = [];
  /** Tools the user waved through for the rest of this page's life. */
  private sessionGrants = new Set<string>();
  private listeners = new Set<() => void>();
  private seq = 0;

  get policy() { return this.policyValue; }

  setPolicy(p: AgentPolicy) {
    if (p === this.policyValue) return;
    this.policyValue = p;
    savePolicy(p);
    // Lowering the setting must not leave earlier blanket grants standing —
    // otherwise "read-only" would still let a previously-granted run through.
    if (p === 'off' || p === 'read') this.sessionGrants.clear();
    this.emit();
  }

  get journal(): readonly AgentJournalEntry[] { return this.entries; }
  get pending(): readonly ConsentRequest[] { return this.pendingConsent; }
  get grants(): ReadonlySet<string> { return this.sessionGrants; }

  hasGrant(tool: string) { return this.sessionGrants.has(tool); }
  revokeGrants() { this.sessionGrants.clear(); this.emit(); }

  /** True while any call is in flight — what the toolbar indicator animates on. */
  get busy() { return this.entries.some((e) => e.state === 'pending'); }

  begin(
    input: { source: AgentSource; tool: string; op: AgentOp; args: Record<string, unknown>; summary: string },
  ): AgentJournalEntry {
    const entry: AgentJournalEntry = {
      id: `ag_${Date.now().toString(36)}_${(++this.seq).toString(36)}`,
      at: Date.now(),
      state: 'pending',
      ...input,
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    this.emit();
    return entry;
  }

  settle(id: string, patch: Partial<AgentJournalEntry>) {
    this.entries = this.entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
    this.emit();
  }

  clearJournal() { this.entries = []; this.emit(); }

  /**
   * Asks the user about one call.
   *
   * Resolves `false` immediately when nothing is listening: a headless context
   * (a test page, a torn-down UI) must refuse rather than hang an agent's tool
   * call on a dialog that will never be rendered.
   */
  requestConsent(
    req: Omit<ConsentRequest, 'id' | 'answer'>,
  ): Promise<{ granted: boolean; remember: boolean }> {
    if (!this.listeners.size) {
      return Promise.resolve({ granted: false, remember: false });
    }
    return new Promise((resolve) => {
      const id = `cq_${Date.now().toString(36)}_${(++this.seq).toString(36)}`;
      const entry: ConsentRequest = {
        ...req,
        id,
        answer: (decision) => {
          this.pendingConsent = this.pendingConsent.filter((p) => p.id !== id);
          if (decision === 'session') this.sessionGrants.add(req.tool);
          this.emit();
          resolve({ granted: decision !== 'deny', remember: decision === 'session' });
        },
      };
      this.pendingConsent = [...this.pendingConsent, entry];
      this.emit();
    });
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
      // The last listener leaving means no UI can answer any longer. Anything
      // still waiting is denied rather than left pending forever.
      if (!this.listeners.size) for (const p of [...this.pendingConsent]) p.answer('deny');
    };
  }

  private emit() { for (const l of [...this.listeners]) l(); }
}

export const agentSession = new AgentSession();
