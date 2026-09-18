/**
 * Maps one `KernelMessage` (what a `NotebookKernel` streams while running
 * code) to one `CellOutput` (what a notebook document persists). Shared by
 * `NotebookView` and `ScriptEditor` — both run code through the same
 * `BrowserPyodideKernel`/`promenade` bridge and render output the same way;
 * only the surrounding UI (many cells vs. one) differs. See
 * docs/python-notebook.md.
 */

import type { KernelMessage } from './kernel';
import type { CellOutput } from './document';

export function kernelMessageToOutput(msg: KernelMessage): CellOutput | null {
  switch (msg.type) {
    case 'stream':
      return { outputType: 'stream', name: msg.name, text: msg.text };
    case 'execute_result':
      return { outputType: 'execute_result', executionCount: msg.executionCount, data: msg.data };
    case 'display_data':
      return { outputType: 'display_data', data: msg.data };
    case 'error':
      return { outputType: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback };
    default:
      return null;
  }
}
