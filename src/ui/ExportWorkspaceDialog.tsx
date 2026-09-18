import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LocalPluginSummary {
  id: string;
  name: string;
}

/**
 * Exports the active workspace as a `.pmworkspace` bundle: its catalog
 * (artifacts, executions, saved views), every artifact's Parquet files, and
 * the version of every plugin that produced something in it. Locally
 * installed plugins — the ones with no registry or bundled source to
 * reinstall from — can optionally be bundled too, so the workspace stays
 * fully self-contained on another machine.
 */
export function ExportWorkspaceDialog({
  workspaceName, artifactCount, localPlugins, onCancel, onExport,
}: {
  workspaceName: string;
  artifactCount: number;
  /** Locally-sourced plugins that produced something in this workspace —
   * the only ones worth offering to bundle. Empty hides the checkbox. */
  localPlugins: LocalPluginSummary[];
  onCancel: () => void;
  onExport: (includeLocalPlugins: boolean) => Promise<void>;
}) {
  const [includeLocalPlugins, setIncludeLocalPlugins] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !working) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, working]);

  const confirm = async () => {
    setWorking(true);
    try { await onExport(localPlugins.length > 0 && includeLocalPlugins); }
    finally { setWorking(false); }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onCancel(); }}>
      <div className="modal workspace-bundle-dialog" role="dialog" aria-modal="true">
        <div className="modal-title">Export workspace</div>
        <p className="storage-detail-muted">
          Bundles "{workspaceName}" — {artifactCount} artifact{artifactCount === 1 ? '' : 's'} with their
          Parquet data, saved views, and view/algorithm parameters — plus the version of every plugin
          that produced something in it.
        </p>
        {localPlugins.length > 0 && (
          <label className="workspace-bundle-checkbox">
            <input
              type="checkbox"
              checked={includeLocalPlugins}
              onChange={(e) => setIncludeLocalPlugins(e.target.checked)}
            />
            <span>
              Include {localPlugins.length} locally-installed plugin{localPlugins.length === 1 ? '' : 's'}
              <small>{localPlugins.map((p) => p.name).join(', ')} — not available from a registry, so the
                bundle is only fully self-contained with these included.</small>
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button disabled={working} onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={working} onClick={confirm}>
            {working ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
