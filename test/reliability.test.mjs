import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, B, R, T } from './stage1-fixture.mjs';
import { taskSend } from './task-window-fixture.mjs';
import { hostname } from 'node:os';
import { mkdir, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listen } from '../src/stage1/ipc.mjs';

const CHILD = '55555555-5555-4555-8555-555555555555';
async function setup(t) {
  const f = await fixture(t);
  const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state', timeoutMs: 100 });
  clearInterval(c.timer);
  t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Isolated reliability regression' });
  f.threads.get(A).environments = [{ environmentId: 'local', cwd: f.cwd, runtimeWorkspaceRoots: [f.cwd] }];
  return { f, c, root: f.threads.get(A) };
}
function complete(root) { root.turns.at(-1).status = 'completed'; root.status = { type: 'idle' }; }
function event(c, method, params, id) { c.event({ method, params, epoch: c.native.epoch, ...(id === undefined ? {} : { id }) }); }
async function activeChild(s, turn) {
  turn.items.push({ type: 'subAgentActivity', id: 'new-child', kind: 'started', agentThreadId: CHILD });
  const child = s.f.thread(CHILD);
  Object.assign(child, { parentThreadId: A, status: { type: 'active' }, turns: [{ id: randomUUID(), status: 'inProgress', items: [] }] });
  s.f.threads.set(CHILD, child);
}

test('a duplicated correlated message in one turn cannot resolve a lost acknowledgement', async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    s.root.turns.push({ id: T, status: 'completed', itemsView: 'full', items: [
      { type: 'userMessage', id: 'u1', clientId: B }, { type: 'userMessage', id: 'u2', clientId: B },
    ] }); socket.terminate(); return true;
  };
  assert.equal((await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' })).phase, 'unknown');
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.operations[0].phase, 'unknown');
  await assert.rejects(taskSend(s.c, { requestId: randomUUID(), threadId: A, text: 'No replay' }), { code: 'SEND_UNRESOLVED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('default scoped start cannot claim or stop a native UI turn that received its text later', async t => {
  const s = await setup(t); const ui = { id: 'native-ui-turn', status: 'completed', items: [
    { type: 'userMessage', id: 'ui-message', clientId: 'native-ui' },
  ] }; s.root.turns.push(ui);
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    ui.status = 'inProgress'; ui.items.push({ type: 'userMessage', id: 'ours-later', clientId: B });
    s.root.status = { type: 'active' }; socket.send(JSON.stringify({ id: q.id, result: { turn: ui } })); return true;
  };
  assert.equal((await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture race' })).phase, 'unknown');
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).operations[0].phase, 'unknown');
  await assert.rejects(s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: ui.id }), { code: 'TURN_NOT_OWNED' });
  assert.equal(s.f.calls.some(q => q.method === 'turn/interrupt'), false);
});

for (const terminal of [
  { itemId: 'owned-command', processId: 'unrelated-process' },
  { itemId: 'unrelated-command', processId: 'owned-process' },
]) test(`terminal identity disagreement preserves ${terminal.itemId}/${terminal.processId}`, async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  s.root.turns[0].items.push({ type: 'commandExecution', id: 'owned-command', processId: 'owned-process' });
  s.f.terminals = [{ ...terminal, cwd: s.f.cwd }];
  const result = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(result.verifiedStopped, false);
  assert.equal(s.f.terminals.length, 1);
  assert.equal(s.f.calls.some(q => q.method === 'thread/backgroundTerminals/terminate'), false);
});

test('contradictory persisted and native process identities grant no termination authority', async t => {
  const s = await setup(t);
  await s.c.store.update(state => { state.threads[A].commandItems = { cmd: { turnId: T, processId: 'older' } }; });
  assert.equal(s.c.ownsTerminal(A, T, { itemId: 'cmd', processId: 'newer' }, { items: [
    { type: 'commandExecution', id: 'cmd', processId: 'newer' },
  ] }), false);
});

