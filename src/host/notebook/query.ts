/**
 * Translates a notebook's structured, semantic data request
 * (`{ artifactId, op, columns, limit }`) into an actual SQL statement
 * against the artifact's logical tables — the one place a physical table
 * name is ever written for the notebook feature. Python never sees this;
 * it only ever names an `op`. See docs/python-notebook.md,
 * "Python↔Promenade bridge".
 *
 * Built on the same logical-relation vocabulary the Promenade Relational
 * API already defines (`host/relational/schemas.ts`) — not a second,
 * competing schema.
 */

import type { Artifact } from '../artifact/types.ts';
import { tableOf } from '../artifact/tables.ts';
import { LOGICAL_SCHEMAS, PHYSICAL_LOGICAL_NAME } from '../relational/schemas.ts';
import type { QueryDataRequest } from './bridge.ts';

const DEFAULT_LIMIT = 10_000;
const MAX_LIMIT = 200_000;

function physicalTable(artifact: Artifact, relation: string): string {
  const map = PHYSICAL_LOGICAL_NAME[artifact.type];
  const physical = map?.[relation];
  if (!physical) throw new Error(`'${relation}' is not available on a ${artifact.type}`);
  return tableOf(artifact.id, physical);
}

function safeLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

function selectList(artifact: Artifact, relation: string, columns?: string[]): string {
  const allowed = LOGICAL_SCHEMAS[artifact.type]?.relations
    .find((r) => r.name === relation)?.columns.map((c) => c.name) ?? [];
  if (!columns || !columns.length) return '*';
  const safe = columns.filter((c) => allowed.includes(c));
  return safe.length ? safe.map((c) => `"${c}"`).join(', ') : '*';
}

/** Builds the SQL text for one structured query request. Throws for an unsupported op/type pair. */
export function buildQuerySql(artifact: Artifact, req: QueryDataRequest): string {
  const limit = safeLimit(req.limit);
  const isOcel = artifact.type === 'ObjectCentricEventLog';
  const isXes = artifact.type === 'TraditionalEventLog';

  switch (req.op) {
    case 'events': {
      const cols = selectList(artifact, 'events', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'events')} LIMIT ${limit}`;
    }
    case 'cases': {
      if (!isXes) throw new Error(`cases() is only available on a TraditionalEventLog`);
      const cols = selectList(artifact, 'cases', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'cases')} LIMIT ${limit}`;
    }
    case 'variants': {
      if (!isXes) throw new Error(`variants() is only available on a TraditionalEventLog`);
      const events = physicalTable(artifact, 'events');
      return `WITH seq AS (
        SELECT trace_idx, string_agg(activity, ' -> ' ORDER BY ts) AS variant
        FROM ${events} GROUP BY trace_idx
      )
      SELECT variant, COUNT(*) AS n_cases FROM seq GROUP BY variant ORDER BY n_cases DESC LIMIT ${limit}`;
    }
    case 'activities': {
      const events = physicalTable(artifact, 'events');
      return `SELECT activity, COUNT(*) AS n FROM ${events} GROUP BY activity ORDER BY n DESC LIMIT ${limit}`;
    }
    case 'attributes': {
      if (!isXes) throw new Error(`attributes() is only available on a TraditionalEventLog`);
      const attrs = physicalTable(artifact, 'event_attributes');
      return `SELECT key, type, COUNT(*) AS n, COUNT(DISTINCT value) AS n_distinct
        FROM ${attrs} GROUP BY key, type ORDER BY n DESC LIMIT ${limit}`;
    }
    case 'objects': {
      if (!isOcel) throw new Error(`objects() is only available on an ObjectCentricEventLog`);
      const cols = selectList(artifact, 'objects', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'objects')} LIMIT ${limit}`;
    }
    case 'e2o': {
      if (!isOcel) throw new Error(`e2o() is only available on an ObjectCentricEventLog`);
      const cols = selectList(artifact, 'event_object', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'event_object')} LIMIT ${limit}`;
    }
    case 'o2o': {
      if (!isOcel) throw new Error(`o2o() is only available on an ObjectCentricEventLog`);
      const cols = selectList(artifact, 'object_object', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'object_object')} LIMIT ${limit}`;
    }
    case 'event_attributes': {
      if (!isOcel) throw new Error(`event_attributes() is only available on an ObjectCentricEventLog`);
      const cols = selectList(artifact, 'event_attributes', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'event_attributes')} LIMIT ${limit}`;
    }
    case 'object_attributes': {
      if (!isOcel) throw new Error(`object_attributes() is only available on an ObjectCentricEventLog`);
      const cols = selectList(artifact, 'object_attributes', req.columns);
      return `SELECT ${cols} FROM ${physicalTable(artifact, 'object_attributes')} LIMIT ${limit}`;
    }
    default:
      throw new Error(`unsupported query op '${(req as QueryDataRequest).op}'`);
  }
}
