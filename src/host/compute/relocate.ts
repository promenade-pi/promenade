/**
 * "Copy to Promenade Compute" / "Move to Promenade Compute" / "Move to
 * Browser" — the artifact-tree context menu actions from
 * `docs/promenade-compute.md` §5, backed by the engine's `/artifacts/blob`
 * endpoints (`compute/engine/src/handlers.rs`).
 *
 * Stage 1 only relocates `storage.kind === 'inline'` artifacts — a
 * Parquet-backed raw log doesn't move yet (see `compute/README.md`). Copy
 * leaves the local artifact's storage untouched and just also puts the data
 * on the engine, recorded in `meta.computeCopies` (informational — nothing
 * currently reads it back except the tree's own badge). Move relocates the
 * canonical copy: `artifact.location` points at the engine and
 * `storage.value` is evicted (freeing the in-memory/OPFS copy), or, on the
 * way back, rehydrated from the engine's export.
 */

import { dataClient } from '../data/client';
import type { Artifact, ProvenanceGraph } from '../artifact/types';
import type { ComputeEngine } from './engines';

export function canRelocate(artifact: Artifact): boolean {
  return artifact.storage.kind === 'inline' && artifact.storage.value != null;
}

export interface ComputeCopy {
  engineId: string;
  engineName: string;
  remoteId: string;
  copiedAt: string;
}

export function computeCopiesOf(artifact: Artifact): ComputeCopy[] {
  return Array.isArray(artifact.meta.computeCopies) ? (artifact.meta.computeCopies as ComputeCopy[]) : [];
}

async function uploadBlob(engine: ComputeEngine, artifact: Artifact): Promise<string> {
  const res = await fetch(`${engine.endpoint}/artifacts/blob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifactId: artifact.id, value: (artifact.storage as any).value }),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
  const { remoteId } = await res.json();
  return remoteId;
}

/** Puts a copy of the data on the engine; the local artifact is unchanged. */
export async function copyArtifactToEngine(artifact: Artifact, engine: ComputeEngine): Promise<ProvenanceGraph> {
  if (!canRelocate(artifact)) throw new Error(`"${artifact.name}" has no local inline data to copy`);
  const remoteId = await uploadBlob(engine, artifact);
  const copy: ComputeCopy = { engineId: engine.id, engineName: engine.name, remoteId, copiedAt: new Date().toISOString() };
  const computeCopies = [...computeCopiesOf(artifact).filter((c) => c.engineId !== engine.id), copy];
  const { catalog } = await dataClient.relocateArtifact(artifact.id, { meta: { computeCopies } });
  return catalog;
}

/** Relocates the canonical copy to the engine, evicting local storage. */
export async function moveArtifactToEngine(artifact: Artifact, engine: ComputeEngine): Promise<ProvenanceGraph> {
  if (!canRelocate(artifact)) throw new Error(`"${artifact.name}" has no local inline data to move`);
  const remoteId = await uploadBlob(engine, artifact);
  const { catalog } = await dataClient.relocateArtifact(artifact.id, {
    location: { engineId: engine.id, remoteId },
    storage: { kind: 'inline', value: null },
  });
  return catalog;
}

/** Pulls a remotely-relocated artifact's data back, clearing `location`. */
export async function moveArtifactToBrowser(artifact: Artifact, engine: ComputeEngine): Promise<ProvenanceGraph> {
  if (!artifact.location) throw new Error(`"${artifact.name}" is not on a Promenade Compute engine`);
  const res = await fetch(`${engine.endpoint}/artifacts/blob/${artifact.location.remoteId}`);
  if (!res.ok) throw new Error(`export failed: ${res.status} ${await res.text().catch(() => '')}`);
  const { value } = await res.json();
  const { catalog } = await dataClient.relocateArtifact(artifact.id, { location: null, storage: { kind: 'inline', value } });
  return catalog;
}
