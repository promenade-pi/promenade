import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { descendantsOf, displayParentId, type Artifact, type ProvenanceGraph } from '../host/artifact/types';
import { artifactTypes, familyColorOf, displayNameOf } from '../host/artifact/registry';
import { actionRegistry, primaryParam } from '../host/actions/registry';
import { fmtBytes, fmtCount } from './format';
import { OP_LABEL, describeOp } from '../host/transform/types';
import type { SavedView } from '../host/views/savedViews';
import { viewRegistry, hasPersistableViewState } from '../host/views/registry';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { SaveViewDialog } from './SaveViewDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { canRelocate } from '../host/compute/relocate';
import type { ComputeEngine } from '../host/compute/engines';

/**
 * Permanent artifact list.
 *
 * Not part of the docking system on purpose: it is the fixed spine of the
 * artifact-first model, and a panel the user could close would take the whole
 * navigation model with it.
 *
 * Derived artifacts nest under their inputs — a readable projection of the
 * provenance DAG rather than the DAG itself. An artifact with several inputs
 * appears under the first; the full edge list is in the inspector.
 *
 * Naming rule, the one thing everything else here follows from: a row's
 * primary text is what the artifact *is* (a noun — "Causal Net", "Process
 * Tree"), never what produced it. Provenance ("via Heuristics Miner") is a
 * dimmed second line, exactly once, not repeated in every descendant's own
 * name the way `artifact.name` used to encode it. See `displayNameOf` and
 * `provenanceOf`.
 */

/** Sentinel group key for top-level artifacts — never a real artifact id. */
const ROOT_GROUP = '__root__';
const ORDER_STORAGE_KEY = 'promenade.artifactOrder';
const VIEW_ORDER_STORAGE_KEY = 'promenade.savedViewOrder';
type SortMode = 'manual' | 'name' | 'newest' | 'oldest';
type GroupMode = 'none' | 'type';

function readOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeOrder(order: Record<string, string[]>) {
  try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order)); } catch {}
}

/**
 * Which rows the user has collapsed.
 *
 * Persisted for the same reason the orders above are: it is a deliberate
 * arrangement of the tree, and losing it on reload silently undoes work the
 * user did. Stored as a flat id list and deliberately not pruned against the
 * current workspace's artifacts — the tree only knows the workspace it is
 * showing, so pruning here would discard every other workspace's collapse
 * state. An id whose artifact is gone is inert, and the same is already true
 * of the order maps.
 */
const COLLAPSE_STORAGE_KEY = 'promenade.artifactCollapsed';

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function writeCollapsed(collapsed: Set<string>) {
  try { localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsed])); } catch {}
}

/** Saved-view row order, one list per source artifact — a flat sibling group,
 * unlike artifacts' nested ones, since a saved view never has children. */
function readViewOrder(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(VIEW_ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function writeViewOrder(order: Record<string, string[]>) {
  try { localStorage.setItem(VIEW_ORDER_STORAGE_KEY, JSON.stringify(order)); } catch {}
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return element.isContentEditable
    || !!element.closest('input, textarea, select, [contenteditable="true"]');
}

/**
 * Applies a saved drag order to a sibling group, dropping ids that no longer
 * exist and appending any the saved order never saw (new siblings) in their
 * natural order at the end — so a fresh child never gets lost above the fold
 * just because it was created after the last manual reorder.
 */
function applyOrder(items: Artifact[], order?: string[]): Artifact[] {
  if (!order || order.length === 0) return items;
  const byId = new Map(items.map((it) => [it.id, it]));
  const ordered: Artifact[] = [];
  for (const id of order) {
    const it = byId.get(id);
    if (it) { ordered.push(it); byId.delete(id); }
  }
  for (const it of items) if (byId.has(it.id)) ordered.push(it);
  return ordered;
}

/** Same rule as `applyOrder`, for a saved-view list instead of an artifact one. */
function applyViewOrder(items: SavedView[], order?: string[]): SavedView[] {
  if (!order || order.length === 0) return items;
  const byId = new Map(items.map((it) => [it.id, it]));
  const ordered: SavedView[] = [];
  for (const id of order) {
    const it = byId.get(id);
    if (it) { ordered.push(it); byId.delete(id); }
  }
  for (const it of items) if (byId.has(it.id)) ordered.push(it);
  return ordered;
}

function orderedArtifacts(items: Artifact[], order: string[] | undefined, mode: SortMode): Artifact[] {
  const out = applyOrder(items, order);
  if (mode === 'manual') return out;
  return out.sort((left, right) => {
    if (mode === 'name') return displayNameOf(left).localeCompare(displayNameOf(right));
    const byDate = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return mode === 'newest' ? byDate : -byDate;
  });
}

function UploadIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10.5V2.5m0 0L5.2 5.3M8 2.5l2.8 2.8M2.5 10.5v2.2c0 .7.6 1.3 1.3 1.3h8.4c.7 0 1.3-.6 1.3-1.3v-2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function FolderIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.5c0-.7.6-1.3 1.3-1.3h3l1.2 1.4h5.6c.7 0 1.3.6 1.3 1.3v6.3c0 .7-.6 1.3-1.3 1.3H3.1c-.7 0-1.3-.6-1.3-1.3V4.5Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" /></svg>;
}

function NewIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

/**
 * "via {action}" or "via {action} · {primary param} {value}" — the one line
 * of provenance a row gets, reading whichever parameter the action's own
 * schema marked `primary` (see `ActionDef.params`), the same flag the
 * inspector uses to pick a tab-title parameter. An action with no primary
 * parameter just says what it was; not every action needs a number to be
 * identified by.
 */
function provenanceOf(a: Artifact, graph: ProvenanceGraph): string | null {
  if (!a.producedBy) return null;
  const exec = graph.executions[a.producedBy];
  if (!exec) return null;
  const action = actionRegistry.get(exec.actionId);
  // A view that publishes an artifact records `<package>.publishArtifact`,
  // which is not a registered action and so has no label of its own. The raw
  // id says less than nothing to a reader; that a person made this rather than
  // a run is the whole content of the line.
  if (!action && exec.actionId.endsWith('.publishArtifact')) return 'authored';
  const label = action?.label ?? exec.actionId;
  const pk = action ? primaryParam(action.params) : null;
  const pv = pk ? exec.params?.[pk] : null;
  if (pk != null && pv != null) {
    const title = (action!.params.properties[pk].title ?? pk).toLowerCase();
    return `via ${label} · ${title} ${pv}`;
  }
  return `via ${label}`;
}

function ArtifactIcon({ artifact, missing }: { artifact: Artifact; missing: boolean }) {
  const color = missing ? 'var(--danger)' : familyColorOf(artifact.type);
  return <span className="t-icon" style={{ background: color, borderRadius: '50%' }} />;
}

/**
 * One saved view, nested under its source artifact.
 *
 * Deliberately undecorated next to an artifact row: no color dot, no type
 * badge. A saved view is a way of looking at data, not data — giving it the
 * same visual weight as the artifacts it points at would say otherwise.
 */
function SavedViewRow({
  view, selected, onSelect, onOpen, onRename, onDelete, deleteLabel, onDuplicate,
  onPointerEnter, onPointerLeave,
  draggable, dragging, dropSide, onDragStart, onDragEnd, onDragOver, onDrop,
}: {
  view: SavedView;
  selected: boolean;
  onSelect: (e: ReactMouseEvent) => void;
  onOpen: () => void;
  onRename: (title: string) => void;
  /** The user asked to delete from this row — the parent decides whether that
   * means this one view or the whole current multi-selection, and owns the
   * confirmation dialog (mirrors how artifact rows delegate `setDeleting`). */
  onDelete: () => void;
  /** "Delete" or "Delete N views…", chosen by the parent from the selection. */
  deleteLabel: string;
  onDuplicate: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Reordering only makes sense once a view has siblings — a lone saved
   * view row has nothing to reorder against. */
  draggable: boolean;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);

  const menuItems: ContextMenuItem[] = [
    { label: 'Open', action: onOpen },
    { label: 'Duplicate view', action: onDuplicate },
    { label: 'Rename…', action: () => setRenaming(true) },
    'separator',
    { label: deleteLabel, action: onDelete },
  ];

  return (
    <div className="t-node">
      <div
        className={`t-row t-view-row${selected ? ' sel' : ''}${dragging ? ' dragging' : ''}${dropSide ? ` drag-${dropSide}` : ''}`}
        onClick={onSelect}
        onMouseEnter={onPointerEnter}
        onMouseLeave={onPointerLeave}
        onDoubleClick={onOpen}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        title={view.title}
        draggable={draggable}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <span className="t-twisty placeholder" />
        <svg className="t-view-icon" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="9" width="3" height="5" fill="currentColor" />
          <rect x="6.5" y="6" width="3" height="8" fill="currentColor" />
          <rect x="11.5" y="2.5" width="3" height="11.5" fill="currentColor" />
        </svg>
        <span className="t-name">{view.title}</span>
        <span className="t-row-actions">
          <button
            className="t-row-action" title="Open"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M3.5 2.5h6v6M9.5 2.5 2.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="t-row-action" title="More"
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2 }); }}
          >
            ⋯
          </button>
        </span>
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {renaming && (
        <SaveViewDialog
          defaultTitle={view.title}
          heading="Rename view"
          confirmLabel="Rename"
          onCancel={() => setRenaming(false)}
          onConfirm={(title) => { onRename(title); setRenaming(false); }}
        />
      )}
    </div>
  );
}

