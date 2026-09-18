import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import { BrowserPyodideKernel } from '../../host/notebook/browser-pyodide-kernel';
import { createNotebookBridgeHost } from '../../host/notebook/bridge-host';
import { kernelMessageToOutput } from '../../host/notebook/kernelMessage';
import type { KernelStatus } from '../../host/notebook/kernel';
import type { CellOutput } from '../../host/notebook/document';
import { OutputView } from '../notebook/OutputView';
import { SaveBeforePublishDialog } from '../SaveBeforePublishDialog';

/**
 * Built-in Python scratchpad — a single-cell notebook, harmonized onto the
 * exact same kernel and bridge as the full Python Notebook (see
 * docs/python-notebook.md): the same `promenade` module, the same automatic
 * `log`/`artifact` binding, the same rich MIME output rendering, so
 * `promenade.publish(...)` and `await log.events()` work here exactly as
 * they do in a notebook cell. Only the shell differs — one cell, one Run
 * button, no markdown, no multi-cell chrome — and persistence, which stays
 * a `Script` artifact rather than a `Notebook` one.
 *
 * This used to run on a separate, simpler `ctx.sql()`-based runtime with no
 * `promenade`/`log` access at all (`pyodide-worker.ts`'s old `script`
 * handler, since removed). Existing saved scripts written against that API
 * (`await ctx.sql(...)`) will need rewriting to the `log`/`promenade` API —
 * a deliberate compatibility break in favor of one Python runtime instead
 * of two, not an oversight.
 */