test('terminal refresh retains conflicting process identities across history and restart', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  complete(s.root);
  s.root.turns[0].items.push({ type: 'commandExecution', id: 'cmd', processId: 'older' });
  await s.c.recordTerminalTurns(A, s.root.turns);
  s.root.turns[0].items.at(-1).processId = 'newer';
  await s.c.recordTerminalTurns(A, s.root.turns);
  assert.equal(s.c.ownsTerminal(A, T, { itemId: 'cmd', processId: 'newer' }, s.root.turns[0]), false);
  await s.c.close();
  const restarted = await Controller.open({ socketPath: s.f.socket, root: s.f.root, stateDir: s.f.dir + '/state', timeoutMs: 100 });
  clearInterval(restarted.timer); t.after(() => restarted.close());
  s.c = restarted;
  s.f.terminals = [{ itemId: 'cmd', processId: 'newer', cwd: s.f.cwd }];
  const result = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(result.verifiedStopped, false);
  assert.equal(s.f.calls.some(q => q.method === 'thread/backgroundTerminals/terminate'), false);
});

test('conflicting command notifications cannot overwrite termination evidence', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  for (const processId of ['older', 'newer']) event(s.c, 'item/started', { threadId: A, turnId: T,
    item: { type: 'commandExecution', id: 'cmd', processId } });
  await s.c.store.tail;
  assert.equal(s.c.ownsTerminal(A, T, { itemId: 'cmd', processId: 'newer' }, { items: [
    { type: 'commandExecution', id: 'cmd', processId: 'newer' },
  ] }), false);
  event(s.c, 'item/started', { threadId: A, turnId: T,
    item: { type: 'commandExecution', id: 'other-cmd', processId: 'older' } });
  await s.c.store.tail;
  assert.equal(s.c.ownsTerminal(A, T, { itemId: 'other-cmd', processId: 'older' }, { items: [
    { type: 'commandExecution', id: 'other-cmd', processId: 'older' },
  ] }), false);
});

test('completed native requests cannot latch approvals and secret prompts forever', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  event(s.c, 'item/commandExecution/requestApproval', { threadId: A, turnId: T }, 'approval');
  event(s.c, 'item/tool/requestUserInput', { threadId: A, turnId: T, questions: [{ id: 'key', isSecret: true }] }, 'secret');
  complete(s.root);
  event(s.c, 'turn/completed', { threadId: A, turn: s.root.turns[0] });
  const listed = await s.c.call('codex_chat_questions', { threadId: A });
  assert.equal(listed.localApprovalRequests, 0); assert.equal(listed.localSecretRequests, 0);
  assert.equal(s.f.calls.some(q => ['approval', 'secret'].includes(q.id) && q.result), false);
});

test('resolved native requests cannot clear an unrelated turn request with a colliding id', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  event(s.c, 'item/commandExecution/requestApproval', { threadId: A, turnId: T }, 'approval');
  event(s.c, 'serverRequest/resolved', { threadId: B, requestId: 'approval' });
  assert.equal((await s.c.call('codex_chat_questions', { threadId: A })).localApprovalRequests, 1);
});

test('stop verification includes newer owned descendants instead of certifying only an old stop', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'First fixture' }); complete(s.root);
  await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  const newer = { id: randomUUID(), status: 'completed', items: [] };
  s.root.turns.push(newer); await activeChild(s, newer);
  await s.c.store.update(state => { state.operations[randomUUID()] = { kind: 'send', phase: 'accepted', threadId: A,
    turnId: newer.id, deadlineAt: Date.now() + 60000 }; });
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.stopVerification.children, 'unverified'); assert.equal(status.stopVerification.verifiedStopped, false);
});

test('a new start in the same window cannot pass active prior descendants', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'First fixture' }); complete(s.root);
  await activeChild(s, s.root.turns[0]);
  await assert.rejects(taskSend(s.c, { requestId: randomUUID(), threadId: A, text: 'No competing writer' }), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('native state changing after stop evidence reads prevents a stale stopped claim', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'First fixture' }); complete(s.root);
  await s.c.store.update(state => { state.threads[A].lastStop = { turnId: T, acknowledged: true }; });
  s.f.handle = (socket, q) => { if (q.method === 'thread/queue/list') s.root.status = { type: 'active' }; };
  assert.equal((await s.c.verifyStop(A)).verifiedStopped, false);
});

