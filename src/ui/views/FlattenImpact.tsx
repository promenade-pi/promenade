import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { logicalTablesOf, tableOf } from '../../host/artifact/tables';
import {
  activitySql, distortionOf, distortionShare, divergenceSql, impactSql,
  type TypeImpact,
} from '../../host/transform/flattenImpact';
import { fmtCount } from '../format';
import { num, useQuery } from './useQuery';

/**
 * What flattening an OCEL by a given object type actually costs, measured
 * before it is committed.
 *
 * The transform editor used to say "flattening is lossy in both directions"
 * in prose and then show a single net event count — a number in which a
 * duplicated event and a dropped event cancel each other out exactly, so the
 * one case where the warning matters most is the one where the count looks
 * calmest. This panel takes the two effects apart, names them by their
 * literature names, and puts every candidate case notion side by side so the
 * choice is made on the numbers rather than on which type sounds like a case.
 *
 * Everything here is measured against what `transform/compile.ts` will
 * actually build, not against an idealised flattening — see `IMPACT_SQL`.
 */

const pct = (n: number, of: number) => {
  if (of === 0) return '0%';
  const v = (n / of) * 100;
  if (v === 0) return '0%';
  if (v < 0.1) return '<0.1%';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
};

export function FlattenImpact({
  artifact, objectType, onChange,
}: {
  /** The *source* OCEL — `OpForm` is handed it in place of the derived log. */
  artifact: Artifact;
  objectType: string;
  onChange: (v: string) => void;
}) {
  const [comparing, setComparing] = useState(false);
  const [showActivities, setShowActivities] = useState(false);

  // A traditional artifact has no object table to read. This can happen for a
  // moment before the provenance graph resolves the source, and the honest
  // response is the bare picker rather than a SQL error.
  const tables = logicalTablesOf(artifact);
  const ready = tables.includes('object') && tables.includes('e2o') && tables.includes('event');
  const object = tableOf(artifact.id, 'object');
  const event = tableOf(artifact.id, 'event');
  const e2o = tableOf(artifact.id, 'e2o');

  const { rows: raw, loading } = useQuery<Record<string, unknown>>(
    ready ? impactSql(object, event, e2o) : null,
    [artifact.id, ready]
  );

  const impacts: TypeImpact[] = (raw ?? []).map((r) => ({
    objectType: String(r.object_type),
    cases: num(r.cases),
    emptyCases: num(r.empty_cases),
    srcEvents: num(r.src_events),
    retainedOnce: num(r.retained_once),
    dupEvents: num(r.dup_events),
    dupRows: num(r.dup_rows),
    dropped: num(r.dropped),
    outRows: num(r.out_rows),
  }));

  const selected = impacts.find((i) => i.objectType === objectType) ?? null;
  const best = impacts.length
    ? impacts.reduce((a, b) => (distortionShare(b) < distortionShare(a) ? b : a))
    : null;
  const recommended = best && distortionOf(best) === 'low' ? best.objectType : null;

  // The table is the point when nothing is chosen yet: there is no preview to
  // show, and the choice is exactly what is being asked for.
  const tableOpen = comparing || (!objectType && impacts.length > 0);

  /**
   * A closed list gets a closed control.
   *
   * This was a text field with a datalist, which is what the generic
   * attribute and activity pickers use — and right for them, because an
   * attribute name is one of hundreds and typing is faster than scrolling.
   * An object type is one of a handful, every one of them is already measured
   * here, and a free-text field invites a value the log does not have.
   *
   * A type the log no longer has is still offered rather than dropped: the
   * plan is persisted and may outlive the import it was written against, and
   * a select silently showing a different value than the plan holds would let
   * a glance at the panel rewrite the transformation.
   */
  const options = impacts.map((i) => i.objectType);
  const unknown = !!objectType && !options.includes(objectType);

  return (
    <div className="tf-flatten">
      <div className="tf-form">
        <span className="tf-word">one case per</span>
        <select value={objectType} onChange={(e) => onChange(e.target.value)}
                disabled={!ready || (impacts.length === 0 && !objectType)}>
          <option value="">{loading ? 'loading…' : 'choose a type…'}</option>
          {unknown && <option value={objectType}>{objectType} (not in this log)</option>}
          {impacts.map((i) => (
            <option key={i.objectType} value={i.objectType}>
              {i.objectType} · {i.cases.toLocaleString()} cases
            </option>
          ))}
        </select>
        <span className="tf-word">object</span>
        {impacts.length > 1 && (
          <button className="tf-link-btn" onClick={() => setComparing((v) => !v)}>
            {tableOpen ? 'Hide comparison' : 'Compare case notions'}
          </button>
        )}
        {loading && <span className="tf-word">measuring…</span>}
      </div>

      {selected && <ImpactBand impact={selected} />}

      {tableOpen && (
        <ComparisonTable impacts={impacts} selected={objectType}
                         recommended={recommended} onPick={onChange} />
      )}

      {selected && ready && (
        <Diagnosis artifact={artifact} impact={selected}
                   object={object} event={event} e2o={e2o}
                   showActivities={showActivities}
                   onToggleActivities={() => setShowActivities((v) => !v)} />
      )}
    </div>
  );
}

