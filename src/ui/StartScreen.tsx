/**
 * Task-oriented start screen.
 *
 * Deliberately not an empty workspace and deliberately not a mode switcher.
 * Orientation comes from naming the thing the user wants to do; picking one
 * opens the panels that job needs. There is no global state behind these —
 * they are shortcuts to an arrangement, not perspectives.
 */
export function StartScreen({
  booted, onPickFile,
}: { booted: boolean; onPickFile: () => void }) {
  return (
    <div className="empty">
      <div className="start-screen">
        <h2>Start</h2>
        <p>
          {booted
            ? 'Import an event log, or pick a task to open the panels it needs.'
            : 'Starting the query engine…'}
        </p>

        <button className="task-card" disabled={!booted} onClick={onPickFile}>
          <b>Discover a process from a log</b>
          <span>Import an XES or OCEL 2.0 log, then open the overview and activity panels.</span>
        </button>

        <button className="task-card" disabled={!booted} onClick={onPickFile}>
          <b>Examine log quality</b>
          <span>Import a log and inspect activities, attributes and time coverage.</span>
        </button>

        <p style={{ marginTop: 22, fontSize: 11.5 }}>
          Supports XES, PNML, and OCEL 2.0 JSON, XML, SQLite, CSV, and CSV or Parquet bundles.
          ProM-compatible event-table CSV files are supported too.
        </p>
      </div>
    </div>
  );
}
