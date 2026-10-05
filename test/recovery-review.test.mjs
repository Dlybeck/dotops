import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';
import { readDescendants } from '../src/stage1/descendants.mjs';
import { captureOwnedTurn, evaluateOwnedObligations } from '../src/stage1/owned-obligations.mjs';

async function historicalChildren(t, count) {
  const f = await fixture(t);
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Synthetic recovery regression' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Synthetic work',
    expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A);
  root.status = { type: 'idle' };
  Object.assign(root.turns[0], { status: 'completed', itemsView: 'full' });
  const children = Array.from({ length: count }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const child = f.thread(id);
    Object.assign(child, { parentThreadId: A, status: { type: 'notLoaded' }, turns: [] });
    f.threads.set(id, child);
    return child;
  });
  f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: randomUUID(), status: 'inProgress', itemsView: 'full', items: [
      { type: 'userMessage', id: 'next-user', clientId: q.params.clientUserMessageId, content: q.params.input } ] };
    root.turns.push(turn); root.status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  return { f, c, children, send: () => c.call('codex_chat_send', { requestId: randomUUID(), threadId: A,
    text: 'Next synthetic work', expectedLastTurnId: T, acknowledgeConcurrentStartRisk: true }) };
}

test('64 unloaded historical children do not impose the legacy verification cap on expanded admission', async t => {
  const s = await historicalChildren(t, 64);
  assert.equal(await readDescendants(s.c, A), null); // Legacy attachment remains bounded.
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, true);
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.some(q => q.params?.threadId !== A &&
    ['thread/resume', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt'].includes(q.method)), false);
});

test('expanded admission completes more than four pages and both archive partitions', async t => {
  const s = await historicalChildren(t, 180);
  s.f.archived = new Set(s.children.slice(100).map(child => child.id));
  assert.equal((await s.send()).phase, 'accepted');
  assert.ok(s.f.calls.some(q => q.method === 'thread/list' && !q.params.archived && q.params.cursor === '80'));
  assert.ok(s.f.calls.some(q => q.method === 'thread/list' && q.params.archived && q.params.cursor === '60'));
});

for (const variant of ['active model', 'active goal', 'queued input', 'unavailable processes', 'incomplete queue']) {
  test(`large historical inventory still blocks current child ${variant}`, async t => {
    const s = await historicalChildren(t, 64), child = s.children.at(-1), handle = s.f.handle;
    if (variant === 'active model') child.status = { type: 'active' };
    if (variant === 'unavailable processes') child.status = { type: 'idle' };
    s.f.handle = (socket, q) => {
      if (q.params?.threadId === child.id) {
        let result;
        if (variant === 'active goal' && q.method === 'thread/goal/get') result = { goal: { status: 'active' } };
        if (variant === 'queued input' && q.method === 'thread/queue/list') result = { data: [{ id: 'synthetic-queue' }], nextCursor: null };
        if (variant === 'incomplete queue' && q.method === 'thread/queue/list') result = { data: [], nextCursor: 'more' };
        if (variant === 'unavailable processes' && q.method === 'thread/backgroundTerminals/list') {
          socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Synthetic unavailable inventory' } })); return true;
        }
        if (result) { socket.send(JSON.stringify({ id: q.id, result })); return true; }
      }
      return handle(socket, q);
    };
    assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
    await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
    assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  });
}

for (const variant of ['missing cursor', 'repeated cursor', 'duplicate child', 'unavailable page', 'incomplete archive']) {
  test(`expanded inventory rejects ${variant} beyond the legacy size`, async t => {
    const s = await historicalChildren(t, 84), handle = s.f.handle;
    s.f.handle = (socket, q) => {
      if (q.method === 'thread/list' && (variant === 'incomplete archive' ? q.params.archived : q.params.cursor === '60')) {
        if (variant === 'unavailable page') {
          socket.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'Synthetic unavailable page' } })); return true;
        }
        const result = variant === 'incomplete archive' ? { data: [] }
          : variant === 'repeated cursor' ? { data: [], nextCursor: '60' }
          : { data: variant === 'duplicate child' ? [s.children[0]] : s.children.slice(60, 80),
            ...(variant === 'duplicate child' ? { nextCursor: null } : {}) };
        socket.send(JSON.stringify({ id: q.id, result })); return true;
      }
      return handle(socket, q);
    };
    assert.equal((await s.c.call('codex_chat_status', { threadId: A })).admission.currentReadiness.ready, false);
    await assert.rejects(s.send(), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  });
}

