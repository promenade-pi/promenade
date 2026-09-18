/**
 * Pyodide execution class.
 *
 * The second runtime, alongside WASM. It exists because pm4py is the de-facto
 * standard of the research community: a researcher writing discovery code
 * writes Python, and answering that with "install the Rust toolchain" excludes
 * exactly the audience this is for.
 *
 * Verified before building: pm4py 2.7.23.4 imports and runs under Pyodide
 * 314.0.3, including the inductive miner and alignments. cvxopt is a declared
 * but not actual dependency — which is why dependencies are installed from an
 * explicit list with deps=False rather than by resolving package metadata.
 *
 * Lifecycle notes:
 *  - Pyodide is loaded lazily (tens of MB, seconds on first use, cached after).
 *  - Reloading plugin code means discarding the worker, not importlib.reload.
 *  - Data reaches Python only through host.sql(), same as every other runtime.
 */

import {
  PN_CONVERTERS_PY, installMissingDeps, loadPyodideRuntime,
} from './pyodide-shared';

let pyodide: any = null;
let loading: Promise<any> | null = null;
const installed = new Set<string>();

const post = (msg: unknown, transfer: Transferable[] = []) =>
  (self as any).postMessage(msg, transfer);

const progress = (fraction: number, message?: string, data?: unknown) =>
  post({ type: 'progress', fraction, message, data });

let sqlSeq = 0;
const sqlWaiting = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

/** Arrow IPC bytes from the host; Python turns them into a DataFrame. */
function sqlIpc(text: string): Promise<Uint8Array> {
  const id = ++sqlSeq;
  return new Promise((resolve, reject) => {
    sqlWaiting.set(id, { resolve, reject });
    post({ type: 'sql', id, text });
  });
}

/**
 * The Python-facing API.
 *
 * Deliberately pm4py-shaped: `ctx.sql()` hands back a pandas DataFrame,
 * because that is what a process-mining researcher already knows how to use.
 * Underneath it is the same single data door as every other runtime — there is
 * no file access and no artifact deserialisation.
 */
const PM_PLUGIN = `
import json
import pandas as pd
import pyarrow as pa

class _Ctx:
    """Host services available to a Promenade Python plugin."""

    def __init__(self, tables, params, input_json=None, inputs_json=None, input_ids_json=None, meta_json=None):
        self._tables = dict(tables or {})
        self._meta_json = meta_json
        self.params = dict(params or {})
        self._input_json = input_json
        self._inputs_json = inputs_json
        self._input_ids_json = input_ids_json

    @property
    def input(self):
        """Payload of the input artifact, for actions that do not read tables.

        A process tree is not table data, so there is nothing for 'ctx.sql()'
        to query. 'ctx.sql()' remains the only door to the *log*; this is the
        door to an artifact another plugin produced, in exactly the shape that
        plugin returned it.
        """
        if self._input_json is None:
            return None
        return json.loads(self._input_json)

    @property
    def inputs(self):
        """Ordered payloads for all declared action input slots.

        ctx.input is deliberately retained for one-input plugins.  A
        multi-input analysis should instead use e.g.
        ctx.inputs["baseline"][0] and ctx.inputs["candidate"][0].
        """
        if self._inputs_json is None:
            return {}
        return json.loads(self._inputs_json)

    @property
    def input_ids(self):
        """Stable artifact ids for all declared input slots.

        This is deliberately separate from inputs: a producer can bind
        its result to exact provenance ids without trusting an id embedded in
        another plugin's payload.
        """
        if self._input_ids_json is None:
            return {}
        return json.loads(self._input_ids_json)

    def table(self, logical):
        """Physical view name for one of the artifact's logical tables.

        The primary input's tables are addressed by their bare logical name
        ('event', 'object', ...). A multi-input action also gets every declared
        slot's tables under a namespaced key '<slot>__<logical>' (e.g.
        'candidate__event') — the only way to reach a second log, since a log
        carries no inline payload and its ctx.inputs entry is None.
        """
        return self._tables[logical]

    @property
    def tables(self):
        return dict(self._tables)

    @property
    def meta(self):
        """What the catalog records *about* each input, by role.

        'ctx.sql()' reads an artifact's rows and 'ctx.inputs' its inline
        payload; neither can reach facts that exist only in the catalog. The
        entry for each artifact is its own metadata plus 'storageKind' and,
        for a derived log, 'transformOps' — the active operations of its
        plan. A plugin that needs to know how a log came to be, rather than
        only what is in it, reads it here.

        Shaped like 'ctx.inputs': role -> list, one entry per bound artifact.
        """
        if self._meta_json is None:
            return {}
        return json.loads(self._meta_json)

    async def sql(self, query):
        """Runs SQL on the host and returns a pandas DataFrame.

        Awaitable, because the query crosses a worker boundary and the browser
        offers no synchronous way back without SharedArrayBuffer — which would
        drag in COOP/COEP, and Milestone 0 established that the data path is
        better off without those headers.

        This is the only way to data. A plugin that iterates over events
        instead of asking for an aggregate is written wrong.
        """
        # Table names and parameters share the format namespace, so a query can
        # say LIMIT {maxEvents} without the plugin building SQL by hand. A
        # two-input action reaches its second log through the namespaced
        # placeholders: "SELECT ... FROM {candidate__event}".
        query = query.format(**{**self._tables, **self.params})
        buf = await _host_sql(query)
        reader = pa.ipc.open_stream(pa.py_buffer(buf.to_py()))
        return reader.read_all().to_pandas()

    def log(self, message):
        _host_log(str(message))

    def progress(self, fraction, message="", data=None):
        """Reports progress. The optional data argument, when given, is
        JSON-serialised and delivered to a live-preview view of this action's
        output type as a structured frame batch while the run is still going."""
        _host_progress(
            float(fraction), str(message),
            None if data is None else json.dumps(data),
        )

` + PN_CONVERTERS_PY;

