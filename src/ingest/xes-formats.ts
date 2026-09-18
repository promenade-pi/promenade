import { isoMicros } from './lib/timestamp.ts';
/** The format-neutral XES shape used at the export boundary. */
export interface XesLog {
  semantics?: any;
  traces: Array<{ id: string; caseId: unknown; attributes: XesAttribute[] }>;
  events: Array<{ id: string; traceId: string; activity: unknown; time: unknown; lifecycle: unknown; resource: unknown; attributes: XesAttribute[] }>;
}

export interface XesAttribute { key: unknown; type: unknown; value: unknown; }

const text = new TextEncoder();
const ATTR_TAGS = new Set(['string', 'date', 'int', 'float', 'boolean', 'id', 'list', 'container']);

function xml(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function csv(value: unknown) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function iso(value: unknown) {
  if (value == null || value === '') return null;
  // DuckDB's TIMESTAMP columns cross the Arrow boundary as a plain epoch-ms
  // number (occasionally a bigint), never a pre-formatted string — routing
  // those through `new Date(String(value))` sent every real log timestamp
  // through `Date.parse` on a bare digit string, which it does not accept,
  // silently emitting the raw millisecond integer as `time:timestamp`
  // instead of a proper XES date.
  //
  // `isoMicros` writes six fractional digits where there are six.
  // `toISOString` writes three and no more, so formatting through it truncated
  // on the way out everything ingest now preserves on the way in.
  return isoMicros(value) ?? String(value);
}
function attribute({ key, type, value }: XesAttribute, indent: string) {
  const tag = ATTR_TAGS.has(String(type)) ? String(type) : 'string';
  return `${indent}<${tag} key="${xml(key)}" value="${xml(value)}"/>`;
}

/** Encode a normalized traditional event log as standards-shaped XES XML. */
export function encodeXes(log: XesLog): Uint8Array {
  const semantics = log.semantics ?? {};
  const out = ['<?xml version="1.0" encoding="UTF-8" ?>', '<log xes.version="1.0" xes.features="nested-attributes">'];
  for (const ext of Array.isArray(semantics.extensions) ? semantics.extensions : []) {
    if (ext?.name) out.push(`  <extension name="${xml(ext.name)}" prefix="${xml(ext.prefix)}" uri="${xml(ext.uri)}"/>`);
  }
  for (const classifier of Array.isArray(semantics.classifiers) ? semantics.classifiers : []) {
    if (classifier?.name) out.push(`  <classifier name="${xml(classifier.name)}" keys="${xml(classifier.keys)}"/>`);
  }
  for (const [scope, attrs] of Object.entries(semantics.globals ?? {})) {
    out.push(`  <global scope="${xml(scope)}">`);
    for (const attr of Array.isArray(attrs) ? attrs : []) out.push(attribute(attr as XesAttribute, '    '));
    out.push('  </global>');
  }
  for (const attr of Array.isArray(semantics.logAttrs) ? semantics.logAttrs : []) out.push(attribute(attr as XesAttribute, '  '));

  const eventsByTrace = new Map<string, XesLog['events']>();
  for (const event of log.events) {
    const list = eventsByTrace.get(event.traceId) ?? [];
    list.push(event); eventsByTrace.set(event.traceId, list);
  }
  const traceIds = new Set(log.traces.map((trace) => trace.id));
  const traces = [...log.traces, ...[...eventsByTrace.keys()].filter((id) => !traceIds.has(id)).map((id) => ({ id, caseId: null, attributes: [] }))];
  for (const trace of traces) {
    out.push('  <trace>');
    if (trace.caseId != null && trace.caseId !== '') out.push(`    <string key="concept:name" value="${xml(trace.caseId)}"/>`);
    for (const attr of trace.attributes) out.push(attribute(attr, '    '));
    for (const event of eventsByTrace.get(trace.id) ?? []) {
      out.push('    <event>');
      if (event.activity != null) out.push(`      <string key="concept:name" value="${xml(event.activity)}"/>`);
      const time = iso(event.time); if (time) out.push(`      <date key="time:timestamp" value="${xml(time)}"/>`);
      if (event.lifecycle != null) out.push(`      <string key="lifecycle:transition" value="${xml(event.lifecycle)}"/>`);
      if (event.resource != null) out.push(`      <string key="org:resource" value="${xml(event.resource)}"/>`);
      for (const attr of event.attributes) out.push(attribute(attr, '      '));
      out.push('    </event>');
    }
    out.push('  </trace>');
  }
  out.push('</log>', '');
  return text.encode(out.join('\n'));
}

/** Flat event-table CSV for tools that do not consume XES. */
export function encodeXesCsv(log: XesLog): Uint8Array {
  const caseIds = new Map(log.traces.map((trace) => [trace.id, trace.caseId]));
  const keys = [...new Set(log.events.flatMap((event) => event.attributes.map((attribute) => String(attribute.key))))].sort();
  const header = ['case_id', 'event_id', 'activity', 'timestamp', 'lifecycle', 'resource', ...keys];
  const rows = log.events.map((event) => {
    const attrs = new Map<string, string>();
    for (const attr of event.attributes) {
      const key = String(attr.key), value = attr.value == null ? '' : String(attr.value);
      attrs.set(key, attrs.has(key) ? `${attrs.get(key)} | ${value}` : value);
    }
    return [caseIds.get(event.traceId), event.id, event.activity, iso(event.time), event.lifecycle, event.resource, ...keys.map((key) => attrs.get(key) ?? '')].map(csv).join(',');
  });
  return text.encode([header.map(csv).join(','), ...rows, ''].join('\n'));
}