/**
 * The net count, taken apart.
 *
 * The bar is scaled to `source + added copies` rather than to the source
 * alone, so the copies occupy real width instead of being folded invisibly
 * into the segment they came from — the whole complaint about the net number,
 * restated as geometry.
 */
function ImpactBand({ impact: i }: { impact: TypeImpact }) {
  const copies = i.dupRows - i.dupEvents;
  const span = i.srcEvents + copies;
  const w = (n: number) => (span === 0 ? 0 : (n / span) * 100);
  const d = distortionOf(i);

  return (
    <div className="tf-impact">
      <div className="tf-impact-head">
        <strong>Impact preview for {i.objectType}</strong>
        <span className={`chip tf-dist tf-dist-${d}`}>{d} distortion</span>
      </div>

      <div className="tf-impact-body">
        <div className="tf-impact-end">
          <b>{fmtCount(i.srcEvents)}</b>
          <small>source events</small>
        </div>
        <span className="tf-impact-arrow">→</span>

        <div className="tf-impact-mid">
          <div className="tf-impact-legend">
            <span className="tf-seg-kept">
              <b>{fmtCount(i.retainedOnce)}</b> retained once · {pct(i.retainedOnce, i.srcEvents)}
            </span>
            {i.dupEvents > 0 && (
              <span className="tf-seg-dup">
                <b>{fmtCount(i.dupEvents)}</b> duplicated → {fmtCount(i.dupRows)} rows
                {copies > 0 && ` · +${fmtCount(copies)} copies`}
              </span>
            )}
            {i.dropped > 0 && (
              <span className="tf-seg-drop">
                <b>{fmtCount(i.dropped)}</b> dropped · {pct(i.dropped, i.srcEvents)}
              </span>
            )}
          </div>
          <div className="tf-impact-bar">
            <i className="tf-seg-kept" style={{ width: `${w(i.retainedOnce)}%` }} />
            <i className="tf-seg-dup" style={{ width: `${w(i.dupEvents)}%` }} />
            <i className="tf-seg-copies" style={{ width: `${w(copies)}%` }} />
            <i className="tf-seg-drop" style={{ width: `${w(i.dropped)}%` }} />
          </div>
          <div className="tf-impact-net">
            {netLine(i, copies)}
          </div>
        </div>

        <span className="tf-impact-arrow">→</span>
        <div className="tf-impact-end">
          <b>{fmtCount(i.outRows)}</b>
          <small>flattened rows</small>
        </div>
      </div>
    </div>
  );
}

/** Says what the single number above the plan is concealing, in its own terms. */
function netLine(i: TypeImpact, copies: number) {
  const net = i.outRows - i.srcEvents;
  if (copies === 0 && i.dropped === 0) return 'Nothing is duplicated and nothing is dropped.';
  if (copies === 0) return `Net −${fmtCount(i.dropped)}: events are only lost, never copied.`;
  if (i.dropped === 0) return `Net +${fmtCount(copies)}: events are only copied, never lost.`;
  return `Net ${net >= 0 ? '+' : '−'}${fmtCount(Math.abs(net))} masks `
    + `${fmtCount(copies)} added copies and ${fmtCount(i.dropped)} lost events.`;
}

