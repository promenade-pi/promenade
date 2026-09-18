import * as arrow from 'apache-arrow';
import { dataClient } from '../data/client';
import { readPluginFile } from './store';
import { entryOf, wasmOf, kernelOf, type PluginManifest } from './manifest';

/**
 * Runs a packaged WASM plugin action.
 *
 * The host owns the worker, the SQL bridge, the abort policy and the memory
 * budget. A plugin cannot terminate itself, cannot decide how often it runs,
 * and cannot reach data except by asking.
 *
 * Keyed by `(plugin, action)`, not just plugin: a package may declare more
 * than one `wasm` action (with its own entry/wasm/kernel, via the per-action
 * override fields — see `manifest.ts`'s `entryOf`/`wasmOf`/`kernelOf`), each
 * getting its own worker and its own cached scan.
 */

export interface PluginRunResult<T = any> {
  result: T;
  activities: string[];
  timing: {
    prepareMs: number;
    finalizeMs: number;
    reused: boolean;
    rows: number | null;
    cases: number | null;
    /** Host-side packaged-code loading, kept separate from the kernel scan. */
    bundleMs?: number;
    bundleCached?: boolean;
    workerCold?: boolean;
  };
}

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

/** Memory budgets by declared appetite, enforced by discarding the worker. */
const BUDGET_MB: Record<string, number> = { low: 256, medium: 768, high: 2048 };

type ManifestAction = NonNullable<PluginManifest['actions']>[number];

export class WasmPluginRunner {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, Waiter>();
  private progressFn: ((f: number, m?: string) => void) | null = null;
  private generation = 0;
  private loaded: { glue: string; wasm: ArrayBuffer } | null = null;

  constructor(private manifest: PluginManifest, private action: ManifestAction) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/wasm-plugin-worker.ts', import.meta.url), {
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
      if (m.type === 'progress') { this.progressFn?.(m.fraction, m.message); return; }
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

  /**
   * Hard stop. A WASM call in progress cannot be interrupted from outside, so
   * the runtime is discarded wholesale. This is also how the memory budget is
   * enforced — a kernel holding hundreds of MB is released, not asked.
   */
  terminate(reason = 'terminated') {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error(reason));
    this.waiting.clear();
    this.generation++;
  }

  get budgetMB() { return BUDGET_MB[this.action.memory ?? 'medium'] ?? 768; }

  private async bundle() {
    if (this.loaded) return this.loaded;
    const entry = entryOf(this.manifest, this.action);
    const wasm = wasmOf(this.manifest, this.action);
    if (!entry || !wasm) throw new Error(`action ${this.action.id}: wasm runtime missing entry/wasm`);
    const glueBytes = await readPluginFile(this.manifest.id, entry);
    const wasmBytes = await readPluginFile(this.manifest.id, wasm);
    this.loaded = {
      glue: new TextDecoder().decode(glueBytes),
      wasm: wasmBytes.buffer as ArrayBuffer,
    };
    return this.loaded;
  }

  /**
   * Runs the action.
   *
   * `signal` is honored for real, not decoratively: aborting raises the flag
   * the worker checks between chunks, and if the run does not stop promptly
   * the worker is terminated.
   */
  async run(args: {
    table: string;
    params: Record<string, unknown>;
    prepareKey: string;
    /** A model-to-model action: instantiate, finalize once, and do no scan. */
    valueFinalize?: boolean;
    signal?: AbortSignal;
    onProgress?: (f: number, m?: string) => void;
  }): Promise<PluginRunResult | null> {
    const gen = ++this.generation;
    this.progressFn = args.onProgress ?? null;

    const bundleCached = !!this.loaded;
    const bundleStarted = performance.now();
    const { glue, wasm } = await this.bundle();
    const bundleMs = performance.now() - bundleStarted;
    const workerCold = !this.worker;
    const kernel = kernelOf(this.manifest, this.action);
    const kernelClass = kernel?.class;
    if (!kernelClass) throw new Error(`action ${this.action.id}: manifest declares no kernel class`);

    let onAbort: (() => void) | null = null;
    if (args.signal) {
      if (args.signal.aborted) return null;
      onAbort = () => {
        this.call('abort', {}).catch(() => {});
        // Escalate if the cooperative stop does not land quickly.
        setTimeout(() => {
          if (gen === this.generation) this.terminate('aborted');
        }, 500);
      };
      args.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const payload = await this.call<PluginRunResult>('run', {
        pluginId: `${this.manifest.id}::${this.action.id}`,
        glue,
        wasm,
        className: kernelClass,
        table: args.table,
        params: args.params,
        prepareKey: args.prepareKey,
        scanOrder: kernel?.scan?.order ?? 'timestamp',
        scanEmptyTraces: kernel?.scan?.includeEmptyTraces ?? false,
        scanActivityIds: kernel?.scan?.activityIds ?? 'frequency',
        scanClassifier: kernel?.scan?.classifier ?? 'activity',
        scanResource: kernel?.scan?.resource ?? false,
        valueFinalize: args.valueFinalize ?? false,
      });
      if (gen !== this.generation) return null; // superseded
      return {
        ...payload,
        timing: { ...payload.timing, bundleMs, bundleCached, workerCold },
      };
    } finally {
      if (args.signal && onAbort) args.signal.removeEventListener('abort', onAbort);
    }
  }
}

const runners = new Map<string, WasmPluginRunner>();

export function runnerFor(manifest: PluginManifest, action: ManifestAction): WasmPluginRunner {
  const key = `${manifest.id}::${action.id}`;
  let r = runners.get(key);
  if (!r) { r = new WasmPluginRunner(manifest, action); runners.set(key, r); }
  return r;
}

export function disposeRunnersFor(pluginId: string) {
  for (const [key, r] of runners) {
    if (key.startsWith(`${pluginId}::`)) { r.terminate('plugin removed'); runners.delete(key); }
  }
}
