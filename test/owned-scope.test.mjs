import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
const CHILD = '55555555-5555-4555-8555-555555555555';
async function setup(t) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Operation scope' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Owned', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; turn.status = 'completed'; turn.itemsView = 'full';
  f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const next = { id: randomUUID(), status: 'inProgress', itemsView: 'full', items: [{ type: 'userMessage', id: 'next', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    root.turns.push(next); root.status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn: next } })); return true;
  };
  return { f, root, turn, get c() { return c; },
    async restart() { await c.close(); c = await Controller.open(options); },
    send: () => c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Next', expectedLastTurnId: root.turns.at(-1).id, acknowledgeConcurrentStartRisk: true }) };
}
test('closed owned operation admits after reconnect without reopening unloaded historical descendants', async t => {
  const s = await setup(t);
  s.turn.items.push({ type: 'subAgentActivity', id: 'launch', kind: 'started', agentThreadId: CHILD },
    { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: CHILD });
  const child = s.f.thread(CHILD); child.parentThreadId = A; child.status = { type: 'notLoaded' }; s.f.threads.set(CHILD, child);
  await s.c.call('codex_chat_status', { threadId: A }); await s.restart();
  const begin = s.f.calls.length;
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.slice(begin).some(q => q.params?.threadId === CHILD || q.method === 'thread/list'), false);
});
test('manual current work blocks target admission while earlier own-stop remains proved', async t => {
  const s = await setup(t);
  await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  const manual = randomUUID(); s.root.turns.push({ id: manual, status: 'inProgress', itemsView: 'full', items: [] }); s.root.status = { type: 'active' };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.stopVerification.verifiedStopped, true);
  assert.equal(status.stopVerification.targetBusy, true);
  assert.equal(status.admission.newStart, 'blocked');
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[manual], undefined);
});

for (const variant of ['live', 'unavailable', 'null', 'conflict']) test(`named owned process blocks admission and survives restart: ${variant}`, async t => {
  const s = await setup(t);
  const command = { type: 'commandExecution', id: 'owned-command', processId: variant === 'null' ? null : '42', status: 'inProgress', exitCode: null };
  s.turn.items.push(command);
  s.f.terminals = variant === 'live' ? [{ itemId: command.id, processId: '42', cwd: s.f.cwd }]
    : variant === 'conflict' ? [{ itemId: command.id, processId: '99', cwd: s.f.cwd }] : [];
  if (variant === 'unavailable') {
    const handle = s.f.handle;
    s.f.handle = (socket, q) => {
      if (q.method === 'thread/backgroundTerminals/list') { socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Unavailable' } })); return true; }
      return handle(socket, q);
    };
  }
  const first = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(first.admission.newStart, 'blocked');
  const process = first.admission.ownedProcesses.items.find(item => item.itemId === command.id);
  assert.equal(process.state, variant === 'live' ? 'live' : 'unknown');
  assert.ok(process.reason);
  await s.restart();
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => q.method === 'thread/backgroundTerminals/terminate'), false);
});

test('ambiguous native interacted operation stays named and grants no child interrupt or adoption', async t => {
  const s = await setup(t);
  s.turn.items.push({ type: 'subAgentActivity', id: 'ambiguous', kind: 'interacted', agentThreadId: CHILD });
  const child = s.f.thread(CHILD); child.parentThreadId = A; child.status = { type: 'active' }; s.f.threads.set(CHILD, child);
  const result = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(result.verifiedStopped, false);
  assert.equal(result.ownedDelegations.items[0].reason, 'AMBIGUOUS_INTERACTED_DELEGATION');
  assert.equal(result.ownedDelegations.items[0].childStopAuthorized, false);
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD), false);
  assert.deepEqual(Object.keys(s.c.store.state.threads), [A]);
});

test('later manual tracked process is unrelated to an exited owned command', async t => {
  const s = await setup(t);
  s.turn.items.push({ type: 'commandExecution', id: 'old-command', processId: '42', status: 'completed', exitCode: 0 });
  s.f.terminals = [{ itemId: 'new-manual', processId: '42', cwd: s.f.cwd }];
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, true); assert.equal(stopped.unrelatedTerminals, 1);
  assert.equal(s.f.calls.some(q => q.method === 'thread/backgroundTerminals/terminate'), false);
  assert.equal((await s.send()).phase, 'accepted');
});

