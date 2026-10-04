import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

test('legacy expired windows and counters are preserved but never stop or gate delivery', async t => {
  const f = await fixture(t); let clock = Date.now();
  const options = { root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Migration fixture' });
  const windowId = randomUUID();
  await c.store.update(s => {
    s.liveTurns = 100000;
    s.taskWindows[windowId] = { threadId: A, startedAt: clock - 2000, deadlineAt: clock - 1000, confirmUserApproval: true, approvalRef: 'Historical record' };
    s.threads[A].windowId = windowId;
  });
  const before = structuredClone(c.store.state.taskWindows);
  const args = { requestId: randomUUID(), threadId: A, text: 'Native workflow', windowId };
  assert.equal((await c.call('codex_chat_send', args)).phase, 'accepted');
  clock += 86400000; await c.close(); c = await Controller.open(options);
  assert.deepEqual(c.store.state.taskWindows, before);
  const status = await c.call('codex_chat_status', { threadId: A });
  assert.equal(status.legacyWindowsEnforced, false); assert.equal(status.operations[0].deadlineEnforcement, 'disabled');
  assert.equal(status.turn.status, 'inProgress'); assert.equal(f.calls.some(q => q.method === 'turn/interrupt'), false);
  assert.equal((await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, expectedTurnId: T, text: 'Steer later' })).phase, 'accepted');
});
test('native goal is visible without connector blocking normal scoping messages', async t => {
  const f = await fixture(t); const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Goal fixture' });
  f.goal = { status: 'blocked', objective: 'Unfinished prior work' };
  assert.equal((await c.call('codex_chat_status', { threadId: A })).admission.nativeGoal.status, 'blocked');
  assert.equal((await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Discuss next work' })).phase, 'accepted');
  assert.deepEqual(f.goal, { status: 'blocked', objective: 'Unfinished prior work' });
});
test('unloaded admission loads only through the send path and inventories before dispatch', async t => {
  const f = await fixture(t); const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Unloaded fixture' });
  f.threads.get(A).status.type = 'notLoaded';
  f.handle = (socket, q) => {
    if (q.method === 'thread/backgroundTerminals/list' && f.threads.get(A).status.type === 'notLoaded') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'thread not found' } })); return true;
    }
    if (q.method === 'thread/resume') f.threads.get(A).status.type = 'idle';
  };
  const status = await c.call('codex_chat_status', { threadId: A });
  assert.equal(status.terminalInventoryComplete, false); assert.equal(status.admission.newStart, 'resumeThenPreflightRequired'); assert.equal(f.calls.some(q => q.method === 'thread/resume'), false);
  assert.equal((await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'First request' })).phase, 'accepted');
  const resume = f.calls.findIndex(q => q.method === 'thread/resume');
  const inventory = f.calls.findIndex((q, i) => i > resume && q.method === 'thread/backgroundTerminals/list');
  const start = f.calls.findIndex(q => q.method === 'turn/start'); assert.ok(resume < inventory && inventory < start);
});
