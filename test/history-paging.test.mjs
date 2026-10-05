import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { Controller } from '../src/stage1/controller.mjs';
import { Native } from '../src/stage1/native.mjs';
import { listen, WatchdogClient } from '../src/stage1/ipc.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

function history(f, method, records) {
  f.handle = (socket, q) => {
    if (q.method !== method) return;
    const offset = Number(q.params.cursor ?? 0);
    const data = records.slice(offset, offset + q.params.limit);
    const nextCursor = offset + data.length < records.length ? String(offset + data.length) : null;
    socket.send(JSON.stringify({ id: q.id, result: { data, nextCursor } }));
    return true;
  };
}

async function controller(t, f) {
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' });
  t.after(() => c.close());
  return c;
}

test('oversized full history shrinks pages without losing older turns or claiming partial history complete', async t => {
  const f = await fixture(t), c = await controller(t, f);
  const records = Array.from({ length: 45 }, (_, i) => ({ id: `turn-${i}`, status: 'completed',
    items: [{ type: 'agentMessage', id: `answer-${i}`, text: 'x'.repeat(120000) }] }));
  history(f, 'thread/turns/list', records);
  const result = await c.turns(A);
  assert.equal(result.complete, true);
  assert.deepEqual(result.data.map(x => x.id), records.map(x => x.id));
  const reads = f.calls.filter(q => q.method === 'thread/turns/list');
  assert.deepEqual(reads.slice(0, 2).map(q => [q.params.limit, q.params.cursor]), [[20, undefined], [10, undefined]]);
  assert.equal(reads.at(-1).params.cursor, '40');
  assert.ok(reads.slice(1).every(q => q.params.limit <= 10));
  assert.equal(f.calls.some(q => ['turn/start', 'thread/resume'].includes(q.method)), false);
  assert.equal((await c.turns(A)).complete, true);
  assert.equal(f.calls.filter(q => q.method === 'thread/turns/list').at(-1).params.limit, 10);
});

test('single oversized history record reports unsupported size and never grants complete evidence', async t => {
  const f = await fixture(t), c = await controller(t, f);
  history(f, 'thread/turns/list', [{ id: T, status: 'completed',
    items: [{ type: 'agentMessage', id: 'answer', text: 'x'.repeat(2100000) }] }]);
  await assert.rejects(c.turns(A), { code: 'NATIVE_RESPONSE_TOO_LARGE' });
  assert.deepEqual(f.calls.filter(q => q.method === 'thread/turns/list').map(q => q.params.limit), [20, 10, 5, 2, 1]);
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
});

test('ordinary history disconnects are not retried', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close());
  f.handle = (socket, q) => { if (q.method === 'thread/turns/list') { socket.terminate(); return true; } };
  await assert.rejects(n.request('thread/turns/list', { threadId: A, limit: 20, itemsView: 'full', sortDirection: 'desc' }), { code: 'DAEMON_UNAVAILABLE' });
  assert.equal(f.calls.filter(q => q.method === 'thread/turns/list').length, 1);
});

test('oversized mutation acknowledgements are never replayed', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close());
  f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    socket.send(JSON.stringify({ id: q.id, result: { turn: { id: T, text: 'x'.repeat(2100000) } } }));
    return true;
  };
  await assert.rejects(n.request('turn/start', { threadId: A,
    input: [{ type: 'text', text: 'Synthetic work.' }], clientUserMessageId: R }), { code: 'DAEMON_UNAVAILABLE' });
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});

for (const boundary of ['missing cursor', 'empty cursor', 'repeated cursor', 'duplicate turn', 'budget']) {
  test(`history remains incomplete or rejects invalid evidence at ${boundary}`, async t => {
    const f = await fixture(t), c = await controller(t, f);
    let page = 0;
    f.handle = (socket, q) => {
      if (q.method !== 'thread/turns/list') return;
      const id = boundary === 'duplicate turn' ? 'same' : `turn-${page++}`;
      const nextCursor = boundary === 'missing cursor' ? undefined : boundary === 'empty cursor' ? ''
        : boundary === 'budget' ? String(page) : 'again';
      socket.send(JSON.stringify({ id: q.id, result: { data: [{ id, status: 'completed', items: [] }], nextCursor } }));
      return true;
    };
    if (boundary === 'duplicate turn') await assert.rejects(c.turns(A), { code: 'INVALID_BACKEND_RESPONSE' });
    else {
      const result = await c.turns(A);
      assert.equal(result.complete, false);
      assert.ok(result.data.length <= 60);
      if (boundary === 'budget') assert.equal(result.data.length, 60);
    }
  });
}

