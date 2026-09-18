/**
 * Notebook document model.
 *
 * Cells, ordering, outputs and execution counts — kept close to nbformat 4.5
 * so `toIpynb()`/`fromIpynb()` round-trip through real Jupyter/JupyterLab
 * without loss of the parts that travel (code, markdown, execution counts,
 * MIME outputs). Promenade-specific state (which artifacts this notebook is
 * bound to, which kernel implementation) is namespaced under
 * `metadata.promenade` rather than invented as new top-level nbformat keys,
 * so a `.ipynb` produced here stays a valid, ordinary notebook to any other
 * tool. See docs/python-notebook.md.
 */

export type MimeBundle = Record<string, unknown>;

export interface StreamOutput {
  outputType: 'stream';
  name: 'stdout' | 'stderr';
  text: string;
}

export interface ExecuteResultOutput {
  outputType: 'execute_result';
  executionCount: number;
  data: MimeBundle;
}

export interface DisplayDataOutput {
  outputType: 'display_data';
  data: MimeBundle;
}

export interface ErrorOutput {
  outputType: 'error';
  ename: string;
  evalue: string;
  traceback: string[];
}

export type CellOutput = StreamOutput | ExecuteResultOutput | DisplayDataOutput | ErrorOutput;

export interface CodeCell {
  id: string;
  cellType: 'code';
  source: string;
  executionCount: number | null;
  outputs: CellOutput[];
  /** Output pane collapsed in the UI; a display preference, not data. */
  collapsed?: boolean;
}

export interface MarkdownCell {
  id: string;
  cellType: 'markdown';
  source: string;
}

export type NotebookCell = CodeCell | MarkdownCell;

export interface NotebookMetadata {
  promenade: {
    version: 1;
    /** Bound Promenade artifact ids, primary (the one bound to `log`/`artifact`) first. */
    artifactBindings: string[];
    kernel: 'browser-pyodide';
  };
}

export interface NotebookDocument {
  id: string;
  title: string;
  cells: NotebookCell[];
  metadata: NotebookMetadata;
}

function mintId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createNotebook(input: {
  title: string;
  artifactBindings?: string[];
  starterCell?: string;
}): NotebookDocument {
  const cells: NotebookCell[] = [];
  if (input.starterCell !== undefined) {
    cells.push({ id: mintId('c'), cellType: 'code', source: input.starterCell, executionCount: null, outputs: [] });
  }
  return {
    id: mintId('nb'),
    title: input.title,
    cells,
    metadata: {
      promenade: { version: 1, artifactBindings: input.artifactBindings ?? [], kernel: 'browser-pyodide' },
    },
  };
}

export function addCell(
  doc: NotebookDocument, cellType: 'code' | 'markdown', afterId?: string,
): NotebookDocument {
  const cell: NotebookCell = cellType === 'code'
    ? { id: mintId('c'), cellType: 'code', source: '', executionCount: null, outputs: [] }
    : { id: mintId('c'), cellType: 'markdown', source: '' };
  const cells = [...doc.cells];
  const idx = afterId ? cells.findIndex((c) => c.id === afterId) : cells.length - 1;
  cells.splice(idx + 1, 0, cell);
  return { ...doc, cells };
}

export function removeCell(doc: NotebookDocument, cellId: string): NotebookDocument {
  return { ...doc, cells: doc.cells.filter((c) => c.id !== cellId) };
}

export function duplicateCell(doc: NotebookDocument, cellId: string): NotebookDocument {
  const idx = doc.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) return doc;
  const src = doc.cells[idx];
  const copy: NotebookCell = src.cellType === 'code'
    ? { ...src, id: mintId('c'), executionCount: null, outputs: [] }
    : { ...src, id: mintId('c') };
  const cells = [...doc.cells];
  cells.splice(idx + 1, 0, copy);
  return { ...doc, cells };
}

/** Moves a cell by `delta` positions (-1 up, +1 down); clamped, no-op at the edges. */
export function moveCell(doc: NotebookDocument, cellId: string, delta: -1 | 1): NotebookDocument {
  const idx = doc.cells.findIndex((c) => c.id === cellId);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= doc.cells.length) return doc;
  const cells = [...doc.cells];
  [cells[idx], cells[target]] = [cells[target], cells[idx]];
  return { ...doc, cells };
}

export function updateCellSource(doc: NotebookDocument, cellId: string, source: string): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
  };
}

export function setCellRunning(doc: NotebookDocument, cellId: string): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId && c.cellType === 'code'
      ? { ...c, outputs: [] } : c)),
  };
}

export function appendCellOutput(doc: NotebookDocument, cellId: string, output: CellOutput): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId && c.cellType === 'code'
      ? { ...c, outputs: [...c.outputs, output] } : c)),
  };
}

export function finishCellExecution(
  doc: NotebookDocument, cellId: string, executionCount: number,
): NotebookDocument {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId && c.cellType === 'code'
      ? { ...c, executionCount } : c)),
  };
}

export function setArtifactBindings(doc: NotebookDocument, ids: string[]): NotebookDocument {
  return { ...doc, metadata: { ...doc.metadata, promenade: { ...doc.metadata.promenade, artifactBindings: ids } } };
}

// --- nbformat 4.5 I/O -------------------------------------------------

interface IpynbCell {
  id: string;
  cell_type: 'code' | 'markdown';
  source: string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: unknown[];
}

