import { useEffect, useState } from 'react';
import type * as arrow from 'apache-arrow';
import { dataClient } from '../../host/data/client';

/**
 * Views get their data through host.sql() and nothing else.
 *
 * The same rule that will apply to plugins applies to the built-in views, so
 * the boundary is exercised from day one rather than discovered to leak later.
 */
export function useQuery<T = any>(sql: string | null, deps: unknown[] = []) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [table, setTable] = useState<arrow.Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!sql) { setRows(null); return; }
    let canceled = false;
    setLoading(true);
    setError(null);
    dataClient.sql(sql)
      .then((t) => {
        if (canceled) return;
        setTable(t);
        setRows(t.toArray().map((r: any) => r.toJSON() as T));
      })
      .catch((e) => !canceled && setError(String(e.message ?? e)))
      .finally(() => !canceled && setLoading(false));
    return () => { canceled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { rows, table, error, loading };
}

/** DuckDB returns BigInt for counts; views want numbers. */
export const num = (v: unknown): number =>
  typeof v === 'bigint' ? Number(v) : (v as number);
