import { useEffect, useRef } from 'react';
import type { Artifact } from '../host/artifact/types';
import { dataClient } from '../host/data/client';
import { colorRegistry } from '../host/services/colors';
import { viewRegistry } from '../host/views/registry';
import { selectionBus } from '../host/services/selection';
import { workspaceState } from '../host/services/workspaceState';
import { artifactTypes } from '../host/artifact/registry';
import { buildPublishedArtifact } from '../host/artifact/publish-artifact';
import { tableOf } from './views/tableName';
import { logicalTablesOf } from '../host/artifact/tables';
import { buildExecutionPartitionArtifact } from '../host/artifact/execution-partition';
import { buildInteractionCohortArtifact, isLassoInteractionSelection, requireInteractionCohort } from '../host/artifact/interaction-cohort';
import { requireObjectCentricReplayEvidence } from '../host/artifact/ocpn-replay-evidence';
import { liveRun } from '../host/actions/liveRun';
import { readPluginFile } from '../host/plugins/store';
import { authoredSemantics, buildAuthoredOcelRelations, buildEditedLogExecution, type AuthoredLogRequest } from '../host/artifact/publish-log';
import frameHtml from './plugin-frame.html?raw';
import { resolve as resolveTheme, subscribe as subscribeTheme } from './theme';

/**
 * Host container for a sandboxed view plugin.
 *
 * The iframe carries `sandbox="allow-scripts allow-downloads"` and
 * deliberately NOT `allow-same-origin`, which gives the document an opaque
 * origin: no access to the host's DOM, cookies, storage or credentialed
 * network. `allow-downloads` only lets an `<a download>` click reach the
 * browser's own save-file UI — it grants no origin access. The only other
 * channel is a MessagePort transferred during the handshake.
 *
 * The host keeps everything the brief says it must keep: panel chrome, panel
 * geometry, the color assignment, and the selection vocabulary. The plugin
 * gets data and events.
 *
 * Known limitations that follow from the boundary and are accepted here:
 *  - the plugin cannot draw outside its rect, so tooltips and context menus
 *    must be rendered by the host or stay inside the panel;
 *  - it cannot take part in global keyboard shortcuts;
 *  - resize and theme tokens have to be injected, because the frame observes
 *    neither the docking manager nor the host stylesheet.
 */

/** Theme tokens handed to plugins. A closed list, not the host's stylesheet. */
const THEME_TOKENS = [
  'bg', 'bg-soft', 'bg-sunken', 'border', 'text', 'text-dim',
  'accent', 'accent-soft', 'danger', 'warn', 'ok',
];

/**
 * Resolves once `el` has a layout box — or right away if it already has one.
 *
 * A panel frame is routinely mounted with no box at all: hidden behind
 * another tab, in a collapsed dock, or reparented off-screen (which reloads
 * the frame, see `send`). Handing a plugin its bundle in that state is what
 * produces a view that is subtly and permanently broken rather than merely
 * late, because a library that measures the DOM once at start-up has nothing
 * to measure and never finds out. React Flow is the clearest case: it renders
 * nodes without measuring them but draws an edge only once that edge's
 * endpoints are measured, so it comes out as nodes with no edges and stays
 * that way (its own error 004, "The parent container needs a width and a
 * height to render the graph").
 *
 * Withholding `init` is the general repair, because plugin code does not run
 * until it arrives. It covers every view rather than each one guarding
 * itself, and it covers the reload case too, which a view cannot see.
 *
 * A ResizeObserver is the primary signal; the poll is a backstop, because an
 * element in a subtree the browser has stopped painting altogether does not
 * reliably get an observation when it comes back.
 */
function whenSized(el: HTMLElement, canceled: () => boolean): Promise<boolean> {
  const sized = () => el.clientWidth > 0 && el.clientHeight > 0;
  if (sized()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearInterval(timer);
      resolve(ok);
    };
    const check = () => {
      if (canceled()) finish(false);
      else if (sized()) finish(true);
    };
    const observer = new ResizeObserver(check);
    observer.observe(el);
    const timer = setInterval(check, 200);
  });
}

function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const t of THEME_TOKENS) out[t] = cs.getPropertyValue(`--${t}`).trim();
  // Not a colour, but the one fact a plugin cannot derive from the colours:
  // which side of the palette it is on. A view that hands a scheme name to a
  // library (React Flow's `colorMode`, a chart theme) would otherwise have to
  // guess it from the luminance of `--bg`, or read the OS scheme through its
  // own `matchMedia` and be wrong whenever the host's is pinned against it.
  out.scheme = resolveTheme();
  return out;
}

/**
 * A plugin's own `setCachedState()` payload, kept per panel across a
 * close-then-reopen — closing a tab still tears down its iframe (there is
 * no way to keep a frame alive without keeping its DOM position fixed, and
 * a docked panel's position is not fixed: moving an iframe to a new parent
 * reloads it, the same reparenting hazard `send()`'s own doc comment
 * describes), but whatever the plugin chose to remember does not have to
 * be recomputed from scratch just because the frame is new. Module-level,
 * not component state: the whole point is to outlive the component that
 * would otherwise be the only thing holding it.
 *
 * Capped and LRU-evicted, not because any one entry is expected to be
 * huge, but because a long session opening many different panels
 * shouldn't accumulate an unbounded number of them.
 */
