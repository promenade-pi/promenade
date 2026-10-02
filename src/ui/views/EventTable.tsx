import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { logicalTablesOf } from '../../host/artifact/tables';
import { useQuery, num } from './useQuery';
import { fmtCount } from '../format';
import { tableOf } from './tableName';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { Pagination } from './TraceExplorer';

/**
 * Every event of a case-centric log, one row each — the `TraditionalEventLog`
 * counterpart of the OCEL Inspector's Events view, and where the Overview's
 * "Events" tile leads.
 *
 * Paged in DuckDB, never sliced in memory: a log can have millions of events
 * and the panel only ever shows one page. Attributes live in the long-format
 * `event_attr` side table, so they are fetched for the page's events only and
 * pivoted here; the column set is the log's most common keys, decided once,
 * so paging doesn't make columns appear and disappear.
 */

const MAX_ATTR_COLUMNS = 12;

interface EventRow {
  event_idx: number; case_id: string; activity: string | null; ts_ms: number | null;
  resource: string | null; lifecycle: string | null; total: number;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** A full timestamp, not just the date — two events of one case are often
 * minutes apart. Milliseconds only when the log actually records them. */
const fmtTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');

export function EventTable({ artifact, panelId }: { artifact: Artifact; panelId: string }) {
  const eventT = tableOf(artifact.id, 'event');
  const traceT = tableOf(artifact.id, 'trace');
  const hasAttrs = logicalTablesOf(artifact).includes('event_attr');
  const attrT = tableOf(artifact.id, 'event_attr');
  const revision = (artifact.meta as any)?.rev;

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [order, setOrder] = useState<'time' | 'case'>('time');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => { const off = selectionBus.subscribe(setSel); return () => { off(); }; }, []);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  // The activity filter follows the shared selection, so picking an activity
  // in the Overview, the Activities table or a DFG narrows this table too.
  const selectedActivity = sel.items.find((i) => i.artifactId === artifact.id && i.kind === 'activity')?.id ?? null;

  useEffect(() => { setPage(0); }, [artifact.id, revision, pageSize, order, search, selectedActivity]);

  const where = [
    selectedActivity != null ? `e.activity = ${lit(selectedActivity)}` : null,
    search ? `(t.case_id ILIKE ${lit(`%${search}%`)} OR e.activity ILIKE ${lit(`%${search}%`)} OR e.resource ILIKE ${lit(`%${search}%`)})` : null,
  ].filter(Boolean);
  const orderBy = order === 'time'
    ? 'e.ts NULLS LAST, e.trace_idx, e.event_idx'
    : 'e.trace_idx, e.ts NULLS LAST, e.event_idx';

  const pageQ = useQuery<EventRow>(`
    SELECT e.event_idx, t.case_id, e.activity, epoch_ms(e.ts) AS ts_ms,
           e.resource, e.lifecycle, COUNT(*) OVER () AS total
    FROM ${eventT} e JOIN ${traceT} t ON t.trace_idx = e.trace_idx
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${orderBy}
    LIMIT ${pageSize} OFFSET ${page * pageSize}
  `, [artifact.id, revision, page, pageSize, order, search, selectedActivity]);

  // Which optional columns this log actually has — an all-null Resource
  // column is just noise.
  const shapeQ = useQuery<{ has_resource: boolean; has_lifecycle: boolean }>(`
    SELECT COUNT(resource) FILTER (WHERE resource <> '') > 0 AS has_resource,
           COUNT(lifecycle) FILTER (WHERE lifecycle <> '') > 0 AS has_lifecycle
    FROM ${eventT}
  `, [artifact.id, revision]);

  const keysQ = useQuery<{ key: string }>(hasAttrs ? `
    SELECT key FROM ${attrT} WHERE key IS NOT NULL
    GROUP BY key ORDER BY COUNT(*) DESC, key LIMIT ${MAX_ATTR_COLUMNS}
  ` : null, [artifact.id, revision, hasAttrs]);
  const attrKeys = useMemo(() => keysQ.rows?.map((r) => String(r.key)) ?? [], [keysQ.rows]);

