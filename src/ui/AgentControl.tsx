import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { agentSession } from '../host/agent/session';
import { webMcpStatus } from '../host/agent/webmcp';
import { OP_LABEL, POLICY_LABEL } from '../host/agent/policy';
import { agentTools } from '../host/agent/tools';
import type { AgentJournalEntry, AgentPolicy } from '../host/agent/types';

/**
 * The agent surface the *user* sees.
 *
 * An agent driving the workspace through an open tab is only acceptable if the
 * tab keeps saying so. This is that: a toolbar control that shows whether tools
 * are being offered at all, lights up while a call is running, lists what has
 * been called, and asks before anything that changes the workspace.
 *
 * The prompt is the optional part — a user who trusts their agent can set
 * "Allow" and stop being asked. The *journal* is not optional: every call is
 * recorded either way, because "what did it just do" must always be answerable.
 */

export function AgentIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <rect x="3.25" y="6.25" width="13.5" height="10.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 3.25v3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="2.6" r="1.15" fill="currentColor" />
      <circle cx="7.4" cy="10.9" r="1.15" fill="currentColor" />
      <circle cx="12.6" cy="10.9" r="1.15" fill="currentColor" />
      <path d="M7.6 13.9h4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Re-renders whenever the agent session changes. */
function useAgentSession() {
  const [, bump] = useState(0);
  useEffect(() => agentSession.subscribe(() => bump((n) => n + 1)), []);
  return agentSession;
}

function relative(at: number) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function JournalRow({ entry }: { entry: AgentJournalEntry }) {
  return (
    <li className={`agent-journal-row is-${entry.state}`}>
      <span className={`agent-dot is-${entry.state}`} aria-hidden="true" />
      <div>
        <div className="agent-journal-summary">{entry.summary}</div>
        <div className="agent-journal-meta">
          {entry.source} · {OP_LABEL[entry.op]} · {relative(entry.at)}
          {entry.durationMs !== undefined && entry.state === 'ok' ? ` · ${entry.durationMs} ms` : ''}
          {entry.outcome ? ` · ${entry.outcome}` : ''}
        </div>
        {entry.error && <div className="agent-journal-error">{entry.error}</div>}
      </div>
    </li>
  );
}

/**
 * The consent question.
 *
 * Deliberately says the *effect* in the app's own words ("run core.discover.dfg
 * on log_x"), with the raw arguments available but not shouted — a dialog that
 * shows only JSON teaches people to click through it.
 */
