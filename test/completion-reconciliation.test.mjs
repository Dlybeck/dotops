import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

for (const earlyCompletion of [false, true]) test(`native completion reconciles delayed origin without status query or resend (before acknowledgement: ${earlyCompletion})`, async t => {
  const f = await fixture(t); let completed = false;
  f.handle = (socket, q) => {
    if (q.method === 'turn/start') {
      const thread = f.threads.get(A);
      const turn = { id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'u', clientId: q.params.clientUserMessageId, content: q.params.input }] };
      thread.turns.push(turn); thread.status = { type: 'active' };
      if (earlyCompletion) {
        completed = true; turn.status = 'completed'; thread.status = { type: 'idle' };
        f.notify('turn/completed', { threadId: A, turn: { id: T, status: 'completed', items: [] } });
      }
      socket.send(JSON.stringify({ id: q.id, result: { turn: { id: T } } }));
      return true;
    }
    if (q.method === 'thread/turns/list' && f.threads.get(A)?.turns.length) {
      const turn = f.threads.get(A).turns[0];
      // The first post-ack read lacks origin even when completion raced the ack.
      const first = !f.firstHistoryRead; f.firstHistoryRead = true;
      socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, items: first || !completed ? [] : turn.items }], nextCursor: null } }));
      return true;
    }
  };
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Delayed native origin fixture' });
  const args = { threadId: A, requestId: randomUUID(), text: 'One request only.' };
  const result = await c.call('codex_chat_send', args);
  assert.equal(result.phase, 'unknown'); assert.equal(result.code, 'TURN_ORIGIN_UNVERIFIED');
  if (!earlyCompletion) {
    completed = true; f.threads.get(A).turns[0].status = 'completed'; f.threads.get(A).status = { type: 'idle' };
    const event = once(c.native, 'event');
    f.notify('turn/completed', { threadId: A, turn: { id: T, status: 'completed', items: [] } });
    await event;
  }
  assert.ok(c.completionJobs?.get(A), 'The native event must schedule a supported one-shot completion task');
  await c.completionJobs.get(A);
  assert.equal(c.store.state.operations[args.requestId].phase, 'accepted');
  assert.equal(c.store.state.threads[A].terminalTurns[T].status, 'completed');
  assert.equal((await c.call('codex_chat_send', args)).phase, 'accepted');
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const evidence of ['absent origin', 'duplicate origin', 'stale epoch', 'history failure']) test(`completion leaves uncertain delivery unknown with ${evidence}`, async t => {
  const f = await fixture(t); let afterSend = false; let recovered = false;
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list' || !f.threads.get(A)?.turns.length) return;
    const turn = f.threads.get(A).turns[0];
    if (afterSend && !recovered && evidence === 'history failure') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32000, message: 'history unavailable' } })); return true;
    }
    const items = recovered ? turn.items : afterSend && evidence === 'duplicate origin' ? [turn.items[0], { ...turn.items[0], id: 'duplicate' }] : [];
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, items }], nextCursor: null } })); return true;
  };
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Uncertain completion fixture' });
  const args = { threadId: A, requestId: randomUUID(), text: 'Do not duplicate.' };
  assert.equal((await c.call('codex_chat_send', args)).phase, 'unknown');
  afterSend = true;
  const readsBefore = f.calls.filter(q => q.method === 'thread/turns/list').length;
  c.event({ method: 'turn/completed', epoch: c.native.epoch - (evidence === 'stale epoch' ? 1 : 0),
    params: { threadId: A, turn: { id: T, status: 'completed', items: f.threads.get(A).turns[0].items } } });
  const job = c.completionJobs.get(A);
  if (evidence === 'stale epoch') assert.equal(job, undefined);
  else { assert.ok(job); await job; }
  assert.equal(c.store.state.operations[args.requestId].phase, 'unknown');
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
  if (evidence === 'stale epoch') assert.equal(f.calls.filter(q => q.method === 'thread/turns/list').length, readsBefore);
  if (evidence === 'absent origin') {
    recovered = true;
    c.event({ method: 'turn/completed', epoch: c.native.epoch,
      params: { threadId: A, turn: { id: T, status: 'completed', items: [] } } });
    const next = c.completionJobs.get(A);
    assert.ok(next); assert.notEqual(next, job, 'A settled job must not suppress a fresh completion');
    await next;
    assert.equal(c.store.state.operations[args.requestId].phase, 'accepted');
    assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
  }
  if (evidence === 'history failure') {
    recovered = true;
    await c.call('codex_chat_status', { threadId: A });
    assert.equal(c.store.state.operations[args.requestId].phase, 'accepted');
    assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
  }
});

for (const [reconnect, shutdown] of [[false, false], [true, false], [false, true]]) test(`completion overlap lifecycle (reconnect: ${reconnect}, shutdown: ${shutdown})`, async t => {
  const f = await fixture(t); let delayedRead; let releaseRead; let completed = false;
  const readStarted = new Promise(resolve => { delayedRead = resolve; });
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list' || !f.threads.get(A)?.turns.length) return;
    const turn = f.threads.get(A).turns[0];
    if (!completed && releaseRead === undefined) {
      socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, items: [] }], nextCursor: null } }));
      releaseRead = null; return true;
    }
    if (!completed && releaseRead === null) {
      releaseRead = () => socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, items: [] }], nextCursor: null } }));
      delayedRead(); return true;
    }
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, status: 'completed' }], nextCursor: null } })); return true;
  };
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Overlapping completion fixture' });
  const args = { threadId: A, requestId: randomUUID(), text: 'Exactly once.' };
  assert.equal((await c.call('codex_chat_send', args)).phase, 'unknown');
  const emit = () => c.event({ method: 'turn/completed', epoch: c.native.epoch,
    params: { threadId: A, turn: { id: T, status: 'completed', items: [] } } });
  emit(); await readStarted;
  const job = c.completionJobs.get(A);
  completed = true;
  if (reconnect) c.native.epoch++;
  emit();
  const closing = shutdown ? c.close() : null;
  if (shutdown) assert.equal(c.native.closed, false, 'Shutdown must await the in-flight completion job');
  releaseRead();
  await job;
  assert.equal(c.store.state.operations[args.requestId].phase, shutdown ? 'unknown' : 'accepted');
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
  if (closing) await closing;
  else await c.close();
  const reopened = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => reopened.close());
  assert.equal(reopened.store.state.operations[args.requestId].phase, shutdown ? 'unknown' : 'accepted');
  if (!shutdown) assert.equal(reopened.store.state.threads[A].terminalTurns[T].status, 'completed');
});

test('current-epoch completion queued behind a stale job is retained', async t => {
  const f = await fixture(t); let ready = false;
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list' || !f.threads.get(A)?.turns.length) return;
    const turn = f.threads.get(A).turns[0];
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, status: 'completed', items: ready ? turn.items : [] }], nextCursor: null } })); return true;
  };
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Queued epoch fixture' });
  const args = { threadId: A, requestId: randomUUID(), text: 'One queued request.' };
  assert.equal((await c.call('codex_chat_send', args)).phase, 'unknown');
  let release; let started;
  const blocked = new Promise(resolve => { started = resolve; });
  const blocker = c.serial(A, () => new Promise(resolve => { release = resolve; started(); }));
  await blocked;
  const emit = () => c.event({ method: 'turn/completed', epoch: c.native.epoch,
    params: { threadId: A, turn: { id: T, status: 'completed', items: [] } } });
  emit(); const job = c.completionJobs.get(A);
  c.native.epoch++; ready = true; emit(); release();
  await blocker; await job;
  assert.equal(c.store.state.operations[args.requestId].phase, 'accepted');
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});
