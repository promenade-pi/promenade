import { makeDecoder } from './lib/chunks';
import { JsonRootStreamer } from './lib/json-stream';
import { ArrowSink, T } from './lib/arrow-sink';
import { epochMicrosBigInt } from './lib/timestamp.ts';
import { ensureOcelTables } from './ocel-tables.ts';

/**
 * OCEL 2.0 JSON ingest, fully streaming.
 *
 * The aoe2 JSON is 1.64 GB. `await file.text()` cannot even produce the string
 * (V8 caps strings near 512 MB), so this never materialises the document.
 */
export async function ingestOcelJson({ source, conn, prefix, log, onProgress }) {
  const eventSink = new ArrowSink(conn, `${prefix}_event_raw`, [
    ['event_id', T.str],
    ['activity', T.str],
    ['ts_us', T.i64],
  ]);
  const objectSink = new ArrowSink(conn, `${prefix}_object`, [
    ['object_id', T.str],
    ['object_type', T.str],
  ]);
  const e2oSink = new ArrowSink(conn, `${prefix}_e2o`, [
    ['event_id', T.str],
    ['object_id', T.str],
    ['qualifier', T.str],
  ]);
  const o2oSink = new ArrowSink(conn, `${prefix}_o2o`, [
    ['source_id', T.str],
    ['target_id', T.str],
    ['qualifier', T.str],
  ]);

  // Event attributes. Events carry their own timestamp, so these are simply
  // (name, value) per event.
  const eattrSink = new ArrowSink(conn, `${prefix}_event_attr`, [
    ['event_id', T.str],
    ['name', T.str],
    ['value', T.str],
  ]);

  // Object attributes, with the timestamp OCEL 2.0 attaches to each value.
  //
  // Static and time-dependent attributes live in one table rather than two:
  // in OCEL 2.0 the distinction is not declared, it is observed — an attribute
  // is time-dependent precisely when an object has more than one value for it.
  // Splitting them at ingest would mean deciding that question before the data
  // is fully read, and would lose the change history for the ones that vary.
  const oattrSink = new ArrowSink(conn, `${prefix}_object_attr`, [
    ['object_id', T.str],
    ['name', T.str],
    ['value', T.str],
    ['ts_us', T.i64],
  ]);

  // OCEL2Semantics: the declared type of every attribute, kept apart from the
  // data model so no algorithm has to know what OCEL is.
  const semantics = {
    objectTypes: [] as Array<{ name: string; attributes: Array<{ name: string; type: string }> }>,
    eventTypes: [] as Array<{ name: string; attributes: Array<{ name: string; type: string }> }>,
    sourceFormat: 'json' as const,
  };

  const streamer = new JsonRootStreamer({
    arrays: ['events', 'objects', 'objectTypes', 'eventTypes'],
    onElement(key, el) {
      if (key === 'objectTypes' || key === 'eventTypes') {
        semantics[key].push({ name: el.name, attributes: el.attributes ?? [] });
        return;
      }

      if (key === 'events') {
        eventSink.push([el.id, el.type, epochMicrosBigInt(el.time)]);
        for (const r of el.relationships || []) {
          e2oSink.push([el.id, r.objectId, r.qualifier ?? null]);
        }
        for (const a of el.attributes || []) {
          eattrSink.push([el.id, a.name, a.value == null ? null : String(a.value)]);
        }
        return;
      }

      objectSink.push([el.id, el.type]);
      for (const r of el.relationships || []) {
        o2oSink.push([el.id, r.objectId, r.qualifier ?? null]);
      }
      for (const a of el.attributes || []) {
        oattrSink.push([
          el.id, a.name,
          a.value == null ? null : String(a.value),
          epochMicrosBigInt(a.time),
        ]);
      }
    },
  });

  const dec = makeDecoder();
  let bytes = 0;
  for await (const chunk of source.chunks()) {
    streamer.write(dec.decode(chunk));
    bytes += chunk.byteLength;
    // Flush between chunks so accumulated rows stay bounded.
    await eventSink.maybeFlush();
    await objectSink.maybeFlush();
    await e2oSink.maybeFlush();
    await o2oSink.maybeFlush();
    await eattrSink.maybeFlush();
    await oattrSink.maybeFlush();
    await streamer.drain();
    onProgress?.(bytes, source.size);
  }
  streamer.write(dec.flush());
  streamer.end();
  await streamer.drain();

  const stats = {
    events: (await eventSink.finish()).rows,
    objects: (await objectSink.finish()).rows,
    e2o: (await e2oSink.finish()).rows,
    o2o: (await o2oSink.finish()).rows,
    eventAttrs: (await eattrSink.finish()).rows,
    objectAttrs: (await oattrSink.finish()).rows,
  };

  if (stats.events > 0) {
    await conn.query(`
      CREATE OR REPLACE TABLE ${prefix}_event AS
      SELECT event_id, activity,
             CASE WHEN ts_us IS NULL THEN NULL ELSE make_timestamp(ts_us) END AS ts
      FROM ${prefix}_event_raw
    `);
    await conn.query(`DROP TABLE ${prefix}_event_raw`);
  }

  // Object attribute timestamps become real timestamps, like event times.
  //
  // Guarded: a sink that never received a row creates no table, and plenty of
  // real logs carry no object attributes at all (aoe2 is one). Converting
  // unconditionally turns "this log has no attributes" into a failed import.
  if (stats.objectAttrs > 0) {
    await conn.query(`
      CREATE OR REPLACE TABLE ${prefix}_object_attr_t AS
      SELECT object_id, name, value,
             CASE WHEN ts_us IS NULL THEN NULL ELSE make_timestamp(ts_us) END AS ts
      FROM ${prefix}_object_attr
    `);
    await conn.query(`DROP TABLE ${prefix}_object_attr`);
    await conn.query(`ALTER TABLE ${prefix}_object_attr_t RENAME TO ${prefix}_object_attr`);
  }

  // Arrow sinks skip table creation when they receive no rows; OCEL does not.
  await ensureOcelTables(conn, prefix);

  log?.(
    `OCEL/JSON: ${stats.events} events, ${stats.objects} objects, ${stats.e2o} E2O, ` +
    `${stats.eventAttrs} event attrs, ${stats.objectAttrs} object attrs`
  );
  return { stats, semantics };
}
