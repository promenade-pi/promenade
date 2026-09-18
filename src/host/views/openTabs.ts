/**
 * Open-tabs snapshot.
 *
 * Which panels are open, showing which view of which artifact, with what
 * parameters — the workspace's own arrangement, not anything derived from
 * the catalog. Stored the same way saved views are (see `savedViews.ts`):
 * one JSON blob under the active workspace's own OPFS subtree, since which
 * tabs were open is workspace-specific and has no place in the shared
 * catalog.
 *
 * Deliberately untyped against `OpenTab` (defined in `ui/Workspace.tsx`,
 * a UI module): the host layer has no business importing UI types, and a
 * plain JSON-shaped record is all a snapshot needs to be. The caller in
 * `App.tsx` already owns the real `OpenTab[]` and casts at the boundary.
 */

import { workspaceRoot } from '../data/opfs';

export interface OpenTabsState {
  tabs: Record<string, unknown>[];
  /** The tab that was focused when this was last saved, if any. */
  activeTabId?: string;
}

const FILE = 'open-tabs.json';
const EMPTY: OpenTabsState = { tabs: [] };

export async function readOpenTabs(workspaceId?: string): Promise<OpenTabsState> {
  try {
    const h = await (await workspaceRoot(workspaceId)).getFileHandle(FILE);
    const parsed = JSON.parse(await (await h.getFile()).text());
    return { tabs: Array.isArray(parsed?.tabs) ? parsed.tabs : [], activeTabId: parsed?.activeTabId };
  } catch { return EMPTY; }
}

export async function writeOpenTabs(state: OpenTabsState, workspaceId?: string): Promise<void> {
  const h = await (await workspaceRoot(workspaceId)).getFileHandle(FILE, { create: true });
  const w = await h.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(state, null, 2)));
  await w.close();
}