function ComparisonTable({
  impacts, selected, recommended, onPick,
}: {
  impacts: TypeImpact[];
  selected: string;
  recommended: string | null;
  onPick: (v: string) => void;
}) {
  const ranked = [...impacts].sort((a, b) => distortionShare(a) - distortionShare(b));
  return (
    <div className="tf-compare">
      <div className="tf-compare-title">Choose the least-distorting case notion</div>
      <table className="tf-compare-table">
        <thead>
          <tr>
            <th>Case notion</th><th>Cases</th><th>Output events</th>
            <th>Duplicated</th><th>Dropped</th><th>Distortion</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((i) => {
            const d = distortionOf(i);
            return (
              <tr key={i.objectType} className={i.objectType === selected ? 'selected' : ''}
                  onClick={() => onPick(i.objectType)}>
                <td><button className="tf-link-btn">{i.objectType}</button></td>
                <td className="n">{i.cases.toLocaleString()}</td>
                <td className="n">{fmtCount(i.outRows)}</td>
                <td><Meter share={i.srcEvents ? i.dupEvents / i.srcEvents : 0} tone="dup" />
                    <span className="n">{pct(i.dupEvents, i.srcEvents)}</span></td>
                <td><Meter share={i.srcEvents ? i.dropped / i.srcEvents : 0} tone="drop" />
                    <span className="n">{pct(i.dropped, i.srcEvents)}</span></td>
                <td>
                  <span className={`chip tf-dist tf-dist-${d}`}>{d}</span>
                  {i.objectType === recommended && <span className="chip tf-recommended">Recommended</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="param-hint">
        Ranked by how many source events a notion copies or drops. That is a
        count, not a verdict — an unavoidable drop is still a drop, and
        divergence is judged separately for whichever notion you pick.
      </p>
    </div>
  );
}

function Meter({ share, tone }: { share: number; tone: 'dup' | 'drop' }) {
  return (
    <span className="tf-meter">
      <i className={`tf-seg-${tone}`} style={{ width: `${Math.min(100, share * 100)}%` }} />
    </span>
  );
}

interface ActivityRow {
  activity: string; events: number; dropped: number;
  dupEvents: number; dupRows: number; maxCopies: number;
}

interface DivergentRow {
  activity: string; explainedBy: string; repeatCases: number; explainedCases: number;
}

/** The three named problems, each with the activities that cause it. */
function Diagnosis({
  artifact, impact, object, event, e2o, showActivities, onToggleActivities,
}: {
  artifact: Artifact;
  impact: TypeImpact;
  object: string; event: string; e2o: string;
  showActivities: boolean;
  onToggleActivities: () => void;
}) {
  const t = impact.objectType;
  const { rows: actRaw } = useQuery<Record<string, unknown>>(
    activitySql(object, event, e2o, t), [artifact.id, t]
  );
  const { rows: divRaw, loading: divLoading } = useQuery<Record<string, unknown>>(
    divergenceSql(object, event, e2o, t), [artifact.id, t]
  );

  const acts: ActivityRow[] = (actRaw ?? []).map((r) => ({
    activity: String(r.activity ?? ''),
    events: num(r.events), dropped: num(r.dropped),
    dupEvents: num(r.dup_events), dupRows: num(r.dup_rows), maxCopies: num(r.max_copies),
  }));

  // One explaining type per activity — the one that accounts for most of its
  // repetitions. Listing all of them would report the same distortion several
  // times over, once per correlated type.
  const divergent: DivergentRow[] = [];
  const seen = new Set<string>();
  for (const r of divRaw ?? []) {
    const row: DivergentRow = {
      activity: String(r.activity ?? ''),
      explainedBy: String(r.explained_by ?? ''),
      repeatCases: num(r.repeat_cases),
      explainedCases: num(r.explained_cases),
    };
    if (row.repeatCases < 2 || row.explainedCases < row.repeatCases * 0.5) continue;
    if (seen.has(row.activity)) continue;
    seen.add(row.activity);
    divergent.push(row);
  }

  const vanishing = acts.filter((a) => a.events > 0 && a.dropped === a.events);
  const convAct = acts.filter((a) => a.dupEvents > 0)
    .sort((a, b) => b.dupEvents - a.dupEvents);
  const defAct = acts.filter((a) => a.dropped > 0)
    .sort((a, b) => b.dropped - a.dropped);
  const maxCopies = convAct.reduce((m, a) => Math.max(m, a.maxCopies), 0);

  const anything = impact.dupEvents > 0 || impact.dropped > 0
    || divergent.length > 0 || impact.emptyCases > 0;

  return (
    <div className="tf-diagnosis">
      <div className="tf-diagnosis-title">
        {anything ? `Why ${t} distorts` : `${t} is a clean case notion`}
      </div>

      {!anything && (
        <div className="why">
          Every event relates to exactly one {t}, and no repetition inside a case
          is explained by another object type. This flattening loses nothing.
        </div>
      )}

      <div className="tf-problems">
        {impact.dupEvents > 0 && (
          <Problem tone="warn" title="Convergence"
                   lead={<><strong>{impact.dupEvents.toLocaleString()}</strong> events relate to
                     several {t} objects and are copied into each of their cases,
                     turning {fmtCount(impact.dupEvents)} events into {fmtCount(impact.dupRows)} rows.
                     Every frequency measured afterwards counts them more than once.</>}
                   chip={maxCopies > 1 ? `1× → ${maxCopies}×` : undefined}
                   items={convAct.slice(0, 4).map((a) => `${a.activity} · ${fmtCount(a.dupEvents)}`)} />
        )}

        {impact.dropped > 0 && (
          <Problem tone="danger" title="Deficiency"
                   lead={<><strong>{impact.dropped.toLocaleString()}</strong> events relate to
                     no {t} at all and are absent from the flat log
                     ({pct(impact.dropped, impact.srcEvents)} of it).
                     {vanishing.length > 0 && <> {vanishing.length} activit{vanishing.length === 1 ? 'y' : 'ies'} disappear{vanishing.length === 1 ? 's' : ''} entirely.</>}</>}
                   items={defAct.slice(0, 4).map((a) =>
                     `${a.activity} · ${fmtCount(a.dropped)}${a.dropped === a.events ? ' (all)' : ''}`)} />
        )}

        {divergent.length > 0 && (
          <Problem tone="experimental" title="Divergence" wide
                   lead={<>{divergent.length} activit{divergent.length === 1 ? 'y' : 'ies'} repeat
                     inside a {t} case once per related object of another type, not because
                     the process does them twice. Discovery reads that as a loop, or as
                     concurrency, that is not there.</>}
                   items={divergent.slice(0, 4).map((d) =>
                     `${d.activity} · one per ${d.explainedBy}`)}>
            <FalseLoop activity={divergent[0].activity} caseType={t}
                       explainedBy={divergent[0].explainedBy} />
          </Problem>
        )}

        {impact.emptyCases > 0 && (
          <Problem tone="warn" title="Empty cases"
                   lead={<><strong>{impact.emptyCases.toLocaleString()}</strong> of {impact.cases.toLocaleString()} {t} objects
                     take part in no event, so they become cases with no events.
                     They inflate the case count and every per-case average
                     computed from it.</>} />
        )}
      </div>

      {divLoading && <div className="why">Checking for divergence…</div>}

      {acts.length > 0 && (
        <>
          <button className="tf-link-btn tf-disclose" onClick={onToggleActivities}>
            {showActivities ? '▾' : '▸'} Per-activity breakdown ({acts.length})
          </button>
          {showActivities && (
            <table className="tf-compare-table tf-act-table">
              <thead>
                <tr>
                  <th>Activity</th><th>Events</th><th>Duplicated</th>
                  <th>Max copies</th><th>Dropped</th><th>Divergence</th>
                </tr>
              </thead>
              <tbody>
                {acts.map((a) => {
                  const div = divergent.find((d) => d.activity === a.activity);
                  return (
                    <tr key={a.activity}>
                      <td>{a.activity || <em>(no activity)</em>}</td>
                      <td className="n">{a.events.toLocaleString()}</td>
                      <td className="n">{a.dupEvents ? a.dupEvents.toLocaleString() : '—'}</td>
                      <td className="n">{a.maxCopies > 1 ? `${a.maxCopies}×` : '—'}</td>
                      <td className="n">
                        {a.dropped
                          ? <span className={a.dropped === a.events ? 'tf-all-dropped' : ''}>
                              {a.dropped.toLocaleString()}{a.dropped === a.events ? ' (all)' : ''}
                            </span>
                          : '—'}
                      </td>
                      <td>{div ? `one per ${div.explainedBy}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function Problem({
  tone, title, lead, chip, items, wide, children,
}: {
  tone: 'warn' | 'danger' | 'experimental';
  title: string;
  lead: ReactNode;
  chip?: string;
  items?: string[];
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`tf-problem tf-problem-${tone}${wide ? ' wide' : ''}`}>
      <div className="tf-problem-head">
        <span className="tf-problem-title">{title}</span>
        {chip && <span className="chip tf-copies-chip">{chip}</span>}
      </div>
      <p className="tf-problem-lead">{lead}</p>
      {items && items.length > 0 && (
        <ul className="tf-problem-items">
          {items.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}
      {children}
    </div>
  );
}

/**
 * What the distortion looks like in a discovered model.
 *
 * Only the activity itself is drawn: its neighbours would have to be invented
 * or discovered, and a made-up predecessor would be a worse lie than the one
 * being illustrated.
 */
function FalseLoop({
  activity, caseType, explainedBy,
}: {
  activity: string; caseType: string; explainedBy: string;
}) {
  const label = activity.length > 22 ? `${activity.slice(0, 21)}…` : activity;
  return (
    <div className="tf-falseloop">
      <svg viewBox="0 0 250 70" role="img"
           aria-label={`${activity} appears once per ${explainedBy} inside one ${caseType} case, which discovery reads as a loop`}>
        <defs>
          <marker id="tf-fl-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 z" fill="currentColor" />
          </marker>
        </defs>
        <rect x="70" y="34" width="110" height="26" rx="4"
              className="tf-fl-box" />
        <text x="125" y="51" textAnchor="middle" className="tf-fl-text">{label}</text>
        <path d="M95 34 C95 8, 155 8, 155 34" fill="none"
              className="tf-fl-loop" markerEnd="url(#tf-fl-arrow)" />
      </svg>
      <span className="tf-falseloop-cap">
        Once per {explainedBy} inside one {caseType} case — read as a loop.
      </span>
    </div>
  );
}
