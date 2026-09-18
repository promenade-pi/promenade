/**
 * Renders `application/vnd.promenade.dataframe+json` — a Promenade-native
 * table, not a raw `DataFrame.to_html()` dump. Structured JSON rather than
 * markup, so there is nothing here to sanitize. See
 * docs/python-notebook.md, "MIME / output handling".
 */

export interface DataFramePayload {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  totalCols: number;
  shownRows: number;
  shownCols: number;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function DataFrameTable({ data }: { data: DataFramePayload }) {
  const truncated = data.totalRows > data.shownRows || data.totalCols > data.shownCols;
  return (
    <div className="notebook-df">
      {truncated && (
        <div className="notebook-df-note">
          showing {data.shownRows.toLocaleString()} of {data.totalRows.toLocaleString()} rows
          {data.totalCols > data.shownCols
            ? `, ${data.shownCols} of ${data.totalCols} columns` : ''}
        </div>
      )}
      <div className="notebook-df-scroll">
        <table>
          <thead>
            <tr>
              <th className="notebook-df-rownum" />
              {data.columns.map((c, i) => <th key={i}>{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="notebook-df-rownum">{ri}</td>
                {row.map((v, ci) => <td key={ci}>{cell(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
