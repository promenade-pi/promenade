import { unzipSync, zipSync } from 'fflate';
import { parquetReadObjects } from 'hyparquet';
import { parquetWriteBuffer } from 'hyparquet-writer';
import { epochMicrosBigInt, isoMicros } from './lib/timestamp.ts';
import { ensureOcelTables } from './ocel-tables.ts';

/** A format-neutral OCEL representation used only at the import/export edge. */
export interface OcelLog {
  eventTypes: Array<{ name: string; attributes: Array<{ name: string; type: string }> }>;
  objectTypes: Array<{ name: string; attributes: Array<{ name: string; type: string }> }>;
  events: Array<{ id: string; type: string; time: unknown; attributes: Array<{ name: string; value: unknown }>; relationships: Array<{ objectId: string; qualifier?: string | null }> }>;
  objects: Array<{ id: string; type: string; attributes: Array<{ name: string; time?: unknown; value: unknown }>; relationships: Array<{ objectId: string; qualifier?: string | null }> }>;
}

const primitives = new Set(['string', 'time', 'integer', 'float', 'boolean']);
const epoch = '1970-01-01T00:00:00.000Z';
const text = new TextDecoder();
const bytes = new TextEncoder();

function attrType(type: unknown) {
  const t = String(type ?? '').toLowerCase();
  if (t === 'text' || t === 'varchar') return 'string';
  if (t === 'real' || t === 'double' || t === 'numeric') return 'float';
  if (t === 'timestamp' || t === 'date' || t === 'datetime') return 'time';
  if (t === 'int' || t === 'bigint') return 'integer';
  if (t === 'bool') return 'boolean';
  return primitives.has(t) ? t : 'string';
}

