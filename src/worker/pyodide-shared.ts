/**
 * Shared Pyodide runtime loading, dependency installation, and Python
 * artifact-conversion source.
 *
 * Used by both the PM4Py/WASM action worker (`pyodide-worker.ts`) and the
 * notebook kernel worker (`notebook-worker.ts`). Two independent Pyodide
 * *instances* exist — one per worker — because kernel state must never leak
 * between an ad-hoc notebook session and a packaged plugin's execution. But
 * the code that loads the runtime, resolves `deps=False` installs, and
 * converts a pm4py object graph to Promenade's JSON artifact payloads is
 * written once and imported twice, so the two runtimes cannot drift.
 *
 * See docs/pyodide-pm4py-report.md for why `deps=False` is required (cvxopt
 * is a declared-but-unused pm4py dependency with no wasm wheel) and
 * docs/python-notebook.md for the notebook-specific bridge built on top of
 * `PN_CONVERTERS_PY`.
 */

export const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.3/full/';

/** Packages Pyodide ships built in; anything else installs from PyPI. */
export const BUILTIN_PACKAGES = [
  'numpy', 'pandas', 'scipy', 'networkx', 'lxml', 'matplotlib', 'pytz', 'tqdm', 'pyarrow',
];

/** What pm4py actually needs at import time (see docs/pyodide-pm4py-report.md). */
export const PM4PY_DEPS = [
  'numpy', 'pandas', 'scipy', 'networkx', 'lxml', 'matplotlib', 'pytz', 'tqdm',
  'pyarrow', 'graphviz', 'deprecation', 'intervaltree', 'sortedcontainers',
  'pm4py',
];

/**
 * ES module worker, so the ESM entry point is imported directly.
 * importScripts is not available here, and jsdelivr serves the module with
 * permissive CORS.
 */
export async function loadPyodideRuntime(onProgress?: (fraction: number, message?: string) => void) {
  onProgress?.(0.05, 'loading Python runtime');
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: PYODIDE_URL });
  onProgress?.(0.35, 'Python ready');
  return py;
}

/**
 * Installs whichever of `deps` are not already in `installed`, splitting
 * Pyodide-builtin packages (`loadPackage`) from PyPI ones (`micropip`,
 * `deps=False`). A declared-but-unused binary dependency (cvxopt in pm4py's
 * case) otherwise aborts the whole install even though nothing imports it.
 */
export async function installMissingDeps(
  pyodide: any,
  installed: Set<string>,
  deps: string[],
  onProgress?: (fraction: number, message?: string) => void,
): Promise<void> {
  const missing = deps.filter((d) => !installed.has(d));
  if (!missing.length) return;
  onProgress?.(0.45, `installing ${missing.join(', ')}`);
  await pyodide.loadPackage('micropip');
  const micropip = pyodide.pyimport('micropip');

  const fromPyodide = missing.filter((d) => BUILTIN_PACKAGES.includes(d));
  const fromPypi = missing.filter((d) => !BUILTIN_PACKAGES.includes(d));

  if (fromPyodide.length) await pyodide.loadPackage(fromPyodide);
  for (const d of fromPypi) {
    await micropip.install.callKwargs(d, { deps: false });
  }
  for (const d of missing) installed.add(d);
}

/**
 * Pure pm4py <-> Promenade artifact-payload conversion functions.
 *
 * Deliberately just the conversion logic — no `ctx`/bridge plumbing — so it
 * means the same thing regardless of which host module (`pm_plugin` for
 * actions, `promenade` for notebooks) execs it into its own interpreter.
 * A plugin or a notebook cell returns structure, not pictures: the host
 * draws it, which is also why pm4py's graphviz rendering being unavailable
 * in the browser does not matter here.
 */