  const rows = useMemo(() => pageQ.rows?.map((r) => ({
    ...r, event_idx: num(r.event_idx), ts_ms: r.ts_ms == null ? null : num(r.ts_ms), total: num(r.total),
  })) ?? null, [pageQ.rows]);

  const idList = rows?.map((r) => r.event_idx).join(',') ?? '';
  const attrQ = useQuery<{ event_idx: number; key: string; value: string }>(
    hasAttrs && attrKeys.length && idList ? `
      SELECT event_idx, key, CAST(value AS VARCHAR) AS value FROM ${attrT}
      WHERE event_idx IN (${idList}) AND key IN (${attrKeys.map(lit).join(',')})
    ` : null,
    [artifact.id, revision, idList, attrKeys.join('\u0000')]
  );
  const attrsByEvent = useMemo(() => {
    const m = new Map<number, Record<string, string>>();
    for (const a of attrQ.rows ?? []) {
      const idx = num(a.event_idx);
      if (!m.has(idx)) m.set(idx, {});
      m.get(idx)![a.key] = a.value;
    }
    return m;
  }, [attrQ.rows]);

  const shape = shapeQ.rows?.[0];
  const total = rows?.[0]?.total ?? 0;

  return <div className="view trace-explorer">
    <div className="trace-header"><div><h2>Events</h2><p>Every event in this log, one row each.</p></div></div>
    <div className="trace-main trace-cases">
      <div className="trace-toolbar event-toolbar">
        <input
          aria-label="Search events" placeholder="Search case, activity or resource…"
          value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
        />
        {selectedActivity != null && (
          <button
            className="chip" title="Clear the activity filter"
            onClick={() => selectionBus.set([], panelId)}
          >
            <span className="swatch" style={{ background: colorRegistry.get('activity', selectedActivity) }} />
            {selectedActivity} ✕
          </button>
        )}
        <span style={{ whiteSpace: 'nowrap' }}>{rows ? `${fmtCount(total)} events` : ''}</span>
        <label>Order <select value={order} onChange={(e) => setOrder(e.target.value as 'time' | 'case')}>
          <option value="time">By time</option>
          <option value="case">By case</option>
        </select></label>
      </div>
      {pageQ.error ? <div className="err">{pageQ.error}</div>
        : !rows ? <div>Querying events…</div>
        : !rows.length ? <div className="trace-empty">No events match.</div>
        : <div className="trace-table-wrap event-table-wrap"><table className="grid trace-table event-table">
          <thead><tr>
            <th>Case</th><th>Activity</th><th>Timestamp</th>
            {shape?.has_resource && <th>Resource</th>}
            {shape?.has_lifecycle && <th>Lifecycle</th>}
            {attrKeys.map((k) => <th key={k}>{k}</th>)}
          </tr></thead>
          <tbody>{rows.map((r) => {
            const attrs = attrsByEvent.get(r.event_idx) ?? {};
            const name = r.activity ?? '(null)';
            const selected = selectedActivity === name;
            return <tr key={r.event_idx}>
              <td className="trace-case-id" title={r.case_id}>{r.case_id}</td>
              <td>
                <button
                  className={`trace-step${selected ? ' selected' : ''}`} title={name}
                  style={{ '--activity-color': colorRegistry.get('activity', name) } as CSSProperties}
                  onClick={() => selectionBus.set(selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: name }], panelId)}
                >{name}</button>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{r.ts_ms == null ? '—' : fmtTs(r.ts_ms)}</td>
              {shape?.has_resource && <td>{r.resource ?? ''}</td>}
              {shape?.has_lifecycle && <td>{r.lifecycle ?? ''}</td>}
              {attrKeys.map((k) => <td key={k} title={attrs[k]}>{attrs[k] ?? ''}</td>)}
            </tr>;
          })}</tbody>
        </table></div>}
      {rows && total > 0 && (
        <Pagination
          page={page} pageSize={pageSize} total={total} onPage={setPage}
          onPageSize={(size) => { setPageSize(size); setPage(0); }}
        />
      )}
    </div>
  </div>;
}