function emptyLog(): OcelLog { return { eventTypes: [], objectTypes: [], events: [], objects: [] }; }
// DuckDB's TIMESTAMP columns cross the Arrow boundary as a plain epoch-ms
// number (occasionally a bigint), never a pre-formatted string — routing those
// through `new Date(String(value))` sent every real log timestamp through
// `Date.parse` on a bare digit string, which it does not accept
// ("1717545600000" is not a recognized date format), silently producing
// `Invalid Date` for every event and object-attribute time in the export.
//
// `isoMicros` handles all of those shapes, and writes six fractional digits
// where there are six: `toISOString` writes three and no more, so formatting
// through it truncated on the way out everything ingest now preserves on the
// way in.
const iso = isoMicros;
function escapeXml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function csvEscape(value: unknown) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function parseCsv(textValue: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = textValue.charCodeAt(0) === 0xfeff ? 1 : 0; i < textValue.length; i++) {
    const c = textValue[i], n = textValue[i + 1];
    if (quoted) { if (c === '"' && n === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c; continue; }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { row.push(field); out.push(row); row = []; field = ''; if (c === '\r' && n === '\n') i++; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out;
}
function recordsToRows(records: string[][]) {
  const header = records[0] ?? [];
  return records.slice(1).filter((r) => !(r.length === 1 && r[0] === '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
function infer(value: unknown) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'float';
  if (typeof value === 'string' && /^[-+]?\d+$/.test(value)) return 'integer';
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return 'float';
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return 'boolean';
  if (typeof value === 'string' && iso(value)) return 'time';
  return 'string';
}
function declaration(types: Map<string, Map<string, string>>) {
  return [...types].map(([name, attributes]) => ({ name, attributes: [...attributes].map(([n, type]) => ({ name: n, type })) }));
}
function ensureType(types: Map<string, Map<string, string>>, name: string) {
  if (!types.has(name)) types.set(name, new Map()); return types.get(name)!;
}
function attributeValue(value: unknown, type: string) {
  if (value == null) return null;
  if (type === 'integer') { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : String(value); }
  if (type === 'float') { const n = Number(value); return Number.isFinite(n) ? n : String(value); }
  if (type === 'boolean') return typeof value === 'boolean' ? value : /^true$/i.test(String(value));
  if (type === 'time') return iso(value) ?? String(value);
  return String(value);
}
function typeMap(log: OcelLog, kind: 'eventTypes' | 'objectTypes') {
  return new Map(log[kind].map((t) => [t.name, new Map(t.attributes.map((a) => [a.name, attrType(a.type)]))]));
}

/** Persist a parsed OCEL without materialising an intermediate DuckDB table. */
export async function ingestOcelRecords({ log, conn, prefix, sourceFormat, onProgress }: { log: OcelLog; conn: any; prefix: string; sourceFormat: 'xml' | 'sqlite' | 'csv' | 'prom-csv' | 'bundle-csv' | 'bundle-parquet'; onProgress?: (a: number, b: number) => void }) {
  const { ArrowSink, T } = await import('./lib/arrow-sink');
  const event = new ArrowSink(conn, `${prefix}_event_raw`, [['event_id', T.str], ['activity', T.str], ['ts_us', T.i64]]);
  const object = new ArrowSink(conn, `${prefix}_object`, [['object_id', T.str], ['object_type', T.str]]);
  const e2o = new ArrowSink(conn, `${prefix}_e2o`, [['event_id', T.str], ['object_id', T.str], ['qualifier', T.str]]);
  const o2o = new ArrowSink(conn, `${prefix}_o2o`, [['source_id', T.str], ['target_id', T.str], ['qualifier', T.str]]);
  const eattr = new ArrowSink(conn, `${prefix}_event_attr`, [['event_id', T.str], ['name', T.str], ['value', T.str]]);
  const oattr = new ArrowSink(conn, `${prefix}_object_attr_raw`, [['object_id', T.str], ['name', T.str], ['value', T.str], ['ts_us', T.i64]]);
  const total = log.events.length + log.objects.length; let done = 0;
  for (const e of log.events) {
    event.push([e.id, e.type, epochMicrosBigInt(iso(e.time))]);
    for (const r of e.relationships) e2o.push([e.id, r.objectId, r.qualifier ?? null]);
    for (const a of e.attributes) eattr.push([e.id, a.name, a.value == null ? null : String(a.value)]);
    await Promise.all([event.maybeFlush(), e2o.maybeFlush(), eattr.maybeFlush()]); onProgress?.(++done, total);
  }
  for (const o of log.objects) {
    object.push([o.id, o.type]);
    for (const r of o.relationships) o2o.push([o.id, r.objectId, r.qualifier ?? null]);
    for (const a of o.attributes) { oattr.push([o.id, a.name, a.value == null ? null : String(a.value), epochMicrosBigInt(iso(a.time))]); }
    await Promise.all([object.maybeFlush(), o2o.maybeFlush(), oattr.maybeFlush()]); onProgress?.(++done, total);
  }
  const stats = { events: (await event.finish()).rows, objects: (await object.finish()).rows, e2o: (await e2o.finish()).rows, o2o: (await o2o.finish()).rows, eventAttrs: (await eattr.finish()).rows, objectAttrs: (await oattr.finish()).rows };
  if (stats.events) {
    await conn.query(`CREATE OR REPLACE TABLE ${prefix}_event AS SELECT event_id, activity, CASE WHEN ts_us IS NULL THEN NULL ELSE make_timestamp(ts_us) END AS ts FROM ${prefix}_event_raw`);
    await conn.query(`DROP TABLE ${prefix}_event_raw`);
  }
  if (stats.objectAttrs) { await conn.query(`CREATE OR REPLACE TABLE ${prefix}_object_attr AS SELECT object_id, name, value, CASE WHEN ts_us IS NULL THEN NULL ELSE make_timestamp(ts_us) END AS ts FROM ${prefix}_object_attr_raw`); await conn.query(`DROP TABLE ${prefix}_object_attr_raw`); }
  await ensureOcelTables(conn, prefix);
  return { stats, semantics: { objectTypes: log.objectTypes, eventTypes: log.eventTypes, sourceFormat } };
}

/** Streaming XML reader for OCEL's four top-level collections. */
export async function parseOcelXml(source: AsyncIterable<Uint8Array>, onProgress?: (a: number, b: number) => void, size = 0): Promise<OcelLog> {
  const { XmlScanner, decodeEntities } = await import('./lib/xml-scan');
  const log = emptyLog(); let section = ''; let current: any = null; let currentType: any = null; let attribute: any = null; let attrText = ''; let used = 0;
  const scanner = new XmlScanner({
    onOpen(name: string, attrs: any) {
      if (['event-types', 'object-types', 'events', 'objects'].includes(name)) { section = name; return; }
      if (name === 'event-type' || name === 'object-type') { currentType = { name: attrs.name ?? '', attributes: [] }; return; }
      if (name === 'event') { current = { id: attrs.id ?? '', type: attrs.type ?? '', time: attrs.time ?? null, attributes: [], relationships: [] }; return; }
      if (name === 'object') { current = { id: attrs.id ?? '', type: attrs.type ?? '', attributes: [], relationships: [] }; return; }
      if (name === 'attribute') { attribute = { name: attrs.name ?? '', type: attrs.type, time: attrs.time ?? null }; attrText = ''; return; }
      if (name === 'relationship' && current) current.relationships.push({ objectId: attrs['object-id'] ?? attrs.objectId ?? '', qualifier: attrs.qualifier ?? attrs.relationship ?? null });
    },
    onText(value: string) { if (attribute) attrText += value; },
    onClose(name: string) {
      if (name === 'attribute' && attribute) { if (currentType) currentType.attributes.push({ name: attribute.name, type: attrType(attribute.type) }); else if (current) current.attributes.push({ name: attribute.name, time: attribute.time, value: decodeEntities(attrText).trim() }); attribute = null; return; }
      if ((name === 'event-type' || name === 'object-type') && currentType) { (name === 'event-type' ? log.eventTypes : log.objectTypes).push(currentType); currentType = null; return; }
      if (name === 'event' && current) { log.events.push(current); current = null; return; }
      if (name === 'object' && current) { log.objects.push(current); current = null; return; }
      if (name === section) section = '';
    },
  });
  const decoder = new TextDecoder(); for await (const chunk of source) { scanner.write(decoder.decode(chunk, { stream: true })); used += chunk.byteLength; onProgress?.(used, size); } scanner.write(decoder.decode()); scanner.end(); return log;
}

function parseReference(value: string, timestamp: string | null) {
  let base = value.trim(), attributes: Array<{ name: string; time: string | null; value: unknown }> = [];
  const brace = base.indexOf('{'); if (brace >= 0) { const body = base.slice(brace); base = base.slice(0, brace); try { const attrs = JSON.parse(body); if (attrs && !Array.isArray(attrs)) attributes = Object.entries(attrs).filter(([, v]) => v == null || typeof v !== 'object').map(([name, value]) => ({ name, time: timestamp, value })); } catch { throw new Error(`invalid object attributes in reference "${value}"`); } }
  const hash = base.indexOf('#'); return { objectId: hash < 0 ? base : base.slice(0, hash), qualifier: hash < 0 ? null : base.slice(hash + 1), attributes };
}
function splitReferences(value: string) { let depth = 0, part = '', out: string[] = []; for (const c of value) { if (c === '{') depth++; if (c === '}') depth--; if (c === '/' && depth === 0) { if (part) out.push(part); part = ''; } else part += c; } if (part) out.push(part); return out; }

/** OCEL 2.1 compact CSV, including declaration and attribute-only rows. */
export function parseOcelCsv(content: string): OcelLog {
  const rows = recordsToRows(parseCsv(content)); const log = emptyLog(); const objects = new Map<string, OcelLog['objects'][number]>(); const ots = new Map<string, Map<string, string>>(), ets = new Map<string, Map<string, string>>();
  const ensureObject = (id: string, type: string) => { const found = objects.get(id); if (found && found.type !== type) throw new Error(`object "${id}" appears as both ${found.type} and ${type}`); if (found) return found; const result = { id, type, attributes: [], relationships: [] }; objects.set(id, result); ensureType(ots, type); return result; };
  rows.forEach((row, index) => {
    const id = row.id?.trim() ?? '', activity = row.activity?.trim() ?? '', time = row.timestamp?.trim() || null;
    const objectColumns = Object.keys(row).filter((h) => h.startsWith('ot:'));
    if (!id && !activity && !time || !id && !activity && time || activity.toLowerCase() === 'o2o' || id && activity) {
      const refs: Array<{ type: string; ref: ReturnType<typeof parseReference> }> = [];
      for (const header of objectColumns) for (const piece of splitReferences(row[header] ?? '')) { const ref = parseReference(piece, time); if (!ref.objectId) continue; refs.push({ type: header.slice(3), ref }); const object = ensureObject(ref.objectId, header.slice(3)); for (const a of ref.attributes) { object.attributes.push(a); ensureType(ots, object.type).set(a.name, infer(a.value)); } }
      if (activity.toLowerCase() === 'o2o') { const source = objects.get(id); if (!source) throw new Error(`CSV row ${index + 2}: source object "${id}" was not declared before its o2o relation`); for (const { ref } of refs) source.relationships.push({ objectId: ref.objectId, qualifier: ref.qualifier }); return; }
      if (id && activity) { const attributes = Object.entries(row).filter(([h, v]) => !['id', 'activity', 'timestamp'].includes(h) && !h.startsWith('ot:') && v !== '').map(([name, value]) => { ensureType(ets, activity).set(name, infer(value)); return { name, value }; }); ensureType(ets, activity); log.events.push({ id, type: activity, time, attributes, relationships: refs.map(({ ref }) => ({ objectId: ref.objectId, qualifier: ref.qualifier })) }); }
    }
  });
  log.objects = [...objects.values()]; log.objectTypes = declaration(ots); log.eventTypes = declaration(ets); return log;
}

/** Event-table CSV as imported by ProM's CSV/XES workflow and Power Automate. */
export function parsePromCsv(content: string): OcelLog {
  const records = parseCsv(content); const headers = records[0] ?? []; const lower = new Map(headers.map((h) => [h.toLowerCase(), h])); const idKey = lower.get('event') ?? lower.get('id') ?? lower.get('case id'); const activityKey = lower.get('activity') ?? lower.get('concept:name'); const timeKey = lower.get('timestamp') ?? lower.get('time:timestamp');
  if (!activityKey || !timeKey) throw new Error('CSV needs Activity and Timestamp columns (or concept:name and time:timestamp).');
  const system = new Set([idKey, activityKey, timeKey, lower.get('actor')].filter(Boolean)); const objectColumns = headers.filter((h) => /^ot:/.test(h) || /^[A-Z][A-Za-z0-9 _.-]*$/.test(h) && !system.has(h)); const objectNames = new Map(objectColumns.map((h) => [h, h.startsWith('ot:') ? h.slice(3) : h])); const eventAttributes = headers.filter((h) => !system.has(h) && !objectNames.has(h) && ![...objectNames.keys()].some((t) => h.startsWith(`${t}-`)));
  const log = emptyLog(), objects = new Map<string, OcelLog['objects'][number]>(), ots = new Map<string, Map<string, string>>(), ets = new Map<string, Map<string, string>>();
  recordsToRows(records).forEach((row, i) => { const activity = row[activityKey].trim(), time = row[timeKey].trim(); if (!activity) return; const id = idKey ? row[idKey].trim() || `event-${i + 1}` : `event-${i + 1}`; const relationships: any[] = [];
    for (const [header, type] of objectNames) for (const objectId of (row[header] ?? '').split('|').map((v) => v.trim()).filter(Boolean)) { let object = objects.get(objectId); if (!object) { object = { id: objectId, type, attributes: [], relationships: [] }; objects.set(objectId, object); } else if (object.type !== type) throw new Error(`object "${objectId}" appears as both ${object.type} and ${type}`); relationships.push({ objectId, qualifier: null }); ensureType(ots, type); for (const attrHeader of headers.filter((h) => h.startsWith(`${header}-`))) { const values = (row[attrHeader] ?? '').split(';'); const at = attrHeader.slice(header.length + 1), value = values[(row[header] ?? '').split('|').map((v) => v.trim()).indexOf(objectId)]; if (value) { object.attributes.push({ name: at, time, value }); ensureType(ots, type).set(at, infer(value)); } } }
    const attributes = eventAttributes.filter((h) => row[h] !== '').map((name) => ({ name, value: row[name] })); const actor = lower.get('actor'); if (actor && row[actor] && row[actor].toLowerCase() !== 'auto') attributes.push({ name: 'Actor', value: row[actor] }); const et = ensureType(ets, activity); for (const a of attributes) et.set(a.name, infer(a.value)); log.events.push({ id, type: activity, time, attributes, relationships });
  });
  log.objects = [...objects.values()]; log.objectTypes = declaration(ots); log.eventTypes = declaration(ets); return log;
}

function bundleMeta(log: OcelLog, storageFormat: 'csv' | 'parquet') {
  const encoded = (name: string) => encodeURIComponent(name).replace(/%[0-9a-f]{2}/gi, (x) => x.toUpperCase());
  return { ocelVersion: '2.0', bundleFormatVersion: '1.0', storageFormat, eventTypes: Object.fromEntries(log.eventTypes.map((t) => [t.name, { file: `events/event_${encoded(t.name)}.${storageFormat}`, attributes: t.attributes.map((a) => ({ ...a, type: attrType(a.type) })) }])), objectTypes: Object.fromEntries(log.objectTypes.map((t) => [t.name, { file: `objects/object_${encoded(t.name)}.${storageFormat}`, changesFile: `object_changes/object_changes_${encoded(t.name)}.${storageFormat}`, attributes: t.attributes.map((a) => ({ ...a, type: attrType(a.type) })) }])), relations: { e2o: `relations/e2o.${storageFormat}`, o2o: `relations/o2o.${storageFormat}` } };
}
function tableColumns(fixed: string[], attrs: any[]) { return [...fixed.map((name) => ({ name, type: name === 'ocel_time' ? 'time' : 'string' })), ...attrs.map((a: any) => ({ name: a.name, type: attrType(a.type) }))]; }
function toTables(log: OcelLog) {
  const metaTypes = { event: typeMap(log, 'eventTypes'), object: typeMap(log, 'objectTypes') };
  const events = new Map(log.eventTypes.map((t) => [t.name, { columns: tableColumns(['ocel_id', 'ocel_time'], t.attributes), rows: [] as any[] }]));
  const objects = new Map(log.objectTypes.map((t) => [t.name, { columns: tableColumns(['ocel_id'], t.attributes), rows: [] as any[] }]));
  const changes = new Map(log.objectTypes.map((t) => [t.name, { columns: tableColumns(['ocel_id', 'ocel_time', 'ocel_changed_field'], t.attributes), rows: [] as any[] }]));
  for (const e of log.events) { if (!events.has(e.type)) events.set(e.type, { columns: tableColumns(['ocel_id', 'ocel_time'], []), rows: [] }); const out: any = { ocel_id: e.id, ocel_time: iso(e.time) ?? epoch }; const types = metaTypes.event.get(e.type) ?? new Map(); for (const a of e.attributes) out[a.name] = attributeValue(a.value, types.get(a.name) ?? infer(a.value)); events.get(e.type)!.rows.push(out); }
  for (const o of log.objects) { if (!objects.has(o.type)) { objects.set(o.type, { columns: tableColumns(['ocel_id'], []), rows: [] }); changes.set(o.type, { columns: tableColumns(['ocel_id', 'ocel_time', 'ocel_changed_field'], []), rows: [] }); } const initial: any = { ocel_id: o.id }, types = metaTypes.object.get(o.type) ?? new Map(); for (const a of o.attributes) { const time = iso(a.time); if (!time || time === epoch) initial[a.name] = attributeValue(a.value, types.get(a.name) ?? infer(a.value)); else changes.get(o.type)!.rows.push({ ocel_id: o.id, ocel_time: time, ocel_changed_field: a.name, [a.name]: attributeValue(a.value, types.get(a.name) ?? infer(a.value)) }); } objects.get(o.type)!.rows.push(initial); }
  return { events, objects, changes, e2o: { columns: tableColumns(['ocel_event_id', 'ocel_object_id', 'ocel_qualifier'], []), rows: log.events.flatMap((e) => e.relationships.map((r) => ({ ocel_event_id: e.id, ocel_object_id: r.objectId, ocel_qualifier: r.qualifier ?? '' }))) }, o2o: { columns: tableColumns(['ocel_source_id', 'ocel_target_id', 'ocel_qualifier'], []), rows: log.objects.flatMap((o) => o.relationships.map((r) => ({ ocel_source_id: o.id, ocel_target_id: r.objectId, ocel_qualifier: r.qualifier ?? '' }))) } };
}
function serializeTable(table: any) { return [table.columns.map((c: any) => csvEscape(c.name)).join(','), ...table.rows.map((row: any) => table.columns.map((c: any) => csvEscape(c.type === 'time' && row[c.name] ? iso(row[c.name]) : row[c.name])).join(','))].join('\r\n'); }
function parquetTable(table: any, fixed: string[]) { const required = new Set(fixed); const schema = [{ name: 'root', num_children: table.columns.length }, ...table.columns.map((c: any) => ({ name: c.name, type: c.type === 'time' || c.type === 'integer' ? 'INT64' : c.type === 'float' ? 'DOUBLE' : c.type === 'boolean' ? 'BOOLEAN' : 'BYTE_ARRAY', converted_type: c.type === 'time' ? 'TIMESTAMP_MICROS' : c.type === 'string' ? 'UTF8' : undefined, repetition_type: required.has(c.name) ? 'REQUIRED' : 'OPTIONAL' }))]; const columnData = table.columns.map((c: any) => ({ name: c.name, data: table.rows.map((r: any) => { const v = r[c.name]; if (v == null) return required.has(c.name) ? (c.type === 'time' || c.type === 'integer' ? 0n : c.type === 'float' ? 0 : c.type === 'boolean' ? false : '') : null; if (c.type === 'time') return epochMicrosBigInt(iso(v) ?? epoch) ?? 0n; if (c.type === 'integer') return BigInt(Math.trunc(Number(v))); return v; }) })); return new Uint8Array(parquetWriteBuffer({ schema, columnData })); }

export function encodeBundle(log: OcelLog, storageFormat: 'csv' | 'parquet') { const meta = bundleMeta(log, storageFormat), tables = toTables(log), files: Record<string, Uint8Array> = { 'ocel-meta.json': bytes.encode(`${JSON.stringify(meta, null, 2)}\n`) }; const add = (path: string, table: any, fixed: string[]) => files[path] = storageFormat === 'csv' ? bytes.encode(serializeTable(table)) : parquetTable(table, fixed); for (const [name, table] of tables.events) add((meta.eventTypes as any)[name].file, table, ['ocel_id', 'ocel_time']); for (const [name, table] of tables.objects) { const entry = (meta.objectTypes as any)[name]; add(entry.file, table, ['ocel_id']); add(entry.changesFile, tables.changes.get(name), ['ocel_id', 'ocel_time', 'ocel_changed_field']); } add(meta.relations.e2o, tables.e2o, ['ocel_event_id', 'ocel_object_id', 'ocel_qualifier']); add(meta.relations.o2o, tables.o2o, ['ocel_source_id', 'ocel_target_id', 'ocel_qualifier']); return zipSync(files, { level: storageFormat === 'parquet' ? 0 : 6 }); }

async function decodeTable(file: Uint8Array, storage: string, columns: any[]) { if (!file) return { rows: [] as any[] }; if (storage === 'csv') return { rows: recordsToRows(parseCsv(text.decode(file))).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => { const t = columns.find((c) => c.name === k)?.type ?? 'string'; return [k, v === '' ? null : attributeValue(v, t)]; }))) }; const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer; const raw = await parquetReadObjects({ file: buffer, utf8: true });
  // hyparquet decodes a TIMESTAMP_MICROS column straight to a native `Date`,
  // not the `bigint` this once assumed was the only alternative to a plain
  // value — a `time` column came back as an unconverted `Date` object instead
  // of the ISO string every other reader of this log expects.
  return { rows: raw.map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => { const t = columns.find((c) => c.name === k)?.type ?? 'string'; return [k, v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? (t === 'time' ? new Date(Number(v / 1000n)).toISOString() : Number(v)) : v]; }))) }; }
