/**
 * One vertical percentile slider: label, live readout, track, reset.
 *
 * Shared by every activity-graph view (DFG, Causal Net, …) that filters an
 * already-fetched result by percentile rather than recomputing — see
 * `DfgView.tsx` for why that belongs to the view (`ownsControls`) rather
 * than the generic inspector.
 */
export function PercentFilter({
  label, value, onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="dfg-filter">
      <div className="dfg-filter-label">{label}</div>
      <div className="dfg-filter-pct">{value}%</div>
      <div className="dfg-filter-track">
        <input
          type="range" min={1} max={100} step={1} value={value}
          // `input`, not `change`: the graph is meant to follow the drag.
          onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
        />
      </div>
      <button
        className="dfg-filter-reset" disabled={value === 100}
        onClick={() => onChange(100)}
      >
        Reset
      </button>
    </div>
  );
}
