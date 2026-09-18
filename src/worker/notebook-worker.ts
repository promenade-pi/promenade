/**
 * Notebook kernel worker.
 *
 * A second Pyodide *instance*, not a second Pyodide *architecture* — it
 * shares `pyodide-shared.ts` (runtime loader, `deps=False` install routine,
 * pm4py<->artifact converters) with the action worker (`pyodide-worker.ts`).
 * Separate Worker/interpreter so a notebook's variables can never leak into
 * an unrelated packaged-plugin execution, and vice versa.
 *
 * Unlike the action worker, this worker keeps one persistent Python
 * namespace (`_notebook_globals`) across every `execute` call for the life
 * of the worker — cell 2 can see cell 1's variables — and never re-execs a
 * fresh module per call. `restart` (browser-pyodide-kernel.ts) is a full
 * worker termination + a fresh one, exactly like the action runtime's abort
 * policy: Pyodide has no preemption, so a clean interpreter is the only way
 * back to a known state.
 *
 * See docs/python-notebook.md for the `promenade` module contract and the
 * bridge protocol this worker speaks to the host.
 */

import { PM4PY_DEPS, PN_CONVERTERS_PY, installMissingDeps, loadPyodideRuntime } from './pyodide-shared';

let pyodide: any = null;
let loading: Promise<any> | null = null;
const installed = new Set<string>();

const post = (msg: unknown, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);
const progress = (fraction: number, message?: string) => post({ type: 'progress', fraction, message });

let bridgeSeq = 0;
const bridgeWaiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

/** JSON-in/JSON-out bridge call: every op except the Arrow-returning query. */
function bridgeJson(op: string, argsJson: string): Promise<string> {
  const id = ++bridgeSeq;
  const args = JSON.parse(argsJson);
  return new Promise((resolve, reject) => {
    bridgeWaiting.set(id, { resolve, reject });
    post({ type: 'bridge', id, request: { op, ...args } });
  });
}

/** The one bridge op that returns tabular data, as Arrow IPC bytes. */
function bridgeQuery(argsJson: string): Promise<Uint8Array> {
  const id = ++bridgeSeq;
  const request = JSON.parse(argsJson);
  return new Promise((resolve, reject) => {
    bridgeWaiting.set(id, { resolve, reject });
    post({ type: 'bridge', id, request: { op: 'queryArtifactData', request } });
  });
}

/**
 * The one bridge op that sends tabular data *to* the host: `publish_event_log()`
 * / `publish_ocel()` hand over one Arrow table per physical relation
 * (`event`, `trace`, `object`, …). `relations` arrives as a genuine plain JS
 * object of `Uint8Array`s — the Python side builds it with
 * `pyodide.ffi.to_js(..., dict_converter=js.Object.fromEntries)` rather than
 * relying on the default dict->Map conversion, so there is no Map-vs-object
 * branching to get wrong here. Each buffer is copied before being added to
 * the transfer list: a `to_js`-converted `Uint8Array` is a fresh copy, not a
 * live view into Pyodide's WASM heap, but copying defensively costs nothing
 * next to a Parquet write and removes any doubt about it.
 */
function bridgePublishLog(metaJson: string, relations: Record<string, Uint8Array>): Promise<string> {
  const id = ++bridgeSeq;
  const meta = JSON.parse(metaJson);
  const relObj: Record<string, Uint8Array> = {};
  const transfer: Transferable[] = [];
  for (const [k, v] of Object.entries(relations)) {
    const bytes = new Uint8Array(v);
    relObj[k] = bytes;
    transfer.push(bytes.buffer);
  }
  return new Promise((resolve, reject) => {
    bridgeWaiting.set(id, { resolve, reject });
    post({ type: 'bridge', id, request: { op: 'publishEventLog', ...meta, relations: relObj } }, transfer);
  });
}

/**
 * The `promenade` Python module: artifact/log handles, the semantic data
 * accessors, and the `publish()` converter registry. Exec'd into
 * `sys.modules['promenade']`, never installed from PyPI — the same
 * technique `pm_plugin` already uses for the action runtime. Concatenated
 * with `PN_CONVERTERS_PY` so `petri_net()`/`process_tree()` are plain
 * top-level names `publish()`'s converters can call directly.
 */
