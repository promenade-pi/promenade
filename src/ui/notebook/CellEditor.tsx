/**
 * CodeMirror 6 wrapper for one notebook cell.
 *
 * Reuses the exact editor stack `ScriptEditor.tsx` already uses — no new
 * editor dependency. Shift+Enter/Ctrl(Cmd)+Enter/Alt+Enter are bound with
 * `Prec.highest` on this editor's own keymap only, so they never register
 * globally and never fight a text input elsewhere in the app (per
 * docs/python-notebook.md's explicit requirement).
 */

import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';

export function CellEditor({
  cellId, source, language, onChange, onRun, onRunAndAdvance, onRunAndInsertBelow, onFocus, autoFocus,
}: {
  cellId: string;
  source: string;
  language: 'python' | 'text';
  onChange: (text: string) => void;
  onRun: () => void;
  onRunAndAdvance: () => void;
  onRunAndInsertBelow: () => void;
  onFocus?: () => void;
  autoFocus?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onRun, onRunAndAdvance, onRunAndInsertBelow, onFocus });
  cbs.current = { onChange, onRun, onRunAndAdvance, onRunAndInsertBelow, onFocus };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      doc: source,
      parent: host.current,
      extensions: [
        basicSetup,
        ...(language === 'python' ? [python()] : []),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cbs.current.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          focus: () => { cbs.current.onFocus?.(); return false; },
        }),
        Prec.highest(keymap.of([
          { key: 'Shift-Enter', run: () => { cbs.current.onRunAndAdvance(); return true; } },
          { key: 'Mod-Enter', run: () => { cbs.current.onRun(); return true; } },
          { key: 'Alt-Enter', run: () => { cbs.current.onRunAndInsertBelow(); return true; } },
        ])),
        EditorView.theme({
          '&': { fontSize: '12px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-content': { minHeight: '1.6em' },
        }),
      ],
    });
    view.current = v;
    if (autoFocus) v.focus();
    // Dev affordance matching ScriptEditor.tsx's identical escape hatch:
    // lets a cell be driven without synthetic pointer events.
    if (import.meta.env.DEV) (globalThis as any).__notebookEditors = { ...(globalThis as any).__notebookEditors, [cellId]: v };
    return () => v.destroy();
    // Recreated only when the cell identity changes — content edits flow
    // through onChange, not through re-mounting the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellId]);

  return <div ref={host} className="notebook-cell-editor" />;
}
