import { makeDecoder } from './lib/chunks';
import { XmlScanner } from './lib/xml-scan';
import { ArrowSink, T } from './lib/arrow-sink';
import { epochMicros } from './lib/timestamp.ts';

const ATTR_TAGS = new Set([
  'string', 'date', 'int', 'float', 'boolean', 'id', 'list', 'container',
]);

// Attributes promoted to typed columns. Everything else is preserved in the
// long-format side table, so nothing from the source is lost.
const CORE = {
  'concept:name': 'activity',
  'time:timestamp': 'ts',
  'lifecycle:transition': 'lifecycle',
  'org:resource': 'resource',
};

/**
 * Streams an XES file into DuckDB tables, then writes Parquet into OPFS.
 *
 * Separates the three levels the brief calls for: the PM data model lands in
 * `xes_event` / `xes_trace`, XES standard semantics (extensions, classifiers,
 * globals) is captured separately as XESSemantics, and physical storage is
 * Parquet. No algorithm downstream has to know what XES is.
 */
export async function ingestXES({ source, conn, prefix, onProgress, log }) {
  const eventSink = new ArrowSink(conn, `${prefix}_event_raw`, [
    ['event_idx', T.i64],
    ['trace_idx', T.i64],
    ['activity', T.str],
    ['ts_us', T.i64],
    ['lifecycle', T.str],
    ['resource', T.str],
  ]);
  const eattrSink = new ArrowSink(conn, `${prefix}_event_attr_raw`, [
    ['event_idx', T.i64],
    ['key', T.str],
    ['type', T.str],
    ['value', T.str],
  ]);
  const traceSink = new ArrowSink(conn, `${prefix}_trace_raw`, [
    ['trace_idx', T.i64],
    ['case_id', T.str],
  ]);
  const tattrSink = new ArrowSink(conn, `${prefix}_trace_attr_raw`, [
    ['trace_idx', T.i64],
    ['key', T.str],
    ['type', T.str],
    ['value', T.str],
  ]);

  // XESSemantics - format-level, kept out of the generic data model.
  const semantics = { extensions: [], classifiers: [], globals: {}, logAttrs: [] };

  let traceIdx = -1;
  let eventIdx = -1;
  let inTrace = false;
  let inEvent = false;
  let globalScope = null;

  // Path stack for nested attributes; XES allows attributes inside attributes.
  const keyPath = [];
  let cur = null; // event/trace row under construction

  // Emitting a row is synchronous. An earlier version awaited a flush check
  // per event, which allocated 1.2M promises for BPI-2017 and dominated the
  // runtime; the actual flush now happens once per chunk instead, which keeps
  // memory bounded just as well because a chunk is a fixed 8 MB of input.
  const emitEvent = () => {
    if (!cur) return;
    eventSink.push([
      BigInt(eventIdx), BigInt(traceIdx),
      cur.activity ?? null,
      cur.ts_us == null ? null : BigInt(cur.ts_us),
      cur.lifecycle ?? null, cur.resource ?? null,
    ]);
    cur = null;
  };

  const scanner = new XmlScanner({
    onOpen(name, attrs, selfClosing) {
      switch (name) {
        case 'extension':
          semantics.extensions.push(attrs);
          return;
        case 'classifier':
          semantics.classifiers.push(attrs);
          return;
        case 'global':
          globalScope = attrs.scope || 'unknown';
          semantics.globals[globalScope] = [];
          return;
        case 'trace':
          traceIdx++;
          inTrace = true;
          keyPath.length = 0;
          return;
        case 'event':
          eventIdx++;
          inEvent = true;
          cur = {};
          keyPath.length = 0;
          return;
      }

      if (!ATTR_TAGS.has(name)) return;

      const key = attrs.key ?? '';
      const value = attrs.value ?? '';
      keyPath.push(key);
      const fullKey = keyPath.join('/');

      if (globalScope) {
        semantics.globals[globalScope].push({ key: fullKey, type: name, value });
      } else if (inEvent) {
        const core = keyPath.length === 1 ? CORE[key] : undefined;
        if (core === 'ts') {
          cur.ts_us = epochMicros(value);
        } else if (core) {
          cur[core] = value;
        } else {
          eattrSink.push([BigInt(eventIdx), fullKey, name, value]);
        }
      } else if (inTrace) {
        if (keyPath.length === 1 && key === 'concept:name') {
          traceSink.push([BigInt(traceIdx), value]);
        } else {
          tattrSink.push([BigInt(traceIdx), fullKey, name, value]);
        }
      } else {
        semantics.logAttrs.push({ key: fullKey, type: name, value });
      }

      if (selfClosing) keyPath.pop();
    },

    onClose(name) {
      if (name === 'event') { inEvent = false; emitEvent(); return; }
      if (name === 'trace') { inTrace = false; keyPath.length = 0; return; }
      if (name === 'global') { globalScope = null; return; }
      if (ATTR_TAGS.has(name)) keyPath.pop();
    },
  });

  const dec = makeDecoder();
  // `onProgress` is passed to the source itself rather than derived from
  // `chunk.byteLength` here: for a gzip source those are decompressed bytes,
  // which can run well past `source.size` (the compressed byte count) and
  // make the progress bar overshoot 100%. The source knows what it actually
  // read and reports against that.
  for await (const chunk of source.chunks(onProgress)) {
    scanner.write(dec.decode(chunk));
    await eventSink.maybeFlush();
    await eattrSink.maybeFlush();
    await traceSink.maybeFlush();
    await tattrSink.maybeFlush();
  }
  scanner.write(dec.flush());
  scanner.end();

  const sinkStats = {
    event: await eventSink.finish(),
    trace: await traceSink.finish(),
    eventAttr: await eattrSink.finish(),
    traceAttr: await tattrSink.finish(),
  };
  const stats = {
    events: sinkStats.event.rows,
    traces: sinkStats.trace.rows,
    eventAttrs: sinkStats.eventAttr.rows,
    traceAttrs: sinkStats.traceAttr.rows,
    sinks: sinkStats,
  };

  // Normalise into the shape every downstream query uses.
  await conn.query(`
    CREATE OR REPLACE TABLE ${prefix}_event AS
    SELECT event_idx, trace_idx, activity,
           CASE WHEN ts_us IS NULL THEN NULL ELSE make_timestamp(ts_us) END AS ts,
           lifecycle, resource
    FROM ${prefix}_event_raw
  `);
  await conn.query(`DROP TABLE ${prefix}_event_raw`);

  // Guarded: a sink that never received a row creates no table (`ArrowSink`
  // only inserts on flush), and plenty of real logs have traces with nothing
  // beyond concept:name, or events with no extra attributes at all — the
  // Road Traffic Fine Management log is one. Converting unconditionally
  // turns "this log has no trace attributes" into a failed import.
  const emptyDDL: Record<string, string> = {
    event_attr: 'event_idx BIGINT, key VARCHAR, type VARCHAR, value VARCHAR',
    trace_attr: 'trace_idx BIGINT, key VARCHAR, type VARCHAR, value VARCHAR',
    trace: 'trace_idx BIGINT, case_id VARCHAR',
  };
  const rowsOf: Record<string, number> = {
    event_attr: stats.eventAttrs, trace_attr: stats.traceAttrs, trace: stats.traces,
  };
  for (const t of ['event_attr', 'trace_attr', 'trace']) {
    if (rowsOf[t] === 0) {
      await conn.query(`CREATE OR REPLACE TABLE ${prefix}_${t} (${emptyDDL[t]})`);
    } else {
      await conn.query(`CREATE OR REPLACE TABLE ${prefix}_${t} AS SELECT * FROM ${prefix}_${t}_raw`);
      await conn.query(`DROP TABLE ${prefix}_${t}_raw`);
    }
  }

  log?.(`XES parsed: ${stats.events} events / ${stats.traces} traces`);
  return { stats, semantics };
}