const PROMENADE_MODULE_PY = `
import json
import sys


class PromenadeError(Exception):
    pass


class _StreamWriter:
    """Redirect target for sys.stdout/sys.stderr during a cell run.

    Posts each write immediately rather than buffering to end of cell, so a
    long-running cell's print() output appears incrementally.
    """

    def __init__(self, name):
        self.name = name

    def write(self, s):
        if s:
            _host_stream(self.name, s)
        return len(s)

    def flush(self):
        pass


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_MAX_ROWS = 50
_MAX_COLS = 20


def _dataframe_bundle(df):
    import pandas as pd
    if isinstance(df, pd.Series):
        df = df.to_frame(name=df.name or "value")
    total_rows, total_cols = df.shape
    view = df.iloc[:_MAX_ROWS, :_MAX_COLS]
    safe = view.astype(object).where(pd.notnull(view), None)
    return {
        "application/vnd.promenade.dataframe+json": json.dumps({
            "columns": [str(c) for c in view.columns],
            "rows": safe.values.tolist(),
            "totalRows": int(total_rows),
            "totalCols": int(total_cols),
            "shownRows": len(view),
            "shownCols": len(view.columns),
        }, default=str),
        "text/plain": df.to_string(max_rows=_MAX_ROWS, max_cols=_MAX_COLS),
    }


def _figure_bundle(fig):
    import io
    import base64
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    buf.seek(0)
    data = base64.b64encode(buf.read()).decode("ascii")
    w, h = fig.get_size_inches()
    return {"image/png": data, "text/plain": f"<Figure {w:.1f}x{h:.1f} inches>"}


def _mimebundle(value):
    try:
        import pandas as pd
        if isinstance(value, (pd.DataFrame, pd.Series)):
            return _dataframe_bundle(value)
    except ImportError:
        pass
    try:
        import matplotlib.figure
        import matplotlib.axes
        if isinstance(value, matplotlib.figure.Figure):
            return _figure_bundle(value)
        if isinstance(value, matplotlib.axes.Axes):
            return _figure_bundle(value.get_figure())
    except ImportError:
        pass
    if hasattr(value, "_repr_mimebundle_"):
        try:
            bundle = value._repr_mimebundle_()
            if bundle:
                return bundle
        except Exception:
            pass
    if isinstance(value, (dict, list)):
        try:
            return {"application/json": json.dumps(value, default=str), "text/plain": repr(value)}
        except TypeError:
            pass
    return {"text/plain": repr(value)}


class ArtifactHandle:
    """A reference to a Promenade artifact -- never a copy of its data."""

    def __init__(self, id, name, type, meta=None, inputs=None, payload=None):
        self.id = id
        self.name = name
        self.type = type
        self.meta = dict(meta or {})
        self.inputs = list(inputs or [])
        self._payload = payload

    @property
    def payload(self):
        """The artifact's own JSON payload, when small enough to hand over
        inline (models like a Petri net) -- never populated for logs."""
        return self._payload

    def __repr__(self):
        return f"{self.type}(id={self.id!r}, name={self.name!r})"


async def _query(artifact_id, op, columns=None, limit=None):
    import pyarrow as pa
    args = {"artifactId": artifact_id, "op": op}
    if columns is not None:
        args["columns"] = list(columns)
    if limit is not None:
        args["limit"] = int(limit)
    buf = await _bridge_query(json.dumps(args))
    reader = pa.ipc.open_stream(pa.py_buffer(buf.to_py()))
    return reader.read_all().to_pandas()


class LogHandle(ArtifactHandle):
    """Base for TraditionalEventLogHandle / ObjectCentricEventLogHandle.

    Every accessor queries Promenade's data layer on demand through a
    structured, semantic bridge op -- never a raw SQL string, never a
    physical table name. Awaitable, like every other cross-worker data
    access in Promenade ('await log.events()', matching 'await ctx.sql()' in
    the existing Python scratchpad) -- there is no synchronous path across a
    Worker boundary without SharedArrayBuffer, which Promenade's data path
    deliberately does not use.
    """

    def events(self, columns=None, limit=None):
        return _query(self.id, "events", columns, limit)

    def to_pandas(self):
        """Alias for readers used to 'df = handle.to_pandas()'."""
        return self.events()


class TraditionalEventLogHandle(LogHandle):
    def cases(self, columns=None, limit=None):
        return _query(self.id, "cases", columns, limit)

    def variants(self, limit=None):
        return _query(self.id, "variants", None, limit)

    def activities(self, limit=None):
        return _query(self.id, "activities", None, limit)

    def attributes(self, limit=None):
        return _query(self.id, "attributes", None, limit)

    async def to_pm4py(self, limit=None):
        """PM4Py-shaped DataFrame -- an interoperability convenience, not a
        second canonical representation of the log."""
        df = await self.events(columns=["trace_idx", "activity", "ts"], limit=limit or 100_000)
        return df.rename(columns={
            "trace_idx": "case:concept:name",
            "activity": "concept:name",
            "ts": "time:timestamp",
        })

    def __repr__(self):
        m = self.meta
        return (f"TraditionalEventLog(name={self.name!r}, "
                f"events={m.get('events', '?')}, cases={m.get('cases', '?')}, "
                f"activities={m.get('activities', '?')})")


class ObjectCentricEventLogHandle(LogHandle):
    def objects(self, columns=None, limit=None):
        return _query(self.id, "objects", columns, limit)

    def e2o(self, columns=None, limit=None):
        return _query(self.id, "e2o", columns, limit)

    def o2o(self, columns=None, limit=None):
        return _query(self.id, "o2o", columns, limit)

    def event_attributes(self, limit=None):
        return _query(self.id, "event_attributes", None, limit)

    def object_attributes(self, limit=None):
        return _query(self.id, "object_attributes", None, limit)

    def __repr__(self):
        m = self.meta
        return (f"ObjectCentricEventLog(name={self.name!r}, "
                f"events={m.get('events', '?')}, objects={m.get('objects', '?')})")


class PublishedArtifact:
    def __init__(self, id, name, type, summary):
        self.id = id
        self.name = name
        self.type = type
        self.summary = summary

    def open(self):
        return open_artifact(self.id)

    def _repr_mimebundle_(self):
        return {
            "text/plain": repr(self),
            "application/vnd.promenade.published+json": json.dumps({
                "id": self.id, "name": self.name, "type": self.type, "summary": self.summary,
            }),
        }

    def __repr__(self):
        return f"PublishedArtifact(id={self.id!r}, name={self.name!r}, type={self.type!r})"


def _handle_of(meta):
    if meta is None:
        return None
    cls = {
        "TraditionalEventLog": TraditionalEventLogHandle,
        "ObjectCentricEventLog": ObjectCentricEventLogHandle,
    }.get(meta["type"], ArtifactHandle)
    return cls(meta["id"], meta["name"], meta["type"], meta.get("meta"), meta.get("inputs"), meta.get("payload"))


async def current_artifact():
    payload = await _bridge_json("getCurrentArtifactMetadata", "{}")
    return _handle_of(json.loads(payload))


async def inputs():
    a = await current_artifact()
    return [a] if a is not None else []


async def artifacts():
    payload = await _bridge_json("listArtifacts", "{}")
    return json.loads(payload)


async def get_artifact(id_or_name):
    payload = await _bridge_json("getArtifact", json.dumps({"idOrName": id_or_name}))
    return _handle_of(json.loads(payload))


async def open_artifact(id_or_handle):
    aid = id_or_handle.id if hasattr(id_or_handle, "id") else id_or_handle
    await _bridge_json("openArtifact", json.dumps({"id": aid}))


async def focus_artifact(id_or_handle):
    aid = id_or_handle.id if hasattr(id_or_handle, "id") else id_or_handle
    await _bridge_json("focusArtifactInTree", json.dumps({"id": aid}))


_display_queue = []


def display(value):
    """Rich display, like IPython.display.display -- queues immediately;
    flushed to the host at the end of the current cell's run."""
    _display_queue.append(value)


# --- publish() converter registry -------------------------------------

_converters = []


def register_converter(type_id, predicate, to_payload, summarize=None):
    _converters.append((type_id, predicate, to_payload, summarize))


def _is_petri_tuple(value):
    if isinstance(value, tuple) and len(value) == 3:
        net = value[0]
        return hasattr(net, "places") and hasattr(net, "transitions") and hasattr(net, "arcs")
    return False


def _petri_tuple_payload(value):
    net, im, fm = value
    return petri_net(net, im, fm)


def _petri_tuple_summary(payload):
    s = payload["stats"]
    return f"{s['places']} places · {s['transitions']} transitions"


register_converter("AcceptingPetriNet", _is_petri_tuple, _petri_tuple_payload, _petri_tuple_summary)


def _is_process_tree(value):
    return hasattr(value, "operator") and hasattr(value, "children") and not isinstance(value, tuple)


def _process_tree_payload(value):
    return process_tree(value)


def _process_tree_summary(payload):
    s = payload["stats"]
    return f"{s['nodes']} nodes · {s['operators']} operators"


register_converter("ProcessTree", _is_process_tree, _process_tree_payload, _process_tree_summary)


def _resolve_converter(value, declared_type):
    if declared_type:
        for type_id, predicate, to_payload, summarize in _converters:
            if type_id == declared_type:
                return type_id, to_payload, summarize
        known = [c[0] for c in _converters]
        raise PromenadeError(f"No converter registered for type={declared_type!r}. Known types: {known}")
    matches = [(t, p, s) for t, pred, p, s in _converters if pred(value)]
    if not matches:
        known = [c[0] for c in _converters]
        raise PromenadeError(
            f"promenade.publish() does not recognize a {type(value).__name__!r} value. "
            f"Pass type= explicitly, or convert it yourself first. Known converters: {known}")
    if len(matches) > 1:
        raise PromenadeError(
            f"Ambiguous value for promenade.publish() -- matches {[m[0] for m in matches]}. "
            f"Pass type= to disambiguate.")
    return matches[0]


def _package_versions():
    import importlib.metadata as im
    out = {}
    for name in ("pm4py", "pandas", "numpy", "scipy", "networkx", "matplotlib"):
        if name in sys.modules:
            try:
                out[name] = im.version(name)
            except Exception:
                pass
    return out


_provenance_context = {}


async def publish(value, type=None, name=None):
    if not name or not str(name).strip():
        raise PromenadeError("promenade.publish() requires name=")
    type_id, to_payload, summarize = _resolve_converter(value, type)
    try:
        payload = to_payload(value)
    except PromenadeError:
        raise
    except Exception as e:
        raise PromenadeError(f"Failed to convert value to {type_id}: {e}") from e
    summary = summarize(payload) if summarize else ""
    current = await current_artifact()
    request = {
        "type": type_id,
        "name": name,
        "payload": payload,
        "meta": {},
        "inputArtifactIds": [current.id] if current is not None else [],
        "provenance": dict(_provenance_context, packages=_package_versions()),
    }
    result_json = await _bridge_json("publishArtifact", json.dumps(request))
    result = json.loads(result_json)
    return PublishedArtifact(result["id"], result["name"], result["type"], summary or result.get("summary", ""))


def _ipc_bytes(table):
    """An Arrow table, serialised the same way \`_bridge_query\`'s response is
    deserialised elsewhere in this module -- IPC stream format, the wire
    shape \`materializeNotebookLog\` (worker/data-worker.ts) reads directly
    with \`arrow.tableFromIPC\`."""
    import pyarrow as pa
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


async def _bridge_publish_log_call(meta, relations):
    """Sends a {physical relation name: bytes} dict to the host as a plain JS
    object of Uint8Arrays -- \`to_js\` with \`dict_converter=js.Object.fromEntries\`
    converts both the dict shape *and* its bytes values in one call, so the JS
    side (\`bridgePublishLog\` in notebook-worker.ts) never has to branch on
    Map vs. plain object or convert nested values itself."""
    from pyodide.ffi import to_js
    import js
    js_relations = to_js(relations, dict_converter=js.Object.fromEntries)
    result_json = await _bridge_publish_log(json.dumps(meta), js_relations)
    return json.loads(result_json)


def _publish_log_meta(name, provenance_extra=None):
    return dict(
        name=name,
        provenance=dict(_provenance_context, packages=_package_versions(), **(provenance_extra or {})),
    )


def _xes_attr_type(series):
    """XES's attribute \`type\` string, inferred from the column's own dtype --
    the value itself is always stored as text (matching the physical
    event_attr/trace_attr schema), this is only the hint a reader casts by."""
    import pandas as pd
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_integer_dtype(series):
        return "int"
    if pd.api.types.is_float_dtype(series):
        return "float"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    return "string"


def _melt_attribute_rows(df, id_values, cols):
    """Yields (id, column name, value) for every non-null cell across \`cols\` --
    an attribute a given row doesn't have contributes no row, the same way an
    XES event that lacks some optional attribute does."""
    import pandas as pd
    for col in cols:
        for i, v in zip(id_values, df[col]):
            if v is None:
                continue
            try:
                if pd.isna(v):
                    continue
            except (TypeError, ValueError):
                pass  # not a value pd.isna can judge (e.g. a list) -- keep it
            yield i, col, v


def _xes_attribute_table(df, id_values, cols, id_col_name, id_type):
    """(id, key, type, value) -- XES's event_attr/trace_attr shape."""
    import pyarrow as pa
    col_types = {c: _xes_attr_type(df[c]) for c in cols}
    ids, keys, types, values = [], [], [], []
    for i, col, v in _melt_attribute_rows(df, id_values, cols):
        ids.append(i)
        keys.append(col)
        types.append(col_types[col])
        values.append(str(v))
    if not ids:
        return None
    return pa.table({
        id_col_name: pa.array(ids, type=id_type),
        "key": pa.array(keys),
        "type": pa.array(types),
        "value": pa.array(values),
    })


def _ocel_attribute_table(df, id_values, cols, id_col_name, with_ts):
    """(id, name, value[, ts]) -- OCEL's event_attr/object_attr shape. \`ts\`,
    when present, is always null: a one-row-per-object/event DataFrame has no
    time axis of its own, so every value published this way is recorded as
    static -- OCEL's own definition of "time-dependent" (more than one value
    over time for the same object) cannot arise from this input shape."""
    import pyarrow as pa
    ids, names, values = [], [], []
    for i, col, v in _melt_attribute_rows(df, id_values, cols):
        ids.append(i)
        names.append(col)
        values.append(str(v))
    if not ids:
        return None
    fields = {
        id_col_name: pa.array(ids, type=pa.string()),
        "name": pa.array(names),
        "value": pa.array(values),
    }
    if with_ts:
        fields["ts"] = pa.nulls(len(ids), type=pa.timestamp("us"))
    return pa.table(fields)


async def publish_event_log(df, case_id, activity, timestamp, lifecycle=None, resource=None,
                             case_attributes=None, name=None):
    """Publishes a pandas DataFrame as a real \`TraditionalEventLog\` artifact --
    real Parquet-backed storage, the same physical shape an XES import
    produces, not a copy stored inline. \`case_id\`/\`activity\`/\`timestamp\`
    name the DataFrame's own columns; \`trace_idx\` is assigned by
    \`case_id\`'s first-occurrence order, \`event_idx\` by row order.

    Every column not otherwise named becomes an event attribute (XES's
    \`event_attr\`) automatically -- nothing from the DataFrame is silently
    dropped, matching how XES import already treats non-core columns. A
    column that is actually constant per case (a customer type, a priority)
    should be named in \`case_attributes=\` instead, so it becomes one
    \`trace_attr\` row per case rather than being repeated on every one of
    that case's events; only its *first* occurrence per case is kept if it
    turns out not to be constant.
    """
    if not name or not str(name).strip():
        raise PromenadeError("promenade.publish_event_log() requires name=")
    for col, label in ((case_id, "case_id"), (activity, "activity"), (timestamp, "timestamp")):
        if col is not None and col not in df.columns:
            raise PromenadeError(f"promenade.publish_event_log(): column {col!r} ({label}) is not in the DataFrame")
    if lifecycle is not None and lifecycle not in df.columns:
        raise PromenadeError(f"promenade.publish_event_log(): lifecycle column {lifecycle!r} is not in the DataFrame")
    if resource is not None and resource not in df.columns:
        raise PromenadeError(f"promenade.publish_event_log(): resource column {resource!r} is not in the DataFrame")
    case_attributes = list(case_attributes or [])
    for col in case_attributes:
        if col not in df.columns:
            raise PromenadeError(f"promenade.publish_event_log(): case attribute column {col!r} is not in the DataFrame")

    import pandas as pd
    import pyarrow as pa

    df = df.reset_index(drop=True)
    n = len(df)
    codes, uniques = pd.factorize(df[case_id], sort=False)
    event_table = pa.table({
        "event_idx": pa.array(range(n), type=pa.int64()),
        "trace_idx": pa.array(codes.astype("int64")),
        "activity": pa.array(df[activity].astype(str)),
        "ts": pa.array(pd.to_datetime(df[timestamp], errors="coerce")),
        "lifecycle": pa.array(df[lifecycle].astype(str)) if lifecycle else pa.nulls(n, type=pa.string()),
        "resource": pa.array(df[resource].astype(str)) if resource else pa.nulls(n, type=pa.string()),
    })
    trace_table = pa.table({
        "trace_idx": pa.array(range(len(uniques)), type=pa.int64()),
        "case_id": pa.array([str(x) for x in uniques]),
    })

    core_cols = {c for c in (case_id, activity, timestamp, lifecycle, resource) if c is not None}
    event_attr_cols = [c for c in df.columns if c not in core_cols and c not in case_attributes]
    event_attr_table = _xes_attribute_table(df, range(n), event_attr_cols, "event_idx", pa.int64())

    case_attr_table = None
    if case_attributes:
        # \`codes\` is assigned in first-occurrence order by \`pd.factorize\`, so
        # the rows where a code is first seen are exactly one per case, in
        # trace_idx order -- no separate groupby needed to find them.
        first_seen = ~pd.Series(codes).duplicated()
        case_df = df.loc[first_seen, case_attributes].reset_index(drop=True)
        case_attr_table = _xes_attribute_table(case_df, range(len(uniques)), case_attributes, "trace_idx", pa.int64())

    relations = {"event": _ipc_bytes(event_table), "trace": _ipc_bytes(trace_table)}
    if event_attr_table is not None:
        relations["event_attr"] = _ipc_bytes(event_attr_table)
    if case_attr_table is not None:
        relations["trace_attr"] = _ipc_bytes(case_attr_table)

    meta = _publish_log_meta(name)
    meta["targetType"] = "TraditionalEventLog"
    current = await current_artifact()
    meta["inputArtifactIds"] = [current.id] if current is not None else []
    result = await _bridge_publish_log_call(meta, relations)
    return PublishedArtifact(result["id"], result["name"], result["type"],
                              f"{n} events \xb7 {len(uniques)} cases")


async def publish_ocel(events, objects, e2o, o2o=None, name=None):
    """Publishes three or four pandas DataFrames as a real
    \`ObjectCentricEventLog\` artifact. Expects the same column names
    \`log.events()\`/\`log.objects()\`/\`log.e2o()\`/\`log.o2o()\` already return
    (\`event_id\`/\`activity\`/\`ts\`, \`object_id\`/\`object_type\`,
    \`event_id\`/\`object_id\`[/\`qualifier\`], \`source_id\`/\`target_id\`[/\`qualifier\`])
    -- the natural shape after querying, filtering and republishing an OCEL
    log, rather than a separate column-mapping interface.

    Any other column on \`events\`/\`objects\` becomes an \`event_attr\`/
    \`object_attr\` row automatically, always as a static value (\`ts\` null) --
    see \`_ocel_attribute_table\`'s docstring for why time-dependent object
    attributes cannot arise from this input shape.
    """
    if not name or not str(name).strip():
        raise PromenadeError("promenade.publish_ocel() requires name=")
    required = {
        "events": (events, ["event_id", "activity"]),
        "objects": (objects, ["object_id", "object_type"]),
        "e2o": (e2o, ["event_id", "object_id"]),
    }
    for label, (frame, cols) in required.items():
        missing = [c for c in cols if c not in frame.columns]
        if missing:
            raise PromenadeError(f"promenade.publish_ocel(): {label} is missing column(s) {missing}")

    import pandas as pd
    import pyarrow as pa

    events = events.reset_index(drop=True)
    objects = objects.reset_index(drop=True)

    def events_table(frame):
        ts = pd.to_datetime(frame["ts"], errors="coerce") if "ts" in frame.columns else pd.Series([None] * len(frame))
        return pa.table({
            "event_id": pa.array(frame["event_id"].astype(str)),
            "activity": pa.array(frame["activity"].astype(str)),
            "ts": pa.array(ts),
        })

    def objects_table(frame):
        return pa.table({
            "object_id": pa.array(frame["object_id"].astype(str)),
            "object_type": pa.array(frame["object_type"].astype(str)),
        })

    def relation_table(frame, a, b):
        return pa.table({
            a: pa.array(frame[a].astype(str)),
            b: pa.array(frame[b].astype(str)),
            "qualifier": (pa.array(frame["qualifier"].astype(str)) if "qualifier" in frame.columns
                          else pa.nulls(len(frame), type=pa.string())),
        })

    relations = {
        "event": _ipc_bytes(events_table(events)),
        "object": _ipc_bytes(objects_table(objects)),
        "e2o": _ipc_bytes(relation_table(e2o, "event_id", "object_id")),
    }
    if o2o is not None:
        missing = [c for c in ("source_id", "target_id") if c not in o2o.columns]
        if missing:
            raise PromenadeError(f"promenade.publish_ocel(): o2o is missing column(s) {missing}")
        relations["o2o"] = _ipc_bytes(relation_table(o2o, "source_id", "target_id"))

    event_attr_cols = [c for c in events.columns if c not in ("event_id", "activity", "ts")]
    event_attr_table = _ocel_attribute_table(events, events["event_id"], event_attr_cols, "event_id", with_ts=False)
    if event_attr_table is not None:
        relations["event_attr"] = _ipc_bytes(event_attr_table)

    object_attr_cols = [c for c in objects.columns if c not in ("object_id", "object_type")]
    object_attr_table = _ocel_attribute_table(objects, objects["object_id"], object_attr_cols, "object_id", with_ts=True)
    if object_attr_table is not None:
        relations["object_attr"] = _ipc_bytes(object_attr_table)

    meta = _publish_log_meta(name)
    meta["targetType"] = "ObjectCentricEventLog"
    current = await current_artifact()
    meta["inputArtifactIds"] = [current.id] if current is not None else []
    result = await _bridge_publish_log_call(meta, relations)
    return PublishedArtifact(result["id"], result["name"], result["type"],
                              f"{len(events)} events \xb7 {len(objects)} objects")


# --- cell execution ------------------------------------------------------

_notebook_globals = {"__name__": "__main__"}


async def _bind_artifact():
    handle = await current_artifact()
    _notebook_globals["artifact"] = handle
    _notebook_globals["promenade"] = sys.modules["promenade"]
    if isinstance(handle, LogHandle):
        _notebook_globals["log"] = handle
    elif "log" in _notebook_globals:
        del _notebook_globals["log"]


async def _run_cell(source, execution_count, provenance_json):
    import traceback
    from pyodide.code import eval_code_async

    global _provenance_context
    _provenance_context = json.loads(provenance_json)
    _display_queue.clear()

    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _StreamWriter("stdout"), _StreamWriter("stderr")
    try:
        try:
            value = await eval_code_async(source, globals=_notebook_globals, filename="<cell>")
        except Exception:
            etype, evalue, tb = sys.exc_info()
            frames = traceback.format_exception(etype, evalue, tb)
            _host_error(json.dumps({
                "ename": etype.__name__ if etype else "Error",
                "evalue": str(evalue),
                "traceback": frames,
            }))
            return
        if value is not None:
            bundle = _mimebundle(value)
            _host_execute_result(json.dumps({"executionCount": execution_count, "data": bundle}))
        for pending in _display_queue:
            _host_display_data(json.dumps({"data": _mimebundle(pending)}))
        _display_queue.clear()
    finally:
        sys.stdout, sys.stderr = old_out, old_err
`;

