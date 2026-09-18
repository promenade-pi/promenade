/**
 * Panel focus — the third focus notion, deliberately separate from the other two.
 *
 * `selectionBus` carries elements *inside* an artifact, `artifactFocus` carries
 * which artifact is being looked at, and this carries which *panel* is on
 * screen. They are different questions: one artifact can be open in several
 * panels, so "show me the Activities view of this log" cannot be expressed as
 * an artifact focus.
 *
 * Only the workspace can act on it — panel geometry belongs to the host, and
 * this is the one door through which the rest of the shell may ask for a panel
 * without touching the docking API itself.
 */
class PanelFocus {
  private listeners = new Set<(panelId: string) => void>();

  request(panelId: string) {
    for (const l of this.listeners) l(panelId);
  }

  subscribe(fn: (panelId: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const panelFocus = new PanelFocus();

/**
 * A request to show one sandboxed plugin view without the surrounding docking
 * layout. As with focus, only Workspace owns the actual DOM and panel
 * geometry; tabs ask through this small service rather than importing the
 * docking API.
 */
class PanelFullscreen {
  private listeners = new Set<(panelId: string) => void>();

  request(panelId: string) {
    for (const l of this.listeners) l(panelId);
  }

  subscribe(fn: (panelId: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const panelFullscreen = new PanelFullscreen();

/** One open panel, as reported by the workspace to the rest of the shell. */
export interface OpenPanel {
  panelId: string;
  artifactId: string;
  view: string;
  /** Set when this panel was opened from a specific saved-view record, not
   * just its (artifactId, view) pair — the only way to tell two duplicated
   * views of the same type apart (e.g. two Dotted Charts on one log). */
  savedViewId?: string;
}
