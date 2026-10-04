// Legacy Stage1 tree/attachment safeguards. Expanded operation scope is tested in owned-scope.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { Native } from '../src/stage1/native.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
const CHILD = '55555555-5555-4555-8555-555555555555';
const SECOND = '66666666-6666-4666-8666-666666666666';
async function setup(t, expanded = false) {
  const f = await fixture(t), subscriptions = new Map(); let c;
  const options = { root: f.root, accessMode: expanded ? 'user-directories' : 'stage1', socketPath: f.socket, stateDir: f.dir + '/state' };
  f.handle = (socket, q) => {
    const id = q.params?.threadId;
    if (q.method === 'thread/start' || q.method === 'thread/resume') {
      if (!subscriptions.has(socket)) {
        subscriptions.set(socket, new Set());
        socket.once('close', () => {
          const ids = subscriptions.get(socket); subscriptions.delete(socket);
          for (const id of ids) if (![...subscriptions.values()].some(set => set.has(id))) f.threads.get(id).status = { type: 'notLoaded' };
        });
      }
      subscriptions.get(socket).add(id ?? A);
      if (q.method === 'thread/resume' && f.threads.has(id)) f.threads.get(id).status = { type: 'idle' };
    }
    if (q.method === 'thread/backgroundTerminals/list' && f.threads.get(id)?.status.type === 'notLoaded') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Thread is not loaded' } })); return true;
    }
    if (q.method === 'turn/start' && f.threads.get(A)?.turns.length) {
      const turn = { id: randomUUID(), status: 'inProgress', items: [{ type: 'userMessage', id: 'next-user', clientId: q.params.clientUserMessageId, content: q.params.input }] };
      f.threads.get(A).turns.push(turn); f.threads.get(A).status = { type: 'active' };
      socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
    }
    if (f.extraHandle) return f.extraHandle(socket, q);
  };
  c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Unload lifecycle' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Synthetic initial work', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A); root.status = { type: 'idle' }; root.turns[0].status = 'completed';
  root.turns[0].items.push({ type: 'collabAgentToolCall', id: 'reviewers', receiverThreadIds: [CHILD, SECOND] });
  if (expanded) {
    root.turns[0].itemsView = 'full';
    root.turns[0].items.pop();
    for (const id of [CHILD, SECOND]) root.turns[0].items.push(
      { type: 'subAgentActivity', id: 'launch-' + id, kind: 'started', agentThreadId: id },
      { type: 'subAgentActivity', id: 'done-' + id, kind: 'completed', agentThreadId: id });
  }
  for (const id of [CHILD, SECOND]) {
    const child = f.thread(id);
    Object.assign(child, { parentThreadId: A, forkedFromId: null, sessionId: id, status: { type: 'notLoaded' },
      turns: [{ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] }] });
    f.threads.set(id, child);
  }
  return { f, root, get c() { return c; }, async reconnect() { await c.close(); await new Promise(r => setTimeout(r, 10)); c = await Controller.open(options); },
    send: () => c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Synthetic next request', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }) };
}
test('native unloaded subagent refusal identifies the blocked descendant without granting work or process proof', async t => {
  const s = await setup(t);
  s.f.extraHandle = (socket, q) => {
    if (q.method !== 'thread/resume' || q.params.threadId !== CHILD) return;
    s.f.threads.get(CHILD).status = { type: 'notLoaded' };
    socket.send(JSON.stringify({ id: q.id, error: { code: -32600,
      message: 'cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it' } }));
    return true;
  };
  const requestId = randomUUID();
  const result = await s.c.call('codex_chat_reconcile', { requestId, threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.equal(result.code, 'NATIVE_SUBAGENT_RESUME_UNAVAILABLE');
  assert.equal(result.blockedDescendantId, CHILD);
  assert.equal(result.recovery.kind, 'nativeCapabilityBlocked');
  assert.equal(result.recovery.terminalInventoryVerified, false);
  assert.equal(result.recovery.automaticRetryRecommended, false);
  assert.equal(result.modelTurnStarted, false);
  assert.equal(result.goalChanged, false);
  assert.deepEqual(await s.c.call('codex_chat_reconcile', { requestId, threadId: A }), result);
  const admission = (await s.c.call('codex_chat_status', { threadId: A })).admission;
  assert.equal(admission.children, 'unverified');
  assert.equal(admission.runtimeProof.durableUnloadedChildClosureAvailable, false);
  assert.equal(admission.runtimeProof.childObservation, 'unverified');
  assert.equal(admission.runtimeProof.authorizesStart, false);
  assert.equal(admission.startGuarantee, 'nonAtomicPreflight');
  await assert.rejects(s.send(), { code: 'NATIVE_SUBAGENT_RESUME_UNAVAILABLE' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => /turn\/(steer|interrupt)|terminate|goal\/(set|clear)/.test(q.method)), false);
});
for (const variant of ['other-message', 'message-suffix', 'other-code']) test(`unrelated native resume rejection stays unclassified: ${variant}`, async t => {
  const s = await setup(t);
  s.f.extraHandle = (socket, q) => {
    if (q.method !== 'thread/resume' || q.params.threadId !== CHILD) return;
    s.f.threads.get(CHILD).status = { type: 'notLoaded' };
    const known = 'cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it';
    socket.send(JSON.stringify({ id: q.id, error: { code: variant === 'other-code' ? -32000 : -32600,
      message: variant === 'other-message' ? 'private-backend-detail' : known + (variant === 'message-suffix' ? ' private-backend-detail' : ''),
      data: { private: 'private-backend-detail' } } }));
    return true;
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.equal(result.code, 'BACKEND_REJECTED');
  assert.equal(result.blockedDescendantId, undefined);
  assert.equal(result.recovery, undefined);
  assert.equal(JSON.stringify(result).includes('private-backend-detail'), false);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
test('the unloaded subagent refusal text on a different RPC supplies no resume classification', async t => {
  const f = await fixture(t), native = new Native({ socketPath: f.socket });
  t.after(() => native.close());
  f.handle = (socket, q) => {
    if (q.method !== 'thread/read') return;
    socket.send(JSON.stringify({ id: q.id, error: { code: -32600,
      message: 'cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it' } }));
    return true;
  };
  await assert.rejects(native.request('thread/read', { threadId: A, includeTurns: false }), error =>
    error.code === 'BACKEND_REJECTED' && error.nativeRejection.reason === 'unclassified');
});
test('authorized send reattaches unloaded completed reviewers and verifies live process inventories before dispatch', async t => {
  const s = await setup(t), histories = [CHILD, SECOND].map(id => structuredClone(s.f.threads.get(id).turns));
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.children, 'unverified');
  assert.equal(s.f.calls.some(q => q.method === 'thread/resume' && q.params.threadId !== A), false);
  const result = await s.send();
  assert.equal(result.phase, 'accepted');
  assert.deepEqual([CHILD, SECOND].map(id => s.f.threads.get(id).turns), histories);
  assert.deepEqual(s.f.calls.filter(q => q.method === 'thread/resume' && q.params.threadId !== A).map(q => q.params),
    [CHILD, SECOND].map(threadId => ({ threadId, excludeTurns: true })));
  const lastStart = s.f.calls.findLastIndex(q => q.method === 'turn/start');
  for (const id of [CHILD, SECOND]) assert.ok(s.f.calls.slice(0, lastStart).some(q => q.method === 'thread/backgroundTerminals/list' && q.params.threadId === id));
  assert.equal(s.f.calls.some(q => q.params?.threadId !== A && /turn\/(start|steer|interrupt)|terminate|goal\/(set|clear)/.test(q.method)), false);
});
test('explicit reconciliation recovers after subscribers close and controller reconnects, without sending a message', async t => {
  const s = await setup(t), original = structuredClone([...s.f.threads.values()].map(x => ({ id: x.id, turns: x.turns })));
  const reconcile = () => s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  const first = await reconcile();
  assert.equal(first.phase, 'verified');
  assert.equal(first.modelTurnStarted, false);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'verifiedCompleted');
  await s.reconnect();
  assert.equal(s.f.threads.get(CHILD).status.type, 'notLoaded');
  assert.equal(s.f.threads.get(SECOND).status.type, 'notLoaded');
  const statusCalls = s.f.calls.length;
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'unverified');
  assert.equal(s.f.calls.slice(statusCalls).some(q => q.method === 'thread/resume'), false);
  assert.equal((await reconcile()).phase, 'verified');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'verifiedCompleted');
  assert.deepEqual([...s.f.threads.values()].map(x => ({ id: x.id, turns: x.turns })), original);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.deepEqual(Object.keys(s.c.store.state.threads), [A]);
});
for (const boundary of ['between joins', 'during final proof']) test(`reconciliation rejects connection changes ${boundary} even while diagnostics keep reviewers loaded`, async t => {
  const s = await setup(t), diagnostic = new Native({ socketPath: s.f.socket });
  t.after(() => diagnostic.close());
  for (const threadId of [A, CHILD, SECOND]) await diagnostic.request('thread/resume', { threadId, excludeTurns: true });
  const request = s.c.native.request.bind(s.c.native); let firstJoined = false, dropped = false;
  s.c.native.request = async (method, params, options) => {
    if (boundary === 'between joins' && firstJoined && !dropped && params.threadId === SECOND) {
      dropped = true; s.c.native.drop(s.c.native.socket);
    }
    const result = await request(method, params, options);
    if (method === 'thread/resume' && params.threadId === CHILD) firstJoined = true;
    return result;
  };
  if (boundary === 'during final proof') {
    const preflight = s.c.preflight.bind(s.c);
    s.c.preflight = async (...args) => { dropped = true; s.c.native.drop(s.c.native.socket); return preflight(...args); };
  }
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(dropped, true);
  assert.equal(result.phase, 'unverified');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
test('reconciliation joins already loaded reviewers on its own connection before diagnostic subscribers leave', async t => {
  const s = await setup(t), diagnostic = new Native({ socketPath: s.f.socket });
  t.after(() => diagnostic.close());
  for (const threadId of [CHILD, SECOND]) await diagnostic.request('thread/resume', { threadId, excludeTurns: true });
  await s.reconnect();
  assert.equal(s.f.threads.get(CHILD).status.type, 'idle');
  const begin = s.f.calls.length;
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'verified');
  assert.deepEqual(s.f.calls.slice(begin).filter(q => q.method === 'thread/resume' && q.params.threadId !== A).map(q => q.params.threadId), [CHILD, SECOND]);
  diagnostic.close(); await new Promise(r => setTimeout(r, 10));
  for (const id of [CHILD, SECOND]) assert.equal(s.f.threads.get(id).status.type, 'idle');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'verifiedCompleted');
  const joined = s.f.calls.length;
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  assert.equal(s.f.calls.slice(joined).some(q => q.method === 'thread/resume' && q.params.threadId !== A), false);
  await s.reconnect();
  for (const id of [CHILD, SECOND]) assert.equal(s.f.threads.get(id).status.type, 'notLoaded');
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
for (const state of ['active', 'invalid-session', 'wrong-cwd', 'missing-history', 'incomplete-history', 'blocked-goal', 'pending-queue', 'process-after-resume', 'inventory-unavailable-after-resume', 'history-after-resume', 'goal-after-resume', 'queue-after-resume', 'lineage-race', 'resume-disconnect']) test(`reconciliation keeps ${state} blocked without model or child-work control`, async t => {
  const s = await setup(t), child = s.f.threads.get(CHILD); let resumed = false, reads = 0;
  if (state === 'active') { child.status = { type: 'active' }; child.turns[0].status = 'inProgress'; }
  if (state === 'invalid-session') child.sessionId = null;
  if (state === 'wrong-cwd') child.cwd = '/tmp';
  if (state === 'missing-history') child.turns = [];
  s.f.extraHandle = (socket, q) => {
    const id = q.params?.threadId;
    if (id !== CHILD) return;
    if (q.method === 'thread/read' && state === 'lineage-race' && ++reads === 2) child.parentThreadId = SECOND;
    if (q.method === 'thread/resume') {
      resumed = true;
      if (state === 'history-after-resume') child.turns.push({ id: randomUUID(), status: 'completed', itemsView: 'full', items: [] });
      if (state === 'resume-disconnect') { s.f.disconnect(); return true; }
    }
    let result;
    if (state === 'incomplete-history' && q.method === 'thread/turns/list') result = { data: child.turns, nextCursor: 'more' };
    if ((state === 'blocked-goal' || state === 'goal-after-resume' && resumed) && q.method === 'thread/goal/get') result = { goal: { objective: 'Preserve real child goal', status: 'blocked' } };
    if ((state === 'pending-queue' || state === 'queue-after-resume' && resumed) && q.method === 'thread/queue/list') result = { data: [{}], nextCursor: null };
    if (state === 'process-after-resume' && resumed && q.method === 'thread/backgroundTerminals/list') result = { data: [{ itemId: 'child-command', processId: 'child-process', cwd: s.f.cwd }], nextCursor: null };
    if (state === 'inventory-unavailable-after-resume' && resumed && q.method === 'thread/backgroundTerminals/list') {
      socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Inventory unavailable' } })); return true;
    }
    if (result) { socket.send(JSON.stringify({ id: q.id, result })); return true; }
  };
  const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
  assert.equal(result.phase, 'unverified');
  assert.equal(result.modelTurnStarted, false);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => /goal\/(set|clear)|terminate|turn\/(steer|interrupt)/.test(q.method)), false);
  if (['active', 'invalid-session', 'wrong-cwd', 'missing-history', 'incomplete-history', 'blocked-goal', 'pending-queue'].includes(state)) assert.equal(resumed, false);
  assert.deepEqual(Object.keys(s.c.store.state.threads), [A]);
});
test('blocked root and paused child goals remain intact; reconciliation receipts grant no old-turn ownership', async t => {
  const s = await setup(t, true);
  const rootGoal = { objective: 'Keep expired engineering goal', status: 'blocked', tokenBudget: null, tokensUsed: 321 };
  const childGoal = { objective: 'Keep paused reviewer objective', status: 'paused', tokenBudget: 123, tokensUsed: 42 };
  s.f.extraHandle = (socket, q) => {
    if (q.method !== 'thread/goal/get') return;
    socket.send(JSON.stringify({ id: q.id, result: { goal: q.params.threadId === A ? rootGoal : childGoal } })); return true;
  };
  const args = { requestId: randomUUID(), threadId: A };
  assert.equal((await s.c.call('codex_chat_reconcile', args)).phase, 'verified');
  const resumes = s.f.calls.filter(q => q.method === 'thread/resume').length;
  await s.reconnect();
  assert.equal((await s.c.call('codex_chat_reconcile', args)).phase, 'verified');
  assert.equal(s.f.calls.filter(q => q.method === 'thread/resume').length, resumes);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'verifiedCompleted');
  assert.equal((await s.c.call('codex_chat_reconcile', { ...args, requestId: randomUUID() })).phase, 'verified');
  assert.equal(rootGoal.status, 'blocked'); assert.equal(childGoal.status, 'paused');
  assert.equal(rootGoal.tokensUsed, 321); assert.equal(childGoal.tokensUsed, 42);
  assert.equal(s.f.calls.some(q => /goal\/(set|clear)/.test(q.method)), false);
  await assert.rejects(s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: CHILD, turnId: s.f.threads.get(CHILD).turns[0].id }), { code: 'CHAT_NOT_OWNED' });
});
test('reconciliation cannot target descendants or accept configuration/permission overrides', async t => {
  const s = await setup(t), count = s.f.calls.length;
  await assert.rejects(s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: CHILD }), { code: 'CHAT_NOT_OWNED' });
  await assert.rejects(s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A, cwd: '/tmp', sandbox: 'danger-full-access' }), { code: 'INVALID_INPUT' });
  assert.equal(s.f.calls.length, count);
});

