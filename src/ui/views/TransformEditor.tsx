import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { Artifact, ProvenanceGraph } from '../../host/artifact/types';
import {
  OP_GROUP, OP_LABEL, describeOp, isComplete, newOp,
  type ObjectSplitRule, type RelationCountCondition, type TransformOp, type TransformOpKind,
  type ValueScope,
} from '../../host/transform/types';
import { exportOperation, exportPlan, importOperations } from '../../host/transform/serialization';
import { fmtCount } from '../format';
import { num, useQuery } from './useQuery';
import { tableOf } from './tableName';
import {
  clampRangeHandle, epochAtPercent, keyboardPercent, percentAtEpoch, pointerPercent,
  type RangeHandle,
} from './rangeMath';

/**
 * Editor for a derived log's transformation plan.
 *
 * A host view, like the script editor — the "plugin UIs should be possible but
 * inconvenient" rule is about plugins shipping their own parameter panels, not
 * about the host. It is a panel rather than an inspector section because an
 * ordered, growing list of operations with a form each does not fit a 320 px
 * column, and because the inspector's job is the primary parameter and the
 * live loop.
 *
 * Editing is declarative throughout: an operation says what changes, never
 * which rows were touched. That is the whole reason the result is
 * reproducible — and why this is not a spreadsheet over five million events.
 */

const KINDS: TransformOpKind[] = [
  'filterActivities', 'filterObjectTypes', 'filterEventAttribute', 'filterObjectAttribute',
  'filterE2oCount', 'filterO2oCount', 'timeRange', 'filterCases', 'variantMinCases',
  'renameActivity', 'renameObjectType', 'mergeActivities', 'mergeObjectTypes', 'splitObjectType',
  'removeEventAttributes', 'removeObjectAttributes', 'removeCaseAttributes',
  'flattenByObjectType',
];

