import test from 'node:test';
import assert from 'node:assert/strict';
import { inferLogType, parquetTables, reconstructArtifact } from '../../src/host/artifact/recover.ts';

const dir = (files: string[], id = 'a_test_1', bytes = 1234) => ({ id, files, bytes });
const XES = ['event.parquet', 'trace.parquet', 'event_attr.parquet', 'trace_attr.parquet'];
const OCEL = ['event.parquet', 'object.parquet', 'e2o.parquet', 'o2o.parquet'];

test('parquetTables reads the logical table names off the file names', () => {
  assert.deepEqual(parquetTables(XES), ['event', 'event_attr', 'trace', 'trace_attr']);
  // A sidecar, a stray file, anything that is not Parquet is not a relation.
  assert.deepEqual(parquetTables(['event.parquet', 'artifact.json', 'notes.txt']), ['event']);
  assert.deepEqual(parquetTables([]), []);
});

test('the relation set identifies the log kind', () => {
  assert.equal(inferLogType(['event', 'trace']), 'TraditionalEventLog');
  assert.equal(inferLogType(['event', 'object', 'e2o']), 'ObjectCentricEventLog');
  // Any one object-centric marker is enough — an OCEL export can be missing
  // o2o or object_attr entirely and is still object-centric.
  assert.equal(inferLogType(['event', 'object_attr']), 'ObjectCentricEventLog');
  assert.equal(inferLogType(['event', 'o2o']), 'ObjectCentricEventLog');
});

test('object-centric markers win over the traditional one', () => {
  // Reading this as traditional would silently drop every object.
  assert.equal(inferLogType(['event', 'trace', 'object', 'e2o']), 'ObjectCentricEventLog');
});

test('an unidentifiable relation set is not guessed at', () => {
  assert.equal(inferLogType([]), null);
  assert.equal(inferLogType(['event']), null);
  assert.equal(inferLogType(['results', 'summary']), null);
});

test('reconstructs a traditional log with every table mapped to its file', () => {
  const a = reconstructArtifact(dir(XES), { artifactsDir: 'artifacts', now: '2026-09-03T00:00:00.000Z' });
  assert.ok(a);
  assert.equal(a!.type, 'TraditionalEventLog');
  assert.equal(a!.storage.kind, 'parquet');
  assert.deepEqual((a!.storage as any).files, {
    event: 'artifacts/a_test_1/event.parquet',
    event_attr: 'artifacts/a_test_1/event_attr.parquet',
    trace: 'artifacts/a_test_1/trace.parquet',
    trace_attr: 'artifacts/a_test_1/trace_attr.parquet',
  });
  // Provenance genuinely cannot be recovered from files, and is not invented.
  assert.equal(a!.producedBy, null);
  assert.deepEqual(a!.inputs, []);
  assert.equal(a!.meta.recovered, true);
  assert.equal(a!.meta.parquetBytes, 1234);
});

test('reconstructs an object-centric log', () => {
  const a = reconstructArtifact(dir(OCEL), { artifactsDir: 'artifacts' });
  assert.equal(a!.type, 'ObjectCentricEventLog');
  assert.deepEqual(Object.keys((a!.storage as any).files).sort(), ['e2o', 'event', 'o2o', 'object']);
});

test('a directory with no Parquet is not recovered', () => {
  // The shape a derived, inline artifact leaves behind once its sidecar is
  // gone: a directory that holds no data of its own.
  assert.equal(reconstructArtifact(dir(['artifact.json']), { artifactsDir: 'artifacts' }), null);
  assert.equal(reconstructArtifact(dir([]), { artifactsDir: 'artifacts' }), null);
});

test('a name recovered from a saved view is used, and recorded as such', () => {
  const withName = reconstructArtifact(dir(XES), { name: 'Sepsis Cases.xes.gz', artifactsDir: 'artifacts' });
  assert.equal(withName!.name, 'Sepsis Cases.xes.gz');
  assert.equal(withName!.meta.recoveredFrom, 'files + saved view');

  const without = reconstructArtifact(dir(XES), { artifactsDir: 'artifacts' });
  assert.match(without!.name, /^Recovered log \(a_test_1\)$/);
  assert.equal(without!.meta.recoveredFrom, 'files');
});
