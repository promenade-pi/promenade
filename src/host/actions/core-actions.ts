import { actionRegistry } from './registry';
import { artifactTypes } from '../artifact/registry';
import { dataClient, type OcelExportFormat, type XesExportFormat } from '../data/client';
import { payloadOf } from './results';
import { toPnml, ocpnToPnml, parsePnml, toAcceptingPetriNet } from '../../ingest/pnml';
import type { ActionDef } from './types';
import {
  runDiscoverOcdfg, runDiscoverDfg, runDiscoverDfgSql, runDiscoverObjectInteractions,
} from './coreCompute';
import discoverDfgSqlManifest from '../relational/reference-actions/discover-dfg/manifest.json';
import objectInteractionsManifest from '../relational/reference-actions/object-interactions/manifest.json';

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Action declarations for Milestone 1.
 *
 * No algorithm is implemented here — that is Milestone 2's Rust/WASM plugin.
 * What exists is the shape: parameter schemas the inspector renders natively,
 * multi-input slots so "applicable once you also select X" is expressible, and
 * the prepare/finalize split the Milestone 0 numbers require.
 */

/**
 * Discovers an object-centric directly-follows graph: for every object type,
 * the per-object event sequences (not per-case — OCEL has no single case
 * notion) become directly-follows edges, the same way a normal DFG's edges
 * come from per-case sequences.
 *
 * Runs as plain SQL over DuckDB rather than a WASM kernel — the aggregation
 * (window functions over `event ⋈ e2o ⋈ object`) is exactly the kind of
 * thing DuckDB already does well, and an object-centric log's own tables
 * are the host's to query directly; no separate scan stage earns its keep
 * here. `minFrequency`/which object types are drawn are therefore *view*
 * parameters (`core.ocdfgView`, `ownsControls: true`), not action params —
 * the full unfiltered result is computed once and filtered client-side,
 * the same split `core.dfgView`'s percentile sliders already use.
 */
const discoverOcdfg: ActionDef = {
  id: 'core.discover.ocdfg',
  // The engine is in the label because two installed actions now produce an
  // OC-DFG and the only thing separating them is how. This one is DuckDB SQL
  // (see `runDiscoverOcdfg`'s `runtimeVersion: 'duckdb-sql'`) — *not* Rust,
  // despite the sibling `core.discover.dfg` next door being exactly that.
  label: 'Discover OC-DFG (SQL)',
  // 0.2.0: every edge now also carries `avgSecs`, the mean wait between the two
  // activities, so consumers can render performance as well as frequency.
  version: '0.2.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  memory: 'medium',
  implemented: true,
  inputs: [
    { name: 'log', type: 'ObjectCentricEventLog', required: true, label: 'an Object-Centric Event Log' },
  ],
  outputs: [{ name: 'ocdfg', type: 'OCDFG' }],
  params: {
    type: 'object',
    properties: {
      maxObjectTypes: {
        type: 'integer',
        title: 'Object type limit',
        description: 'Keeps only the most frequent object types — every relation is scanned per object, so this bounds how much the query has to do on a log with many types.',
        default: 12, minimum: 1, maximum: 50,
      },
    },
    required: ['maxObjectTypes'],
  },
  run: runDiscoverOcdfg,
};

/**
 * The one action with a real implementation: a Rust kernel compiled to WASM,
 * running in its own worker, reaching data only through host.sql().
 */
