import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

const C = '55555555-5555-4555-8555-555555555555';
const D = '66666666-6666-4666-8666-666666666666';
const interaction = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId });
const completion = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'completed', agentThreadId });

async function setup(t, { startedLifecycle = false } = {}) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Lifecycle fixture' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Review', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; turn.status = 'completed'; turn.itemsView = 'full';
  turn.items.push(interaction('c1', C), interaction('d1', D), interaction('c2', C), interaction('d2', D),
    completion('c-done', C), interaction('d3', D), completion('d-done', D));
  if (startedLifecycle) turn.items.splice(1, turn.items.length - 1,
    { type: 'subAgentActivity', id: 'c1', kind: 'started', agentThreadId: C },
    interaction('c2', C), completion('c-done', C));
  for (const id of [C, D]) { const child = f.thread(id); child.parentThreadId = A; child.status = { type: 'notLoaded' }; f.threads.set(id, child); }
  return { f, root, turn, get c() { return c; }, async restart() { await c.close(); c = await Controller.open(options); } };
}

test('started then interacted reviewer lifecycle admits after reconnect without closing either exact outcome', async t => {
  // Synthetic counterpart of native started -> interacted -> completed history:
  // one completion cannot establish the outcomes of two distinct operations.
  const s = await setup(t, { startedLifecycle: true });
  // Match the reported inventory size without publishing native identities.
  for (let i = 0; i < 20; i++) {
    const child = s.f.thread(`77777777-7777-4777-8777-${String(i).padStart(12, '0')}`);
    child.parentThreadId = A; child.status = { type: 'notLoaded' }; s.f.threads.set(child.id, child);
  }
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, true);
  assert.equal(status.admission.ownedDelegations.open, 2);
  assert.ok(status.admission.ownedDelegations.items.every(x => x.state === 'unknown' && !x.childStopAuthorized));
  assert.equal(status.admission.currentReadiness.delegationReadiness.unready, 0);
  await s.restart();
  const begin = s.f.calls.length;
  const reconciled = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(reconciled.phase, 'verified');
  assert.equal(reconciled.historicalUnknowns.open, 2);
  assert.deepEqual(reconciled.resumedDescendants, []);
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, false);
  assert.equal(stopped.ownedDelegations.open, 2);
  assert.equal(Object.keys(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures ?? {}).length, 0);
  assert.equal(s.f.calls.slice(begin).some(q => [C, D].includes(q.params?.threadId) &&
    ['thread/resume', 'thread/items/list', 'thread/turns/list', 'turn/interrupt', 'thread/backgroundTerminals/terminate'].includes(q.method)), false);
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

