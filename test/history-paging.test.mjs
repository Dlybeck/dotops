import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { Controller } from '../src/stage1/controller.mjs';
import { Native } from '../src/stage1/native.mjs';
import { listen, WatchdogClient } from '../src/stage1/ipc.mjs';
import { verifyChildren } from '../src/stage1/children.mjs';
import { fixture, A, B, R, T } from './stage1-fixture.mjs';

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
  await assert.rejects(c.turns(A), { code: 'NATIVE_HISTORY_FRAME_UNVERIFIED' });
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
  await assert.rejects(c.repairOwnedTurn(A, T), { code: 'NATIVE_HISTORY_FRAME_UNVERIFIED' });
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

test('successful paging cannot hide budget exhaustion in later status verification', async t => {
  const f = await fixture(t); let clock = Date.now();
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Verification budget fixture' });
  await c.store.update(s => { s.operations[randomUUID()] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' }; });
  const records = Array.from({ length: 36 }, (_, i) => ({ id: i === 0 ? T : `turn-${i}`, status: 'completed',
    items: [{ type: 'agentMessage', id: `answer-${i}`, text: 'x'.repeat(120000) }] }));
  history(f, 'thread/turns/list', records);
  assert.equal((await c.turns(A)).complete, true);
  const fast = f.handle;
  let pages = 0, expired = false;
  f.handle = (socket, q) => {
    if (expired && ['thread/goal/get', 'thread/queue/list'].includes(q.method)) assert.fail('No native reads may continue after paging exhausts the caller budget');
    if (q.method === 'thread/turns/list') { clock += 1000; pages++; return fast(socket, q); }
    if (q.method === 'thread/backgroundTerminals/list') { clock += 3600; expired = true; }
  };
  await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.equal(pages, 4, 'History must have succeeded before the later verification failure');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
});

for (const code of ['HISTORY_READ_BUDGET_EXHAUSTED', 'NATIVE_HISTORY_FRAME_UNVERIFIED']) {
  test(`child verification preserves the explicit unsupported history error ${code}`, async () => {
    await assert.rejects(verifyChildren({ turns: async () => { throw Object.assign(new Error(code), { code }); } }, A, []), { code });
  });
}

test('overlapping status calls retain independent history budgets', async t => {
  const f = await fixture(t); let clock = Date.now();
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Concurrent budget fixture' });
  f.threads.set(B, f.thread(B));
  await c.store.update(s => {
    s.threads[B] = structuredClone(s.threads[A]);
    s.operations[randomUUID()] = { kind: 'send', threadId: A, turnId: T, phase: 'accepted' };
  });
  let release, started;
  const ready = new Promise(r => { started = r; }), hold = new Promise(r => { release = r; });
  f.handle = async (socket, q) => {
    if (q.method !== 'thread/turns/list' || q.params.threadId !== A) return;
    started(); await hold;
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ id: T, status: 'completed', items: [] }], nextCursor: null } }));
    return true;
  };
  const earlier = c.call('codex_chat_status', { threadId: A });
  const earlierFailure = assert.rejects(earlier, { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  await ready; clock += 3000;
  const later = c.call('codex_chat_status', { threadId: B });
  clock += 3000;
  assert.equal((await later).threadId, B, 'The later request remains inside its own budget');
  release(); await earlierFailure;
});

test('an expired in-flight history read leaves another caller and later reads available', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); await n.connect();
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    setTimeout(() => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ id: q.id, result: { data: [], nextCursor: null } }));
    }, 200);
    return true;
  };
  const params = { threadId: A, limit: 1, itemsView: 'full', sortDirection: 'desc' }, epoch = n.epoch;
  const earlier = n.request('thread/turns/list', params, { deadlineAt: Date.now() + 100 });
  const later = n.request('thread/turns/list', { ...params, threadId: B }, { deadlineAt: Date.now() + 1500 });
  await assert.rejects(earlier, { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.deepEqual(await later, { data: [], nextCursor: null });
  assert.equal(n.epoch, epoch, 'No transport loss is needed to expire a bounded read');
  assert.deepEqual(await n.request('thread/turns/list', params), { data: [], nextCursor: null });
});

test('size retries check expiration before opening another connection', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); let clock = Date.now(); n.now = () => clock;
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    clock += 6000;
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ id: T, items: [{ text: 'x'.repeat(2100000) }] }], nextCursor: null } }));
    return true;
  };
  await assert.rejects(n.request('thread/turns/list', { threadId: A, limit: 20, itemsView: 'full', sortDirection: 'desc' }, { deadlineAt: clock + 5000 }), { code: 'DEADLINE_EXPIRED' });
  assert.equal(f.calls.filter(q => q.method === 'initialize').length, 1);
  assert.equal(f.calls.filter(q => q.method === 'thread/turns/list').length, 1);
});

