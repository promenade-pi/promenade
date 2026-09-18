import { dataClient } from '../data/client';
import * as arrow from 'apache-arrow';

/**
 * Executes WASM compute plugins.
 *
 * Owns three things the plugin must not own: the worker lifecycle, the
 * debounce/abort policy, and the SQL bridge. A plugin cannot terminate itself
 * or decide how often it runs, which is what keeps a live parameter control
 * from turning into an unbounded queue of overlapping runs.
 */

export interface RunStats {
  rows: number;
  cases: number;
  totalEdges: number;
  shownEdges: number;
  prepareMs: number;
  finalizeMs: number;
  reused: boolean;
  heapEstimate: number;
}

export interface DfgResult {
  activities: string[];
  edges: Uint32Array;
  starts: Uint32Array;
  ends: Uint32Array;
  counts: Uint32Array;
  stats: RunStats;
}

type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

export class PluginRunner {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, Waiter>();
  private progressFn: ((f: number, m?: string) => void) | null = null;

  /** Generation counter: results from a superseded run are dropped. */
  private generation = 0;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../worker/plugin-worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = async (e) => {
      const m = e.data;

      // The plugin's only data door, serviced by the host.
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
      if (m.type === 'progress') {
        this.progressFn?.(m.fraction, m.message);
        return;
      }

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
   * Terminates the worker.
   *
   * This is the abort mechanism for the expensive stage: a WASM call in
   * progress cannot be interrupted from outside, so the host discards the
   * whole runtime. It is also the memory-budget enforcement — a discovery
   * plugin holding hundreds of MB is released here, not asked politely.
   */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('terminated'));
    this.waiting.clear();
    this.generation++;
  }

  /**
   * Runs the action, dropping any result whose generation has been superseded.
   * Callers debounce; this guarantees ordering regardless.
   */
  async run(
    args: { table: string; params: Record<string, unknown>; prepareKey: string },
    onProgress?: (f: number, m?: string) => void
  ): Promise<DfgResult | null> {
    const gen = ++this.generation;
    this.progressFn = onProgress ?? null;
    const raw = await this.call<any>('run', args);
    if (gen !== this.generation) return null; // superseded while running
    return {
      activities: raw.activities,
      edges: raw.edges instanceof Uint32Array ? raw.edges : Uint32Array.from(raw.edges),
      starts: Uint32Array.from(raw.starts),
      ends: Uint32Array.from(raw.ends),
      counts: Uint32Array.from(raw.counts),
      stats: raw.stats,
    };
  }
}

export const dfgRunner = new PluginRunner();

/** Debounce helper for the live parameter loop. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