async function ensureKernel(onProgress?: (f: number, m?: string) => void) {
  if (!pyodide) {
    loading ??= loadPyodideRuntime(onProgress);
    pyodide = await loading;
    pyodide.globals.set('_bridge_json', async (op: string, argsJson: string) => bridgeJson(op, argsJson));
    pyodide.globals.set('_bridge_query', async (argsJson: string) => bridgeQuery(argsJson));
    pyodide.globals.set('_bridge_publish_log', async (metaJson: string, relations: any) => bridgePublishLog(metaJson, relations));
    pyodide.globals.set('_host_stream', (name: string, text: string) => post({ type: 'cellMessage', message: { type: 'stream', name, text } }));
    pyodide.globals.set('_host_execute_result', (json: string) => {
      const { executionCount, data } = JSON.parse(json);
      post({ type: 'cellMessage', message: { type: 'execute_result', executionCount, data } });
    });
    pyodide.globals.set('_host_display_data', (json: string) => {
      const { data } = JSON.parse(json);
      post({ type: 'cellMessage', message: { type: 'display_data', data } });
    });
    pyodide.globals.set('_host_error', (json: string) => {
      const { ename, evalue, traceback } = JSON.parse(json);
      post({ type: 'cellMessage', message: { type: 'error', ename, evalue, traceback } });
    });
  }
  await installMissingDeps(pyodide, installed, PM4PY_DEPS, onProgress);

  await pyodide.runPythonAsync(`
import sys, types
if "promenade" not in sys.modules:
    _m = types.ModuleType("promenade")
    _m.__dict__["_bridge_json"] = _bridge_json
    _m.__dict__["_bridge_query"] = _bridge_query
    _m.__dict__["_bridge_publish_log"] = _bridge_publish_log
    _m.__dict__["_host_stream"] = _host_stream
    _m.__dict__["_host_execute_result"] = _host_execute_result
    _m.__dict__["_host_display_data"] = _host_display_data
    _m.__dict__["_host_error"] = _host_error
    exec(${JSON.stringify(PN_CONVERTERS_PY + PROMENADE_MODULE_PY)}, _m.__dict__)
    sys.modules["promenade"] = _m
`);
  await pyodide.runPythonAsync('import promenade\nawait promenade._bind_artifact()');
  const v = await pyodide.runPythonAsync('import sys\nf"Python {sys.version.split()[0]}"');
  return { pyodide: pyodide.version as string, python: String(v) };
}

const HANDLERS: Record<string, (a: any) => Promise<unknown>> = {
  async init() {
    return ensureKernel((f, m) => progress(f, m));
  },

  /** Re-resolves `artifact`/`log` against the current binding without wiping other state. */
  async rebind() {
    await pyodide.runPythonAsync('import promenade\nawait promenade._bind_artifact()');
    return { ok: true };
  },

  async execute({ code, executionCount, provenance }) {
    pyodide.globals.set('_cell_source', code);
    pyodide.globals.set('_cell_execution_count', executionCount);
    pyodide.globals.set('_cell_provenance_json', JSON.stringify(provenance ?? {}));
    await pyodide.runPythonAsync(
      'import promenade\nawait promenade._run_cell(_cell_source, _cell_execution_count, _cell_provenance_json)',
    );
    return { ok: true };
  },

  async dispose() {
    return { disposed: true };
  },
};

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'bridgeResult' || m.type === 'bridgeError') {
    const w = bridgeWaiting.get(m.id);
    if (!w) return;
    bridgeWaiting.delete(m.id);
    if (m.type === 'bridgeError') w.reject(new Error(m.error));
    else w.resolve(m.payload);
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
