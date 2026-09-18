export function fmtBytes(b?: number | null): string {
  if (b == null) return '—';
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtCount(n?: number | null): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

export function fmtDate(v: unknown): string {
  if (v == null) return '—';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

export function fmtMs(ms?: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A calendar span (a log's time range, a case's lifetime) — coarser and
 * friendlier than `fmtMs`, which is for a computation's wall-clock time. */
export function fmtDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const days = ms / 86400000;
  if (days < 1) return '<1 day';
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 365) return `~${Math.round(days / 30)} month${Math.round(days / 30) === 1 ? '' : 's'}`;
  return `~${(days / 365).toFixed(1)} years`;
}

/** A gap between two events — seconds through days, picking the coarsest
 * unit that keeps the number readable. */
export function fmtGap(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${(s / 60).toFixed(1)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
