import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

const C = '55555555-5555-4555-8555-555555555555';
const interaction = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId });

async function setup(t) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'History failure fixture' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Execute task', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; turn.status = 'completed'; turn.itemsView = 'full';
  turn.items.push({ type: 'subAgentActivity', id: 'c1', kind: 'started', agentThreadId: C },
    interaction('c2', C), { type: 'subAgentActivity', id: 'c-done', kind: 'completed', agentThreadId: C });
  const child = f.thread(C); child.parentThreadId = A; child.status = { type: 'notLoaded' }; f.threads.set(C, child);
  return { f, turn, get c() { return c; }, async restart() { await c.close(); c = await Controller.open(options); } };
}

for (const acrossPages of [false, true]) test(`duplicate conflicting turn snapshots cannot qualify readiness: acrossPages=${acrossPages}`, async t => {
  const s = await setup(t);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  await s.restart();
  const snapshots = [{ id: T, status: 'completed', itemsView: 'summary' }, { ...s.turn, status: 'unknown' }];
  if (acrossPages) snapshots.reverse();
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const data = acrossPages ? [snapshots[q.params.cursor ? 1 : 0]] : snapshots;
    socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor: acrossPages && !q.params.cursor ? 'later' : null } })); return true;
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.ok(['PREVIOUS_WORK_UNVERIFIED', 'INVALID_BACKEND_RESPONSE'].includes(result.code));
  assert.equal(result.modelTurnStarted, false);
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), error => ['PREVIOUS_WORK_UNVERIFIED', 'INVALID_BACKEND_RESPONSE'].includes(error.code));
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const variant of ['malformed page', 'transport failure']) test(`failed later history page retains positive obligations across reconnect: ${variant}`, async t => {
  const s = await setup(t);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  s.turn.items.push(interaction('late-input', C));
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    if (q.params.cursor && variant === 'transport failure') { socket.close(); return true; }
    const result = q.params.cursor ? { data: null, nextCursor: null } : { data: [s.turn], nextCursor: 'later' };
    socket.send(JSON.stringify({ id: q.id, result })); return true;
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.equal(result.modelTurnStarted, false);
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].items['late-input']?.kind, 'interacted');
  s.turn.items = s.turn.items.filter(item => item.id !== 'late-input');
  s.f.handle = null;
  await s.restart();
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const variant of ['null item', 'malformed receiver list']) test(`malformed later owned turn retains earlier obligations: ${variant}`, async t => {
  const s = await setup(t);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  const root = s.f.threads.get(A), U = randomUUID();
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: U, status: 'inProgress', itemsView: 'full', items: [{ type: 'userMessage', id: 'next', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    root.turns.push(turn);
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  assert.equal((await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true })).phase, 'accepted');
  root.turns[1].status = 'completed';
  s.f.handle = null;
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  s.turn.items.push(interaction('late-input', C));
  const malformed = variant === 'null item' ? null : { type: 'collabAgentToolCall', id: 'malformed-child', receiverThreadIds: 1 };
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    const data = q.params.cursor ? [{ id: U, status: 'completed', itemsView: 'full', items: [malformed] }] : [s.turn];
    socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor: q.params.cursor ? null : 'later' } })); return true;
  };
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].items['late-input']?.kind, 'interacted');
  s.turn.items = s.turn.items.filter(item => item.id !== 'late-input');
  s.f.handle = null;
  await s.restart();
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Third', expectedLastTurnId: U, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 2);
});

for (const variant of ['malformed page', 'transport failure']) test(`failed fresh item repair retains returned obligations: ${variant}`, async t => {
  const s = await setup(t);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  s.f.handle = (socket, q) => {
    if (q.method === 'thread/turns/list') {
      socket.send(JSON.stringify({ id: q.id, result: { data: [{ id: T, status: 'completed', itemsView: 'summary' }], nextCursor: null } })); return true;
    }
    if (q.method !== 'thread/items/list') return;
    if (q.params.cursor) {
      if (variant === 'transport failure') socket.close();
      else socket.send(JSON.stringify({ id: q.id, result: { data: null, nextCursor: null } }));
      return true;
    }
    const data = [...s.turn.items, interaction('late-input', C)].map(item => ({ turnId: T, item }));
    socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor: 'later' } })); return true;
  };
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].items['late-input']?.kind, 'interacted');
  s.f.handle = null;
  await s.restart();
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
  await assert.rejects(s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
