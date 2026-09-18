import { useEffect, useState } from 'react';
import type { Artifact } from '../../host/artifact/types';
import { useQuery, num } from './useQuery';
import { fmtCount } from '../format';
import { colorRegistry } from '../../host/services/colors';
import { selectionBus, type Selection } from '../../host/services/selection';
import { tableOf } from './tableName';

/**
 * Activity frequencies, queried live through host.sql().
 *
 * Also the demonstration of the selection bus: clicking a row publishes
 * (artifactId, 'activity', name), and any other panel showing the same
 * artifact highlights the same activity without knowing this view exists.
 */
export function ActivityTable({ artifact, panelId }: { artifact: Artifact; panelId: string }) {
  const t = tableOf(artifact.id, 'event');
  const { rows, error, loading } = useQuery<{ activity: string; n: number }>(
    `SELECT activity, COUNT(*) AS n FROM ${t}
     GROUP BY 1 ORDER BY n DESC LIMIT 200`,
    // `rev` changes whenever a derived log's plan is rebuilt: the SQL text is
    // identical, only the view behind the name has changed.
    [artifact.id, (artifact.meta as any)?.rev]
  );

  const [sel, setSel] = useState<Selection>(selectionBus.get());
  useEffect(() => selectionBus.subscribe(setSel), []);

  if (error) return <div className="view"><div className="err">{error}</div></div>;
  if (loading || !rows) return <div className="view">Querying…</div>;

  return (
    <div className="view">
      <table className="grid">
        <thead>
          <tr><th>Activity</th><th style={{ textAlign: 'right' }}>Events</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const name = String(r.activity ?? '(null)');
            const selected = sel.items.some(
              (i) => i.artifactId === artifact.id && i.kind === 'activity' && i.id === name
            );
            return (
              <tr
                key={name}
                className={`clickable${selected ? ' sel' : ''}`}
                onClick={() => selectionBus.set(
                  selected ? [] : [{ artifactId: artifact.id, kind: 'activity', id: name }],
                  panelId
                )}
              >
                <td>
                  <span className="swatch" style={{ background: colorRegistry.get('activity', name) }} />
                  {name}
                </td>
                <td className="num">{fmtCount(num(r.n))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
