import test from 'node:test';
import assert from 'node:assert/strict';
import { epochMicros, epochMicrosBigInt, isoMicros } from '../../src/ingest/lib/timestamp.ts';

/**
 * Microsecond fidelity through ingest and export.
 *
 * The bug these pin down was silent in both directions: `Date.parse` truncated
 * sub-millisecond digits on the way in, so two distinct source instants became
 * one — Promenade manufactured timestamp ties that were not in the file and
 * then reported them as a data-quality finding. `toISOString` writes exactly
 * three fractional digits, so the way out lost them again.
 */

test('sub-millisecond digits survive parsing, and are not invented', () => {
  assert.equal(epochMicros('2024-01-01T10:00:00Z'), 1_704_103_200_000_000);
  assert.equal(epochMicros('2024-01-01T10:00:00.123Z'), 1_704_103_200_123_000);
  assert.equal(epochMicros('2024-01-01T10:00:00.123456Z'), 1_704_103_200_123_456);
  // The pair that used to collide.
  assert.notEqual(
    epochMicros('2024-01-01T10:00:00.000100Z'),
    epochMicros('2024-01-01T10:00:00.000400Z')
  );
});

test('digits finer than a microsecond are floored, never rounded up', () => {
  // Flooring is monotone: two instants the source ordered may collapse into
  // one, but they can never swap. Rounding can swap them.
  assert.equal(epochMicros('2024-01-01T10:00:00.123456789Z'), 1_704_103_200_123_456);
  assert.equal(epochMicros('2024-01-01T10:00:00.1234569Z'), 1_704_103_200_123_456);
});

test('time zones and pre-epoch instants keep their microseconds', () => {
  assert.equal(
    epochMicros('2024-01-01T12:00:00.500000+02:00'),
    epochMicros('2024-01-01T10:00:00.500000Z')
  );
  // The fraction counts forward in time on both sides of the epoch.
  assert.equal(epochMicros('1960-01-01T00:00:00.000250Z'), -315_619_199_999_750);
  assert.equal(isoMicros('1960-01-01T00:00:00.000250Z'), '1960-01-01T00:00:00.000250Z');
});

test('a plain number is fractional epoch milliseconds, as DuckDB hands it over', () => {
  // `SELECT TIMESTAMP '2024-01-01 10:00:00.123456'` crosses the Arrow boundary
  // as 1704103200123.456, not as a microsecond integer.
  assert.equal(epochMicros(1_704_103_200_123.456), 1_704_103_200_123_456);
  assert.equal(epochMicros(1_704_103_200_000.001), 1_704_103_200_000_001);
  assert.equal(epochMicros(-315_619_199_999.75), -315_619_199_999_750);
});

test('the fractional-millisecond round trip is exact, not approximate', () => {
  // Floating point is the hazard here: flooring `us / 1000 * 1000` loses a
  // microsecond whenever the binary representation lands a hair below.
  let mismatches = 0;
  for (let i = 0; i < 50_000; i++) {
    const micros = 1_704_103_200_000_000 + Math.floor(Math.random() * 1e9);
    if (epochMicros(micros / 1000) !== micros) mismatches++;
  }
  assert.equal(mismatches, 0);
});

test('export writes six fractional digits only when there are six', () => {
  // Keeping the familiar three-digit form for whole-millisecond timestamps
  // means a log with no sub-millisecond data exports byte-identically.
  assert.equal(isoMicros('2024-01-01T10:00:00Z'), '2024-01-01T10:00:00.000Z');
  assert.equal(isoMicros('2024-01-01T10:00:00.123Z'), '2024-01-01T10:00:00.123Z');
  assert.equal(isoMicros('2024-01-01T10:00:00.123456Z'), '2024-01-01T10:00:00.123456Z');
  assert.equal(isoMicros('2024-01-01T10:00:00.000001Z'), '2024-01-01T10:00:00.000001Z');
});

test('import and export are inverse over microsecond timestamps', () => {
  for (const text of [
    '2024-01-01T10:00:00.000001Z', '2024-01-01T10:00:00.999999Z',
    '1971-02-03T04:05:06.070809Z', '2099-12-31T23:59:59.999999Z',
  ]) {
    assert.equal(isoMicros(epochMicros(text)! / 1000), text, text);
  }
});

test('non-timestamps stay null rather than becoming an epoch', () => {
  for (const value of [null, undefined, '', '   ', 'not a date', {}]) {
    assert.equal(epochMicros(value), null, String(value));
    assert.equal(epochMicrosBigInt(value), null, String(value));
    assert.equal(isoMicros(value), null, String(value));
  }
});

import { encodeOcel } from '../../src/ingest/ocel-formats.ts';
import { encodeXes } from '../../src/ingest/xes-formats.ts';

/**
 * Export is the other half of the same bug.
 *
 * Preserving microseconds on the way in and dropping them on the way out
 * would be worse than not preserving them at all: the round trip would look
 * lossless and quietly not be. Both encoders take their timestamps straight
 * from a DuckDB query, which is why these pass fractional epoch milliseconds
 * rather than strings — that is the shape the Arrow boundary hands over.
 */

const MICROS_AS_FRACTIONAL_MS = 1_704_103_200_123.456;

test('OCEL export keeps microseconds in JSON and XML', () => {
  const log = {
    eventTypes: [{ name: 'Create', attributes: [] }],
    objectTypes: [{ name: 'Order', attributes: [] }],
    events: [{ id: 'e1', type: 'Create', time: MICROS_AS_FRACTIONAL_MS, attributes: [], relationships: [] }],
    objects: [{ id: 'o1', type: 'Order', attributes: [], relationships: [] }],
  } as any;

  const json = new TextDecoder().decode(encodeOcel(log, 'json'));
  assert.match(json, /2024-01-01T10:00:00\.123456Z/);

  const xml = new TextDecoder().decode(encodeOcel(log, 'xml'));
  assert.match(xml, /2024-01-01T10:00:00\.123456Z/);
});

test('XES export keeps microseconds', () => {
  const log = {
    traces: [{ id: 't1', caseId: 'case-1', attributes: [] }],
    events: [{
      id: 'e1', traceId: 't1', activity: 'A', time: MICROS_AS_FRACTIONAL_MS,
      lifecycle: null, resource: null, attributes: [],
    }],
  } as any;
  const xes = new TextDecoder().decode(encodeXes(log));
  assert.match(xes, /2024-01-01T10:00:00\.123456Z/);
});

test('a whole-millisecond log still exports in the familiar three-digit form', () => {
  // No sub-millisecond data means no change to the bytes anyone already has.
  const log = {
    traces: [{ id: 't1', caseId: 'case-1', attributes: [] }],
    events: [{
      id: 'e1', traceId: 't1', activity: 'A', time: 1_704_103_200_123,
      lifecycle: null, resource: null, attributes: [],
    }],
  } as any;
  const xes = new TextDecoder().decode(encodeXes(log));
  assert.match(xes, /2024-01-01T10:00:00\.123Z/);
  assert.doesNotMatch(xes, /\.123000Z/);
});
