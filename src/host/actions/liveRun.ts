import type { ArtifactTypeId } from '../artifact/types';

/**
 * The single in-flight action run that a live-preview view is bound to.
 *
 * An action can emit structured frame batches through
 * `ctx.progress(fraction, message, data)`. When its output type has a
 * `livePreview` view (`ViewDef.livePreview`), `App`'s `onRun` opens a panel
 * for the not-yet-existing artifact and this store carries the frames to it —
 * `PluginPanel` subscribes and forwards each batch into the sandbox as a
 * `liveFrame` message. Exactly one run is live at a time (a new run
 * supersedes the previous), mirroring `inFlight` in `App`.
 *
 * Frames are the *rich* channel, and only an action that chooses to emit
 * `data` has them. The plain `fraction`/`message` every runtime already
 * reports (the wasm worker's chunked scan, a pyodide `ctx.progress` with no
 * data) is carried too, and forwarded as `liveRunState` — that alone is
 * enough for a view whose live preview is a standby animation rather than a
 * reconstruction of the pending result, which is the only thing a kernel
 * that cannot describe its own intermediate state can offer.
 *
 * Nothing here is persisted: the frames exist only for the duration of the
 * run, and the real artifact (with its own bounded `trace`) replaces them
 * the moment the run finishes.
 */
export type LiveRunState = 'running' | 'done' | 'error';

export interface LiveRunSnapshot {
  runId: string;
  actionId: string;
  outputType: ArtifactTypeId;
  /** OCPN model payload etc. the view needs before the first frame — put on
   * the synthetic artifact's `value` so a view can lay out immediately. */
  seed: unknown;
  frames: unknown[];
  state: LiveRunState;
  message: string;
  /** 0..1 where the run knows it, `null` where it is genuinely indefinite —
   * never a fabricated number, so a view can honestly draw an indeterminate
   * animation instead of a bar that lies about being nearly done. */
  fraction: number | null;
}

class LiveRunStore {
  private snap: LiveRunSnapshot | null = null;
  private listeners = new Set<() => void>();

  current(): LiveRunSnapshot | null { return this.snap; }

  start(runId: string, actionId: string, outputType: ArtifactTypeId, seed: unknown): void {
    this.snap = { runId, actionId, outputType, seed, frames: [], state: 'running', message: '', fraction: null };
    this.emit();
  }

  /** Coarse progress, with no structured frame attached. */
  progress(runId: string, fraction: number | null, message: string): void {
    if (!this.snap || this.snap.runId !== runId || this.snap.state !== 'running') return;
    if (this.snap.fraction === fraction && this.snap.message === message) return;
    this.snap = { ...this.snap, fraction, message };
    this.emit();
  }

  frame(runId: string, batch: unknown): void {
    if (!this.snap || this.snap.runId !== runId || this.snap.state !== 'running') return;
    this.snap = { ...this.snap, frames: [...this.snap.frames, batch] };
    this.emit();
  }

  finish(runId: string, state: 'done' | 'error', message = ''): void {
    if (!this.snap || this.snap.runId !== runId) return;
    this.snap = { ...this.snap, state, message };
    this.emit();
  }

  /** Drop the live run once its panel has handed off to the real artifact. */
  clear(runId: string): void {
    if (this.snap && this.snap.runId !== runId) return;
    this.snap = null;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() { for (const l of this.listeners) l(); }
}

export const liveRun = new LiveRunStore();
