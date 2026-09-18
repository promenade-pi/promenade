import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Replaces `window.confirm` for anything destructive.
 *
 * Some embedded and automated browser contexts don't support the blocking
 * native confirm dialog — the call returns without ever showing anything, so
 * the destructive action just silently never happens. A real in-page dialog
 * works everywhere a modal does.
 */
export function ConfirmDialog({
  title, message, confirmLabel = 'Confirm', danger = false, onCancel, onConfirm,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" role="alertdialog" aria-modal="true">
        <div className="modal-title" style={danger ? { color: 'var(--danger)' } : undefined}>{title}</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 4px', whiteSpace: 'pre-line' }}>
          {message}
        </p>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            ref={confirmRef}
            style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' } : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