/**
 * Close a popup menu on a click outside it or on Escape. Both menus in this
 * panel want exactly this, and a menu that stays open when you click away is
 * the kind of bug nobody files and everybody notices.
 */
function useDismissOnOutside<T extends HTMLElement>(
  open: boolean,
  ref: RefObject<T | null>,
  setOpen: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, setOpen]);
}

export function ArtifactTree({
  graph, selected, onSelect, onOpen, onRemove, onRemoveMany, onRenameArtifact, onExportAction, onImport, onFilesDropped, onSampleLogs,
  savedViews, selectedSavedViews, onSelectSavedViews, onOpenSavedView,
  onRenameSavedView, onRemoveSavedView, onRemoveManySavedViews, onDuplicateSavedView,
  unusedMaterializations = 0, onCleanupUnusedMaterializations,
  otherWorkspaces = [], onMoveToWorkspace,
  computeEngines = [], onRelocateArtifact,
  onOpenView, onRunAction, onExplore, authoringViews = [], onOpenAuthoringView,
  standaloneActions = [], onOpenStandaloneAction,
}: {
  graph: ProvenanceGraph;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onOpen: (a: Artifact) => void;
  onRemove: (id: string) => void;
  /** Deletes several artifacts at once — multi-select followed by Backspace,
   *  or "Delete…" on a row that is part of the current selection. */
  onRemoveMany: (ids: string[]) => void;
  /** Renames the artifact's own record — distinct from `onRenameSavedView`,
   * which renames a saved parameterised view of one. */
  onRenameArtifact?: (id: string, name: string) => void;
  /**
   * Runs any `exportsFile` action applicable to one artifact and triggers
   * the browser download — the artifact tree only has to know how to build
   * the submenu (`exportActionsFor`, below); running the action and turning
   * its result into a downloaded file is `App.tsx`'s `onExportAction`.
   */
  onExportAction?: (actionId: string, artifact: Artifact, params: Record<string, unknown>) => void;
  onImport?: () => void;
  /** Files dropped onto the tree — the same import path as the file picker. */
  onFilesDropped?: (files: FileList) => void;
  /** Opens the curated sample-logs picker. */
  onSampleLogs?: () => void;
  /**
   * Standalone authoring panels plugins contribute (`ViewDef.standalone`) —
   * the other way an artifact enters an empty workspace besides a file. Each
   * one is offered by its own label, so what appears here is whatever is
   * installed rather than a fixed list core knows about.
   */
  authoringViews?: Array<{ id: string; label: string }>;
  onOpenAuthoringView?: (viewId: string) => void;
  /**
   * Manufacturing actions (`inputs: []`) plugins contribute — the
   * action-side counterpart to `authoringViews`: no artifact exists yet for
   * these either, they just collect their own params (typically a `file`
   * one) in a plain dialog instead of a sandboxed authoring view.
   */
  standaloneActions?: Array<{ id: string; label: string }>;
  onOpenStandaloneAction?: (actionId: string) => void;
  /** Saved views, grouped under their source artifact's "Views" node. */
  savedViews: SavedView[];
  /** Multi-select, mirroring `selected` for artifacts. Selecting views and
   * selecting artifacts are mutually exclusive (the app clears one when the
   * other changes), so at most one of the two is ever non-empty. */
  selectedSavedViews: string[];
  onSelectSavedViews: (ids: string[]) => void;
  onOpenSavedView: (v: SavedView) => void;
  onRenameSavedView: (id: string, title: string) => void;
  onRemoveSavedView: (id: string) => void;
  /** Deletes several saved views at once — multi-select then Backspace, or
   * "Delete N views…" on a row inside the selection. */
  onRemoveManySavedViews: (ids: string[]) => void;
  onDuplicateSavedView: (id: string) => void;
  /** Unreferenced OPFS artifact directories — safe maintenance candidates. */
  unusedMaterializations?: number;
  onCleanupUnusedMaterializations?: () => Promise<void>;
  /** Workspaces besides the active one, for the "Move to workspace" menu on
   * a root artifact — empty hides that entry entirely. */
  otherWorkspaces?: Array<{ id: string; name: string }>;
  onMoveToWorkspace?: (artifactId: string, destWorkspaceId: string) => void;
  /** Configured Promenade Compute engines — feeds "Copy/Move to Promenade
   * Compute". Empty hides those menu entries entirely. */
  computeEngines?: ComputeEngine[];
  /** "Copy to Promenade Compute" / "Move to Promenade Compute" / "Move to
   * Browser" (`host/compute/relocate.ts`) — the tree hands off the actual
   * upload/export call so it can refresh `graph` on completion, the same
   * division of responsibility `onRemove`/`onMoveToWorkspace` already use. */
  onRelocateArtifact?: (artifact: Artifact, kind: 'copy' | 'move-to-engine' | 'move-to-browser', engine: ComputeEngine) => void;
  /** Open one of the renderers registered for the contextual artifact. */
  onOpenView?: (artifact: Artifact, viewId: string) => void;
  /** Run a single-input action directly from the contextual artifact. */
  onRunAction?: (actionId: string, artifact: Artifact) => void;
  /**
   * Opens the destination gallery for one artifact — the tiled "what can I do
   * with this" panel.
   *
   * Offered from the row's own affordance, from `Enter`, and as the first
   * context-menu item; deliberately *not* from a plain click. A click is how
   * a selection is built, and two-input actions ("Compare OCPNs") need a
   * selection of two — hijacking the click would make those harder to reach
   * for the sake of a panel that is already one keystroke away.
   */
  onExplore?: (artifact: Artifact) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  // Every path that changes it persists, rather than each call site
  // remembering to: the per-row toggle, "Collapse all" and
  // "Expand top-level logs" all land here.
  useEffect(() => { writeCollapsed(collapsed); }, [collapsed]);
  // The artifacts a confirm-delete dialog is currently open for. An array so
  // one gesture can clear a whole multi-selection.
  const [deleting, setDeleting] = useState<string[] | null>(null);
  // The saved views a confirm-delete dialog is currently open for — the
  // saved-view counterpart of `deleting`.
  const [deletingViews, setDeletingViews] = useState<string[] | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pointedId, setPointedId] = useState<string | null>(null);
  const [pointedViewId, setPointedViewId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<{ id: string; x: number; y: number } | null>(null);
  // The row a plain/⌘ click last landed on — the fixed end of a Shift-click
  // range. Not state: it only ever needs to be current at the next click.
  const rangeAnchor = useRef<string | null>(null);
  const viewRangeAnchor = useRef<string | null>(null);
  // Narrows the whole tree to one artifact's own lineage — a breadcrumb
  // above the list is the only way out. Session-local on purpose: reopening
  // the app to a narrowed tree with no visible reason why would be its own
  // kind of confusing.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // A counter, not a boolean: dragenter/dragleave fire on every child
  // boundary crossed, so a plain flag flickers off the moment the pointer
  // passes over a row while still inside the tree.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState('');
  const [panelMenuOpen, setPanelMenuOpen] = useState(false);
  const [showSavedViews, setShowSavedViews] = useState(true);
  const [showOnlyOrphaned, setShowOnlyOrphaned] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('manual');
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [cleaningUnused, setCleaningUnused] = useState(false);
  const [confirmCleanupUnused, setConfirmCleanupUnused] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const panelMenuRef = useRef<HTMLDivElement>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  // Manual reordering, persisted per sibling group (root, or a specific
  // parent's children) — see `applyOrder`. `dragId` is the artifact being
  // dragged; `dropTarget` is which row it is currently over and on which
  // side, purely for the insertion-line indicator.
  const [order, setOrder] = useState<Record<string, string[]>>(readOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; before: boolean } | null>(null);

  // Same pattern, scoped to one artifact's saved-view rows instead of the
  // artifact tree itself — a saved view's "sibling group" is simply every
  // other saved view on the same source artifact.
  const [viewOrder, setViewOrder] = useState<Record<string, string[]>>(readViewOrder);
  const [dragViewId, setDragViewId] = useState<string | null>(null);
  const [dropViewTarget, setDropViewTarget] = useState<{ id: string; before: boolean } | null>(null);

  // Backspace opens the existing destructive confirmation for whichever
  // artifact the pointer is over, so a row can be deleted without first
  // clicking to select it. Falls back to the single clicked/selected
  // artifact when nothing is currently hovered — `mouseenter` only fires on
  // actual pointer movement into an element, not on a click by itself, so a
  // row selected by click but never physically hovered (e.g. the cursor
  // hasn't moved since a previous row's delete-confirm dialog closed) would
  // otherwise silently do nothing despite looking selected. Editable
  // controls own Backspace themselves, so searching or editing never
  // triggers deletion.
  useEffect(() => {
    const validViewIds = new Set(savedViews.map((v) => v.id));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (deleting || deletingViews) { event.preventDefault(); return; }
      if (isEditableTarget(event.target)) return;

      // Saved views first: a pointed view row, or the view selection when the
      // pointer is off a view row. Same "pointing at an unselected row targets
      // just that row" rule as artifacts. Selecting views and artifacts is
      // mutually exclusive, so this branch and the artifact one never both
      // have a selection to act on.
      const pointedView = pointedViewId && validViewIds.has(pointedViewId) ? pointedViewId : null;
      const chosenViews = selectedSavedViews.filter((id) => validViewIds.has(id));
      const viewIds = pointedView && !chosenViews.includes(pointedView) ? [pointedView]
        : chosenViews.length > 0 ? chosenViews
        : pointedView ? [pointedView]
        : [];
      if (viewIds.length > 0) {
        event.preventDefault();
        setDeletingViews(viewIds);
        return;
      }

      const pointed = pointedId && graph.artifacts[pointedId] ? pointedId : null;
      const chosen = selected.filter((id) => graph.artifacts[id]);
      // A row the pointer is over but which is *not* part of the selection is
      // its own target — hovering elsewhere shouldn't nuke the selection. Any
      // other case (pointing at a selected row, or not pointing at all) acts
      // on the whole selection, one artifact or many.
      const ids = pointed && !chosen.includes(pointed) ? [pointed]
        : chosen.length > 0 ? chosen
        : pointed ? [pointed]
        : [];
      if (ids.length === 0) return;
      event.preventDefault();
      setDeleting(ids);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [deleting, deletingViews, graph.artifacts, pointedId, selected, pointedViewId, selectedSavedViews, savedViews]);

  /**
   * `Enter` opens the destination gallery for the artifact in hand — the
   * keyboard counterpart to the row's own affordance, and the reason a plain
   * click does not have to do it.
   *
   * Targeting follows the same rule Backspace already established: a row the
   * pointer is over but which is not part of the selection is its own target;
   * otherwise the selection answers. Only a single artifact opens a gallery,
   * because the gallery is *about* one artifact — a second selected artifact
   * fills an action's other slot rather than getting a panel of its own.
   */
  useEffect(() => {
    if (!onExplore) return;
    const onEnter = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target)) return;
      // A focused control owns Enter — activating a button must not also open
      // a gallery behind it.
      if (event.target instanceof HTMLElement && event.target.closest('button,a,[role="button"]')) return;
      const pointed = pointedId && graph.artifacts[pointedId] ? pointedId : null;
      const chosen = selected.filter((id) => graph.artifacts[id]);
      const id = pointed && !chosen.includes(pointed) ? pointed
        : chosen.length === 1 ? chosen[0]
        : pointed ?? null;
      const artifact = id ? graph.artifacts[id] : null;
      if (!artifact) return;
      event.preventDefault();
      onExplore(artifact);
    };
    document.addEventListener('keydown', onEnter);
    return () => document.removeEventListener('keydown', onEnter);
  }, [onExplore, graph.artifacts, pointedId, selected]);

  useDismissOnOutside(panelMenuOpen, panelMenuRef, setPanelMenuOpen);
  useDismissOnOutside(newMenuOpen, newMenuRef, setNewMenuOpen);

  /**
   * Everything that makes a new artifact from nothing, as one list.
   *
   * A standalone view and a standalone action reach the host by different
   * routes, but to someone looking at the panel they are the same offer, so
   * the difference has no business showing in the UI. Labels stay exactly as
   * the plugin wrote them — rewriting somebody else's menu entry to fit our
   * heading is how a label ends up saying something the plugin does not do.
   */
  const creators = useMemo(() => [
    ...(onOpenAuthoringView ? authoringViews.map((v) => ({ id: v.id, label: v.label, open: () => onOpenAuthoringView(v.id) })) : []),
    ...(onOpenStandaloneAction ? standaloneActions.map((a) => ({ id: a.id, label: a.label, open: () => onOpenStandaloneAction(a.id) })) : []),
    // Alphabetical, because the order plugins happen to be registered in is
    // not an order anybody can learn: it changes when a plugin is installed,
    // so the entry someone reaches for moves under them.
  ].sort((left, right) => left.label.localeCompare(right.label)),
  [authoringViews, onOpenAuthoringView, standaloneActions, onOpenStandaloneAction]);

  const { roots, childrenOf, groupKeyOf } = useMemo(() => {
    const all = Object.values(graph.artifacts);
    const childrenOf = new Map<string, Artifact[]>();
    const groupKeyOf = new Map<string, string>();
    const roots: Artifact[] = [];

    // An `internal` action's own output (`executeAction.ts` stamps
    // `meta.hidden`) is a real, fully provenanced artifact — still
    // queryable, still visible in Provenance — it just never earns its own
    // row here: a projection step a user never separately ran (e.g. OCPN's
    // automatic OCEL→TraditionalEventLog stage) tells them nothing they can
    // act on. Its own children nest under its nearest non-hidden ancestor
    // instead, consistent with this component already being "a readable
    // projection of the DAG, not the DAG itself" for multi-input artifacts.
    const isHidden = (a: Artifact) => (a.meta as any)?.hidden === true;
    function effectiveParentId(a: Artifact): string | undefined {
      let parentId = displayParentId(graph, a);
      while (parentId) {
        const parent = graph.artifacts[parentId];
        if (!parent || !isHidden(parent)) return parentId;
        parentId = displayParentId(graph, parent);
      }
      return undefined;
    }

    for (const a of all) {
      if (isHidden(a)) continue;
      const parent = effectiveParentId(a);
      if (!parent || !graph.artifacts[parent]) {
        roots.push(a);
        groupKeyOf.set(a.id, ROOT_GROUP);
        continue;
      }
      groupKeyOf.set(a.id, parent);
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(a);
    }
    return { roots, childrenOf, groupKeyOf };
  }, [graph]);

  // Focus mode's own root list: just the focused artifact, if it still
  // exists — a deleted focus target falls back to the full tree rather than
  // rendering nothing.
  const focused = focusedId ? graph.artifacts[focusedId] : null;
  const effectiveRoots = focused ? [focused] : orderedArtifacts(roots, order[ROOT_GROUP], sortMode);

  const breadcrumb = useMemo(() => {
    if (!focused) return null;
    const chain: Artifact[] = [];
    let cur: Artifact | undefined = focused;
    while (cur) {
      chain.unshift(cur);
      const parentId: string | undefined = displayParentId(graph, cur);
      cur = parentId ? graph.artifacts[parentId] : undefined;
    }
    return chain;
  }, [focused, graph]);

  /**
   * Commits a drag: `draggedId` moves to just before/after `targetId` within
   * its own sibling group. Rebuilt from the group's *current* rendered order
   * (already reflecting any prior manual order), not from scratch, so two
   * drags in a row compose instead of each one discarding the last.
   */
  const reorder = (groupKey: string, siblings: Artifact[], draggedId: string, targetId: string, before: boolean) => {
    const ids = siblings.map((s) => s.id).filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(before ? at : at + 1, 0, draggedId);
    setOrder((prev) => {
      const next = { ...prev, [groupKey]: ids };
      writeOrder(next);
      return next;
    });
  };

  const reorderViews = (sourceArtifactId: string, siblings: SavedView[], draggedId: string, targetId: string, before: boolean) => {
    const ids = siblings.map((s) => s.id).filter((id) => id !== draggedId);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(before ? at : at + 1, 0, draggedId);
    setViewOrder((prev) => {
      const next = { ...prev, [sourceArtifactId]: ids };
      writeViewOrder(next);
      return next;
    });
  };

  const viewsByArtifact = useMemo(() => {
    const m = new Map<string, SavedView[]>();
    if (!showSavedViews) return m;
    for (const v of savedViews) {
      // Defensive: an artifact can be deleted without cascading to the saved
      // views that pointed at it; an orphan should disappear, not crash.
      if (!graph.artifacts[v.sourceArtifactId]) continue;
      // Parameterless built-ins do not earn a duplicate tree row, while an
      // installed renderer does: the renderer selection itself is state.
      if (!hasPersistableViewState(viewRegistry.get(v.view))) continue;
      if (!m.has(v.sourceArtifactId)) m.set(v.sourceArtifactId, []);
      m.get(v.sourceArtifactId)!.push(v);
    }
    for (const [id, views] of m) m.set(id, applyViewOrder(views, viewOrder[id]));
    return m;
  }, [savedViews, graph, showSavedViews, viewOrder]);

  /**
   * `viewsByArtifact` already excludes the artifact's own `primary` view
   * (e.g. Overview) via `hasPersistableViewState` — that one's reachable
   * straight from the artifact row's own Open button. For a type that
   * registers one (today: event logs), anything left is a deliberately
   * chosen alternate renderer with no other way back once its panel is
   * closed — even a single one (Dotted chart, say) is worth surfacing.
   *
   * A type with no `primary` view at all (a Petri net, a process tree, …)
   * has no such distinct "default" to fall back on: `openArtifact` picks
   * whichever view registered first as its own Open-button destination, and
   * that view is not excluded from `viewsByArtifact` the way a `primary`
   * one is. Saving it therefore looks identical to saving the artifact's
   * only way in — the original "needs a second view to be worth a row"
   * rule still applies there.
   */
  const shownViewsByArtifact = useMemo(() => {
    const m = new Map<string, SavedView[]>();
    for (const [id, views] of viewsByArtifact) {
      const artifact = graph.artifacts[id];
      const hasDefaultOverview = !!artifact
        && viewRegistry.forType(artifact.type, artifact).some((v) => v.primary);
      if (hasDefaultOverview || views.length > 1) m.set(id, views);
    }
    return m;
  }, [viewsByArtifact, graph]);

  /**
   * Search keeps ancestors of a match visible — hiding the parent would hide
   * the path that explains where the match came from. Matches both the
   * artifact's stored name (still the only name a root/imported artifact
   * has) and its displayed noun, so searching either "Road_Traffic…" or
   * "Causal Net" finds what it should.
   */
  const isOrphaned = (artifact: Artifact) => !!artifact.unavailable
    || !!artifact.providerMissing
    || (artifact.inputs ?? []).some((id) => !graph.artifacts[id]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && !showOnlyOrphaned) return null;
    const keep = new Set<string>();
    const mark = (a: Artifact, chain: string[]) => {
      const textHit = !q || a.name.toLowerCase().includes(q)
        || displayNameOf(a).toLowerCase().includes(q)
        || artifactTypes.get(a.type).shortLabel.toLowerCase().includes(q);
      const hit = textHit && (!showOnlyOrphaned || isOrphaned(a));
      if (hit) for (const id of [...chain, a.id]) keep.add(id);
      for (const c of childrenOf.get(a.id) ?? []) mark(c, [...chain, a.id]);
    };
    for (const r of effectiveRoots) mark(r, []);
    return keep;
  }, [query, effectiveRoots, childrenOf, showOnlyOrphaned, graph]);

  // Root dividers belong between rendered groups. Filtering here prevents a
  // search-hidden root from leaving a divider at the top of the results.
  const visibleRoots = visible
    ? effectiveRoots.filter((a) => visible.has(a.id))
    : effectiveRoots;

  const treeArtifacts = useMemo(
    () => Object.values(graph.artifacts).filter((artifact) => (artifact.meta as any)?.hidden !== true),
    [graph],
  );
  const displayedCount = useMemo(() => {
    if (visible) return visible.size;
    if (!focused) return treeArtifacts.length;
    const ids = new Set<string>();
    const visit = (artifact: Artifact) => {
      ids.add(artifact.id);
      for (const child of childrenOf.get(artifact.id) ?? []) visit(child);
    };
    visit(focused);
    return ids.size;
  }, [visible, focused, treeArtifacts, childrenOf]);

  const rootGroups = useMemo(() => {
    if (groupMode === 'none') return [{ label: null as string | null, artifacts: visibleRoots }];
    const groups = new Map<string, Artifact[]>();
    for (const artifact of visibleRoots) {
      const label = artifactTypes.get(artifact.type).label;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(artifact);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, artifacts]) => ({ label, artifacts }));
  }, [groupMode, visibleRoots]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  /**
   * The rows a Shift-click can sweep across: the clicked artifact's own
   * siblings, in the order they are drawn, minus any hidden by search or a
   * collapsed group filter. "Sibling" is same parent — or, at the root, same
   * type sub-list when the tree is grouped by type — matching how the row
   * dividers and drag-reordering already carve the list up.
   */
  const siblingIdsInDrawOrder = (a: Artifact): string[] => {
    const groupKey = groupKeyOf.get(a.id) ?? ROOT_GROUP;
    if (groupKey === ROOT_GROUP) {
      const label = artifactTypes.get(a.type).label;
      return visibleRoots
        .filter((s) => groupMode !== 'type' || artifactTypes.get(s.type).label === label)
        .map((s) => s.id);
    }
    return orderedArtifacts(childrenOf.get(groupKey) ?? [], order[groupKey], sortMode)
      .filter((s) => !visible || visible.has(s.id))
      .map((s) => s.id);
  };

  const selectRow = (e: ReactMouseEvent, a: Artifact) => {
    if (e.shiftKey && rangeAnchor.current && rangeAnchor.current !== a.id) {
      const sibs = siblingIdsInDrawOrder(a);
      const from = sibs.indexOf(rangeAnchor.current);
      const to = sibs.indexOf(a.id);
      if (from !== -1 && to !== -1) {
        // Anchor stays put so the range can be widened or narrowed by further
        // Shift-clicks, exactly like a file list.
        onSelect(sibs.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      onSelect(selected.includes(a.id)
        ? selected.filter((id) => id !== a.id)
        : [...selected, a.id]);
    } else {
      onSelect([a.id]);
    }
    rangeAnchor.current = a.id;
  };

  /**
   * Saved-view click selection, mirroring `selectRow`. A saved view's
   * "sibling group" for a Shift-click sweep is every other saved view drawn
   * under the same source artifact (`siblings`, in draw order). Plain click
   * selects one; ⌘/Ctrl toggles; Shift extends from the anchor.
   */
  const selectRowView = (e: ReactMouseEvent, viewId: string, siblings: string[]) => {
    if (e.shiftKey && viewRangeAnchor.current && viewRangeAnchor.current !== viewId) {
      const from = siblings.indexOf(viewRangeAnchor.current);
      const to = siblings.indexOf(viewId);
      if (from !== -1 && to !== -1) {
        onSelectSavedViews(siblings.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      onSelectSavedViews(selectedSavedViews.includes(viewId)
        ? selectedSavedViews.filter((id) => id !== viewId)
        : [...selectedSavedViews, viewId]);
    } else {
      onSelectSavedViews([viewId]);
    }
    viewRangeAnchor.current = viewId;
  };

  const render = (a: Artifact) => {
    if (visible && !visible.has(a.id)) return null;

    const def = artifactTypes.get(a.type);
    const meta: any = a.meta ?? {};
    const missing = !!a.providerMissing || !def.providerInstalled || !!a.unavailable;
    const groupKey = groupKeyOf.get(a.id) ?? ROOT_GROUP;
    const kids = orderedArtifacts(childrenOf.get(a.id) ?? [], order[a.id], sortMode);
    const shownViews = shownViewsByArtifact.get(a.id) ?? [];
    // The Shift-click sweep range for this artifact's saved-view rows.
    const shownViewIds = shownViews.map((v) => v.id);
    // Only a same-group sibling accepts the drop — a DFG can reorder among
    // its log's other derived artifacts, never migrate to a different log.
    const dragOverState = dragId && dropTarget?.id === a.id && groupKeyOf.get(dragId) === groupKey
      ? (dropTarget.before ? 'before' : 'after') : null;
    // A search result is expanded regardless, so matches are not hidden behind
    // a collapsed ancestor.
    const isOpen = !collapsed.has(a.id) || !!visible;
    const isSel = selected.includes(a.id);
    const name = displayNameOf(a);

    // A transform's own description ("Flatten by object type: Aircraft")
    // already says what happened and is noun-shaped; provenance would only
    // repeat that less specifically ("via Transform log"), so it is skipped
    // there and shown for every other derived artifact instead.
    const provenance = !missing && a.storage.kind !== 'view' ? provenanceOf(a, graph) : null;

    const sub = a.unavailable
      ? a.unavailable
      : missing
      ? 'producing plugin missing'
      : [
          provenance,
          // A transform's shape is its plan; the counts alone do not say that
          // this log is derived rather than imported.
          // A single-operation plan is better described than counted.
          a.storage.kind === 'view'
            ? (a.storage.plan.ops.length === 1
                ? `${OP_LABEL[a.storage.plan.ops[0].kind]}: ${describeOp(a.storage.plan.ops[0])}`
                : `${a.storage.plan.ops.length} operations`)
            : null,
          meta.events != null ? `${fmtCount(meta.events)} events` : null,
          meta.objects != null ? `${fmtCount(meta.objects)} objects` : null,
          meta.traces != null ? `${fmtCount(meta.traces)} traces` : null,
          meta.places != null ? `${fmtCount(meta.places)} places` : null,
          meta.totalEdges != null ? `${fmtCount(meta.totalEdges)} edges` : null,
          meta.parquetBytes ? fmtBytes(meta.parquetBytes) : null,
        ].filter(Boolean).join(' · ');

    const viewItems: ContextMenuItem[] = viewRegistry.forType(a.type, a)
      .filter((v) => !v.standalone && !v.primary && (v.component || v.entry || v.nativeView))
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((v) => ({ label: v.label, action: () => onOpenView?.(a, v.id) }));
    // A tree row names one artifact, so only actions that can be satisfied by
    // that one artifact are offered here. Multi-input actions remain in the
    // Inspector, where the additional selected inputs can be made explicit.
    const actionItems: ContextMenuItem[] = actionRegistry.applicableTo([a])
      .filter(({ action, applicable }) => applicable && action.implemented)
      .sort((left, right) => left.action.label.localeCompare(right.action.label))
      .map(({ action }) => ({ label: action.label, action: () => onRunAction?.(action.id, a) }));

    // One entry per format when the action declares one (its own `format`
    // enum param — OCEL's six, XES's two), or one entry for the action
    // itself when it takes no params (PNML, BPMN 2.0 XML). Registry-driven
    // (`exportActionsFor`) rather than the two hardcoded `a.type === '...'`
    // blocks this replaces, so a plugin's own model exporter (BPMN, PNML)
    // appears here exactly the way OCEL/XES export always has.
    const exportItems: ContextMenuItem[] = onExportAction
      ? actionRegistry.exportActionsFor(a)
        .sort((left, right) => left.label.localeCompare(right.label))
        .flatMap((action) => {
          const format = action.params.properties.format;
          if (format?.enum) {
            return format.enum.map((v) => ({
              label: String(v).toUpperCase(),
              action: () => onExportAction(action.id, a, { format: v }),
            }));
          }
          return [{ label: action.label, action: () => onExportAction(action.id, a, {}) }];
        })
      : [];

    const menuItems: ContextMenuItem[] = [
      ...(onExplore ? [{ label: 'Explore views and actions…', action: () => onExplore(a) } as ContextMenuItem] : []),
      { label: 'Open', action: () => onOpen(a) },
      ...(viewItems.length > 0 ? [{ label: 'Show view', submenu: viewItems } as ContextMenuItem] : []),
      ...(actionItems.length > 0 ? [{ label: 'Run action', submenu: actionItems } as ContextMenuItem] : []),
      { label: 'Focus on this artifact', action: () => setFocusedId(a.id) },
      ...(onRenameArtifact ? [{ label: 'Rename…', action: () => setRenamingId(a.id) }] : []),
      ...(exportItems.length > 0 ? ['separator' as const, { label: 'Export', submenu: exportItems }] : []),
      // Only a root artifact can move — a derived one has no meaning apart
      // from the log it was computed against, which stays behind otherwise.
      ...(groupKey === ROOT_GROUP && onMoveToWorkspace && otherWorkspaces.length > 0 ? [
        'separator' as const,
        {
          label: 'Move to workspace',
          submenu: otherWorkspaces.map((w) => ({
            label: w.name,
            action: () => onMoveToWorkspace(a.id, w.id),
          })),
        },
      ] : []),
      ...(onRelocateArtifact && computeEngines.length > 0 ? (
        a.location
          ? (() => {
              const engine = computeEngines.find((e) => e.id === a.location!.engineId);
              return engine ? [
                'separator' as const,
                { label: `Move to Browser (from ${engine.name})`, action: () => onRelocateArtifact(a, 'move-to-browser', engine) },
              ] : [];
            })()
          : canRelocate(a) ? [
              'separator' as const,
              {
                label: 'Copy to Promenade Compute',
                submenu: computeEngines.map((e) => ({ label: e.name, action: () => onRelocateArtifact(a, 'copy', e) })),
              },
              {
                label: 'Move to Promenade Compute',
                submenu: computeEngines.map((e) => ({ label: e.name, action: () => onRelocateArtifact(a, 'move-to-engine', e) })),
              },
            ] : []
      ) : []),
      'separator',
      {
        label: selected.includes(a.id) && selected.length > 1 ? `Delete ${selected.length} artifacts…` : 'Delete…',
        action: () => setDeleting(
          selected.includes(a.id) && selected.length > 1
            ? selected.filter((id) => graph.artifacts[id])
            : [a.id],
        ),
      },
    ];

    return (
      <div className="t-node" key={a.id}>
        <div
          className={`t-artifact-node${isSel ? ' sel' : ''}${dragId === a.id ? ' dragging' : ''}${dragOverState ? ` drag-${dragOverState}` : ''}`}
          onClick={(e) => selectRow(e, a)}
          onDoubleClick={() => onOpen(a)}
          onMouseEnter={() => setPointedId(a.id)}
          onMouseLeave={() => setPointedId((current) => current === a.id ? null : current)}
          onContextMenu={(e) => { e.preventDefault(); setMenuFor({ id: a.id, x: e.clientX, y: e.clientY }); }}
          title={missing ? 'The plugin that defines this artifact type is not installed' : name}
          draggable
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.effectAllowed = 'move';
            // No payload needed — same-document reorder reads the dragged id
            // back out of state, not out of dataTransfer.
            setDragId(a.id);
          }}
          onDragEnd={() => { setDragId(null); setDropTarget(null); }}
          onDragOver={(e) => {
            if (!dragId || dragId === a.id || groupKeyOf.get(dragId) !== groupKey) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            const before = e.clientY < rect.top + rect.height / 2;
            setDropTarget((prev) => (prev?.id === a.id && prev.before === before ? prev : { id: a.id, before }));
          }}
          onDrop={(e) => {
            if (!dragId || groupKeyOf.get(dragId) !== groupKey) return;
            e.preventDefault();
            e.stopPropagation();
            const siblings = groupKey === ROOT_GROUP ? roots : childrenOf.get(groupKey) ?? [];
            reorder(groupKey, orderedArtifacts(siblings, order[groupKey], sortMode), dragId, a.id, dropTarget?.before ?? true);
            setDragId(null);
            setDropTarget(null);
          }}
        >
          {/* Title and subtitle hover, select and drag together as one unit —
              "via …" is provenance for the row above it, not a separate
              target — the same pattern the plugin list uses for its items. */}
          <div className="t-row">
            {kids.length > 0 || shownViews.length > 0 ? (
              <button
                className={`t-twisty${isOpen ? ' open' : ''}`}
                onClick={(e) => { e.stopPropagation(); toggle(a.id); }}
                aria-label={isOpen ? 'Collapse' : 'Expand'}
              >
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                  <path d="M4 2.5 L8 6 L4 9.5" fill="none" stroke="currentColor"
                        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ) : (
              <span className="t-twisty placeholder" />
            )}

            <ArtifactIcon artifact={a} missing={missing} />
            <span className="t-name">{name}</span>
            {a.stale && (
              <span className="t-stale-dot" title="Out of date — an input changed since this was computed" />
            )}
            <span className={`chip${missing ? ' missing' : ''}`}>{def.shortLabel}</span>
          </div>

          {/* The row's one affordance, under the type badge on the same right
              edge. "Open" used to sit here too and is gone: double-click
              already opens, and a second control for it cost a third of the
              row's width on every artifact. So did the "More" button — the
              menu it opened is the same one right-click gives. What is left
              is the one thing with no other gesture behind it. */}
          <div className="t-sub">
            <span className="t-sub-text">{sub}</span>
            {onExplore && (
              <button
                className="t-row-explore"
                title="See every view and action for this artifact"
                aria-label={`Explore views and actions for ${name}`}
                onClick={(e) => { e.stopPropagation(); onExplore(a); }}
              >
                Explore
              </button>
            )}
          </div>
        </div>

        {menuFor?.id === a.id && (
          <ContextMenu x={menuFor.x} y={menuFor.y} items={menuItems} onClose={() => setMenuFor(null)} />
        )}

        {isOpen && (kids.length > 0 || shownViews.length > 0) && (
          <div className="t-children">
            {shownViews.map((v) => (
              <SavedViewRow
                key={v.id}
                view={v}
                selected={selectedSavedViews.includes(v.id)}
                onSelect={(e) => selectRowView(e, v.id, shownViewIds)}
                onOpen={() => onOpenSavedView(v)}
                onRename={(title) => onRenameSavedView(v.id, title)}
                onDelete={() => setDeletingViews(
                  selectedSavedViews.includes(v.id) && selectedSavedViews.length > 1
                    ? selectedSavedViews.filter((id) => savedViews.some((s) => s.id === id))
                    : [v.id],
                )}
                deleteLabel={selectedSavedViews.includes(v.id) && selectedSavedViews.length > 1
                  ? `Delete ${selectedSavedViews.length} views…`
                  : 'Delete'}
                onDuplicate={() => onDuplicateSavedView(v.id)}
                onPointerEnter={() => setPointedViewId(v.id)}
                onPointerLeave={() => setPointedViewId((cur) => (cur === v.id ? null : cur))}
                draggable
                dragging={dragViewId === v.id}
                dropSide={dragViewId && dropViewTarget?.id === v.id ? (dropViewTarget.before ? 'before' : 'after') : null}
                onDragStart={() => setDragViewId(v.id)}
                onDragEnd={() => { setDragViewId(null); setDropViewTarget(null); }}
                onDragOver={(e) => {
                  if (!dragViewId || dragViewId === v.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const before = e.clientY < rect.top + rect.height / 2;
                  setDropViewTarget((prev) => (prev?.id === v.id && prev.before === before ? prev : { id: v.id, before }));
                }}
                onDrop={(e) => {
                  if (!dragViewId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  reorderViews(a.id, shownViews, dragViewId, v.id, dropViewTarget?.before ?? true);
                  setDragViewId(null);
                  setDropViewTarget(null);
                }}
              />
            ))}
            {kids.map((k) => render(k))}
          </div>
        )}
      </div>
    );
  };

  const collapsibleIds = treeArtifacts
    .filter((artifact) => (childrenOf.get(artifact.id)?.length ?? 0) > 0 || (shownViewsByArtifact.get(artifact.id)?.length ?? 0) > 0)
    .map((artifact) => artifact.id);
  const collapseAll = () => setCollapsed(new Set(collapsibleIds));
  const expandTopLevelLogs = () => {
    const topLogIds = new Set(roots
      .filter((artifact) => artifactTypes.get(artifact.type).family === 'log')
      .map((artifact) => artifact.id));
    setCollapsed(new Set(collapsibleIds.filter((id) => !topLogIds.has(id))));
  };

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <div
      className={`t-dropzone${dragOver ? ' drag-over' : ''}`}
      data-tour="artifact-browser"
      onDragEnter={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => { if (onFilesDropped && hasFiles(e)) e.preventDefault(); }}
      onDragLeave={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!onFilesDropped || !hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        if (e.dataTransfer.files.length) onFilesDropped(e.dataTransfer.files);
      }}
    >
      {dragOver && (
        <div className="t-drop-hint">
          <div>Drop to import</div>
          <div className="t-drop-hint-sub">XES, OCEL 2.0 (JSON, XML, SQLite, CSV, or bundle), PNML, or a .pmplugin package</div>
        </div>
      )}
      <div className="t-panel-header">
        <div className="t-panel-title-row">
          <div className="t-panel-title">Artifacts <span className="t-panel-count">{displayedCount}</span></div>
          <button
            className={`t-panel-menu-button${panelMenuOpen ? ' open' : ''}`}
            onClick={() => setPanelMenuOpen((open) => !open)}
            title="Artifact options"
            aria-label="Artifact options"
            aria-expanded={panelMenuOpen}
          >
            <span /><span /><span />
          </button>
        </div>
        <div className="t-search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search artifacts…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {panelMenuOpen && (
          <div className="t-panel-menu" ref={panelMenuRef}>
            <div className="t-panel-menu-heading">View</div>
            <button onClick={collapseAll}>Collapse all</button>
            <button onClick={expandTopLevelLogs}>Expand top-level logs</button>
            <button onClick={() => setShowSavedViews((shown) => !shown)}>
              {showSavedViews ? 'Hide saved views' : 'Show saved views'}
            </button>
            <div className="t-panel-menu-separator" />
            <div className="t-panel-menu-heading">Organize</div>
            <details>
              <summary>Sort by <span>›</span></summary>
              {([['manual', 'Manual order'], ['name', 'Name'], ['newest', 'Newest first'], ['oldest', 'Oldest first']] as Array<[SortMode, string]>).map(([mode, label]) => (
                <button key={mode} className={sortMode === mode ? 'selected' : ''} onClick={() => setSortMode(mode)}>{label}</button>
              ))}
            </details>
            <details>
              <summary>Group by <span>›</span></summary>
              <button className={groupMode === 'none' ? 'selected' : ''} onClick={() => setGroupMode('none')}>None</button>
              <button className={groupMode === 'type' ? 'selected' : ''} onClick={() => setGroupMode('type')}>Artifact type</button>
            </details>
            <details>
              <summary>Focus mode <span>›</span></summary>
              <button disabled={selected.length !== 1} onClick={() => selected[0] && setFocusedId(selected[0])}>Focus selected artifact</button>
              <button disabled={!focusedId} onClick={() => setFocusedId(null)}>Exit focus mode</button>
            </details>
            <div className="t-panel-menu-separator" />
            <div className="t-panel-menu-heading">Maintenance</div>
            <button className={showOnlyOrphaned ? 'selected' : ''} onClick={() => setShowOnlyOrphaned((shown) => !shown)}>
              {showOnlyOrphaned ? 'Show all artifacts' : 'Show orphaned artifacts'}
            </button>
            <button
              disabled={unusedMaterializations === 0 || cleaningUnused || !onCleanupUnusedMaterializations}
              onClick={() => setConfirmCleanupUnused(true)}
            >
              Clean up unused materializations ({unusedMaterializations})…
            </button>
            <div className="t-panel-menu-separator" />
            {onImport && <button className="t-panel-menu-action" onClick={onImport}><UploadIcon /> Import artifact…</button>}
            {onSampleLogs && <button className="t-panel-menu-action" onClick={onSampleLogs}><FolderIcon /> Browse sample logs…</button>}
            {creators.map((c) => (
              <button key={c.id} className="t-panel-menu-action" onClick={c.open}>
                <NewIcon /> {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {breadcrumb && (
        <div className="t-breadcrumb">
          {breadcrumb.map((a, i) => (
            <span key={a.id}>
              {i > 0 && <span className="t-breadcrumb-sep">›</span>}
              {displayNameOf(a)}
            </span>
          ))}
          <button className="t-breadcrumb-close" title="Exit focus" onClick={() => setFocusedId(null)}>×</button>
        </div>
      )}

      <div className="tree">
        {treeArtifacts.length === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            No artifacts yet. Import an artifact to begin.
          </div>
        )}
        {rootGroups.map((group) => (
          <Fragment key={group.label ?? '__all__'}>
            {group.label && <div className="t-group-label">{group.label}</div>}
            {group.artifacts.map((a, index) => (
              <Fragment key={a.id}>
                {index > 0 && <div className="t-root-divider" />}
                {render(a)}
              </Fragment>
            ))}
          </Fragment>
        ))}
        {visible && visible.size === 0 && (
          <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 12 }}>
            {showOnlyOrphaned && !query ? 'No orphaned artifacts.' : `Nothing matches “${query}”.`}
          </div>
        )}
      </div>

      {onImport && (
        <div className="t-footer-actions">
          <button onClick={onImport}><UploadIcon /> Import artifact…</button>
          <button data-tour="sample-logs-btn" onClick={onSampleLogs}><FolderIcon /> Browse sample logs…</button>
          {/* Every installed authoring surface behind one button. The list is
              whatever plugins contribute, so as a row of buttons it grows
              without bound and pushes the tree itself off the panel — and
              each label alone ("New survey") never said that creating things
              was one idea with several answers. */}
          {creators.length > 0 && (
            <div className="t-new-menu-wrap" ref={newMenuRef}>
              <button
                className={newMenuOpen ? 'open' : ''}
                onClick={() => setNewMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={newMenuOpen}
              >
                <NewIcon /> New artifact…
              </button>
              {newMenuOpen && (
                <div className="t-new-menu" role="menu">
                  {creators.map((c) => (
                    <button
                      key={c.id} role="menuitem"
                      onClick={() => { setNewMenuOpen(false); c.open(); }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {confirmCleanupUnused && (
        <ConfirmDialog
          title="Clean up unused materializations"
          message={`Delete ${unusedMaterializations} unreferenced artifact materialization${unusedMaterializations === 1 ? '' : 's'} from OPFS? Active artifacts remain untouched. This cannot be undone.`}
          confirmLabel="Clean up"
          danger
          onCancel={() => setConfirmCleanupUnused(false)}
          onConfirm={async () => {
            setConfirmCleanupUnused(false);
            setCleaningUnused(true);
            try { await onCleanupUnusedMaterializations?.(); } finally { setCleaningUnused(false); }
          }}
        />
      )}

      {deleting && (() => {
        const arts = deleting.map((id) => graph.artifacts[id]).filter(Boolean) as Artifact[];
        if (arts.length === 0) return null;

        // Deleting cascades to every derived artifact — its views are gone the
        // moment this one's are, so the confirmation has to say so, not just
        // name the artifacts the user picked. A selected artifact that is
        // itself derived from another selected one is not double-counted.
        const picked = new Set(arts.map((a) => a.id));
        const derived = new Set<string>();
        for (const a of arts) for (const d of descendantsOf(graph, a.id)) if (!picked.has(d)) derived.add(d);
        const extra = derived.size;
        const finish = () => {
          setDeleting(null);
          if (focusedId && picked.has(focusedId)) setFocusedId(null);
          if (arts.length === 1) onRemove(arts[0].id);
          else onRemoveMany(arts.map((a) => a.id));
        };

        if (arts.length === 1) {
          const label = displayNameOf(arts[0]);
          const msg = extra > 0
            ? `Delete "${label}" and the ${extra} artifact${extra > 1 ? 's' : ''} derived from it, ` +
              `plus their stored Parquet files? This cannot be undone.`
            : `Delete "${label}" and its stored Parquet files? This cannot be undone.`;
          return (
            <ConfirmDialog
              title="Delete artifact" message={msg} confirmLabel="Delete" danger
              onCancel={() => setDeleting(null)} onConfirm={finish}
            />
          );
        }

        const list = arts.map((a) => `  •  ${displayNameOf(a)}`).join('\n');
        const cascade = extra > 0
          ? `\n\nThis also removes ${extra} artifact${extra > 1 ? 's' : ''} derived from them, plus every stored Parquet file.`
          : `\n\nStored Parquet files for these are removed too.`;
        return (
          <ConfirmDialog
            title="Delete artifacts"
            message={`Delete these ${arts.length} artifacts?\n\n${list}${cascade}\n\nThis cannot be undone.`}
            confirmLabel={`Delete ${arts.length}`}
            danger
            onCancel={() => setDeleting(null)}
            onConfirm={finish}
          />
        );
      })()}

      {deletingViews && (() => {
        const views = deletingViews
          .map((id) => savedViews.find((v) => v.id === id))
          .filter(Boolean) as SavedView[];
        if (views.length === 0) return null;
        const finish = () => {
          setDeletingViews(null);
          onSelectSavedViews([]);
          if (views.length === 1) onRemoveSavedView(views[0].id);
          else onRemoveManySavedViews(views.map((v) => v.id));
        };
        if (views.length === 1) {
          return (
            <ConfirmDialog
              title="Delete view"
              message={`Delete "${views[0].title}"?`}
              confirmLabel="Delete" danger
              onCancel={() => setDeletingViews(null)} onConfirm={finish}
            />
          );
        }
        const list = views.map((v) => `  •  ${v.title}`).join('\n');
        return (
          <ConfirmDialog
            title="Delete views"
            message={`Delete these ${views.length} saved views?\n\n${list}\n\nThe artifacts they point at are untouched.`}
            confirmLabel={`Delete ${views.length}`}
            danger
            onCancel={() => setDeletingViews(null)}
            onConfirm={finish}
          />
        );
      })()}

      {renamingId && onRenameArtifact && (() => {
        const a = graph.artifacts[renamingId];
        if (!a) return null;
        return (
          <SaveViewDialog
            defaultTitle={a.name}
            heading="Rename artifact"
            confirmLabel="Rename"
            onCancel={() => setRenamingId(null)}
            onConfirm={(name) => {
              onRenameArtifact(a.id, name);
              setRenamingId(null);
            }}
          />
        );
      })()}
    </div>
  );
}
