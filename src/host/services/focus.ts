import type { ArtifactId } from '../artifact/types';

/**
 * Artifact focus — a host service, separate from the selection bus.
 *
 * The selection bus carries *elements inside* an artifact (an activity, an
 * object type). Which artifact the workspace is looking at is a different
 * question, and conflating the two would let a view claim a selection on an
 * artifact it does not belong to.
 *
 * A view asks the host to focus an artifact; the host decides what that means
 * (updating the tree selection, the inspector, and any open panel).
 */
class ArtifactFocus {
  private listeners = new Set<(id: ArtifactId) => void>();

  request(id: ArtifactId) {
    for (const l of this.listeners) l(id);
  }

  subscribe(fn: (id: ArtifactId) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const artifactFocus = new ArtifactFocus();
