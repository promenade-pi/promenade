/**
 * NotebookKernel — the abstraction a notebook panel programs against.
 *
 * `BrowserPyodideKernel` (browser-pyodide-kernel.ts) is the only
 * implementation today. A future `ComputeJupyterKernel` speaking the real
 * Jupyter wire protocol against Promenade Compute implements the same
 * interface; `NotebookView` and `NotebookDocument` never depend on which one
 * is behind it. See docs/python-notebook.md.
 */

import type { MimeBundle } from './document';

export type KernelStatus = 'starting' | 'idle' | 'busy' | 'restarting' | 'dead' | 'error';

export interface ExecutionContext {
  cellId: string;
  executionCount: number;
  notebookId: string;
  notebookTitle: string;
}

export type KernelMessage =
  | { type: 'status'; status: KernelStatus }
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'execute_result'; executionCount: number; data: MimeBundle }
  | { type: 'display_data'; data: MimeBundle }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] };

export interface NotebookKernel {
  start(): Promise<void>;
  /** Streams messages for one cell's run; the iterable completes when the cell is done. */
  execute(code: string, context: ExecutionContext): AsyncIterable<KernelMessage>;
  /** Best-effort. In browser-Pyodide mode this always restarts the kernel — see docs. */
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
  getStatus(): KernelStatus;
  onStatusChange(fn: (s: KernelStatus) => void): () => void;
  /** Human-readable identity for the kernel status chip, e.g. "Python · Pyodide". */
  readonly label: string;
}