export function TransformEditor({
  artifact, graph, onPlanChange,
}: {
  artifact: Artifact;
  graph?: ProvenanceGraph;
  onPlanChange?: (artifact: Artifact, ops: TransformOp[]) => Promise<void> | void;
}) {
  const plan = artifact.storage.kind === 'view' ? artifact.storage.plan : null;
  const [ops, setOps] = useState<TransformOp[]>(plan?.ops ?? []);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const importPlanRef = useRef<HTMLInputElement>(null);
  const importOperationRef = useRef<HTMLInputElement>(null);

  // Adopt the stored plan when the panel is pointed at a different artifact,
  // but not on every rebuild — that would fight the user's typing.
  const forId = useRef(artifact.id);
  useEffect(() => {
    if (forId.current === artifact.id) return;
    forId.current = artifact.id;
    setOps(plan?.ops ?? []);
  }, [artifact.id]);

  const source = plan ? graph?.artifacts[plan.source] : undefined;
  const isOcelSource = source?.type === 'ObjectCentricEventLog';
  const isOcelArtifact = artifact.type === 'ObjectCentricEventLog';

  const apply = async (next: TransformOp[]) => {
    setOps(next);
    if (!onPlanChange) return;
    setBusy(true);
    try { await onPlanChange(artifact, next); } finally { setBusy(false); }
  };

  // A field's `onChange` fires per keystroke, and every `apply` is a full
  // worker round trip: re-read the catalog, recompile every dependent
  // view, recompute stats, and persist the catalog back to OPFS. Committing
  // immediately on each keystroke queued up a backlog of redundant
  // recomputes behind fast typing — and, before the catalog write was
  // serialized (see `writeCatalog` in host/data/opfs.ts), could even race
  // two overlapping writes into the same OPFS access handle. Debouncing the
  // commit — while still updating `ops` (and so every field's own value)
  // immediately, so typing itself never lags — fixes both: only the last
  // keystroke in a burst actually triggers a recompute.
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPatch = useRef<TransformOp[] | null>(null);
  useEffect(() => () => {
    // Flush a still-pending edit on unmount rather than silently dropping
    // whatever the user typed right before navigating away.
    if (patchTimer.current) {
      clearTimeout(patchTimer.current);
      if (pendingPatch.current) apply(pendingPatch.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const patch = (i: number, p: Partial<TransformOp>) => {
    const next = ops.map((o, j) => (j === i ? { ...o, ...p } as TransformOp : o));
    setOps(next);
    pendingPatch.current = next;
    setBusy(true);
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = setTimeout(() => {
      patchTimer.current = null;
      const toApply = pendingPatch.current;
      pendingPatch.current = null;
      if (toApply) apply(toApply);
    }, 400);
  };

  /** A structural edit must not be overwritten by an older debounced field edit. */
  const applyImmediately = (next: TransformOp[]) => {
    if (patchTimer.current) clearTimeout(patchTimer.current);
    patchTimer.current = null;
    pendingPatch.current = null;
    return apply(next);
  };

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ops.length) return;
    if (ops[i].kind === 'flattenByObjectType' || ops[j].kind === 'flattenByObjectType') return;
    const next = [...ops];
    [next[i], next[j]] = [next[j], next[i]];
    applyImmediately(next);
  };

  const download = (definition: unknown, filename: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(definition, null, 2)], {
      type: 'application/json',
    }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importDefinition = async (event: ChangeEvent<HTMLInputElement>, scope: 'plan' | 'operation') => {
    const file = event.target.files?.[0];
    // Reset first so selecting the same file again still triggers an import.
    event.target.value = '';
    if (!file) return;
    try {
      const imported = importOperations(await file.text());
      if (scope === 'operation' && imported.length !== 1) {
        throw new Error('Choose a file containing exactly one operation.');
      }
      setTransferError(null);
      setAdding(false);
      const next = scope === 'plan' ? imported : [...ops, imported[0]];
      if (next.findIndex((op) => op.kind === 'flattenByObjectType') > 0) {
        throw new Error('Flatten by object type can only be the first operation.');
      }
      await applyImmediately(next);
    } catch (error: any) {
      setTransferError(`Could not import ${scope === 'plan' ? 'operations' : 'operation'}: ${error.message}`);
    }
  };

  if (!plan) {
    return <div className="view"><div className="err">
      This artifact is not a derived log.
    </div></div>;
  }

  return (
    <div className="view tf">
      <div className="tf-head">
        <div>
          <strong>{artifact.name}</strong>
          <div className="tf-sub">
            derived from {source?.name ?? plan.source} · no storage used until materialised
          </div>
        </div>
        <div className="tf-transfer-actions">
          <button onClick={() => download(exportPlan(ops), 'transform-operations.json')}>
            Export all
          </button>
          <button onClick={() => importPlanRef.current?.click()}>
            Import all
          </button>
        </div>
        {busy && <span className="script-status">recomputing…</span>}
      </div>

      <input ref={importPlanRef} className="tf-file-input" type="file" accept="application/json,.json"
             onChange={(event) => void importDefinition(event, 'plan')} />
      <input ref={importOperationRef} className="tf-file-input" type="file" accept="application/json,.json"
             onChange={(event) => void importDefinition(event, 'operation')} />

      <Counts artifact={artifact} source={source} />
      {transferError && <div className="err">{transferError}</div>}
      {ops.some((o) => o.kind === 'flattenByObjectType' && !o.disabled && !o.objectType) && (
        <div className="why">
          Pick a case notion below. Until then this log is empty — its shape is
          already traditional, its content is not decided yet.
        </div>
      )}
      {ops.some((o) => o.kind === 'flattenByObjectType' && !o.disabled && !!o.objectType) && (
        <div className="why">
          Flattening is lossy in both directions: an event related to several
          objects of this type is duplicated, and an event related to none is
          dropped. The event count above shows the net effect.
        </div>
      )}

      <ol className="tf-ops">
        {ops.map((op, i) => (
          <li key={i} className={'tf-op' + (isComplete(op) ? '' : ' tf-incomplete') + (op.disabled ? ' tf-disabled' : '')}>
            <div className="tf-op-head">
              <span className="tf-num">{i + 1}</span>
              <span className="tf-op-label">{OP_LABEL[op.kind]}</span>
              <span className={'chip tf-group-' + OP_GROUP[op.kind]}>{OP_GROUP[op.kind]}</span>
              {op.disabled && <span className="tf-inactive">Inactive</span>}
              <span className="spacer" />
              <button
                onClick={() => applyImmediately(ops.map((item, j) => j === i ? { ...item, disabled: !item.disabled } : item))}
                aria-pressed={!op.disabled}
                title={op.disabled ? 'Activate operation' : 'Deactivate operation'}
              >{op.disabled ? 'Activate' : 'Deactivate'}</button>
              <button
                onClick={() => download(exportOperation(op), `${op.kind}-operation.json`)}
                title="Export this operation"
              >Export</button>
              <button onClick={() => move(i, -1)} disabled={i === 0 || ops[i - 1]?.kind === 'flattenByObjectType'} title="Move up">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === ops.length - 1 || op.kind === 'flattenByObjectType'} title="Move down">↓</button>
              <button onClick={() => applyImmediately(ops.filter((_, j) => j !== i))} title="Remove">×</button>
            </div>
            <OpForm
              op={op} artifact={source ?? artifact} isOcel={isOcelArtifact}
              onChange={(p) => patch(i, p)}
            />
            {op.disabled ? (
              <div className="why">Inactive — this step is retained but skipped.</div>
            ) : !isComplete(op) && (
              <div className="why">Incomplete — this step is skipped until it is filled in.</div>
            )}
          </li>
        ))}
      </ol>

      {ops.length === 0 && (
        <div className="tf-empty">
          No operations yet. The derived log is identical to its source.
        </div>
      )}

      <OrphanHint
        artifact={artifact}
        busy={busy}
        onAdd={() => applyImmediately([...ops, newOp('dropOrphanObjects')])}
      />

      <div className="tf-plan-actions">
        <button onClick={() => importOperationRef.current?.click()}>Import operation</button>
        {adding ? (
          <div className="tf-add">
          {(['Repair', 'Filter', 'Edit', 'Structure'] as const).map((g) => {
            // Case/variant operations have no OCEL semantics. Object relation filters are
            // available only where the OCEL graph exists.
            const kinds = KINDS.filter((k) => OP_GROUP[k] === g).filter(
              (k) => !isOcelArtifact || !['filterCases', 'variantMinCases', 'filterEvents', 'removeCaseAttributes', 'dropEmptyCases'].includes(k)
            ).filter(
              (k) => isOcelArtifact || !['filterObjectTypes', 'filterE2oCount', 'filterO2oCount', 'renameObjectType', 'mergeObjectTypes', 'splitObjectType', 'removeObjectAttributes', 'deduplicateRelations', 'dropSelfRelations', 'dropDanglingRelations', 'dropOrphanObjects', 'dropEventsWithoutObjects'].includes(k)
            ).filter(
              // Flattening changes the artifact type, so only the dedicated
              // flattened artifact may add its required first step back.
              (k) => k !== 'flattenByObjectType'
                || (!isOcelArtifact && isOcelSource && ops.length === 0)
            );
            if (kinds.length === 0) return null;
            return (
              <div key={g}>
                <h4>{g}</h4>
                {kinds.map((k) => (
                  <button key={k} onClick={() => { setAdding(false); applyImmediately([...ops, newOp(k)]); }}>
                    {OP_LABEL[k]}
                  </button>
                ))}
              </div>
            );
          })}
          <button className="tf-cancel" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <button className="primary tf-addbtn" onClick={() => setAdding(true)}>
            + Add operation
          </button>
        )}
      </div>

      <div className="tf-note">
        The source log is never modified. Changing an operation recomputes this
        artifact and every view open on it.
      </div>
    </div>
  );
}

/**
 * Before → after, as two counts.
 *
 * Deliberately not a changed-row diff: that means running both sides and
 * anti-joining them, which is a second full pass on every keystroke. Counts
 * are one aggregate each and answer the question the user actually has.
 */
function Counts({ artifact, source }: { artifact: Artifact; source?: Artifact }) {
  const a = artifact.meta as any;
  const s = source?.meta as any;
  const { rows } = useQuery<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${tableOf(artifact.id, 'event')}`,
    [artifact.id, JSON.stringify((artifact.storage as any).plan?.ops ?? [])]
  );
  const now = rows?.[0] ? Number(rows[0].n) : a?.events;

  return (
    <div className="tf-counts">
      <Metric label="Events" from={s?.events} to={now} />
      {artifact.type === 'ObjectCentricEventLog'
        ? <Metric label="Objects" from={s?.objects} to={a?.objects} />
        : <Metric label="Cases" from={s?.traces} to={a?.traces} />}
      <Metric label="Activities" from={s?.activities} to={a?.activities} />
    </div>
  );
}

/**
 * Objects the plan has left unreferenced, and the one operation that removes
 * them.
 *
 * An event filter on an OCEL log deliberately keeps every object — see
 * `cascadeFromEvents` in `transform/compile.ts`, which declines to invent an
 * orphan policy the user did not ask for. So a time-range filter that drops
 * three quarters of the events reports "Objects 11K → 11K", and is telling the
 * truth. That number is also easy to read as "the objects were untouched",
 * when what actually happened is that most of them no longer take part in
 * anything. This says which, and offers the operation that acts on it.
 *
 * One aggregate, keyed on the plan like `Counts` is, so it re-runs when the
 * result changes and not on every keystroke. It disappears on its own once the
 * cleanup is in the plan, because then there are no orphans left to report.
 */
function OrphanHint({
  artifact, onAdd, busy,
}: {
  artifact: Artifact;
  onAdd: () => void;
  busy: boolean;
}) {
  // Keyed on the *committed* plan, not the editor's working copy, exactly as
  // `Counts` is. The working copy changes on the keystroke; the derived views
  // are recompiled a debounce later. Keying on it ran this query against the
  // previous tables, where every object is still referenced and the answer is
  // therefore always zero — and since the key never changed again, the query
  // never re-ran and the hint stayed hidden for the one case it exists for.
  const committed = (artifact.storage.kind === 'view' ? artifact.storage.plan?.ops : null) ?? [];
  // Only worth asking about once the plan does something: an untransformed log
  // with orphans has a data-quality finding, not a transform consequence, and
  // Log Quality already reports it as SMELL-OBJECT-NO-EVENTS.
  const active = committed.some((o) => !o.disabled);
  const ask = artifact.type === 'ObjectCentricEventLog' && active;
  const object = tableOf(artifact.id, 'object');
  const e2o = tableOf(artifact.id, 'e2o');
  const { rows } = useQuery<{ orphans: number; total: number }>(
    ask
      ? `SELECT (SELECT COUNT(*) FROM ${object} o WHERE NOT EXISTS (
           SELECT 1 FROM ${e2o} r WHERE r.object_id = o.object_id)) AS orphans,
                (SELECT COUNT(*) FROM ${object}) AS total`
      : null,
    [artifact.id, ask, JSON.stringify(committed)]
  );
  const orphans = rows?.[0] ? num(rows[0].orphans) : 0;
  const total = rows?.[0] ? num(rows[0].total) : 0;
  if (!ask || orphans === 0) return null;

  const share = total > 0 ? Math.round((orphans / total) * 100) : 0;
  return (
    <div className="tf-orphans">
      <span>
        <strong>{fmtCount(orphans)}</strong> of {fmtCount(total)} objects
        {share >= 1 ? ` (${share}%)` : ''} are no longer referenced by any event.
        They are kept unless you remove them.
      </span>
      <button disabled={busy} onClick={onAdd}>{OP_LABEL.dropOrphanObjects}</button>
    </div>
  );
}

function Metric({ label, from, to }: { label: string; from?: number; to?: number }) {
  const drop = from != null && to != null && to < from;
  return (
    <div className="tf-metric">
      <div className="tf-metric-label">{label}</div>
      <div className="tf-metric-val">
        {from != null && <span className="tf-from">{fmtCount(from)} →</span>}{' '}
        <span className={drop ? 'tf-to drop' : 'tf-to'}>
          {to != null ? fmtCount(to) : '…'}
        </span>
      </div>
    </div>
  );
}

/** Per-operation form. Activity fields are bound to the source log's values. */
function OpForm({
  op, artifact, isOcel, onChange,
}: {
  op: TransformOp;
  artifact: Artifact;
  isOcel: boolean;
  onChange: (p: Partial<TransformOp>) => void;
}) {
  switch (op.kind) {
    case 'renameActivity':
      return <EntityRenameForm entity="activity" artifact={artifact} from={op.from} to={op.to}
                               allowMerge={op.allowMerge} onChange={(patch) => onChange(patch as any)} />;

    case 'renameObjectType':
      return <EntityRenameForm entity="object type" artifact={artifact} from={op.from} to={op.to}
                               allowMerge={op.allowMerge} onChange={(patch) => onChange(patch as any)} />;

    case 'mergeActivities':
      return <EntityMergeForm entity="activity" artifact={artifact} sources={op.sources} target={op.target}
                              onChange={(patch) => onChange(patch as any)} />;

    case 'mergeObjectTypes':
      return <EntityMergeForm entity="object type" artifact={artifact} sources={op.sources} target={op.target}
                              onChange={(patch) => onChange(patch as any)} />;

    case 'splitObjectType':
      return <SplitObjectTypeForm artifact={artifact} op={op} onChange={(patch) => onChange(patch as any)} />;

    case 'filterEvents':
      return (
        <div className="tf-form">
          <select value={op.column} onChange={(e) => onChange({ column: e.target.value } as any)}>
            <option value="activity">activity</option>
            {!isOcel && <option value="lifecycle">lifecycle</option>}
            {!isOcel && <option value="resource">resource</option>}
          </select>
          <select value={op.op} onChange={(e) => onChange({ op: e.target.value } as any)}>
            <option value="is">is</option>
            <option value="isNot">is not</option>
            <option value="contains">contains</option>
          </select>
          {op.column === 'activity' && op.op !== 'contains' ? (
            <ActivityInput artifact={artifact} value={op.value}
                           onChange={(v) => onChange({ value: v } as any)} placeholder="value" />
          ) : (
            <input value={op.value} placeholder="value"
                   onChange={(e) => onChange({ value: e.target.value } as any)} />
          )}
        </div>
      );

    case 'filterActivities':
      return <CategoryFilter artifact={artifact} column="activity" label="Activities" op={op}
                             onChange={(p) => onChange(p as any)} />;

    case 'filterObjectTypes':
      return <CategoryFilter artifact={artifact} column="object_type" label="Object types" op={op}
                             onChange={(p) => onChange(p as any)} />;

    case 'filterEventAttribute':
      return <AttributeFilter artifact={artifact} scope="event" isOcel={isOcel} op={op}
                              onChange={(p) => onChange(p as any)} />;

    case 'filterObjectAttribute':
      return <AttributeFilter artifact={artifact} scope={isOcel ? 'object' : 'trace'} isOcel={isOcel} op={op}
                              onChange={(p) => onChange(p as any)} />;

    case 'filterE2oCount':
      return <RelationshipCountFilter kind="E2O" artifact={artifact} op={op} onChange={(p) => onChange(p as any)} />;

    case 'filterO2oCount':
      return <RelationshipCountFilter kind="O2O" artifact={artifact} op={op} onChange={(p) => onChange(p as any)} />;

    case 'timeRange':
      return <TimeRangeFilter artifact={artifact} op={op} onChange={(p) => onChange(p as any)} />;

    case 'filterCases':
      return (
        <div className="tf-form">
          <span className="tf-word">keep cases that</span>
          <select value={op.mode} onChange={(e) => onChange({ mode: e.target.value } as any)}>
            <option value="contains">contain</option>
            <option value="notContains">do not contain</option>
          </select>
          <ActivityInput artifact={artifact} value={op.activity}
                         onChange={(v) => onChange({ activity: v } as any)} placeholder="activity" />
        </div>
      );

    case 'variantMinCases':
      return (
        <div className="tf-form">
          <span className="tf-word">keep variants seen in at least</span>
          <input type="number" min={1} style={{ width: 70 }} value={op.minCases}
                 onChange={(e) => onChange({ minCases: Number(e.target.value) } as any)} />
          <span className="tf-word">cases</span>
        </div>
      );

    case 'flattenByObjectType':
      return (
        <div className="tf-form">
          <span className="tf-word">one case per</span>
          <ObjectTypeInput artifact={artifact} value={op.objectType}
                           onChange={(v) => onChange({ objectType: v } as any)} />
          <span className="tf-word">object</span>
        </div>
      );

    case 'removeAttribute':
      return (
        <div className="tf-form">
          <select value={op.scope} onChange={(e) => onChange({ scope: e.target.value } as any)}>
            <option value="event">event</option>
            {!isOcel && <option value="trace">case</option>}
          </select>
          <AttributeInput artifact={artifact} scope={op.scope} value={op.key} isOcel={isOcel}
                          onChange={(v) => onChange({ key: v } as any)} />
        </div>
      );

    case 'removeEventAttributes':
      return <TypedAttributeRemovalEditor scope="event" artifact={artifact} activity={op.activity} keys={op.keys}
                                          onChange={(patch) => onChange(patch as any)} />;

    case 'removeObjectAttributes':
      return <TypedAttributeRemovalEditor scope="object" artifact={artifact} objectType={op.objectType} keys={op.keys}
                                          onChange={(patch) => onChange(patch as any)} />;

    case 'removeCaseAttributes':
      return <TypedAttributeRemovalEditor scope="trace" artifact={artifact} keys={op.keys}
                                          onChange={(patch) => onChange(patch as any)} />;

    case 'disambiguateEventOrder':
      return <DisambiguateForm artifact={artifact} isOcel={isOcel} op={op}
                               onChange={(p) => onChange(p as any)} />;

    case 'dropImplausibleTimestamps':
      return (
        <div className="tf-form">
          <select value={op.mode} onChange={(e) => onChange({ mode: e.target.value } as any)}>
            <option value="clear">clear the timestamp</option>
            <option value="drop">drop the event</option>
          </select>
          <span className="tf-word">outside years</span>
          <input type="number" style={{ width: 74 }} value={op.minYear}
                 onChange={(e) => onChange({ minYear: Number(e.target.value) } as any)} />
          <span className="tf-word">to</span>
          <input type="number" style={{ width: 74 }} value={op.maxYear}
                 onChange={(e) => onChange({ maxYear: Number(e.target.value) } as any)} />
        </div>
      );

    case 'deduplicateRelations':
      return (
        <div className="tf-form">
          <span className="tf-word">collapse identical tuples in</span>
          <select value={op.scope} onChange={(e) => onChange({ scope: e.target.value } as any)}>
            <option value="both">E2O and O2O</option>
            <option value="e2o">E2O only</option>
            <option value="o2o">O2O only</option>
          </select>
        </div>
      );

    // Repairs whose definition is their kind. The head already names them, so
    // a form with nothing in it would be noise; `describeOp` carries the detail.
    case 'dropSelfRelations':
    case 'dropDanglingRelations':
    case 'dropOrphanObjects':
    case 'dropEventsWithoutObjects':
    case 'dropEmptyCases':
      return null;

    case 'canonicaliseValues':
      return op.scope === 'qualifier' ? (
        <div className="tf-form">
          <span className="tf-word">
            every relation qualifier, onto the most frequent spelling of each
          </span>
        </div>
      ) : (
        <ValueScopeForm artifact={artifact} isOcel={isOcel} scope={op.scope} names={op.names}
                        onChange={(p) => onChange(p as any)} />
      );

    case 'mapSentinelValues':
      return (
        <>
          <ValueScopeForm artifact={artifact} isOcel={isOcel} scope={op.scope} names={op.names}
                          onChange={(p) => onChange(p as any)} />
          <div className="tf-form">
            <span className="tf-word">treat as missing</span>
            <input style={{ minWidth: 260 }} value={op.values.join(', ')}
                   placeholder="n/a, unknown, -"
                   onChange={(e) => onChange({
                     values: e.target.value.split(',').map((v) => v.trim()).filter(Boolean),
                   } as any)} />
          </div>
        </>
      );

    case 'removeAttributes':
      return <ValueScopeForm artifact={artifact} isOcel={isOcel} scope={op.scope} names={op.names}
                             onChange={(p) => onChange(p as any)} />;

    case 'pseudonymiseAttributes':
      return (
        <>
          <ValueScopeForm artifact={artifact} isOcel={isOcel} scope={op.scope} names={op.names}
                          onChange={(p) => onChange(p as any)} />
          <div className="tf-form">
            <select value={op.mode} onChange={(e) => onChange({ mode: e.target.value } as any)}>
              <option value="hash">replace with a salted digest</option>
              <option value="remove">remove the attribute</option>
            </select>
            {op.mode === 'hash' && (
              <>
                <span className="tf-word">salt</span>
                <input style={{ width: 150 }} value={op.salt}
                       onChange={(e) => onChange({ salt: e.target.value } as any)} />
              </>
            )}
          </div>
          {op.mode === 'hash' && (
            <div className="why">
              Pseudonymisation, not anonymisation: the same value maps to the same
              digest throughout the log, so counts and joins survive — and so does
              re-identification by anyone who can guess the values. The salt travels
              with the transformation definition and is not a secret.
            </div>
          )}
        </>
      );
  }
}

/**
 * The tie-break and step for `disambiguateEventOrder`.
 *
 * The note is not decoration. This is the only operation in the editor that
 * adds a claim to the log instead of removing or relabelling one, and the
 * artifact carries no other place to say so.
 */
function DisambiguateForm({ artifact, isOcel, op, onChange }: {
  artifact: Artifact;
  isOcel: boolean;
  op: Extract<TransformOp, { kind: 'disambiguateEventOrder' }>;
  onChange: (patch: Partial<Extract<TransformOp, { kind: 'disambiguateEventOrder' }>>) => void;
}) {
  return (
    <>
      <div className="tf-form">
        <span className="tf-word">order tied events by</span>
        <select value={op.tieBreak} onChange={(e) => onChange({ tieBreak: e.target.value as any })}>
          <option value="identifier">{isOcel ? 'event identifier' : 'order of appearance'}</option>
          {!isOcel && <option value="lifecycle">lifecycle transition</option>}
          <option value="attribute">an event attribute</option>
        </select>
        {op.tieBreak === 'attribute' && (
          <AttributeInput artifact={artifact} scope="event" value={op.attribute ?? ''} isOcel={isOcel}
                          onChange={(v) => onChange({ attribute: v })} />
        )}
        <span className="tf-word">at most</span>
        <input type="number" min={1} style={{ width: 90 }} value={op.stepMicroseconds}
               onChange={(e) => onChange({ stepMicroseconds: Number(e.target.value) })} />
        <span className="tf-word">µs apart</span>
      </div>
      <div className="why">
        This asserts an order the log does not record. Tied timestamps usually mean
        the extraction rounded sub-second precision away, so the true order is
        unknown — every duration and directly-follows relation derived from here
        inherits this assumption. Each tied group is spread across the gap to the
        next distinct timestamp, so no event is ever pushed onto or past a real
        one; where a gap is too small to separate a group, some ties remain.
        {isOcel && ' OCEL keeps no sequence column, so “event identifier” is a proxy for the source order, not the source order itself.'}
      </div>
    </>
  );
}

/** Scope + attribute-name picker shared by the value repairs. */
function ValueScopeForm({ artifact, isOcel, scope, names, onChange }: {
  artifact: Artifact;
  isOcel: boolean;
  scope: ValueScope;
  names: string[];
  onChange: (patch: { scope?: ValueScope; names?: string[] }) => void;
}) {
  const attrScope = scope === 'objectAttribute' ? 'object' : scope === 'caseAttribute' ? 'trace' : 'event';
  return (
    <div className="tf-form">
      <select value={scope} onChange={(e) => onChange({ scope: e.target.value as ValueScope, names: [] })}>
        <option value="eventAttribute">event attributes</option>
        {isOcel && <option value="objectAttribute">object attributes</option>}
        {!isOcel && <option value="caseAttribute">case attributes</option>}
      </select>
      <AttributeInput artifact={artifact} scope={attrScope as any} value={names[0] ?? ''} isOcel={isOcel}
                      onChange={(v) => onChange({ names: v ? [v, ...names.slice(1)] : names.slice(1) })} />
      {names.length > 1 && (
        <span className="tf-word">and {names.length - 1} more</span>
      )}
      {names.length > 1 && (
        <button onClick={() => onChange({ names: names.slice(0, 1) })}>Clear extras</button>
      )}
    </div>
  );
}

/** Rename only a value that is actually present in the source log. */
function EntityRenameForm({
  entity, artifact, from, to, allowMerge, onChange,
}: {
  entity: 'activity' | 'object type';
  artifact: Artifact;
  from: string;
  to: string;
  allowMerge?: boolean;
  onChange: (patch: { from?: string; to?: string }) => void;
}) {
  const table = tableOf(artifact.id, entity === 'activity' ? 'event' : 'object');
  const column = entity === 'activity' ? 'activity' : 'object_type';
  const { rows } = useQuery<{ value: string; n: number }>(
    `SELECT ${column} AS value, COUNT(*) AS n FROM ${table} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 500`,
    [artifact.id, entity]
  );
  const conflicts = allowMerge === false && !!to && to !== from
    && (rows ?? []).some((row) => String(row.value) === to);
  return (
    <div className="tf-edit-form">
      <label>
        <span>{entity === 'activity' ? 'Activity to rename' : 'Object type to rename'}</span>
        <select value={from} onChange={(e) => onChange({ from: e.target.value })}>
          <option value="">Select {entity}</option>
          {(rows ?? []).map((row) => <option key={String(row.value)} value={String(row.value)}>
            {row.value} ({fmtCount(Number(row.n))})
          </option>)}
        </select>
      </label>
      <span className="tf-arrow">→</span>
      <label>
        <span>New, unused name</span>
        <input value={to} placeholder={entity === 'activity' ? 'e.g. Confirm order' : 'e.g. Customer order'}
               onChange={(e) => onChange({ to: e.target.value })} />
      </label>
      {conflicts ? (
        <div className="why">“{to}” already exists. This rename is not applied; use “Merge {entity === 'activity' ? 'activities' : 'object types'}” to combine labels deliberately.</div>
      ) : (
        <div className="param-hint">A rename changes only this label. It does not change timestamps, attributes, or their values.</div>
      )}
    </div>
  );
}

/** Explicit relabelling of categories; values in rows are never combined. */
function EntityMergeForm({
  entity, artifact, sources, target, onChange,
}: {
  entity: 'activity' | 'object type';
  artifact: Artifact;
  sources: string[];
  target: string;
  onChange: (patch: { sources?: string[]; target?: string }) => void;
}) {
  const table = tableOf(artifact.id, entity === 'activity' ? 'event' : 'object');
  const column = entity === 'activity' ? 'activity' : 'object_type';
  const { rows } = useQuery<{ value: string; n: number }>(
    `SELECT ${column} AS value, COUNT(*) AS n FROM ${table} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 300`,
    [artifact.id, entity]
  );
  const toggle = (value: string) => onChange({
    sources: sources.includes(value) ? sources.filter((source) => source !== value) : [...sources, value],
  });
  const listId = `merge-${entity.replace(' ', '-')}-${artifact.id}`;
  return (
    <div className="tf-merge-form">
      <div className="tf-merge-target">
        <label>
          <span>Target {entity}</span>
          <input list={listId} value={target} placeholder={`Choose or name the merged ${entity}`}
                 onChange={(e) => onChange({ target: e.target.value })} />
          <datalist id={listId}>{(rows ?? []).map((row) => <option key={String(row.value)} value={String(row.value)} />)}</datalist>
        </label>
        <span className="param-hint">Every selected {entity} is relabelled as the target. Event/object rows stay separate; no numeric or string attribute values are combined, and their order is unchanged.</span>
      </div>
      <div className="tf-merge-list">
        {(rows ?? []).map((row) => {
          const value = String(row.value);
          return <label key={value} className={sources.includes(value) ? 'selected' : ''}>
            <input type="checkbox" checked={sources.includes(value)} onChange={() => toggle(value)} />
            <span>{value}</span><small>{fmtCount(Number(row.n))}</small>
          </label>;
        })}
      </div>
    </div>
  );
}

function splitSqlLit(v: string) { return `'${String(v).replace(/'/g, "''")}'`; }

