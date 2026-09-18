/**
 * Notebook bridge — the typed, capability-oriented RPC surface between
 * notebook Python (the `promenade` module) and the host.
 *
 * Every op is a narrow, named capability, not "run this SQL" or "call this
 * host function". `BrowserPyodideKernel` validates every request against the
 * live `ProvenanceGraph` before delegating to a `NotebookBridgeHost` — the
 * kernel and the worker never see `dataClient`, OPFS, or `window` directly.
 * See docs/python-notebook.md, "Python↔Promenade bridge".
 */

import type * as arrow from 'apache-arrow';
import type { Artifact } from '../artifact/types';

export interface ArtifactSummary {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

export interface ArtifactMetadata extends ArtifactSummary {
  meta: Record<string, unknown>;
  inputs: string[];
  /** Present only for small, inline/json-stored artifacts (models, not logs). */
  payload?: unknown;
}

/** Structured, semantic query — never a raw SQL string. */
export interface QueryDataRequest {
  artifactId: string;
  op: 'events' | 'cases' | 'variants' | 'activities' | 'attributes'
    | 'objects' | 'e2o' | 'o2o' | 'event_attributes' | 'object_attributes';
  columns?: string[];
  limit?: number;
}

export interface ProvenanceWire {
  notebookId: string;
  notebookTitle: string;
  cellId: string;
  executionCount: number;
  kernelLabel: string;
  kernelVersion: string;
  packages: Record<string, string>;
}

export interface PublishRequest {
  /** Always resolved to a concrete type by the Python-side converter registry before this crosses the bridge. */
  type: string;
  name: string;
  payload: unknown;
  meta?: Record<string, unknown>;
  /** Which bound artifacts this result was derived from. */
  inputArtifactIds: string[];
  provenance: ProvenanceWire;
}

/**
 * `promenade.publish_event_log()` / `publish_ocel()` — a log-shaped result,
 * built from real Parquet-backed storage rather than an inline JSON blob
 * (see `materializeNotebookLog` in `worker/data-worker.ts`). `relations` is
 * keyed by the *physical* logical table name the target type expects
 * (`event`/`trace` for `TraditionalEventLog`; `event`/`object`/`e2o`/`o2o`
 * for `ObjectCentricEventLog`) — the same vocabulary
 * `host/relational/schemas.ts`'s `PHYSICAL_LOGICAL_NAME` already uses, not a
 * notebook-invented one.
 */
export interface PublishEventLogRequest {
  targetType: 'TraditionalEventLog' | 'ObjectCentricEventLog';
  name: string;
  inputArtifactIds: string[];
  provenance: ProvenanceWire;
  relations: Record<string, Uint8Array>;
}

export interface PublishedSummary {
  id: string;
  name: string;
  type: string;
  summary: string;
}

/**
 * What the kernel/worker asks the host to do — one variant per bridge op.
 *
 * `publishArtifact`'s fields are flattened alongside `op`, not nested under
 * a `request` key: the worker's generic JSON bridge call
 * (`notebook-worker.ts`'s `bridgeJson`) spreads the Python-side args object
 * directly onto the wire message. `queryArtifactData` is the one exception —
 * it travels over the separate `bridgeQuery` call, which does nest its
 * payload under `request`, because that path also carries a distinct
 * (non-JSON) Arrow-bytes response.
 */
export type BridgeRequest =
  | { op: 'getCurrentArtifactMetadata' }
  | { op: 'listArtifacts' }
  | { op: 'getArtifact'; idOrName: string }
  | { op: 'queryArtifactData'; request: QueryDataRequest }
  | ({ op: 'publishArtifact' } & PublishRequest)
  | ({ op: 'publishEventLog' } & PublishEventLogRequest)
  | { op: 'openArtifact'; id: string }
  | { op: 'focusArtifactInTree'; id: string };

export type BridgeResponseFor<R extends BridgeRequest> =
  R extends { op: 'getCurrentArtifactMetadata' } ? ArtifactMetadata | null :
  R extends { op: 'listArtifacts' } ? ArtifactSummary[] :
  R extends { op: 'getArtifact' } ? ArtifactMetadata :
  R extends { op: 'queryArtifactData' } ? Uint8Array : // Arrow IPC
  R extends { op: 'publishArtifact' } ? PublishedSummary :
  R extends { op: 'publishEventLog' } ? PublishedSummary :
  R extends { op: 'openArtifact' } ? { ok: true } :
  R extends { op: 'focusArtifactInTree' } ? { ok: true } :
  never;

/**
 * Host-side implementation of every bridge op, injected into
 * `BrowserPyodideKernel` rather than imported by it — keeps the kernel
 * testable against a mock and free of any direct `dataClient`/`window`
 * dependency. `bridge-host.ts` is the real implementation against live app
 * state; tests supply a fake.
 */
export interface NotebookBridgeHost {
  getCurrentArtifactMetadata(): ArtifactMetadata | null;
  listArtifacts(): ArtifactSummary[];
  getArtifact(idOrName: string): ArtifactMetadata;
  queryArtifactData(request: QueryDataRequest): Promise<arrow.Table>;
  publishArtifact(request: PublishRequest): Promise<PublishedSummary>;
  publishEventLog(request: PublishEventLogRequest): Promise<PublishedSummary>;
  openArtifact(id: string): void;
  focusArtifactInTree(id: string): void;
}

export function artifactSummaryOf(a: Artifact): ArtifactSummary {
  return { id: a.id, name: a.name, type: a.type, createdAt: a.createdAt };
}