function ConsentDialog() {
  const session = useAgentSession();
  const request = session.pending[0];
  const denyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    denyRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') request?.answer('deny'); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request]);

  if (!request) return null;
  const destructive = request.op === 'destructive';

  return createPortal(
    <div className="modal-backdrop">
      <div className="modal agent-consent" role="alertdialog" aria-modal="true">
        <div className="modal-title" style={destructive ? { color: 'var(--danger)' } : undefined}>
          {destructive ? 'An agent wants to delete something' : 'An agent wants to act on this workspace'}
        </div>
        <p className="agent-consent-summary">{request.summary}</p>
        <div className="agent-consent-facts">
          <span>tool</span><b>{request.tool}</b>
          <span>via</span><b>{request.source === 'webmcp' ? 'WebMCP (navigator.modelContext)' : 'page bridge'}</b>
          <span>effect</span><b>{OP_LABEL[request.op]}</b>
        </div>
        {Object.keys(request.args).length > 0 && (
          <details className="agent-consent-args">
            <summary>arguments</summary>
            <pre>{JSON.stringify(request.args, null, 2)}</pre>
          </details>
        )}
        <div className="modal-actions">
          <button ref={denyRef} onClick={() => request.answer('deny')}>Deny</button>
          {!destructive && (
            <button onClick={() => request.answer('session')} title="Stop asking for this tool until the page is reloaded">
              Always this session
            </button>
          )}
          <button
            className="primary"
            style={destructive ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : undefined}
            onClick={() => request.answer('once')}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AgentPopover({ onClose }: { onClose: () => void }) {
  const session = useAgentSession();
  const root = useRef<HTMLDivElement>(null);
  const status = webMcpStatus();

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const grants = [...session.grants];

  return (
    <div className="compute-status-popover agent-popover" ref={root}>
      <div className="compute-status-heading">
        <AgentIcon size={17} />
        <span>Agent access</span>
      </div>

      <div className="agent-status-line">
        <span className={`agent-dot is-${status.registered ? 'ok' : 'muted'}`} aria-hidden="true" />
        <div>
          {status.registered
            ? <><b>{status.toolCount} tools</b> offered to this browser via WebMCP</>
            : status.supported
              ? <>WebMCP available, no tools registered</>
              : <>This browser has no WebMCP support</>}
          <div className="agent-journal-meta">
            {agentTools.length} tools also reachable at <code>window.promenadeAgent</code>
            {status.note ? ` · ${status.note}` : ''}
          </div>
        </div>
      </div>

      <div className="compute-status-section">
        <h4>What agents may do</h4>
        <div className="agent-policy-list">
          {(['off', 'read', 'ask', 'allow'] as AgentPolicy[]).map((p) => (
            <label key={p} className={`agent-policy-option${session.policy === p ? ' is-active' : ''}`}>
              <input
                type="radio" name="agent-policy" checked={session.policy === p}
                onChange={() => agentSession.setPolicy(p)}
              />
              <span>
                <b>{POLICY_LABEL[p]}</b>
                <small>
                  {p === 'off' && 'No tools are offered at all.'}
                  {p === 'read' && 'Reading the workspace only; anything that changes it is refused.'}
                  {p === 'ask' && 'Reads run freely; running actions, installing plugins and deleting ask first.'}
                  {p === 'allow' && 'Everything runs without asking. Deletions are still confirmed.'}
                </small>
              </span>
            </label>
          ))}
        </div>
        {grants.length > 0 && (
          <div className="agent-grants">
            Waved through this session: {grants.join(', ')}
            <button onClick={() => agentSession.revokeGrants()}>Revoke</button>
          </div>
        )}
      </div>

      <div className="compute-status-section">
        <h4>Recent activity</h4>
        {session.journal.length === 0
          ? <div className="compute-empty-state"><div><strong>Nothing yet</strong><small>Tool calls appear here as they happen.</small></div></div>
          : (
            <>
              <ul className="agent-journal">
                {session.journal.slice(0, 30).map((e) => <JournalRow key={e.id} entry={e} />)}
              </ul>
              <button className="agent-clear" onClick={() => agentSession.clearJournal()}>Clear log</button>
            </>
          )}
      </div>
    </div>
  );
}

export function AgentControl({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const session = useAgentSession();
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) =>
    onOpenChange(typeof next === 'function' ? next(open) : next);
  const busy = session.busy;
  const recent = session.journal[0];
  // The chip stays visible for a moment after a call so a fast read is not a
  // flicker the user never sees.
  const active = busy || (recent && Date.now() - recent.at < 4000);

  return (
    <div className="compute-topbar-control agent-topbar-control" onMouseDown={(e) => e.stopPropagation()}>
      <button
        className={`compute-topbar-button agent-topbar-button${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={session.policy === 'off'
          ? 'Agent access is off'
          : `Agent access: ${POLICY_LABEL[session.policy]}${recent ? ` · last: ${recent.summary}` : ''}`}
        aria-label="Agent access"
        aria-expanded={open}
      >
        <span className="compute-topbar-icon-wrap">
          <AgentIcon />
          <span className={`compute-topbar-status agent-topbar-status is-${session.policy === 'off' ? 'off' : active ? 'active' : 'idle'}`} />
        </span>
        <span>AI</span>
      </button>
      {active && !open && recent && (
        <div className="agent-flyout" role="status">
          <span className={`agent-dot is-${recent.state}`} aria-hidden="true" />
          {recent.summary}
        </div>
      )}
      {open && <AgentPopover onClose={() => setOpen(false)} />}
      <ConsentDialog />
    </div>
  );
}