test('setup waiting is bounded per caller without canceling another caller', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close());
  f.handle = (socket, q) => {
    if (q.method !== 'initialize' && q.method !== 'thread/turns/list') return;
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: q.id,
      result: q.method === 'initialize' ? {} : { data: [], nextCursor: null } })); }, q.method === 'initialize' ? 300 : 0);
    return true;
  };
  const params = { threadId: A, limit: 1, itemsView: 'full', sortDirection: 'desc' };
  const earlier = n.request('thread/turns/list', params, { deadlineAt: Date.now() + 100 });
  const later = n.request('thread/turns/list', { ...params, threadId: B }, { deadlineAt: Date.now() + 1500 });
  await assert.rejects(earlier, { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.deepEqual(await later, { data: [], nextCursor: null });
  assert.deepEqual(f.calls.filter(q => q.method === 'thread/turns/list').map(q => q.params.threadId), [B]);
  assert.equal(f.calls.filter(q => q.method === 'initialize').length, 1);
});

test('concurrent response-size failures retain uncertainty for fitting history records', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); await n.connect();
  const large = Array.from({ length: 20 }, (_, i) => ({ id: `turn-${i}`, items: [{ text: 'x'.repeat(120000) }] }));
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: q.id, result: {
      data: q.params.threadId === A ? large.slice(0, q.params.limit) : [], nextCursor: null } })); }, q.params.threadId === A ? 20 : 100);
    return true;
  };
  const params = { threadId: A, limit: 20, itemsView: 'full', sortDirection: 'desc' };
  const results = await Promise.allSettled([n.request('thread/turns/list', params), n.request('thread/turns/list', { ...params, threadId: B, limit: 1 })]);
  assert.deepEqual(results.map(x => x.reason?.code), ['DAEMON_UNAVAILABLE', 'DAEMON_UNAVAILABLE']);
  assert.equal((await n.request('thread/turns/list', params)).data.length, 10, 'A later isolated read can safely adapt');
});

test('late oversized expired responses retain uncertainty for another caller', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); await n.connect();
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: q.id, result: {
      data: q.params.threadId === A ? [{ id: T, items: [{ text: 'x'.repeat(2100000) }] }] : [], nextCursor: null
    } })); }, q.params.threadId === A ? 200 : 400);
    return true;
  };
  const params = { threadId: A, limit: 1, itemsView: 'full', sortDirection: 'desc' };
  const earlier = n.request('thread/turns/list', params, { deadlineAt: Date.now() + 100 });
  const later = n.request('thread/turns/list', { ...params, threadId: B }, { deadlineAt: Date.now() + 1500 });
  await assert.rejects(earlier, { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  await assert.rejects(later, { code: 'DAEMON_UNAVAILABLE' });
});

test('unanswered expired reads retain bounded capacity until their replies arrive', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); await n.connect();
  const delayed = [];
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    delayed.push({ socket, q }); return true;
  };
  const params = { threadId: A, limit: 1, itemsView: 'full', sortDirection: 'desc' };
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => n.request('thread/turns/list', params, { deadlineAt: Date.now() + 100 })));
  assert.ok(results.every(r => r.reason?.code === 'HISTORY_READ_BUDGET_EXHAUSTED'));
  await assert.rejects(n.request('thread/turns/list', params), { code: 'BUSY' });
  for (const {socket, q} of delayed) socket.send(JSON.stringify({ id: q.id, result: { data: [], nextCursor: null } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  f.handle = null;
  assert.ok(Array.isArray((await n.request('thread/turns/list', params)).data));
});

test('final descendant inventory exhaustion stops the root ownership reread', async t => {
  const f = await fixture(t); let clock = Date.now(), expired = false;
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Final inventory budget fixture' });
  const afterExpiry = [];
  f.handle = (socket, q) => {
    if (expired) afterExpiry.push(q.method);
    if (q.method === 'thread/turns/list') clock += 2000;
    if (q.method === 'thread/list' && q.params.archived) { clock += 3600; expired = true; }
  };
  await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.deepEqual(afterExpiry, []);
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
});

test('oversized unsolicited events cannot establish a history record size', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close()); await n.connect();
  f.handle = (socket, q) => {
    if (q.method !== 'thread/turns/list') return;
    socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: B, turnId: T,
      item: { type: 'agentMessage', text: 'x'.repeat(2100000) } } }));
    return true;
  };
  await assert.rejects(n.request('thread/turns/list', { threadId: A, limit: 1, itemsView: 'full', sortDirection: 'desc' }), { code: 'NATIVE_HISTORY_FRAME_UNVERIFIED' });
});

test('ownership reconnect expiration stops before dispatching the ownership read', async t => {
  const f = await fixture(t); let clock = Date.now();
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', now: () => clock });
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Ownership reconnect fixture' });
  c.native.drop(c.native.socket); const start = f.calls.length;
  f.handle = (socket, q) => { if (q.method === 'initialize') clock += 6000; };
  await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.deepEqual(f.calls.slice(start).map(q => q.method), ['initialize']);
});

test('nonhistory verification reads bound setup waiting to the remaining budget', async t => {
  const f = await fixture(t), n = new Native({ socketPath: f.socket });
  t.after(() => n.close());
  f.handle = (socket, q) => {
    if (q.method !== 'initialize') return;
    setTimeout(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ id: q.id, result: {} })); }, 300);
    return true;
  };
  const start = Date.now();
  await assert.rejects(n.request('thread/backgroundTerminals/list', { threadId: A, limit: 1 }, { deadlineAt: start + 100 }), { code: 'HISTORY_READ_BUDGET_EXHAUSTED' });
  assert.ok(Date.now() - start < 250);
  assert.equal(f.calls.some(q => q.method === 'thread/backgroundTerminals/list'), false);
});