async function ensurePyodide(deps: string[] = []) {
  const coldRuntime = !pyodide;
  const setupStarted = performance.now();
  let runtimeMs = 0;
  let dependencyMs = 0;
  let bridgeMs = 0;
  const missingAtStart = deps.filter((d) => !installed.has(d));
  if (!pyodide) {
    const started = performance.now();
    loading ??= loadPyodideRuntime(progress);
    pyodide = await loading;
    runtimeMs = performance.now() - started;

    // The bridge Python calls back through. Nothing else from the host is
    // reachable from Python.
    pyodide.globals.set('_host_sql', async (q: string) => sqlIpc(q));
    pyodide.globals.set('_host_log', (m: string) => post({ type: 'log', message: m }));
    pyodide.globals.set('_host_progress', (f: number, m: string, dataJson?: string) =>
      progress(f, m, dataJson ? JSON.parse(dataJson) : undefined));
  }

  {
    const started = performance.now();
    const before = installed.size;
    try {
      await installMissingDeps(pyodide, installed, deps, progress);
    } catch (e: any) {
      post({ type: 'log', message: `install failed: ${e.message}` });
      throw e;
    }
    if (installed.size !== before) dependencyMs += performance.now() - started;
  }

  // pyarrow is always needed: it is how SQL results become DataFrames.
  if (!installed.has('pyarrow')) {
    const started = performance.now();
    await pyodide.loadPackage(['pyarrow', 'pandas']);
    installed.add('pyarrow');
    dependencyMs += performance.now() - started;
  }
  // The module gets its own namespace, so the host bridge has to be seeded
  // into it explicitly — globals set on the interpreter are not visible inside
  // an exec'd module dict.
  const bridgeStarted = performance.now();
  await pyodide.runPythonAsync(`
import sys, types
if "pm_plugin" not in sys.modules:
    _m = types.ModuleType("pm_plugin")
    _m.__dict__["_host_sql"] = _host_sql
    _m.__dict__["_host_log"] = _host_log
    _m.__dict__["_host_progress"] = _host_progress
    exec(${JSON.stringify(PM_PLUGIN)}, _m.__dict__)
    sys.modules["pm_plugin"] = _m
`);
  bridgeMs = performance.now() - bridgeStarted;
  return {
    py: pyodide,
    timing: {
      setupMs: performance.now() - setupStarted,
      runtimeMs,
      dependencyMs,
      bridgeMs,
      coldRuntime,
      installed: missingAtStart,
    },
  };
}

/** Cached prepared state for the two-stage contract. */
let prepared: { key: string } | null = null;
/**
 * Source last exec'd into `_promenade_plugin`.
 *
 * Kept outside Python: `sys.modules.get("_promenade_plugin") is None` used to
 * be the reload guard, which is wrong the moment a *second* plugin runs in
 * the same worker — the module is no longer `None`, so its stale functions
 * (from the first plugin's source, possibly under a different entry point)
 * kept getting called for every plugin after the first.
 */