const CACHED_STATE_LIMIT = 12;
const panelStateCache = new Map<string, unknown>();
function readPanelCache(panelId: string): unknown {
  if (!panelStateCache.has(panelId)) {
    // console.info, not console.debug: Chrome DevTools files console.debug
    // under its "Verbose" level, which is unchecked in the console's level
    // filter by default — a human watching the real console panel sees
    // nothing at all, even though the calls are firing exactly as intended
    // (a CDP-based reader, unlike the DevTools UI, is not subject to that
    // filter, which is why this looked fine every time it was checked that
    // way).
    if (import.meta.env.DEV) console.info('[plugin-cache] miss', panelId, [...panelStateCache.keys()]);
    return null;
  }
  const v = panelStateCache.get(panelId);
  if (import.meta.env.DEV) console.info('[plugin-cache] hit', panelId);
  // Re-inserting moves it to the end of the Map's iteration order — the
  // cheapest available LRU bump, no separate timestamp bookkeeping needed.
  panelStateCache.delete(panelId);
  panelStateCache.set(panelId, v);
  return v;
}
function writePanelCache(panelId: string, value: unknown): void {
  if (import.meta.env.DEV) console.info('[plugin-cache] write', panelId);
  panelStateCache.delete(panelId);
  panelStateCache.set(panelId, value);
  while (panelStateCache.size > CACHED_STATE_LIMIT) {
    const oldest = panelStateCache.keys().next().value;
    if (oldest === undefined) break;
    panelStateCache.delete(oldest);
  }
}

/**
 * Arrow columns converted to structured-cloneable columnar data.
 *
 * The frame boundary forces a copy or a transfer either way, so numeric
 * columns cross as typed arrays (transferred) rather than an array of row
 * objects. SQL remains the contract; only the carrier differs from the
 * in-process views, which get the Arrow table directly.
 */
function toColumns(table: import('apache-arrow').Table) {
  const columns: Record<string, unknown> = {};
  const transfer: Transferable[] = [];
  for (const field of table.schema.fields) {
    const vec = table.getChild(field.name)!;
    const arr = vec.toArray();
    if (ArrayBuffer.isView(arr) && !(arr instanceof BigInt64Array) && !(arr instanceof BigUint64Array)) {
      const copy = (arr as any).slice();
      columns[field.name] = copy;
      transfer.push(copy.buffer);
    } else if (arr instanceof BigInt64Array || arr instanceof BigUint64Array) {
      // BigInt is cloneable but awkward for plugin authors; timestamps and
      // counts are handed over as Float64 instead.
      const f = new Float64Array(arr.length);
      for (let i = 0; i < arr.length; i++) f[i] = Number(arr[i]);
      columns[field.name] = f;
      transfer.push(f.buffer);
    } else {
      const out = new Array(table.numRows);
      for (let i = 0; i < table.numRows; i++) {
        const v = vec.get(i);
        out[i] = typeof v === 'bigint' ? Number(v) : v == null ? null : String(v);
      }
      columns[field.name] = out;
    }
  }
  return { payload: { numRows: table.numRows, columns }, transfer };
}

