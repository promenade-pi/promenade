/**
 * Saved views.
 *
 * A saved view is a named, persisted *reference* to a view plus the panel
 * parameters it was showing — a color, a sample limit, a grouping — never
 * the data itself. It deliberately has no provenance: nothing was computed,
 * nothing was derived, so it does not belong in the artifact graph. It is a
 * bookmark, not a result — the same distinction as an open browser tab
 * versus a bookmark to it. Reopening one re-queries the source artifact
 * through the same view it always went through; only the settings are new.
 *
 * Stored the same way installed plugins are stored per plugin: one JSON
 * index, no binary payloads, nothing that needs unpacking — but scoped
 * under the active workspace's own OPFS subtree, since which views are
 * saved is workspace-specific.
 */

import { workspaceRoot } from '../data/opfs';

export interface SavedView {
  id: string;
  title: string;
  /** The artifact this view was opened against. */
  sourceArtifactId: string;
  /** The view registry id — which renderer opens this. */
  view: string;
  /** The panel's params at the moment it was saved. */
  state: Record<string, unknown>;
  createdAt: string;
  /** The view's plugin id, e.g. `ViewDef.provider` — absent for core views. */
  providerId?: string;
  /** That plugin's installed version at the moment this was last saved. */
  providerVersion?: string;
}

const FILE = 'saved-views.json';

async function readIndex(workspaceId?: string): Promise<Record<string, SavedView>> {
  try {
    const h = await (await workspaceRoot(workspaceId)).getFileHandle(FILE);
    return JSON.parse(await (await h.getFile()).text());
  } catch { return {}; }
}

async function writeIndex(idx: Record<string, SavedView>, workspaceId?: string) {
  const h = await (await workspaceRoot(workspaceId)).getFileHandle(FILE, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(idx, null, 2)));
  await w.close();
}

export async function listSavedViews(workspaceId?: string): Promise<SavedView[]> {
  return Object.values(await readIndex(workspaceId));
}

export async function saveView(input: {
  title: string;
  sourceArtifactId: string;
  view: string;
  state: Record<string, unknown>;
}): Promise<SavedView> {
  const idx = await readIndex();
  const id = `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const sv: SavedView = { id, createdAt: new Date().toISOString(), ...input };
  idx[id] = sv;
  await writeIndex(idx);
  return sv;
}

export async function renameSavedView(id: string, title: string): Promise<void> {
  const idx = await readIndex();
  if (!idx[id]) return;
  idx[id] = { ...idx[id], title };
  await writeIndex(idx);
}

export async function removeSavedView(id: string): Promise<void> {
  const idx = await readIndex();
  delete idx[id];
  await writeIndex(idx);
}

/** Deletes several saved views in one write — a multi-select delete from the
 * tree. A missing id is simply skipped. */
export async function removeSavedViews(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const idx = await readIndex();
  let changed = false;
  for (const id of ids) if (idx[id]) { delete idx[id]; changed = true; }
  if (changed) await writeIndex(idx);
}

function mintId(): string {
  return `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Creates-or-updates a saved view record.
 *
 * Opening a view and editing its parameters no longer needs an explicit
 * "Save view…" step: every open upserts here. With `input.id` given, it
 * updates that exact record (or creates it with that id if missing) — the
 * caller already knows which one, e.g. a tab editing the params of one
 * specific duplicated view among several sharing the same (artifact, view)
 * pair. Without an id, it falls back to the pair itself: the common case of
 * exactly one saved view per (artifact, view), where re-opening it should
 * update that one record in place rather than accumulate duplicates.
 */
export async function upsertView(input: {
  id?: string;
  sourceArtifactId: string;
  view: string;
  state: Record<string, unknown>;
  title: string;
  /** The view's plugin id and its currently-installed version, if any —
   * restamped on every save so the record always reflects what last wrote
   * it. Used for the version-mismatch warning on reopen. */
  providerId?: string;
  providerVersion?: string;
}): Promise<SavedView> {
  const idx = await readIndex();
  const existing = input.id
    ? idx[input.id]
    : Object.values(idx).find(
        (v) => v.sourceArtifactId === input.sourceArtifactId && v.view === input.view
      );
  const sv: SavedView = existing
    ? { ...existing, state: input.state, providerId: input.providerId, providerVersion: input.providerVersion }
    : {
        id: input.id ?? mintId(),
        title: input.title,
        sourceArtifactId: input.sourceArtifactId,
        view: input.view,
        state: input.state,
        createdAt: new Date().toISOString(),
        providerId: input.providerId,
        providerVersion: input.providerVersion,
      };
  idx[sv.id] = sv;
  await writeIndex(idx);
  return sv;
}

/**
 * Moves the saved views belonging to `sourceArtifactIds` into another
 * workspace's index — the saved-view half of moving an artifact between
 * workspaces (see `DataClient.moveArtifactToWorkspace`). A view has no data
 * of its own, so this is a metadata move, not a file move.
 */
export async function moveViewsForSources(
  sourceArtifactIds: Set<string>, fromWorkspaceId: string, toWorkspaceId: string
): Promise<void> {
  const from = await readIndex(fromWorkspaceId);
  const to = await readIndex(toWorkspaceId);
  let changed = false;
  for (const [id, v] of Object.entries(from)) {
    if (!sourceArtifactIds.has(v.sourceArtifactId)) continue;
    to[id] = v;
    delete from[id];
    changed = true;
  }
  if (!changed) return;
  await writeIndex(to, toWorkspaceId);
  await writeIndex(from, fromWorkspaceId);
}

/**
 * Copies a saved view into a second, independent record for the same
 * (artifact, view) pair — e.g. two "Dotted Chart" views on one log, each
 * filtered to a different object type. Starts from the source's current
 * params rather than the view's bare defaults, since duplicating usually
 * means "this, but slightly different," not "start over."
 */
export async function duplicateSavedView(id: string): Promise<SavedView> {
  const idx = await readIndex();
  const source = idx[id];
  if (!source) throw new Error('Saved view not found');
  const titles = new Set(Object.values(idx)
    .filter((v) => v.sourceArtifactId === source.sourceArtifactId && v.view === source.view)
    .map((v) => v.title));
  let title = `${source.title} copy`;
  for (let n = 2; titles.has(title); n++) title = `${source.title} copy ${n}`;
  const copy: SavedView = {
    ...source,
    id: mintId(),
    title,
    createdAt: new Date().toISOString(),
  };
  idx[copy.id] = copy;
  await writeIndex(idx);
  return copy;
}

/** Cascade-delete cleanup: an artifact's views have no data of their own to
 * outlive it — leaving them behind is a storage leak, not a feature. */
export async function removeViewsForSources(ids: Set<string>): Promise<void> {
  const idx = await readIndex();
  let changed = false;
  for (const [id, v] of Object.entries(idx)) {
    if (ids.has(v.sourceArtifactId)) { delete idx[id]; changed = true; }
  }
  if (changed) await writeIndex(idx);
}
