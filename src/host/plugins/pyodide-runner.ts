import * as arrow from 'apache-arrow';
import { dataClient } from '../data/client';

/**
 * Host side of the Pyodide execution class.
 *
 * Same shape as the WASM runner and for the same reasons: the host owns the
 * worker, the SQL bridge and the abort policy. Python cannot terminate itself
 * and cannot reach data except by asking.
 *
 * One difference matters. Python code cannot be interrupted cooperatively
 * mid-call any more than a WASM call can, and Pyodide has no preemption. Abort
 * is therefore always a worker termination — which also discards the loaded
 * runtime, so aborting a Python action is genuinely expensive. That is a real
 * cost of this runtime, not an implementation shortcut.
 */

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

export class PyodideRunner {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, Waiter>();
  private progressFn: ((f: number, m?: string, data?: unknown) => void) | null = null;
  private logFn: ((s: string) => void) | null = null;
  private generation = 0;
  /** True once the runtime has been loaded at least once in this worker. */
  private warm = false;

  get isWarm() { return this.warm; }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/pyodide-worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'sql') {
        try {
          const table = await dataClient.sql(m.text);
          const ipc = arrow.tableToIPC(table, 'stream');
          w.postMessage({ type: 'sqlResult', id: m.id, ipc }, [ipc.buffer]);
        } catch (err: any) {
          w.postMessage({ type: 'sqlResult', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }
      if (m.type === 'progress') { this.progressFn?.(m.fraction, m.message, m.data); return; }
      if (m.type === 'log') { this.logFn?.(m.message); return; }
      const waiter = this.waiting.get(m.id);
      if (!waiter) return;
      this.waiting.delete(m.id);
      if (m.type === 'error') waiter.reject(new Error(m.error));
      else waiter.resolve(m.payload);
    };
    this.worker = w;
    return w;
  }

  private call<T>(cmd: string, args: unknown): Promise<T> {
    const w = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ id, cmd, args });
    });
  }

  /** Discards the runtime. The only way to stop Python mid-execution. */
  terminate(reason = 'terminated') {
    this.worker?.terminate();
    this.worker = null;
    this.warm = false;
    for (const w of this.waiting.values()) w.reject(new Error(reason));
    this.waiting.clear();
    this.generation++;
  }

  /** Reported into provenance: the same analysis can differ across runtimes. */
  async version() {
    const v = await this.call<{ pyodide: string; python: string }>('version', {});
    this.warm = true;
    return v;
  }

  /**
   * Runs a packaged Python plugin.
   *
   * `prepareKey` carries the same meaning as for WASM kernels: when it is
   * unchanged the worker reuses the cached result of `prepare()`, so only the
   * cheap stage runs again.
   */
  async run(args: {
    source: string;
    deps: string[];
    tables: Record<string, string>;
    /** Catalog metadata for each bound input, by role — backs `ctx.meta`. */
    inputMeta?: Record<string, unknown[]>;
    params: Record<string, unknown>;
    /** Suffix selecting `prepare_<x>` / `finalize_<x>`; the plain pair if unset. */
    entryPoint?: string;
    /** Payload of an inline input artifact, for actions that do not read tables. */
    inputValue?: unknown;
    /**
     * Payloads for every declared input slot.  Each role maps to its ordered
     * input values, matching `ActionExecution.inputs`.  `inputValue` remains
     * the first input for existing one-input plugins.
     */
    inputValues?: Record<string, unknown[]>;
    /** Stable artifact ids for every declared input slot.  Payloads alone
     * cannot carry provenance: a result such as replay evidence must bind
     * itself to the exact source log and model that produced it. */
    inputArtifactIds?: Record<string, string[]>;
    prepareKey: string;
    signal?: AbortSignal;
    onProgress?: (f: number, m?: string, data?: unknown) => void;
    onLog?: (s: string) => void;
  }) {
    const gen = ++this.generation;
    this.progressFn = args.onProgress ?? null;
    this.logFn = args.onLog ?? null;

    let onAbort: (() => void) | null = null;
    if (args.signal) {
      if (args.signal.aborted) return null;
      onAbort = () => this.terminate('aborted');
      args.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const out = await this.call<any>('run', {
        source: args.source, deps: args.deps,
        tables: args.tables, params: args.params, prepareKey: args.prepareKey,
        inputMeta: args.inputMeta,
        entryPoint: args.entryPoint ?? null, inputValue: args.inputValue ?? null,
        inputValues: args.inputValues ?? {}, inputArtifactIds: args.inputArtifactIds ?? {},
      });
      this.warm = true;
      return gen === this.generation ? out : null;
    } finally {
      if (args.signal && onAbort) args.signal.removeEventListener('abort', onAbort);
    }
  }
}

export const pyodideRunner = new PyodideRunner();
