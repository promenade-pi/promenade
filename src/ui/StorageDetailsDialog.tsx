import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StorageBreakdown } from '../host/data/opfs';
import { ConfirmDialog } from './ConfirmDialog';
import { fmtBytes } from './format';

type PendingAction = 'orphans' | 'cache' | null;

/**
 * Explains the gap between the origin-wide browser quota and the workspace
 * catalog.  Files in OPFS can be counted exactly; Cache API responses are
 * counted from their Content-Length headers; browser HTTP cache cannot be
 * enumerated by a web app and is shown as unclassified rather than guessed.
 */
export function StorageDetailsDialog({
  breakdown, loading, onClose, onRefresh, onRecoverOrphans, onRemoveOrphans, onClearCacheStorage, onResetWorkspace,
}: {
  breakdown: StorageBreakdown | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  /** Rebuilds catalog entries for orphaned directories; resolves with a summary. */
  onRecoverOrphans: () => Promise<string>;
  onRemoveOrphans: () => Promise<void>;
  onClearCacheStorage: () => Promise<void>;
  onResetWorkspace: () => void;
}) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [working, setWorking] = useState(false);
  const [recovery, setRecovery] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !pending) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const run = async (action: () => Promise<void>) => {
    setPending(null);
    setWorking(true);
    try { await action(); } finally { setWorking(false); }
  };
  const row = (label: string, value: number, detail?: string) => (
    <div className="storage-detail-row" key={label}>
      <div><strong>{label}</strong>{detail && <div>{detail}</div>}</div>
      <span>{fmtBytes(value)}</span>
    </div>
  );
  const cache = breakdown?.cacheStorage;
  const opfs = breakdown?.opfs;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !working) onClose(); }}>
      <div className="modal storage-details-dialog" role="dialog" aria-modal="true" aria-label="Storage details">
        <div className="modal-title">Storage details</div>
        {loading || !breakdown ? (
          <p className="storage-detail-muted">Measuring storage…</p>
        ) : <>
          <p className="storage-detail-muted">
            Browser usage is origin-wide. The values below separate the parts Promenade can inspect;
            the remainder is browser-managed storage that a website cannot enumerate precisely.
          </p>
          <div className="storage-detail-total">
            <strong>{fmtBytes(breakdown.usage)}</strong><span> of {fmtBytes(breakdown.quota)}</span>
          </div>

          <h4>OPFS — this workspace</h4>
          <div className="storage-detail-list">
            {row('Artifacts', opfs!.artifacts, `${fmtBytes(opfs!.activeArtifacts)} referenced by the catalog`)}
            {/* Not "safe to remove". An orphan is a directory the catalog has
                no entry for, and the catalog being wrong is one of the ways
                that happens — in which case these files are the artifacts, and
                deleting them is the one irreversible step. Recovery is offered
                first, and named first. */}
            {row('↳ Orphaned artifacts', opfs!.orphanArtifacts,
              `${opfs!.orphanArtifactDirectories} director${opfs!.orphanArtifactDirectories === 1 ? 'y' : 'ies'} with no catalog entry — try recovering them before deleting`)}
            {row('Staging', opfs!.staging)}
            {row('Catalog and saved state', opfs!.catalog + opfs!.other)}
          </div>

          <h4>OPFS — global</h4>
          <div className="storage-detail-list">
            {row('Other workspaces', opfs!.otherWorkspaces)}
            {row('Plugins', opfs!.plugins)}
            {row('Engine session', opfs!.engine)}
          </div>
          <div className="storage-detail-actions">
            <button
              disabled={working || opfs!.orphanArtifactDirectories === 0}
              onClick={() => run(async () => setRecovery(await onRecoverOrphans()))}
            >
              Recover orphaned artifacts
            </button>
            <button
              className="storage-detail-danger"
              disabled={working || opfs!.orphanArtifacts === 0}
              onClick={() => setPending('orphans')}
            >
              Remove orphaned artifact files
            </button>
          </div>
          {recovery && <p className="storage-detail-muted">{recovery}</p>}

          <h4>Cache Storage</h4>
          <div className="storage-detail-list">
            {row('App-controlled Cache Storage', cache!.bytes, `${cache!.entries} entries; ${fmtBytes(cache!.pyodideBytes)} matching Pyodide/package URLs`)}
          </div>
          {cache!.caches.length > 0 && (
            <details className="storage-cache-list">
              <summary>Cache names</summary>
              {cache!.caches.map((item) => (
                <div key={item.name}>{item.name} · {item.entries} entries · {fmtBytes(item.bytes)}</div>
              ))}
            </details>
          )}
          <button
            className="storage-detail-danger"
            disabled={working || cache!.entries === 0}
            onClick={() => setPending('cache')}
          >
            Clear Cache Storage
          </button>

          {row('Browser-managed / unclassified', breakdown.unclassified, 'May include HTTP cache. It cannot be attributed to or cleared as “Pyodide” by this app.')}
        </>}
        <div className="modal-actions">
          <button disabled={working} onClick={onRefresh}>Refresh</button>
          <button disabled={working} onClick={onClose}>Close</button>
          <button disabled={working} className="storage-detail-reset" onClick={onResetWorkspace}>Reset workspace…</button>
        </div>
      </div>
      {pending === 'orphans' && (
        <ConfirmDialog
          title="Remove orphaned artifact files"
          message={`Permanently deletes ${fmtBytes(opfs?.orphanArtifacts)} of artifact files with no catalog entry. If the catalog is what went missing, these files are your artifacts — run "Recover orphaned artifacts" first. Active artifacts, plugins and saved views are kept.`}
          confirmLabel="Remove files"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => run(onRemoveOrphans)}
        />
      )}
      {pending === 'cache' && (
        <ConfirmDialog
          title="Clear Cache Storage"
          message="Permanently removes this origin’s Cache Storage entries. Cached responses will need to be downloaded again if used. Browser HTTP cache is not affected."
          confirmLabel="Clear Cache Storage"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => run(onClearCacheStorage)}
        />
      )}
    </div>,
    document.body,
  );
}