export function PluginPanel({
  artifact, panelId, entry, params, inlineValue, cacheKey, onParamChange, onGraphUpdated, provider, sourceArtifact, comparisonCohorts, interactionSelections, replayEvidence, live, publishes, readsFiles, readsWorkspace, derivesLogs, viewId, onPublishedArtifact, onOpenView, onDeriveLog,
}: {
  artifact: Artifact;
  panelId: string;
  entry: string;
  /** Artifact types this view's manifest declares it may publish (`ViewDef.publishes`). */
  publishes?: string[];
  /**
   * The manifest let this view read the bound artifact's stored files
   * (`ViewDef.readsFiles`), which is what unlocks `promenade.files()` and
   * `promenade.openFile()` below.
   */
  readsFiles?: boolean;
  /**
   * The manifest let this view read the on-screen arrangement
   * (`ViewDef.readsWorkspace`) — `promenade.workspace()` and the `workspace`
   * event below.
   */
  readsWorkspace?: boolean;
  /**
   * The manifest let this view propose log repairs (`ViewDef.derivesLogs`),
   * which is what unlocks `promenade.deriveLog()` below.
   */
  derivesLogs?: boolean;
  /**
   * Backs `promenade.deriveLog()`. The panel hands over the operations and the
   * *bound artifact*; resolving which log they apply to, finding or creating
   * the derived artifact and merging the plan are all the shell's, because
   * they are decisions about the catalog rather than about this frame.
   */
  onDeriveLog?: (
    boundArtifactId: string, ops: unknown[]
  ) => Promise<{ id: string; name: string; applied: number }>;
  /**
   * Which registered view this frame is — `ViewDef.id`.
   *
   * Not a capability: a panel knowing its own identity is not a privilege,
   * and without it a package that ships several views out of one bundle (the
   * frame evals exactly one script, so that is the normal shape) cannot tell
   * which one it was opened as. The workaround until now was to infer it from
   * the artifact's type, which stops working the moment two views apply to
   * the same type — an editor and a runner for the same questionnaire, say.
   */
  viewId?: string;
  /** Called after `promenade.publishLog()` committed, so the shell can select and open it. */
  onPublishedArtifact?: (a: Artifact) => void;
  /**
   * Backs `promenade.openView()`: resolves the target artifact against the
   * live catalog and asks the host to open (or focus) the requested view,
   * the same "is a panel for this pair already open" check every other
   * opener in the app shares. Absent for an embedding (standalone/live
   * panels) that hasn't wired a workspace to open a view into.
   */
  onOpenView?: (
    artifactId: string, viewId?: string, viewParams?: Record<string, unknown>,
    placement?: { beside: 'left' | 'right'; fromPanelId: string },
  ) => { ok: boolean; error?: string };
  /**
   * Run-bound live preview: `artifact` is synthetic and value-less, the
   * frame is told `runState: 'running'`, and this panel forwards `liveRun`'s
   * structured frame batches into the sandbox as `liveFrame` messages until
   * the run finishes (then a real artifact tab replaces this one).
   */
  live?: boolean;
  params?: Record<string, unknown>;
  /** Payload for an inline artifact whose value lives in the result store. */
  inlineValue?: unknown;
  /**
   * Lets the plugin push its own param changes back through the Inspector's
   * param state — the plugin-side counterpart of `params` flowing in.
   * Undefined for a host that hasn't wired a tab-scoped update function in
   * (e.g. an older embedding), in which case `setParams` calls are dropped.
   */
  onParamChange?: (key: string, value: unknown) => void;
  /** Commits the catalog after the narrow typed publish request below. */
  onGraphUpdated?: (catalog: import('../host/artifact/types').ProvenanceGraph) => void;
  /** The manifest provider that owns this frame's code. */
  provider?: string;
  /** The partition's canonical OCEL source, exposed as names only to the frame. */
  sourceArtifact?: Artifact;
  /**
   * Source-bound Atlas cohorts the host has explicitly made comparable. This
   * stays a narrow, Atlas-only population capability — it is not a catalog
   * read API for arbitrary iframe code.
   */
  comparisonCohorts?: Artifact[];
  /** Exact lasso cohorts advertised only to a manifest-opted-in compatible view. */
  interactionSelections?: Artifact[];
  /** Candidate OCEL/OCPN replay evidence advertised only to the Atlas. */
  replayEvidence?: Artifact[];
  /**
   * Key for `promenade.cachedState()`/`setCachedState()`, stable across a
   * close-then-reopen of this same artifact+view — unlike `panelId`, which
   * is dockview's own per-instantiation id (`` `${tab.id}#${seq++}` ``, see
   * `Workspace.tsx`) and therefore different every time a panel is created,
   * including on every reopen. Caching by `panelId` would compile and run
   * without error, and would just never hit: every reopen mints a fresh
   * `panelId`, so every reopen was a guaranteed cache miss. Falls back to
   * `panelId` only so a caller that genuinely has nothing more stable still
   * gets *a* key rather than a crash — that caller just won't benefit from
   * caching across a close/reopen.
   */
  cacheKey?: string;
}) {
  const stateCacheKey = cacheKey ?? panelId;
  const comparisonCohortKey = (comparisonCohorts ?? []).map((candidate) => `${candidate.id}:${(candidate.meta as any)?.rev ?? ''}`).sort().join('|');
  const interactionSelectionKey = (interactionSelections ?? []).map((candidate) => `${candidate.id}:${(candidate.meta as any)?.rev ?? ''}`).sort().join('|');
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const port = useRef<MessagePort | null>(null);
  // An effect that pushes parameters can run before a newly created iframe
  // has installed its port listener. Keep the latest values here and send
  // them as part of the ready handshake as well.
  const latestParams = useRef<Record<string, unknown>>({});
  latestParams.current = params ?? {};
  // Read inside a handshake closure that is only rebuilt on `send()`
  // (mount, plus a rare same-element reload), so a fresh callback identity
  // from a re-render must reach it through a ref rather than by capture.
  const onParamChangeRef = useRef(onParamChange);
  onParamChangeRef.current = onParamChange;
  // Same reason as above: the publish handler lives inside the handshake
  // closure, so a fresh callback identity has to reach it through a ref.
  const onPublishedRef = useRef(onPublishedArtifact);
  onPublishedRef.current = onPublishedArtifact;
  // Same reason again: `openView` lives inside the handshake closure too.
  const onOpenViewRef = useRef(onOpenView);
  onOpenViewRef.current = onOpenView;

  useEffect(() => {
    const el = holder.current!;
    const iframe = document.createElement('iframe');
    // No allow-same-origin: the frame gets an opaque origin, so it has no
    // access to the host's DOM, storage or credentialed network.
    //
    // srcdoc rather than a served URL: it guarantees the opaque origin without
    // a second document to host, and it avoids depending on subresource loads
    // from an opaque origin, which are not reliably permitted.
    // allow-downloads: without it, a sandboxed frame's `<a download>` click
    // is silently a no-op (no error, no navigation) — this is what let
    // plugin figure-export buttons sit there doing nothing. It doesn't grant
    // same-origin access; the browser still routes it through its own
    // save-file UI.
    iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
    iframe.srcdoc = frameHtml;
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block';
    el.appendChild(iframe);
    frame.current = iframe;

    let canceled = false;
    const cancellableSql = new Map<number, () => Promise<boolean>>();
    // Read by every OTHER sender below (selection/theme/resize) at send
    // time, never captured once — so they keep targeting whichever
    // handshake is actually current after a re-handshake (see `send`),
    // instead of silently writing into a port the frame on the other end
    // stopped listening on.
    let currentPort: MessagePort | null = null;
    let pluginReady = false;

    const sendInitialState = () => {
      if (!currentPort || !pluginReady) return;
      const rect = el.getBoundingClientRect();
      // ResizeObserver's first asynchronous callback can happen before the
      // frame has received its port. Sending the measured rect *after* the
      // plugin says it has registered its handlers prevents a view from
      // loading data at 0×0 and waiting forever for the next viewport resize.
      currentPort.postMessage({ type: 'resize', payload: { w: rect.width, h: rect.height } });
      currentPort.postMessage({
        type: 'theme', payload: { theme: readTheme(), colors: colorRegistry.toJSON() },
      });
      currentPort.postMessage({ type: 'params', payload: latestParams.current });
      flushLive();
    };

    // Run-bound live preview: forward `liveRun`'s structured frame batches
    // into the frame as they arrive. `liveSent` tracks how many of the
    // (append-only) batches have already crossed, so a late handshake or a
    // re-handshake replays the backlog exactly once per port.
    let liveSent = 0;
    // The last state posted, so a `liveRun` emit that only appended a frame
    // doesn't also re-post an unchanged running state on every batch.
    let liveStateSent = '';
    const flushLive = () => {
      if (!live || !currentPort || !pluginReady) return;
      const snap = liveRun.current();
      if (!snap) return;
      for (; liveSent < snap.frames.length; liveSent++) {
        currentPort.postMessage({ type: 'liveFrame', payload: snap.frames[liveSent] });
      }
      // Posted while still running too, not only at the end: coarse
      // progress is the whole of what a standby live preview has to show,
      // and an action whose kernel cannot describe its intermediate state
      // (every wasm one) emits nothing else.
      const stateKey = `${snap.state}|${snap.message}|${snap.fraction ?? ''}`;
      if (stateKey !== liveStateSent) {
        liveStateSent = stateKey;
        currentPort.postMessage({
          type: 'liveRunState',
          payload: { state: snap.state, message: snap.message, fraction: snap.fraction },
        });
      }
    };
    const liveUnsub = live ? liveRun.subscribe(flushLive) : null;

    async function onPortMessage(e: MessageEvent) {
      const m = e.data;

      if (m.type === 'ready') {
        pluginReady = true;
        sendInitialState();
        return;
      }


      if (m.type === 'sql') {
        try {
          const table = await dataClient.sql(m.payload.text);
          const { payload, transfer } = toColumns(table);
          currentPort?.postMessage({ type: 'result', id: m.id, payload }, transfer);
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'sqlCancelable') {
        const request = dataClient.sqlCancelable(m.payload.text);
        cancellableSql.set(m.id, request.cancel);
        try {
          const table = await request.promise;
          const { payload, transfer } = toColumns(table);
          currentPort?.postMessage({ type: 'result', id: m.id, payload }, transfer);
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        } finally {
          cancellableSql.delete(m.id);
        }
        return;
      }

      if (m.type === 'cancelSql') {
        await cancellableSql.get(Number(m.payload?.id))?.();
        return;
      }

      if (m.type === 'cache') {
        writePanelCache(stateCacheKey, m.payload);
        return;
      }

      if (m.type === 'cachedState') {
        // An RPC, not part of `init`'s payload — see `cachedState`'s doc
        // comment in plugin-frame.html for why: a large cached value costs
        // real structured-clone time, and paying that cost as part of
        // `init` lands it before the plugin's own code has run even once,
        // when nothing could paint a loading state regardless. Asking for
        // it over the port instead means the plugin has already mounted
        // and rendered *something* by the time this reply arrives.
        currentPort?.postMessage({ type: 'result', id: m.id, payload: readPanelCache(stateCacheKey) });
        return;
      }

      if (m.type === 'workspace') {
        // Declared, like every other capability here. Answering with ids,
        // labels and the parameters the host already owns — never a row of
        // anybody's data, which stays behind `sql()`.
        if (!readsWorkspace) {
          currentPort?.postMessage({
            type: 'error', id: m.id,
            error: 'This view does not declare that it reads the workspace.',
          });
          return;
        }
        currentPort?.postMessage({ type: 'result', id: m.id, payload: { panels: workspaceState.get() } });
        return;
      }

      if (m.type === 'publishArtifact') {
        try {
          const type = String(m.payload?.type ?? '');
          // Two gates, and they are not the same question. `publishes` is
          // what this *view* said it would write — the user consented to it
          // at install and can read it in the plugin manager. The registry
          // check is what stops a package publishing a type it did not
          // define: without it, any manifest could declare
          // `publishes: ["AcceptingPetriNet"]` and put a forged model in the
          // catalog.
          if (!publishes?.includes(type)) {
            throw new Error(`This view does not declare it publishes ${type || 'artifacts'}.`);
          }
          // Read the catalog rather than trusting a prop: dockview fixes a
          // panel's params at creation time, so a `graph` handed in that way
          // is a snapshot from whenever this panel opened — and an input
          // published five minutes ago would fail to validate against it.
          // One worker round-trip, on an explicit user action.
          const { catalog } = await dataClient.catalog();
          const built = buildPublishedArtifact({
            request: { ...(m.payload ?? {}), type },
            provider: provider ?? 'unknown',
            graph: catalog,
            ownTypes: (candidate) => artifactTypes.get(candidate)?.provider === provider,
          });
          // Materialize before the catalog row exists, then correct the row —
          // the same order `publishLog` uses, so a failed write never leaves
          // a catalog entry pointing at a payload that was never written.
          if (built.materialize) {
            const materialized = await dataClient.materializeArtifactJson(built.artifact.id, m.payload?.value);
            built.artifact.storage = materialized.storage;
          }
          const r: any = await dataClient.putArtifact(built.artifact, built.execution ?? undefined);
          onGraphUpdated?.(r.catalog);
          onPublishedRef.current?.(built.artifact);
          currentPort?.postMessage({
            type: 'result', id: m.id,
            payload: { id: built.artifact.id, name: built.artifact.name, type },
          });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'deriveLog') {
        try {
          // Same two-gate shape as `publishArtifact`: the manifest says this
          // view may propose repairs, and the shell decides what they apply
          // to. Nothing in the message names a target artifact, so a frame
          // cannot reach a log it was not opened against.
          if (!derivesLogs) {
            throw new Error('This view does not declare that it derives logs.');
          }
          if (!onDeriveLog) {
            throw new Error('This panel is not attached to a workspace that can derive a log.');
          }
          const ops = Array.isArray(m.payload?.ops) ? m.payload.ops : [];
          if (!ops.length) throw new Error('No operations to apply.');
          const result = await onDeriveLog(artifact.id, ops);
          currentPort?.postMessage({ type: 'result', id: m.id, payload: result });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'files' || m.type === 'openFile') {
        // The manifest is the authority, exactly as it is for `publishLog`.
        // Both calls are scoped to `artifact.id` by the host, never by the
        // frame: a path is the only thing the plugin gets to name, and the
        // worker rejects any path that is not a plain relative name inside
        // that one directory.
        try {
          if (!readsFiles) {
            throw new Error('This view does not declare that it reads artifact files.');
          }
          if (m.type === 'files') {
            const { entries } = await dataClient.artifactFiles(artifact.id);
            currentPort?.postMessage({ type: 'result', id: m.id, payload: { entries } });
          } else {
            const opened = await dataClient.artifactFile(
              artifact.id, String(m.payload?.path ?? ''),
              m.payload?.maxBytes == null ? undefined : Number(m.payload.maxBytes)
            );
            // Bytes are transferred rather than copied — a materialized JSON
            // payload can be megabytes, and it has already been copied once
            // out of OPFS to get here.
            const transfer = opened.kind === 'bytes' ? [opened.bytes.buffer] : [];
            currentPort?.postMessage({ type: 'result', id: m.id, payload: opened }, transfer);
          }
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'select') {
        // Selections from a plugin are re-stamped with the artifact id by the
        // host. A plugin cannot claim a selection on someone else's artifact.
        selectionBus.set(
          (m.payload.items ?? []).map((i: any) => ({
            artifactId: artifact.id, kind: i.kind, id: String(i.id),
          })),
          panelId
        );
        return;
      }

      if (m.type === 'setParams') {
        // One host update per key, same shape as ParamControls' own
        // onChange — the plugin is just another author of the same params
        // a manifest-declared control would have produced.
        const patch = (m.payload ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(patch)) onParamChangeRef.current?.(key, patch[key]);
        return;
      }

      if (m.type === 'openView') {
        const handler = onOpenViewRef.current;
        if (!handler) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: 'Opening views is not available here.' });
          return;
        }
        const artifactId = String(m.payload?.artifactId ?? '');
        const targetViewId = m.payload?.viewId ? String(m.payload.viewId) : undefined;
        // A placement *hint*, not geometry: "put it beside me, on this side".
        // The host still decides what that means — it resolves to the same
        // `OpenTab.splitFrom` mechanism "Compare side by side" uses. Without
        // it a plugin's `openView` lands in the active group, i.e. as a tab
        // on top of the very panel that asked for it, which for a panel
        // whose job is to show something *next to* itself is never right.
        const beside = m.payload?.beside === 'left' || m.payload?.beside === 'right'
          ? { beside: m.payload.beside as 'left' | 'right', fromPanelId: panelId }
          : undefined;
        const result = handler(artifactId, targetViewId, m.payload?.params as Record<string, unknown> | undefined, beside);
        if (result.ok) currentPort?.postMessage({ type: 'result', id: m.id, payload: null });
        else currentPort?.postMessage({ type: 'error', id: m.id, error: result.error ?? 'Could not open that view.' });
        return;
      }

      if (m.type === 'publishExecutionPartition') {
        try {
          // This is deliberately not a general write API for iframe code.
          // The first cross-plugin artifact is narrowly scoped to the one
          // producer implementing Adams-style execution extraction; the host
          // validates its schema, source binding and inline-size limit before
          // it reaches the catalog.
          if (provider !== 'run.promenade.ocel-cases-variants') {
            throw new Error('This plugin is not authorized to publish execution partitions.');
          }
          const built = buildExecutionPartitionArtifact({
            source: artifact, payload: m.payload?.payload, name: m.payload?.name, provider,
          });
          if (built.artifact.storage.kind === 'json') {
            const materialized = await dataClient.materializeArtifactJson(built.artifact.id, m.payload?.payload);
            built.artifact.storage = materialized.storage;
          }
          const r: any = await dataClient.putArtifact(built.artifact, built.execution);
          onGraphUpdated?.(r.catalog);
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id: built.artifact.id, name: built.artifact.name } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'publishLog') {
        try {
          const type = String(m.payload?.type ?? '');
          // The manifest's own `publishes` declaration is the authority —
          // installed, user-visible, and per view. A provider allowlist here
          // (as the two cohort capabilities above still carry) would mean
          // every future authoring plugin needs a core edit to be allowed to
          // do the thing its manifest already says it does.
          if (!publishes?.includes(type)) {
            throw new Error(`This view does not declare it publishes ${type || 'artifacts'}.`);
          }
          const request = { ...(m.payload ?? {}), type } as AuthoredLogRequest;
          // Both validations run before anything is written: a rejected
          // declaration must not leave Parquet behind under an id no
          // catalog row will ever point at.
          const semantics = authoredSemantics(request);
          const { relations, summary } = buildAuthoredOcelRelations(request);
          // The id has to exist before the artifact does: Parquet is written
          // under it first, and only the resulting storage/meta complete the
          // row — the same order `bridge-host.ts`'s `publishEventLog` uses.
          const id = `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          // A log edited from another one is a child of it; one written from
          // scratch is a root, exactly like an import. Which of the two this
          // is depends on the request naming a source, and the check is
          // against the artifact this frame was actually bound to.
          const execution = request.source
            ? buildEditedLogExecution({
              source: artifact, claimedSource: request.source, outputId: id,
              provider: provider ?? 'unknown', summary,
            })
            : null;
          const materialized: any = await dataClient.materializeNotebookLog({ id, targetType: type, relations });
          const authored: Artifact = {
            id,
            name: request.name.trim(),
            type,
            createdAt: new Date().toISOString(),
            storage: materialized.storage,
            meta: {
              ...materialized.meta,
              semantics,
              // Where the rows came from is worth recording either way: a
              // hand-authored log has no earlier artifact behind it, but it
              // does have an author, and provenance can show that.
              authoredBy: { plugin: provider ?? 'unknown', rows: summary },
            },
            producedBy: execution?.id ?? null,
            inputs: execution ? [artifact.id] : [],
          };
          const r: any = await dataClient.putArtifact(authored, execution ?? undefined);
          onGraphUpdated?.(r.catalog);
          onPublishedRef.current?.(authored);
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id, name: authored.name, type } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'publishInteractionCohort') {
        try {
          // Like execution partitions, cohorts are the host-owned boundary
          // between a sandboxed analytical view and the provenance graph.
          // Keep the authority narrow: the Atlas may publish only the typed
          // membership artifact it declares, never an arbitrary catalog row.
          if (provider !== 'run.promenade.interaction-atlas') {
            throw new Error('This plugin is not authorized to publish interaction cohorts.');
          }
          const canonicalSource = sourceArtifact?.type === 'ObjectCentricEventLog' ? sourceArtifact : artifact;
          const built = buildInteractionCohortArtifact({
            source: canonicalSource, payload: m.payload?.payload, name: m.payload?.name, provider,
          });
          if (built.artifact.storage.kind === 'json') {
            const materialized = await dataClient.materializeArtifactJson(built.artifact.id, m.payload?.payload);
            built.artifact.storage = materialized.storage;
          }
          const r: any = await dataClient.putArtifact(built.artifact, built.execution);
          onGraphUpdated?.(r.catalog);
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id: built.artifact.id, name: built.artifact.name } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'readComparisonCohort') {
        try {
          if (provider !== 'run.promenade.interaction-atlas') {
            throw new Error('This plugin is not authorized to read comparison cohort membership.');
          }
          const canonicalSource = sourceArtifact?.type === 'ObjectCentricEventLog' ? sourceArtifact : artifact;
          const candidate = (comparisonCohorts ?? []).find((item) => item.id === String(m.payload?.id));
          if (!candidate || candidate.type !== 'ObjectCentricInteractionCohort' || !candidate.inputs.includes(canonicalSource.id)) {
            throw new Error('Comparison cohort is not source-bound to this Atlas.');
          }
          const value = candidate.storage.kind === 'inline'
            ? (candidate.storage as any).value ?? null
            : candidate.storage.kind === 'json'
              ? await dataClient.readArtifactJson(candidate.id)
              : null;
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id: candidate.id, name: candidate.name, value } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'readInteractionSelection') {
        try {
          const canonicalSource = sourceArtifact?.type === 'ObjectCentricEventLog' ? sourceArtifact : artifact;
          const candidate = (interactionSelections ?? []).find((item) => item.id === String(m.payload?.id));
          if (!candidate || candidate.type !== 'ObjectCentricInteractionCohort' || !candidate.inputs.includes(canonicalSource.id)) {
            throw new Error('Interaction selection is not source-bound to this view.');
          }
          const value = candidate.storage.kind === 'inline'
            ? (candidate.storage as any).value ?? null
            : candidate.storage.kind === 'json'
              ? await dataClient.readArtifactJson(candidate.id)
              : null;
          const selection = requireInteractionCohort(value, canonicalSource.id);
          if (!isLassoInteractionSelection(selection, canonicalSource.id)) {
            throw new Error('This shared selection does not contain an exact lifecycle-bin mask.');
          }
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id: candidate.id, name: candidate.name, value: selection } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }

      if (m.type === 'readReplayEvidence') {
        try {
          if (provider !== 'run.promenade.interaction-atlas') throw new Error('This plugin is not authorized to read replay evidence.');
          const canonicalSource = sourceArtifact?.type === 'ObjectCentricEventLog' ? sourceArtifact : artifact;
          const candidate = (replayEvidence ?? []).find((item) => item.id === String(m.payload?.id));
          if (!candidate || candidate.type !== 'ObjectCentricReplayEvidence' || !candidate.inputs.includes(canonicalSource.id)) {
            throw new Error('Replay evidence is not source-bound to this Atlas.');
          }
          const value = candidate.storage.kind === 'inline' ? (candidate.storage as any).value ?? null
            : candidate.storage.kind === 'json' ? await dataClient.readArtifactJson(candidate.id) : null;
          requireObjectCentricReplayEvidence(value, canonicalSource.id);
          currentPort?.postMessage({ type: 'result', id: m.id, payload: { id: candidate.id, name: candidate.name, value } });
        } catch (err: any) {
          currentPort?.postMessage({ type: 'error', id: m.id, error: String(err.message ?? err) });
        }
        return;
      }
    }

    /**
     * Handshake: fetch the plugin bundle, then hand it in with a fresh port.
     *
     * Runs again on every genuine `load`, not just the first. A docking
     * layout that lazily shows/hides panels can reparent a hidden panel's
     * DOM subtree when its tab becomes active again — and moving an
     * `<iframe>` element to a new place in the DOM makes the browser reload
     * its document (a standard, if easy to forget, iframe behavior), which
     * fires `load` again on the very same element. React never reruns this
     * effect for that (no dependency changed), so a one-shot "only the
     * first load counts" guard left the reloaded frame's `window.promenade`
     * permanently unset — blank forever, no error, because the plugin
     * bundle was never handed an `init` message the second time. A previous
     * port cannot be reused for the resend (a `MessagePort` transfers
     * exactly once), so each call opens its own fresh `MessageChannel`.
     *
     * The host fetching the bundle is not a workaround for convenience — an
     * opaque-origin frame cannot depend on loading its own subresources. It
     * also puts the host in a position to pin or verify a bundle's hash before
     * any of it executes.
     */
    const send = async () => {
      // Never hand a plugin its bundle before the panel has a box — see
      // `whenSized`. This is the one gate every view passes through, on the
      // first load and on each reparent-induced reload alike.
      if (!(await whenSized(el, () => canceled))) return;
      const channel = new MessageChannel();
      currentPort?.close();
      currentPort = channel.port1;
      port.current = channel.port1;
      pluginReady = false;
      // A reloaded frame (DOM reparenting) needs the whole live backlog again.
      liveSent = 0;
      liveStateSent = '';
      channel.port1.onmessage = onPortMessage;

      let source: string;
      try {
        if (entry.startsWith('opfs:')) {
          // A packaged view's script lives in the plugin store, not on a URL —
          // `fetch('opfs:…')` has no scheme handler and fails. Reading it here
          // also keeps the host in the position to check the bytes before any
          // of them execute.
          const [pluginId, ...rest] = entry.slice('opfs:'.length).split('/');
          const bytes = await readPluginFile(pluginId, rest.join('/'));
          source = new TextDecoder().decode(bytes);
        } else {
          const res = await fetch(entry);
          if (!res.ok) throw new Error(`${res.status}`);
          source = await res.text();
        }
      } catch (err: any) {
        console.error('[plugin] could not load bundle', entry, err);
        return;
      }
      if (canceled) return;

      const tables: Record<string, string> = {};
      for (const logical of logicalTablesOf(artifact)) {
        tables[logical] = tableOf(artifact.id, logical);
      }
      /**
       * Small artifacts travel as a value; logs never do.
       *
       * "Never its contents" was always a statement about *table* data — a log
       * must not cross the boundary, which is why `sql()` exists. A process
       * tree or a Petri net has no table to query: the payload is the artifact,
       * it is kilobytes, and a viewer that cannot see it cannot draw it.
       */
      const value = live
        ? (inlineValue ?? null)
        : artifact.storage.kind === 'inline'
          ? (inlineValue ?? (artifact.storage as any).value ?? null)
          : artifact.storage.kind === 'json'
            ? await dataClient.readArtifactJson(artifact.id)
            : null;
      // Materialized membership can take long enough to hydrate that the
      // iframe is reloaded meanwhile. Never hand a stale port to a newer
      // frame (or a detached one).
      if (canceled || currentPort !== channel.port1) return;
      const cohorts = provider === 'run.promenade.interaction-atlas'
        ? (comparisonCohorts ?? []).map((candidate) => ({ id: candidate.id, name: candidate.name, meta: candidate.meta }))
        : [];
      const selections = (interactionSelections ?? []).map((candidate) => ({
        id: candidate.id, name: candidate.name,
        selection: (candidate.meta as any)?.selection ?? null,
      }));
      const evidence = provider === 'run.promenade.interaction-atlas'
        ? (replayEvidence ?? []).map((candidate) => ({ id: candidate.id, name: candidate.name, meta: candidate.meta }))
        : [];
      // Declared OCEL/XES schema (attribute names + types, per object/event
      // type) — computed once at ingest and already public metadata (it says
      // nothing about the log's actual rows), just not previously forwarded
      // across the sandbox boundary. A view that wants to draw a type's
      // declared attributes (e.g. a schema graph) would otherwise have no way
      // to ask for it, since none of it lives in a queryable table.
      const semantics = (artifact.meta as any)?.semantics ?? null;
      const sourceTables: Record<string, string> = {};
      if (sourceArtifact) {
        for (const logical of logicalTablesOf(sourceArtifact)) sourceTables[logical] = tableOf(sourceArtifact.id, logical);
      }
      iframe.contentWindow!.postMessage(
        {
          type: 'init',
          entry,
          source,
          // Metadata and table names only — never contents, never a handle.
          viewId: viewId ?? null,
          viewLabel: viewId ? viewRegistry.get(viewId)?.label ?? '' : '',
          artifact: {
            id: artifact.id, name: artifact.name, type: artifact.type, tables, value, semantics,
            ...(live ? { runState: 'running' as const } : {}),
            // A partition has no rows of its own. Its declared source does,
            // and only table names (not rows or handles) cross the boundary.
            source: sourceArtifact ? {
              id: sourceArtifact.id, name: sourceArtifact.name, type: sourceArtifact.type,
              tables: sourceTables, semantics: (sourceArtifact.meta as any)?.semantics ?? null,
            } : null,
            comparisonCohorts: cohorts,
            interactionSelections: selections,
            replayEvidence: evidence,
          },
          theme: readTheme(),
          colors: colorRegistry.toJSON(),
        },
        '*',
        [channel.port2]
      );
    };
    iframe.addEventListener('load', send);

    // Diagnostics from inside the sandbox. The frame cannot be inspected from
    // here, so it reports failures outward on the window channel.
    const onFrameNote = (e: MessageEvent) => {
      // No source check: comparing against a sandboxed frame's WindowProxy is
      // unreliable, and this channel carries diagnostics only.
      if (!e.data?.__plugin) return;
      if (e.data.__plugin === 'error') console.error(`[plugin ${entry}]`, e.data.message);
      else if (import.meta.env.DEV) console.debug('[plugin]', e.data.stage, e.data.detail ?? '');
    };
    window.addEventListener('message', onFrameNote);

    // The arrangement is forwarded the same way selection is, and only to a
    // frame that declared it wants it. A view whose subject is the other
    // panels has to learn that a slider moved next door; polling for it
    // would be the alternative, and a worse one.
    const unsubWorkspace = readsWorkspace
      ? workspaceState.subscribe((panels) => {
        currentPort?.postMessage({ type: 'workspace', payload: { panels } });
      })
      : null;

    // Selection is forwarded so linked highlighting works across the boundary.
    const unsubSel = selectionBus.subscribe((sel) => {
      if (sel.source === panelId) return; // don't echo the plugin's own change
      currentPort?.postMessage({ type: 'selection', payload: sel });
    });
    const unsubColor = colorRegistry.subscribe(() => {
      currentPort?.postMessage({
        type: 'theme', payload: { theme: readTheme(), colors: colorRegistry.toJSON() },
      });
    });

    const ro = new ResizeObserver(([entryBox]) => {
      const r = entryBox.contentRect;
      if (pluginReady) currentPort?.postMessage({ type: 'resize', payload: { w: r.width, h: r.height } });
    });
    ro.observe(el);

    // Watches the resolved theme rather than the media query directly: an
    // explicit Light/Dark pick from the Help menu changes the tokens without
    // the OS scheme moving at all, and a frame that only listened to the OS
    // would keep painting the previous palette until it was rebuilt.
    const unsubTheme = subscribeTheme(() => currentPort?.postMessage({
      type: 'theme', payload: { theme: readTheme(), colors: colorRegistry.toJSON() },
    }));

    return () => {
      canceled = true;
      for (const cancel of cancellableSql.values()) void cancel();
      cancellableSql.clear();
      ro.disconnect();
      unsubTheme();
      window.removeEventListener('message', onFrameNote);
      unsubSel();
      unsubWorkspace?.();
      unsubColor();
      liveUnsub?.();
      currentPort?.close();
      iframe.remove();
    };
    // `inlineValue` is in the dependencies, so a live recompute rebuilds the
    // frame around the new payload.
    //
    // The payload is only sent in `init`, and until this was listed here a
    // recomputed artifact left its viewer drawing the previous result — no
    // error, no console message, just a picture that quietly stopped matching
    // the parameters beside it. Pushing a new message type instead would be
    // cheaper, but every existing view plugin would have to learn it, and the
    // ones that had not would go on being silently wrong. Re-initializing is
    // correct for a viewer that has never been updated, and these payloads are
    // kilobytes. Log artifacts are unaffected: they carry no inline value, so
    // this stays referentially stable for them.
    //
    // A table-backed log needs the same treatment for a different reason: its
    // data lives behind a stable view name (`tableOf(artifact.id, logical)`
    // never changes), so a transform edit elsewhere leaves every OTHER panel
    // already open on this same artifact — a table, a chart, anything that
    // queried it before the edit — silently showing the pre-edit rows, since
    // nothing tells an idle plugin its own last query is now stale. `rev` is
    // the transform editor's own "this artifact's plan just changed" signal
    // (`onPlanChange`, App.tsx); including it here re-runs the same
    // re-initialise path `inlineValue` already relies on, so every plugin
    // picks up fresh data the moment it changes, with nothing plugin-side to
    // opt into.
  }, [artifact.id, entry, panelId, inlineValue, stateCacheKey, sourceArtifact?.id, comparisonCohortKey, interactionSelectionKey, live, (replayEvidence ?? []).map((candidate) => `${candidate.id}:${(candidate.meta as any)?.rev ?? ''}`).sort().join('|'), (artifact.meta as any)?.rev]);

  // Parameter changes are pushed; the plugin decides whether to re-query.
  useEffect(() => {
    port.current?.postMessage({ type: 'params', payload: params ?? {} });
  }, [params]);

  return <div ref={holder} style={{ width: '100%', height: '100%' }} />;
}
