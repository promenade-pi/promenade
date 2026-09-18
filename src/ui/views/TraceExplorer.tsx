import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { useQuery, num } from './useQuery';
import { fmtCount, fmtDate, fmtMs } from '../format';
import { tableOf } from './tableName';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';

interface CaseRow { case_id: string; seq: string[]; length: number; start_ms: number; end_ms: number; total_cases: number; }
interface VariantRow {
  seq: string[]; case_count: number; avg_length: number; avg_duration_ms: number;
  example_cases: string[]; total_variants: number; total_case_count: number;
}
interface ActivityRow { activity: string; event_count: number; }

const VARIANT_LIMIT = 1000;
const SEQUENCE_VISIBLE = 6;
const PAGE_SIZES = [25, 50, 100];
type VariantSort = 'case_count' | 'share' | 'avg_length' | 'avg_duration_ms';
type CaseSort = 'start_asc' | 'start_desc' | 'duration_desc' | 'length_desc';

function variantKey(v: VariantRow) { return v.seq.join('\u0000'); }

/** Compact paths preserve scanability; each segment carries the complete activity name in a tooltip. */
function ActivityPath({ seq, panelId, artifactId, sel }: { seq: string[]; panelId: string; artifactId: string; sel: Selection }) {
  const shown = seq.slice(0, SEQUENCE_VISIBLE);
  const more = seq.length - shown.length;
  const selected = (activity: string) => sel.items.some((item) => item.kind === 'activity' && item.id === activity);
  return <div className="trace-path" title={seq.join(' → ')}>
    {shown.map((activity, index) => <button
      className={`trace-step${selected(activity) ? ' selected' : ''}`}
      key={`${activity}-${index}`} title={activity}
      style={{ '--activity-color': colorRegistry.get('activity', activity) } as CSSProperties}
      onClick={(event) => {
        event.stopPropagation();
        selectionBus.set(selected(activity) ? [] : [{ artifactId, kind: 'activity', id: activity }], panelId);
      }}
    >{activity}</button>)}
    {more > 0 && <span className="trace-more" title={`${more} more activities`}>+{more}</span>}
  </div>;
}

function SortHeader({ children, active, descending, onClick }: {
  children: React.ReactNode; active: boolean; descending: boolean; onClick: () => void;
}) {
  return <th className="num"><button className={`trace-sort${active ? ' active' : ''}`} onClick={onClick}>
    {children}<span aria-hidden="true">{active ? (descending ? '↓' : '↑') : '↕'}</span>
  </button></th>;
}

