import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
import * as ownership from '../src/stage1/owned-obligations.mjs';

async function setup(t, beforeSend) {
  const f = await fixture(t);
  const options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options);
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Owned obligations fixture' });
  beforeSend?.(f, c);
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Owned fixture work', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  return { f, get c() { return c; }, async restart() { await c.close(); c = await Controller.open(options); },
    async journal() { return JSON.parse(await readFile(options.stateDir + '/state.json', 'utf8')); } };
}

test('exact owned turn history persists model, command exit and delegation evidence without private payloads', async t => {
  const s = await setup(t), turn = s.f.threads.get(A).turns[0];
  turn.status = 'completed'; s.f.threads.get(A).status = { type: 'idle' };
  turn.itemsView = 'full';
  turn.items.push({ type: 'commandExecution', id: 'command-one', processId: '42', status: 'completed', exitCode: 0, command: 'PRIVATE COMMAND', aggregatedOutput: 'PRIVATE OUTPUT' });
  turn.items.push({ type: 'collabAgentToolCall', id: 'delegate-one', tool: 'spawnAgent', status: 'completed', senderThreadId: A,
    receiverThreadIds: ['55555555-5555-4555-8555-555555555555'], agentsStates: { '55555555-5555-4555-8555-555555555555': { status: 'running', message: 'PRIVATE RESULT' } }, prompt: 'PRIVATE PROMPT' });
  await s.c.call('codex_chat_status', { threadId: A });
  await s.restart();
  const journal = await s.journal(), owned = journal.threads[A].ownedObligations.turns[T];
  assert.equal(owned.modelStatus, 'completed');
  assert.equal(owned.fullItemsObserved, true);
  assert.equal(owned.items['command-one'].processId, '42');
  assert.equal(owned.items['command-one'].exitCode, 0);
  assert.equal(owned.items['delegate-one'].tool, 'spawnAgent');
  assert.equal(owned.items['delegate-one'].agentStatuses['55555555-5555-4555-8555-555555555555'], 'running');
  assert.equal(JSON.stringify(owned).includes('PRIVATE'), false);
});

