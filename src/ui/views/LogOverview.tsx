import { useEffect, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { fmtBytes, fmtCount, fmtDuration, fmtGap, fmtMs } from '../format';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { tableOf } from './tableName';
import { useQuery, num } from './useQuery';

/**
 * Native Overview for a `TraditionalEventLog` — the case-centric analog
 * of the OCEL Overview `run.promenade.ocelot` provides for
 * `ObjectCentricEventLog` (that one's `primary` view, bundled as a plugin).
 * This one is core rather than a plugin: a case-centric log is the default,
 * always-installed log type, and its overview shouldn't depend on a plugin
 * install step the way an object-centric log's optional depth-analysis
 * tooling reasonably can.
 *
 * Visually it mirrors that plugin's card language (see `.ov-*` in
 * `styles.css`) so opening either log type reads as the same product — but
 * every number here comes from a live `host.sql()` query, the same
 * boundary every other core view uses, not a sandboxed bridge.
 *
 * Every card is gated on its *own* query, not one shared loading flag: the
 * cheap counts (cases/events/activities) and the Time Range card typically
 * land almost immediately, while the heavier window-function/string_agg
 * queries (Case Structure, Variants) are still running — a card shows its
 * own "Querying…" only until its own data is in, rather than the whole
 * page staying blank until the slowest query of the batch finishes.
 */

const BREAKDOWN_LIMIT = 6;
const MAX_VARIANT_ROWS = 2000;

function normalizedEntropy(counts: number[]): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (counts.length <= 1 || total === 0) return null;
  const entropy = -counts.reduce((sum, n) => {
    const p = n / total;
    return sum + (p > 0 ? p * Math.log2(p) : 0);
  }, 0);
  return entropy / Math.log2(counts.length);
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="ov-stat">
      <div className="ov-stat-value">{value}</div>
      <div className="ov-stat-label">{label}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ov-stat-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function KvItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="ov-kv-label">{label}</div>
      <div className="ov-kv-value">{value}</div>
    </div>
  );
}

/** What every card body renders while its own query hasn't resolved yet, or
 * has failed — used instead of one page-level loading/error gate so a slow
 * or broken query only ever blanks its own card. */
function CardPending({ error }: { error?: string | null }) {
  return error ? <div className="err">{error}</div> : <span className="ov-empty">Querying…</span>;
}

interface BreakdownItem { name: string; n: number }

/** A sorted top-N bar list with a collapsible "N more" toggle — the same
 * pattern `run.promenade.ocelot`'s Overview uses for object/event type
 * breakdowns, applied here to activities and resources. Bar width reads
 * "which names dominate" (relative to the largest); the bracketed
 * percentage reads "how much of the log this accounts for" (relative to
 * the whole) — deliberately two different scales. */
function BreakdownCard({
  items, colorDomain, selectable, artifact, panelId, sel,
}: {
  items: BreakdownItem[];
  colorDomain?: 'activity';
  selectable?: boolean;
  artifact?: Artifact;
  panelId?: string;
  sel?: Selection;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = items.reduce((sum, it) => sum + it.n, 0);
  const maxCount = Math.max(1, ...items.map((it) => it.n));
  const shown = expanded ? items : items.slice(0, BREAKDOWN_LIMIT);
  const remaining = items.length - BREAKDOWN_LIMIT;

  return (
    <>
      {items.length === 0 && <span className="ov-empty">No data.</span>}
      {shown.map((it) => {
        const selected = !!(selectable && artifact && sel?.items.some(
          (i) => i.artifactId === artifact.id && i.kind === 'activity' && i.id === it.name
        ));
        return (
          <div
            key={it.name}
            className="ov-bar-row"
            style={selectable ? { cursor: 'pointer', borderRadius: 5, background: selected ? 'var(--accent-soft)' : undefined } : undefined}
            onClick={selectable && artifact && panelId ? () => selectionBus.set(
              selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: it.name }], panelId
            ) : undefined}
          >
            <span className="ov-bar-name" title={it.name}>
              {colorDomain && (
                <span className="swatch" style={{ background: colorRegistry.get(colorDomain, it.name) }} />
              )}
              {it.name}
            </span>
            <div className="ov-bar-track">
              <div className="ov-bar-fill" style={{ width: `${Math.max(4, (it.n / maxCount) * 100)}%` }} />
            </div>
            <span className="ov-bar-count">
              {fmtCount(it.n)}
              {total > 0 && <span className="ov-bar-pct"> ({Math.round((it.n / total) * 100)}%)</span>}
            </span>
          </div>
        );
      })}
      {remaining > 0 && (
        <button type="button" className="ov-btn" style={{ marginTop: 8 }} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : `${remaining} more`}
        </button>
      )}
    </>
  );
}

