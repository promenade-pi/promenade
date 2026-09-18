import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { actionRegistry, defaultParams } from '../host/actions/registry';
import { ParamControls } from './ParamControls';

/**
 * Runs a manufacturing action (`inputs: []`) with no artifact selected —
 * the counterpart to `openStandaloneView` for an *action* rather than a
 * plugin-bundled authoring view. Its own params (typically including a
 * `file` one) are collected right here instead of in a sandboxed iframe,
 * since this dialog is host UI, not plugin-supplied code. Execution itself
 * is delegated to `onRun` (the same dispatcher `Inspector`'s Run button
 * uses) so the artifact-graph/quota/view-opening tail stays in one place.
 */
export function RunActionDialog({ actionId, onClose, onRun }: {
  actionId: string;
  onClose: () => void;
  onRun: (actionId: string, params: Record<string, unknown>) => Promise<string | undefined>;
}) {
  const def = actionRegistry.get(actionId);
  const [params, setParams] = useState<Record<string, unknown>>(() => defaultParams(def?.params ?? { type: 'object', properties: {} }));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, running]);

  if (!def) return null;

  const run = async () => {
    const missing = (def.params.required ?? []).filter((key) => params[key] == null || params[key] === '');
    if (missing.length > 0) {
      setError(`missing ${missing.map((key) => def.params.properties[key]?.title ?? key).join(', ')}`);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const artifactId = await onRun(actionId, params);
      if (artifactId) onClose();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setRunning(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={def.label}>
        <div className="modal-title">{def.label}</div>
        {def.description && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{def.description}</div>}
        <ParamControls schema={def.params} values={params} disabled={running}
          onChange={(key, value) => setParams((prev) => ({ ...prev, [key]: value }))} />
        {error && <div style={{ color: 'var(--danger, #c0392b)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={running}>Cancel</button>
          <button onClick={run} disabled={running} className="primary">{running ? 'Running…' : 'Run'}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