test('native command evidence arriving before send acknowledgement is captured only after exact ownership resolves', async t => {
  const s = await setup(t, f => {
    f.handle = async (socket, q) => {
      if (q.method !== 'turn/start') return;
      const turn = { id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'u', clientId: q.params.clientUserMessageId, content: q.params.input }] };
      f.threads.get(A).turns.push(turn); f.threads.get(A).status = { type: 'active' };
      f.notify('item/started', { threadId: A, turnId: T, item: { type: 'commandExecution', id: 'early-command', processId: '51', status: 'inProgress' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      socket.send(JSON.stringify({ id: q.id, result: { turn } }));
      return true;
    };
  });
  await s.c.store.tail;
  const ledger = (await s.journal()).threads[A].ownedObligations;
  assert.equal(ledger.turns[T].items['early-command'].processId, '51');
});

test('completion before acknowledgement preserves deferred native process evidence and terminal model status', async t => {
  const s = await setup(t, f => {
    f.handle = async (socket, q) => {
      if (q.method !== 'turn/start') return;
      const turn = { id: T, status: 'completed', itemsView: 'full', items: [{ type: 'userMessage', id: 'u', clientId: q.params.clientUserMessageId, content: q.params.input }] };
      f.threads.get(A).turns.push(turn); f.threads.get(A).status = { type: 'idle' };
      f.notify('item/started', { threadId: A, turnId: T, item: { type: 'commandExecution', id: 'early-command', processId: '51', status: 'inProgress' } });
      f.notify('turn/completed', { threadId: A, turn: { id: T, status: 'completed' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      socket.send(JSON.stringify({ id: q.id, result: { turn: { ...turn, status: 'inProgress' } } }));
      return true;
    };
  });
  await s.restart();
  const owned = (await s.journal()).threads[A].ownedObligations.turns[T];
  assert.equal(owned.modelStatus, 'completed');
  assert.equal(owned.items['early-command'].processId, '51');
  assert.equal(owned.fullItemsObserved, false); // Full history omitted the retained event.
});

test('owned native command events survive restart while later manual-turn events stay unowned', async t => {
  const s = await setup(t);
  const received = once(s.c.native, 'event');
  s.f.notify('item/started', { threadId: A, turnId: T,
    item: { type: 'commandExecution', id: 'live-command', processId: '73', status: 'inProgress', command: 'PRIVATE' } });
  await received; await s.c.store.tail;
  await s.restart();
  let journal = await s.journal();
  assert.equal(journal.threads[A].ownedObligations.turns[T].items['live-command'].status, 'inProgress');
  await s.c.call('codex_chat_status', { threadId: A });
  const manual = randomUUID(), nextReceived = once(s.c.native, 'event');
  s.f.notify('item/started', { threadId: A, turnId: manual,
    item: { type: 'commandExecution', id: 'manual-command', processId: '99', status: 'inProgress' } });
  await nextReceived; await s.c.store.tail;
  journal = await s.journal();
  assert.equal(journal.threads[A].ownedObligations.turns[manual], undefined);
  assert.equal(JSON.stringify(journal.threads[A].ownedObligations).includes('manual-command'), false);
});

test('conflicting native handles retain both identities instead of transferring process ownership', async t => {
  const s = await setup(t);
  for (const processId of ['73', '99']) {
    const received = once(s.c.native, 'event');
    s.f.notify('item/started', { threadId: A, turnId: T,
      item: { type: 'commandExecution', id: 'same-command', processId, status: 'inProgress' } });
    await received; await s.c.store.tail;
  }
  await s.restart();
  const command = (await s.journal()).threads[A].ownedObligations.turns[T].items['same-command'];
  assert.equal(command.identityConflict, true);
  assert.deepEqual(command.processIds, ['73', '99']);
});

test('reading newer manual history does not turn its commands or delegations into owned evidence', async t => {
  const s = await setup(t), root = s.f.threads.get(A), manual = randomUUID();
  root.turns[0].status = 'completed'; root.turns[0].itemsView = 'full';
  root.turns.push({ id: manual, status: 'inProgress', itemsView: 'full', items: [
    { type: 'userMessage', id: 'manual-input', clientId: null },
    { type: 'commandExecution', id: 'manual-command', processId: '99', status: 'inProgress' },
    { type: 'subAgentActivity', id: 'manual-spawn', kind: 'started', agentThreadId: randomUUID() }
  ] });
  await s.c.call('codex_chat_status', { threadId: A });
  const ledger = (await s.journal()).threads[A].ownedObligations;
  assert.equal(ledger.turns[T].modelStatus, 'completed');
  assert.equal(ledger.turns[manual], undefined);
  assert.equal(JSON.stringify(ledger).includes('manual-command'), false);
});

test('targeted repair reads only the recorded owned turn and restores command exit evidence', async t => {
  const s = await setup(t), command = { type: 'commandExecution', id: 'old-command', processId: '64', status: 'completed', exitCode: 0 };
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return;
    assert.equal(q.params.turnId, T);
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T, item: command, startedAtMs: 100, completedAtMs: 200 }], nextCursor: null } }));
    return true;
  };
  const repair = await s.c.repairOwnedTurn(A, T);
  assert.equal(repair.complete, true);
  const captured = (await s.journal()).threads[A].ownedObligations.turns[T];
  assert.equal(captured.items['old-command'].exitCode, 0);
  assert.equal(captured.modelStatus, 'unknown'); // Item exit never closes the model.
  assert.equal(captured.fullItemsObserved, true);
  const before = s.f.calls.length;
  await assert.rejects(s.c.repairOwnedTurn(A, randomUUID()), { code: 'TURN_NOT_OWNED' });
  assert.equal(s.f.calls.length, before);
});

for (const variant of ['wrong-turn', 'duplicate-items', 'missing-cursor', 'cursor-loop']) test(`targeted repair refuses incomplete or mismatched evidence: ${variant}`, async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return;
    const entry = { turnId: variant === 'wrong-turn' ? randomUUID() : T,
      item: { type: 'commandExecution', id: 'repair-command', processId: '14', status: 'inProgress' } };
    const data = variant === 'duplicate-items' ? [entry, entry] : variant === 'cursor-loop' && q.params.cursor ? [] : [entry];
    const result = { data, ...(variant === 'missing-cursor' ? {} : { nextCursor: variant === 'cursor-loop' ? 'again' : null }) };
    socket.send(JSON.stringify({ id: q.id, result })); return true;
  };
  if (['wrong-turn', 'duplicate-items'].includes(variant)) await assert.rejects(s.c.repairOwnedTurn(A, T), { code: 'INVALID_BACKEND_RESPONSE' });
  else {
    assert.equal((await s.c.repairOwnedTurn(A, T)).complete, false);
    assert.equal((await s.journal()).threads[A].ownedObligations.turns[T].fullItemsObserved, false);
  }
});

