import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

const CHILD = '55555555-5555-4555-8555-555555555555';
async function setup(t) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Durable closure fixture' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Synthetic work', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; Object.assign(turn, { status: 'completed', itemsView: 'full' });
  turn.items.push({ type: 'subAgentActivity', id: 'launch', kind: 'started', agentThreadId: CHILD },
    { type: 'subAgentActivity', id: 'completion', kind: 'completed', agentThreadId: CHILD });
  const child = f.thread(CHILD); Object.assign(child, { parentThreadId: A, status: { type: 'notLoaded' }, turns: [] }); f.threads.set(CHILD, child);
  f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const next = { id: randomUUID(), status: 'inProgress', itemsView: 'full', items: [{ type: 'userMessage', id: 'next-user', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    root.turns.push(next); root.status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn: next } })); return true;
  };
  return { f, root, turn, get c() { return c; },
    async restart(transform) {
      await c.close();
      if (transform) {
        const file = options.stateDir + '/state.json', state = JSON.parse(await readFile(file, 'utf8'));
        transform(state); await writeFile(file, JSON.stringify(state), { mode: 0o600 });
      }
      c = await Controller.open(options);
    },
    status: () => c.call('codex_chat_status', { threadId: A }),
    send: () => c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Continue safely', expectedLastTurnId: root.turns.at(-1).id, acknowledgeConcurrentStartRisk: true }) };
}

test('proved exact delegation closure survives omitted native history and restart, allowing continuation', async t => {
  const s = await setup(t);
  assert.equal((await s.status()).admission.unknownOwnedObligations.open, 0);
  s.turn.items = s.turn.items.filter(item => item.type !== 'subAgentActivity');
  await s.restart();
  assert.equal((await s.status()).admission.unknownOwnedObligations.open, 0);
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});

for (const variant of ['missing completion', 'ambiguous launches', 'summary only']) test(`unproved delegation cannot acquire durable closure: ${variant}`, async t => {
  const s = await setup(t);
  if (variant === 'missing completion') s.turn.items.pop();
  if (variant === 'ambiguous launches') s.turn.items.splice(1, 0, { type: 'subAgentActivity', id: 'other-launch', kind: 'started', agentThreadId: CHILD });
  if (variant === 'summary only') s.turn.itemsView = 'summary';
  assert.equal((await s.status()).admission.newStart, 'blocked');
  s.turn.items = []; s.turn.itemsView = 'full'; await s.restart();
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});

for (const variant of ['new launch', 'new launch before old completion', 'omitted unresolved launch']) test(`durable completion cannot retire another operation: ${variant}`, async t => {
  const s = await setup(t);
  await s.status();
  const launch = { type: 'subAgentActivity', id: 'new-launch', kind: 'started', agentThreadId: CHILD };
  if (variant === 'new launch before old completion') s.turn.items.splice(2, 0, launch);
  else s.turn.items.push(launch);
  assert.equal((await s.status()).admission.ownedDelegations.open, 1);
  if (variant === 'omitted unresolved launch') s.turn.items = [];
  await s.restart();
  const status = await s.status();
  assert.equal(status.admission.ownedDelegations.open, 1);
  assert.ok(status.admission.ownedDelegations.items.some(item => item.itemId === launch.id && item.state === 'unknown'));
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});

for (const variant of ['launch target', 'completion target', 'launch kind', 'completion kind', 'item type']) test(`contradictory current native identity invalidates retained closure: ${variant}`, async t => {
  const s = await setup(t);
  await s.status();
  const launch = s.turn.items.find(item => item.id === 'launch'), completion = s.turn.items.find(item => item.id === 'completion');
  if (variant === 'launch target') launch.agentThreadId = R;
  if (variant === 'completion target') completion.agentThreadId = R;
  if (variant === 'launch kind') launch.kind = 'interacted';
  if (variant === 'completion kind') completion.kind = 'interrupted';
  if (variant === 'item type') launch.type = 'commandExecution';
  await s.restart();
  const status = await s.status();
  assert.equal(status.admission.newStart, 'blocked');
  assert.ok(status.admission.unknownOwnedObligations.items.some(item => item.reason === 'OWNED_ITEM_IDENTITY_CONFLICT'));
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});

for (const variant of ['live model', 'live process', 'active goal', 'queued work']) test(`retained closure leaves fresh work safeguard intact: ${variant}`, async t => {
  const s = await setup(t);
  // Capture an exact command exit as well, then contradict it with current inventory.
  if (variant === 'live process') s.turn.items.push({ type: 'commandExecution', id: 'command', processId: '42', status: 'completed', exitCode: 0 });
  const before = await s.status();
  if (variant === 'active goal') {
    await s.c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: before.admission.nativeGoalHash, action: 'set', objective: 'Owned goal continuation' });
    s.f.goal.status = 'active';
  }
  s.turn.items = []; await s.restart();
  if (variant === 'live model') { s.root.status = { type: 'active' }; s.root.turns.push({ id: randomUUID(), status: 'inProgress', itemsView: 'full', items: [] }); }
  if (variant === 'live process') s.f.terminals = [{ itemId: 'command', processId: '42', cwd: s.f.cwd }];
  if (variant === 'queued work') s.f.queue = [{ id: 'queued', clientUserMessageId: randomUUID() }];
  const status = await s.status();
  assert.equal(status.admission.newStart, 'blocked');
  await assert.rejects(s.send());
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(s.f.calls.some(q => /terminate|interrupt|goal\/clear/.test(q.method)), false);
});

