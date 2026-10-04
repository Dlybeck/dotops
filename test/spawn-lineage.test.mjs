import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
const CHILD = '55555555-5555-4555-8555-555555555555';
async function setup(t, expanded = false) {
  const f = await fixture(t);
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', accessMode: expanded ? 'user-directories' : 'stage1' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Ordinary native spawn' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Synthetic fixture', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A);
  root.turns[0].status = 'completed'; root.status = { type: 'idle' };
  root.turns[0].items.push({ type: 'collabAgentToolCall', id: 'native-spawn', receiverThreadIds: [CHILD] });
  const child = f.thread(CHILD);
  Object.assign(child, { sessionId: CHILD, parentThreadId: A, forkedFromId: null,
    turns: [{ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] }] });
  f.threads.set(CHILD, child);
  return { f, c, root, child };
}
test('ordinary native-spawn child with independent session permits continuation without another model turn', async t => {
  const s = await setup(t);
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.children, 'verifiedCompleted');
  assert.equal(status.admission.newStart, 'preflightRequired');
  assert.equal(status.admission.descendantInventory.count, 1);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && /resume|start|steer|interrupt|terminate|goal\/(set|clear)/.test(q.method)), false);
});

test('expanded root blocked goal is preserved for admission without acquiring its external continuation', async t => {
  const s = await setup(t, true);
  s.root.turns[0].itemsView = 'full';
  s.root.turns[0].items.pop();
  s.root.turns[0].items.push({ type: 'subAgentActivity', id: 'launch', kind: 'started', agentThreadId: CHILD },
    { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: CHILD });
  const goal = { objective: 'Retain blocked work', status: 'blocked', tokenBudget: 12345 };
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/goal/get' || q.params.threadId !== A) return;
    socket.send(JSON.stringify({ id: q.id, result: { goal } })); return true;
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.children, 'verifiedCompleted');
  assert.equal(status.admission.newStart, 'preflightRequired');
  assert.equal(status.admission.nativeGoal.status, 'blocked');
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.children, 'verifiedCompleted');
  assert.equal(stopped.goalContinuationStopped, true);
  assert.equal(stopped.verifiedStopped, true);
  assert.equal(goal.status, 'blocked');
  assert.equal(s.f.calls.some(q => /thread\/goal\/(set|clear)/.test(q.method)), false);
});
for (const state of ['invalid-session', 'unloaded', 'unavailable-process-inventory', 'descendant-blocked-goal', 'root-goal-unavailable', 'session-race']) test(`ordinary spawn still blocks ${state}`, async t => {
  const s = await setup(t); let reads = 0;
  if (state === 'invalid-session') s.child.sessionId = null;
  if (state === 'unloaded') s.child.status = { type: 'notLoaded' };
  s.f.handle = (socket, q) => {
    if (state === 'session-race' && q.method === 'thread/read' && q.params.threadId === CHILD && ++reads === 2) s.child.sessionId = R;
    if ((state === 'unavailable-process-inventory' && q.method === 'thread/backgroundTerminals/list' && q.params.threadId === CHILD) ||
      (state === 'root-goal-unavailable' && q.method === 'thread/goal/get' && q.params.threadId === A)) {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Inventory unavailable' } })); return true;
    }
    if (state === 'descendant-blocked-goal' && q.method === 'thread/goal/get' && q.params.threadId === CHILD) {
      socket.send(JSON.stringify({ id: q.id, result: { goal: { objective: 'Retain child work', status: 'blocked' } } })); return true;
    }
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.children, 'unverified');
  assert.equal(status.admission.newStart, 'blocked');
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && /resume|start|steer|interrupt|terminate|goal\/(set|clear)/.test(q.method)), false);
});