for (const environments of [null, [], [{ environmentId: 'cloud', cwd: '/workspace' }],
  [{ environmentId: 'local', cwd: '/tmp/different' }],
  [{ environmentId: 'local', cwd: 'MATCH' }, { environmentId: 'fallback', cwd: '/workspace' }],
]) test(`send refuses unverified or changed native execution selection ${JSON.stringify(environments)}`, async t => {
  const s = await setup(t);
  s.root.environments = environments?.map(e => ({ ...e, cwd: e.cwd === 'MATCH' ? s.f.cwd : e.cwd })) ?? null;
  await assert.rejects(taskSend(s.c, { requestId: B, threadId: A, text: 'Must remain local' }), { code: 'EXECUTION_ENVIRONMENT_UNVERIFIED' });
  assert.equal(s.f.calls.some(q => q.method === 'turn/start'), false);
});

test('auto-review denial is visible but never grants native permission', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  event(s.c, 'item/autoApprovalReview/completed', { threadId: A, turnId: T, reviewId: 'review', targetItemId: 'command',
    review: { status: 'denied', rationale: 'token=SECRET' }, action: { type: 'command', command: 'PRIVATE_COMMAND' } });
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.nativeApprovals.reviews[0].status, 'denied');
  assert.equal(status.nativeApprovals.ownerControlAvailable, false);
  assert.ok(!JSON.stringify(status.nativeApprovals).includes('SECRET'));
  assert.ok(!JSON.stringify(status.nativeApprovals).includes('PRIVATE_COMMAND'));
  assert.equal(s.f.calls.some(q => q.method === 'thread/approveGuardianDeniedAction'), false);
});

test('status distinguishes transport acceptance, failed completion and target identity', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  const running = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(running.operations[0].phase, 'accepted'); assert.equal(running.operations[0].executionState, 'running');
  s.root.turns[0].status = 'failed'; s.root.status = { type: 'idle' };
  const failed = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(failed.operations[0].phase, 'accepted'); assert.equal(failed.operations[0].executionState, 'failed');
  assert.equal(failed.execution.host, hostname());
  assert.equal(failed.execution.connectorSource, new URL('..', import.meta.url).pathname.replace(/\/$/, ''));
  assert.equal(failed.execution.nativeExecutionVerification, 'selectionOnly');
});

test('status exposes newest assistant report with phase and truncation instead of oldest commentary', async t => {
  const s = await setup(t); await taskSend(s.c, { requestId: B, threadId: A, text: 'Fixture only' });
  s.root.turns[0].items.push({ type: 'agentMessage', id: 'early', text: 'EARLY '.repeat(1000) },
    { type: 'agentMessage', id: 'latest', phase: 'final_answer', text: 'LATEST RESULT ' + 'z'.repeat(4000) });
  complete(s.root);
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.match(status.turn.assistantText, /^LATEST RESULT /);
  assert.equal(status.turn.assistantMessageId, 'latest'); assert.equal(status.turn.assistantTextPhase, 'final_answer');
  assert.equal(status.turn.assistantTextTruncated, true); assert.equal(status.turn.assistantText.length, 3000);
});

test('cwd drift exposes the exact blocked target without allowing a send or rewriting enrollment', async t => {
  const s = await setup(t); const other = s.f.root + '/other'; await mkdir(other); s.root.cwd = other;
  const before = structuredClone(s.c.store.state);
  await assert.rejects(s.c.call('codex_chat_status', { threadId: A }), error => {
    assert.equal(error.code, 'OUT_OF_SCOPE'); assert.equal(error.diagnostic.expectedCwd, s.f.cwd);
    assert.equal(error.diagnostic.observedCwd, other); assert.equal(error.diagnostic.controlAllowed, false); return true;
  });
  await assert.rejects(taskSend(s.c, { requestId: B, threadId: A, text: 'No cwd guessing' }), { code: 'OUT_OF_SCOPE' });
  assert.deepEqual(s.c.store.state, before); assert.equal(s.f.calls.some(q => q.method === 'thread/settings/update'), false);
});

