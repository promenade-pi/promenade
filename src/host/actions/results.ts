import type { DfgResult } from './executor';

/**
 * In-memory results of derived artifacts.
 *
 * Derived artifacts are not persisted yet: they are cheap to recompute and,
 * more importantly, the live loop rewrites them on every parameter change.
 * Writing Parquet on each keystroke would be exactly the wrong trade.
 */
class ResultStore {
  private map = new Map<string, DfgResult>();
  private listeners = new Set<() => void>();

  set(artifactId: string, r: DfgResult) {
    this.map.set(artifactId, r);
    this.emit();
  }
  get(artifactId: string) { return this.map.get(artifactId); }
  delete(artifactId: string) { this.map.delete(artifactId); this.emit(); }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() { for (const l of this.listeners) l(); }
}

export const resultStore = new ResultStore();

/**
 * The plugin's own payload for an artifact, without the runner's envelope.
 *
 * `executeAction()` wraps an inline outcome's value in `{ result, activities,
 * stats }` so the host can record activities/timing alongside it; the app's
 * boot-time rehydration (`App.tsx`'s `dataClient.boot()` handler) instead
 * puts an already-bare `storage.value` straight into the store. A `result`
 * key is the one thing every wrapped shape has and no bare payload does (none
 * of `OcpnPayload`/`ProcessTree`/`AcceptingPetriNet`/etc. declare a field by
 * that name) — checking for it alone, rather than also requiring a specific
 * sibling key like the `timing` field an earlier envelope shape had and the
 * current one doesn't, is what makes this work regardless of which of the
 * two ever wrote this id.
 */
export function payloadOf(id: string): unknown {
  // Older sessions can contain a wrapper written by the action executor and
  // then wrapped again while restoring an inline artifact.  Peel every such
  // transport envelope: `result` is reserved for that envelope, never a
  // field of the supported model payloads.  Keeping this here makes every
  // sandboxed model view receive the actual model rather than `{ result: … }`.
  let value: any = resultStore.get(id);
  for (let depth = 0; depth < 4 && value && typeof value === 'object' && 'result' in value; depth++) {
    value = value.result;
  }
  return value;
}