test('model completion never closes a still-live exact owned process and unrelated terminals grant no ownership', () => {
  const owned = { modelStatus: 'completed', fullItemsObserved: true, items: {
    command: { type: 'commandExecution', id: 'command', processId: '42', status: 'completed', exitCode: 0 }
  } };
  const live = { available: true, complete: true, data: [
    { itemId: 'command', processId: '42' }, { itemId: 'manual', processId: '99' }
  ] };
  assert.deepEqual(ownership.commandObligations(owned, live), [
    { itemId: 'command', processId: '42', state: 'live', reason: 'NATIVE_PROCESS_OBSERVED' }
  ]);
  assert.deepEqual(ownership.commandObligations(owned, { ...live, data: [live.data[1]] }), [
    { itemId: 'command', processId: '42', state: 'closed', reason: 'NATIVE_COMMAND_EXIT' }
  ]);
});

for (const variant of ['inventory-unavailable', 'null-handle', 'reused-handle', 'model-running', 'items-incomplete']) test(`specific ambiguous process obligation stays unknown: ${variant}`, () => {
  const item = { type: 'commandExecution', id: 'command', processId: variant === 'null-handle' ? null : '42', status: 'inProgress', exitCode: null };
  const owned = { modelStatus: variant === 'model-running' ? 'inProgress' : 'completed', fullItemsObserved: variant !== 'items-incomplete', items: { command: item } };
  const inventory = { available: variant !== 'inventory-unavailable', complete: variant !== 'inventory-unavailable',
    data: variant === 'reused-handle' ? [{ itemId: 'other-command', processId: '42' }] : [] };
  const obligations = ownership.commandObligations(owned, inventory);
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].state, 'unknown');
  assert.equal(obligations[0].itemId, 'command');
});

test('complete fresh inventory can close an owned tracked handle after model completion without claiming detached processes stopped', () => {
  const owned = { modelStatus: 'completed', fullItemsObserved: true, items: {
    command: { type: 'commandExecution', id: 'command', processId: '42', status: 'inProgress', exitCode: null }
  } };
  assert.deepEqual(ownership.commandObligations(owned, { available: true, complete: true, data: [] }), [
    { itemId: 'command', processId: '42', state: 'closed', reason: 'NATIVE_TRACKED_PROCESS_ABSENT' }
  ]);
});

test('a positively exited historical command does not acquire a later manual process reusing its handle', () => {
  const owned = { modelStatus: 'completed', fullItemsObserved: true, items: {
    command: { type: 'commandExecution', id: 'old-owned', processId: '42', status: 'completed', exitCode: 0 }
  } };
  assert.deepEqual(ownership.commandObligations(owned, { available: true, complete: true,
    data: [{ itemId: 'new-manual', processId: '42' }] }), [
    { itemId: 'old-owned', processId: '42', state: 'closed', reason: 'NATIVE_COMMAND_EXIT' }
  ]);
});

test('contradictory model observations cannot close an outstanding process by inventory absence', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: T, status: 'completed', itemsView: 'full', items: [
    { type: 'commandExecution', id: 'command', processId: '42', status: 'inProgress', exitCode: null }
  ] });
  ownership.captureOwnedTurn(record, { id: T, status: 'inProgress' });
  const owned = record.ownedObligations.turns[T];
  assert.equal(owned.modelConflict, true);
  assert.equal(ownership.commandObligations(owned, { available: true, complete: true, data: [] })[0].state, 'unknown');
});

test('partial repair discovering a new process invalidates earlier full-history completeness', async t => {
  const s = await setup(t), root = s.f.threads.get(A);
  root.turns[0].status = 'completed'; root.turns[0].itemsView = 'full'; root.status = { type: 'idle' };
  await s.c.call('codex_chat_status', { threadId: A });
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return;
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T,
      item: { type: 'commandExecution', id: 'new-command', processId: '55', status: 'inProgress' } }] } }));
    return true;
  };
  assert.equal((await s.c.repairOwnedTurn(A, T)).complete, false);
  const owned = (await s.journal()).threads[A].ownedObligations.turns[T];
  assert.equal(owned.fullItemsObserved, false);
  assert.equal(ownership.commandObligations(owned, { available: true, complete: true, data: [] })[0].state, 'unknown');
});

