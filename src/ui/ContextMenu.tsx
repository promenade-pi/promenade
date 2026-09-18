import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';

/**
 * A minimal right-click menu, positioned at the pointer and dismissed on an
 * outside click, Escape, or window blur.
 *
 * Built on dockview's own `.dv-context-menu*` classes rather than a bespoke
 * look: those ship with the (MIT) `dockview-react` stylesheet already
 * imported for the workspace, and are styled by the same `--dv-*` theme
 * variables as the tab strip. Only the *JS* wiring for a tab menu is gated
 * behind the separately licensed `dockview-enterprise` package — the CSS
 * carries no such restriction, and reusing it is what keeps a hand-rolled
 * menu indistinguishable from a native one.
 */

export type ContextMenuItem =
  | { label: string; action: () => void; disabled?: boolean }
  | { label: string; submenu: ContextMenuItem[]; disabled?: boolean }
  | 'separator';

export function ContextMenu({
  x, y, items, onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({
    left: 'calc(100% + 3px)', top: -1,
  });

  const showSubmenu = (index: number) => {
    // Measure from the normal, top-aligned position first. This avoids a
    // previous flyout's flipped location being visible for one frame.
    setSubmenuPosition({ left: 'calc(100% + 3px)', top: -1 });
    setOpenSubmenu(index);
  };

  useLayoutEffect(() => {
    // Listeners are attached after mount, so the mousedown half of the
    // right-click that opened this menu — already dispatched by the time
    // React commits — never immediately closes it.
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  // Clamped after the first layout, once the menu's real size is known —
  // opening near the right or bottom edge must not run it off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflowX = x + rect.width - window.innerWidth;
    const overflowY = y + rect.height - window.innerHeight;
    el.style.left = `${overflowX > 0 ? Math.max(4, x - overflowX) : x}px`;
    el.style.top = `${overflowY > 0 ? Math.max(4, y - overflowY) : y}px`;
  }, [x, y]);

  // A flyout belongs beside its parent item, but that does not imply its top
  // must be aligned to the item. Near the lower edge, align their bottoms so
  // the complete export list remains reachable instead of running below the
  // workspace. The same pass also flips horizontally when there is room only
  // on the left.
  useLayoutEffect(() => {
    const submenu = submenuRef.current;
    if (!submenu || openSubmenu == null) return;
    const flyout = submenu.getBoundingClientRect();
    const parent = submenu.parentElement?.getBoundingClientRect();
    if (!parent) return;

    let top = -1;
    let left: CSSProperties['left'] = 'calc(100% + 3px)';
    if (flyout.bottom > window.innerHeight - 4) {
      top = Math.max(4 - parent.top, Math.round(parent.height - flyout.height + 1));
    }
    if (flyout.right > window.innerWidth - 4 && parent.left - flyout.width - 3 >= 4) {
      left = -Math.round(flyout.width + 3);
    }
    setSubmenuPosition({ top, left });
  }, [openSubmenu]);

  return createPortal(
    <div
      ref={ref}
      // `dockview-theme-light` carries the `--dv-*` custom properties
      // `.dv-context-menu` reads. Those only cascade to real DOM descendants
      // of the element with the class — a portal escapes the workspace's own
      // themed subtree by rendering into `document.body`, so the class has
      // to be repeated here or the menu draws with every color unset. The
      // colours it ends up with are the app's own tokens, not dockview's
      // light palette (see the `--dv-*` mapping in `styles.css`).
      className="dockview-theme-light dv-context-menu"
      // Dockview's stock context-menu stylesheet sets `overflow: hidden` to
      // clip hover backgrounds at its rounded corners. That also clips our
      // absolutely positioned Export flyout completely, leaving only the
      // parent item's hover shade visible. The outer menu must be visible;
      // each flyout still owns its own rounded background.
      style={{ position: 'fixed', left: x, top: y, zIndex: 1000, overflow: 'visible' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => item === 'separator'
        ? <div className="dv-context-menu-separator" key={i} />
        : 'submenu' in item ? (
          <div
            key={i}
            className={`dv-context-menu-item${item.disabled ? ' dv-context-menu-item--disabled' : ''}`}
            style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', gap: 18 }}
            onMouseEnter={() => { if (!item.disabled) showSubmenu(i); }}
            onClick={(e) => { e.stopPropagation(); if (!item.disabled) showSubmenu(i); }}
          >
            <span>{item.label}</span><span aria-hidden="true">›</span>
            {openSubmenu === i && !item.disabled && (
              <div
                className="dockview-theme-light dv-context-menu"
                ref={submenuRef}
                style={{ position: 'absolute', ...submenuPosition, zIndex: 1, whiteSpace: 'nowrap' }}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                {item.submenu.map((child, childIndex) => child === 'separator'
                  ? <div className="dv-context-menu-separator" key={childIndex} />
                  : 'submenu' in child
                    ? null // One flyout level is enough for all current menus.
                    : (
                      <div
                        key={childIndex}
                        className={`dv-context-menu-item${child.disabled ? ' dv-context-menu-item--disabled' : ''}`}
                        onClick={() => { if (!child.disabled) { child.action(); onClose(); } }}
                      >
                        {child.label}
                      </div>
                    ))}
              </div>
            )}
          </div>
        ) : (
          <div
            key={i}
            className={`dv-context-menu-item${item.disabled ? ' dv-context-menu-item--disabled' : ''}`}
            onClick={() => { if (!item.disabled) { item.action(); onClose(); } }}
          >
            {item.label}
          </div>
        ))}
    </div>,
    document.body
  );
}
