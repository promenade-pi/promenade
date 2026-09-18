import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface TourStep {
  /** Locates the element to spotlight. Re-run on every poll tick, so it can
   *  return null while the element hasn't mounted yet (e.g. behind a dialog
   *  `onEnter` just opened) without the tour erroring out. */
  target: () => HTMLElement | null;
  title: string;
  body: string;
  placement?: TourPlacement;
  /** Fired once when the step becomes current — e.g. to open a dialog the
   *  step's target lives inside. */
  onEnter?: () => void;
  /** Overrides the default "Next"/"Finish" button. Receives `advance`, the
   *  function that would normally move to the next step, so custom handling
   *  (like triggering a real click elsewhere) can still end with it. */
  primaryLabel?: string;
  onPrimary?: (advance: () => void) => void;
}

const PAD = 6;
const GAP = 14;
const CARD_MARGIN = 12;
const POLL_MS = 130;
const MAX_POLLS = 45;

/**
 * A minimal coach-mark tour: dims the screen, cuts a spotlight around one
 * element at a time via a giant box-shadow (no clip-path/SVG mask needed),
 * and floats a captioned card with an arrow next to it. The dimming layer
 * has `pointer-events: none` throughout — the tour never blocks the app, so
 * a step's real target stays clickable exactly where the user is looking,
 * and a user who acts on it directly (installing a plugin, say) doesn't
 * first have to dismiss anything.
 */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [searching, setSearching] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);
  const step = steps[index];

  const advance = () => {
    if (index >= steps.length - 1) onClose();
    else setIndex((i) => i + 1);
  };
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // Locate this step's target, polling briefly for one that mounts async
  // (a dialog `onEnter` just opened, a registry fetch still in flight).
  useEffect(() => {
    let canceled = false;
    let tries = 0;
    setRect(null);
    setSearching(true);
    step.onEnter?.();
    const poll = () => {
      if (canceled) return;
      const el = step.target();
      if (el) {
        setRect(el.getBoundingClientRect());
        setSearching(false);
        return;
      }
      tries += 1;
      if (tries >= MAX_POLLS) { setSearching(false); return; }
      setTimeout(poll, POLL_MS);
    };
    poll();
    return () => { canceled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  // Keep tracking the target once found — layout can still shift under it
  // (a dialog finishing its open animation, a window resize).
  useEffect(() => {
    if (!rect) return;
    const update = () => {
      const el = step.target();
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const id = window.setInterval(update, 300);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect !== null, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Position the card relative to the spotlighted rect, then clamp it back
  // onto the screen once its real size is known.
  useLayoutEffect(() => {
    if (!rect) { setCardPos(null); return; }
    const placement = step.placement ?? 'bottom';
    const cw = cardRef.current?.offsetWidth ?? 300;
    const ch = cardRef.current?.offsetHeight ?? 140;
    let top = 0;
    let left = 0;
    switch (placement) {
      case 'top':
        top = rect.top - GAP - ch;
        left = rect.left + rect.width / 2 - cw / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - ch / 2;
        left = rect.left - GAP - cw;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - ch / 2;
        left = rect.right + GAP;
        break;
      case 'bottom':
      default:
        top = rect.bottom + GAP;
        left = rect.left + rect.width / 2 - cw / 2;
    }
    top = Math.max(CARD_MARGIN, Math.min(top, window.innerHeight - ch - CARD_MARGIN));
    left = Math.max(CARD_MARGIN, Math.min(left, window.innerWidth - cw - CARD_MARGIN));
    setCardPos({ top, left });
    // Re-measure whenever the card's own content changes size too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, step.placement, step.title, step.body]);

  const arrowSide = rect ? (step.placement ?? 'bottom') : null;

  return createPortal(
    <div className="tour-overlay" role="dialog" aria-modal="true" aria-label={step.title}>
      {rect
        ? (
          <div
            className="tour-spotlight"
            style={{
              top: rect.top - PAD, left: rect.left - PAD,
              width: rect.width + PAD * 2, height: rect.height + PAD * 2,
            }}
          />
        )
        : <div className="tour-dim" />}

      <div
        className="tour-card"
        ref={cardRef}
        style={cardPos
          ? { top: cardPos.top, left: cardPos.left }
          : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
      >
        {arrowSide && <div className={`tour-arrow tour-arrow-${arrowSide}`} />}
        <div className="tour-card-head">
          <span className="tour-step-count">Step {index + 1} of {steps.length}</span>
          <button className="tour-skip" onClick={onClose}>Skip tour</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">
          {searching && !rect ? 'One moment…' : step.body}
        </p>
        <div className="tour-actions">
          <div className="tour-dots">
            {steps.map((_, i) => <span key={i} className={`tour-dot${i === index ? ' active' : ''}`} />)}
          </div>
          <div className="tour-nav">
            {index > 0 && <button onClick={back}>Back</button>}
            <button
              className="primary"
              onClick={() => (step.onPrimary ? step.onPrimary(advance) : advance())}
            >
              {step.primaryLabel ?? (index === steps.length - 1 ? 'Finish' : 'Next')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
