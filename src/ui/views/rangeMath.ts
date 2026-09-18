export type RangeHandle = 'start' | 'end';

/** Convert a pointer coordinate into a bounded percentage along a rail. */
export function pointerPercent(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.max(0, Math.min(100, ((clientX - left) / width) * 100));
}

/** Convert between Ocelot-style [0, 100] slider state and epoch milliseconds. */
export function epochAtPercent(lower: number, upper: number, percent: number): number {
  const bounded = Math.max(0, Math.min(100, percent));
  return lower + (upper - lower) * bounded / 100;
}

export function percentAtEpoch(lower: number, upper: number, epoch: number): number {
  const span = upper - lower;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(100, (epoch - lower) / span * 100));
}

/** Move one handle without ever changing or crossing the other handle. */
export function clampRangeHandle(
  handle: RangeHandle,
  value: number,
  start: number,
  end: number,
): [number, number] {
  const bounded = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return handle === 'start'
    ? [Math.min(bounded, end), end]
    : [start, Math.max(bounded, start)];
}

/** Percentage produced by the keyboard for an accessible custom thumb. */
export function keyboardPercent(key: string, current: number, largeStep = false): number | null {
  const step = largeStep ? 5 : .5;
  if (key === 'Home') return 0;
  if (key === 'End') return 100;
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, current - step);
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(100, current + step);
  return null;
}
