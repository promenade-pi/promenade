/**
 * OCEL's relational interchange shape is fixed even when a particular log
 * happens not to use one of its relations. Keeping empty relations means
 * consumers can query `event_attr` without per-log existence checks.
 */
export async function ensureOcelTables(conn: any, prefix: string) {
  const tables = [
    ['event', 'event_id VARCHAR, activity VARCHAR, ts TIMESTAMP'],
    ['object', 'object_id VARCHAR, object_type VARCHAR'],
    ['e2o', 'event_id VARCHAR, object_id VARCHAR, qualifier VARCHAR'],
    ['o2o', 'source_id VARCHAR, target_id VARCHAR, qualifier VARCHAR'],
    ['event_attr', 'event_id VARCHAR, name VARCHAR, value VARCHAR'],
    ['object_attr', 'object_id VARCHAR, name VARCHAR, value VARCHAR, ts TIMESTAMP'],
  ] as const;
  for (const [name, columns] of tables) {
    await conn.query(`CREATE TABLE IF NOT EXISTS ${prefix}_${name} (${columns})`);
  }
}
