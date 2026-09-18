/**
 * Python notebook — a Promenade-native view, not an embedded JupyterLab.
 *
 * Opened via "Views → Python notebook" on any artifact. The selected
 * artifact is automatically available to Python as `artifact` (and, for the
 * two log types, as `log`) through `promenade.current_artifact()`. See
 * docs/python-notebook.md for the full architecture; this component owns
 * only cell/kernel UI — every capability notebook Python has goes through
 * `BrowserPyodideKernel` + `NotebookBridgeHost`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import {
  type NotebookDocument, type CodeCell, type MarkdownCell,
  createNotebook, addCell, removeCell, duplicateCell, moveCell, updateCellSource,
  appendCellOutput, finishCellExecution, setCellRunning, boundOutputForPersistence,
  serializeIpynb, deserializeIpynb,
} from '../../host/notebook/document';
import { kernelMessageToOutput } from '../../host/notebook/kernelMessage';
import { BrowserPyodideKernel } from '../../host/notebook/browser-pyodide-kernel';
import { createNotebookBridgeHost } from '../../host/notebook/bridge-host';
import type { KernelStatus } from '../../host/notebook/kernel';
import { CellEditor } from '../notebook/CellEditor';
import { OutputView } from '../notebook/OutputView';
import { Markdown } from '../Markdown';
import { SaveBeforePublishDialog } from '../SaveBeforePublishDialog';

const STATUS_LABEL: Record<KernelStatus, string> = {
  starting: 'Starting…', idle: 'Ready', busy: 'Running…',
  restarting: 'Restarting…', dead: 'Not started', error: 'Error',
};

function starterCellFor(artifact: Artifact): string {
  const isLog = artifact.type === 'TraditionalEventLog' || artifact.type === 'ObjectCentricEventLog';
  return isLog
    ? [
      '# The selected artifact is available as `log`.',
      '#',
      '# log.events(), log.variants(), log.activities() each return an',
      '# awaitable pandas DataFrame -- await them, the same way `ctx.sql()`',
      '# works elsewhere in Promenade.',
      '#',
      '# Useful:',
      '#     await log.events()',
      '#     await log.variants()',
      '#     await promenade.artifacts()',
      '#     await promenade.publish(value, name="...")',
      'log',
    ].join('\n')
    : [
      '# The selected artifact is available as `artifact`.',
      'artifact',
    ].join('\n');
}

function buildPersistedDoc(d: NotebookDocument): NotebookDocument {
  return {
    ...d,
    cells: d.cells.map((c) => (c.cellType === 'code'
      ? { ...c, outputs: c.outputs.map(boundOutputForPersistence) } : c)),
  };
}

function MarkdownCellView({
  cell, onChange, onRunAndAdvance, onRunAndInsertBelow, onFocus,
}: {
  cell: MarkdownCell;
  onChange: (text: string) => void;
  onRunAndAdvance: () => void;
  onRunAndInsertBelow: () => void;
  onFocus?: () => void;
}) {
  const [editing, setEditing] = useState(cell.source.trim().length === 0);
  return (
    <div className="notebook-markdown-cell">
      {editing ? (
        <CellEditor
          cellId={cell.id}
          source={cell.source}
          language="text"
          onChange={onChange}
          onRun={() => setEditing(false)}
          onRunAndAdvance={() => { setEditing(false); onRunAndAdvance(); }}
          onRunAndInsertBelow={() => { setEditing(false); onRunAndInsertBelow(); }}
          onFocus={onFocus}
          autoFocus
        />
      ) : (
        <div className="notebook-markdown-preview" onDoubleClick={() => setEditing(true)}>
          {cell.source.trim()
            ? <Markdown source={cell.source} />
            : <span className="notebook-markdown-empty">Empty markdown cell — double-click to edit.</span>}
        </div>
      )}
    </div>
  );
}

export function NotebookView({
  artifact, graph, panelId, onOpenArtifact, onFocusArtifact, onGraphUpdated, onSave,
}: {
  artifact: Artifact;
  graph: ProvenanceGraph;
  panelId: string;
  onOpenArtifact?: (a: Artifact) => void;
  onFocusArtifact?: (id: string) => void;
  onGraphUpdated?: (catalog: ProvenanceGraph) => void;
  /** Persists the notebook as a `Notebook` artifact. Undefined when saving is unavailable. */
  onSave?: (doc: NotebookDocument, input: Artifact, nameOverride?: string) => Promise<Artifact> | void;
}) {
  // Harmonized with ScriptEditor's identical `source` pattern: a saved
  // notebook holds code (here, cells), its own table names come from the log
  // it was written against, which is exactly the artifact it records as its
  // input — never the notebook artifact itself.
  const source = artifact.type === 'Notebook'
    ? graph?.artifacts[artifact.inputs?.[0] ?? ''] ?? artifact
    : artifact;

  const [doc, setDoc] = useState<NotebookDocument | null>(null);
  const [status, setStatus] = useState<KernelStatus>('dead');
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [pendingPublishSave, setPendingPublishSave] = useState<{
    defaultName: string;
    resolve: (choice: { save: boolean; name?: string }) => void;
  } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const graphRef = useRef(graph); graphRef.current = graph;
  const sourceRef = useRef(source); sourceRef.current = source;
  const artifactRef = useRef(artifact); artifactRef.current = artifact;
  const onOpenArtifactRef = useRef(onOpenArtifact); onOpenArtifactRef.current = onOpenArtifact;
  const onFocusArtifactRef = useRef(onFocusArtifact); onFocusArtifactRef.current = onFocusArtifact;
  const onGraphUpdatedRef = useRef(onGraphUpdated); onGraphUpdatedRef.current = onGraphUpdated;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  const docRef = useRef<NotebookDocument | null>(null); docRef.current = doc;
  // Set once this panel has resolved a real, persisted notebook identity —
  // either it was already saved, or the user answered the save-before-
  // publish prompt with "save". `artifactRef` alone can't serve this: it
  // only updates on the next render after `onSave` resolves, which can be
  // too late for a second `publish()` call in the same cell.
  const savedIdentityRef = useRef<{ id: string; name: string } | null>(null);
  // Set once the user answers the prompt with "continue without saving" —
  // remembered for the rest of this panel's session, per-panel exactly like
  // `savedIdentityRef`, so later publishes in the same notebook/script don't
  // ask again.
  const stayedLooseRef = useRef(false);

  // One kernel per panel, for the panel's lifetime — restart replaces the
  // Worker underneath, not this object, so `execute()`'s consumer never
  // needs to know a restart happened.
  const kernel = useMemo(() => {
    const host = createNotebookBridgeHost({
      getGraph: () => graphRef.current,
      getBoundArtifactId: () => sourceRef.current?.id ?? null,
      onGraphUpdated: (catalog) => onGraphUpdatedRef.current?.(catalog),
      onOpenArtifact: (id) => {
        const a = graphRef.current.artifacts[id];
        if (a) onOpenArtifactRef.current?.(a);
      },
      onFocusArtifact: (id) => onFocusArtifactRef.current?.(id),
      ensureSaved: () => ensureSavedRef.current(),
    });
    return new BrowserPyodideKernel(host);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  useEffect(() => {
    const off = kernel.onStatusChange(setStatus);
    setStatus(kernel.getStatus());
    kernel.start().catch((e) => console.error('notebook kernel start failed', e));
    return () => { off(); void kernel.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  // A saved `Notebook` artifact carries its own cells inline (mirroring
  // ScriptEditor reading `artifact.storage.value.code`); opening a log
  // starts a fresh, ephemeral document bound to it.
  useEffect(() => {
    if (artifact.type === 'Notebook' && artifact.storage.kind === 'inline') {
      setDoc(artifact.storage.value as NotebookDocument);
    } else {
      setDoc(createNotebook({
        title: `Python notebook for ${artifact.name}`,
        artifactBindings: [artifact.id], starterCell: starterCellFor(artifact),
      }));
    }
  }, [artifact.id, artifact.type]);

  const runCell = useCallback(async (cellId: string) => {
    const current = docRef.current;
    if (!current) return;
    const cell = current.cells.find((c) => c.id === cellId);
    if (!cell || cell.cellType !== 'code') return;
    const execCount = 1 + Math.max(
      0, ...current.cells.filter((c): c is CodeCell => c.cellType === 'code').map((c) => c.executionCount ?? 0),
    );
    setRunningCellId(cellId);
    setDoc((d) => (d ? setCellRunning(d, cellId) : d));
    // The persisted Notebook *artifact*'s own id -- matching ScriptEditor's
    // identical pattern -- not `current.id`, the notebook *document*'s own
    // internal id: that one is minted client-side when the document is
    // first created and never updated to the real artifact id `onSave`
    // mints, so a published artifact's `execution.params.notebook.id` would
    // point at an id that never appears in `graph.artifacts` and every
    // "nest under the producing notebook" display lookup
    // (`host/artifact/types.ts`'s `displayParentId`) would silently miss.
    // Pre-save, `artifact` is the source log the notebook was opened
    // against rather than the notebook itself, but that's harmless here:
    // it's the same id `inputs[0]` already falls back to.
    const a = artifactRef.current;
    const context = { cellId, executionCount: execCount, notebookId: a.id, notebookTitle: a.name };
    try {
      for await (const msg of kernel.execute(cell.source, context)) {
        const out = kernelMessageToOutput(msg);
        if (out) setDoc((d) => (d ? appendCellOutput(d, cellId, out) : d));
      }
      setDoc((d) => (d ? finishCellExecution(d, cellId, execCount) : d));
    } finally {
      setRunningCellId(null);
    }
  }, [kernel]);

  const runAll = useCallback(async () => {
    const cells = docRef.current?.cells ?? [];
    for (const c of cells) {
      if (c.cellType === 'code') await runCell(c.id); // eslint-disable-line no-await-in-loop
    }
  }, [runCell]);

  const restart = useCallback(async () => {
    setRunningCellId(null);
    await kernel.restart();
  }, [kernel]);

  const insertCellAfter = useCallback((cellId: string | null, type: 'code' | 'markdown'): string | null => {
    let newId: string | null = null;
    setDoc((d) => {
      if (!d) return d;
      const idx = cellId ? d.cells.findIndex((c) => c.id === cellId) : d.cells.length - 1;
      const next = addCell(d, type, cellId ?? undefined);
      newId = next.cells[idx + 1]?.id ?? null;
      return next;
    });
    return newId;
  }, []);

  const advanceFrom = useCallback((cellId: string) => {
    const cells = docRef.current?.cells ?? [];
    const idx = cells.findIndex((c) => c.id === cellId);
    const nextCell = cells[idx + 1];
    if (nextCell) { setActiveCellId(nextCell.id); return; }
    const id = insertCellAfter(cellId, 'code');
    if (id) setActiveCellId(id);
  }, [insertCellAfter]);

  const runAndAdvance = useCallback((cellId: string) => {
    void runCell(cellId).then(() => advanceFrom(cellId));
  }, [runCell, advanceFrom]);

  const runAndInsertBelow = useCallback((cellId: string) => {
    void runCell(cellId).then(() => {
      const id = insertCellAfter(cellId, 'code');
      if (id) setActiveCellId(id);
    });
  }, [runCell, insertCellAfter]);

  const saveAsArtifact = useCallback(async () => {
    if (!doc || !onSave) return;
    setSaving(true);
    setSaveStatus('saving…');
    try {
      const persisted = buildPersistedDoc(doc);
      const saved = await onSave(persisted, artifact);
      setDoc(persisted);
      if (saved) savedIdentityRef.current = { id: saved.id, name: saved.name };
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(''), 1500);
    } catch (e: any) {
      setSaveStatus(`save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }, [doc, onSave, artifact]);

  // Asked from inside the bridge host, before every publish — see
  // `NotebookBridgeHostDeps.ensureSaved`'s doc comment for the contract.
  // `[]` deps: everything it touches is a ref or a stable setter, so the
  // closure never goes stale and the kernel (memoized on `[panelId]` alone)
  // can hold one stable reference to it for the panel's whole lifetime.
  const ensureSaved = useCallback(async (): Promise<{ notebookId: string; notebookTitle: string }> => {
    const a = artifactRef.current;
    if (a.type === 'Notebook') return { notebookId: a.id, notebookTitle: a.name };
    if (savedIdentityRef.current) {
      return { notebookId: savedIdentityRef.current.id, notebookTitle: savedIdentityRef.current.name };
    }
    if (stayedLooseRef.current || !onSaveRef.current) {
      return { notebookId: a.id, notebookTitle: a.name };
    }
    const defaultName = docRef.current?.title || `Python notebook for ${a.name}`;
    const choice = await new Promise<{ save: boolean; name?: string }>((resolve) => {
      setPendingPublishSave({ defaultName, resolve });
    });
    if (!choice.save || !docRef.current) {
      stayedLooseRef.current = true;
      return { notebookId: a.id, notebookTitle: a.name };
    }
    const persisted = buildPersistedDoc(docRef.current);
    const saved = await onSaveRef.current(persisted, a, choice.name);
    setDoc(persisted);
    if (!saved) {
      // `onSave` is typed to allow a void return for the plain button path;
      // this path genuinely needs the persisted artifact back, so treat a
      // missing one as "stay loose" instead of publishing with a lie.
      stayedLooseRef.current = true;
      return { notebookId: a.id, notebookTitle: a.name };
    }
    savedIdentityRef.current = { id: saved.id, name: saved.name };
    return { notebookId: saved.id, notebookTitle: saved.name };
  }, []);
  const ensureSavedRef = useRef(ensureSaved); ensureSavedRef.current = ensureSaved;

  const exportIpynb = useCallback(() => {
    if (!doc) return;
    const blob = new Blob([serializeIpynb(doc)], { type: 'application/x-ipynb+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(doc.title || 'notebook').replace(/[^a-z0-9 _-]/gi, '_')}.ipynb`;
    a.click();
    URL.revokeObjectURL(url);
  }, [doc]);

  const importIpynb = useCallback((file: File) => {
    file.text().then((text) => {
      const imported = deserializeIpynb(text, file.name.replace(/\.ipynb$/i, ''));
      setDoc(imported);
    });
  }, []);

  if (!doc) return <div className="view notebook-view"><div className="why">Loading notebook…</div></div>;

  return (
    <div className="view notebook-view">
      <div className="notebook-toolbar">
        <strong className="notebook-title">{doc.title}</strong>
        <span className={`notebook-kernel-chip notebook-kernel-${status}`}>
          {kernel.label} · {STATUS_LABEL[status]}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => { const id = insertCellAfter(activeCellId, 'code'); if (id) setActiveCellId(id); }}>
          + Code
        </button>
        <button type="button" onClick={() => { const id = insertCellAfter(activeCellId, 'markdown'); if (id) setActiveCellId(id); }}>
          + Markdown
        </button>
        <button type="button" disabled={status === 'busy'} onClick={() => void runAll()}>Run all</button>
        <button type="button" disabled={status === 'restarting'} onClick={() => void restart()} title="Discards all cell state — Pyodide cannot interrupt mid-cell without a full restart">
          Restart
        </button>
        {onSave && (
          <button type="button" disabled={saving} onClick={() => void saveAsArtifact()} title="Keep this notebook as an artifact">
            Save as artifact
          </button>
        )}
        {saveStatus && <span className="notebook-save-status">{saveStatus}</span>}
        <button type="button" onClick={exportIpynb} title="Download this notebook as a standard .ipynb file">
          Export .ipynb
        </button>
        <button type="button" onClick={() => importInput.current?.click()}>Import .ipynb</button>
        <input
          ref={importInput} type="file" accept=".ipynb" style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importIpynb(f); e.target.value = ''; }}
        />
      </div>

      <div className="notebook-cells">
        {doc.cells.map((cell, idx) => (
          <div
            key={cell.id}
            className={`notebook-cell ${activeCellId === cell.id ? 'notebook-cell-active' : ''}`}
            onFocus={() => setActiveCellId(cell.id)}
          >
            <div className="notebook-cell-gutter">
              {cell.cellType === 'code' && (
                <>
                  <button
                    type="button"
                    className="notebook-run-button"
                    disabled={status === 'busy' && runningCellId !== cell.id}
                    onClick={() => void runCell(cell.id)}
                    title="Run cell"
                  >
                    {runningCellId === cell.id ? '◐' : '▶'}
                  </button>
                  <span className="notebook-exec-count">
                    [{runningCellId === cell.id ? '*' : cell.executionCount ?? ' '}]
                  </span>
                </>
              )}
            </div>
            <div className="notebook-cell-body">
              {cell.cellType === 'code' ? (
                <>
                  <CellEditor
                    cellId={cell.id}
                    source={cell.source}
                    language="python"
                    onChange={(text) => setDoc((d) => (d ? updateCellSource(d, cell.id, text) : d))}
                    onRun={() => void runCell(cell.id)}
                    onRunAndAdvance={() => runAndAdvance(cell.id)}
                    onRunAndInsertBelow={() => runAndInsertBelow(cell.id)}
                    onFocus={() => setActiveCellId(cell.id)}
                  />
                  {!cell.collapsed && cell.outputs.length > 0 && (
                    <OutputView
                      outputs={cell.outputs}
                      onOpenArtifact={(id) => { const a = graph.artifacts[id]; if (a) onOpenArtifact?.(a); }}
                      onFocusArtifact={onFocusArtifact}
                    />
                  )}
                  {cell.outputs.length > 0 && (
                    <button
                      type="button" className="notebook-collapse-toggle"
                      onClick={() => setDoc((d) => (d ? {
                        ...d, cells: d.cells.map((c) => (c.id === cell.id && c.cellType === 'code' ? { ...c, collapsed: !c.collapsed } : c)),
                      } : d))}
                    >
                      {cell.collapsed ? 'Show output' : 'Hide output'}
                    </button>
                  )}
                </>
              ) : (
                <MarkdownCellView
                  cell={cell}
                  onChange={(text) => setDoc((d) => (d ? updateCellSource(d, cell.id, text) : d))}
                  onRunAndAdvance={() => advanceFrom(cell.id)}
                  onRunAndInsertBelow={() => { const id = insertCellAfter(cell.id, 'code'); if (id) setActiveCellId(id); }}
                  onFocus={() => setActiveCellId(cell.id)}
                />
              )}
            </div>
            <div className="notebook-cell-actions">
              <button type="button" disabled={idx === 0} onClick={() => setDoc((d) => (d ? moveCell(d, cell.id, -1) : d))} title="Move up">↑</button>
              <button type="button" disabled={idx === doc.cells.length - 1} onClick={() => setDoc((d) => (d ? moveCell(d, cell.id, 1) : d))} title="Move down">↓</button>
              <button type="button" onClick={() => setDoc((d) => (d ? duplicateCell(d, cell.id) : d))} title="Duplicate">⧉</button>
              <button
                type="button"
                onClick={() => setDoc((d) => (d ? removeCell(d, cell.id) : d))}
                disabled={doc.cells.length <= 1}
                title="Delete cell"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {doc.cells.length === 0 && (
          <div className="notebook-empty">
            <button type="button" onClick={() => insertCellAfter(null, 'code')}>+ Code</button>
            <button type="button" onClick={() => insertCellAfter(null, 'markdown')}>+ Markdown</button>
          </div>
        )}
      </div>
      {pendingPublishSave && (
        <SaveBeforePublishDialog
          defaultName={pendingPublishSave.defaultName}
          kindLabel="notebook"
          onSave={(name) => { pendingPublishSave.resolve({ save: true, name }); setPendingPublishSave(null); }}
          onContinueLoose={() => { pendingPublishSave.resolve({ save: false }); setPendingPublishSave(null); }}
        />
      )}
    </div>
  );
}