export const PN_CONVERTERS_PY = `
_PT_OPERATORS = {
    "->": "sequence", "X": "xor", "+": "parallel", "*": "loop",
    "O": "or", "<>": "interleaving", "PO": "partialorder",
}


def process_tree(tree, stats=None):
    """Converts a pm4py ProcessTree into Promenade's ProcessTree payload.

    A flat node array with index references: it clones cheaply across the
    sandboxed-view boundary, and a viewer can walk it without recursion.
    operator and label both None means a silent (tau) leaf, the same way
    pm4py represents it.
    """
    nodes = []
    activities = []

    def walk(node):
        idx = len(nodes)
        op = getattr(node, "operator", None)
        entry = {
            "operator": _PT_OPERATORS.get(str(op.value) if op is not None else None),
            "label": node.label,
            "children": [],
        }
        if op is None and node.label is not None and node.label not in activities:
            activities.append(node.label)
        nodes.append(entry)
        for child in getattr(node, "children", []) or []:
            entry["children"].append(walk(child))
        return idx

    root = walk(tree)
    leaves = sum(1 for n in nodes if n["operator"] is None)
    return {
        "root": root,
        "nodes": nodes,
        "activities": activities,
        "stats": {
            "nodes": len(nodes),
            "leaves": leaves,
            "silent": sum(1 for n in nodes if n["operator"] is None and n["label"] is None),
            "operators": len(nodes) - leaves,
            **(stats or {}),
        },
    }


def parse_process_tree(payload):
    """Rebuilds a pm4py ProcessTree from the payload.

    The inverse of 'process_tree()'. A conversion action receives an artifact
    another action produced, so it has to be able to read the contract as well
    as write it.
    """
    from pm4py.objects.process_tree.obj import ProcessTree, Operator

    by_name = {
        "sequence": Operator.SEQUENCE, "xor": Operator.XOR,
        "parallel": Operator.PARALLEL, "loop": Operator.LOOP,
        "or": Operator.OR, "interleaving": Operator.INTERLEAVING,
        "partialorder": Operator.PARTIALORDER,
    }
    nodes = payload["nodes"]

    def build(i, parent):
        spec = nodes[i]
        node = ProcessTree(
            operator=by_name.get(spec.get("operator")) if spec.get("operator") else None,
            parent=parent,
            label=spec.get("label"),
        )
        node.children = [build(c, node) for c in spec.get("children", [])]
        return node

    return build(payload["root"], None)


def petri_net(net, im, fm, activities=None):
    """Converts a pm4py Petri net into Promenade's AcceptingPetriNet shape.

    A plugin returns structure, not pictures: the host draws it. That is also
    why pm4py's graphviz rendering being unavailable in the browser does not
    matter here.
    """
    places = list(net.places)
    transitions = list(net.transitions)
    p_index = {p: i for i, p in enumerate(places)}
    labels = []
    t_index = {}
    for t in transitions:
        t_index[t] = len(labels)
        labels.append(t.label if t.label is not None else None)

    place_to_transition = []
    transition_to_place = []
    for arc in net.arcs:
        if arc.source in p_index:
            place_to_transition.append([p_index[arc.source], t_index[arc.target]])
        else:
            transition_to_place.append([t_index[arc.source], p_index[arc.target]])

    return {
        "activities": list(range(len(labels))),
        "labels": labels,
        "places": [
            {
                "id": str(p.name),
                "inputs": [t_index[a.source] for a in p.in_arcs],
                "outputs": [t_index[a.target] for a in p.out_arcs],
                "kind": ("initial" if p in im else "final" if p in fm else "derived"),
            }
            for p in places
        ],
        "place_to_transition": place_to_transition,
        "transition_to_place": transition_to_place,
        "initial_marking": [p_index[p] for p in im],
        "final_marking": [p_index[p] for p in fm],
        "start_activities": [],
        "end_activities": [],
        "stats": {
            "places": len(places),
            "transitions": len(transitions),
            "arcs": len(net.arcs),
            "silent_transitions": sum(1 for l in labels if l is None),
        },
    }
`;
