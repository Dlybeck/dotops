import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, B, R, T } from './stage1-fixture.mjs';

async function setup(t) {
  const f = await fixture(t); const options = { root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Control recovery' });
  return { f, get c() { return c; }, async reopen() { await c.close(); c = await Controller.open(options); } };
}
test('native goals can be paused and cleared explicitly with prior metadata and idempotency', async t => {
  const s = await setup(t); s.f.goal = { objective: 'Keep prior work', status: 'blocked', tokenBudget: null };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  const pause = { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'pause' };
  assert.equal((await s.c.call('codex_chat_goal', pause)).observedDesiredState, true);
  assert.equal(s.f.goal.status, 'paused');
  assert.deepEqual(s.c.store.state.operations[pause.requestId].priorGoal, { status: 'blocked', tokenBudget: null, tokensUsed: null });
  await s.reopen();
  assert.equal((await s.c.call('codex_chat_goal', pause)).nativeAcknowledged, true);
  assert.equal(s.f.calls.filter(q => q.method === 'thread/goal/set').length, 1);
  await assert.rejects(s.c.call('codex_chat_goal', { ...pause, requestId: randomUUID(), action: 'clear' }), { code: 'GOAL_CHANGED' });
  const updated = await s.c.call('codex_chat_status', { threadId: A });
  const clear = { ...pause, requestId: randomUUID(), action: 'clear', expectedGoalHash: updated.admission.nativeGoalHash };
  assert.equal((await s.c.call('codex_chat_goal', clear)).observedDesiredState, true);
  assert.equal(s.f.goal, null); assert.equal(s.f.calls.some(q => q.method === 'turn/start'), false);
});
test('goal mutation after final-read disconnect remains uncertain without replay', async t => {
  const s = await setup(t); s.f.goal = { objective: 'Existing', status: 'blocked' };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  s.f.handle = (socket, q) => { if (q.method === 'thread/goal/clear') { s.f.goal = null; socket.terminate(); return true; } };
  const args = { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'clear' };
  assert.equal((await s.c.call('codex_chat_goal', args)).phase, 'unknown');
  await s.reopen(); assert.equal((await s.c.call('codex_chat_goal', args)).phase, 'unknown');
  assert.equal(s.f.calls.filter(q => q.method === 'thread/goal/clear').length, 1);
});
test('more than 100 command observations are retained without global admission latch', async t => {
  const s = await setup(t);
  await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Track commands' });
  for (let i = 0; i < 150; i++) s.c.event({ method: 'item/started', params: { threadId: A, turnId: T,
    item: { type: 'commandExecution', id: 'item-' + i, processId: 'process-' + i, status: 'completed' } } });
  await s.c.store.tail;
  assert.equal(Object.keys(s.c.store.state.threads[A].commandItems).length, 150);
  assert.equal(s.c.persistenceRetries.size, 0);
  s.f.threads.get(A).turns[0].status = 'completed'; s.f.threads.get(A).status.type = 'idle';
  assert.equal((await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next request' })).phase, 'accepted');
});
test('transient persistence failure retries exact observations without losing identity conflicts', async t => {
  const s = await setup(t);
  await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Track commands' });
  const update = s.c.store.update.bind(s.c.store); let failing = true;
  s.c.store.update = fn => failing ? Promise.reject(new Error('Synthetic disk fault')) : update(fn);
  const event = processId => s.c.event({ method: 'item/started', params: { threadId: A, turnId: T,
    item: { type: 'commandExecution', id: 'same-item', processId, status: 'inProgress' } } });
  event('original'); event('replacement'); await Promise.resolve(); await Promise.resolve();
  assert.equal(s.c.persistenceRetries.has(A), true);
  failing = false; await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(s.c.persistenceRetries.has(A), false);
  const receipt = s.c.store.state.threads[A].commandItems['same-item'];
  assert.equal(receipt.identityConflict, true);
  assert.deepEqual(new Set(receipt.observations.map(x => x.processId)), new Set(['original', 'replacement']));
});
test('paused goal permits verified turn stop without pretending goal completion', async t => {
  const s = await setup(t); await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Work' });
  s.f.goal = { objective: 'Unfinished work', status: 'paused' };
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, true); assert.equal(stopped.goalsClear, false); assert.equal(stopped.goalContinuationStopped, true);
  assert.equal(s.f.goal.status, 'paused');
});
test('status pages newest operations with explicit continuation and rejects changed snapshots', async t => {
  const s = await setup(t);
  await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'One delivery' });
  const ids = [];
  await s.c.store.update(state => {
    for (let i = 0; i < 24; i++) {
      const id = randomUUID(); ids.push(id);
      state.operations[id] = { kind: 'send', fingerprint: 'fixture', phase: 'accepted', threadId: A, turnId: T };
    }
  });
  const first = await s.c.call('codex_chat_status', { threadId: A, limit: 5 });
  assert.equal(first.operations[0].requestId, ids.at(-1));
  assert.equal(first.operationCount, 25); assert.equal(first.operations.length, 5); assert.ok(first.nextCursor);
  const second = await s.c.call('codex_chat_status', { threadId: A, cursor: first.nextCursor, limit: 5 });
  assert.equal(second.operations[0].requestId, ids.at(-6));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 32768);
  await s.c.store.update(state => { state.operations[ids[0]].failureCode = 'Synthetic changed evidence'; });
  await assert.rejects(s.c.call('codex_chat_status', { threadId: A, cursor: first.nextCursor }), { code: 'STATUS_CHANGED' });
});
test('ordinary question arriving before acknowledgement is retained until positive ownership proof', async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const thread = s.f.threads.get(A);
    const turn = { id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'u', clientId: q.params.clientUserMessageId }] };
    thread.turns.push(turn); thread.status.type = 'active';
    socket.send(JSON.stringify({ id: 'early-question', method: 'item/tool/requestUserInput', params: {
      threadId: A, turnId: T, itemId: 'q', questions: [{ id: 'choice', header: 'Intent', question: 'Which option?', options: [{ label: 'First', description: 'First option' }] }] } }));
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  assert.equal((await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Ask a question' })).phase, 'accepted');
  const listed = await s.c.call('codex_chat_questions', { threadId: A });
  assert.equal(listed.questions.length, 1); assert.equal(s.c.deferredRequests.size, 0);
  const answer = await s.c.call('codex_chat_answer', { requestId: randomUUID(), threadId: A,
    questionRef: listed.questions[0].questionRef, answers: { choice: ['First'] } });
  assert.equal(answer.phase, 'answeredUnconfirmed');
});
test('mismatched steering acknowledgement never grants ownership or stop authority', async t => {
  const s = await setup(t);
  await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Owned first turn' });
  s.f.handle = (socket, q) => {
    if (q.method === 'turn/steer') { socket.send(JSON.stringify({ id: q.id, result: { turnId: 'unrelated-ui-turn' } })); return true; }
  };
  const result = await s.c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, expectedTurnId: T, text: 'Steer owned work' });
  assert.equal(result.phase, 'unknown'); assert.equal(result.code, 'UNEXPECTED_NATIVE_TURN');
  await assert.rejects(s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: 'unrelated-ui-turn' }), { code: 'TURN_NOT_OWNED' });
  assert.equal(s.f.calls.some(q => q.method === 'turn/interrupt'), false);
});
test('controller startup persistence failure releases the writer lock', async t => {
  const { Store } = await import('../src/stage1/store.mjs');
  const f = await fixture(t); const options = { root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' };
  const update = Store.prototype.update;
  try {
    Store.prototype.update = async () => { throw new Error('Synthetic startup failure'); };
    await assert.rejects(Controller.open(options), /Synthetic startup failure/);
  } finally { Store.prototype.update = update; }
  const c = await Controller.open(options); t.after(() => c.close());
  assert.equal((await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'After failed startup' })).phase, 'accepted');
});
test('deferred question IDs cannot be erased or overwritten across enrolled threads', async t => {
  const s = await setup(t); const second = '55555555-5555-4555-8555-555555555555';
  s.f.threads.set(second, s.f.thread(second));
  await s.c.store.update(state => {
    state.threads[second] = { cwd: s.f.cwd };
    state.operations[B] = { kind: 'send', phase: 'dispatching', threadId: A };
    state.operations[randomUUID()] = { kind: 'send', phase: 'dispatching', threadId: second };
  });
  const event = threadId => ({ method: 'item/tool/requestUserInput', id: 'same-id', epoch: s.c.native.epoch,
    params: { threadId, turnId: T, questions: [{ id: 'choice', question: 'Early question' }] } });
  s.c.event(event(A)); s.c.event(event(second)); assert.equal(s.c.deferredRequests.size, 2);
  s.c.event({ method: 'serverRequest/resolved', epoch: s.c.native.epoch, params: { threadId: second, requestId: 'same-id' } });
  assert.equal(s.c.deferredRequests.size, 1); assert.equal([...s.c.deferredRequests.values()][0].params.threadId, A);
});
test('oversized ordinary questions remain readable through bounded continuation', async t => {
  const s = await setup(t); await s.c.call('codex_chat_send', { requestId: B, threadId: A, text: 'Ask' });
  const questions = Array.from({ length: 5 }, (_, i) => ({ id: 'choice' + i, header: 'Intent',
    question: i === 0 ? 'Use password=secret' : '界'.repeat(1200),
    options: Array.from({ length: 4 }, () => ({ label: '界'.repeat(200), description: 'Choose "quoted" \\ path token=secret ' + '界'.repeat(250) })) }));
  for (let i = 0; i < 12; i++) s.c.event({ method: 'item/tool/requestUserInput', id: 'request-' + i,
    epoch: s.c.native.epoch, params: { threadId: A, turnId: T, questions } });
  const listed = await s.c.call('codex_chat_questions', { threadId: A });
  assert.equal(listed.questionCount, 12); assert.ok(listed.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 32768);
  const first = listed.questions[0]; assert.equal(first.truncated, true);
  let cursor = first.detailsCursor, text = '', pages = 0;
  do {
    const page = await s.c.call('codex_chat_questions', { threadId: A, cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 32768);
    text += page.details.map(x => x.text).join(''); cursor = page.nextCursor; pages++;
  } while (cursor);
  assert.ok(pages > 1);
  const parsed = JSON.parse(text);
  assert.equal(parsed[0].question, 'Use password=[REDACTED]');
  assert.equal(parsed[1].question, '界'.repeat(1200));
  assert.ok(parsed[0].options[0].description.includes('"quoted" \\ path token=[REDACTED]'));
  assert.equal(text.includes('secret'), false);
});