let loadedSource: string | null = null;

const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  /** Reports the runtime's identity, which provenance records. */
  async version() {
    const { py } = await ensurePyodide([]);
    const v = await py.runPythonAsync(`
import sys
f"Python {sys.version.split()[0]}"
`);
    return { pyodide: py.version, python: String(v) };
  },

  /**
   * Runs a packaged Python plugin.
   *
   * The module defines `prepare(ctx)` and `finalize(prepared, params, ctx)`;
   * the expensive stage is cached exactly as for WASM kernels.
   *
   * A manifest action may name an `entryPoint`, which selects
   * `prepare_<x>` / `finalize_<x>` instead. That is how one module serves
   * several actions — the Inductive Miner package ships discovery and a
   * process-tree-to-Petri-net conversion — without inventing a dispatch table
   * of its own, and without the host having to load two modules.
   */
  async run({ source, deps, tables, params, prepareKey, entryPoint, inputValue, inputValues, inputArtifactIds, inputMeta }) {
    const { py, timing: setupTiming } = await ensurePyodide(deps ?? []);
    const t0 = performance.now();

    py.globals.set('_tables', py.toPy(tables));
    py.globals.set('_params', py.toPy(params));
    // Passed as JSON rather than as a converted object graph: the payload is a
    // plugin's artifact contract, and it should reach Python looking exactly
    // like what the producing plugin returned.
    py.globals.set('_input_json', inputValue == null ? null : JSON.stringify(inputValue));
    py.globals.set('_inputs_json', JSON.stringify(inputValues ?? {}));
    py.globals.set('_input_ids_json', JSON.stringify(inputArtifactIds ?? {}));
    py.globals.set('_meta_json', JSON.stringify(inputMeta ?? {}));
    py.globals.set('_entry', entryPoint ?? null);

    const sourceStarted = performance.now();
    let sourceReloaded = false;
    if (loadedSource !== source) {
      await py.runPythonAsync(`
import sys, types
_mod = types.ModuleType("_promenade_plugin")
exec(${JSON.stringify(source)}, _mod.__dict__)
sys.modules["_promenade_plugin"] = _mod
`);
      loadedSource = source;
      sourceReloaded = true;
      // A reloaded module invalidates whatever the old one prepared — its
      // functions may be entirely different, entry point or not.
      prepared = null;
    }
    const sourceMs = performance.now() - sourceStarted;

    let reused = true;
    if (!prepared || prepared.key !== prepareKey) {
      reused = false;
      progress(0.55, 'running prepare()');
      await py.runPythonAsync(`
import inspect, pm_plugin, sys
_ctx = pm_plugin._Ctx(_tables, _params, _input_json, _inputs_json, _input_ids_json, _meta_json)
_mod = sys.modules["_promenade_plugin"]
_fn = getattr(_mod, "prepare_" + _entry) if _entry else getattr(_mod, "prepare")
_prepared = _fn(_ctx)
if inspect.isawaitable(_prepared):
    _prepared = await _prepared
`);
      prepared = { key: prepareKey };
    }
    const prepareMs = performance.now() - t0;

    const t1 = performance.now();
    progress(0.9, 'running finalize()');
    const out = await py.runPythonAsync(`
import inspect, json, pm_plugin, sys
_ctx = pm_plugin._Ctx(_tables, _params, _input_json, _inputs_json, _input_ids_json, _meta_json)
_mod = sys.modules["_promenade_plugin"]
_fn = getattr(_mod, "finalize_" + _entry) if _entry else getattr(_mod, "finalize")
_out = _fn(_prepared, _params, _ctx)
if inspect.isawaitable(_out):
    _out = await _out
json.dumps(_out)
`);
    const finalizeMs = performance.now() - t1;

    return {
      result: JSON.parse(String(out)),
      timing: { prepareMs, finalizeMs, reused, sourceMs, sourceReloaded, ...setupTiming },
    };
  },

  async dispose() {
    prepared = null;
    return { disposed: true };
  },
};

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'sqlResult') {
    const w = sqlWaiting.get(m.id);
    if (!w) return;
    sqlWaiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m.ipc);
    return;
  }
  const { id, cmd, args } = m;
  try {
    const h = HANDLERS[cmd];
    if (!h) throw new Error(`unknown cmd ${cmd}`);
    post({ type: 'result', id, payload: await h(args || {}) });
  } catch (err: any) {
    post({ type: 'error', id, error: String(err?.message || err) });
  }
};
