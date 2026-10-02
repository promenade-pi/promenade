/**
 * What flattening an OCEL by a given object type costs, as SQL.
 *
 * Lives beside `compile.ts` rather than in the view that renders it because
 * it is the same kind of thing: a statement about what the flatten plan does,
 * which has to stay true to `compile.ts` statement by statement. A preview
 * that disagrees with the result it previews is worse than no preview, so the
 * agreement is asserted directly — `test/transform/flatten-impact.test.ts`
 * runs both this and the compiled plan against the same log and compares.
 *
 * Three problems are measured, under the names the object-centric literature
 * gives them:
 *
 *  - **convergence** — an event related to several objects of the case type is
 *    copied into each of their cases. Counts inflate; every frequency, and so
 *    every frequency-based filter and every performance average, is wrong by a
 *    factor nobody sees.
 *  - **deficiency** — an event related to no object of the case type is not in
 *    the flat log at all. Whole activities can disappear this way.
 *  - **divergence** — an activity that belongs to a *different* object type
 *    repeats inside one case, with no order relation between its occurrences.
 *    Nothing is lost and nothing is added, so no count shows it; discovery
 *    reports a loop, or concurrency, that the process does not have.
 *
 * The first two partly cancel in a net event count, which is exactly why the
 * editor used to be able to show a reassuring number for a ruinous flattening.
 *
 * Every SUM is cast to BIGINT. DuckDB widens a sum to HUGEINT, which Arrow
 * hands over as a *string* — and `num()` in the view layer passes a string
 * through untouched, so `retained + duplicated` silently became string
 * concatenation. Caught by the invariant test, not by reading the query.
 */

/** Single-quote escaping, same rule as `compile.ts`'s `lit`. */
const lit = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

export interface TypeImpact {
  objectType: string;
  /** Objects of this type. Each becomes one case, event-less ones included. */
  cases: number;
  emptyCases: number;
  srcEvents: number;
  /** Events with exactly one related object of the type: carried over as-is. */
  retainedOnce: number;
  /** Events with several: **convergence**. */
  dupEvents: number;
  /** The rows those events become. `dupRows - dupEvents` is the inflation. */
  dupRows: number;
  /** Events with none: **deficiency**. They are not in the flat log at all. */
  dropped: number;
  outRows: number;
}

/**
 * One pass for every candidate case notion at once.
 *
 * Deliberately mirrors the compiled plan rather than the textbook definition,
 * because the preview is worthless if it disagrees with the result:
 *
 *  - `rows_out` is `COUNT(*)` over E2O, not `COUNT(DISTINCT object_id)`. The
 *    flatten view in `compile.ts` joins E2O without de-duplicating, so two
 *    identical relation tuples really do produce two rows. Counting distinct
 *    objects here would under-report convergence on exactly the logs that have
 *    a `deduplicateRelations` repair waiting for them.
 *  - Both joins are inner joins, so a relation pointing at an event or object
 *    that does not exist is invisible to both this and the compiler.
 *  - `cases` counts every object of the type, including ones no event mentions,
 *    because the compiled `trace` view does too.
 */
export const impactSql = (object: string, event: string, e2o: string) => `
WITH per AS (
  SELECT o.object_type AS t, r.event_id AS eid, COUNT(*) AS rows_out
  FROM ${e2o} r
  JOIN ${object} o ON o.object_id = r.object_id
  JOIN ${event} e ON e.event_id = r.event_id
  GROUP BY 1, 2
), agg AS (
  SELECT t,
    COUNT(*) AS kept_events,
    COUNT(*) FILTER (WHERE rows_out = 1) AS retained_once,
    COUNT(*) FILTER (WHERE rows_out > 1) AS dup_events,
    CAST(COALESCE(SUM(rows_out) FILTER (WHERE rows_out > 1), 0) AS BIGINT) AS dup_rows,
    CAST(COALESCE(SUM(rows_out), 0) AS BIGINT) AS out_rows
  FROM per GROUP BY 1
), types AS (
  SELECT object_type AS t, COUNT(*) AS cases,
    COUNT(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM ${e2o} r2 WHERE r2.object_id = o.object_id)) AS empty_cases
  FROM ${object} o WHERE object_type IS NOT NULL GROUP BY 1
), src AS (SELECT COUNT(*) AS n FROM ${event})
SELECT types.t AS object_type, types.cases, types.empty_cases,
  (SELECT n FROM src) AS src_events,
  COALESCE(agg.retained_once, 0) AS retained_once,
  COALESCE(agg.dup_events, 0) AS dup_events,
  COALESCE(agg.dup_rows, 0) AS dup_rows,
  COALESCE(agg.out_rows, 0) AS out_rows,
  (SELECT n FROM src) - COALESCE(agg.kept_events, 0) AS dropped
FROM types LEFT JOIN agg ON agg.t = types.t
ORDER BY types.t`;