export function LogOverview({ artifact, panelId }: { artifact: Artifact; panelId: string }) {
  const eventT = tableOf(artifact.id, 'event');
  const traceT = tableOf(artifact.id, 'trace');
  const eventAttrT = tableOf(artifact.id, 'event_attr');
  const traceAttrT = tableOf(artifact.id, 'trace_attr');
  const deps = [artifact.id, (artifact.meta as any)?.rev];

  // Split from the variant count below on purpose: three plain COUNTs
  // resolve almost immediately, and shouldn't wait behind the
  // string_agg-over-every-case grouping variant counting needs.
  const basicCounts = useQuery<{ cases: number; events: number; activities: number }>(`
    SELECT
      (SELECT COUNT(*) FROM ${traceT}) AS cases,
      (SELECT COUNT(*) FROM ${eventT}) AS events,
      (SELECT COUNT(DISTINCT activity) FROM ${eventT} WHERE activity IS NOT NULL) AS activities
  `, deps);

  const variantCount = useQuery<{ variants: number }>(`
    SELECT COUNT(DISTINCT variant) AS variants FROM (
      SELECT trace_idx, string_agg(activity, ' → ' ORDER BY ts, event_idx) AS variant
      FROM ${eventT} GROUP BY trace_idx
    ) v
  `, deps);

  const timeRange = useQuery<{ earliest: string; latest: string }>(`
    SELECT MIN(ts) AS earliest, MAX(ts) AS latest FROM ${eventT} WHERE ts IS NOT NULL
  `, deps);

  const timing = useQuery<{
    median_active: number; busiest: number; active_days: number;
    median_gap_ms: number; day_f: number; hour_f: number; minute_f: number; second_f: number; milli_f: number;
    ts_total: number; ts_distinct: number;
  }>(`
    WITH daily AS (
      SELECT date_trunc('day', ts) AS d, COUNT(*) AS n FROM ${eventT} WHERE ts IS NOT NULL GROUP BY 1
    ), gaps AS (
      SELECT ts, LAG(ts) OVER (ORDER BY ts) AS prev FROM ${eventT} WHERE ts IS NOT NULL
    ), prec AS (
      SELECT
        AVG(CASE WHEN epoch_us(ts) % 86400000000 = 0 THEN 1.0 ELSE 0 END) AS day_f,
        AVG(CASE WHEN epoch_us(ts) % 3600000000 = 0 THEN 1.0 ELSE 0 END) AS hour_f,
        AVG(CASE WHEN epoch_us(ts) % 60000000 = 0 THEN 1.0 ELSE 0 END) AS minute_f,
        AVG(CASE WHEN epoch_us(ts) % 1000000 = 0 THEN 1.0 ELSE 0 END) AS second_f,
        AVG(CASE WHEN epoch_us(ts) % 1000 = 0 THEN 1.0 ELSE 0 END) AS milli_f
      FROM ${eventT} WHERE ts IS NOT NULL
    ), share AS (
      SELECT COUNT(*) AS total, COUNT(DISTINCT ts) AS distinct_ts FROM ${eventT} WHERE ts IS NOT NULL
    )
    SELECT
      (SELECT median(n) FROM daily) AS median_active,
      (SELECT max(n) FROM daily) AS busiest,
      (SELECT count(*) FROM daily) AS active_days,
      (SELECT median(epoch_us(ts) - epoch_us(prev)) / 1000.0 FROM gaps WHERE prev IS NOT NULL) AS median_gap_ms,
      (SELECT day_f FROM prec) AS day_f, (SELECT hour_f FROM prec) AS hour_f,
      (SELECT minute_f FROM prec) AS minute_f, (SELECT second_f FROM prec) AS second_f,
      (SELECT milli_f FROM prec) AS milli_f,
      (SELECT total FROM share) AS ts_total, (SELECT distinct_ts FROM share) AS ts_distinct
  `, deps);

  const hourRows = useQuery<{ h: number; n: number }>(`
    SELECT EXTRACT(HOUR FROM ts)::INTEGER AS h, COUNT(*) AS n
    FROM ${eventT} WHERE ts IS NOT NULL GROUP BY 1 ORDER BY 1
  `, deps);

  const structure = useQuery<{
    median_events: number; max_events: number; median_dur_ms: number; max_dur_ms: number;
    n_start: number; n_end: number; trivial_cases: number; total_cases: number;
    self_loops: number; df_pairs: number;
  }>(`
    WITH per_case AS (
      SELECT trace_idx, COUNT(*) AS n_events, MIN(ts) AS start_ts, MAX(ts) AS end_ts FROM ${eventT} GROUP BY trace_idx
    ), starts AS (
      SELECT activity FROM (
        SELECT activity, ROW_NUMBER() OVER (PARTITION BY trace_idx ORDER BY ts NULLS LAST, event_idx) AS rn FROM ${eventT}
      ) WHERE rn = 1
    ), ends AS (
      SELECT activity FROM (
        SELECT activity, ROW_NUMBER() OVER (PARTITION BY trace_idx ORDER BY ts DESC NULLS LAST, event_idx DESC) AS rn FROM ${eventT}
      ) WHERE rn = 1
    ), loops AS (
      SELECT activity, LEAD(activity) OVER (PARTITION BY trace_idx ORDER BY ts NULLS LAST, event_idx) AS next_activity FROM ${eventT}
    )
    SELECT
      (SELECT median(n_events) FROM per_case) AS median_events,
      (SELECT max(n_events) FROM per_case) AS max_events,
      (SELECT median(epoch_ms(end_ts) - epoch_ms(start_ts)) FROM per_case WHERE start_ts IS NOT NULL) AS median_dur_ms,
      (SELECT max(epoch_ms(end_ts) - epoch_ms(start_ts)) FROM per_case WHERE start_ts IS NOT NULL) AS max_dur_ms,
      (SELECT COUNT(DISTINCT activity) FROM starts) AS n_start,
      (SELECT COUNT(DISTINCT activity) FROM ends) AS n_end,
      (SELECT COUNT(*) FROM per_case WHERE n_events = 1) AS trivial_cases,
      (SELECT COUNT(*) FROM per_case) AS total_cases,
      (SELECT SUM(CASE WHEN next_activity IS NOT NULL AND activity = next_activity THEN 1 ELSE 0 END) FROM loops) AS self_loops,
      (SELECT SUM(CASE WHEN next_activity IS NOT NULL THEN 1 ELSE 0 END) FROM loops) AS df_pairs
  `, deps);

  const activityRows = useQuery<{ name: string; n: number }>(`
    SELECT activity AS name, COUNT(*) AS n FROM ${eventT} WHERE activity IS NOT NULL GROUP BY 1 ORDER BY n DESC
  `, deps);

  const resourceRows = useQuery<{ name: string; n: number }>(`
    SELECT resource AS name, COUNT(*) AS n FROM ${eventT} WHERE resource IS NOT NULL AND resource <> '' GROUP BY 1 ORDER BY n DESC
  `, deps);

  const variantRows = useQuery<{ variant: string; n: number }>(`
    WITH seq AS (
      SELECT trace_idx, string_agg(activity, ' → ' ORDER BY ts NULLS LAST, event_idx) AS variant
      FROM ${eventT} GROUP BY trace_idx
    )
    SELECT variant, COUNT(*) AS n FROM seq GROUP BY variant ORDER BY n DESC LIMIT ${MAX_VARIANT_ROWS}
  `, deps);

  const attrCounts = useQuery<{ event_values: number; event_keys: number; case_values: number; case_keys: number }>(`
    SELECT
      (SELECT COUNT(*) FROM ${eventAttrT}) AS event_values,
      (SELECT COUNT(DISTINCT key) FROM ${eventAttrT}) AS event_keys,
      (SELECT COUNT(*) FROM ${traceAttrT}) AS case_values,
      (SELECT COUNT(DISTINCT key) FROM ${traceAttrT}) AS case_keys
  `, deps);

  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);

  const c = basicCounts.rows?.[0];
  const vc = variantCount.rows?.[0];
  const tr = timeRange.rows?.[0];
  const t = timing.rows?.[0];
  const s = structure.rows?.[0];
  const a = attrCounts.rows?.[0];

  const hourHistogram = new Array(24).fill(0);
  if (hourRows.rows) for (const r of hourRows.rows) hourHistogram[num(r.h)] = num(r.n);
  const maxHour = Math.max(1, ...hourHistogram);
  const peakHour = hourHistogram.indexOf(maxHour);

  const [precisionLabel, precisionShare] = t ? (() => {
    if (t.day_f == null) return ['—', 0] as const;
    if (t.day_f >= 0.5) return ['whole days', t.day_f] as const;
    if (t.hour_f >= 0.5) return ['whole hours', t.hour_f] as const;
    if (t.minute_f >= 0.5) return ['whole minutes', t.minute_f] as const;
    if (t.second_f >= 0.5) return ['whole seconds', t.second_f] as const;
    if (t.milli_f >= 0.5) return ['whole milliseconds', t.milli_f] as const;
    return ['sub-millisecond', 1 - t.milli_f] as const;
  })() : (['—', 0] as const);
  const totalDaySpan = tr?.earliest && tr.latest
    ? Math.floor((new Date(tr.latest).getTime() - new Date(tr.earliest).getTime()) / 86400000) + 1 : 0;
  const activeDays = t ? num(t.active_days) || 0 : 0;
  const sharedTsShare = t?.ts_total ? 1 - num(t.ts_distinct) / Math.max(1, num(t.ts_total)) : 0;

  const activities: BreakdownItem[] = activityRows.rows?.map((r) => ({ name: r.name, n: num(r.n) })) ?? [];
  const resources: BreakdownItem[] = resourceRows.rows?.map((r) => ({ name: r.name, n: num(r.n) })) ?? [];

  const variants = variantRows.rows?.map((r) => ({ variant: r.variant, n: num(r.n) })) ?? [];
  const variantSpread = normalizedEntropy(variants.map((v) => v.n));
  const topVariants = variants.slice(0, 8);
  const totalCasesForVariants = variants.reduce((sum, v) => sum + v.n, 0);

  const semantics: any = (artifact.meta as any)?.semantics ?? null;

  return (
    <div className="view">
      <div className="ov-stat-grid">
        <StatCard value={c ? fmtCount(num(c.cases)) : '…'} label="Cases" />
        <StatCard value={c ? fmtCount(num(c.events)) : '…'} label="Events" />
        <StatCard value={c ? fmtCount(num(c.activities)) : '…'} label="Activities" />
        <StatCard value={vc ? fmtCount(num(vc.variants)) : '…'} label="Variants" />
      </div>

      <div className="ov-card">
        <div className="ov-card-title">Time Range</div>
        {timeRange.error || !tr ? <CardPending error={timeRange.error} /> : (
          <div className="ov-kv-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <KvItem label="Earliest event" value={tr.earliest ? new Date(tr.earliest).toLocaleString() : '—'} />
            <KvItem label="Latest event" value={tr.latest ? new Date(tr.latest).toLocaleString() : '—'} />
            <KvItem
              label="Duration"
              value={tr.earliest && tr.latest ? fmtDuration(new Date(tr.latest).getTime() - new Date(tr.earliest).getTime()) : '—'}
            />
          </div>
        )}
      </div>

      <div className="ov-grid-2">
        <div className="ov-card">
          <div className="ov-card-title">Timing Profile</div>
          {(timing.error || hourRows.error) || !t || !hourRows.rows ? <CardPending error={timing.error || hourRows.error} /> : (
            <>
              <StatRow label="Events per active day (median)" value={fmtCount(num(t.median_active))} />
              <StatRow label="Busiest day" value={fmtCount(num(t.busiest))} />
              <StatRow label="Active / idle days" value={`${activeDays} / ${Math.max(0, totalDaySpan - activeDays)}`} />
              <StatRow label="Median gap between events" value={fmtGap(num(t.median_gap_ms))} />
              <StatRow label="Timestamp precision" value={`${precisionLabel} (${Math.round(precisionShare * 100)}%)`} />
              <StatRow label="Events sharing a timestamp" value={`${Math.round(sharedTsShare * 100)}%`} />
              {tr?.earliest && (
                <div style={{ marginTop: 10 }}>
                  <div className="ov-hist-label">
                    Events by hour of day — peak {fmtCount(maxHour)} at {String(peakHour).padStart(2, '0')}:00
                  </div>
                  <div className="ov-hist">
                    {hourHistogram.map((n, h) => (
                      <i key={h} title={`${h}:00 — ${n}`} style={{ height: `${Math.max(3, (n / maxHour) * 100)}%` }} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="ov-card">
          <div className="ov-card-title">Case Structure</div>
          {structure.error || !s ? <CardPending error={structure.error} /> : (
            <>
              <StatRow label="Events per case (median / max)" value={`${num(s.median_events)} / ${num(s.max_events)}`} />
              <StatRow label="Case duration (median / max)" value={`${fmtGap(num(s.median_dur_ms))} / ${fmtGap(num(s.max_dur_ms))}`} />
              <StatRow label="Distinct start activities" value={fmtCount(num(s.n_start))} />
              <StatRow label="Distinct end activities" value={fmtCount(num(s.n_end))} />
              <StatRow label="Single-event cases" value={`${fmtCount(num(s.trivial_cases))} of ${fmtCount(num(s.total_cases))}`} />
              <StatRow
                label="Self-loop rate"
                value={s.df_pairs ? `${Math.round((num(s.self_loops) / Math.max(1, num(s.df_pairs))) * 100)}%` : '—'}
              />
            </>
          )}
        </div>
      </div>

      <div className="ov-grid-2">
        <div className="ov-card">
          <div className="ov-card-title">Activities</div>
          {activityRows.error || !activityRows.rows ? <CardPending error={activityRows.error} /> : (
            <BreakdownCard items={activities} colorDomain="activity" selectable artifact={artifact} panelId={panelId} sel={sel} />
          )}
        </div>
        <div className="ov-card">
          <div className="ov-card-title">Resources</div>
          {resourceRows.error || !resourceRows.rows ? <CardPending error={resourceRows.error} /> : (
            resources.length > 0
              ? <BreakdownCard items={resources} />
              : <span className="ov-empty">No resource attribute in this log.</span>
          )}
        </div>
      </div>

      <div className="ov-card">
        <div className="ov-card-title">Variants</div>
        <div className="ov-card-sub">Distinct end-to-end activity sequences, one per case.</div>
        {variantRows.error || !variantRows.rows ? <CardPending error={variantRows.error} /> : (
          <>
            <div className="ov-kv-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', marginBottom: 12 }}>
              <KvItem label="Distinct variants" value={vc ? fmtCount(num(vc.variants)) : '…'} />
              <KvItem label="Spread" value={variantSpread == null ? '—' : variantSpread.toFixed(2)} />
              <KvItem label="Case length (median / max)" value={s ? `${num(s.median_events)} / ${num(s.max_events)}` : '…'} />
            </div>
            <div className="ov-table-wrap">
              <table className="ov-table">
                <thead><tr><th>Path</th><th style={{ textAlign: 'right' }}>Cases</th></tr></thead>
                <tbody>
                  {topVariants.map((v) => {
                    const parts = v.variant.split(' → ');
                    const truncated = parts.length > 6 ? `${parts.slice(0, 6).join(' → ')} → … (${parts.length})` : v.variant;
                    return (
                      <tr key={v.variant}>
                        <td title={v.variant}>{truncated}</td>
                        <td style={{ textAlign: 'right' }}>
                          {fmtCount(v.n)}
                          {totalCasesForVariants > 0 && (
                            <span className="ov-bar-pct"> ({Math.round((v.n / totalCasesForVariants) * 100)}%)</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="ov-card">
        <div className="ov-card-title">Log Info</div>
        {attrCounts.error || !a ? <CardPending error={attrCounts.error} /> : (
          <>
            <div className="ov-kv-grid">
              <KvItem label="Event attributes" value={`${fmtCount(num(a.event_values))} values · ${fmtCount(num(a.event_keys))} keys`} />
              <KvItem label="Case attributes" value={`${fmtCount(num(a.case_values))} values · ${fmtCount(num(a.case_keys))} keys`} />
              <KvItem label="Stored (Parquet)" value={fmtBytes((artifact.meta as any)?.parquetBytes)} />
              <KvItem label="Import time" value={fmtMs((artifact.meta as any)?.importMs)} />
            </div>
            {semantics && (Array.isArray(semantics.extensions) && semantics.extensions.length > 0 || Array.isArray(semantics.classifiers) && semantics.classifiers.length > 0) && (
              <div style={{ marginTop: 10, fontSize: 12 }}>
                {Array.isArray(semantics.extensions) && semantics.extensions.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <b>Extensions:</b> {semantics.extensions.map((e: any) => e.prefix || e.name).join(', ')}
                  </div>
                )}
                {Array.isArray(semantics.classifiers) && semantics.classifiers.length > 0 && (
                  <div>
                    <b>Classifiers:</b> {semantics.classifiers.map((cl: any) => cl.name).join(', ')}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