/** Mirrors `compile.ts`'s WHEN-clause logic for the live per-rule preview below. */
function splitRuleCondition(column: string, rule: ObjectSplitRule): string {
  if (rule.mode === 'equals') return `${column} = ${splitSqlLit(rule.value)}`;
  if (rule.mode === 'regex') return `regexp_matches(${column}, ${splitSqlLit(rule.value)})`;
  return `contains(${column}, ${splitSqlLit(rule.value)})`;
}

type SplitOp = Extract<TransformOp, { kind: 'splitObjectType' }>;

/**
 * Splits one object type into several by matching a per-object field — its
 * own id, or one attribute's value — against ordered rules. The first rule
 * that matches wins; an object matching none keeps the source type.
 *
 * Attributes and relationships need no editor of their own here: both are
 * keyed by `object_id`, never `object_type`, so reassigning the type label
 * carries them along automatically (same property `EntityRenameForm`'s
 * object-type case already relies on).
 */
function SplitObjectTypeForm({ artifact, op, onChange }: {
  artifact: Artifact;
  op: SplitOp;
  onChange: (patch: Partial<SplitOp>) => void;
}) {
  const objectTable = tableOf(artifact.id, 'object');
  const attrTable = tableOf(artifact.id, 'object_attr');
  const { rows: types } = useQuery<{ object_type: string; n: number }>(
    `SELECT object_type, COUNT(*) AS n FROM ${objectTable} GROUP BY 1 ORDER BY n DESC, 1`,
    [artifact.id]
  );
  const { rows: attrRows, error: attrError } = useQuery<{ name: string }>(
    op.source
      ? `SELECT DISTINCT a.name FROM ${attrTable} a JOIN ${objectTable} o ON o.object_id = a.object_id
         WHERE o.object_type = ${splitSqlLit(op.source)} ORDER BY 1`
      : null,
    [artifact.id, op.source]
  );
  const matchSql = op.field
    ? `(SELECT a.value FROM ${attrTable} a WHERE a.object_id = o.object_id AND a.name = ${splitSqlLit(op.field)} ` +
      `ORDER BY a.ts DESC NULLS LAST LIMIT 1)`
    : 'o.object_id';
  const completeRules = op.rules.filter((r) => r.value && r.target);
  const ruleIndex = new Map(completeRules.map((r, i) => [r, i]));
  const countSql = op.source && completeRules.length
    ? `WITH scoped AS (SELECT ${matchSql} AS match_value FROM ${objectTable} o WHERE o.object_type = ${splitSqlLit(op.source)}) ` +
      `SELECT COUNT(*) AS total, ${completeRules.map((r, i) =>
        `SUM(CASE WHEN ${splitRuleCondition('match_value', r)} THEN 1 ELSE 0 END) AS r${i}`).join(', ')} FROM scoped`
    : null;
  const { rows: countRows } = useQuery<Record<string, number>>(
    countSql, [artifact.id, op.source, op.field, JSON.stringify(completeRules)]
  );
  const counts = countRows?.[0];

  const setRule = (i: number, patch: Partial<ObjectSplitRule>) => onChange({
    rules: op.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
  });
  const addRule = () => onChange({ rules: [...op.rules, { mode: 'contains', value: '', target: '' }] });
  const removeRule = (i: number) => onChange({ rules: op.rules.filter((_, j) => j !== i) });
  // Tabbing or clicking into an empty target from a contains/equals pattern
  // is almost always going to name the new type after that pattern — pre-fill
  // it, selected, so typing something different just overwrites it. A regex
  // is rarely a valid type name itself, so it's left blank as before.
  const prefillTarget = (i: number, rule: ObjectSplitRule, e: ReactFocusEvent<HTMLInputElement>) => {
    if (rule.mode === 'regex' || rule.target || !rule.value) return;
    e.target.value = rule.value;
    e.target.select();
    setRule(i, { target: rule.value });
  };
  const typesListId = `split-types-${artifact.id}`;

  return (
    <div className="tf-split-form">
      <div className="tf-edit-form">
        <label>
          <span>Object type to split</span>
          <select value={op.source} onChange={(e) => onChange({ source: e.target.value, field: '' })}>
            <option value="">Select object type</option>
            {(types ?? []).map((t) => <option key={String(t.object_type)} value={String(t.object_type)}>
              {t.object_type} ({fmtCount(Number(t.n))})
            </option>)}
          </select>
        </label>
        <label>
          <span>Match on</span>
          <select value={op.field} disabled={!op.source} onChange={(e) => onChange({ field: e.target.value })}>
            <option value="">Object ID</option>
            {(attrRows ?? []).map((a) => <option key={String(a.name)} value={String(a.name)}>{a.name}</option>)}
          </select>
        </label>
        {op.source && attrError && (
          <span className="param-hint">This log has no object attributes; matching is limited to the Object ID.</span>
        )}
      </div>

      <div className="tf-split-table">
        <div className="tf-split-row tf-split-head">
          <span>Rule</span><span>Pattern</span><span /><span>New object type</span><span>Matches</span><span />
        </div>
        {op.rules.map((rule, i) => {
          const idx = ruleIndex.get(rule);
          return (
            <div className="tf-split-row" key={i}>
              <select value={rule.mode} onChange={(e) => setRule(i, { mode: e.target.value as ObjectSplitRule['mode'] })}>
                <option value="contains">contains</option>
                <option value="equals">equals</option>
                <option value="regex">matches regex</option>
              </select>
              <input value={rule.value} placeholder="e.g. BAGGAGE_CONVEYOR"
                     onChange={(e) => setRule(i, { value: e.target.value })} />
              <span className="tf-arrow">→</span>
              <input list={typesListId} value={rule.target} placeholder="new or existing type"
                     onFocus={(e) => prefillTarget(i, rule, e)}
                     onChange={(e) => setRule(i, { target: e.target.value })} />
              <span className="tf-split-count">
                {counts && idx != null ? fmtCount(Number(counts[`r${idx}`] ?? 0)) : '—'}
              </span>
              <button type="button" className="tf-relation-remove" onClick={() => removeRule(i)} title="Remove this rule">
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <datalist id={typesListId}>{(types ?? []).map((t) => <option key={String(t.object_type)} value={String(t.object_type)} />)}</datalist>
      <button type="button" className="tf-split-add" onClick={addRule}>+ Add rule</button>

      <div className="param-hint">
        Rules are tried in order; the first match wins. An object matching no rule stays “{op.source || '…'}”.
        Attributes and relationships are untouched — only the object's type label changes.
        {' '}Regex uses DuckDB's RE2 syntax; both modes are case-sensitive (use <code>(?i)</code> in a regex for case-insensitive matching).
        {op.source && counts && (
          <> {fmtCount(Number(counts.total))} object{Number(counts.total) === 1 ? '' : 's'} currently in “{op.source}”.</>
        )}
      </div>
    </div>
  );
}

type TypedAttributeScope = 'event' | 'object' | 'trace';
type TypedAttributeRow = { entity: string; key: string; n: number };

/**
 * A removal edit should be selected from observed data, not typed from memory.
 * Choosing an event activity/object type initially selects all of its actual
 * attributes for removal; users simply uncheck the attributes they want kept.
 */
function TypedAttributeRemovalEditor({
  scope, artifact, activity, objectType, keys, onChange,
}: {
  scope: TypedAttributeScope;
  artifact: Artifact;
  activity?: string;
  objectType?: string;
  keys: string[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const isOcel = artifact.type === 'ObjectCentricEventLog';
  const attrTable = tableOf(artifact.id, scope === 'event' ? 'event_attr' : scope === 'object' ? 'object_attr' : 'trace_attr');
  const entityTable = tableOf(artifact.id, scope === 'event' ? 'event' : 'object');
  const attrKey = isOcel && scope !== 'trace' ? 'name' : 'key';
  const attrId = scope === 'event' ? (isOcel ? 'event_id' : 'event_idx') : 'object_id';
  const entityId = scope === 'event' ? (isOcel ? 'event_id' : 'event_idx') : 'object_id';
  const entityColumn = scope === 'event' ? 'activity' : 'object_type';
  const sql = scope === 'trace'
    ? `SELECT '' AS entity, ${attrKey} AS key, COUNT(*) AS n FROM ${attrTable} GROUP BY 1, 2 ORDER BY 2`
    : `SELECT e.${entityColumn} AS entity, a.${attrKey} AS key, COUNT(*) AS n
       FROM ${attrTable} a JOIN ${entityTable} e ON e.${entityId} = a.${attrId}
       GROUP BY 1, 2 ORDER BY 1, 2`;
  const { rows, loading, error } = useQuery<TypedAttributeRow>(sql, [artifact.id, scope, isOcel]);
  const selectedEntity = scope === 'event' ? activity ?? '' : scope === 'object' ? objectType ?? '' : '';
  const entities = Array.from(new Set((rows ?? []).map((row) => String(row.entity))));
  const attributes = (rows ?? []).filter((row) => scope === 'trace' || String(row.entity) === selectedEntity);
  const setEntity = (entity: string) => {
    const allKeys = (rows ?? []).filter((row) => String(row.entity) === entity).map((row) => String(row.key));
    onChange(scope === 'event' ? { activity: entity, keys: allKeys } : { objectType: entity, keys: allKeys });
  };
  const toggle = (key: string) => onChange({
    keys: keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
  });
  const selectAll = () => onChange({ keys: attributes.map((row) => String(row.key)) });
  const clear = () => onChange({ keys: [] });
  const entityLabel = scope === 'event' ? 'event activity' : 'object type';

  return (
    <div className="tf-edit-attributes">
      {scope !== 'trace' && (
        <label className="tf-edit-entity">
          <span>{entityLabel}</span>
          <select value={selectedEntity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Select {entityLabel}</option>
            {entities.map((entity) => <option value={entity} key={entity}>{entity}</option>)}
          </select>
        </label>
      )}
      {loading && <div className="tf-note">Reading attributes…</div>}
      {error && <div className="why">This log has no {scope === 'trace' ? 'case' : scope} attributes.</div>}
      {!loading && !error && scope !== 'trace' && !selectedEntity && (
        <div className="why">Choose a {entityLabel}; its actual attributes will be selected for removal.</div>
      )}
      {!loading && !error && (scope === 'trace' || selectedEntity) && attributes.length === 0 && (
        <div className="why">No attributes occur for this {scope === 'trace' ? 'log' : entityLabel}.</div>
      )}
      {!!attributes.length && (
        <>
          <div className="tf-edit-attr-toolbar">
            <span>Selected attributes are removed. Uncheck attributes to keep.</span>
            <button type="button" onClick={selectAll}>Select all</button>
            <button type="button" onClick={clear}>Keep all</button>
          </div>
          <div className="tf-edit-attr-list">
            {attributes.map((row) => {
              const key = String(row.key);
              return <label key={key}>
                <input type="checkbox" checked={keys.includes(key)} onChange={() => toggle(key)} />
                <span>{key}</span>
                <small>{fmtCount(Number(row.n))}</small>
              </label>;
            })}
          </div>
        </>
      )}
    </div>
  );
}

type CategoryOp = Extract<TransformOp, { kind: 'filterActivities' | 'filterObjectTypes' }>;

/**
 * Selection-first activity/object-type filter.  The frequency range is a
 * second, transparent criterion: it picks categories relative to the most
 * common one, while the checkboxes make arbitrary subsets possible.
 */
function CategoryFilter({
  artifact, column, label, op, onChange,
}: {
  artifact: Artifact;
  column: 'activity' | 'object_type';
  label: string;
  op: CategoryOp;
  onChange: (patch: Partial<CategoryOp>) => void;
}) {
  const table = tableOf(artifact.id, column === 'activity' ? 'event' : 'object');
  const { rows, loading } = useQuery<{ value: string; n: number }>(
    `SELECT ${column} AS value, COUNT(*) AS n FROM ${table} WHERE ${column} IS NOT NULL
     GROUP BY 1 ORDER BY n DESC, value LIMIT 200`,
    [artifact.id, column]
  );
  const values = rows ?? [];
  const max = Math.max(1, ...values.map((r) => Number(r.n)));
  const toggle = (value: string) => {
    const selected = new Set(op.values);
    selected.has(value) ? selected.delete(value) : selected.add(value);
    onChange({ values: [...selected] });
  };
  return (
    <div className="tf-category-filter">
      <div className="tf-filter-toolbar">
        <span>{label}</span>
        <select value={op.mode} onChange={(e) => onChange({ mode: e.target.value as CategoryOp['mode'] })}>
          <option value="include">Keep selected</option>
          <option value="exclude">Exclude selected</option>
        </select>
        <span className="tf-filter-selected">{op.values.length} selected</span>
      </div>
      <FrequencyRange min={op.minFrequency} max={op.maxFrequency}
                      onChange={(minFrequency, maxFrequency) => onChange({ minFrequency, maxFrequency })} />
      <div className="tf-frequency-list" aria-label={`${label} frequency chart`}>
        {loading && <div className="why">Loading {label.toLowerCase()}…</div>}
        {values.map((row) => {
          const value = String(row.value);
          const selected = op.values.includes(value);
          const percent = Number(row.n) * 100 / max;
          const inFrequency = percent >= op.minFrequency && percent <= op.maxFrequency;
          return (
            <label className={`tf-frequency-row${selected ? ' selected' : ''}${!inFrequency ? ' outside' : ''}`} key={value}>
              <input type="checkbox" checked={selected} onChange={() => toggle(value)} />
              <span className="tf-frequency-name" title={value}>{value}</span>
              <span className="tf-frequency-bar"><i style={{ width: `${percent}%` }} /></span>
              <b>{fmtCount(Number(row.n))}</b>
            </label>
          );
        })}
      </div>
      {values.length === 200 && <div className="param-hint">Showing the 200 most frequent values. The selected set is retained even if it is not listed.</div>}
    </div>
  );
}

function FrequencyRange({ min, max, onChange }: {
  min: number; max: number; onChange: (min: number, max: number) => void;
}) {
  return (
    <div className="tf-frequency-range">
      <div><span>Frequency range</span><b>{min}% – {max}%</b><small>of most frequent</small></div>
      <DualRange min={min} max={max} onChange={onChange} />
    </div>
  );
}

/** A compact two-thumb range rail used for both frequency and time. */
function DualRange({ min, max, onChange }: {
  min: number; max: number; onChange: (min: number, max: number) => void;
}) {
  return (
    <div className="tf-dual-range">
      <span className="tf-dual-rail" />
      <span className="tf-dual-selected" style={{ left: `${min}%`, right: `${100 - max}%` }} />
      <input aria-label="Minimum" type="range" min="0" max="100" value={min}
             onInput={(e) => onChange(Math.min(Number((e.target as HTMLInputElement).value), max), max)} />
      <input aria-label="Maximum" type="range" min="0" max="100" value={max}
             onInput={(e) => onChange(min, Math.max(Number((e.target as HTMLInputElement).value), min))} />
    </div>
  );
}

type AttributeOp = Extract<TransformOp, { kind: 'filterEventAttribute' | 'filterObjectAttribute' }>;

function AttributeFilter({
  artifact, scope, isOcel, op, onChange,
}: {
  artifact: Artifact;
  scope: 'event' | 'object' | 'trace';
  isOcel: boolean;
  op: AttributeOp;
  onChange: (patch: Partial<AttributeOp>) => void;
}) {
  const logical = scope === 'event' ? 'event_attr' : scope === 'object' ? 'object_attr' : 'trace_attr';
  const keyColumn = isOcel && scope !== 'trace' ? 'name' : 'key';
  const { rows } = useQuery<{ key: string; n: number }>(
    `SELECT ${keyColumn} AS key, COUNT(*) AS n FROM ${tableOf(artifact.id, logical)} GROUP BY 1 ORDER BY n DESC LIMIT 300`,
    [artifact.id, logical, keyColumn]
  );
  const listId = `filter-attrs-${artifact.id}-${scope}`;
  const subject = scope === 'event' ? 'event' : scope === 'object' ? 'object' : 'case';
  return (
    <div className="tf-attribute-filter">
      <div className="tf-form">
        <span className="tf-word">keep {subject}s whose attribute</span>
        <input list={listId} value={op.key} placeholder="attribute name"
               onChange={(e) => onChange({ key: e.target.value })} />
        <datalist id={listId}>{(rows ?? []).map((r) => <option key={String(r.key)} value={String(r.key)}>{fmtCount(Number(r.n))} values</option>)}</datalist>
        <select value={op.mode} onChange={(e) => onChange({ mode: e.target.value as AttributeOp['mode'] })}>
          <option value="has">is present</option>
          <option value="equals">equals</option>
          <option value="contains">contains</option>
          <option value="numberRange">is in number range</option>
        </select>
        {op.mode === 'numberRange' ? <>
          <input type="number" value={op.min ?? ''} placeholder="minimum" onChange={(e) => onChange({ min: e.target.value === '' ? undefined : Number(e.target.value) })} />
          <span className="tf-arrow">–</span>
          <input type="number" value={op.max ?? ''} placeholder="maximum" onChange={(e) => onChange({ max: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </> : op.mode !== 'has' && (
          <input value={op.value} placeholder="value" onChange={(e) => onChange({ value: e.target.value })} />
        )}
      </div>
      <div className="param-hint">Attribute values are evaluated on the current transformation stage; numeric ranges safely ignore non-numeric values.</div>
    </div>
  );
}

type RelationCountRow = {
  sourceType: string;
  targetType: string;
  qualifier: string;
  minCount: number;
  maxCount: number;
  sourceCount: number;
};

function relationKey(row: Pick<RelationCountRow, 'sourceType' | 'targetType' | 'qualifier'>) {
  return `${row.sourceType}\u0000${row.targetType}\u0000${row.qualifier}`;
}

function RelationshipCountFilter({ kind, artifact, op, onChange }: {
  kind: 'E2O' | 'O2O';
  artifact: Artifact;
  op: Extract<TransformOp, { kind: 'filterE2oCount' | 'filterO2oCount' }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const event = tableOf(artifact.id, 'event');
  const object = tableOf(artifact.id, 'object');
  const relationship = tableOf(artifact.id, kind === 'E2O' ? 'e2o' : 'o2o');
  // Include zeroes for source entities which do not carry a specific observed
  // relation. That is why a relation can correctly report a minimum of 0,
  // rather than merely describing existing relationship rows.
  const e2oSql = `
    WITH relation_kinds AS (
      SELECT DISTINCT e.activity AS source_type, o.object_type AS target_type,
             COALESCE(r.qualifier, '') AS qualifier
      FROM ${event} e
      JOIN ${relationship} r ON r.event_id = e.event_id
      JOIN ${object} o ON o.object_id = r.object_id
    ), per_source AS (
      SELECT e.event_id, e.activity AS source_type, o.object_type AS target_type,
             COALESCE(r.qualifier, '') AS qualifier, COUNT(*) AS n
      FROM ${event} e
      JOIN ${relationship} r ON r.event_id = e.event_id
      JOIN ${object} o ON o.object_id = r.object_id
      GROUP BY 1, 2, 3, 4
    )
    SELECT k.source_type AS sourceType, k.target_type AS targetType, k.qualifier,
           MIN(COALESCE(c.n, 0)) AS minCount, MAX(COALESCE(c.n, 0)) AS maxCount,
           COUNT(e.event_id) AS sourceCount
    FROM relation_kinds k
    JOIN ${event} e ON e.activity = k.source_type
    LEFT JOIN per_source c ON c.event_id = e.event_id
                          AND c.source_type = k.source_type
                          AND c.target_type = k.target_type
                          AND c.qualifier = k.qualifier
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`;
  const o2oSql = `
    WITH relation_kinds AS (
      SELECT DISTINCT source.object_type AS source_type, target.object_type AS target_type,
             COALESCE(r.qualifier, '') AS qualifier
      FROM ${relationship} r
      JOIN ${object} source ON source.object_id = r.source_id
      JOIN ${object} target ON target.object_id = r.target_id
    ), per_source AS (
      SELECT r.source_id, source.object_type AS source_type, target.object_type AS target_type,
             COALESCE(r.qualifier, '') AS qualifier, COUNT(*) AS n
      FROM ${relationship} r
      JOIN ${object} source ON source.object_id = r.source_id
      JOIN ${object} target ON target.object_id = r.target_id
      GROUP BY 1, 2, 3, 4
    )
    SELECT k.source_type AS sourceType, k.target_type AS targetType, k.qualifier,
           MIN(COALESCE(c.n, 0)) AS minCount, MAX(COALESCE(c.n, 0)) AS maxCount,
           COUNT(source.object_id) AS sourceCount
    FROM relation_kinds k
    JOIN ${object} source ON source.object_type = k.source_type
    LEFT JOIN per_source c ON c.source_id = source.object_id
                          AND c.source_type = k.source_type
                          AND c.target_type = k.target_type
                          AND c.qualifier = k.qualifier
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3`;
  const { rows, loading, error } = useQuery<RelationCountRow>(kind === 'E2O' ? e2oSql : o2oSql, [artifact.id, kind]);
  const conditions = op.conditions ?? [];
  const active = new Map(conditions.map((condition) => [relationKey(condition), condition]));
  const activate = (row: RelationCountRow) => {
    const condition: RelationCountCondition = {
      sourceType: String(row.sourceType), targetType: String(row.targetType), qualifier: String(row.qualifier ?? ''),
      // The observed extremes are the neutral initial range, so activating a
      // row does not unexpectedly remove data before the user narrows it.
      min: Number(row.minCount), max: Number(row.maxCount),
    };
    onChange({ conditions: [...conditions, condition], min: undefined, max: undefined });
  };
  const remove = (key: string) => onChange({
    conditions: conditions.filter((condition) => relationKey(condition) !== key),
  });
  const changeBound = (key: string, bound: 'min' | 'max', text: string) => onChange({
    conditions: conditions.map((condition) => relationKey(condition) === key
      ? { ...condition, [bound]: text === '' ? undefined : Number(text) }
      : condition),
  });

  return (
    <div className="tf-relation-filter">
      <div className="param-hint">
        {kind === 'E2O'
          ? 'Choose an event activity → object type relation and keep events whose count is within its range.'
          : 'Choose a directional object type → object type relation and keep source objects whose count is within its range.'}
      </div>
      {loading && <div className="tf-note">Reading relation types…</div>}
      {error && <div className="why">This log has no {kind} relationship table.</div>}
      {!loading && !error && rows?.length === 0 && <div className="why">No {kind} relations are present in this log.</div>}
      {!!rows?.length && (
        <div className="tf-relation-table">
          <div className="tf-relation-row tf-relation-head">
            <span>{kind === 'E2O' ? 'Event activity' : 'Source type'}</span>
            <span>Target type</span>
            <span>Qualifier</span>
            <span>Count per {kind === 'E2O' ? 'event' : 'object'}</span>
            <span>Filter</span>
          </div>
          {rows.map((row) => {
            const key = relationKey(row);
            const condition = active.get(key);
            const low = Number(row.minCount);
            const high = Number(row.maxCount);
            return (
              <div className={`tf-relation-row${condition ? ' active' : ''}`} key={key}>
                <span title={String(row.sourceType)}>{row.sourceType}</span>
                <span title={String(row.targetType)}>{row.targetType}</span>
                <span title={row.qualifier || 'Unqualified'}>{row.qualifier || '—'}</span>
                <span className={`tf-relation-range${condition ? '' : ' inactive'}`}>
                  <input type="number" min={low} max={high} value={condition?.min ?? low}
                         disabled={!condition}
                         aria-label={`Minimum ${kind} count for ${row.sourceType} to ${row.targetType}`}
                         onChange={(e) => changeBound(key, 'min', e.target.value)} />
                  <i>–</i>
                  <input type="number" min={low} max={high} value={condition?.max ?? high}
                         disabled={!condition}
                         aria-label={`Maximum ${kind} count for ${row.sourceType} to ${row.targetType}`}
                         onChange={(e) => changeBound(key, 'max', e.target.value)} />
                </span>
                <button className={condition ? 'tf-relation-remove' : 'tf-relation-add'}
                        title={condition ? 'Remove this relation constraint' : 'Constrain this relation'}
                        onClick={() => condition ? remove(key) : activate(row)}>
                  {condition ? 'Remove' : 'Add filter'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function dateOf(ms: number) { return new Date(ms).toISOString().slice(0, 10); }
/**
 * `datetime-local`-input-compatible value (`YYYY-MM-DDTHH:mm`), on the same
 * UTC-but-labeled-as-local convention `dateOf` already uses for plain dates
 * — extended with minutes so a narrow range is actually distinguishable
 * instead of every bound printing the same calendar day.
 */
function dateTimeOf(ms: number) { return new Date(ms).toISOString().slice(0, 16); }
/** A readable label for the slider thumbs and the range end-points. */
function dateTimeLabel(ms: number) { return dateTimeOf(ms).replace('T', ' '); }
/**
 * Arrow can surface an epoch as a bigint, number, or string depending on the
 * DuckDB/WASM build. Metadata can surface it as an ISO string. Normalise both
 * representations here; critically, an epoch in seconds must not be handed to
 * `Date` as milliseconds (which is how a 2023 date becomes January 1970).
 */
function millisOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function epochOf(text: string | undefined, fallback: number) {
  const n = text ? Date.parse(text) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * A genuine two-handle rail.
 *
 * This deliberately does not stack two native `input[type=range]` elements.
 * Their invisible full-width hit boxes overlap differently across browsers,
 * which made the end thumb reliable and the start thumb effectively random.
 * Each visible button below is its own complete hit target.
 */
function TimeRangeSlider({
  start, end, startLabel, endLabel,
  onPreview, onCommit,
}: {
  start: number;
  end: number;
  startLabel: string;
  endLabel: string;
  onPreview: (handle: RangeHandle, value: number) => void;
  onCommit: (handle: RangeHandle, value: number) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const valuesRef = useRef<[number, number]>([start, end]);
  valuesRef.current = [start, end];
  const dragRef = useRef<{
    handle: RangeHandle;
    pointerId: number;
    grabOffset: number;
    value: number;
  } | null>(null);

  const valueAt = (clientX: number, grabOffset = 0) => {
    const rect = railRef.current?.getBoundingClientRect();
    return rect ? pointerPercent(clientX - grabOffset, rect.left, rect.width) : 0;
  };

  const move = (handle: RangeHandle, raw: number) => {
    const [currentStart, currentEnd] = valuesRef.current;
    const next = clampRangeHandle(handle, raw, currentStart, currentEnd);
    valuesRef.current = next;
    const value = handle === 'start' ? next[0] : next[1];
    onPreview(handle, value);
    return value;
  };

  const pointerDown = (handle: RangeHandle, e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect) return;
    const current = handle === 'start' ? valuesRef.current[0] : valuesRef.current[1];
    const thumbX = rect.left + current / 100 * rect.width;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      handle,
      pointerId: e.pointerId,
      // Preserve where inside the thumb it was grabbed, so pointer-down does
      // not itself nudge the selected date.
      grabOffset: e.clientX - thumbX,
      value: current,
    };
  };

  const pointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.value = move(drag.handle, valueAt(e.clientX, drag.grabOffset));
  };

  const pointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const value = move(drag.handle, valueAt(e.clientX, drag.grabOffset));
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit(drag.handle, value);
  };

  const keyDown = (handle: RangeHandle, e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const current = handle === 'start' ? valuesRef.current[0] : valuesRef.current[1];
    const raw = keyboardPercent(e.key, current, e.shiftKey);
    if (raw == null) return;
    e.preventDefault();
    const value = move(handle, raw);
    onCommit(handle, value);
  };

  const thumb = (handle: RangeHandle, value: number, label: string) => (
    <button
      type="button"
      className={`tf-time-thumb tf-time-thumb--${handle}`}
      style={{ left: `${value}%` }}
      role="slider"
      aria-label={`${handle === 'start' ? 'Start' : 'End'} of time range`}
      aria-valuemin={handle === 'start' ? 0 : start}
      aria-valuemax={handle === 'start' ? end : 100}
      aria-valuenow={value}
      aria-valuetext={label}
      onPointerDown={(e) => pointerDown(handle, e)}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={() => { dragRef.current = null; }}
      onKeyDown={(e) => keyDown(handle, e)}
    />
  );

  return (
    <div ref={railRef} className="tf-dual-range tf-time-range">
      <span className="tf-dual-rail" />
      <span className="tf-dual-selected" style={{ left: `${start}%`, right: `${100 - end}%` }} />
      {thumb('start', start, startLabel)}
      {thumb('end', end, endLabel)}
    </div>
  );
}

/** Timeline histogram and dual-handle time selector, rendered from the log itself. */
function TimeRangeFilter({ artifact, op, onChange }: {
  artifact: Artifact;
  op: Extract<TransformOp, { kind: 'timeRange' }>;
  onChange: (patch: Partial<Extract<TransformOp, { kind: 'timeRange' }>>) => void;
}) {
  const table = tableOf(artifact.id, 'event');
  const { rows } = useQuery<{ bin: number; n: number; lo: string; hi: string }>(
    `WITH bounds AS (
       SELECT epoch_ms(MIN(ts)) AS lo_ms, epoch_ms(MAX(ts)) AS hi_ms,
              CAST(MIN(ts) AS VARCHAR) AS lo, CAST(MAX(ts) AS VARCHAR) AS hi
       FROM ${table} WHERE ts IS NOT NULL
     ),
     bins AS (SELECT LEAST(47, CAST(FLOOR(48 * (epoch_ms(e.ts) - b.lo_ms) / NULLIF(b.hi_ms - b.lo_ms + 1, 0)) AS INTEGER)) AS bin, b.lo, b.hi
              FROM ${table} e CROSS JOIN bounds b WHERE e.ts IS NOT NULL)
     SELECT bin, COUNT(*) AS n, MIN(lo) AS lo, MIN(hi) AS hi FROM bins GROUP BY 1 ORDER BY 1`,
    [artifact.id]
  );
  // Use textual timestamp bounds from the same query that supplies the bars.
  // Artifact metadata crosses the catalog/Arrow boundary and can arrive as
  // seconds, milliseconds, or a timestamp object; a cast in DuckDB makes this
  // picker independent of that representation.
  const lo = rows?.[0] ? millisOf(rows[0].lo) ?? NaN : NaN;
  const hi = rows?.[0] ? millisOf(rows[0].hi) ?? NaN : NaN;
  // Kept before the no-timestamp early return: query results arrive after the
  // first render, so hooks must not appear/disappear with that result.
  const [draft, setDraft] = useState<[number, number] | null>(null);
  // A range input emits `input` immediately before `pointerup`. Keep the last
  // input value in a ref too: otherwise a fast release can commit the prior
  // render's handle position and make the slider appear to spring back.
  const draftRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    setDraft(null);
    draftRef.current = null;
  }, [op.from, op.to, lo, hi]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return <div className="why">This log has no timestamps to filter.</div>;
  // `percentAtEpoch`/`epochAtPercent` safely fall back to `lo` for a zero
  // span rather than dividing by it, but that just means every drag commits
  // the same unchanged instant — a two-handle rail that looks interactive
  // and silently never moves. There is no narrower window to offer here, so
  // say that plainly instead of rendering a slider that cannot do anything.
  if (hi <= lo) {
    return <div className="why">Every timestamped event in this log falls at {dateTimeLabel(lo)} — there is no narrower range to select.</div>;
  }
  const storedFrom = Math.max(lo, Math.min(epochOf(op.from, lo), hi));
  const storedTo = Math.max(storedFrom, Math.min(epochOf(op.to, hi), hi));
  // Match Ocelot's model exactly: slider state is always [0, 100]. Convert to
  // timestamps only for labels and commits. The previous implementation put
  // percentages into `draft` and then treated them as epoch milliseconds,
  // which is why touching the start thumb produced 1969/1970 dates.
  const storedStart = percentAtEpoch(lo, hi, storedFrom);
  const storedEnd = percentAtEpoch(lo, hi, storedTo);
  const start = draft?.[0] ?? storedStart;
  const end = draft?.[1] ?? storedEnd;
  const from = epochAtPercent(lo, hi, start);
  const to = epochAtPercent(lo, hi, end);
  const byBin = new Map((rows ?? []).map((r) => [Number(r.bin), Number(r.n)]));
  const max = Math.max(1, ...byBin.values());
  const preview = (handle: RangeHandle, value: number) => {
    const current = draftRef.current ?? [start, end];
    const next = clampRangeHandle(handle, value, current[0], current[1]);
    draftRef.current = next;
    setDraft(next);
  };
  const commit = (handle: RangeHandle, value: number) => {
    const date = dateTimeOf(epochAtPercent(lo, hi, value));
    onChange(handle === 'start' ? { from: date } : { to: date });
  };
  return (
    <div className="tf-time-filter">
      <div className="tf-time-dates">
        <input type="datetime-local" min={dateTimeOf(lo)} max={dateTimeOf(to)} value={dateTimeOf(from)} onChange={(e) => onChange({ from: e.target.value })} />
        <span>to</span>
        <input type="datetime-local" min={dateTimeOf(from)} max={dateTimeOf(hi)} value={dateTimeOf(to)} onChange={(e) => onChange({ to: e.target.value })} />
        <button onClick={() => onChange({ from: undefined, to: undefined })}>Full range</button>
      </div>
      <div className="tf-time-histogram" aria-label="Event counts over time">
        {Array.from({ length: 48 }, (_, bin) => {
          const pct = (bin + .5) / 48 * 100;
          return <i key={bin} className={pct >= start && pct <= end ? 'active' : ''}
                    style={{ height: `${Math.max(3, (byBin.get(bin) ?? 0) / max * 100)}%` }} />;
        })}
      </div>
      <TimeRangeSlider
        start={start}
        end={end}
        startLabel={dateTimeLabel(from)}
        endLabel={dateTimeLabel(to)}
        onPreview={preview}
        onCommit={commit}
      />
      <div className="tf-time-ends"><span>{dateTimeLabel(lo)}</span><span>{dateTimeLabel(hi)}</span></div>
    </div>
  );
}

/**
 * Free text plus the real values from the log.
 *
 * A plain enum would be wrong here — the values are data, not a fixed
 * vocabulary — and a plain text box would make the user retype names they can
 * see in another panel. This is the same idea as `optionsFrom` on action
 * parameters, applied to a host view.
 */
function ActivityInput({
  artifact, value, onChange, placeholder,
}: {
  artifact: Artifact; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const { rows } = useQuery<{ activity: string }>(
    `SELECT activity, COUNT(*) AS n FROM ${tableOf(artifact.id, 'event')}
     GROUP BY 1 ORDER BY n DESC LIMIT 300`,
    [artifact.id]
  );
  const listId = `acts-${artifact.id}`;
  return (
    <>
      <input list={listId} value={value} placeholder={placeholder}
             onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {(rows ?? []).map((r) => <option key={String(r.activity)} value={String(r.activity)} />)}
      </datalist>
    </>
  );
}

/** Object types of the source log, queried rather than declared. */
function ObjectTypeInput({
  artifact, value, onChange,
}: {
  artifact: Artifact; value: string; onChange: (v: string) => void;
}) {
  const { rows } = useQuery<{ object_type: string }>(
    `SELECT object_type, COUNT(*) AS n FROM ${tableOf(artifact.id, 'object')}
     GROUP BY 1 ORDER BY n DESC LIMIT 300`,
    [artifact.id]
  );
  const listId = `otypes-${artifact.id}`;
  return (
    <>
      <input list={listId} value={value} placeholder="object type"
             onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {(rows ?? []).map((r) => <option key={String(r.object_type)} value={String(r.object_type)} />)}
      </datalist>
    </>
  );
}

function AttributeInput({
  artifact, scope, value, isOcel, onChange,
}: {
  artifact: Artifact; scope: 'event' | 'trace' | 'object'; value: string; isOcel: boolean;
  onChange: (v: string) => void;
}) {
  const logical = scope === 'event' ? 'event_attr' : scope === 'object' ? 'object_attr' : 'trace_attr';
  // `object_attr` exists only on OCEL and always names its key column `name`,
  // unlike `event_attr`, which follows the log kind.
  const keyColumn = scope === 'object' || isOcel ? 'name' : 'key';
  const { rows } = useQuery<{ key: string }>(
    `SELECT ${keyColumn} AS key, COUNT(*) AS n FROM ${tableOf(artifact.id, logical)}
     GROUP BY 1 ORDER BY n DESC LIMIT 300`,
    [artifact.id, scope, isOcel]
  );
  const listId = `attrs-${artifact.id}-${scope}`;
  return (
    <>
      <input list={listId} value={value} placeholder="attribute key"
             onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {(rows ?? []).map((r) => <option key={String(r.key)} value={String(r.key)} />)}
      </datalist>
    </>
  );
}

export { describeOp };