async function listedForkFixture(t, copiedActivity = false) {
  const s = await setup(t), child = s.f.threads.get(CHILD);
  s.root.turns[0].itemsView = 'full';
  Object.assign(child, { forkedFromId: A, sessionId: A, status: { type: 'idle' }, turns: [
    { ...structuredClone(s.root.turns[0]), status: 'interrupted', items: structuredClone(copiedActivity ? s.root.turns[0].items : s.root.turns[0].items.slice(0, 1)) },
    { id: randomUUID(), status: 'completed', itemsView: 'full', items: [{ type: 'agentMessage', id: 'review-result', text: 'Done.' }] },
  ] });
  s.f.threads.get(SECOND).status = { type: 'idle' };
  s.f.extraHandle = (socket, q) => {
    if (q.method !== 'thread/list') return;
    const data = q.params.archived ? [] : [CHILD, SECOND].map(id => ({ ...s.f.threads.get(id), forkedFromId: null }));
    socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor: null } })); return true;
  };
  return s;
}
for (const [reconcileFirst, copiedActivity] of [[true, false], [false, false], [true, true]]) test(`missing DB-only fork admits one next request (reconcile first: ${reconcileFirst}, copied activity: ${copiedActivity})`, async t => {
  const s = await listedForkFixture(t, copiedActivity);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.children, 'verifiedCompleted');
  if (reconcileFirst) assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'verified');
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 2);
  assert.equal(s.f.calls.some(q => /goal\/(set|clear)|terminate|turn\/(steer|interrupt)/.test(q.method)), false);
});