function sequentialDelegations(pairs) {
  const record = {}, turn = { id: 'synthetic-turn', status: 'completed', itemsView: 'full',
    items: Array.from({ length: pairs }, (_, i) => [
      { type: 'subAgentActivity', id: `launch-${i}`, kind: 'started', agentThreadId: 'synthetic-child' },
      { type: 'subAgentActivity', id: `done-${i}`, kind: 'completed', agentThreadId: 'synthetic-child' },
    ]).flat() };
  captureOwnedTurn(record, turn);
  return { record, turn, owned: record.ownedObligations.turns[turn.id],
    evaluate: () => evaluateOwnedObligations(record, [turn.id], { available: true, complete: true, data: [] }, A) };
}

for (const operation of ['unchanged capture', 'omitted capture', 'evaluation']) {
  test(`retained receipt reads scale linearly during ${operation}`, () => {
    const pairs = 32, s = sequentialDelegations(pairs); let reads = 0;
    // Count reads at the ledger input boundary, not elapsed time or helper calls.
    // This detects repeated scans without depending on CI runner speed.
    s.owned.delegationClosures = new Proxy(s.owned.delegationClosures, {
      get(target, key, receiver) { if (Object.hasOwn(target, key)) reads++; return Reflect.get(target, key, receiver); },
    });
    if (operation === 'unchanged capture') captureOwnedTurn(s.record, s.turn);
    else if (operation === 'omitted capture') captureOwnedTurn(s.record, { ...s.turn, items: [] });
    else s.evaluate();
    assert.ok(reads <= pairs * 8, `${reads} receipt reads for ${pairs} operations`);
    const proof = s.evaluate();
    assert.equal(proof.verifiedStopped, true);
    assert.equal(proof.delegations.length, pairs);
    assert.ok(proof.delegations.every(item => item.state === 'closed' && item.childStopAuthorized === false));
  });
}

for (const malformed of [false, true]) {
  test(`indexed closure rejects duplicate completion claims including ${malformed ? 'malformed' : 'valid'} claimants`, () => {
    const s = sequentialDelegations(32);
    s.owned.delegationClosures['duplicate-claim'] = { ...s.owned.delegationClosures['launch-0'],
      launchId: 'duplicate-claim', ...(malformed ? { source: 'invalid-source' } : {}) };
    captureOwnedTurn(s.record, { ...s.turn, items: [] });
    const proof = s.evaluate();
    assert.equal(proof.verifiedStopped, false);
    assert.equal(proof.delegations.find(item => item.itemId === 'launch-0').state, 'unknown');
    assert.equal(proof.delegations.filter(item => item.state === 'closed').length, 31);
    assert.equal(Object.values(s.owned).some(value => value instanceof Map || value instanceof Set), false);
  });
}

test('indexed completions remain consumed by their original operations in accumulated ambiguous history', () => {
  const s = sequentialDelegations(32);
  captureOwnedTurn(s.record, { ...s.turn, items: [...s.turn.items,
    { type: 'subAgentActivity', id: 'later-launch', kind: 'started', agentThreadId: 'synthetic-child' },
    { type: 'subAgentActivity', id: 'ambiguous-launch', kind: 'interacted', agentThreadId: 'synthetic-child' },
    { type: 'subAgentActivity', id: 'ambiguous-completion', kind: 'completed', agentThreadId: 'synthetic-child' },
  ] });
  captureOwnedTurn(s.record, { ...s.turn, items: [] });
  const proof = s.evaluate();
  assert.equal(proof.delegations.filter(item => item.state === 'closed').length, 32);
  assert.equal(proof.delegations.filter(item => item.state === 'unknown').length, 2);
  assert.ok(proof.delegations.every(item => item.childStopAuthorized === false));
});
