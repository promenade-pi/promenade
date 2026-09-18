import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Asked once per panel, the first time an unsaved Notebook/Script publishes
 * an artifact — not on every publish call (see `ensureSaved` in
 * `NotebookView.tsx`/`ScriptEditor.tsx`, which remembers the answer for the
 * rest of the panel's session).
 *
 * There is no plain "Cancel" here on purpose: declining doesn't abort the
 * publish already in flight, it just answers "don't nest the result under
 * a notebook/script artifact" — so Escape and a backdrop click both mean
 * "continue without saving", the same as clicking that button.
 */
export function SaveBeforePublishDialog({
  defaultName, kindLabel, onSave, onContinueLoose,
}: {
  defaultName: string;
  /** "notebook" or "script" — copy only. */
  kindLabel: string;
  onSave: (name: string) => void;
  onContinueLoose: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onContinueLoose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onContinueLoose]);

  const save = () => {
    const t = name.trim();
    if (t) onSave(t);
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onContinueLoose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">Save this {kindLabel} before publishing?</div>
        <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: '0 0 8px', lineHeight: 1.5 }}>
          Publishing still works either way — but only a saved {kindLabel} shows the result
          nested under it in the artifact tree and provenance. You can rename it here.
        </p>
        <input
          ref={inputRef}
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          placeholder={`Name this ${kindLabel}`}
        />
        <div className="modal-actions">
          <button onClick={onContinueLoose}>Continue without saving</button>
          <button className="primary" disabled={!name.trim()} onClick={save}>Save</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
