/**
 * What is on screen, as a value — the fourth focus-adjacent notion, and the
 * one that describes the *arrangement* rather than a point in it.
 *
 * `selectionBus` carries elements inside an artifact, `artifactFocus` carries
 * which artifact is being looked at, `panelFocus` carries which single panel
 * to bring forward. None of them answers "what else is open, and how is it
 * configured right now" — which is a question a panel whose subject is the
 * other panels genuinely has to ask. A questionnaire step that says "filter
 * the log to the three commonest activities" cannot tell whether the
 * participant did it without reading the neighbouring panel's parameters.
 *
 * Deliberately a snapshot of *descriptions*: ids, labels, and the view
 * parameters the host already owns. No artifact contents, no handles, no
 * component references. Reading data stays behind `sql()`, and changing
 * another panel stays behind `openView()`, which the host is free to refuse.
 *
 * Written by `App`, which is the only place that holds both halves — the open
 * panels (`host/services/panels.ts`) and the per-tab `viewParams`. Read by
 * `PluginPanel` on behalf of a frame whose manifest declares `readsWorkspace`.
 */

export interface WorkspacePanelState {
  /** Dockview's panel id — unique per panel instance. */
  panelId: string;
  artifactId: string;
  artifactName: string;
  artifactType: string;
  viewId: string;
  viewLabel: string;
  /** The parameters this panel is showing, as the host currently holds them. */
  params: Record<string, unknown>;
  /** True for the panel the user is looking at. */
  active: boolean;
}

class WorkspaceState {
  private current: WorkspacePanelState[] = [];
  private listeners = new Set<(panels: WorkspacePanelState[]) => void>();
  /**
   * Cheap change detection.
   *
   * A parameter that moves with a slider re-renders `App` on every frame, and
   * every one of those would otherwise be a structured-clone postMessage into
   * every listening frame. Comparing the serialised snapshot costs far less
   * than sending it, and the payload is small and JSON-shaped by construction.
   */
  private signature = '[]';

  set(panels: WorkspacePanelState[]) {
    const next = JSON.stringify(panels);
    if (next === this.signature) return;
    this.signature = next;
    this.current = panels;
    for (const l of this.listeners) l(this.current);
  }

  get(): WorkspacePanelState[] { return this.current; }

  subscribe(fn: (panels: WorkspacePanelState[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const workspaceState = new WorkspaceState();
