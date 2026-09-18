/**
 * Real implementation of `NotebookBridgeHost` against live app state.
 *
 * Everything a notebook's Python can reach goes through this file's seven
 * methods — never `window`, never `dataClient`/OPFS/DuckDB directly from
 * the kernel. Constructed fresh by `NotebookView` with getters/callbacks
 * closing over the same `ProvenanceGraph` and `openView`/`setSelected`
 * functions the rest of the app already uses, so there is no second,
 * privileged surface. See docs/python-notebook.md.
 */

import * as arrow from 'apache-arrow';
import type { Artifact, ProvenanceGraph } from '../artifact/types';
import { dataClient } from '../data/client';
import { artifactTypes } from '../artifact/registry';
import { buildQuerySql } from './query';
import { buildPublishedArtifact, buildExecution, mintId, requireValidPublishTarget } from './publish';
import {
  artifactSummaryOf, type ArtifactMetadata, type ArtifactSummary,
  type NotebookBridgeHost, type PublishRequest, type PublishEventLogRequest,
  type PublishedSummary, type QueryDataRequest,
} from './bridge';
import type { ActionExecution } from '../artifact/types';

const INLINE_PAYLOAD_LIMIT = 512 * 1024;

function metadataOf(a: Artifact): ArtifactMetadata {
  const base = { ...artifactSummaryOf(a), meta: a.meta, inputs: a.inputs };
  if (a.storage.kind === 'inline') {
    const size = (() => { try { return JSON.stringify(a.storage.value).length; } catch { return Infinity; } })();
    if (size <= INLINE_PAYLOAD_LIMIT) return { ...base, payload: a.storage.value };
  }
  return base;
}

export interface NotebookBridgeHostDeps {
  getGraph: () => ProvenanceGraph;
  /** The artifact this notebook was opened against — fixed for the session. */
  getBoundArtifactId: () => string | null;
  onGraphUpdated: (catalog: ProvenanceGraph) => void;
  onOpenArtifact: (id: string) => void;
  onFocusArtifact: (id: string) => void;
  /**
   * Called before every publish. Resolves to the notebook/script identity to
   * stamp into that publish's provenance. When the notebook/script is
   * already a saved artifact, or the user has already answered for this
   * panel's session, this resolves immediately with no user-visible effect —
   * it is not a "first publish only" hook, the once-per-session behavior is
   * the *implementation*'s job (see `NotebookView.tsx`/`ScriptEditor.tsx`),
   * not something this bridge tracks or assumes.
   */
  ensureSaved: () => Promise<{ notebookId: string; notebookTitle: string }>;
}

export function createNotebookBridgeHost(deps: NotebookBridgeHostDeps): NotebookBridgeHost {
  return {
    getCurrentArtifactMetadata() {
      const id = deps.getBoundArtifactId();
      if (!id) return null;
      const a = deps.getGraph().artifacts[id];
      return a ? metadataOf(a) : null;
    },

    listArtifacts(): ArtifactSummary[] {
      return Object.values(deps.getGraph().artifacts).map(artifactSummaryOf);
    },

    getArtifact(idOrName: string): ArtifactMetadata {
      const graph = deps.getGraph();
      const byId = graph.artifacts[idOrName];
      if (byId) return metadataOf(byId);
      const byName = Object.values(graph.artifacts).find((a) => a.name === idOrName);
      if (byName) return metadataOf(byName);
      throw new Error(`No artifact found for '${idOrName}'.`);
    },

    async queryArtifactData(request: QueryDataRequest): Promise<arrow.Table> {
      const artifact = deps.getGraph().artifacts[request.artifactId];
      if (!artifact) throw new Error(`Artifact '${request.artifactId}' no longer exists.`);
      const sql = buildQuerySql(artifact, request);
      return dataClient.sql(sql);
    },

    async publishArtifact(request: PublishRequest): Promise<PublishedSummary> {
      // Resolves before `getGraph()`, not after: if this triggers a save,
      // the fresh id/name it hands back is what provenance should carry —
      // `getGraph()` reading a not-yet-re-rendered `graph` prop afterward is
      // fine, nothing below actually depends on that save being visible
      // there yet (see `NotebookBridgeHostDeps.ensureSaved`'s doc comment).
      const ensured = await deps.ensureSaved();
      const provenance = { ...request.provenance, notebookId: ensured.notebookId, notebookTitle: ensured.notebookTitle };
      const graph = deps.getGraph();
      for (const id of request.inputArtifactIds) {
        if (!graph.artifacts[id]) throw new Error(`Input artifact '${id}' no longer exists.`);
      }
      const { artifact, execution } = buildPublishedArtifact({
        type: request.type,
        name: request.name,
        payload: request.payload,
        meta: request.meta,
        inputArtifactIds: request.inputArtifactIds,
        provenance,
      });
      const r: any = await dataClient.putArtifact(artifact, execution);
      deps.onGraphUpdated(r.catalog);
      return { id: artifact.id, name: artifact.name, type: artifact.type, summary: artifactTypes.get(artifact.type).label };
    },

    async publishEventLog(request: PublishEventLogRequest): Promise<PublishedSummary> {
      const ensured = await deps.ensureSaved();
      const provenance = { ...request.provenance, notebookId: ensured.notebookId, notebookTitle: ensured.notebookTitle };
      const graph = deps.getGraph();
      for (const id of request.inputArtifactIds) {
        if (!graph.artifacts[id]) throw new Error(`Input artifact '${id}' no longer exists.`);
      }
      requireValidPublishTarget(request.targetType, request.name);

      // Unlike `publishArtifact`, the id has to exist *before* the artifact
      // object does: `materializeNotebookLog` writes Parquet under it first,
      // and only the resulting `storage`/`meta` complete the `Artifact`.
      const id = mintId('a');
      const { storage, meta }: any = await dataClient.materializeNotebookLog({
        id, targetType: request.targetType, relations: request.relations,
      });
      const execution: ActionExecution = buildExecution([id], request.inputArtifactIds, provenance);
      const artifact: Artifact = {
        id,
        name: request.name,
        type: request.targetType,
        createdAt: execution.startedAt,
        storage,
        meta,
        producedBy: execution.id,
        inputs: request.inputArtifactIds,
      };
      const r: any = await dataClient.putArtifact(artifact, execution);
      deps.onGraphUpdated(r.catalog);
      return { id: artifact.id, name: artifact.name, type: artifact.type, summary: artifactTypes.get(artifact.type).label };
    },

    openArtifact(id: string) {
      deps.onOpenArtifact(id);
    },

    focusArtifactInTree(id: string) {
      deps.onFocusArtifact(id);
    },
  };
}
