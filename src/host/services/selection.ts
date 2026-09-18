/**
 * Selection bus — a host service with an explicit, plugin-independent vocabulary.
 *
 * Linked selection across panels is a core promise of the docked layout, and
 * across an iframe boundary it only works with a contract both sides already
 * agree on. The vocabulary is therefore (artifactId, elementKind, elementId)
 * where elementId comes from the *artifact schema* — an event id, an object
 * id, an activity name — and never a plugin-internal row index. An index is
 * meaningless to the panel next door.
 */

import type { ArtifactId } from '../artifact/types';

export type ElementKind =
  | 'event' | 'object' | 'activity' | 'objectType'
  | 'trace' | 'edge' | 'place' | 'transition';

export interface SelectionItem {
  artifactId: ArtifactId;
  kind: ElementKind;
  /** Identifier from the artifact's own schema. Never a positional index. */
  id: string;
  /** Optional composite key for edges: "A->B" style endpoints. */
  parts?: Record<string, string>;
}

export interface Selection {
  items: SelectionItem[];
  /** Panel that originated it, so a view can avoid echoing its own change. */
  source: string;
}

const EMPTY: Selection = { items: [], source: '' };

export class SelectionBus {
  private current: Selection = EMPTY;
  private listeners = new Set<(s: Selection) => void>();

  get(): Selection { return this.current; }

  set(items: SelectionItem[], source: string) {
    this.current = { items, source };
    for (const l of this.listeners) l(this.current);
  }

  clear(source: string) { this.set([], source); }

  /** True if the given element is selected — the common view-side query. */
  isSelected(artifactId: ArtifactId, kind: ElementKind, id: string): boolean {
    return this.current.items.some(
      (i) => i.artifactId === artifactId && i.kind === kind && i.id === id
    );
  }

  subscribe(fn: (s: Selection) => void) {
    this.listeners.add(fn);
    fn(this.current);
    return () => this.listeners.delete(fn);
  }
}

export const selectionBus = new SelectionBus();
