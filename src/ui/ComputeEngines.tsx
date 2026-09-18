import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addEngine, listEngines, refreshEngine, removeEngine, testConnection, type ComputeEngine } from '../host/compute/engines';

type BrowserEngineReport = {
  bundle?: string;
  threads?: number;
  memory_limit?: string | number;
  spilling?: string | boolean;
} | null;

/** A small product mark for the Promenade Compute surface. */
export function ComputeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <rect x="2.25" y="2.25" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.25" y="2.25" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="7.75" y="13.25" width="4.5" height="4.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.75 4.5h6.5M4.5 6.75v3.5l5.5 3M15.5 6.75v3.5l-5.5 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRight() {
  return <span className="compute-chevron" aria-hidden="true">›</span>;
}

function browserValue(value: unknown) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function dotClass(status: ComputeEngine['status']) {
  return status === 'reachable' ? 'ready' : status === 'unreachable' ? 'error' : 'muted';
}

/** The compact status surface in the top bar. */
export function ComputeStatusPopover({
  report, onClose, onManage,
}: {
  report: BrowserEngineReport;
  onClose: () => void;
  onManage: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [engines, setEngines] = useState<ComputeEngine[]>(() => listEngines());

  useEffect(() => {
    let canceled = false;
    Promise.all(engines.map((e) => refreshEngine(e.id))).then(() => {
      if (!canceled) setEngines(listEngines());
    });
    return () => { canceled = true; };
    // Refresh once, on open — a live poller here would outlive the popover's
    // short lifetime for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="compute-status-popover" ref={root} role="dialog" aria-label="Promenade Compute status">
      <div className="compute-status-heading"><ComputeIcon /> <span>Promenade Compute</span></div>

      <section className="compute-status-section">
        <h4>Browser engine</h4>
        <div className="compute-browser-card">
          <div className="compute-engine-status"><span className="compute-dot ready" /> <strong>Browser (WASM)</strong><span>Ready</span></div>
          <div className="compute-browser-details">
            <span>Bundle</span><b>{browserValue(report?.bundle)}</b>
            <span>Threads</span><b>{browserValue(report?.threads)}</b>
            <span>Memory limit</span><b>{browserValue(report?.memory_limit)}</b>
            <span>Spilling</span><b>{browserValue(report?.spilling ?? 'none')}</b>
          </div>
        </div>
      </section>

      <section className="compute-status-section">
        <h4>Compute engines</h4>
        {engines.length === 0 ? (
          <div className="compute-empty-state">
            <span className="compute-dot muted" />
            <div><strong>Not configured</strong><small>Add one from "Manage" below.</small></div>
          </div>
        ) : (
          <div className="compute-engine-list">
            {engines.map((e) => (
              <div className="compute-engine-status" key={e.id}>
                <span className={`compute-dot ${dotClass(e.status)}`} />
                <strong>{e.name}</strong>
                <span style={{ color: e.status === 'unreachable' ? 'var(--danger, #c0392b)' : undefined }}>
                  {e.status === 'reachable' ? 'Ready' : e.status === 'unreachable' ? 'Unreachable' : 'Unknown'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <button className="compute-manage-button" onClick={onManage}>
        <ComputeIcon size={16} /> <span>Manage Promenade Compute engines…</span><ChevronRight />
      </button>
    </div>
  );
}

export function ComputeEnginesDialog({ onClose }: { onClose: () => void }) {
  const [engines, setEngines] = useState<ComputeEngine[]>(() => listEngines());
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('http://localhost:7420');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testConnection(endpoint);
    setTesting(false);
    if (result.ok) {
      const caps = result.capabilities;
      setTestResult({ ok: true, message: `Reachable — ${caps.wasmTargets.join(', ') || 'no wasm targets reported'}, ${caps.threads} threads` });
    } else {
      const message: string = result.ok === false ? result.error : 'unknown error';
      setTestResult({ ok: false, message });
    }
  };

  const submitAdd = () => {
    addEngine(name, endpoint);
    setEngines(listEngines());
    setAdding(false);
    setName('');
    setTestResult(null);
    const added = listEngines().at(-1);
    if (added) {
      setBusyId(added.id);
      refreshEngine(added.id).then(() => { setEngines(listEngines()); setBusyId(null); });
    }
  };

  const doRefresh = async (id: string) => {
    setBusyId(id);
    await refreshEngine(id);
    setEngines(listEngines());
    setBusyId(null);
  };

  const doRemove = (id: string) => {
    removeEngine(id);
    setEngines(listEngines());
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal compute-engines-dialog" role="dialog" aria-modal="true" aria-label="Compute engines">
        <div className="compute-dialog-head">
          <div>
            <div className="modal-title">Compute engines</div>
            <p>Connect to a local or remote Promenade Compute engine (see <code>compute/README.md</code>).</p>
          </div>
          <div className="compute-dialog-head-actions">
            {!adding && <button className="compute-add-button" onClick={() => setAdding(true)}><span aria-hidden="true">＋</span> Add engine</button>}
            <button className="compute-dialog-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>

        <div className="compute-dialog-body">
          {adding && (
            <div className="compute-add-form">
              <label>
                <span>Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Local Docker" autoFocus />
              </label>
              <label>
                <span>Endpoint</span>
                <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:7420" />
              </label>
              {testResult && (
                <div className={`compute-test-result ${testResult.ok ? 'ok' : 'error'}`}>
                  <span className={`compute-dot ${testResult.ok ? 'ready' : 'error'}`} />
                  {testResult.message}
                </div>
              )}
              <div className="compute-add-form-actions">
                <button onClick={runTest} disabled={testing || !endpoint.trim()}>{testing ? 'Testing…' : 'Test Connection'}</button>
                <button className="primary" onClick={submitAdd} disabled={!endpoint.trim()}>Add</button>
                <button onClick={() => { setAdding(false); setTestResult(null); }}>Cancel</button>
              </div>
            </div>
          )}

          {engines.length === 0 && !adding ? (
            <div className="compute-unconfigured-card">
              <div className="compute-unconfigured-icon"><ComputeIcon size={26} /></div>
              <div>
                <strong>No compute engines configured</strong>
                <p>Run <code>docker build -t promenade-compute:0.1.0 compute && docker run -p 7420:7420 promenade-compute:0.1.0</code>, then add it here.</p>
              </div>
            </div>
          ) : (
            <div className="compute-engine-list compute-engine-list--dialog">
              {engines.map((e) => (
                <div className="compute-engine-row" key={e.id}>
                  <span className={`compute-dot ${dotClass(e.status)}`} />
                  <div className="compute-engine-row-main">
                    <strong>{e.name}</strong>
                    <span className="compute-engine-endpoint">{e.endpoint}</span>
                    {e.status === 'unreachable' && e.lastError && <span className="compute-engine-error">{e.lastError}</span>}
                    {e.capabilities && (
                      <span className="compute-engine-caps">
                        {e.capabilities.threads} threads · {e.capabilities.maxMemoryMb} MB · {e.capabilities.wasmTargets.join(', ')}
                      </span>
                    )}
                  </div>
                  <button onClick={() => doRefresh(e.id)} disabled={busyId === e.id}>{busyId === e.id ? '…' : 'Test'}</button>
                  <button onClick={() => doRemove(e.id)}>Remove</button>
                </div>
              ))}
            </div>
          )}

          <div className="compute-dialog-note">
            <span className="compute-dot ready" />
            <div><strong>Local browser engine</strong><span>Always available in this browser; it does not require configuration.</span></div>
          </div>
        </div>

        <div className="modal-actions compute-dialog-actions">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
