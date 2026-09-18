import { useCallback, useState } from 'react';

const MIN = 0.25;
const MAX = 2.5;
const STEP = 0.15;

const clamp = (z: number) => Math.min(MAX, Math.max(MIN, +z.toFixed(2)));

/** Shared zoom state for diagram views — DFG and causal net both use it. */
export function useZoom(initial = 1) {
  const [zoom, setZoom] = useState(initial);
  const zoomIn = useCallback(() => setZoom((z) => clamp(z + STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => clamp(z - STEP)), []);
  const reset = useCallback(() => setZoom(1), []);
  // Ctrl/Cmd+wheel zooms, like every other pan-and-zoom canvas; a plain
  // wheel still scrolls the container normally.
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => clamp(z - e.deltaY * 0.001));
  }, []);
  return { zoom, zoomIn, zoomOut, reset, onWheel };
}
