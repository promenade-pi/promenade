import test from 'node:test';
import assert from 'node:assert/strict';
import { SupersededError } from '../../src/host/actions/types.ts';

/**
 * A superseded run is not a failure, and the difference has to be visible to
 * `executeAction` by *type*, not by reading the message.
 *
 * The bug this guards against: the wasm runtime adapters used to raise a plain
 * `Error` when the runner reported that a newer request had replaced the run.
 * Every caller treated it as a real failure, so a fast slider drag — which
 * supersedes runs many times a second, by design — left a permanent
 * "superseded by a newer request" banner describing a run nobody was waiting
 * for, while the run that *was* waited for had already succeeded and could
 * never clear it.
 *
 * `executeAction` now maps this type to a `null` result, which is the
 * "nothing to report" signal its callers already handled for an aborted run.
 * That mapping cannot be exercised here: `executeAction` reaches the data
 * client, the result store and OPFS through extensionless imports that only
 * Vite resolves, so nothing under `node --test` can load it. What is pinned
 * here is the half that makes the mapping possible — that the signal is a
 * distinguishable type at all. A future change back to a plain `Error`, or to
 * message-matching, fails this.
 */
test('a superseded run is distinguishable without matching on its message', () => {
  const superseded = new SupersededError('run.promenade.split-miner.discover');

  assert.ok(superseded instanceof SupersededError);
  assert.ok(superseded instanceof Error, 'it still throws and catches like an error');
  assert.equal(superseded.name, 'SupersededError');

  // The message names the action, because it is still worth logging.
  assert.match(superseded.message, /run\.promenade\.split-miner\.discover/);

  // And an ordinary failure is not mistaken for one.
  assert.ok(!(new Error('kernel panicked') instanceof SupersededError));
});
