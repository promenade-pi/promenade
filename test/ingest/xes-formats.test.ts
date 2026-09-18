import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeXes, encodeXesCsv } from '../../src/ingest/xes-formats.ts';

const log = {
  traces: [{ id: '0', caseId: 'case-1', attributes: [{ key: 'priority', type: 'int', value: '3' }] }],
  events: [{ id: '1', traceId: '0', activity: 'Approve', time: '2024-01-01T12:00:00Z', lifecycle: 'complete', resource: 'alice', attributes: [{ key: 'amount', type: 'float', value: '10.5' }] }],
};

test('XES export recreates the trace, core event attributes, and side attributes', () => {
  const xes = new TextDecoder().decode(encodeXes(log));
  assert.match(xes, /<trace>/);
  assert.match(xes, /key="concept:name" value="case-1"/);
  assert.match(xes, /key="amount" value="10.5"/);
});

test('CSV export emits one portable event table', () => {
  const csv = new TextDecoder().decode(encodeXesCsv(log));
  assert.match(csv, /^case_id,event_id,activity,timestamp,lifecycle,resource,amount/m);
  assert.match(csv, /case-1,1,Approve/);
});

test('a numeric epoch-ms event time — what DuckDB/Arrow actually hands the worker, not a pre-formatted ISO string — becomes a proper XES date, not the raw millisecond integer', () => {
  const time = Date.parse('2024-01-01T12:00:00Z');
  const numericLog = { ...log, events: [{ ...log.events[0], time }] };
  const xes = new TextDecoder().decode(encodeXes(numericLog));
  assert.match(xes, new RegExp(`key="time:timestamp" value="${new Date(time).toISOString()}"`));
});
