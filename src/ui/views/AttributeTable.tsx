import type { Artifact } from '../../host/artifact/types';
import { logicalTablesOf } from '../../host/artifact/tables';
import { useQuery, num } from './useQuery';
import { fmtCount } from '../format';
import { tableOf } from './tableName';

/**
 * Attribute coverage.
 *
 * XES keeps non-core attributes in a long-format side table so nothing from
 * the source is lost while the typed columns stay narrow; OCEL exposes the
 * E2O relation instead. The view picks the query from the artifact type,
 * which is exactly the kind of format knowledge that should live in a view
 * and not in the data model.
 */
export function AttributeTable({ artifact }: { artifact: Artifact }) {
  const isXES = artifact.type === 'TraditionalEventLog';
  const files = Object.fromEntries(logicalTablesOf(artifact).map((l) => [l, true]));

  /**
   * OCEL keeps object attributes with a timestamp per value, so an attribute
   * is time-dependent exactly when some object has more than one value for it.
   * That is reported per attribute rather than assumed, and event attributes
   * and object attributes are shown in one list because the user is asking
   * "what is in this log", not "which table is it in".
   */
  const sql = isXES
    ? (files['event_attr']
        ? `SELECT key, type, 'event' AS scope, COUNT(*) AS n,
                  COUNT(DISTINCT value) AS distinct_values, false AS time_dependent
           FROM ${tableOf(artifact.id, 'event_attr')}
           GROUP BY 1, 2 ORDER BY n DESC LIMIT 200`
        : null)
    // A sink that never received a row leaves no table behind, so an OCEL log
    // with no event attributes simply has no event_attr table. The query is
    // assembled from what actually exists rather than assuming both.
    : (files['object_attr']
        ? `SELECT * FROM (
             ${files['event_attr'] ? `
             SELECT name AS key, 'event' AS scope, COUNT(*) AS n,
                    COUNT(DISTINCT value) AS distinct_values,
                    false AS time_dependent
             FROM ${tableOf(artifact.id, 'event_attr')} GROUP BY 1, 2
             UNION ALL` : ''}
             SELECT a.name AS key, 'object' AS scope, COUNT(*) AS n,
                    COUNT(DISTINCT a.value) AS distinct_values,
                    COUNT(*) FILTER (WHERE v.varying) > 0 AS time_dependent
             FROM ${tableOf(artifact.id, 'object_attr')} a
             LEFT JOIN (
               SELECT object_id, name, COUNT(DISTINCT ts) > 1 AS varying
               FROM ${tableOf(artifact.id, 'object_attr')} GROUP BY 1, 2
             ) v ON v.object_id = a.object_id AND v.name = a.name
             GROUP BY 1, 2
           ) ORDER BY n DESC LIMIT 200`
        : null);

  // The query text is part of the dependency: it varies with the artifact's
  // shape, not just its id.
  const { rows, error, loading } = useQuery<any>(sql, [artifact.id, sql, (artifact.meta as any)?.rev]);

  if (!sql) return <div className="view" style={{ color: 'var(--text-dim)' }}>No attribute table for this artifact.</div>;
  if (error) return <div className="view"><div className="err">{error}</div></div>;
  if (loading || !rows) return <div className="view">Querying…</div>;

  return (
    <div className="view">
      <table className="grid">
        <thead>
          <tr>
            <th>Attribute</th>
            <th>Scope</th>
            <th style={{ textAlign: 'right' }}>Values</th>
            <th style={{ textAlign: 'right' }}>Distinct</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.key}-${r.scope}-${i}`}>
              <td>
                {String(r.key ?? '(none)')}
                {r.time_dependent && (
                  <span className="chip" style={{ marginLeft: 6 }}>time-dependent</span>
                )}
              </td>
              <td style={{ color: 'var(--text-dim)' }}>{String(r.scope ?? r.type)}</td>
              <td className="num">{fmtCount(num(r.n))}</td>
              <td className="num">{fmtCount(num(r.distinct_values))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
