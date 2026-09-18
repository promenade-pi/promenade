/**
 * Promenade Compute engine registry.
 *
 * Engines are configured app-wide, not per-workspace — this matches
 * `WorkspaceSwitcher.tsx`'s existing doc comment that "plugins and Promenade
 * Compute settings stay global" (`docs/promenade-compute.md` §4.1). Stage 1
 * only implements `kind: 'local-docker'` in spirit (a URL you point at your
 * own `docker run`); there is no bootstrap helper, and "local-docker" vs
 * "remote" are otherwise the identical protocol, so both are just an
 * `endpoint` here.
 */

const STORAGE_KEY = 'promenade.computeEngines';

export interface EngineCapabilities {
  wasmTargets: string[];
  pyodideEquivalent: boolean;
  maxMemoryMb: number;
  threads: number;
  dataSources: string[];
}

export interface ComputeEngine {
  id: string;
  name: string;
  endpoint: string; // http(s) base URL, no trailing slash
  status: 'unknown' | 'reachable' | 'unreachable';
  capabilities?: EngineCapabilities;
  lastSeen?: string;
  lastError?: string;
}

function newId(): string {
  return `eng_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeEndpoint(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function listEngines(): ComputeEngine[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(engines: ComputeEngine[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(engines));
}

export function addEngine(name: string, endpoint: string): ComputeEngine {
  const engines = listEngines();
  const engine: ComputeEngine = { id: newId(), name: name.trim() || 'Promenade Compute', endpoint: normalizeEndpoint(endpoint), status: 'unknown' };
  save([...engines, engine]);
  return engine;
}

export function removeEngine(id: string) {
  save(listEngines().filter((e) => e.id !== id));
}

export function getEngine(id: string): ComputeEngine | undefined {
  return listEngines().find((e) => e.id === id);
}

function updateEngine(id: string, patch: Partial<ComputeEngine>) {
  const engines = listEngines();
  const idx = engines.findIndex((e) => e.id === id);
  if (idx === -1) return;
  engines[idx] = { ...engines[idx], ...patch };
  save(engines);
}

/**
 * `GET /health` + `GET /capabilities`, per `docs/promenade-compute.md` §4.3.
 * Used both by the "Test Connection" button (before an engine is saved) and
 * to refresh a saved engine's status popover row.
 */
export async function testConnection(endpoint: string): Promise<
  { ok: true; capabilities: EngineCapabilities } | { ok: false; error: string }
> {
  const base = normalizeEndpoint(endpoint);
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    if (!health.ok) return { ok: false, error: `/health returned ${health.status}` };
    const caps = await fetch(`${base}/capabilities`, { signal: AbortSignal.timeout(4000) });
    if (!caps.ok) return { ok: false, error: `/capabilities returned ${caps.status}` };
    const capabilities = await caps.json();
    return { ok: true, capabilities };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'TimeoutError' ? 'timed out reaching the engine' : String(e?.message || e) };
  }
}

export async function refreshEngine(id: string): Promise<ComputeEngine | undefined> {
  const engine = getEngine(id);
  if (!engine) return undefined;
  const result = await testConnection(engine.endpoint);
  if (result.ok) {
    updateEngine(id, { status: 'reachable', capabilities: result.capabilities, lastSeen: new Date().toISOString(), lastError: undefined });
  } else {
    const error: string = result.ok === false ? result.error : 'unknown error';
    updateEngine(id, { status: 'unreachable', lastError: error });
  }
  return getEngine(id);
}
