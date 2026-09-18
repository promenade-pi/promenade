import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Resizable, collapsible side panel.
 *
 * The two side panels sit outside the docking system deliberately. The artifact
 * list is the navigation model — a panel the user could close would take it
 * with them. The inspector holds the live-recompute controls, and a dockable
 * inspector could end up *tabbed behind* the very view it is driving, which
 * would break the one interaction the whole design is built around: moving a
 * parameter and watching the result change.
 *
 * Neither reason argues against resizing or collapsing, so both are offered
 * here. Width and collapsed state persist, because a layout the user has to
 * re-establish on every reload is not really theirs.
 */
export function SidePanel({
  side, title, defaultWidth, minWidth = 200, maxWidth = 560, storageKey, children,
}: {
  side: 'left' | 'right';
  title: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  storageKey: string;
  children: ReactNode;
}) {
  const read = <T,>(key: string, fallback: T): T => {
    try {
      const raw = localStorage.getItem(`${storageKey}.${key}`);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch { return fallback; }
  };
  const write = (key: string, value: unknown) => {
    try { localStorage.setItem(`${storageKey}.${key}`, JSON.stringify(value)); } catch {}
  };

  const [width, setWidth] = useState<number>(() => read('width', defaultWidth));
  const [collapsed, setCollapsed] = useState<boolean>(() => read('collapsed', false));
  const dragging = useRef(false);

  useEffect(() => { write('width', width); }, [width]);
  useEffect(() => { write('collapsed', collapsed); }, [collapsed]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    // Measured from the window edge, so the handle stays under the cursor
    // regardless of what is between the panel and that edge.
    const raw = side === 'left' ? e.clientX : window.innerWidth - e.clientX;
    setWidth(Math.max(minWidth, Math.min(maxWidth, raw)));
  }, [side, minWidth, maxWidth]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  if (collapsed) {
    return (
      <div className={`side-rail ${side}`}>
        <button
          className="side-rail-btn"
          onClick={() => setCollapsed(false)}
          title={`Show ${title}`}
          aria-label={`Show ${title}`}
        >
          <Chevron dir={side === 'left' ? 'right' : 'left'} />
        </button>
      </div>
    );
  }

  return (
    <div className={`side ${side}`} style={{ width }}>
      <div className="side-body">{children}</div>

      {/* An edge tab straddling the panel's own border — the same place
          design tools (Figma, Sketch) put this — rather than a bar sitting
          on top of the panel's content. Anchored to the vertical middle so
          it never lands on whatever happens to be at the bottom of the
          panel (the storage meter, the last "available actions" row), and
          dim rather than fully invisible at rest, so it stays findable
          without competing with the content next to it. */}
      <button
        className={`side-collapse ${side}`}
        onClick={() => setCollapsed(true)}
        title={`Hide ${title}`}
        aria-label={`Hide ${title}`}
      >
        <Chevron dir={side === 'left' ? 'left' : 'right'} />
      </button>

      {/* Double-click restores the default width — faster than dragging back. */}
      <div
        className={`side-handle ${side}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setWidth(defaultWidth)}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
      />
    </div>
  );
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"
         style={{ transform: dir === 'left' ? 'rotate(180deg)' : undefined }}>
      <path d="M4.5 2.5 L8 6 L4.5 9.5" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
