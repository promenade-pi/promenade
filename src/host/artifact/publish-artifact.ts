import type { ActionExecution, Artifact, ArtifactTypeId, ProvenanceGraph } from './types';
import { validateOcpn } from './ocpn.ts';
import { validateAcceptingPetriNet } from './petri-net.ts';

/**
 * Core types a package may publish without having declared them.
 *
 * The rule above — a package may only write types it defined — exists so no
 * manifest can forge someone else's type. That is right for an opaque payload
 * the host has no opinion about, and it also locked out the one case where the
 * host *does* have an opinion: an editor that draws a Petri net. Its whole
 * purpose is to produce a core type, and it can never own one.
 *
 * So the exception is narrow and earns its way in by being checked: a type is
 * listed here only if the host can validate its payload structurally, and
 * publishing one runs that validator. The forgery the `ownTypes` rule guards
 * against — a fake model slipped into the catalog — is exactly what a
 * validator prevents directly, rather than by proxy. Same shape as
 * `publish-log.ts`'s closed `PUBLISHABLE_TYPES`: a short, explicit list, not a
 * capability a manifest can widen.
 *
 * The view must still declare the type in its `publishes` — that gate is about
 * user consent at install time and is unaffected.
 */
export const HOST_VALIDATED_TYPES: Record<string, (value: unknown) => string | null> = {
  AcceptingPetriNet: validateAcceptingPetriNet,
  ObjectCentricPetriNet: validateOcpn,
};

/**
 * A view writing an artifact of a type its own package defined.
 *
 * The two publish doors that came before this one each answer a question the
 * host has an opinion about: `publish-log.ts` turns rows into Parquet, so it
 * has to know the relation layout of every type it accepts (hence the short,
 * closed `PUBLISHABLE_TYPES`); the two cohort publishers validate a payload
 * schema the host itself defined. Neither generalises, and a plugin that
 * invents its own artifact type — a questionnaire, a study response — needs
 * neither: the host has no opinion about the payload, because the package
 * that declared the type is the only thing that can have one.
 *
 * So what is validated here is the *envelope*, not the contents:
 *
 *  - the type is one this package declares (checked by the caller against the
 *    type registry's `provider`), so no manifest can forge someone else's
 *    type and slip a fake OCEL or Petri net into the catalog;
 *  - the payload is JSON-serialisable and within a sane size;
 *  - every declared input exists in the catalog, so provenance is real rather
 *    than asserted — a study response genuinely becomes a child of the
 *    questionnaire and of the log it was run against.
 *
 * The payload itself is opaque, and deliberately so. A host that validated it
 * would have to be updated for every plugin that ever ships a type.
 */

/** Beyond this the payload goes to `payload.json` rather than into the catalog. */
export const PUBLISH_ARTIFACT_INLINE_LIMIT = 256 * 1024;
/** A hard ceiling. Artifacts are references plus metadata; this is not a data store. */
export const PUBLISH_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

export interface PublishArtifactRequest {
  type: ArtifactTypeId;
  name: string;
  value: unknown;
  /** Artifacts this one was made from — its parents in the provenance DAG. */
  inputs?: string[];
  /** Optional, shallow, JSON-shaped metadata for the Inspector. */
  meta?: Record<string, unknown>;
}

const mint = (p: string) =>
  `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export interface BuiltArtifact {
  artifact: Artifact;
  execution: ActionExecution | null;
  /** Serialised payload size, so the caller can decide to materialize. */
  bytes: number;
  /** True when the payload must be written to `payload.json` instead of the catalog. */
  materialize: boolean;
}

/**
 * Validates a publish request and builds the artifact plus its execution
 * record. Writes nothing — the caller materializes and commits, so a rejected
 * request cannot leave a payload behind under an id no catalog row points at.
 */
export function buildPublishedArtifact(input: {
  request: unknown;
  /** The plugin package publishing this, for the provenance record. */
  provider: string;
  /** The live catalog, to check that declared inputs exist. */
  graph: ProvenanceGraph;
  /** Types this package declares — the authority on what it may publish. */
  ownTypes: (type: string) => boolean;
}): BuiltArtifact {
  const r = (input.request ?? {}) as Partial<PublishArtifactRequest>;

  const type = String(r.type ?? '');
  if (!type) throw new Error('publishArtifact needs a type.');
  const hostValidator = HOST_VALIDATED_TYPES[type];
  if (!hostValidator && !input.ownTypes(type)) {
    throw new Error(`This package does not define the artifact type "${type}".`);
  }

  const name = String(r.name ?? '').trim();
  if (!name) throw new Error('publishArtifact needs a name.');
  if (name.length > 200) throw new Error('That name is too long.');

  if (r.value === undefined) throw new Error('publishArtifact needs a value.');
  if (hostValidator) {
    // Checked before serialising: a payload that is not the type it claims is
    // rejected on its own terms, with the reason the validator gives, rather
    // than as a size or JSON complaint further down.
    const problem = hostValidator(r.value);
    if (problem) throw new Error(`That is not a valid ${type}: ${problem}.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(r.value);
  } catch {
    // A cycle, a BigInt, a function — all survive structured clone across the
    // frame boundary and all die at the storage layer. Better here than
    // half-way through a write.
    throw new Error('That value is not JSON-serialisable.');
  }
  if (serialized === undefined) throw new Error('That value is not JSON-serialisable.');
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > PUBLISH_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `That payload is ${Math.round(bytes / 1024)} KB; the limit is `
      + `${PUBLISH_ARTIFACT_MAX_BYTES / 1024 / 1024} MB. An artifact is a reference plus `
      + 'metadata, not a data store — large results belong in a relation.'
    );
  }

  const inputs = Array.isArray(r.inputs) ? r.inputs.map((i) => String(i)) : [];
  if (new Set(inputs).size !== inputs.length) {
    throw new Error('publishArtifact was given the same input twice.');
  }
  for (const id of inputs) {
    // Provenance that names an artifact which does not exist is worse than no
    // provenance: the DAG would show an edge to nothing, and every consumer
    // walking it has to cope with a dangling parent forever after.
    if (!input.graph.artifacts[id]) throw new Error(`No artifact with id "${id}".`);
  }

  const meta = r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)
    ? { ...(r.meta as Record<string, unknown>) }
    : {};

  const id = mint('a');
  const createdAt = new Date().toISOString();
  const materialize = bytes > PUBLISH_ARTIFACT_INLINE_LIMIT;

  // A published artifact with no inputs is a root, exactly like an import or a
  // hand-authored log: nothing was derived, so there is no execution to
  // record. With inputs it is derived, and the execution is what makes the
  // edges in the DAG real.
  const execution: ActionExecution | null = inputs.length
    ? {
      id: mint('x'),
      actionId: `${input.provider}.publishArtifact`,
      actionVersion: '1',
      inputs: { source: inputs },
      outputs: [id],
      params: { type },
      startedAt: createdAt,
      durationMs: 0,
      runtime: { kind: 'core', version: 'plugin-view-bridge/1' },
    }
    : null;

  return {
    artifact: {
      id,
      name,
      type,
      createdAt,
      // The real storage is filled in by the caller once it has written the
      // payload; inline is correct as-is for a small one.
      storage: materialize ? { kind: 'json', path: '' } : { kind: 'inline', value: r.value },
      meta: { ...meta, publishedBy: input.provider, bytes },
      producedBy: execution?.id ?? null,
      inputs,
    },
    execution,
    bytes,
    materialize,
  };
}
