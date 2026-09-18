/**
 * Renders one code cell's output list: streams, rich MIME bundles, and
 * errors. See docs/python-notebook.md, "MIME / output handling".
 */

import { useState } from 'react';
import type { CellOutput } from '../../host/notebook/document';
import { DataFrameTable, type DataFramePayload } from './DataFrameTable';
import { sanitizeHtml } from './sanitizeHtml';

/** Strips ANSI color escapes some Python packages (pm4py's banner, tqdm) write to stdout/stderr. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

interface PublishedSummary { id: string; name: string; type: string; summary: string }

function PublishedCard({
  summary, onOpenArtifact, onFocusArtifact,
}: {
  summary: PublishedSummary;
  onOpenArtifact?: (id: string) => void;
  onFocusArtifact?: (id: string) => void;
}) {
  return (
    <div className="notebook-published">
      <div className="notebook-published-badge">✓ Published artifact</div>
      <strong>{summary.name}</strong>
      <div className="notebook-published-meta">{summary.type} · {summary.summary}</div>
      <div className="notebook-published-actions">
        <button type="button" onClick={() => onOpenArtifact?.(summary.id)}>Open</button>
        <button type="button" onClick={() => onFocusArtifact?.(summary.id)}>Show in artifact tree</button>
      </div>
    </div>
  );
}

function MimeBundleView({
  data, onOpenArtifact, onFocusArtifact,
}: {
  data: Record<string, unknown>;
  onOpenArtifact?: (id: string) => void;
  onFocusArtifact?: (id: string) => void;
}) {
  const published = data['application/vnd.promenade.published+json'];
  if (typeof published === 'string') {
    return <PublishedCard summary={JSON.parse(published)} onOpenArtifact={onOpenArtifact} onFocusArtifact={onFocusArtifact} />;
  }
  const df = data['application/vnd.promenade.dataframe+json'];
  if (typeof df === 'string') {
    return <DataFrameTable data={JSON.parse(df) as DataFramePayload} />;
  }
  if (typeof data['image/png'] === 'string') {
    return <img className="notebook-output-image" src={`data:image/png;base64,${data['image/png']}`} alt="cell output" />;
  }
  if (typeof data['image/svg+xml'] === 'string') {
    // eslint-disable-next-line react/no-danger
    return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(data['image/svg+xml'] as string) }} />;
  }
  if (typeof data['text/html'] === 'string') {
    // eslint-disable-next-line react/no-danger
    return <div className="notebook-output-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(data['text/html'] as string) }} />;
  }
  if (typeof data['application/json'] === 'string') {
    let pretty = data['application/json'] as string;
    try { pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* leave as-is */ }
    return <pre className="notebook-output-json">{pretty}</pre>;
  }
  if (typeof data['text/plain'] === 'string') {
    return <pre className="notebook-output-text">{data['text/plain'] as string}</pre>;
  }
  return null;
}

function ErrorOutput({ output }: { output: Extract<CellOutput, { outputType: 'error' }> }) {
  const [open, setOpen] = useState(output.traceback.length <= 3);
  return (
    <div className="notebook-error">
      <div className="notebook-error-head">{output.ename}: {output.evalue}</div>
      {output.traceback.length > 0 && (
        open
          ? <pre className="notebook-error-traceback">{output.traceback.join('')}</pre>
          : <button type="button" className="notebook-error-toggle" onClick={() => setOpen(true)}>Show traceback</button>
      )}
    </div>
  );
}

export function OutputView({
  outputs, onOpenArtifact, onFocusArtifact,
}: {
  outputs: CellOutput[];
  onOpenArtifact?: (id: string) => void;
  onFocusArtifact?: (id: string) => void;
}) {
  if (!outputs.length) return null;
  return (
    <div className="notebook-outputs">
      {outputs.map((o, i) => {
        if (o.outputType === 'stream') {
          return <pre key={i} className={`notebook-stream notebook-stream-${o.name}`}>{stripAnsi(o.text)}</pre>;
        }
        if (o.outputType === 'error') return <ErrorOutput key={i} output={o} />;
        return (
          <div key={i} className="notebook-output">
            <MimeBundleView data={o.data} onOpenArtifact={onOpenArtifact} onFocusArtifact={onFocusArtifact} />
          </div>
        );
      })}
    </div>
  );
}