test('cwd diagnostics reach the parent MCP result through the real private IPC transport', async t => {
  const s = await setup(t), socket = s.f.dir + '/state/control.sock';
  const handle = listen(s.c, socket); handle.server.listen(socket); await once(handle.server, 'listening'); await chmod(socket, 0o600);
  t.after(async () => { for (const connection of handle.sockets) connection.destroy(); await new Promise(resolve => handle.server.close(resolve)); });
  const client = new Client({ name: 'reliability-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./stage1-fixture-server.mjs', import.meta.url)), socket], stderr: 'pipe' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport);
  const other = s.f.root + '/other'; await mkdir(other); s.root.cwd = other;
  const result = await client.callTool({ name: 'codex_chat_status', arguments: { threadId: A } });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.reason, 'CWD_DRIFT');
  assert.equal(result.structuredContent.execution.host, hostname());
  assert.equal(result.structuredContent.observedCwd, other); assert.equal(result.structuredContent.controlAllowed, false);
  assert.ok(result.content[0].text.includes('OUT_OF_SCOPE'));
});

test('execution selection changing after durable reservation yields an immutable no-dispatch receipt', async t => {
  const s = await setup(t); const update = s.c.store.update.bind(s.c.store);
  s.c.store.update = async fn => {
    await update(fn);
    if (s.c.store.state.operations[B]?.phase === 'dispatching') s.root.environments = [{ environmentId: 'cloud', cwd: '/workspace' }];
  };
  const args = { requestId: B, threadId: A, text: 'Fixture only' };
  const result = await taskSend(s.c, args);
  assert.equal(result.phase, 'notDispatched'); assert.equal(result.code, 'EXECUTION_ENVIRONMENT_UNVERIFIED');
  assert.equal(s.f.calls.some(q => q.method === 'turn/start'), false);
  s.root.environments = [{ environmentId: 'local', cwd: s.f.cwd }];
  assert.deepEqual(await taskSend(s.c, args), result);
  assert.equal(s.c.store.state.operations[B].dispatchBinding.host, hostname());
});

for (const mode of ['active', 'archived', 'nested']) test(`native descendant inventory catches unobserved ${mode} work`, async t => {
  const s = await setup(t);
  const child = s.f.thread(CHILD);
  Object.assign(child, { parentThreadId: A, turns: [{ id: randomUUID(), status: 'completed', items: [] }] });
  s.f.threads.set(CHILD, child);
  if (mode === 'nested') {
    const nested = s.f.thread(B); Object.assign(nested, { parentThreadId: CHILD, status: { type: 'active' },
      turns: [{ id: randomUUID(), status: 'inProgress', items: [] }] }); s.f.threads.set(B, nested);
  } else { child.status = { type: 'active' }; child.turns[0].status = 'inProgress'; }
  if (mode === 'archived') s.f.archived = new Set([CHILD]);
  await assert.rejects(s.c.preflight(A), { code: 'PREVIOUS_WORK_UNVERIFIED' });
  assert.equal(Object.keys(s.c.store.state.taskWindows).length, 0);
  assert.equal(s.f.calls.some(q => q.method === 'turn/interrupt'), false);
});
for (const mode of ['incomplete', 'duplicate', 'malformed']) test(`descendant inventory ${mode} cannot prove clear work`, async t => {
  const s = await setup(t);
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/list') return;
    const child = { ...s.f.thread(CHILD), parentThreadId: A };
    const result = mode === 'incomplete' ? { data: [], nextCursor: 'loop' }
      : mode === 'duplicate' ? { data: [child, child], nextCursor: null }
      : { data: [{ ...child, id: 'malformed' }], nextCursor: null };
    socket.send(JSON.stringify({ id: q.id, result })); return true;
  };
  await assert.rejects(s.c.preflight(A), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});

test('a new native descendant during final inventory recheck invalidates earlier empty evidence', async t => {
  const s = await setup(t); let reads = 0;
  s.f.handle = (socket, q) => {
    if (q.method === 'thread/list' && ++reads === 3) {
      const child = s.f.thread(CHILD); Object.assign(child, { parentThreadId: A, status: { type: 'active' },
        turns: [{ id: randomUUID(), status: 'inProgress', items: [] }] }); s.f.threads.set(CHILD, child);
    }
  };
  await assert.rejects(s.c.preflight(A), { code: 'PREVIOUS_WORK_UNVERIFIED' });
});
