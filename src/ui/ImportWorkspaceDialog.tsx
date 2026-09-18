import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParsedWorkspaceBundle } from '../host/data/workspaceBundle';
import type { InstalledPlugin } from '../host/plugins/store';
import { compareVersions } from '../host/plugins/registry';

function pluginStatus(id: string, bundledVersion: string, installed: InstalledPlugin[]) {
  const found = installed.find((p) => p.manifest.id === id);
  if (!found) return { label: 'not installed', tone: 'warn' as const };
  const cmp = compareVersions(found.manifest.version, bundledVersion);
  if (cmp === 0) return { label: `installed v${found.manifest.version}`, tone: 'ok' as const };
  return { label: `installed v${found.manifest.version} — ${cmp < 0 ? 'older' : 'newer'} than v${bundledVersion}`, tone: 'warn' as const };
}

/**
 * Previews a `.pmworkspace` bundle before committing it as a new workspace.
 * Plugin version differences are shown here only as information — nothing
 * here blocks the import itself; the per-artifact/view version-mismatch
 * warning is what actually gates opening something once it is mismatched.
 */
export function ImportWorkspaceDialog({
  bundle, installedPlugins, onCancel, onImport,
}: {
  bundle: ParsedWorkspaceBundle;
  installedPlugins: InstalledPlugin[];
  onCancel: () => void;
  onImport: (name: string, installLocalPlugins: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(bundle.name);
  const [installLocalPlugins, setInstallLocalPlugins] = useState(true);
  const [working, setWorking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const artifactCount = Object.keys(bundle.artifacts).length;
  const localPluginIds = Object.keys(bundle.localPlugins);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !working) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, working]);

  const confirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setWorking(true);
    try { await onImport(trimmed, installLocalPlugins); }
    finally { setWorking(false); }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onCancel(); }}>
      <div className="modal workspace-bundle-dialog" role="dialog" aria-modal="true">
        <div className="modal-title">Import workspace</div>
        <input
          ref={inputRef}
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          placeholder="Workspace name"
        />
        <p className="storage-detail-muted" style={{ marginTop: 10 }}>
          {artifactCount} artifact{artifactCount === 1 ? '' : 's'} with their Parquet data, saved views,
          and view/algorithm parameters.
        </p>

        {Object.keys(bundle.pluginVersions).length > 0 && (
          <div className="workspace-bundle-plugin-list">
            {Object.entries(bundle.pluginVersions).map(([id, version]) => {
              const status = pluginStatus(id, version, installedPlugins);
              return (
                <div key={id} className={`workspace-bundle-plugin-row ${status.tone}`}>
                  <span>{id}</span>
                  <span>v{version} · {status.label}</span>
                </div>
              );
            })}
          </div>
        )}

        {localPluginIds.length > 0 && (
          <label className="workspace-bundle-checkbox">
            <input
              type="checkbox"
              checked={installLocalPlugins}
              onChange={(e) => setInstallLocalPlugins(e.target.checked)}
            />
            <span>
              Install {localPluginIds.length} locally-sourced plugin{localPluginIds.length === 1 ? '' : 's'} bundled with this workspace
              <small>{localPluginIds.join(', ')}</small>
            </span>
          </label>
        )}

        <div className="modal-actions">
          <button disabled={working} onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={working || !name.trim()} onClick={confirm}>
            {working ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
