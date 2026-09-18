-- Object-Type Interaction Graph, as a Promenade Relational Program.
--
-- The analysis an OCEL log makes possible and a traditional log cannot even
-- express: which object types act together (co-occur on the same event),
-- and what OCEL 2.0's qualifiers say about how. Every relation below reads
-- {log.event_object}/{log.object_object} — relations a TraditionalEventLog
-- input would simply not have, which is exactly the point of a per-artifact-
-- type logical schema (see host/relational/schemas.ts).
--
-- `event_object_types` is the shared basis for two different questions:
-- "how much does this type appear" (object_type_events) and "which types
-- appear together" (type_pairs, via a self-join on event_id). Deduplicating
-- to (event_id, object_type) first is what makes `shared_events` count
-- *events*, not object pairs — an event carrying three "item" objects and
-- one "order" object shares exactly one event with "order", not three.

-- @relation event_object_types
SELECT DISTINCT eo.event_id, o.object_type
FROM {log.event_object} eo
JOIN {log.objects} o ON o.object_id = eo.object_id

-- @relation object_type_counts
SELECT object_type, COUNT(*) AS object_count
FROM {log.objects}
GROUP BY 1

-- @relation object_type_events
SELECT object_type, COUNT(DISTINCT event_id) AS event_count
FROM event_object_types
GROUP BY 1

-- @relation type_pairs
-- Unordered pairs only (type_a < type_b): a type does not "interact with
-- itself" in this graph, even when two objects of the same type appear on
-- one event together — that is a different question (cardinality, not
-- interaction) and not what this action answers.
SELECT a.object_type AS type_a, b.object_type AS type_b,
       COUNT(DISTINCT a.event_id) AS shared_events
FROM event_object_types a
JOIN event_object_types b
  ON a.event_id = b.event_id AND a.object_type < b.object_type
GROUP BY 1, 2

-- @relation e2o_qualifier_counts
SELECT o.object_type, eo.qualifier, COUNT(*) AS n
FROM {log.event_object} eo
JOIN {log.objects} o ON o.object_id = eo.object_id
GROUP BY 1, 2

-- @relation o2o_relation_counts
-- May legitimately be empty: OCEL 1.0-shaped logs and plenty of real OCEL
-- 2.0 exports declare no O2O relationships at all.
SELECT sa.object_type AS source_type, ta.object_type AS target_type,
       oo.qualifier, COUNT(*) AS n
FROM {log.object_object} oo
JOIN {log.objects} sa ON sa.object_id = oo.source_id
JOIN {log.objects} ta ON ta.object_id = oo.target_id
GROUP BY 1, 2, 3

-- @output object_type_summary
SELECT
  c.object_type,
  c.object_count,
  COALESCE(e.event_count, 0) AS event_count,
  CASE WHEN c.object_count = 0 THEN 0
       ELSE ROUND(COALESCE(e.event_count, 0)::DOUBLE / c.object_count, 2) END AS avg_events_per_object
FROM object_type_counts c
LEFT JOIN object_type_events e ON e.object_type = c.object_type
ORDER BY c.object_count DESC

-- @output type_interactions
SELECT type_a, type_b, shared_events
FROM type_pairs
WHERE shared_events >= :minSharedEvents
ORDER BY shared_events DESC

-- @output e2o_qualifiers
SELECT object_type, qualifier, n
FROM e2o_qualifier_counts
ORDER BY object_type, n DESC

-- @output o2o_relations
SELECT source_type, target_type, qualifier, n
FROM o2o_relation_counts
ORDER BY n DESC