for (const boundary of ['transaction', 'first-recheck', 'final-recheck', 'connection']) test(`send blocks newly observed owned obligations at ${boundary}`, async t => {
  const s = await setup(t), request = s.c.native.request.bind(s.c.native); let injected = false, proofs = 0, finalReads = 0;
  const inject = async () => { injected = true; await s.c.store.update(state => {
    const record = state.threads[A].ownedObligations.turns[T];
    record.items.race = { type: 'commandExecution', id: 'race', processId: null, status: 'inProgress', exitCode: null };
    record.observedOrder.push('race'); record.fullItemsObserved = false;
  }); };
  s.c.native.request = async (method, params, options) => {
    if (method === 'thread/backgroundTerminals/list') proofs++;
    const result = await request(method, params, options);
    if (method === 'thread/read' && proofs === 2) finalReads++;
    if (!injected && (boundary === 'transaction' && method === 'thread/turns/list' && proofs === 1 ||
        boundary === 'first-recheck' && method === 'thread/backgroundTerminals/list' && proofs === 2 ||
        boundary === 'final-recheck' && finalReads === 2)) await inject();
    if (!injected && boundary === 'connection' && finalReads === 2) { injected = true; s.c.native.drop(s.c.native.socket); }
    return result;
  };
  let result;
  try { result = await s.send(); } catch (error) { assert.equal(error.code, 'PREVIOUS_WORK_UNVERIFIED'); }
  assert.equal(injected, true);
  if (result) assert.equal(result.phase, 'notDispatched');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('final send recheck sees an exact live process appearing after initial send recheck', async t => {
  const s = await setup(t), request = s.c.native.request.bind(s.c.native); let inventories = 0, injected = false;
  s.turn.items.push({ type: 'commandExecution', id: 'old-command', processId: '42', status: 'completed', exitCode: 0 });
  s.c.native.request = async (method, params, options) => {
    const result = await request(method, params, options);
    if (method === 'thread/backgroundTerminals/list') inventories++;
    if (!injected && inventories === 2 && method === 'thread/read') {
      injected = true; s.f.terminals = [{ itemId: 'old-command', processId: '42', cwd: s.f.cwd }];
    }
    return result;
  };
  const result = await s.send();
  assert.equal(injected, true); assert.equal(result.phase, 'notDispatched');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('legacy exact-turn repair keeps known command handles when bounded history has moved on', async t => {
  const s = await setup(t);
  await s.c.store.update(state => {
    const record = state.threads[A]; delete record.ownedObligations;
    record.terminalTurns = { [T]: { id: T, status: 'completed', items: [{ type: 'commandExecution', id: 'legacy-command', processId: '42' }] } };
    record.commandItems = { 'legacy-command': { turnId: T, processId: '42' } };
  });
  s.root.turns = [{ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] }];
  const handle = s.f.handle;
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return handle(socket, q);
    assert.equal(q.params.turnId, T);
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T,
      item: { type: 'commandExecution', id: 'legacy-command', processId: '42', status: 'inProgress', exitCode: null } }], nextCursor: null } })); return true;
  };
  s.f.terminals = [{ itemId: 'legacy-command', processId: '42', cwd: s.f.cwd }];
  let status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.ownedProcesses.items[0].state, 'live');
  assert.equal(status.admission.newStart, 'blocked');
  await s.restart(); s.f.terminals = [];
  status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.newStart, 'preflightRequired');
  assert.equal(s.c.store.state.threads[A].ownedObligations.turns[T].items['legacy-command'].processId, '42');
});

test('connector goal continuation is independently blocking until native pause, without changing goal policy', async t => {
  const s = await setup(t);
  let status = await s.c.call('codex_chat_status', { threadId: A });
  await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash,
    action: 'set', objective: 'Owned continuation' });
  // Native fixture only applies requested fields; real set returns an active goal.
  s.f.goal.status = 'active';
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.turnTerminal, true); assert.equal(stopped.verifiedStopped, false);
  assert.equal(stopped.ownedContinuations.open, 1);
  assert.equal(s.f.goal.status, 'active');
  s.f.goal.status = 'paused'; await s.restart();
  status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.stopVerification.verifiedStopped, true);
});

test('manual queue is target policy rather than earlier owned stop failure', async t => {
  const s = await setup(t);
  s.f.queue = [{ id: 'manual-queue', clientUserMessageId: randomUUID() }];
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, true);
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.ok(status.admission.reasons.includes('UNMANAGED_QUEUE'));
  await assert.rejects(s.send(), { code: 'UNMANAGED_QUEUE' });
});

