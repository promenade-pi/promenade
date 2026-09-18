import type { OcelLog } from './ocel-formats';

const q = (name: string) => `"${String(name).replaceAll('"', '""')}"`;
const lit = (value: unknown) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const sqliteType = (type: string) => ({ integer: 'INTEGER', float: 'REAL', boolean: 'BOOLEAN', time: 'TIMESTAMP' }[type] ?? 'TEXT');

/** Load the standard OCEL relational layout with SQLite's browser WASM build. */
export async function parseOcelSqlite(input: ArrayBuffer): Promise<OcelLog> {
  const sqlite3 = (await import('@sqlite.org/sqlite-wasm')).default ? await (await import('@sqlite.org/sqlite-wasm')).default() : await (await import('@sqlite.org/sqlite-wasm') as any)();
  const source = new Uint8Array(input); const allocated = new Uint8Array(source.byteLength + 1024 * 1024); allocated.set(source);
  const p = sqlite3.wasm.allocFromTypedArray(allocated); const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    sqlite3.capi.sqlite3_deserialize(db.pointer, 'main', p, allocated.byteLength, allocated.byteLength, 0);
    const all = (sql: string) => { const rows: any[] = []; db.exec({ sql, rowMode: 'object', callback: (row: any) => rows.push(row) }); return rows; };
    const columns = (table: string) => all(`PRAGMA table_info(${q(table)})`);
    const objectMaps = all('SELECT ocel_type, ocel_type_map FROM object_map_type');
    const eventMaps = all('SELECT ocel_type, ocel_type_map FROM event_map_type');
    const log: OcelLog = { objectTypes: [], eventTypes: [], objects: [], events: [] };
    const objectById = new Map<string, OcelLog['objects'][number]>(); const eventById = new Map<string, OcelLog['events'][number]>();
    for (const m of objectMaps) {
      const table = `object_${m.ocel_type_map}`, attrs = columns(table).filter((c) => !String(c.name).startsWith('ocel_')).map((c) => ({ name: c.name, type: sqliteToOcel(c.type) }));
      log.objectTypes.push({ name: m.ocel_type, attributes: attrs });
      for (const row of all(`SELECT * FROM ${q(table)}`)) { const id = String(row.ocel_id); let object = objectById.get(id); if (!object) { object = { id, type: m.ocel_type, attributes: [], relationships: [] }; objectById.set(id, object); log.objects.push(object); }
        const changed = row.ocel_changed_field; for (const a of attrs) if ((!changed || changed === a.name) && row[a.name] != null) object.attributes.push({ name: a.name, value: row[a.name], time: row.ocel_time ?? null });
      }
    }
    for (const m of eventMaps) {
      const table = `event_${m.ocel_type_map}`, attrs = columns(table).filter((c) => !String(c.name).startsWith('ocel_')).map((c) => ({ name: c.name, type: sqliteToOcel(c.type) }));
      log.eventTypes.push({ name: m.ocel_type, attributes: attrs });
      for (const row of all(`SELECT * FROM ${q(table)}`)) { const event = { id: String(row.ocel_id), type: m.ocel_type, time: row.ocel_time ?? null, attributes: attrs.filter((a) => row[a.name] != null).map((a) => ({ name: a.name, value: row[a.name] })), relationships: [] as any[] }; log.events.push(event); eventById.set(event.id, event); }
    }
    for (const row of all('SELECT * FROM event_object')) eventById.get(String(row.ocel_event_id))?.relationships.push({ objectId: String(row.ocel_object_id), qualifier: row.ocel_qualifier ?? null });
    for (const row of all('SELECT * FROM object_object')) objectById.get(String(row.ocel_source_id))?.relationships.push({ objectId: String(row.ocel_target_id), qualifier: row.ocel_qualifier ?? null });
    return log;
  } finally { try { db.close(); } catch {} }
}

