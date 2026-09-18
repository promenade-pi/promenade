import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const PHRASE = 'reset';

/**
 * Last-resort recovery when the catalog itself has gone inconsistent — a
 * root deleted before cascade-delete existed, an interrupted write — and
 * there is no partial-repair path. Requires typing a phrase rather than a
 * single confirm(): this deletes every artifact, plugin and saved view in
 * one shot, with no per-item review the way "Delete artifact" gets.
 */
export function ResetWorkspaceDialog({
  onCancel, onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const ready = text.trim().toLowerCase() === PHRASE;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title" style={{ color: 'var(--danger)' }}>Reset workspace</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 10px' }}>
          Deletes every artifact and saved view in this workspace, and its
          engine session — everything this app has stored for it. Installed
          plugins and other workspaces are not affected. This cannot be
          undone.
        </p>
        <p style={{ fontSize: 12, margin: '0 0 6px' }}>
          Type <strong>{PHRASE}</strong> to confirm.
        </p>
        <input
          ref={inputRef}
          className="modal-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ready) onConfirm(); }}
          placeholder={PHRASE}
          autoComplete="off"
        />
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            disabled={!ready}
            style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }}
            onClick={onConfirm}
          >
            Reset workspace
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