for (const state of ['positive-list-conflict', 'invalid-read-fork', 'read-fork-before-join', 'read-fork-disappears', 'resume-fork-conflict', 'read-fork-after-join']) test(`missing list fork still rejects ${state} without dispatch`, async t => {
  const s = await setup(t), child = s.f.threads.get(CHILD); child.forkedFromId = A;
  let reads = 0, joined = false;
  s.f.extraHandle = (socket, q) => {
    if (q.method === 'thread/list') {
      const data = q.params.archived ? [] : [CHILD, SECOND].map(id => ({ ...s.f.threads.get(id),
        forkedFromId: id === CHILD && state === 'positive-list-conflict' ? SECOND : null }));
      socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor: null } })); return true;
    }
    if (q.params?.threadId !== CHILD) return;
    if (q.method === 'thread/read') {
      reads++;
      if (state === 'invalid-read-fork') child.forkedFromId = 'not-a-native-thread';
      if (state === 'read-fork-before-join' && reads === 2 || state === 'read-fork-after-join' && joined) child.forkedFromId = SECOND;
      if (state === 'read-fork-disappears' && reads === 2) child.forkedFromId = null;
    }
    if (q.method === 'thread/resume') {
      joined = true;
      if (state === 'resume-fork-conflict') child.forkedFromId = SECOND;
    }
  };
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => /goal\/(set|clear)|terminate|turn\/(steer|interrupt)/.test(q.method)), false);
});

for (const defect of ['shared-session mismatch', 'changed inherited prefix']) test(`missing list fork grants no inherited-work exemption with ${defect}`, async t => {
  const s = await listedForkFixture(t, true), child = s.f.threads.get(CHILD);
  if (defect === 'shared-session mismatch') child.sessionId = CHILD;
  else child.turns[0].items[0].content = [{ type: 'text', text: 'Changed copied content' }];
  assert.equal((await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A })).phase, 'unverified');
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => /goal\/(set|clear)|terminate|turn\/(steer|interrupt)/.test(q.method)), false);
});