export async function parseBundle(input: Uint8Array): Promise<OcelLog> { const entries = unzipSync(input, { filter: (entry) => !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/') }); const metaName = Object.keys(entries).filter((n) => n === 'ocel-meta.json' || n.endsWith('/ocel-meta.json')).sort((a, b) => a.length - b.length)[0]; if (!metaName) throw new Error('This ZIP is not an OCEL bundle: it has no ocel-meta.json.'); const root = metaName.slice(0, -'ocel-meta.json'.length), meta: any = JSON.parse(text.decode(entries[metaName])); if (!['csv', 'parquet'].includes(meta.storageFormat)) throw new Error('OCEL bundle storageFormat must be "csv" or "parquet".'); const log = emptyLog(); const eventTypes = Object.entries(meta.eventTypes ?? {}), objectTypes = Object.entries(meta.objectTypes ?? {});
  log.eventTypes = eventTypes.map(([name, entry]: any) => ({ name, attributes: (entry.attributes ?? []).map((a: any) => ({ name: a.name, type: attrType(a.type) })) })); log.objectTypes = objectTypes.map(([name, entry]: any) => ({ name, attributes: (entry.attributes ?? []).map((a: any) => ({ name: a.name, type: attrType(a.type) })) })); const events = new Map<string, any>(), objects = new Map<string, any>();
  for (const [name, entry] of eventTypes as any) { const attrs = entry.attributes ?? [], rows = (await decodeTable(entries[root + entry.file], meta.storageFormat, [{ name: 'ocel_id', type: 'string' }, { name: 'ocel_time', type: 'time' }, ...attrs])).rows; for (const r of rows) { const e = { id: String(r.ocel_id ?? ''), type: name, time: r.ocel_time, attributes: Object.entries(r).filter(([k, v]) => !['ocel_id', 'ocel_time'].includes(k) && v != null).map(([name, value]) => ({ name, value })), relationships: [] as any[] }; log.events.push(e); events.set(e.id, e); } }
  for (const [name, entry] of objectTypes as any) { const attrs = entry.attributes ?? [], rows = (await decodeTable(entries[root + entry.file], meta.storageFormat, [{ name: 'ocel_id', type: 'string' }, ...attrs])).rows; for (const r of rows) { const o = { id: String(r.ocel_id ?? ''), type: name, attributes: Object.entries(r).filter(([k, v]) => k !== 'ocel_id' && v != null).map(([name, value]) => ({ name, time: epoch, value })), relationships: [] as any[] }; log.objects.push(o); objects.set(o.id, o); } const changes = entry.changesFile ? (await decodeTable(entries[root + entry.changesFile], meta.storageFormat, [{ name: 'ocel_id', type: 'string' }, { name: 'ocel_time', type: 'time' }, { name: 'ocel_changed_field', type: 'string' }, ...attrs])).rows : []; for (const r of changes) { const o = objects.get(String(r.ocel_id ?? '')), name = String(r.ocel_changed_field ?? ''); if (o && name) o.attributes.push({ name, time: r.ocel_time, value: r[name] ?? null }); } }
  const e2o = meta.relations?.e2o ? (await decodeTable(entries[root + meta.relations.e2o], meta.storageFormat, [])).rows : []; for (const r of e2o) events.get(String(r.ocel_event_id ?? ''))?.relationships.push({ objectId: String(r.ocel_object_id ?? ''), qualifier: r.ocel_qualifier ?? null }); const o2o = meta.relations?.o2o ? (await decodeTable(entries[root + meta.relations.o2o], meta.storageFormat, [])).rows : []; for (const r of o2o) objects.get(String(r.ocel_source_id ?? ''))?.relationships.push({ objectId: String(r.ocel_target_id ?? ''), qualifier: r.ocel_qualifier ?? null }); return log; }

export function encodeOcel(log: OcelLog, format: 'json' | 'xml' | 'csv' | 'bundle-csv' | 'bundle-parquet') {
  if (format === 'json') {
    // Every other branch formats its own timestamps on the way out; this one
    // serialises the log object directly, so the conversion has to happen here
    // — otherwise `time` is written as the raw epoch number the Arrow boundary
    // handed over, where OCEL 2.0 requires an ISO 8601 string.
    const isoTime = (value: unknown) => iso(value) ?? value;
    return bytes.encode(`${JSON.stringify({
      ...log,
      events: log.events.map((e) => ({ ...e, time: isoTime(e.time) })),
      objects: log.objects.map((o) => ({
        ...o,
        attributes: o.attributes.map((a: any) =>
          a?.time == null ? a : { ...a, time: isoTime(a.time) }),
      })),
    }, null, 2)}\n`);
  }
  if (format === 'bundle-csv') return encodeBundle(log, 'csv'); if (format === 'bundle-parquet') return encodeBundle(log, 'parquet');
  if (format === 'csv') { const types = log.objectTypes.map((t) => t.name); const attrs = [...new Set(log.events.flatMap((e) => e.attributes.map((a) => a.name)))]; const objectById = new Map(log.objects.map((o) => [o.id, o])); const lines = [['id', 'activity', 'timestamp', ...types.map((t) => `ot:${t}`), ...attrs].map(csvEscape).join(',')]; for (const e of log.events) { const row: any = { id: e.id, activity: e.type, timestamp: iso(e.time) ?? '' }; for (const t of types) row[`ot:${t}`] = e.relationships.filter((r) => objectById.get(r.objectId)?.type === t).map((r) => `${r.objectId}${r.qualifier ? `#${r.qualifier}` : ''}`).join('/'); for (const a of e.attributes) row[a.name] = a.value; lines.push(['id', 'activity', 'timestamp', ...types.map((t) => `ot:${t}`), ...attrs].map((h) => csvEscape(row[h])).join(',')); } return bytes.encode(lines.join('\r\n')); }
  const types = (tag: string, values: any[]) => `<${tag}>${values.map((t) => `<${tag === 'event-types' ? 'event-type' : 'object-type'} name="${escapeXml(t.name)}"><attributes>${t.attributes.map((a: any) => `<attribute name="${escapeXml(a.name)}" type="${escapeXml(attrType(a.type))}"/>`).join('')}</attributes></${tag === 'event-types' ? 'event-type' : 'object-type'}>`).join('')}</${tag}>`; const objects = `<objects>${log.objects.map((o) => `<object id="${escapeXml(o.id)}" type="${escapeXml(o.type)}"><attributes>${o.attributes.map((a) => `<attribute name="${escapeXml(a.name)}"${a.time ? ` time="${escapeXml(iso(a.time) ?? a.time)}"` : ''}>${escapeXml(a.value)}</attribute>`).join('')}</attributes><objects>${o.relationships.map((r) => `<relationship object-id="${escapeXml(r.objectId)}" qualifier="${escapeXml(r.qualifier ?? '')}"/>`).join('')}</objects></object>`).join('')}</objects>`; const events = `<events>${log.events.map((e) => `<event id="${escapeXml(e.id)}" type="${escapeXml(e.type)}" time="${escapeXml(iso(e.time) ?? '')}"><attributes>${e.attributes.map((a) => `<attribute name="${escapeXml(a.name)}">${escapeXml(a.value)}</attribute>`).join('')}</attributes><objects>${e.relationships.map((r) => `<relationship object-id="${escapeXml(r.objectId)}" qualifier="${escapeXml(r.qualifier ?? '')}"/>`).join('')}</objects></event>`).join('')}</events>`; return bytes.encode(`<?xml version="1.0" encoding="UTF-8"?><log>${types('event-types', log.eventTypes)}${types('object-types', log.objectTypes)}${events}${objects}</log>`);
}
