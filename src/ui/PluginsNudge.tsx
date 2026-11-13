import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 12;

/**
 * A quiet, non-blocking callout pointing at the topbar Plugins button.
 *
 * Shown whenever a workspace has nothing installed beyond the bundled
 * defaults — the same signal the welcome dialog's tour ends on, but for
 * whoever closed that dialog without taking the tour. Unlike `Tour`, this
 * never dims or blocks the page: it floats beside the button.
 *
 * Once seen it can be put away for good — via its ✕, or by following it
 * into Plugins. An earlier version kept reappearing on every load until an
 * install changed the plugin list; users who had read it and chosen not to
 * install had no way to get rid of it.
 */
const DISMISS_KEY = 'promenade.pluginsNudge.dismissed';

function isDismissed(): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}

function rememberDismissed() {
  try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable: hide for this load only */ }
}

export function PluginsNudge({ onOpen }: { onOpen: () => void }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [dismissed, setDismissed] = useState(isDismissed);

  useEffect(() => {
    if (dismissed) return;
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
  }, [dismissed]);

  if (dismissed || !rect) return null;

  const dismiss = () => { rememberDismissed(); setDismissed(true); };

  return createPortal(
    <div
      className="plugins-nudge"
      style={{ top: rect.bottom + GAP, left: rect.left + rect.width / 2 }}
    >
      <div className="plugins-nudge-arrow" />
      <div className="plugins-nudge-body">
        <button className="plugins-nudge-card" onClick={() => { dismiss(); onOpen(); }}>
          <strong>You're running the bundled defaults</strong>
          <span>Open Plugins and install everything the registry offers.</span>
        </button>
        <button
          className="plugins-nudge-close"
          onClick={dismiss}
          title="Don't show this again"
          aria-label="Dismiss plugins hint"
        >
          ×
        </button>
      </div>
    </div>,
    document.body,
  );
}
