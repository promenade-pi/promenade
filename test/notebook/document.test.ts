import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNotebook, addCell, removeCell, duplicateCell, moveCell, updateCellSource,
  appendCellOutput, finishCellExecution, setArtifactBindings,
  toIpynb, fromIpynb, serializeIpynb, deserializeIpynb, boundOutputForPersistence,
  type NotebookDocument, type CodeCell,
} from '../../src/host/notebook/document.ts';

function freshDoc(): NotebookDocument {
  return createNotebook({ title: 'Test notebook', artifactBindings: ['a_1'], starterCell: 'log' });
}

test('createNotebook seeds one code cell with the starter source and the promenade metadata namespace', () => {
  const doc = freshDoc();
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].cellType, 'code');
  assert.equal((doc.cells[0] as CodeCell).source, 'log');
  assert.deepEqual(doc.metadata.promenade, { version: 1, artifactBindings: ['a_1'], kernel: 'browser-pyodide' });
});

test('createNotebook with no starterCell starts empty', () => {
  const doc = createNotebook({ title: 'Empty' });
  assert.equal(doc.cells.length, 0);
});

test('addCell inserts a code or markdown cell after the given cell, or at the end with no anchor', () => {
  let doc = freshDoc();
  const firstId = doc.cells[0].id;
  doc = addCell(doc, 'markdown', firstId);
  assert.equal(doc.cells.length, 2);
  assert.equal(doc.cells[1].cellType, 'markdown');
  assert.equal(doc.cells[1].source, '');

  doc = addCell(doc, 'code');
  assert.equal(doc.cells.length, 3);
  assert.equal(doc.cells[2].cellType, 'code');
});

test('removeCell drops exactly the named cell and nothing else', () => {
  let doc = freshDoc();
  doc = addCell(doc, 'markdown', doc.cells[0].id);
  const keepId = doc.cells[1].id;
  doc = removeCell(doc, doc.cells[0].id);
  assert.equal(doc.cells.length, 1);
  assert.equal(doc.cells[0].id, keepId);
});

test('duplicateCell copies source but resets execution state for a code cell', () => {
  let doc = freshDoc();
  doc = appendCellOutput(doc, doc.cells[0].id, { outputType: 'stream', name: 'stdout', text: 'hi' });
  doc = finishCellExecution(doc, doc.cells[0].id, 3);
  doc = duplicateCell(doc, doc.cells[0].id);
  assert.equal(doc.cells.length, 2);
  const copy = doc.cells[1] as CodeCell;
  assert.equal(copy.source, 'log');
  assert.equal(copy.executionCount, null);
  assert.deepEqual(copy.outputs, []);
  assert.notEqual(copy.id, doc.cells[0].id);
});

test('moveCell swaps adjacent cells and no-ops past the edges', () => {
  let doc = freshDoc();
  doc = addCell(doc, 'markdown', doc.cells[0].id);
  const [firstId, secondId] = doc.cells.map((c) => c.id);

  const moved = moveCell(doc, secondId, -1);
  assert.deepEqual(moved.cells.map((c) => c.id), [secondId, firstId]);

  const noop = moveCell(doc, firstId, -1);
  assert.deepEqual(noop.cells.map((c) => c.id), doc.cells.map((c) => c.id));
});

test('updateCellSource only touches the named cell', () => {
  let doc = freshDoc();
  doc = addCell(doc, 'code', doc.cells[0].id);
  doc = updateCellSource(doc, doc.cells[1].id, 'x = 1');
  assert.equal((doc.cells[0] as CodeCell).source, 'log');
  assert.equal((doc.cells[1] as CodeCell).source, 'x = 1');
});

test('setArtifactBindings replaces the bound artifact list', () => {
  const doc = setArtifactBindings(freshDoc(), ['a_2', 'a_3']);
  assert.deepEqual(doc.metadata.promenade.artifactBindings, ['a_2', 'a_3']);
});

