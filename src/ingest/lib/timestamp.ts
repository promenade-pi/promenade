/**
 * Timestamps at microsecond resolution, for import and export.
 *
 * `Date.parse` returns integer milliseconds and silently discards anything
 * finer, and `Date.prototype.toISOString` writes exactly three fractional
 * digits. Both were on every path in and out of this app, which is a real
 * loss: XES and OCEL 2.0 both type their timestamps as ISO 8601 /
 * `xs:dateTime`, and neither mandates a resolution. A source stamped
 * `10:00:00.000100` and one stamped `10:00:00.000400` arrived as the *same*
 * instant — so Promenade manufactured ties that were not in the file and then
 * reported them as a data-quality problem.
 *
 * DuckDB's `TIMESTAMP` is microsecond-resolution, which is what the storage
 * layer can carry; digits beyond that are floored away. Floor rather than
 * round, because flooring is monotone: two instants the source ordered can
 * collapse into one, but they can never swap.
 */

/**
 * ISO 8601 with an optional fractional part and an optional zone.
 *
 * Only the fraction and the zone are captured. The date and time fields are
 * left to `Date.parse`, which already handles them (and their surprising
 * corners) correctly — this splits off the sub-millisecond digits it would
 * throw away and puts them back afterwards.
 */
const ISO_FRACTION = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.(\d+)(.*)$/;

function fromString(text: string): number | null {
  const match = ISO_FRACTION.exec(text);
  if (!match) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms * 1000 : null;
  }
  const [, head, fraction, zone] = match;
  // Re-parse with the fraction truncated to milliseconds so `Date.parse` sees
  // a form it handles exactly, then add back the digits it dropped.
  const ms = Date.parse(`${head}.${fraction.slice(0, 3).padEnd(3, '0')}${zone}`);
  if (!Number.isFinite(ms)) return null;
  const extra = Number(fraction.slice(3, 6).padEnd(3, '0'));
  // Added in both directions: before the epoch `ms` is negative while the
  // fraction still counts *forward* in time, and `Date.parse` already returns
  // the millisecond part on that same convention.
  return Number.isFinite(extra) ? ms * 1000 + extra : ms * 1000;
}

/**
 * Epoch microseconds for anything a log carries a time as, or null.
 *
 * A plain number is epoch **milliseconds, possibly fractional** — which is not
 * an arbitrary choice but what both producers actually hand over. DuckDB's
 * `TIMESTAMP` columns cross the Arrow boundary that way (`10:00:00.123456`
 * arrives as `1704103200123.456`), and the OCEL SQLite and Parquet readers
 * hand over epoch milliseconds too.
 */
export function epochMicros(value: unknown): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms * 1000 : null;
  }
  if (typeof value === 'bigint') return Number(value) * 1000;
  if (typeof value === 'number') {
    // Round, not floor. The value is already an exact microsecond count
    // divided by 1000, so rounding recovers the integer it came from;
    // flooring would lose a microsecond whenever the binary representation
    // lands a hair below it. (Flooring is the right rule for *parsing* a
    // string with more digits than microseconds, which is a real truncation.)
    return Number.isFinite(value) ? Math.round(value * 1000) : null;
  }
  const text = String(value).trim();
  return text ? fromString(text) : null;
}

/** The same value as a `BigInt` for an Arrow `i64` column, or null. */
export function epochMicrosBigInt(value: unknown): bigint | null {
  const micros = epochMicros(value);
  return micros == null ? null : BigInt(Math.floor(micros));
}

/**
 * ISO 8601 with microsecond precision, or null when it is not a timestamp.
 *
 * `toISOString` writes three fractional digits and no more, so the remaining
 * microseconds are appended; a timestamp that has none is left in the familiar
 * three-digit form rather than padded out to six.
 */
export function isoMicros(value: unknown): string | null {
  const micros = epochMicros(value);
  if (micros == null) return null;
  // Floor, so the split is correct on both sides of the epoch: `-0.75ms` is
  // millisecond `-1` plus 250µs, not millisecond `0` minus 750µs.
  const ms = Math.floor(micros / 1000);
  const rest = micros - ms * 1000;
  const base = new Date(ms);
  if (Number.isNaN(base.getTime())) return null;
  const text = base.toISOString();
  return rest ? text.replace(/Z$/, `${String(rest).padStart(3, '0')}Z`) : text;
}
