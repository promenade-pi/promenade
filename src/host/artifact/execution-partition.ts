import type { ActionExecution, Artifact } from './types';

/**
 * A reusable, versioned result of object-centric execution extraction.
 *
 * This is intentionally membership data, not a copy of OCEL rows.  Consumers
 * join the recorded event ids back to `sourceArtifactId`; that preserves the
 * source log as the single canonical record of events and objects.
 */
export const EXECUTION_PARTITION_TYPE = 'ObjectCentricExecutionPartition';
export const EXECUTION_PARTITION_SCHEMA_VERSION = 1;
export const EXECUTION_PARTITION_INLINE_LIMIT = 8 * 1024 * 1024;

export interface ObjectCentricExecution {
  id: string;
  objectIds: string[];
  eventIds: string[];
  variantId: string;
  truncated: boolean;
  startMs: number;
  endMs: number;
}

export interface ObjectCentricVariant {
  id: string;
  executionIds: string[];
}

export interface ObjectCentricExecutionPartition {
  schemaVersion: 1;
  sourceArtifactId: string;
  extraction: {
    method: 'leadingType' | 'connectedComponents';
    leadingType?: string;
    scopeSharedObjects: boolean;
    maxEvents: number;
  };
  executions: ObjectCentricExecution[];
  variants: ObjectCentricVariant[];
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/** Throws for malformed or internally inconsistent partition payloads. */
export function requireExecutionPartition(value: unknown, sourceArtifactId?: string): ObjectCentricExecutionPartition {
  const p = value as Partial<ObjectCentricExecutionPartition> | null;
  if (!p || p.schemaVersion !== EXECUTION_PARTITION_SCHEMA_VERSION || typeof p.sourceArtifactId !== 'string') {
    throw new Error('Execution partition must use schemaVersion 1 and name its source artifact.');
  }
  if (sourceArtifactId && p.sourceArtifactId !== sourceArtifactId) {
    throw new Error('Execution partition sourceArtifactId must match the artifact it was opened from.');
  }
  const extraction = p.extraction;
  if (!extraction || (extraction.method !== 'leadingType' && extraction.method !== 'connectedComponents')
    || typeof extraction.scopeSharedObjects !== 'boolean' || !Number.isInteger(extraction.maxEvents) || extraction.maxEvents < 1) {
    throw new Error('Execution partition has invalid extraction parameters.');
  }
  if (!Array.isArray(p.executions) || !Array.isArray(p.variants)) {
    throw new Error('Execution partition must include executions and variants.');
  }
  const executionIds = new Set<string>();
  for (const e of p.executions) {
    if (!e || typeof e.id !== 'string' || !e.id || typeof e.variantId !== 'string' || !e.variantId
      || !isStringList(e.objectIds) || !isStringList(e.eventIds) || typeof e.truncated !== 'boolean'
      || !Number.isFinite(e.startMs) || !Number.isFinite(e.endMs) || executionIds.has(e.id)) {
      throw new Error('Execution partition contains an invalid execution.');
    }
    executionIds.add(e.id);
  }
  const variantIds = new Set<string>();
  for (const v of p.variants) {
    if (!v || typeof v.id !== 'string' || !v.id || !isStringList(v.executionIds) || variantIds.has(v.id)
      || v.executionIds.some((id) => !executionIds.has(id))) {
      throw new Error('Execution partition contains an invalid variant.');
    }
    variantIds.add(v.id);
  }
  for (const e of p.executions) if (!variantIds.has(e.variantId)) {
    throw new Error('Every execution partition execution must belong to a declared variant.');
  }
  return p as ObjectCentricExecutionPartition;
}

function mint(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Pure construction for the one narrowly-authorized sandbox publish path. */
export function buildExecutionPartitionArtifact(input: {
  source: Artifact;
  payload: unknown;
  name?: string;
  provider: string;
}): { artifact: Artifact; execution: ActionExecution } {
  if (input.source.type !== 'ObjectCentricEventLog') throw new Error('Execution partitions can only be derived from an object-centric event log.');
  const payload = requireExecutionPartition(input.payload, input.source.id);
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  const id = mint('a');
  const startedAt = new Date().toISOString();
  const execution: ActionExecution = {
    id: mint('x'), actionId: `${input.provider}.publishExecutionPartition`, actionVersion: '1',
    inputs: { source: [input.source.id] }, outputs: [id],
    params: { extraction: payload.extraction, schemaVersion: payload.schemaVersion },
    startedAt, durationMs: 0, runtime: { kind: 'core', version: 'plugin-view-bridge/1' },
  };
  return {
    artifact: {
      id, name: input.name?.trim() || `Execution partition · ${input.source.name}`,
      type: EXECUTION_PARTITION_TYPE, createdAt: startedAt, storage: bytes > EXECUTION_PARTITION_INLINE_LIMIT ? { kind: 'json', path: '' } : { kind: 'inline', value: payload },
      meta: { executionCount: payload.executions.length, variantCount: payload.variants.length, extraction: payload.extraction, materialized: bytes > EXECUTION_PARTITION_INLINE_LIMIT },
      producedBy: execution.id, inputs: [input.source.id],
    }, execution,
  };
}
