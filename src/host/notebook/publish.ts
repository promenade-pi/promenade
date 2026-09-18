/**
 * Turns a `promenade.publish()` (or `publish_event_log()`/`publish_ocel()`)
 * request into a real Promenade artifact + `ActionExecution`, through the
 * exact same `Artifact`/provenance contract every other runtime already
 * populates. `buildPublishedArtifact()` is pure and independently
 * testable — no Pyodide, no `dataClient`, no React. `mintId`/`buildExecution`
 * are shared with `bridge-host.ts`'s log-publishing path, which needs an
 * artifact id *before* `buildPublishedArtifact` would normally mint one
 * (materialization writes Parquet under that id first) but wants the exact
 * same provenance shape. See docs/python-notebook.md, "promenade.publish()".
 */

import type { Artifact, ActionExecution } from '../artifact/types.ts';
import { artifactTypes } from '../artifact/registry.ts';

export interface NotebookProvenance {
  notebookId: string;
  notebookTitle: string;
  cellId: string;
  executionCount: number;
  kernelLabel: string;
  kernelVersion: string;
  packages: Record<string, string>;
}

export interface PublishInput {
  type: string;
  name: string;
  payload: unknown;
  meta?: Record<string, unknown>;
  inputArtifactIds: string[];
  provenance: NotebookProvenance;
}

export function mintId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** The `ActionExecution` every notebook-produced artifact shares, regardless of how its payload was built. */
export function buildExecution(
  outputs: string[], inputArtifactIds: string[], provenance: NotebookProvenance,
): ActionExecution {
  return {
    id: mintId('x'),
    actionId: 'core.notebook',
    actionVersion: '1',
    inputs: { source: inputArtifactIds },
    outputs,
    params: {
      notebook: { id: provenance.notebookId, title: provenance.notebookTitle },
      cellId: provenance.cellId,
      executionCount: provenance.executionCount,
      packages: provenance.packages,
    },
    startedAt: new Date().toISOString(),
    durationMs: 0,
    runtime: { kind: 'pyodide', version: `${provenance.kernelLabel} ${provenance.kernelVersion}` },
  };
}

/** Throws when `type` is not a registered artifact type, or `name` is empty. */
export function requireValidPublishTarget(type: string, name: string): void {
  const def = artifactTypes.get(type);
  if (def.provider === 'unknown') {
    throw new Error(
      `Unknown artifact type '${type}'. It is not registered in this session — check spelling, `
      + `or pass a type= that matches a Promenade artifact type.`,
    );
  }
  if (!name || !name.trim()) {
    throw new Error('publish() requires a non-empty name.');
  }
}

/**
 * Validates the target type is registered and builds the artifact +
 * execution pair `dataClient.putArtifact()` expects. Throws (rather than
 * building a half-valid artifact) when the type is unrecognised or the name
 * is empty — a failed conversion must never leave a partial artifact behind.
 * For inline-payload artifacts (models: Petri nets, process trees) — a
 * log-shaped artifact's storage is built by `bridge-host.ts`'s
 * `publishEventLog`, via `materializeNotebookLog` + `buildExecution` above,
 * since a log needs real Parquet files, not an inline JSON blob.
 */
export function buildPublishedArtifact(input: PublishInput): { artifact: Artifact; execution: ActionExecution } {
  requireValidPublishTarget(input.type, input.name);

  const id = mintId('a');
  const execution = buildExecution([id], input.inputArtifactIds, input.provenance);

  const artifact: Artifact = {
    id,
    // A duplicate display name never collides with an existing artifact:
    // identity is the minted id, exactly as for every action-produced
    // artifact — two published nets can legitimately share a name.
    name: input.name,
    type: input.type,
    createdAt: execution.startedAt,
    storage: { kind: 'inline', value: input.payload },
    meta: input.meta ?? {},
    producedBy: execution.id,
    inputs: input.inputArtifactIds,
  };

  return { artifact, execution };
}
