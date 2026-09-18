import * as arrow from 'apache-arrow';
import { dataClient } from '../data/client';
import type { RelationalInputBinding, RelationalExecutionResult } from './types.ts';
import type { ParamTypeSchema } from './paramBinding.ts';

/**
 * The public Promenade Relational API — what a `runtime: 'relational'`
 * action's context actually calls. This is the top of the stack described in
 * the architecture doc:
 *
 *   Plugin / Action
 *        v
 *   Promenade Relational API        <- this module
 *        v
 *   Relational execution plan / SQL profile   (compileProgram.ts, sqlProfile.ts)
 *        v
 *   DuckDB-Wasm adapter              (worker/data-worker.ts's `relational` command)
 *
 * Nothing below this module is reachable from here except through
 * `dataClient.relational()` — no DuckDB handle, no OPFS path, no physical
 * table name ever crosses this boundary.
 */

export interface RelationalRequest {
  /** Logical role -> bound artifact, e.g. `{ role: 'log', artifactId: 'a_abc123' }`. */
  inputs: Array<{ role: string; artifactId: string }>;
  params: Record<string, unknown>;
  /** SQL Profile v1 program text (`-- @relation`/`-- @output` marked statements). */
  programSource: string;
  /** The action manifest's declared parameter schema — required so `:param` binding can validate types. */
  declaredParams: Record<string, ParamTypeSchema>;
  /** Named intermediate relations to materialise and return, beyond the program's own outputs. */
  requestedRelations?: string[];
}

export interface RelationalResult {
  outputs: Record<string, arrow.Table>;
  relations: Record<string, arrow.Table>;
  stats: RelationalExecutionResult['stats'];
  backend: RelationalExecutionResult['backend'];
}

function tablesOf(bytesByName: Record<string, Uint8Array>): Record<string, arrow.Table> {
  const out: Record<string, arrow.Table> = {};
  for (const [name, bytes] of Object.entries(bytesByName)) out[name] = arrow.tableFromIPC(bytes);
  return out;
}

/**
 * Executes a relational program and returns its named outputs (always) and
 * requested intermediate relations (if any) as Arrow tables.
 *
 * This is the only function a `relational` action needs: it never sees an
 * artifact's physical storage, only the logical `role.relation` names it
 * declared in `inputs`.
 */
export async function executeRelational(request: RelationalRequest): Promise<RelationalResult> {
  const raw = await dataClient.relational(request);
  return {
    outputs: tablesOf(raw.outputs),
    relations: tablesOf(raw.relations),
    stats: raw.stats as RelationalExecutionResult['stats'],
    backend: raw.backend,
  };
}

export type { RelationalInputBinding };

/**
 * SHA-256 of a program's source text, hex-encoded — recorded on
 * `ActionExecution.programDigest` so two runs of the same action can be told
 * apart even when neither `actionVersion` nor `params` changed (a packaged
 * `.sql` file edited without a version bump). Uses Web Crypto, available in
 * both the main thread and workers, so no extra dependency is needed for
 * something this small.
 */
export async function digestProgram(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
