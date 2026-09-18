import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 12;

/**
 * A quiet, non-blocking callout pointing at the topbar Plugins button.
 *
 * Shown whenever a workspace has nothing installed beyond the bundled
 * defaults — the same signal the welcome dialog's tour ends on, but for
 * whoever closed that dialog without taking the tour. Unlike `Tour`, this
 * never dims or blocks the page: it floats beside the button, and it keeps
 * reappearing on every load until an actual install changes the plugin
 * list, rather than offering a dismiss that would just be remembered as
 * "never ask again".
 */
export function PluginsNudge({ onOpen }: { onOpen: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const update = () => {
      const el = document.querySelector<HTMLElement>('[data-tour="plugins-btn"]');
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    window.addEventListener('resize', update);
    const id = window.setInterval(update, 400);
    return () => {
      window.removeEventListener('resize', update);
      window.clearInterval(id);
    };
  }, []);

  if (!rect) return null;

  return createPortal(
    <div
      className="plugins-nudge"
      style={{ top: rect.bottom + GAP, left: rect.left + rect.width / 2 }}
    >
      <div className="plugins-nudge-arrow" />
      <button className="plugins-nudge-card" onClick={onOpen}>
        <strong>You're running the bundled defaults</strong>
        <span>Open Plugins and install everything the registry offers.</span>
      </button>
    </div>,
    document.body,
  );
}