test('targeted repair rejects unsafe item identity rather than dropping an owned obligation', async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/items/list') return;
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: T,
      item: { type: 'commandExecution', id: '__proto__', processId: '55', status: 'inProgress' } }], nextCursor: null } }));
    return true;
  };
  await assert.rejects(s.c.repairOwnedTurn(A, T), { code: 'INVALID_BACKEND_RESPONSE' });
});

test('scoped evaluator retains ambiguous interactions without child-stop authority', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'subAgentActivity', id: 'interaction', kind: 'interacted', agentThreadId: 'child' }
  ] });
  const result = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] });
  assert.equal(result.verifiedStopped, false);
  assert.deepEqual(result.delegations.map(d => [d.itemId, d.state, d.childStopAuthorized]), [['interaction', 'unknown', false]]);
});

test('ordered attributable completion retires delegation without adopting later manual child work', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'subAgentActivity', id: 'interaction', kind: 'interacted', agentThreadId: 'child' },
    { type: 'subAgentActivity', id: 'completion', kind: 'completed', agentThreadId: 'child' }
  ] });
  const result = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [{ itemId: 'manual', processId: 'manual-process' }] });
  assert.equal(result.verifiedStopped, true);
  assert.equal(result.delegations[0].state, 'closed');
});

test('scoped evaluator keeps missing current evidence and known live processes blocking', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'commandExecution', id: 'command', processId: 'process', status: 'completed', exitCode: 0 }
  ] });
  assert.equal(ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [{ itemId: 'command', processId: 'process' }] }).verifiedStopped, false);
  assert.equal(ownership.evaluateOwnedObligations(record, ['missing'], { available: true, complete: true, data: [] }).verifiedStopped, false);
});

test('legacy migration binds exact accepted turns and retains known handles and lossy child evidence', () => {
  const record = { terminalTurns: { owned: { status: 'completed', items: [{ type: 'commandExecution', id: 'legacy', processId: '42' }], childActivityObserved: true } },
    commandItems: { live: { turnId: 'owned', processId: '73', status: 'inProgress' }, manual: { turnId: 'manual', processId: '99' } } };
  ownership.migrateOwnedObligations(record, ['owned']);
  const owned = record.ownedObligations.turns.owned;
  assert.equal(owned.modelStatus, 'completed');
  assert.equal(owned.items.legacy.processId, '42');
  assert.equal(owned.items.live.processId, '73');
  assert.equal(owned.items.manual, undefined);
  assert.equal(owned.fullItemsObserved, false);
  assert.equal(owned.legacyDelegationUnknown, true);
  const before = structuredClone(record);
  ownership.migrateOwnedObligations(record, ['owned']);
  assert.deepEqual(record, before);
  assert.equal(ownership.evaluateOwnedObligations(record, ['owned'], { available: false }).verifiedStopped, false);
});

test('overlapping delegation inputs cannot use one completion as two causal receipts', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'subAgentActivity', id: 'one', kind: 'started', agentThreadId: 'child' },
    { type: 'subAgentActivity', id: 'two', kind: 'interacted', agentThreadId: 'child' },
    { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: 'child' }
  ] });
  const proof = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] });
  assert.equal(proof.delegations.every(item => item.state === 'unknown'), true);
});

test('completed read-only collaboration does not become perpetual delegated model work', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'collabAgentToolCall', id: 'wait', tool: 'wait', status: 'completed', senderThreadId: A, receiverThreadIds: ['child'] },
    { type: 'collabAgentToolCall', id: 'message', tool: 'sendMessage', status: 'completed', senderThreadId: A, receiverThreadIds: ['child'] }
  ] });
  assert.equal(ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] }).verifiedStopped, true);
});

for (const type of ['subAgentActivity', 'collabAgentToolCall']) test(`malformed delegation cannot borrow a later valid completion: ${type}`, () => {
  const record = {}, item = type === 'subAgentActivity'
    ? { type, id: 'malformed', kind: 'future-kind', agentThreadId: 'child' }
    : { type, id: 'malformed', tool: 'future-tool', status: 'completed', senderThreadId: A, receiverThreadIds: ['child'] };
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [item,
    { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: 'child' }] });
  const proof = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] });
  assert.equal(proof.delegations[0].state, 'unknown');
});