/** Write the relational OCEL 2.0 layout. Names are mapped by ordinal, never lossy sanitisation. */
export async function encodeOcelSqlite(log: OcelLog): Promise<Uint8Array> {
  const sqlite3 = (await import('@sqlite.org/sqlite-wasm')).default ? await (await import('@sqlite.org/sqlite-wasm')).default() : await (await import('@sqlite.org/sqlite-wasm') as any)();
  const db = new sqlite3.oo1.DB(':memory:', 'c');
  try {
    db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE event (ocel_id TEXT PRIMARY KEY, ocel_type TEXT); CREATE TABLE object (ocel_id TEXT PRIMARY KEY, ocel_type TEXT); CREATE TABLE event_map_type (ocel_type TEXT PRIMARY KEY, ocel_type_map TEXT); CREATE TABLE object_map_type (ocel_type TEXT PRIMARY KEY, ocel_type_map TEXT); CREATE TABLE event_object (ocel_event_id TEXT, ocel_object_id TEXT, ocel_qualifier TEXT); CREATE TABLE object_object (ocel_source_id TEXT, ocel_target_id TEXT, ocel_qualifier TEXT);');
    const eventMap = new Map(log.eventTypes.map((t, i) => [t.name, `e${i}`])); const objectMap = new Map(log.objectTypes.map((t, i) => [t.name, `o${i}`]));
    for (const t of log.eventTypes) { const map = eventMap.get(t.name)!; db.exec(`INSERT INTO event_map_type VALUES (${lit(t.name)}, ${lit(map)}); CREATE TABLE ${q(`event_${map}`)} (ocel_id TEXT PRIMARY KEY, ocel_time TIMESTAMP${t.attributes.map((a) => `, ${q(a.name)} ${sqliteType(a.type)}`).join('')});`); }
    for (const t of log.objectTypes) { const map = objectMap.get(t.name)!; db.exec(`INSERT INTO object_map_type VALUES (${lit(t.name)}, ${lit(map)}); CREATE TABLE ${q(`object_${map}`)} (ocel_id TEXT, ocel_time TIMESTAMP, ocel_changed_field TEXT${t.attributes.map((a) => `, ${q(a.name)} ${sqliteType(a.type)}`).join('')});`); }
    const eventTypes = new Map(log.eventTypes.map((t) => [t.name, t]));
    for (const e of log.events) { const table = `event_${eventMap.get(e.type)}`; const attrs = new Map(e.attributes.map((a) => [a.name, a.value])); const columns = ['ocel_id', 'ocel_time', ...[...attrs.keys()]]; db.exec(`INSERT INTO event VALUES (${lit(e.id)}, ${lit(e.type)}); INSERT INTO ${q(table)} (${columns.map(q).join(',')}) VALUES (${[e.id, e.time, ...attrs.values()].map(lit).join(',')});`); for (const r of e.relationships) db.exec(`INSERT INTO event_object VALUES (${lit(e.id)}, ${lit(r.objectId)}, ${lit(r.qualifier ?? '')});`); }
    for (const o of log.objects) {
      const table = q(`object_${objectMap.get(o.type)}`); const initial = o.attributes.filter((a) => !a.time || new Date(String(a.time)).getTime() === 0);
      const columns = ['ocel_id', 'ocel_time', 'ocel_changed_field', ...initial.map((a) => a.name)];
      db.exec(`INSERT INTO object VALUES (${lit(o.id)}, ${lit(o.type)}); INSERT INTO ${table} (${columns.map(q).join(',')}) VALUES (${[o.id, '1970-01-01T00:00:00Z', null, ...initial.map((a) => a.value)].map(lit).join(',')});`);
      for (const a of o.attributes.filter((a) => a.time && new Date(String(a.time)).getTime() !== 0)) db.exec(`INSERT INTO ${table} (${q('ocel_id')}, ${q('ocel_time')}, ${q('ocel_changed_field')}, ${q(a.name)}) VALUES (${lit(o.id)}, ${lit(a.time)}, ${lit(a.name)}, ${lit(a.value)});`);
      for (const r of o.relationships) db.exec(`INSERT INTO object_object VALUES (${lit(o.id)}, ${lit(r.objectId)}, ${lit(r.qualifier ?? '')});`);
    }
    return sqlite3.capi.sqlite3_js_db_export(db.pointer);
  } finally { db.close(); }
}
function sqliteToOcel(type: unknown) { const t = String(type ?? '').toUpperCase(); return t.includes('INT') ? 'integer' : t.includes('REAL') || t.includes('FLOAT') || t.includes('DOUBLE') ? 'float' : t.includes('BOOL') ? 'boolean' : t.includes('TIME') || t.includes('DATE') ? 'time' : 'string'; }
