import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../../src/host/agent/dispatch.ts';
import { agentSession } from '../../src/host/agent/session.ts';
import type { AgentOp, AgentTool } from '../../src/host/agent/types.ts';

function tool(op: AgentOp, run: () => unknown = () => ({ ok: true })): AgentTool {
  return {
    name: `t_${op}`,
    op,
    description: 'test tool',
    inputSchema: { type: 'object', properties: {} },
    summarize: () => `do a ${op}`,
    run,
  };
}

/** Answers the next consent question as `decision`, once. */
function answerWith(decision: 'once' | 'session' | 'deny') {
  const stop = agentSession.subscribe(() => {
    const pending = agentSession.pending[0];
    if (pending) pending.answer(decision);
  });
  return stop;
}

test.beforeEach(() => {
  agentSession.setPolicy('ask');
  agentSession.revokeGrants();
  agentSession.clearJournal();
});

test('a read runs without asking and is journaled', async () => {
  const result = await dispatch(tool('read', () => ({ artifacts: [1, 2, 3], total: 3 })), {}, 'bridge');
  assert.equal(result.isError, undefined);
  const [entry] = agentSession.journal;
  assert.equal(entry.state, 'ok');
  assert.equal(entry.source, 'bridge');
  assert.equal(entry.outcome, '3 artifacts');
});

test('an effectful call under read-only is refused, and still journaled', async () => {
  agentSession.setPolicy('read');
  let ran = false;
  const result = await dispatch(tool('run', () => { ran = true; return {}; }), {}, 'webmcp');
  assert.equal(result.isError, true);
  assert.equal(ran, false, 'the tool must not run');
  assert.equal(agentSession.journal[0].state, 'denied');
});

test('with nothing listening, a call needing consent is refused rather than hanging', async () => {
  let ran = false;
  const result = await dispatch(tool('install', () => { ran = true; return {}; }), {}, 'webmcp');
  assert.equal(result.isError, true);
  assert.equal(ran, false);
});

test('the user allowing once lets exactly one call through', async () => {
  const stop = answerWith('once');
  try {
    let runs = 0;
    const t = tool('run', () => { runs += 1; return { artifact: { name: 'DFG' } }; });
    assert.equal((await dispatch(t, {}, 'webmcp')).isError, undefined);
    assert.equal(runs, 1);
    assert.equal(agentSession.hasGrant(t.name), false, 'no standing grant from allow-once');
    assert.equal(agentSession.journal[0].outcome, '→ DFG');
  } finally { stop(); }
});

test('allow-for-this-session stops the asking, and lowering the policy revokes it', async () => {
  const stop = answerWith('session');
  const t = tool('run');
  try {
    await dispatch(t, {}, 'webmcp');
    assert.equal(agentSession.hasGrant(t.name), true);
  } finally { stop(); }
  // No listener now: a further call only succeeds because of the grant.
  assert.equal((await dispatch(t, {}, 'webmcp')).isError, undefined);
  agentSession.setPolicy('read');
  assert.equal(agentSession.hasGrant(t.name), false);
});

test('declining reports the refusal to the agent and runs nothing', async () => {
  const stop = answerWith('deny');
  try {
    let ran = false;
    const result = await dispatch(tool('destructive', () => { ran = true; return {}; }), {}, 'bridge');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /declined/i);
    assert.equal(ran, false);
    assert.equal(agentSession.journal[0].state, 'denied');
  } finally { stop(); }
});

test('deletion is confirmed even when everything else is allowed', async () => {
  agentSession.setPolicy('allow');
  const stop = answerWith('deny');
  try {
    assert.equal((await dispatch(tool('destructive'), {}, 'bridge')).isError, true);
    assert.equal((await dispatch(tool('run'), {}, 'bridge')).isError, undefined);
  } finally { stop(); }
});

test('a failing tool reports the message and marks the entry', async () => {
  agentSession.setPolicy('allow');
  const result = await dispatch(tool('read', () => { throw new Error('no such artifact'); }), {}, 'bridge');
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'no such artifact');
  assert.equal(agentSession.journal[0].state, 'error');
});