interface IpynbNotebook {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: { promenade?: NotebookMetadata['promenade']; title?: string; [k: string]: unknown };
  cells: IpynbCell[];
}

function toSourceLines(source: string): string[] {
  // nbformat stores source as a list of lines, each retaining its own
  // trailing newline except the last — the format real Jupyter writes.
  const lines = source.split('\n');
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}\n` : l));
}

function fromSourceLines(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

function outputToIpynb(o: CellOutput): unknown {
  switch (o.outputType) {
    case 'stream':
      return { output_type: 'stream', name: o.name, text: toSourceLines(o.text) };
    case 'execute_result':
      return {
        output_type: 'execute_result',
        execution_count: o.executionCount,
        data: mimeToIpynb(o.data),
        metadata: {},
      };
    case 'display_data':
      return { output_type: 'display_data', data: mimeToIpynb(o.data), metadata: {} };
    case 'error':
      return { output_type: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback };
  }
}

/** Text-ish MIME values are stored as line arrays in nbformat, like `source`. */
function mimeToIpynb(data: MimeBundle): MimeBundle {
  const out: MimeBundle = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' && (k.startsWith('text/') || k === 'application/json')
      ? (k === 'application/json' ? v : toSourceLines(v)) : v;
  }
  return out;
}

function mimeFromIpynb(data: MimeBundle): MimeBundle {
  const out: MimeBundle = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = Array.isArray(v) ? v.join('') : v;
  }
  return out;
}

function outputFromIpynb(o: any): CellOutput | null {
  switch (o.output_type) {
    case 'stream':
      return { outputType: 'stream', name: o.name, text: fromSourceLines(o.text) };
    case 'execute_result':
      return { outputType: 'execute_result', executionCount: o.execution_count ?? 0, data: mimeFromIpynb(o.data ?? {}) };
    case 'display_data':
      return { outputType: 'display_data', data: mimeFromIpynb(o.data ?? {}) };
    case 'error':
      return { outputType: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback ?? [] };
    default:
      return null;
  }
}

export function toIpynb(doc: NotebookDocument): IpynbNotebook {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { promenade: doc.metadata.promenade, title: doc.title },
    cells: doc.cells.map((c): IpynbCell => (c.cellType === 'code'
      ? {
        id: c.id, cell_type: 'code', source: toSourceLines(c.source), metadata: {},
        execution_count: c.executionCount, outputs: c.outputs.map(outputToIpynb),
      }
      : { id: c.id, cell_type: 'markdown', source: toSourceLines(c.source), metadata: {} })),
  };
}

export function fromIpynb(nb: IpynbNotebook, fallbackTitle = 'Untitled notebook'): NotebookDocument {
  const promenadeMeta = nb.metadata?.promenade;
  const cells: NotebookCell[] = (nb.cells ?? []).map((c: any): NotebookCell => {
    const id = c.id ?? mintId('c');
    if (c.cell_type === 'markdown') return { id, cellType: 'markdown', source: fromSourceLines(c.source) };
    return {
      id,
      cellType: 'code',
      source: fromSourceLines(c.source),
      executionCount: c.execution_count ?? null,
      outputs: (c.outputs ?? []).map(outputFromIpynb).filter((o: CellOutput | null): o is CellOutput => o !== null),
    };
  });
  return {
    id: mintId('nb'),
    title: (nb.metadata?.title as string) ?? fallbackTitle,
    cells,
    metadata: {
      promenade: promenadeMeta ?? { version: 1, artifactBindings: [], kernel: 'browser-pyodide' },
    },
  };
}

export function serializeIpynb(doc: NotebookDocument): string {
  return JSON.stringify(toIpynb(doc), null, 1);
}

export function deserializeIpynb(json: string, fallbackTitle?: string): NotebookDocument {
  return fromIpynb(JSON.parse(json), fallbackTitle);
}

// --- output size limits (persistence policy) --------------------------

const LIMITS: Record<string, number> = {
  'text/plain': 64 * 1024,
  stream: 64 * 1024,
  'text/html': 256 * 1024,
  'image/png': 2 * 1024 * 1024,
  'image/svg+xml': 2 * 1024 * 1024,
  'application/json': 256 * 1024,
};

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated, ${s.length} bytes]` : s;
}

/**
 * Bounds an output before it is folded into a `NotebookDocument` that will
 * be saved. Small text/image outputs are kept (truncated if oversized);
 * anything still too large to keep is dropped and flagged
 * `recomputeRequired` rather than silently bloating `notebooks.json`. See
 * docs/python-notebook.md "Output persistence limits".
 */
export function boundOutputForPersistence(o: CellOutput): CellOutput & { recomputeRequired?: boolean } {
  if (o.outputType === 'stream') {
    return { ...o, text: truncateText(o.text, LIMITS.stream) };
  }
  if (o.outputType === 'error') return o;
  const data: MimeBundle = {};
  let dropped = false;
  for (const [mime, value] of Object.entries(o.data)) {
    const limit = LIMITS[mime] ?? 64 * 1024;
    if (typeof value === 'string') {
      if (value.length > limit * 4) { dropped = true; continue; }
      data[mime] = truncateText(value, limit);
    } else {
      data[mime] = value;
    }
  }
  if (Object.keys(data).length === 0 && dropped) {
    return { ...(o as any), data: {}, recomputeRequired: true };
  }
  return { ...(o as any), data };
}
