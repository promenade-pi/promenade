import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Names a panel before it becomes a saved view.
 *
 * A modal, not an inline field: this is the one moment a view stops being
 * disposable and becomes a named, tree-visible thing, and that deserves a
 * deliberate step rather than a text box that silently commits on blur.
 */
export function SaveViewDialog({
  defaultTitle, heading = 'Save view', confirmLabel = 'Save', onCancel, onConfirm,
}: {
  defaultTitle: string;
  heading?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (title: string) => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const confirm = () => {
    const t = title.trim();
    if (t) onConfirm(t);
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">{heading}</div>
        <input
          ref={inputRef}
          className="modal-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
          placeholder="Name this view"
        />
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!title.trim()} onClick={confirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
