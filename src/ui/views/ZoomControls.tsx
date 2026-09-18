/** Floating +/− zoom cluster, pinned to a diagram view's own corner. */
export function ZoomControls({
  zoom, onZoomIn, onZoomOut, onReset,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}) {
  return (
    <div className="zoom-controls">
      <button onClick={onZoomOut} title="Zoom out" aria-label="Zoom out">−</button>
      <button className="zoom-pct" onClick={onReset} title="Reset zoom">{Math.round(zoom * 100)}%</button>
      <button onClick={onZoomIn} title="Zoom in" aria-label="Zoom in">+</button>
    </div>
  );
}