const discoverDfg: ActionDef = {
  id: 'core.discover.dfg',
  label: 'Discover DFG (Rust/WASM)',
  description:
    'Counts how often each activity directly follows each other one, and keeps the edges above '
    + 'a frequency threshold. The plainest possible view of the control flow: no soundness '
    + 'guarantee, no concurrency semantics, but nothing hidden either.',
  agent: {
    whenToUse: 'A first look at an unfamiliar log, and the basis every filtered "map" view builds on.',
    notFor: 'Conformance checking or replay — those need a Petri net; discover one with a miner instead.',
    examples: ['minFrequency 1 to see everything, then raise it until the graph is readable'],
  },
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'wasm',
  memory: 'medium',
  implemented: true,
  inputs: [
    { name: 'log', type: 'TraditionalEventLog', required: true, label: 'a Traditional Event Log' },
  ],
  outputs: [{ name: 'dfg', type: 'DFG' }],
  params: {
    type: 'object',
    properties: {
      minFrequency: {
        type: 'integer', title: 'Minimum edge frequency',
        // Keep every observed directly-follows relation by default.  A
        // threshold of ten used to make rare, but perfectly valid, loops look
        // as if the DFG computation had lost them.
        default: 1, minimum: 1, maximum: 5000, primary: true, cheap: true,
      },
      /**
       * The case a static enum cannot express: the values only exist once a
       * log is imported. The host runs the query and renders the picker, so
       * this needs no plugin-side UI.
       *
       * Not `cheap`: restricting the activities changes what is scanned, so
       * the expensive stage has to run again.
       */
      activities: {
        type: 'array',
        title: 'Activities',
        description: 'Empty means all. Restricting them re-runs the scan.',
        default: [],
        optionsFrom: {
          sql: `SELECT activity AS value, COUNT(*) AS n FROM {event}
                WHERE activity IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
          countField: 'n',
          colorDomain: 'activity',
        },
      },
    },
    required: ['minFrequency'],
  },
  run: runDiscoverDfg,
};

// OCPN discovery used to be declared here, core-provider, with its own
// bespoke runner and worker — see `docs/` in `plugins/ocpn-rs` for why that
// was the wrong shape: any basic capability that cannot work as an
// installed plugin is a plugin-API gap, not a reason to keep it in core. It
// now ships as `plugins/ocpn-rs`'s own manifest, a genuine two-action
// package (a `relational` projection action feeding a `wasm` mining action
// via `ctx.produce()`), installed the same way any other plugin is.

// Conformance checking used to be declared here as an unimplemented shell —
// it is now a real action, declared by the alignment-rs plugin's own
// manifest like every other miner, not a core placeholder.

/**
 * The built-in Python scratchpad.
 *
 * A host feature rather than a plugin: it opens the editor panel and produces
 * no artifact, so it leaves no provenance node — exploration is not
 * computation someone else needs to reproduce.
 */
const pythonScript: ActionDef = {
  id: 'core.script.python',
  label: 'Python script',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'pyodide',
  implemented: true,
  opensView: 'core.scriptEditor',
  inputs: [
    { name: 'log', type: 'ObjectCentricEventLog', required: false, label: 'a log' },
    { name: 'tradLog', type: 'TraditionalEventLog', required: false, label: 'a log' },
  ],
  outputs: [],
  params: { type: 'object', properties: {} },
};

/**
 * Derives a new log from an existing one.
 *
 * Editing and filtering are one action, not two: both derive a log, and the
 * whole ordered list of operations is the unit the user thinks in. One action
 * per operation would grow a tree node for every keystroke of cleaning work.
 *
 * Produces an artifact of the *same* type as its input — a filtered log is
 * still a log — which is what lets every downstream action and view work on it
 * without knowing it was transformed.
 */
const transformLog: ActionDef = {
  id: 'core.transformLog',
  label: 'Transform log (filter / edit)',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  inputs: [
    { name: 'log', type: 'TraditionalEventLog', required: false, label: 'a log' },
    { name: 'ocel', type: 'ObjectCentricEventLog', required: false, label: 'a log' },
  ],
  outputs: [{ name: 'derived', type: 'TraditionalEventLog' }],
  params: { type: 'object', properties: {} },
};

/**
 * Object-centric → case-centric.
 *
 * The bridge that makes the entire case-centric toolset usable on an OCEL log:
 * pick an object type, and every object of that type becomes a case. It is a
 * transformation like any other — a plan over views, no copy — and it is lossy
 * in the two ways every flattening is, which the resulting artifact reports
 * rather than hides.
 */
const flattenOcel: ActionDef = {
  id: 'core.flattenOcel',
  label: 'Flatten to a case-centric log',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  inputs: [
    {
      name: 'log', type: 'ObjectCentricEventLog', required: true,
      label: 'an Object-Centric Event Log',
      // Without objects there is nothing to make cases out of.
      requires: ['objects'],
    },
  ],
  outputs: [{ name: 'log', type: 'TraditionalEventLog' }],
  params: {
    type: 'object',
    properties: {
      objectType: {
        type: 'string',
        title: 'Case notion',
        description: 'Each object of this type becomes one case.',
        primary: true,
        // The types only exist once a log is imported, so they are queried
        // rather than declared — the same rule as every other data-bound choice.
        optionsFrom: {
          sql: 'SELECT object_type AS value, COUNT(*) AS n FROM {object} '
            + 'GROUP BY 1 ORDER BY n DESC',
          countField: 'n',
          colorDomain: 'objectType',
        },
      },
    },
    required: ['objectType'],
  },
};

/**
 * Discovers a DFG the same way `discoverDfg` does, but as a Promenade
 * Relational Program instead of a Rust/WASM kernel — the reference action
 * that proves the relational API against a real algorithm (see
 * `host/relational/reference-actions/discover-dfg/`). `id`, `label`,
 * `inputs`, `outputs` and `params` are read from that package's own
 * `manifest.json` rather than duplicated here, so the declaration that ships
 * as an example plugin package is exactly the one that runs.
 */
const dfgSqlDef = discoverDfgSqlManifest.actions[0];
const discoverDfgSql: ActionDef = {
  id: dfgSqlDef.id,
  label: dfgSqlDef.label,
  version: discoverDfgSqlManifest.version,
  provider: 'core',
  trusted: true,
  runtime: 'relational',
  memory: dfgSqlDef.memory as ActionDef['memory'],
  implemented: true,
  inputs: dfgSqlDef.inputs,
  outputs: dfgSqlDef.outputs,
  params: dfgSqlDef.params,
  run: runDiscoverDfgSql,
};

/**
 * Object-type interaction graph — the second reference action, and the one
 * that is actually OCEL-shaped rather than a relational restatement of an
 * XES-era algorithm. `discoverDfg`/`discoverDfgSql` both work on a
 * `TraditionalEventLog`; this one only makes sense once a log has more than
 * one object type and E2O/O2O relations with qualifiers to query — see
 * `host/relational/reference-actions/object-interactions/query.sql`.
 *
 * `provider: 'core'` here, same as every other built-in action — this ships
 * with the app, not through the plugin marketplace, and `pluginName()` in
 * `Inspector.tsx` only resolves a provider id to a friendly name by looking
 * it up among *installed* plugins, which this deliberately is not; anything
 * else would show the raw package id as "Produced by".
 *
 * `ObjectInteractionGraph`, the artifact *type* this produces, is a
 * different story: it is genuinely new, with exactly one producer and no
 * cross-plugin contract to be — the case `architecture.md` says belongs to
 * the plugin, not to `core`'s type list. It is registered below with
 * `provider: objectInteractionsManifest.id`, the same call
 * `host/plugins/store.ts` makes for a real install's `manifest.artifactTypes`.
 */
const objectInteractionsDef = objectInteractionsManifest.actions[0];
const discoverObjectInteractions: ActionDef = {
  id: objectInteractionsDef.id,
  label: objectInteractionsDef.label,
  version: objectInteractionsManifest.version,
  provider: 'core',
  trusted: true,
  runtime: 'relational',
  memory: objectInteractionsDef.memory as ActionDef['memory'],
  implemented: true,
  inputs: objectInteractionsDef.inputs,
  outputs: objectInteractionsDef.outputs,
  params: objectInteractionsDef.params,
  run: runDiscoverObjectInteractions,
};

/**
 * Opens the provenance DAG. Produces nothing and records nothing: looking at
 * where an artifact came from is not itself a computation.
 */
const provenance: ActionDef = {
  id: 'core.provenance.show',
  label: 'Show provenance',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  opensView: 'core.provenance',
  inputs: [
    { name: 'any', type: 'ObjectCentricEventLog', required: false, label: 'any artifact' },
    { name: 'trad', type: 'TraditionalEventLog', required: false, label: 'any artifact' },
    { name: 'dfg', type: 'DFG', required: false, label: 'any artifact' },
    { name: 'apn', type: 'AcceptingPetriNet', required: false, label: 'any artifact' },
  ],
  outputs: [],
  params: { type: 'object', properties: {} },
};

/**
 * The three exports that predate the generalized `exportsFile` mechanism,
 * ported onto it rather than left as the hand-written `App.tsx`/view-button
 * special cases they used to be — the same reasoning that made a plugin
 * author's own model export (PNML, BPMN 2.0 XML) worth generalizing applies
 * equally to these; "core" is just this manifest's `provider`, not a
 * different mechanism. Each still does exactly what its old handler did
 * (`dataClient.exportOcel`/`exportXes`, `toPnml`), just returning
 * `ActionOutcome.exported` instead of building a `Blob` and clicking an
 * `<a>` itself — that part is now `executeExport`'s job (`App.tsx`), shared
 * by every export action, first- or third-party alike.
 */
const exportOcel: ActionDef = {
  id: 'core.export.ocel',
  label: 'Export OCEL',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  exportsFile: true,
  inputs: [{ name: 'log', type: 'ObjectCentricEventLog', required: true, label: 'an OCEL log' }],
  outputs: [],
  params: {
    type: 'object',
    properties: { format: { type: 'string', title: 'Format', enum: ['json', 'xml', 'sqlite', 'csv', 'bundle-csv', 'bundle-parquet'], default: 'json' } },
    required: ['format'],
  },
  async run(inputs, params) {
    const id = inputs.log[0];
    const format = params.format as OcelExportFormat;
    const { content } = await dataClient.exportOcel(id, format);
    const { catalog } = await dataClient.catalog();
    const name = sanitizeFilename(catalog.artifacts[id]?.name ?? 'export');
    const suffix: Record<OcelExportFormat, string> = { json: '.jsonocel', xml: '.xmlocel', sqlite: '.sqlite', csv: '.ocel.csv', 'bundle-csv': '.ocel.zip', 'bundle-parquet': '.ocel.zip' };
    const mime = format === 'sqlite' ? 'application/vnd.sqlite3' : format.includes('bundle') ? 'application/zip' : format === 'xml' ? 'application/xml' : 'text/plain';
    const extra = format === 'bundle-parquet' ? '.parquet' : format === 'bundle-csv' ? '.csv' : '';
    return { exported: { bytes: content, filename: `${name}${extra}${suffix[format]}`, mime } };
  },
};

const exportXes: ActionDef = {
  id: 'core.export.xes',
  label: 'Export XES',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  exportsFile: true,
  inputs: [{ name: 'log', type: 'TraditionalEventLog', required: true, label: 'a traditional event log' }],
  outputs: [],
  params: {
    type: 'object',
    properties: { format: { type: 'string', title: 'Format', enum: ['xes', 'csv'], default: 'xes' } },
    required: ['format'],
  },
  async run(inputs, params) {
    const id = inputs.log[0];
    const format = params.format as XesExportFormat;
    const { content } = await dataClient.exportXes(id, format);
    const { catalog } = await dataClient.catalog();
    const name = sanitizeFilename(catalog.artifacts[id]?.name ?? 'export');
    return { exported: { bytes: content, filename: `${name}.${format}`, mime: format === 'xes' ? 'application/xml' : 'text/csv' } };
  },
};

/**
 * PNML for an object-centric net.
 *
 * Separate from `core.export.pnml` rather than a branch inside it: the two
 * take different artifact types, and `exportActionsFor` matches an export to
 * an artifact by its single input slot's type, so one action per type is what
 * makes each appear under the right artifact.
 */
const exportOcpnPnml: ActionDef = {
  id: 'core.export.ocpn.pnml',
  label: 'Export PNML',
  description:
    'Writes the net as PNML: a structurally valid P/T net that any PNML tool can open, '
    + 'with the object types, the silent transitions and the variable arcs carried in a '
    + 'toolspecific block, since PNML has no object-centric grammar of its own.',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  exportsFile: true,
  inputs: [{
    name: 'net', type: 'ObjectCentricPetriNet', required: true,
    label: 'an Object-Centric Petri Net',
  }],
  outputs: [],
  params: { type: 'object', properties: {} },
  async run(inputs) {
    const id = inputs.net[0];
    const { catalog } = await dataClient.catalog();
    const artifact = catalog.artifacts[id];
    if (!artifact) throw new Error('Export PNML: artifact not found');
    const value = payloadOf(id) ?? (artifact.storage.kind === 'inline' ? artifact.storage.value : null);
    if (value == null) {
      throw new Error(
        `Export PNML: "${artifact.name}" has no computed result in memory — reopen its view once to recompute it.`
      );
    }
    const name = sanitizeFilename(artifact.name.replace(/\.[^.]+$/, '')) || 'net';
    return {
      exported: {
        bytes: ocpnToPnml(value as any, artifact.name),
        filename: `${name}.pnml`,
        mime: 'application/xml',
      },
    };
  },
};

const exportPnml: ActionDef = {
  id: 'core.export.pnml',
  label: 'Export PNML',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  implemented: true,
  exportsFile: true,
  inputs: [{ name: 'net', type: 'AcceptingPetriNet', required: true, label: 'an Accepting Petri Net' }],
  outputs: [],
  params: { type: 'object', properties: {} },
  async run(inputs) {
    const id = inputs.net[0];
    const { catalog } = await dataClient.catalog();
    const artifact = catalog.artifacts[id];
    if (!artifact) throw new Error('Export PNML: artifact not found');
    const value = payloadOf(id) ?? (artifact.storage.kind === 'inline' ? artifact.storage.value : null);
    if (value == null) throw new Error(`Export PNML: "${artifact.name}" has no computed result in memory — reopen its view once to recompute it.`);
    // Names only matter for the Alpha Miner shape (no embedded `labels`);
    // the Inductive/Heuristics Miner shape ignores this argument entirely.
    const names = Array.isArray((artifact.meta as any)?.activityNames) ? (artifact.meta as any).activityNames as string[] : [];
    const name = sanitizeFilename(artifact.name);
    const xml = toPnml(value, names, name);
    return { exported: { bytes: xml, filename: `${name}.pnml`, mime: 'application/xml' } };
  },
};

/**
 * A manufacturing action (`inputs: []`) rather than a branch hardcoded into
 * `App.tsx`'s file-import dispatch — the same shape `run.promenade.bpmn`'s
 * `import` action already uses, so a dropped `.pnml` file reaches this
 * through the plain Import control's generic "does any registered
 * manufacturing action's file param accept this extension" fallback
 * (`fileImporterFor` in `App.tsx`) instead of a special case only PNML got.
 * `executeAction`'s own generic `inline`-outcome handling — artifact
 * creation, `resultStore`, color seeding — is exactly what the old
 * hand-written branch did by hand.
 */
const importPnml: ActionDef = {
  id: 'core.pnml.import',
  label: 'Import PNML',
  version: '0.1.0',
  provider: 'core',
  trusted: true,
  runtime: 'core',
  memory: 'low',
  implemented: true,
  inputs: [],
  outputs: [{ name: 'net', type: 'AcceptingPetriNet' }],
  params: {
    type: 'object',
    properties: {
      xml: {
        type: 'file',
        title: 'PNML file',
        description: 'A Petri net in PNML format (accepting Petri net semantics).',
        accept: '.pnml',
        primary: true,
      },
    },
    required: ['xml'],
  },
  async run(_inputs, params) {
    const { net, names } = toAcceptingPetriNet(parsePnml(String(params.xml ?? '')));
    return {
      inline: {
        value: { result: net, activities: names },
        activities: names,
        stats: { ...net.stats, sourceFormat: 'pnml' },
      },
    };
  },
};

export function registerCoreActions() {
  // Same call `host/plugins/store.ts` makes from a real install's
  // `manifest.artifactTypes` — done here once, eagerly, because these two
  // reference packages never go through the install flow itself.
  for (const m of [discoverDfgSqlManifest, objectInteractionsManifest]) {
    for (const t of m.artifactTypes ?? []) {
      artifactTypes.register({ ...t, provider: m.id, providerInstalled: true });
    }
  }

  for (const a of [transformLog, flattenOcel, discoverOcdfg, discoverDfg, exportOcpnPnml,
                   discoverDfgSql, discoverObjectInteractions, pythonScript, provenance,
                   exportOcel, exportXes, exportPnml, importPnml]) {
    actionRegistry.register(a);
  }
}
