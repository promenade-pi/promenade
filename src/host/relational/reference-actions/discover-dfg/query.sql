-- Directly-Follows Graph discovery, as a Promenade Relational Program.
--
-- Per-case event sequences (`{log.events}`, ordered by timestamp then event
-- id — the tie-break within a timestamp) become directly-follows pairs via
-- LEAD(), the standard SQL-window formulation of a DFG. `ordered` is the one
-- relation everything else is built from; `activity_counts`/`edge_counts`/
-- `start_counts`/`end_counts` are named intermediate results, independently
-- fetchable (see the "named intermediate relations" test in
-- app/test/relational/ocpqShaped.test.ts) even though this action only ever
-- asks for its four named outputs.
--
-- `core-actions.ts`'s `buildDfgArtifact()` combines the four outputs below
-- into the same `{activities, edges, starts, ends, counts, stats}` shape
-- `core.discover.dfg` (the Rust/WASM kernel) produces, so `DfgView` renders
-- either without knowing which one it is looking at — the artifact type is
-- the contract, not the runtime that produced it.

-- @relation ordered
SELECT
  trace_idx,
  activity,
  LEAD(activity) OVER (PARTITION BY trace_idx ORDER BY ts NULLS LAST, event_idx) AS next_activity,
  ROW_NUMBER() OVER (PARTITION BY trace_idx ORDER BY ts NULLS LAST, event_idx) AS rn,
  COUNT(*) OVER (PARTITION BY trace_idx) AS trace_len
FROM {log.events}
WHERE activity IS NOT NULL

-- @relation activity_counts
SELECT activity, COUNT(*) AS n
FROM {log.events}
WHERE activity IS NOT NULL
GROUP BY 1

-- @relation edge_counts
SELECT activity AS src, next_activity AS dst, COUNT(*) AS freq
FROM ordered
WHERE next_activity IS NOT NULL
GROUP BY 1, 2

-- @relation start_counts
SELECT activity, COUNT(*) AS n
FROM ordered
WHERE rn = 1
GROUP BY 1

-- @relation end_counts
SELECT activity, COUNT(*) AS n
FROM ordered
WHERE rn = trace_len
GROUP BY 1

-- @output activities
SELECT activity, n FROM activity_counts ORDER BY n DESC

-- @output edges
SELECT src, dst, freq FROM edge_counts
WHERE freq >= :minFrequency
ORDER BY freq DESC

-- @output starts
SELECT activity, n FROM start_counts

-- @output ends
SELECT activity, n FROM end_counts

-- @output statistics
SELECT
  (SELECT COUNT(*) FROM {log.events} WHERE activity IS NOT NULL) AS rows,
  (SELECT COUNT(DISTINCT trace_idx) FROM {log.events}) AS cases,
  (SELECT COUNT(*) FROM edge_counts) AS total_edges,
  (SELECT COUNT(*) FROM edge_counts WHERE freq >= :minFrequency) AS shown_edges