function starterCellFor(artifact: Artifact): string {
  const isLog = artifact.type === 'TraditionalEventLog' || artifact.type === 'ObjectCentricEventLog';
  return isLog
    ? [
      '# The selected artifact is available as `log`.',
      '#',
      '# log.events(), log.variants(), log.activities() each return an',
      '# awaitable pandas DataFrame -- await them.',
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

const STATUS_LABEL: Record<KernelStatus, string> = {
  starting: 'Starting…', idle: 'Ready', busy: 'Running…',
  restarting: 'Restarting…', dead: 'Not started', error: 'Error',
};

export function ScriptEditor({
  artifact, graph, panelId, onSave, onOpenArtifact, onFocusArtifact, onGraphUpdated,
}: {
  artifact: Artifact;
  graph: ProvenanceGraph;
  panelId: string;
  /** Persists the script as a `Script` artifact. Undefined when saving is unavailable. */
  onSave?: (code: string, input: Artifact, nameOverride?: string) => Promise<Artifact> | void;
  onOpenArtifact?: (a: Artifact) => void;
  onFocusArtifact?: (id: string) => void;
  onGraphUpdated?: (catalog: ProvenanceGraph) => void;
}) {
  // A saved script holds code, not data — its bound artifact is the log it
  // was written against, which is exactly the artifact it records as its
  // input, never the Script artifact itself.
  const source = artifact.type === 'Script'
    ? graph?.artifacts[artifact.inputs?.[0] ?? ''] ?? artifact
    : artifact;

  const editorHost = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [outputs, setOutputs] = useState<CellOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [kernelStatus, setKernelStatus] = useState<KernelStatus>('dead');
  const execCount = useRef(0);

  const graphRef = useRef(graph); graphRef.current = graph;
  const sourceRef = useRef(source); sourceRef.current = source;
  const artifactRef = useRef(artifact); artifactRef.current = artifact;
  const onOpenArtifactRef = useRef(onOpenArtifact); onOpenArtifactRef.current = onOpenArtifact;
  const onFocusArtifactRef = useRef(onFocusArtifact); onFocusArtifactRef.current = onFocusArtifact;
  const onGraphUpdatedRef = useRef(onGraphUpdated); onGraphUpdatedRef.current = onGraphUpdated;
  const onSaveRef = useRef(onSave); onSaveRef.current = onSave;
  // Same contract as NotebookView.tsx's identically-named refs — see
  // `ensureSaved` below and `NotebookBridgeHostDeps.ensureSaved`'s doc
  // comment in `bridge-host.ts`.
  const savedIdentityRef = useRef<{ id: string; name: string } | null>(null);
  const stayedLooseRef = useRef(false);
  const [pendingPublishSave, setPendingPublishSave] = useState<{
    defaultName: string;
    resolve: (choice: { save: boolean; name?: string }) => void;
  } | null>(null);

  const ensureSaved = useCallback(async (): Promise<{ notebookId: string; notebookTitle: string }> => {
    const a = artifactRef.current;
    if (a.type === 'Script') return { notebookId: a.id, notebookTitle: a.name };
    if (savedIdentityRef.current) {
      return { notebookId: savedIdentityRef.current.id, notebookTitle: savedIdentityRef.current.name };
    }
    if (stayedLooseRef.current || !onSaveRef.current) {
      return { notebookId: a.id, notebookTitle: a.name };
    }
    const defaultName = `Script · ${a.name}`;
    const choice = await new Promise<{ save: boolean; name?: string }>((resolve) => {
      setPendingPublishSave({ defaultName, resolve });
    });
    if (!choice.save) {
      stayedLooseRef.current = true;
      return { notebookId: a.id, notebookTitle: a.name };
    }
    const code = view.current?.state.doc.toString() ?? '';
    const saved = await onSaveRef.current(code, a, choice.name);
    if (!saved) {
      stayedLooseRef.current = true;
      return { notebookId: a.id, notebookTitle: a.name };
    }
    savedIdentityRef.current = { id: saved.id, name: saved.name };
    return { notebookId: saved.id, notebookTitle: saved.name };
  }, []);
  const ensureSavedRef = useRef(ensureSaved); ensureSavedRef.current = ensureSaved;

  // One kernel per panel — same lifecycle contract as NotebookView's.
  const kernel = useMemo(() => {
    const bridgeHost = createNotebookBridgeHost({
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
    return new BrowserPyodideKernel(bridgeHost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelId]);

  useEffect(() => {
    const off = kernel.onStatusChange(setKernelStatus);
    setKernelStatus(kernel.getStatus());
    kernel.start().catch((e) => console.error('script kernel start failed', e));
    return () => { off(); void kernel.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  const run = useRef<() => void>(() => {});
  run.current = async () => {
    if (busy) return;
    setBusy(true);
    setOutputs([]);
    setStatus(kernel.getStatus() === 'idle' ? 'running…' : 'starting Python (first run)…');
    const code = view.current?.state.doc.toString() ?? '';
    const context = {
      cellId: 'script', executionCount: ++execCount.current,
      notebookId: artifact.id, notebookTitle: artifact.name,
    };
    try {
      for await (const msg of kernel.execute(code, context)) {
        if (msg.type === 'status') continue;
        const out = kernelMessageToOutput(msg);
        if (out) setOutputs((o) => [...o, out]);
        if (msg.type !== 'stream') setStatus('');
      }
    } finally {
      setBusy(false);
      setStatus('');
    }
  };

  useEffect(() => {
    if (!editorHost.current) return;
    // A saved Script artifact carries its own code; opening a log starts
    // from the template.
    const saved = artifact.type === 'Script'
      ? String((artifact.storage as any)?.value?.code ?? '')
      : '';
    const v = new EditorView({
      doc: saved || starterCellFor(artifact),
      parent: editorHost.current,
      extensions: [
        basicSetup,
        python(),
        // Highest precedence so it wins over basicSetup's own bindings.
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => { run.current(); return true; } },
        ])),
        EditorView.theme({
          '&': { fontSize: '12px', height: '100%' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
        }),
      ],
    });
    view.current = v;
    // Dev affordance: lets a script be driven without typing into the editor.
    if (import.meta.env.DEV) (globalThis as any).__editor = v;
    return () => v.destroy();
  }, [artifact.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="script-bar">
        <button className="primary" disabled={busy} onClick={() => run.current()}>
          {busy ? 'Running…' : 'Run'}
        </button>
        <span className="script-hint">⌘/Ctrl + Enter</span>
        {status && <span className="script-status">{status}</span>}
        <span className={`notebook-kernel-chip notebook-kernel-${kernelStatus}`}>
          {kernel.label} · {STATUS_LABEL[kernelStatus]}
        </span>
        <span className="spacer" />
        {onSave && (
          <button
            onClick={async () => {
              setStatus('saving…');
              const saved = await onSave(view.current?.state.doc.toString() ?? '', artifact);
              if (saved) savedIdentityRef.current = { id: saved.id, name: saved.name };
              setStatus('saved');
              setTimeout(() => setStatus(''), 1500);
            }}
            title="Keep this script as an artifact"
          >
            Save as artifact
          </button>
        )}
        <span className="chip">python · pyodide</span>
      </div>

      <div ref={editorHost} className="script-editor" />

      <div className="script-out">
        <OutputView
          outputs={outputs}
          onOpenArtifact={(id) => { const a = graph.artifacts[id]; if (a) onOpenArtifact?.(a); }}
          onFocusArtifact={onFocusArtifact}
        />
        {outputs.length === 0 && !busy && (
          <span style={{ color: 'var(--text-dim)' }}>
            Run the script to see its output. Python loads on first use.
          </span>
        )}
      </div>
      {pendingPublishSave && (
        <SaveBeforePublishDialog
          defaultName={pendingPublishSave.defaultName}
          kindLabel="script"
          onSave={(name) => { pendingPublishSave.resolve({ save: true, name }); setPendingPublishSave(null); }}
          onContinueLoose={() => { pendingPublishSave.resolve({ save: false }); setPendingPublishSave(null); }}
        />
      )}
    </div>
  );
}
