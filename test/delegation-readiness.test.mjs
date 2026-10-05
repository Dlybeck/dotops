import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

const C = '55555555-5555-4555-8555-555555555555';
const D = '66666666-6666-4666-8666-666666666666';
const interaction = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId });
const completion = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'completed', agentThreadId });

async function setup(t) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Lifecycle fixture' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Review', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; turn.status = 'completed'; turn.itemsView = 'full';
  turn.items.push(interaction('c1', C), interaction('d1', D), interaction('c2', C), interaction('d2', D),
    completion('c-done', C), interaction('d3', D), completion('d-done', D));
  for (const id of [C, D]) { const child = f.thread(id); child.parentThreadId = A; child.status = { type: 'notLoaded' }; f.threads.set(id, child); }
  return { f, root, turn, get c() { return c; }, async restart() { await c.close(); c = await Controller.open(options); } };
}

function assertUnknownOutcomes(s, value) {
  assert.equal(value.ownedDelegations.open, 5);
  assert.ok(value.ownedDelegations.items.every(x => x.state === 'unknown' && !x.childStopAuthorized));
  assert.equal(Object.keys(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures ?? {}).length, 0);
}

test('completed reviewer lifecycles admit after reconnect while five exact interaction outcomes remain unknown', async t => {
  const s = await setup(t);
  let status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, true);
  assertUnknownOutcomes(s, status.admission);
  assert.equal(status.admission.currentReadiness.delegationReadiness.unready, 0);
  await s.restart();
  const begin = s.f.calls.length;
  const reconciled = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(reconciled.phase, 'verified');
  assert.equal(reconciled.currentReadiness.ready, true);
  assert.equal(reconciled.historicalUnknowns.open, 5);
  assert.deepEqual(reconciled.resumedDescendants, []);
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, false);
  assertUnknownOutcomes(s, stopped);
  status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, true);
  assert.equal(s.f.calls.slice(begin).some(q => [C, D].includes(q.params?.threadId) &&
    ['thread/resume', 'thread/items/list', 'thread/turns/list', 'turn/start', 'turn/interrupt', 'thread/backgroundTerminals/terminate'].includes(q.method)), false);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  // A new send exercises the actual dispatch path and both fresh rechecks.
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: 'next', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    s.root.turns.push(turn); s.root.status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
  assert.equal(sent.phase, 'accepted');
  assert.notEqual(sent.turnId, T);
});

for (const variant of ['missing child', 'wrong parent', 'changed cwd', 'active child', 'unknown child status',
  'active goal', 'queued input', 'missing queue cursor', 'unknown goal', 'live child process', 'missing process cursor',
  'missing lifecycle completion', 'wrong completion receiver', 'late interaction', 'started operation', 'typed waking operation',
  'unknown kind', 'duplicate completion', 'null completion receiver', 'incomplete history', 'running root']) test(`lifecycle readiness retains real blockers: ${variant}`, async t => {
  const s = await setup(t), child = s.f.threads.get(C);
  if (variant === 'missing child') s.f.threads.delete(C);
  if (variant === 'wrong parent') child.parentThreadId = null;
  if (variant === 'changed cwd') {
    const read = s.c.native.request.bind(s.c.native);
    s.c.native.request = async (method, params, options) => {
      const response = await read(method, params, options);
      return method === 'thread/read' && params.threadId === C ? { thread: { ...response.thread, cwd: '/different' } } : response;
    };
  }
  if (variant === 'active child' || variant === 'unknown child status') child.status = { type: variant === 'active child' ? 'active' : 'mystery' };
  if (variant === 'live child process' || variant === 'missing process cursor') child.status = { type: 'idle' };
  if (variant === 'missing lifecycle completion') s.turn.items = s.turn.items.filter(x => x.id !== 'c-done');
  if (variant === 'wrong completion receiver') s.turn.items.find(x => x.id === 'c-done').agentThreadId = D;
  if (variant === 'late interaction') s.turn.items.push(interaction('late', C));
  if (variant === 'started operation') s.turn.items[1].kind = 'started';
  if (variant === 'typed waking operation') s.turn.items[1] = { type: 'collabAgentToolCall', id: 'typed', tool: 'followupTask', status: 'completed', senderThreadId: A, receiverThreadIds: [D] };
  if (variant === 'unknown kind') s.turn.items[1].kind = 'mystery';
  if (variant === 'duplicate completion') s.turn.items.push(completion('c-done', C));
  if (variant === 'null completion receiver') s.turn.items.find(x => x.id === 'c-done').agentThreadId = null;
  if (variant === 'incomplete history') s.turn.itemsView = 'summary';
  if (variant === 'running root') { s.turn.status = 'inProgress'; s.root.status = { type: 'active' }; }
  s.f.handle = (socket, q) => {
    if (q.params?.threadId !== C) return;
    let result;
    if (variant === 'active goal' && q.method === 'thread/goal/get') result = { goal: { status: 'active' } };
    if (variant === 'unknown goal' && q.method === 'thread/goal/get') result = {};
    if (variant === 'queued input' && q.method === 'thread/queue/list') result = { data: [{ id: 'queued' }], nextCursor: null };
    if (variant === 'missing queue cursor' && q.method === 'thread/queue/list') result = { data: [] };
    if (variant === 'live child process' && q.method === 'thread/backgroundTerminals/list') result = { data: [{ itemId: 'live', processId: '42', cwd: s.f.cwd }], nextCursor: null };
    if (variant === 'missing process cursor' && q.method === 'thread/backgroundTerminals/list') result = { data: [] };
    if (result) { socket.send(JSON.stringify({ id: q.id, result })); return true; }
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, false);
  if (variant === 'running root') await assert.rejects(s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A }), { code: 'CHAT_ACTIVE' });
  else {
    const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
    assert.equal(result.phase, 'unverified');
  }
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const variant of ['active', 'goal', 'queue']) test(`send recheck rejects a reviewer becoming ${variant} after readiness snapshot`, async t => {
  const s = await setup(t);
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  const request = s.c.native.request.bind(s.c.native); let reads = 0;
  s.c.native.request = async (method, params, options) => {
    if (method === 'thread/read' && params.threadId === C) reads++;
    if (reads >= 2 && params.threadId === C) {
      if (variant === 'active' && method === 'thread/read') return { thread: { ...s.f.threads.get(C), status: { type: 'active' } } };
      if (variant === 'goal' && method === 'thread/goal/get') return { goal: { status: 'active' } };
      if (variant === 'queue' && method === 'thread/queue/list') return { data: [{ id: 'new' }], nextCursor: null };
    }
    return request(method, params, options);
  };
  const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
  assert.equal(sent.phase, 'notDispatched');
  assert.equal(sent.code, 'PREVIOUS_WORK_UNVERIFIED');
  assert.ok(reads >= 2);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('unloaded reviewers need no inventory RPC or reattachment; readiness is not a durable closure', async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if ([C, D].includes(q.params?.threadId) && q.method === 'thread/backgroundTerminals/list') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Not loaded' } })); return true;
    }
  };
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  assert.equal(s.f.calls.some(q => [C, D].includes(q.params?.threadId) && q.method === 'thread/backgroundTerminals/list'), false);
  await s.restart();
  s.f.threads.get(C).status = { type: 'active' };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, false);
  assert.equal(status.admission.runtimeProof.durableUnloadedChildClosureAvailable, false);
  assertUnknownOutcomes(s, status.admission);
});
