import { useEffect, useRef, useState } from 'react';
import type { WorkspaceMeta } from '../host/data/opfs';
import { SaveViewDialog } from './SaveViewDialog';
import { ConfirmDialog } from './ConfirmDialog';

function ChevronDown() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <path d="M2.5 6.3 5 8.8l4.5-5.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A starting point, not a nudge to accept it — the field is pre-selected
 * (see `SaveViewDialog`), so typing immediately replaces it. */
const NEW_WORKSPACE_SUGGESTIONS = ['Home Base', 'The Boulevard', 'First Stroll'];
function suggestWorkspaceName() {
  return NEW_WORKSPACE_SUGGESTIONS[Math.floor(Math.random() * NEW_WORKSPACE_SUGGESTIONS.length)];
}

/**
 * The workspace switcher, docked beside the logo — each workspace has its
 * own catalog/artifact tree; plugins and Promenade Compute settings stay
 * global and are unaffected by which one is open. Switching, creating, and
 * deleting a workspace all end in a page reload: the data worker's DuckDB
 * connection and in-memory mount state are tied to one workspace's OPFS
 * subtree for the life of the tab, the same way a full "Reset workspace"
 * already reloads rather than trying to hot-swap that state.
 */
export function WorkspaceSwitcher({
  workspaces, activeWorkspaceId, onSwitch, onCreate, onRename, onDelete, onExport, onImport,
}: {
  workspaces: WorkspaceMeta[];
  activeWorkspaceId: string;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newWorkspaceSuggestion, setNewWorkspaceSuggestion] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="workspace-switcher" ref={root} onMouseDown={(e) => e.stopPropagation()}>
      <button
        className={`workspace-switcher-button${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Switch workspace"
        aria-label="Switch workspace"
        aria-expanded={open}
      >
        <span className="workspace-switcher-name">{active?.name ?? '…'}</span>
        <ChevronDown />
      </button>

      {open && (
        <div className="workspace-menu" role="menu">
          <div className="workspace-menu-heading">Workspaces</div>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className="workspace-menu-item"
              onClick={() => { setOpen(false); if (w.id !== activeWorkspaceId) onSwitch(w.id); }}
            >
              <span className="workspace-menu-check">{w.id === activeWorkspaceId && <CheckIcon />}</span>
              <span>{w.name}</span>
            </button>
          ))}
          <div className="workspace-menu-separator" />
          <button
            className="workspace-menu-item"
            onClick={() => { setOpen(false); setNewWorkspaceSuggestion(suggestWorkspaceName()); setCreating(true); }}
          >
            <span className="workspace-menu-check" /><span>New workspace…</span>
          </button>
          <button className="workspace-menu-item" onClick={() => { setOpen(false); setRenaming(true); }}>
            <span className="workspace-menu-check" /><span>Rename current…</span>
          </button>
          <button
            className="workspace-menu-item danger"
            disabled={workspaces.length <= 1}
            title={workspaces.length <= 1 ? 'The last remaining workspace cannot be deleted' : undefined}
            onClick={() => { setOpen(false); setDeleting(true); }}
          >
            <span className="workspace-menu-check" /><span>Delete current</span>
          </button>
          <div className="workspace-menu-separator" />
          <button className="workspace-menu-item" onClick={() => { setOpen(false); onExport(); }}>
            <span className="workspace-menu-check" /><span>Export workspace…</span>
          </button>
          <button className="workspace-menu-item" onClick={() => { setOpen(false); onImport(); }}>
            <span className="workspace-menu-check" /><span>Import workspace…</span>
          </button>
        </div>
      )}

      {creating && (
        <SaveViewDialog
          defaultTitle={newWorkspaceSuggestion}
          heading="New workspace"
          confirmLabel="Create"
          onCancel={() => setCreating(false)}
          onConfirm={(name) => { setCreating(false); onCreate(name); }}
        />
      )}
      {renaming && active && (
        <SaveViewDialog
          defaultTitle={active.name}
          heading="Rename workspace"
          confirmLabel="Rename"
          onCancel={() => setRenaming(false)}
          onConfirm={(name) => { setRenaming(false); onRename(name); }}
        />
      )}
      {deleting && active && (
        <ConfirmDialog
          title="Delete workspace"
          message={`Delete "${active.name}" and everything in it — every artifact, saved view and its stored Parquet files? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleting(false)}
          onConfirm={() => { setDeleting(false); onDelete(); }}
        />
      )}
    </div>
  );
}