test('disconnect followed by omitted history retains exact closure and permits supported continuation', async t => {
  const s = await setup(t); await s.status();
  s.f.disconnect(); s.turn.items = []; await s.restart();
  assert.equal((await s.send()).phase, 'accepted');
});

for (const supported of [false, true]) test(`legacy missing receipts remain unknown with ${supported ? 'supported but empty' : 'unsupported'} exact history API`, async t => {
  const s = await setup(t);
  // Synthetic structural replay: old journal observed 120 commands and 19 launches
  // without exit or completion receipts. Current full native history has no items.
  s.turn.items = [];
  await s.restart(state => {
    const record = state.threads[A]; delete record.ownedObligations;
    record.commandItems = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`legacy-command-${i}`, { turnId: T, processId: null, status: 'completed' }]));
    record.childItems = { [T]: Array.from({ length: 19 }, (_, i) => ({ type: 'subAgentActivity', id: `legacy-launch-${i}`, kind: 'started', agentThreadId: CHILD })) };
  });
  if (supported) {
    const handle = s.f.handle;
    s.f.handle = (socket, q) => {
      if (q.method !== 'thread/items/list') return handle(socket, q);
      socket.send(JSON.stringify({ id: q.id, result: { data: [], nextCursor: null } })); return true;
    };
  }
  const status = await s.status();
  assert.equal(status.admission.ownedProcesses.open, 120);
  assert.equal(status.admission.ownedDelegations.open, 19);
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.some(q => q.method === 'thread/items/list' && q.params.turnId === T), true);
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});

for (const tool of ['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask']) test(`exact native closure survives omitted typed ${tool} launch`, async t => {
  const s = await setup(t);
  s.turn.items[1] = { type: 'collabAgentToolCall', id: 'launch', tool, senderThreadId: A, receiverThreadIds: [CHILD], status: 'completed' };
  assert.equal((await s.status()).admission.ownedDelegations.open, 0);
  s.turn.items = []; await s.restart();
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.some(q => q.params?.threadId === CHILD && ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});

for (const variant of ['sender', 'receiver', 'tool', 'failed status']) test(`typed delegation closure rejects changed ${variant}`, async t => {
  const s = await setup(t);
  const launch = { type: 'collabAgentToolCall', id: 'launch', tool: 'spawnAgent', senderThreadId: A, receiverThreadIds: [CHILD], status: 'completed' };
  s.turn.items[1] = launch; await s.status();
  if (variant === 'sender') launch.senderThreadId = R;
  if (variant === 'receiver') launch.receiverThreadIds = [R];
  if (variant === 'tool') launch.tool = 'sendMessage';
  if (variant === 'failed status') launch.status = 'failed';
  await s.restart();
  assert.equal((await s.status()).admission.newStart, 'blocked');
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});

for (const variant of ['missing source', 'wrong completion', 'duplicate completion']) test(`invalid saved closure cannot bypass missing history: ${variant}`, async t => {
  const s = await setup(t); await s.status(); s.turn.items = [];
  await s.restart(state => {
    const owned = state.threads[A].ownedObligations.turns[T], receipt = owned.delegationClosures.launch;
    if (variant === 'missing source') delete receipt.source;
    if (variant === 'wrong completion') receipt.completionId = 'absent';
    if (variant === 'duplicate completion') owned.delegationClosures.duplicate = { ...receipt, launchId: 'duplicate' };
  });
  assert.equal((await s.status()).admission.newStart, 'blocked');
  await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});

test('bounded exact-turn item repair establishes durable closure before later omission', async t => {
  const s = await setup(t), items = s.turn.items.filter(item => item.type === 'subAgentActivity');
  s.turn.items = []; s.turn.itemsView = 'summary';
  const handle = s.f.handle;
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return handle(socket, q);
    assert.equal(q.params.threadId, A); assert.equal(q.params.turnId, T);
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T, item: items[q.params.cursor ? 1 : 0] }], nextCursor: q.params.cursor ? null : 'completion-page' } })); return true;
  };
  assert.equal((await s.status()).admission.ownedDelegations.open, 0);
  s.turn.itemsView = 'full'; await s.restart();
  s.f.handle = handle;
  assert.equal((await s.send()).phase, 'accepted');
});

test('seventeen closed owned turns admit despite two empty unloaded historical children', async t => {
  const s = await setup(t); await s.status();
  const other = s.f.thread(R); Object.assign(other, { parentThreadId: A, status: { type: 'notLoaded' }, turns: [] }); s.f.threads.set(R, other);
  for (let i = 1; i < 17; i++) {
    assert.equal((await s.send()).phase, 'accepted');
    Object.assign(s.root.turns.at(-1), { status: 'completed', itemsView: 'full' }); s.root.status = { type: 'idle' };
  }
  await s.status(); s.turn.items = []; await s.restart();
  const status = await s.status();
  assert.equal(status.admission.ownedModel.count, 17); assert.equal(status.admission.unknownOwnedObligations.open, 0);
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.some(q => [CHILD, R].includes(q.params?.threadId) && ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});
