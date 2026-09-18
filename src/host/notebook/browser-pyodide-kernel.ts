/**
 * `BrowserPyodideKernel` — the v1 `NotebookKernel`.
 *
 * Owns the notebook Worker (`worker/notebook-worker.ts`) and answers every
 * bridge request the worker's Python raises by delegating to a
 * `NotebookBridgeHost` it receives through its constructor — this class
 * never imports `dataClient`, `window`, or any other host singleton
 * directly, which is what keeps it testable against a mock host and
 * portable to a future transport. See docs/python-notebook.md.
 *
 * Interrupt and restart are the same operation here: Pyodide has no
 * preemption, so there is no way to stop a running cell without discarding
 * the interpreter. `interrupt()` documents that cost rather than hiding it
 * behind a stop button that cannot actually stop anything.
 */

import * as arrow from 'apache-arrow';
import type { NotebookKernel, KernelStatus, KernelMessage, ExecutionContext } from './kernel';
import type { BridgeRequest, NotebookBridgeHost } from './bridge';

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

export class BrowserPyodideKernel implements NotebookKernel {
  readonly label = 'Python · Pyodide';

  private worker: Worker | null = null;
  private seq = 0;
  /**
   * Bumped on every `terminateWorker()`. `start()` checks it after its
   * `await` returns so a `dispose()`/`restart()` that lands mid-start — the
   * routine case being React StrictMode mounting the panel twice in dev,
   * where the first `start()` is canceled by the immediately-following
   * cleanup — is treated as "superseded," not as a failure to report.
   * Mirrors the identical `generation` guard already used by
   * `PyodideRunner` for the same reason.
   */
  private generation = 0;
  private waiting = new Map<number, Waiter>();
  private status: KernelStatus = 'dead';
  private statusListeners = new Set<(s: KernelStatus) => void>();
  private cellMessageSink: ((m: KernelMessage) => void) | null = null;
  private version = { pyodide: '', python: '' };
  private host: NotebookBridgeHost;
  /** In-flight `start()` call, if any — lets a concurrent `execute()` await the same startup instead of racing it. */
  private startPromise: Promise<void> | null = null;

  constructor(host: NotebookBridgeHost) {
    this.host = host;
  }

  getStatus() { return this.status; }
  onStatusChange(fn: (s: KernelStatus) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private setStatus(s: KernelStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/notebook-worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => { void this.onWorkerMessage(e.data); };
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

  private async onWorkerMessage(m: any) {
    if (m.type === 'bridge') {
      try {
        const payload = await this.dispatchBridge(m.request as BridgeRequest);
        if (payload instanceof Uint8Array) {
          this.worker?.postMessage({ type: 'bridgeResult', id: m.id, payload }, [payload.buffer]);
        } else {
          this.worker?.postMessage({ type: 'bridgeResult', id: m.id, payload });
        }
      } catch (err: any) {
        this.worker?.postMessage({ type: 'bridgeError', id: m.id, error: String(err?.message ?? err) });
      }
      return;
    }
    if (m.type === 'progress') return;
    if (m.type === 'cellMessage') { this.cellMessageSink?.(m.message as KernelMessage); return; }
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.type === 'error') w.reject(new Error(m.error));
    else w.resolve(m.payload);
  }

  /** Every capability notebook Python can reach — nothing else crosses this boundary. */
  private async dispatchBridge(request: BridgeRequest): Promise<string | Uint8Array> {
    switch (request.op) {
      case 'getCurrentArtifactMetadata':
        return JSON.stringify(this.host.getCurrentArtifactMetadata());
      case 'listArtifacts':
        return JSON.stringify(this.host.listArtifacts());
      case 'getArtifact':
        return JSON.stringify(this.host.getArtifact(request.idOrName));
      case 'queryArtifactData': {
        const table = await this.host.queryArtifactData(request.request);
        return arrow.tableToIPC(table, 'stream');
      }
      case 'publishArtifact': {
        const { op: _op, ...publishRequest } = request;
        return JSON.stringify(await this.host.publishArtifact(publishRequest));
      }
      case 'publishEventLog': {
        const { op: _op, ...logRequest } = request;
        return JSON.stringify(await this.host.publishEventLog(logRequest));
      }
      case 'openArtifact':
        this.host.openArtifact(request.id);
        return JSON.stringify({ ok: true });
      case 'focusArtifactInTree':
        this.host.focusArtifactInTree(request.id);
        return JSON.stringify({ ok: true });
      default:
        throw new Error(`unknown bridge op`);
    }
  }

  async start(): Promise<void> {
    if (this.status === 'idle' || this.status === 'busy') return;
    if (this.startPromise) return this.startPromise;
    this.setStatus('starting');
    const gen = this.generation;
    this.startPromise = (async () => {
      try {
        const v = await this.call<{ pyodide: string; python: string }>('init', {});
        if (gen !== this.generation) return; // superseded — see `generation`'s doc comment
        this.version = v;
        this.setStatus('idle');
      } catch (e) {
        if (gen !== this.generation) return; // superseded, not a real failure
        this.setStatus('error');
        throw e;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  async *execute(code: string, context: ExecutionContext): AsyncIterable<KernelMessage> {
    // Anything short of idle/busy means the worker hasn't finished registering the
    // `promenade` module yet — awaiting here (instead of only for dead/error) is what
    // closes the race where a click during 'starting' reached the worker before
    // `sys.modules["promenade"]` existed and blew up with ModuleNotFoundError.
    if (this.status !== 'idle' && this.status !== 'busy') await this.start();
    this.setStatus('busy');

    const queue: KernelMessage[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    this.cellMessageSink = (msg) => { queue.push(msg); wake?.(); };

    const provenance = {
      notebookId: context.notebookId,
      notebookTitle: context.notebookTitle,
      cellId: context.cellId,
      executionCount: context.executionCount,
      kernelLabel: this.label,
      kernelVersion: this.version.python || this.version.pyodide || 'unknown',
    };

    const runPromise = this.call('execute', { code, executionCount: context.executionCount, provenance })
      .catch((e: any) => {
        queue.push({ type: 'error', ename: 'KernelError', evalue: String(e?.message ?? e), traceback: [] });
      })
      .finally(() => { done = true; wake?.(); });

    try {
      while (!done || queue.length) {
        if (queue.length) { yield queue.shift()!; continue; }
        await new Promise<void>((res) => { wake = res; });
      }
    } finally {
      this.cellMessageSink = null;
      await runPromise;
      this.setStatus('idle');
    }
  }

  /** Always a full restart — see the class doc for why. */
  async interrupt() {
    await this.restart();
  }

  async restart() {
    this.setStatus('restarting');
    this.terminateWorker();
    await this.start();
  }

  async dispose() {
    this.terminateWorker();
    this.setStatus('dead');
  }

  private terminateWorker() {
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('kernel restarted'));
    this.waiting.clear();
    this.cellMessageSink = null;
  }
}