test('.ipynb round-trip preserves cells, execution counts, and outputs', () => {
  let doc = freshDoc();
  doc = addCell(doc, 'markdown', doc.cells[0].id);
  doc = updateCellSource(doc, doc.cells[1].id, '# Heading\n\nSome text.');
  doc = appendCellOutput(doc, doc.cells[0].id, { outputType: 'stream', name: 'stdout', text: 'hello\nworld' });
  doc = appendCellOutput(doc, doc.cells[0].id, {
    outputType: 'execute_result', executionCount: 1, data: { 'text/plain': 'repr', 'application/json': '{"a":1}' },
  });
  doc = finishCellExecution(doc, doc.cells[0].id, 1);

  const json = serializeIpynb(doc);
  const nb = JSON.parse(json);
  assert.equal(nb.nbformat, 4);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[0].cell_type, 'code');
  assert.equal(nb.cells[0].execution_count, 1);
  assert.equal(nb.metadata.promenade.artifactBindings[0], 'a_1');

  const restored = deserializeIpynb(json);
  assert.equal(restored.cells.length, 2);
  assert.equal((restored.cells[0] as CodeCell).source, 'log');
  assert.equal(restored.cells[1].source, '# Heading\n\nSome text.');
  const restoredCode = restored.cells[0] as CodeCell;
  assert.equal(restoredCode.executionCount, 1);
  assert.equal(restoredCode.outputs.length, 2);
  assert.equal(restoredCode.outputs[0].outputType, 'stream');
  assert.equal((restoredCode.outputs[0] as any).text, 'hello\nworld');
  assert.equal((restoredCode.outputs[1] as any).data['application/json'], '{"a":1}');
  assert.deepEqual(restored.metadata.promenade, doc.metadata.promenade);
});

test('toIpynb/fromIpynb is a plain-object round trip too, not just via JSON text', () => {
  const doc = freshDoc();
  const restored = fromIpynb(toIpynb(doc));
  assert.equal(restored.cells.length, 1);
  assert.equal((restored.cells[0] as CodeCell).source, 'log');
});

test('a foreign, non-Promenade .ipynb still imports, defaulting the kernel metadata', () => {
  const foreign = {
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ id: 'x1', cell_type: 'code', source: ['print(1)'], metadata: {}, execution_count: null, outputs: [] }],
  };
  const doc = fromIpynb(foreign as any, 'Imported');
  assert.equal(doc.title, 'Imported');
  assert.equal((doc.cells[0] as CodeCell).source, 'print(1)');
  assert.deepEqual(doc.metadata.promenade.artifactBindings, []);
});

test('boundOutputForPersistence truncates an oversized text output rather than storing it whole', () => {
  const huge = 'x'.repeat(200_000);
  const bounded = boundOutputForPersistence({ outputType: 'stream', name: 'stdout', text: huge });
  assert.ok((bounded as any).text.length < huge.length);
  assert.match((bounded as any).text, /truncated/);
});

test('boundOutputForPersistence drops (rather than truncates) a wildly oversized MIME value and flags recompute', () => {
  const huge = 'y'.repeat(2_000_000);
  const bounded = boundOutputForPersistence({ outputType: 'execute_result', executionCount: 1, data: { 'text/plain': huge } });
  assert.equal(bounded.recomputeRequired, true);
});

test('boundOutputForPersistence leaves a small output untouched', () => {
  const out = { outputType: 'execute_result' as const, executionCount: 1, data: { 'text/plain': 'small' } };
  const bounded = boundOutputForPersistence(out);
  assert.deepEqual(bounded.data, { 'text/plain': 'small' });
  assert.equal(bounded.recomputeRequired, undefined);
});

test('an error output passes through boundOutputForPersistence unchanged', () => {
  const out = { outputType: 'error' as const, ename: 'ValueError', evalue: 'bad', traceback: ['line1', 'line2'] };
  assert.deepEqual(boundOutputForPersistence(out), out);
});