test('accepted goal pause with unconfirmed observation cannot discard earlier owned continuation', async t => {
  const s = await setup(t);
  let status = await s.c.call('codex_chat_status', { threadId: A });
  await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'set', objective: 'Owned continuation' });
  s.f.goal.status = 'active';
  status = await s.c.call('codex_chat_status', { threadId: A });
  const handle = s.f.handle;
  s.f.handle = (socket, q) => {
    if (q.method === 'thread/goal/set' && q.params.status === 'paused') { socket.send(JSON.stringify({ id: q.id, result: {} })); return true; }
    return handle(socket, q);
  };
  const pause = await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'pause' });
  assert.equal(pause.phase, 'accepted'); assert.equal(pause.observedDesiredState, false);
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, false); assert.equal(stopped.ownedContinuations.open, 1);
});

test('unresolved later send is a named owned uncertainty even when earlier turn is stopped', async t => {
  const s = await setup(t), requestId = randomUUID();
  await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  await s.c.store.update(state => { state.operations[requestId] = { kind: 'send', phase: 'unknown', threadId: A }; });
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.stopVerification.verifiedStopped, false);
  assert.ok(status.stopVerification.unknownOwnedObligations.items.some(item => item.requestId === requestId && item.reason === 'SEND_OWNERSHIP_UNRESOLVED'));
});

test('goal ownership fingerprint survives reconnect and confirmed closure does not acquire manual reactivation', async t => {
  const s = await setup(t);
  let status = await s.c.call('codex_chat_status', { threadId: A });
  await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'set', objective: 'Owned goal' });
  s.f.goal.status = 'active';
  await s.restart(); status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.ownedContinuations.items[0].reason, 'OWNED_GOAL_CONTINUATION_OPEN');
  const pause = await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'pause' });
  assert.equal(pause.observedDesiredState, true);
  s.f.goal.status = 'active'; // Later owner-native reactivation, after confirmed closure.
  await s.restart();
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.verifiedStopped, true); assert.equal(s.f.goal.status, 'active');
});

test('running full snapshot plus terminal event repairs the exact old turn after bounded history eviction', async t => {
  const s = await setup(t);
  await s.c.store.update(state => { state.threads[A].ownedObligations = { version: 1, turns: { [T]: {
    modelStatus: 'inProgress', items: {}, observedOrder: [], historyOrder: [], fullItemsObserved: true
  } } }; });
  const eventDone = new Promise(resolve => s.c.native.once('event', resolve));
  s.f.notify('turn/completed', { threadId: A, turn: { id: T, status: 'completed' } });
  await eventDone; await s.c.store.tail;
  s.root.turns = [{ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] }];
  let repairs = 0; const handle = s.f.handle;
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return handle(socket, q);
    repairs++; assert.equal(q.params.turnId, T);
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T,
      item: { type: 'commandExecution', id: 'hidden-command', processId: '42', status: 'inProgress' } }], nextCursor: null } })); return true;
  };
  s.f.terminals = [{ itemId: 'hidden-command', processId: '42', cwd: s.f.cwd }];
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(repairs, 1); assert.equal(status.admission.newStart, 'blocked');
  assert.equal(status.admission.ownedProcesses.items[0].state, 'live');
});

test('missing native process inventory cursor cannot prove a retained handle absent', async t => {
  const s = await setup(t), handle = s.f.handle;
  s.turn.items.push({ type: 'commandExecution', id: 'owned-command', processId: '42', status: 'inProgress' });
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/backgroundTerminals/list') return handle(socket, q);
    socket.send(JSON.stringify({ id: q.id, result: { data: [] } })); return true;
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.newStart, 'blocked');
  assert.equal(status.admission.ownedProcesses.items[0].reason, 'OWNED_PROCESS_UNVERIFIED');
});

test('native event exit omitted by legacy full transcript survives reconnect and admits without item RPC', async t => {
  const s = await setup(t);
  const item = { type: 'commandExecution', id: 'event-only', processId: '42', status: 'completed', exitCode: 0 };
  const { once } = await import('node:events');
  const received = once(s.c.native, 'event');
  s.f.notify('item/completed', { threadId: A, turnId: T, item });
  await received; await s.c.store.tail;
  await s.c.call('codex_chat_status', { threadId: A });
  await s.restart();
  const old = s.f.handle;
  s.f.handle = (socket, q) => {
    if (q.method === 'thread/items/list') { socket.send(JSON.stringify({ id: q.id, error: { code: -32601, message: 'unsupported' } })); return true; }
    return old(socket, q);
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.ownedProcesses.items[0].reason, 'NATIVE_COMMAND_EXIT');
  assert.equal(status.admission.newStart, 'preflightRequired');
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.some(q => q.method === 'thread/backgroundTerminals/terminate'), false);
});