/**
 * The same split, per activity, for the chosen type — which is what turns
 * "36% of events disappear" into "Create order and Confirm payment disappear".
 *
 * `COUNT(r.object_id)` over a left join is 0 for an event with no related
 * object of the type, which is the deficiency case and the reason the join
 * cannot be an inner one.
 */
export const activitySql = (object: string, event: string, e2o: string, type: string) => `
WITH per AS (
  SELECT e.event_id AS eid, e.activity AS activity, COUNT(r.object_id) AS rows_out
  FROM ${event} e
  LEFT JOIN ${e2o} r ON r.event_id = e.event_id
    AND r.object_id IN (SELECT object_id FROM ${object} WHERE object_type = ${lit(type)})
  GROUP BY 1, 2
)
SELECT activity, COUNT(*) AS events,
  COUNT(*) FILTER (WHERE rows_out = 0) AS dropped,
  COUNT(*) FILTER (WHERE rows_out > 1) AS dup_events,
  CAST(COALESCE(SUM(rows_out) FILTER (WHERE rows_out > 1), 0) AS BIGINT) AS dup_rows,
  CAST(COALESCE(MAX(rows_out), 0) AS BIGINT) AS max_copies
FROM per GROUP BY 1 ORDER BY events DESC`;

/**
 * Divergence — the third flattening problem, and the one that is invisible in
 * any count.
 *
 * Convergence and deficiency change how many events there are. Divergence
 * changes what the *order* between them means: an activity that belongs to a
 * different object type appears several times inside one case with no causal
 * relation between the occurrences, and a discovery algorithm reading that
 * case cannot tell it apart from genuine rework. It reports a loop, or
 * concurrency, that the process does not have.
 *
 * The signature looked for is the operational one: within a case, the
 * activity occurs more than once, and its occurrences stand in a one-to-one
 * correspondence with distinct objects of some *other* type — one "Pick item"
 * per Item, not two passes over the same Item. An activity that repeats
 * without such an explanation is left alone: that is rework, and rework is
 * real.
 *
 * Reported per explaining type and only for the selected notion, because this
 * is the one query here that is not linear in the relation table: it pairs
 * each flattened row with the other objects of its event.
 */
export const divergenceSql = (object: string, event: string, e2o: string, type: string) => `
WITH tcase AS (SELECT object_id AS cid FROM ${object} WHERE object_type = ${lit(type)}),
ce AS (
  SELECT DISTINCT r.object_id AS cid, r.event_id AS eid, e.activity AS activity
  FROM ${e2o} r
  JOIN tcase ON tcase.cid = r.object_id
  JOIN ${event} e ON e.event_id = r.event_id
), repeats AS (
  SELECT activity, COUNT(*) FILTER (WHERE n > 1) AS repeat_cases
  FROM (SELECT cid, activity, COUNT(*) AS n FROM ce GROUP BY 1, 2)
  GROUP BY 1
), oth AS (
  SELECT r.event_id AS eid, o.object_type AS otype, r.object_id AS oid
  FROM ${e2o} r
  JOIN ${object} o ON o.object_id = r.object_id
  WHERE o.object_type <> ${lit(type)} AND o.object_type IS NOT NULL
), per AS (
  SELECT ce.cid, ce.activity AS activity, oth.otype,
    COUNT(DISTINCT ce.eid) AS occurrences,
    COUNT(DISTINCT oth.oid) AS distinct_objects
  FROM ce JOIN oth ON oth.eid = ce.eid
  GROUP BY 1, 2, 3
)
SELECT per.activity AS activity, per.otype AS explained_by,
  repeats.repeat_cases AS repeat_cases,
  COUNT(*) FILTER (WHERE occurrences > 1 AND distinct_objects = occurrences) AS explained_cases
FROM per JOIN repeats ON repeats.activity = per.activity
WHERE repeats.repeat_cases > 0
GROUP BY 1, 2, 3
ORDER BY explained_cases DESC`;

export type Distortion = 'low' | 'medium' | 'high';

/**
 * Two shares, one label. Kept deliberately crude and stated in the UI: this
 * ranks candidates, it does not certify one. Divergence is not in it, because
 * it is only measured for the selected notion.
 */
export function distortionOf(i: TypeImpact): Distortion {
  if (i.srcEvents === 0) return 'low';
  const drop = i.dropped / i.srcEvents;
  const dup = i.dupEvents / i.srcEvents;
  if (drop >= 0.25 || dup >= 0.25) return 'high';
  if (drop >= 0.05 || dup >= 0.05) return 'medium';
  return 'low';
}

export const distortionShare = (i: TypeImpact) =>
  i.srcEvents === 0 ? 0 : (i.dropped + i.dupEvents) / i.srcEvents;