for (const startedLifecycle of [false, true]) for (const variant of ['missing child', 'wrong parent', 'changed cwd', 'active child', 'unknown child status',
  'active goal', 'queued input', 'missing queue cursor', 'unknown goal', 'live child process', 'missing process cursor',
  'missing lifecycle completion', 'wrong completion receiver', 'late interaction', 'later started operation', 'typed waking operation',
  'multiple starts', 'unknown kind', 'duplicate completion', 'null completion receiver', 'identity conflict', 'incomplete history', 'running root']) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} lifecycle readiness retains real blockers: ${variant}`, async t => {
  const s = await setup(t, { startedLifecycle }), child = s.f.threads.get(C);
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
  if (variant === 'later started operation') s.turn.items.push({ ...interaction('late-start', C), kind: 'started' });
  if (variant === 'multiple starts') s.turn.items.splice(1, 1,
    { ...interaction('first-start', C), kind: 'started' }, { ...interaction('second-start', C), kind: 'started' });
  if (variant === 'typed waking operation') s.turn.items[1] = { type: 'collabAgentToolCall', id: 'typed', tool: 'followupTask', status: 'completed', senderThreadId: A, receiverThreadIds: [D] };
  if (variant === 'unknown kind') s.turn.items[1].kind = 'mystery';
  if (variant === 'duplicate completion') s.turn.items.push(completion('c-done', C));
  if (variant === 'null completion receiver') s.turn.items.find(x => x.id === 'c-done').agentThreadId = null;
  if (variant === 'identity conflict') {
    await s.c.call('codex_chat_status', { threadId: A });
    s.turn.items.find(x => x.id === 'c1').agentThreadId = D;
  }
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

test('a completion retained for exact closure cannot supply readiness to a new started/interacted lifecycle', async t => {
  const s = await setup(t, { startedLifecycle: true });
  s.turn.items = s.turn.items.filter(x => x.id !== 'c2');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.ownedDelegations.open, 0);
  // Omit the already closed launch, then present new activity before its receipt.
  s.turn.items.splice(1, s.turn.items.length - 1,
    { ...interaction('new-start', C), kind: 'started' }, interaction('new-interaction', C), completion('c-done', C));
  await s.restart();
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, false);
  assert.equal(status.admission.ownedDelegations.open, 2);
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const startedLifecycle of [false, true]) for (const variant of ['active', 'goal', 'queue', 'process', 'later interaction', 'incomplete history', 'unavailable history']) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} send recheck rejects ${variant} after readiness snapshot`, async t => {
  const s = await setup(t, { startedLifecycle });
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  const request = s.c.native.request.bind(s.c.native); let reads = 0;
  s.c.native.request = async (method, params, options) => {
    if (method === 'thread/read' && params.threadId === C) reads++;
    if (reads >= 2 && variant === 'unavailable history' && method === 'thread/turns/list') throw Object.assign(new Error('History unavailable'), { code: 'UNSUPPORTED_RPC' });
    if (reads >= 2 && params.threadId === C) {
      if (variant === 'active' && method === 'thread/read') return { thread: { ...s.f.threads.get(C), status: { type: 'active' } } };
      if (variant === 'goal' && method === 'thread/goal/get') return { goal: { status: 'active' } };
      if (variant === 'queue' && method === 'thread/queue/list') return { data: [{ id: 'new' }], nextCursor: null };
      if (variant === 'process') {
        s.f.threads.get(C).status = { type: 'idle' };
        if (method === 'thread/backgroundTerminals/list') return { data: [{ itemId: 'live', processId: '42', cwd: s.f.cwd }], nextCursor: null };
      }
      if (variant === 'later interaction' && !s.turn.items.some(x => x.id === 'later')) s.turn.items.push(interaction('later', C));
      if (variant === 'incomplete history') s.turn.itemsView = 'summary';
    }
    return request(method, params, options);
  };
  const sent = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true });
  assert.equal(sent.phase, 'notDispatched');
  assert.equal(sent.code, 'PREVIOUS_WORK_UNVERIFIED');
  assert.ok(reads >= 2);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const startedLifecycle of [false, true]) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} unloaded reviewers need no inventory RPC or reattachment; readiness is not a durable closure`, async t => {
  const s = await setup(t, { startedLifecycle });
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
  if (startedLifecycle) assert.equal(status.admission.ownedDelegations.open, 2);
  else assertUnknownOutcomes(s, status.admission);
});

for (const variant of ['summary', 'unavailable', 'missing turn']) test(`reconnect cannot recycle cached started/interacted readiness with ${variant} history`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  await s.restart();
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const response = variant === 'unavailable' ? { error: { code: -32601, message: 'Unsupported' } }
      : { result: { data: variant === 'missing turn' ? [] : [{ ...s.turn, itemsView: 'summary' }], nextCursor: null } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  const reconciled = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(reconciled.phase, 'unverified');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.ownedDelegations.open, 2);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const lateInteraction of [false, true]) test(`unavailable later history page blocks cached lifecycle readiness${lateInteraction ? ' with new interaction' : ''}`, async t => {
  const s = await setup(t, { startedLifecycle: true });
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  if (lateInteraction) s.turn.items.push(interaction('late', C));
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const response = q.params.cursor ? { error: { code: -32601, message: 'Unsupported history page' } }
      : { result: { data: [s.turn], nextCursor: 'unavailable-page' } };
    socket.send(JSON.stringify({ id: q.id, ...response })); return true;
  };
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