function Pagination({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (page: number) => void; onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const last = pages - 1;
  const visible = [...new Set([0, page - 1, page, page + 1, last].filter((p) => p >= 0 && p <= last))].sort((a, b) => a - b);
  return <div className="trace-pagination">
    <label>Rows per page <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
      {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
    </select></label>
    <span>{total ? `${fmtCount(page * pageSize + 1)}–${fmtCount(Math.min((page + 1) * pageSize, total))} of ${fmtCount(total)}` : 'No cases'}</span>
    <div className="trace-page-buttons">
      <button title="First page" disabled={page === 0} onClick={() => onPage(0)}>‹‹</button>
      <button title="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button>
      {visible.map((p, index) => <Fragment key={p}>
        {index > 0 && visible[index - 1] !== p - 1 && <span>…</span>}
        <button className={p === page ? 'active' : ''} onClick={() => onPage(p)}>{p + 1}</button>
      </Fragment>)}
      <button title="Next page" disabled={page >= last} onClick={() => onPage(page + 1)}>›</button>
      <button title="Last page" disabled={page >= last} onClick={() => onPage(last)}>››</button>
    </div>
  </div>;
}

export function TraceExplorer({ artifact, panelId, params, onParamChange }: {
  artifact: Artifact; panelId: string; params?: { coverage?: number }; onParamChange?: (key: string, value: unknown) => void;
}) {
  const [tab, setTab] = useState<'variants' | 'cases'>('variants');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  const [variantSort, setVariantSort] = useState<{ key: VariantSort; desc: boolean }>({ key: 'case_count', desc: true });
  const [caseSort, setCaseSort] = useState<CaseSort>('start_asc');
  const [casePage, setCasePage] = useState(0);
  const [casePageSize, setCasePageSize] = useState(50);
  const [legendFilter, setLegendFilter] = useState('');
  useEffect(() => {
    const unsubscribe = selectionBus.subscribe(setSel);
    return () => { unsubscribe(); };
  }, []);

  const coverage = params?.coverage ?? 95;
  const eventT = tableOf(artifact.id, 'event');
  const traceT = tableOf(artifact.id, 'trace');
  const revision = (artifact.meta as any)?.rev;
  const caseOrder: Record<CaseSort, string> = {
    start_asc: 'start_ms ASC, case_id ASC', start_desc: 'start_ms DESC, case_id ASC',
    duration_desc: '(end_ms - start_ms) DESC, case_id ASC', length_desc: 'length DESC, case_id ASC',
  };
  // DuckDB receives only a page. Pagination is data retrieval, not an in-memory slice of every trace.
  const casesSql = `
    WITH case_stats AS (
      SELECT t.case_id, list(e.activity ORDER BY e.ts, e.event_idx) AS seq, COUNT(*) AS length,
             epoch_ms(MIN(e.ts)) AS start_ms, epoch_ms(MAX(e.ts)) AS end_ms
      FROM ${traceT} t JOIN ${eventT} e ON e.trace_idx = t.trace_idx
      GROUP BY t.trace_idx, t.case_id
    )
    SELECT *, COUNT(*) OVER () AS total_cases FROM case_stats
    ORDER BY ${caseOrder[caseSort]}
    LIMIT ${casePageSize} OFFSET ${casePage * casePageSize}
  `;
  const variantsSql = `
    WITH cases AS (
      SELECT t.case_id, t.trace_idx, list(e.activity ORDER BY e.ts, e.event_idx) AS seq, COUNT(*) AS len,
             epoch_ms(MIN(e.ts)) AS start_ms, epoch_ms(MAX(e.ts)) AS end_ms
      FROM ${traceT} t JOIN ${eventT} e ON e.trace_idx = t.trace_idx
      GROUP BY t.trace_idx, t.case_id
    ), variants AS (
      SELECT seq, COUNT(*) AS case_count, AVG(len) AS avg_length, AVG(end_ms - start_ms) AS avg_duration_ms,
             array_slice(list(case_id ORDER BY start_ms), 1, 20) AS example_cases
      FROM cases GROUP BY seq
    )
    SELECT *, COUNT(*) OVER () AS total_variants, SUM(case_count) OVER () AS total_case_count
    FROM variants ORDER BY case_count DESC LIMIT ${VARIANT_LIMIT}
  `;
  const legendSql = `SELECT activity, COUNT(*) AS event_count FROM ${eventT} GROUP BY activity ORDER BY event_count DESC, activity`;

  const casesQ = useQuery<CaseRow>(tab === 'cases' ? casesSql : null, [artifact.id, revision, tab, casePage, casePageSize, caseSort]);
  const variantsQ = useQuery<VariantRow>(tab === 'variants' ? variantsSql : null, [artifact.id, revision, tab]);
  const legendQ = useQuery<ActivityRow>(tab === 'variants' ? legendSql : null, [artifact.id, revision, tab]);
  useEffect(() => { setCasePage(0); }, [artifact.id, revision, casePageSize, caseSort]);
  useEffect(() => { setExpanded(new Set()); }, [artifact.id, revision, coverage]);

  const cases = useMemo(() => casesQ.rows?.map((row) => ({ ...row, seq: Array.from(row.seq), start_ms: num(row.start_ms), end_ms: num(row.end_ms), total_cases: num(row.total_cases) })), [casesQ.rows]);
  const variants = useMemo(() => variantsQ.rows?.map((row) => ({
    ...row, seq: Array.from(row.seq), example_cases: Array.from(row.example_cases), case_count: num(row.case_count),
    avg_length: num(row.avg_length), avg_duration_ms: num(row.avg_duration_ms), total_variants: num(row.total_variants), total_case_count: num(row.total_case_count),
  })), [variantsQ.rows]);
  const legend = useMemo(() => legendQ.rows?.map((row) => ({ ...row, event_count: num(row.event_count) })), [legendQ.rows]);
  // Coverage remains frequency based even when the displayed table is sorted another way.
  const shownVariants = useMemo(() => {
    if (!variants?.length) return { rows: [] as VariantRow[], reachedCoverage: true };
    const target = (coverage / 100) * (variants[0].total_case_count || 1);
    let total = 0;
    const cutoff = variants.findIndex((variant) => (total += variant.case_count) >= target);
    return { rows: variants.slice(0, cutoff < 0 ? variants.length : cutoff + 1), reachedCoverage: cutoff >= 0 };
  }, [variants, coverage]);
  const sortedVariants = useMemo(() => [...shownVariants.rows].sort((a, b) => {
    const av = variantSort.key === 'share' ? a.case_count / (a.total_case_count || 1) : a[variantSort.key];
    const bv = variantSort.key === 'share' ? b.case_count / (b.total_case_count || 1) : b[variantSort.key];
    return (av - bv) * (variantSort.desc ? -1 : 1);
  }), [shownVariants.rows, variantSort]);
  const filteredLegend = useMemo(() => legend?.filter((entry) => entry.activity.toLowerCase().includes(legendFilter.toLowerCase())), [legend, legendFilter]);
  const changeVariantSort = (key: VariantSort) => setVariantSort((current) => current.key === key ? { key, desc: !current.desc } : { key, desc: true });
  const toggle = (key: string) => setExpanded((previous) => {
    const next = new Set(previous); next.has(key) ? next.delete(key) : next.add(key); return next;
  });

  return <div className="view trace-explorer">
    <div className="trace-header"><div><h2>Cases &amp; variants</h2><p>Explore the paths through this event log.</p></div>
      {tab === 'variants' && variants?.length ? <div className="trace-kpis"><span><b>{fmtCount(variants[0].total_case_count)}</b> cases</span><span><b>{fmtCount(variants[0].total_variants)}</b> variants</span></div> : null}
    </div>
    <div className="pd-tabs trace-tabs"><button className={tab === 'variants' ? 'active' : ''} onClick={() => setTab('variants')}>Variants</button><button className={tab === 'cases' ? 'active' : ''} onClick={() => setTab('cases')}>Cases</button></div>

    {tab === 'variants' && (() => {
      if (variantsQ.error || legendQ.error) return <div className="err">{variantsQ.error || legendQ.error}</div>;
      if (variantsQ.loading || legendQ.loading || !variants || !legend) return <div>Querying variants…</div>;
      if (!variants.length) return <div className="trace-empty">No cases yet.</div>;
      const totalVariants = variants[0].total_variants;
      return <div className="trace-layout"><main className="trace-main">
        <div className="trace-toolbar trace-variant-toolbar"><label className="trace-coverage">Coverage <input type="range" min={1} max={100} step={1} value={coverage} onInput={(event) => onParamChange?.('coverage', Number((event.target as HTMLInputElement).value))} /><b>{coverage}%</b></label><span>{fmtCount(shownVariants.rows.length)} of {fmtCount(totalVariants)} variants · {shownVariants.reachedCoverage ? `${coverage}% of cases` : 'coverage limit not reached'}</span></div>
        <div className="trace-table-wrap"><table className="grid trace-table trace-variants-table"><thead><tr><th className="trace-chevron-col" /><th>#</th><th>Variant path</th>
          <SortHeader active={variantSort.key === 'case_count'} descending={variantSort.desc} onClick={() => changeVariantSort('case_count')}>Cases</SortHeader>
          <SortHeader active={variantSort.key === 'share'} descending={variantSort.desc} onClick={() => changeVariantSort('share')}>Share</SortHeader>
          <SortHeader active={variantSort.key === 'avg_length'} descending={variantSort.desc} onClick={() => changeVariantSort('avg_length')}>Avg. events</SortHeader>
          <SortHeader active={variantSort.key === 'avg_duration_ms'} descending={variantSort.desc} onClick={() => changeVariantSort('avg_duration_ms')}>Avg. duration</SortHeader>
        </tr></thead><tbody>{sortedVariants.map((variant, index) => {
          const key = variantKey(variant), open = expanded.has(key);
          return <Fragment key={key}><tr className="clickable" onClick={() => toggle(key)}><td className="trace-chevron-col"><span className={`trace-chevron${open ? ' open' : ''}`}>›</span></td><td className="trace-rank">{index + 1}</td><td><ActivityPath seq={variant.seq} panelId={panelId} artifactId={artifact.id} sel={sel} /></td><td className="num">{fmtCount(variant.case_count)}</td><td className="num">{((variant.case_count / (variant.total_case_count || 1)) * 100).toFixed(1)}%</td><td className="num">{Math.round(variant.avg_length)}</td><td className="num">{fmtMs(variant.avg_duration_ms)}</td></tr>
            {open && <tr className="trace-detail-row"><td /><td /><td colSpan={5}><div className="trace-detail-sequence">{variant.seq.join(' → ')}</div><div className="trace-detail-label">Example cases</div><div className="trace-case-chips">{variant.example_cases.map((id) => <span className="chip" key={id}>{id}</span>)}{variant.case_count > variant.example_cases.length && <span className="chip">+{fmtCount(variant.case_count - variant.example_cases.length)} more</span>}</div></td></tr>}
          </Fragment>;
        })}</tbody></table></div>
      </main><aside className="trace-legend"><div className="trace-legend-head"><h3>Legend</h3><span>{fmtCount(legend.length)} activities</span></div><input aria-label="Search activities" value={legendFilter} onChange={(event) => setLegendFilter(event.target.value)} placeholder="Search activities…" /><div className="trace-legend-list">{filteredLegend?.map((entry) => {
        const isSelected = sel.items.some((item) => item.kind === 'activity' && item.id === entry.activity);
        return <button className={`trace-legend-row${isSelected ? ' selected' : ''}`} key={entry.activity} title={entry.activity} onClick={() => selectionBus.set(isSelected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: entry.activity }], panelId)}><i style={{ background: colorRegistry.get('activity', entry.activity) }} /><span>{entry.activity}</span><b>{fmtCount(entry.event_count)}</b></button>;
      })}</div></aside></div>;
    })()}

    {tab === 'cases' && (() => {
      if (casesQ.error) return <div className="err">{casesQ.error}</div>;
      if (casesQ.loading || !cases) return <div>Loading cases…</div>;
      const total = cases[0]?.total_cases ?? 0;
      return <div className="trace-main trace-cases"><div className="trace-toolbar"><span>{total ? `${fmtCount(total)} cases` : 'No cases yet'}</span><label>Sort <select value={caseSort} onChange={(event) => { setCaseSort(event.target.value as CaseSort); setCasePage(0); }}><option value="start_asc">Start time · oldest first</option><option value="start_desc">Start time · newest first</option><option value="duration_desc">Duration · longest first</option><option value="length_desc">Events · most first</option></select></label></div>
        <div className="trace-table-wrap"><table className="grid trace-table"><thead><tr><th>Case</th><th>Path</th><th className="num">Events</th><th>Start</th><th>End</th><th className="num">Duration</th></tr></thead><tbody>{cases.map((caseRow) => <tr key={caseRow.case_id}><td className="trace-case-id" title={caseRow.case_id}>{caseRow.case_id}</td><td><ActivityPath seq={caseRow.seq} panelId={panelId} artifactId={artifact.id} sel={sel} /></td><td className="num">{fmtCount(caseRow.length)}</td><td>{fmtDate(caseRow.start_ms)}</td><td>{fmtDate(caseRow.end_ms)}</td><td className="num">{fmtMs(caseRow.end_ms - caseRow.start_ms)}</td></tr>)}</tbody></table></div>
        <Pagination page={casePage} pageSize={casePageSize} total={total} onPage={setCasePage} onPageSize={(size) => { setCasePageSize(size); setCasePage(0); }} />
      </div>;
    })()}
  </div>;
}