test('item type conflicts retain a named unknown and the known command identity', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'commandExecution', id: 'same', processId: '42', status: 'inProgress' }
  ] });
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'subAgentActivity', id: 'same', kind: 'completed', agentThreadId: 'child' }
  ] });
  const proof = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [{ itemId: 'same', processId: '42' }] });
  assert.equal(proof.verifiedStopped, false);
  assert.equal(proof.processes[0].processId, '42');
  assert.equal(proof.processes[0].reason, 'PROCESS_IDENTITY_CONFLICT');
});

test('model-only terminal notification invalidates earlier running item completeness', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'inProgress', itemsView: 'full', items: [] });
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed' });
  assert.equal(record.ownedObligations.turns.owned.fullItemsObserved, false);
  assert.equal(ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] }).verifiedStopped, false);
});

test('migration preserves legacy handle disagreement even when a new ledger already exists', () => {
  const record = { terminalTurns: { owned: { status: 'completed', items: [{ type: 'commandExecution', id: 'command', processId: '42' }] } } };
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'commandExecution', id: 'command', processId: '73', status: 'completed', exitCode: 0 }
  ] });
  ownership.migrateOwnedObligations(record, ['owned']);
  const proof = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] });
  assert.equal(proof.verifiedStopped, false);
  assert.equal(proof.processes[0].reason, 'PROCESS_IDENTITY_CONFLICT');
  assert.deepEqual(record.ownedObligations.turns.owned.items.command.processIds.sort(), ['42', '73']);
});

test('a collab sender disagreement cannot retire via a later child completion', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'collabAgentToolCall', id: 'launch', tool: 'spawnAgent', status: 'completed', senderThreadId: 'other', receiverThreadIds: ['child'] },
    { type: 'subAgentActivity', id: 'done', kind: 'completed', agentThreadId: 'child' }
  ] });
  assert.equal(ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] }, A).verifiedStopped, false);
});

test('command-to-collab item type conflict retains a named unknown instead of throwing', () => {
  const record = {};
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'commandExecution', id: 'same', processId: '42', status: 'inProgress' }
  ] });
  ownership.captureOwnedTurn(record, { id: 'owned', status: 'completed', itemsView: 'full', items: [
    { type: 'collabAgentToolCall', id: 'same', tool: 'spawnAgent', status: 'completed', senderThreadId: A, receiverThreadIds: ['child'] }
  ] });
  const proof = ownership.evaluateOwnedObligations(record, ['owned'], { available: true, complete: true, data: [] }, A);
  assert.equal(proof.verifiedStopped, false);
  assert.equal(proof.processes[0].reason, 'PROCESS_IDENTITY_CONFLICT');
  assert.ok(proof.evidence.some(item => item.itemId === 'same' && item.reason === 'OWNED_ITEM_IDENTITY_CONFLICT'));
});

for (const variant of ['exit', 'live', 'missing-exit', 'identity-conflict', 'delegation']) test(`full native transcript omitting retained item preserves exact closure boundary: ${variant}`, () => {
  const record = {};
  const item = variant === 'delegation'
    ? { type: 'subAgentActivity', id: 'omitted', kind: 'started', agentThreadId: A }
    : { type: 'commandExecution', id: 'omitted', processId: '42', status: variant === 'live' ? 'inProgress' : 'completed',
      exitCode: variant === 'missing-exit' || variant === 'live' ? null : 0 };
  ownership.captureOwnedTurn(record, { id: T, status: 'completed', items: [item] }, { eventItem: true });
  if (variant === 'identity-conflict') ownership.captureOwnedTurn(record, { id: T, status: 'completed',
    items: [{ ...item, processId: '99' }] }, { eventItem: true });
  ownership.captureOwnedTurn(record, { id: T, status: 'completed', itemsView: 'full', items: [] });
  const proof = ownership.evaluateOwnedObligations(record, [T], { available: true, complete: true, data: [] }, A);
  assert.equal(proof.verifiedStopped, variant === 'exit');
  assert.ok(record.ownedObligations.turns[T].items.omitted);
  if (variant !== 'exit') assert.ok(proof.evidence.some(item => item.reason === 'OWNED_ITEMS_UNVERIFIED'));
});