test('smaller item pages retain the original 400-item repair budget and exact command receipts', async t => {
  const f = await fixture(t), c = await controller(t, f);
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'History paging fixture' });
  const requestId = randomUUID();
  await c.store.update(s => { s.operations[requestId] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' }; });
  const records = Array.from({ length: 225 }, (_, i) => ({ turnId: T,
    item: { type: 'commandExecution', id: `command-${i}`, status: 'completed', exitCode: 0,
      aggregatedOutput: 'x'.repeat(120000) } }));
  history(f, 'thread/items/list', records);
  const result = await c.repairOwnedTurn(A, T);
  assert.deepEqual(result, { turnId: T, complete: true, itemCount: 225 });
  const owned = c.store.state.threads[A].ownedObligations.turns[T];
  assert.equal(owned.fullItemsObserved, true);
  assert.equal(owned.items['command-224'].exitCode, 0);
  assert.ok(f.calls.filter(q => q.method === 'thread/items/list').length > 20);
});

test('an oversized individual item cannot create a complete repair receipt', async t => {
  const f = await fixture(t), c = await controller(t, f);
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'History paging fixture' });
  await c.store.update(s => { s.operations[randomUUID()] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' }; });
  history(f, 'thread/items/list', [{ turnId: T, item: { type: 'agentMessage', id: 'large-item', text: 'x'.repeat(2100000) } }]);
  await assert.rejects(c.repairOwnedTurn(A, T), { code: 'NATIVE_RESPONSE_TOO_LARGE' });
  assert.notEqual(c.store.state.threads[A].ownedObligations?.turns?.[T]?.fullItemsObserved, true);
});

test('item repair stops at the evidence budget with a visible incomplete result', async t => {
  const f = await fixture(t), c = await controller(t, f);
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'History paging fixture' });
  await c.store.update(s => { s.operations[randomUUID()] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' }; });
  history(f, 'thread/items/list', Array.from({ length: 401 }, (_, i) => ({ turnId: T,
    item: { type: 'agentMessage', id: `item-${i}`, text: 'Synthetic answer.' } })));
  assert.deepEqual(await c.repairOwnedTurn(A, T), { turnId: T, complete: false, itemCount: 400 });
  assert.notEqual(c.store.state.threads[A].ownedObligations?.turns?.[T]?.fullItemsObserved, true);
});

test('slow supported history fails explicitly within the production IPC reply window', async t => {
  const f = await fixture(t), c = await controller(t, f);
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'History timing fixture' });
  await c.store.update(s => { s.operations[randomUUID()] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' }; });
  const records = Array.from({ length: 45 }, (_, i) => ({ id: i === 0 ? T : `turn-${i}`, status: 'completed',
    items: [{ type: 'agentMessage', id: `answer-${i}`, text: 'x'.repeat(1100000) }] }));
  history(f, 'thread/turns/list', records);
  assert.equal((await c.turns(A)).complete, true);
  const fast = f.handle;
  f.handle = async (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    await new Promise(r => setTimeout(r, 200));
    if (socket.readyState === 1) fast(socket, q);
    return true;
  };
  const socket = f.dir + '/state/control.sock', ipc = listen(c, socket);
  await new Promise(r => ipc.server.listen(socket, r)); await chmod(socket, 0o600);
  t.after(async () => { for (const s of ipc.sockets) s.destroy(); await new Promise(r => ipc.server.close(r)); });
  const start = Date.now();
  await assert.rejects(new WatchdogClient(socket).call('codex_chat_status', { threadId: A }), { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.ok(Date.now() - start < 12000, 'Explicit failure must arrive before the 14-second IPC timeout');
  assert.equal(ipc.jobs.size, 0, 'The controller must stop traversal when it reports the failure');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
});

test('later native completion gets fresh history time instead of inheriting an expired caller budget', async t => {
  const f = await fixture(t); let clock = Date.now(), completed = false;
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Completion timing fixture' });
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list' || !f.threads.get(A)?.turns.length) return;
    const turn = f.threads.get(A).turns[0];
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ ...turn, items: completed ? turn.items : [] }], nextCursor: null } }));
    return true;
  };
  const requestId = randomUUID();
  assert.equal((await c.call('codex_chat_send', { requestId, threadId: A, text: 'One synthetic request.' })).phase, 'unknown');
  clock += 6000; completed = true;
  f.threads.get(A).turns[0].status = 'completed'; f.threads.get(A).status.type = 'idle';
  const event = once(c.native, 'event');
  f.notify('turn/completed', { threadId: A, turn: { id: T, status: 'completed', items: [] } });
  await event; await c.completionJobs.get(A);
  assert.equal(c.store.state.operations[requestId].phase, 'accepted');
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});
