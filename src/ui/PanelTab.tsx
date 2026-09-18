import { useCallback, useState } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { viewRegistry } from '../host/views/registry';
import { artifactTypes } from '../host/artifact/registry';
import type { ProvenanceGraph } from '../host/artifact/types';
import { panelFullscreen } from '../host/services/panels';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

/**
 * Compact panel tab.
 *
 * A tab is a label for a *view*, not for an artifact. Putting the artifact name
 * in the tab makes every tab as wide as the longest file the user imported, and
 * three panels of one log then read as three near-identical strips. The view
 * name is short, stable and is the thing that actually differs between the
 * panels of a default layout; which artifact is being viewed is answered by the
 * breadcrumb bar directly underneath, the same division VS Code uses.
 */
/** Small plug glyph marking a tab as a plugin panel rather than an artifact view. */
function PlugIcon() {
  return (
    <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
      <path d="M4 1.2v2.3M8 1.2v2.3" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" />
      <rect x="3" y="3.5" width="6" height="4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 7.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PanelTab(props: IDockviewPanelHeaderProps<{
  artifactId?: string; view?: string; graph?: ProvenanceGraph;
  viewParams?: Record<string, unknown>;
  /** Set when this panel's view has an auto-persisted record, possibly renamed. */
  savedViewId?: string;
  /** Transient chrome (the destination gallery) — shown in italics. */
  preview?: boolean;
}>) {
  const { view, artifactId, graph, savedViewId, preview } = props.params ?? {};
  const def = view ? viewRegistry.get(view) : undefined;
  const artifact = artifactId ? graph?.artifacts[artifactId] : undefined;
  const type = artifact ? artifactTypes.get(artifact.type) : undefined;

  // A standalone panel isn't a view *of* an artifact — the view registry's
  // label for it ("Plugin") is the same for every one, so it is the caller's
  // own title (the plugin's actual name) that has to appear on the tab, the
  // same way an artifact's own name never shows up in the badge slot. A
  // saved view earns the same treatment for the same reason: "Dotted chart"
  // is the renderer's name, not the name the user gave this configuration
  // of it.
  const standalone = !!def?.standalone && !artifact;
  const label = (standalone || savedViewId)
    ? (props.api.title ?? def?.label ?? 'Panel')
    : (def?.label ?? props.api.title ?? 'Panel');
  const isPlugin = view === 'core.pluginDetails';

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  /**
   * VS Code's tab menu, scoped to the panel's own group — the same scope its
   * physical tab strip covers. Built only while the menu is open: reading
   * `group.panels` is cheap, but there is no reason to do it on every render
   * the tab strip causes. The *ids* are snapshotted at open time, so the
   * choices offered match what the user saw when they right-clicked rather
   * than what is left partway through acting on them — but each id is
   * re-resolved to a live panel right before it is closed, because closing
   * one panel invalidates dockview's `IDockviewPanel` objects for the
   * others still in the group; closing by a stale reference silently no-ops.
   */
  const menuItems: ContextMenuItem[] | null = !menu ? null : (() => {
    const panels = props.api.group.panels;
    const idx = panels.findIndex((p) => p.id === props.api.id);
    const otherIds = panels.filter((p) => p.id !== props.api.id).map((p) => p.id);
    const toRightIds = idx >= 0 ? panels.slice(idx + 1).map((p) => p.id) : [];
    const allIds = panels.map((p) => p.id);
    const closeByIds = (ids: string[]) => {
      for (const id of ids) props.api.group.panels.find((p) => p.id === id)?.api.close();
    };
    return [
      ...(def?.entry ? [{ label: 'Open Full Screen', action: () => panelFullscreen.request(props.api.id) } as ContextMenuItem, 'separator' as const] : []),
      { label: 'Close', action: () => props.api.close() },
      'separator',
      { label: 'Close Others', disabled: otherIds.length === 0, action: () => closeByIds(otherIds) },
      { label: 'Close to the Right', disabled: toRightIds.length === 0, action: () => closeByIds(toRightIds) },
      'separator',
      { label: 'Close All', disabled: allIds.length <= 1, action: () => closeByIds(allIds) },
    ];
  })();

  return (
    <div
      className={`pm-tab${preview ? ' pm-tab--preview' : ''}`}
      // The artifact stays reachable for a tab that has been narrowed by a
      // crowded tab strip.
      title={artifact ? `${label} — ${artifact.name}` : (isPlugin ? `Plugin — ${label}` : label)}
      onContextMenu={onContextMenu}
    >
      {type && <span className="pm-tab-kind">{type.shortLabel}</span>}
      {!type && isPlugin && (
        <span className="pm-tab-kind pm-tab-kind-plugin">
          <PlugIcon /> PLG
        </span>
      )}
      <span className="pm-tab-label">{label}</span>
      <button
        className="pm-tab-close"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          // Without this the mousedown reaches the tab strip and dockview
          // starts a drag from a tab that is about to disappear.
          e.stopPropagation();
          props.api.close();
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        ×
      </button>
      {menu && menuItems && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  );
}
