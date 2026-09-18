import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/host/agent/policy.ts';
import type { AgentOp, AgentPolicy } from '../../src/host/agent/types.ts';

const OPS: AgentOp[] = ['read', 'ui', 'write', 'run', 'install', 'destructive'];

test('off offers nothing at all', () => {
  for (const op of OPS) assert.equal(decide(op, 'off'), 'deny');
});

test('read-only allows reading and looking, refuses everything else', () => {
  assert.equal(decide('read', 'read'), 'allow');
  assert.equal(decide('ui', 'read'), 'allow');
  for (const op of ['write', 'run', 'install', 'destructive'] as AgentOp[]) {
    assert.equal(decide(op, 'read'), 'deny');
  }
});

test('ask confirms everything with an effect, and nothing without one', () => {
  assert.equal(decide('read', 'ask'), 'allow');
  assert.equal(decide('ui', 'ask'), 'allow');
  for (const op of ['write', 'run', 'install', 'destructive'] as AgentOp[]) {
    assert.equal(decide(op, 'ask'), 'ask');
  }
});

test('allow still confirms deletion', () => {
  for (const op of ['read', 'ui', 'write', 'run', 'install'] as AgentOp[]) {
    assert.equal(decide(op, 'allow'), 'allow');
  }
  assert.equal(decide('destructive', 'allow'), 'ask');
});

test('every policy has a verdict for every op', () => {
  for (const policy of ['off', 'read', 'ask', 'allow'] as AgentPolicy[]) {
    for (const op of OPS) {
      assert.ok(['allow', 'ask', 'deny'].includes(decide(op, policy)));
    }
  }
});
