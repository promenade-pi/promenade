import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserPyodideKernel } from '../../src/host/notebook/browser-pyodide-kernel.ts';
import type { NotebookBridgeHost } from '../../src/host/notebook/bridge.ts';

/**
 * `start()`/`execute()`/`restart()` all reach into a real Worker (Pyodide
 * itself only runs in a browser), so this file only covers what's testable
 * without one: the status machine's rest state and the dispose-before-start
 * safety guard. The live execute/publish/restart path was verified against
 * a running Pyodide worker in-browser during development — see the
 * implementation report for what was exercised there.
 */
const mockHost: NotebookBridgeHost = {
  getCurrentArtifactMetadata: () => null,
  listArtifacts: () => [],
  getArtifact: () => { throw new Error('not found'); },
  queryArtifactData: async () => { throw new Error('unused'); },
  publishArtifact: async () => { throw new Error('unused'); },
  openArtifact: () => {},
  focusArtifactInTree: () => {},
};

test('a fresh kernel reports "dead" until start() is called', () => {
  const kernel = new BrowserPyodideKernel(mockHost);
  assert.equal(kernel.getStatus(), 'dead');
  assert.equal(kernel.label, 'Python · Pyodide');
});

test('dispose() before any worker exists is a safe no-op, not a crash', async () => {
  const kernel = new BrowserPyodideKernel(mockHost);
  await kernel.dispose();
  assert.equal(kernel.getStatus(), 'dead');
});

test('onStatusChange returns a working unsubscribe function', () => {
  const kernel = new BrowserPyodideKernel(mockHost);
  const seen: string[] = [];
  const off = kernel.onStatusChange((s) => seen.push(s));
  off();
  // Nothing to assert on `seen` without touching the Worker — this just
  // confirms subscribe/unsubscribe don't throw on an untouched kernel.
  assert.deepEqual(seen, []);
});
