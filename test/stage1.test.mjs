import { randomUUID } from 'node:crypto';
import { taskSend, openTestWindow } from './task-window-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, A, R, B, T } from './stage1-fixture.mjs';
import { Controller } from '../src/stage1/controller.mjs';
import { Native } from '../src/stage1/native.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WatchdogClient } from '../src/stage1/ipc.mjs';
import { mkdir, symlink } from 'node:fs/promises';
const until = async fn => { const end = Date.now() + 4000; while (!await fn()) { if (Date.now() > end) assert.fail('condition timed out'); await new Promise(r => setTimeout(r, 30)); } };

test('named chat creation is durable and duplicate request IDs never create another chat', async t => {
  const f = await fixture(t);
  const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  const args = { requestId: R, repository: f.cwd, title: 'Disposable creation' };
  const created = await c.call('codex_chat_create', args);
  assert.equal(created.threadId, A);
  assert.equal((await c.call('codex_chat_status', { threadId: A })).title, 'Disposable creation');
  await c.close(); c = await Controller.open(options);
  assert.deepEqual(await c.call('codex_chat_create', args), created);
  assert.equal(f.calls.filter(x => x.method === 'thread/start').length, 1);
  assert.equal(f.calls.some(x => x.method === 'turn/start'), false);
  await assert.rejects(c.call('codex_chat_create', { ...args, title: 'Changed' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('connector preserves a native configured provider without imposing a subscription policy', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Provider boundary' }); f.threads.get(A).modelProvider = 'custom-provider';
  assert.equal((await taskSend(c, { requestId: B, threadId: A, text: 'Native provider request' })).phase, 'accepted');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), true);
});

test('native boundary rejects commands and permission overrides before connection', async () => {
  const n = new Native({ socketPath: '/tmp/no-stage1-backend.sock' });
  try {
    for (const [method, params] of [['command/exec', {}], ['thread/archive', { threadId: A }], ['turn/start', { threadId: A, input: [{ type: 'text', text: 'Denied' }], clientUserMessageId: R, permissions: 'danger-full-access' }], ['thread/resume', { threadId: A, excludeTurns: true, approvalPolicy: 'never' }]]) await assert.rejects(n.request(method, params), { code: 'FORBIDDEN_RPC' });
  } finally { n.close(); }
});
test('observed child activity keeps stop verification partial across watchdog restart', async t => {
  const f = await fixture(t); const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Children boundary' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Fixture only', deadlineSeconds: 60 });
  f.notify('item/started', { threadId: A, turnId: T, item: { type: 'subAgentActivity', id: 'child-item', agentThreadId: '55555555-5555-4555-8555-555555555555' } });
  await until(async () => (await c.call('codex_chat_status', { threadId: A })).turn?.childActivityObserved);
  await c.close(); c = await Controller.open(options);
  const stopped = await c.call('codex_chat_stop', { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, turnId: T });
  assert.equal(stopped.turnTerminal, true); assert.equal(stopped.children, 'unverified'); assert.equal(stopped.verifiedStopped, false);
  assert.equal(f.calls.some(q => q.params?.threadId === '55555555-5555-4555-8555-555555555555' && /interrupt|terminate|resume|start|steer/.test(q.method)), false);
});

test('stop drains all bounded terminal pages and cannot verify a truncated inventory', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Terminal pages' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Brief', deadlineSeconds: 60 });
  f.threads.get(A).turns[0].items.push({ type: 'commandExecution', id: 'last-page-item', processId: 'last-page-process', status: 'inProgress' });
  let ownedAlive = true;
  f.handle = (s, q) => {
    if (q.method === 'thread/backgroundTerminals/list') { const data = q.params.cursor === 'page2' ? (ownedAlive ? [{ itemId: 'last-page-item', processId: 'last-page-process', cwd: f.cwd }] : []) : []; s.send(JSON.stringify({ id: q.id, result: { data, nextCursor: q.params.cursor ? null : 'page2' } })); return true; }
    if (q.method === 'thread/backgroundTerminals/terminate') { ownedAlive = false; s.send(JSON.stringify({ id: q.id, result: { terminated: true } })); return true; }
  };
  const stopped = await c.call('codex_chat_stop', { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, turnId: T });
  assert.equal(ownedAlive, false); assert.equal(stopped.terminalsComplete, true); assert.equal(stopped.verifiedStopped, true);
  f.handle = (s, q) => { if (q.method === 'thread/backgroundTerminals/list') { s.send(JSON.stringify({ id: q.id, result: { data: [], nextCursor: 'continuation' } })); return true; } };
  const status = await c.call('codex_chat_status', { threadId: A }); assert.equal(status.stopVerification.terminalsComplete, false); assert.equal(status.stopVerification.verifiedStopped, false);
});

test('explicit steering cannot enroll an existing native UI turn as connector-owned', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Steering boundary' });
  f.threads.get(A).status = { type: 'active' }; f.threads.get(A).turns.push({ id: T, status: 'inProgress', items: [] });
  await assert.rejects(taskSend(c, { requestId: B, threadId: A, expectedTurnId: T, text: 'Do not steer native UI work', deadlineSeconds: 60 }), { code: 'TURN_NOT_OWNED' });
  assert.equal(f.calls.some(q => q.method === 'turn/steer'), false);
});
test('control scope can restrict enrolled chats to one repository while Projects scope stays canonical', async t => {
  const f = await fixture(t); await mkdir(f.root + '/other-repo');
  const c = await Controller.open({ socketPath: f.socket, root: f.root, controlRoot: f.cwd, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await assert.rejects(c.call('codex_chat_create', { requestId: R, repository: f.root + '/other-repo', title: 'Denied sibling' }), { code: 'OUT_OF_SCOPE' });
  assert.equal(f.calls.some(q => q.method === 'thread/start'), false);
});

test('simultaneous watchdog recovery permits one owner and no duplicate chat mutation', async t => {
  const f = await fixture(t); let worker = await watchdog(f, t); const ipc = new WatchdogClient(f.dir + '/state/control.sock');
  await ipc.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Exclusive recovery' }); worker.kill('SIGKILL'); await once(worker, 'exit');
  const args = [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)), '--state-dir', f.dir + '/state', '--projects-root', f.root, '--native-socket', f.socket];
  const workers = Array.from({ length: 3 }, () => spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }));
  t.after(async () => { for (const child of workers) if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const outcomes = await Promise.all(workers.map(child => Promise.race([once(child.stdout, 'data').then(() => true), once(child, 'exit').then(() => false)])));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await ipc.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Exclusive recovery' })).threadId, A);
  assert.equal(f.calls.filter(x => x.method === 'thread/start').length, 1);
});

test('live command notifications establish durable terminal ownership before history contains the command', async t => {
  const f = await fixture(t); const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Live process' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Sleep', deadlineSeconds: 60 });
  f.terminals = [{ itemId: 'live-item', processId: 'live-process', cwd: f.cwd }];
  f.notify('item/started', { threadId: A, turnId: T, item: { type: 'commandExecution', id: 'live-item', status: 'inProgress', processId: 'live-process' } });
  await until(async () => (await c.call('codex_chat_status', { threadId: A })).trackedOwnedTerminals === 1);
  await c.close(); c = await Controller.open(options);
  const stopped = await c.call('codex_chat_stop', { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, turnId: T });
  assert.equal(stopped.ownedTerminals, 0); assert.equal(stopped.verifiedStopped, true); assert.equal(f.terminals.length, 0);
});

test('a recorded owned idle chat can be resumed after the desktop unloaded it', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Resume' }); f.threads.get(A).status = { type: 'notLoaded' };
  f.handle = (s, q) => {
    if (q.method === 'thread/loaded/list') { s.send(JSON.stringify({ id: q.id, result: { data: [], nextCursor: null } })); return true; }
    if (q.method === 'thread/resume') { f.threads.get(A).status = { type: 'idle' }; s.send(JSON.stringify({ id: q.id, result: { thread: f.threads.get(A) } })); return true; }
  };
  const accepted = await taskSend(c, { requestId: B, threadId: A, text: 'Resume then reply', deadlineSeconds: 60 }); assert.equal(accepted.phase, 'accepted');
  assert.deepEqual(f.calls.find(q => q.method === 'thread/resume').params, { threadId: A, excludeTurns: true });
});

test('status exposes bounded assistant progress and observed usage without reasoning or command output', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Progress' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Brief', deadlineSeconds: 60 });
  f.threads.get(A).turns[0].items.push({ type: 'agentMessage', text: 'Visible progress' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'commandExecution', id: 'command', status: 'inProgress', aggregatedOutput: 'PRIVATE_COMMAND_OUTPUT' });
  f.notify('thread/tokenUsage/updated', { threadId: A, turnId: T, tokenUsage: { total: { totalTokens: 120, inputTokens: 100, outputTokens: 20 }, last: { totalTokens: 120 } } });
  await until(async () => (await c.call('codex_chat_status', { threadId: A })).tokenUsage?.total?.totalTokens === 120);
  const status = await c.call('codex_chat_status', { threadId: A }); assert.equal(status.turn.assistantText, 'Visible progress'); assert.equal(status.turn.commandsInProgress, 1);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_'));
});

test('out-of-scope paths and pending queues fail closed before a prompt', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await mkdir(f.dir + '/outside'); await symlink(f.dir + '/outside', f.root + '/escape');
  for (const repository of [f.dir + '/outside', f.root + '/escape', '../outside']) await assert.rejects(c.call('codex_chat_create', { requestId: R, repository, title: 'Denied' }), { code: 'OUT_OF_SCOPE' });
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Scoped' });
  const args = { requestId: B, threadId: A, text: 'Do not send', deadlineSeconds: 60 };
  f.handle = (s, q) => { if (q.method === 'account/read') { s.send(JSON.stringify({ id: q.id, result: { account: { type: 'apiKey' } } })); return true; } };
  f.queue = [{}]; await assert.rejects(taskSend(c, args), { code: 'UNMANAGED_QUEUE' });
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
  f.threads.get(A).cwd = f.dir + '/outside'; await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'OUT_OF_SCOPE' });
});
test('historical reservations remain accounting and never deny another approved-window send after restart', async t => {
  const f = await fixture(t); const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Historical accounting' });
  await c.store.update(s => { s.liveTurns = 18; });
  const window = await openTestWindow(c, A);
  await taskSend(c, { requestId: B, threadId: A, windowId: window.windowId, text: 'First' });
  f.threads.get(A).turns[0].status = 'completed'; f.threads.get(A).status = { type: 'idle' };
  await c.close(); c = await Controller.open(options);
  await taskSend(c, { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, windowId: window.windowId, text: 'Second' });
  assert.equal((await c.call('codex_chat_status', { threadId: A } )).historicalTestSends, 18);
});
test('timeout leaves an unresolved send blocking new prompts and never infers rejection from empty history', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state', timeoutMs: 100 }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Ambiguous' });
  f.handle = (s, q) => q.method === 'turn/start';
  const args = { requestId: B, threadId: A, text: 'Ambiguous', deadlineSeconds: 60 };
  assert.equal((await taskSend(c, args)).phase, 'unknown');
  assert.equal((await c.call('codex_chat_status', { threadId: A })).operations[0].phase, 'unknown');
  await assert.rejects(taskSend(c, { ...args, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), { code: 'SEND_UNRESOLVED' });
  assert.equal((await taskSend(c, args)).phase, 'unknown'); assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});

async function watchdog(f, t) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)), '--state-dir', f.dir + '/state', '--projects-root', f.root, '--native-socket', f.socket], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => assert.fail('watchdog startup failed'))]); return child;
}
async function mcp(f, t) {
  const client = new Client({ name: 'stage1-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./stage1-fixture-server.mjs', import.meta.url)), f.dir + '/state/control.sock'], stderr: 'pipe' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport); return { client, transport };
}
test('independent control remains available after the MCP bridge is killed', async t => {
  const f = await fixture(t); const worker = await watchdog(f, t); const { client, transport } = await mcp(f, t);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 13); assert.equal(tools.tools.find(x => x.name === 'codex_chat_stop').annotations.readOnlyHint, false);
  assert.equal(tools.tools.find(x => x.name === 'codex_chat_skills').annotations.readOnlyHint, true);
  const created = await client.callTool({ name: 'codex_chat_create', arguments: { requestId: R, repository: f.cwd, title: 'Independent deadline' } }); assert.equal(created.structuredContent.threadId, A);
  const ipc = new WatchdogClient(f.dir + '/state/control.sock');
  const window = await openTestWindow(ipc, A, 1);
  const sent = await client.callTool({ name: 'codex_chat_send', arguments: { requestId: B, threadId: A, windowId: window.windowId, text: 'Wait' } }); assert.equal(sent.structuredContent.phase, 'accepted');
  process.kill(transport.pid, 'SIGKILL'); await client.close().catch(() => {});
  const stopped = await ipc.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.phase, 'stopped');
  process.kill(worker.pid, 0); assert.equal(f.threads.get(A).turns[0].status, 'interrupted');
  worker.kill('SIGTERM'); await once(worker, 'exit'); assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
});
test('watchdog crash preserves delivery and explicit control without automatic stopping', async t => {
  const f = await fixture(t); let worker = await watchdog(f, t); const ipc = new WatchdogClient(f.dir + '/state/control.sock');
  await ipc.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Watchdog recovery' });
  await taskSend(ipc, { requestId: B, threadId: A, text: 'Wait', deadlineSeconds: 1 });
  worker.kill('SIGKILL'); await once(worker, 'exit'); await new Promise(r => setTimeout(r, 1100)); worker = await watchdog(f, t);
  const stopped = await ipc.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.phase, 'stopped');
  assert.equal((await ipc.call('codex_chat_status', { threadId: A } )).historicalTestSends, 0);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
  worker.kill('SIGTERM'); await once(worker, 'exit');
});

test('ordinary questions are answerable once; secrets and approvals stay local; disconnect makes questions stale', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Questions' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Ask', deadlineSeconds: 60 });
  const q = { threadId: A, turnId: T, itemId: 'q', isBlocking: true, questions: [{ id: 'choice', header: 'Color', question: 'Choose a color', options: [{ label: 'Blue', description: 'Use blue' }] }] };
  f.notify('item/tool/requestUserInput', q, 'ordinary');
  f.notify('item/tool/requestUserInput', { ...q, questions: [{ id: 'secret', header: 'Key', question: 'credential', isSecret: true }] }, 'secret');
  f.notify('item/commandExecution/requestApproval', { threadId: A, turnId: T }, 'approval');
  await until(async () => (await c.call('codex_chat_questions', { threadId: A })).questions.length === 1);
  const listed = await c.call('codex_chat_questions', { threadId: A }); assert.equal(listed.localSecretRequests, 1); assert.equal(listed.localApprovalRequests, 1); assert.ok(!JSON.stringify(listed).includes('credential'));
  const ref = listed.questions[0].questionRef;
  const args = { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, questionRef: ref, answers: { choice: ['Blue'] } };
  await c.call('codex_chat_answer', args); await c.call('codex_chat_answer', args);
  assert.equal(f.calls.filter(x => x.id === 'ordinary' && x.result).length, 1);
  assert.equal(f.calls.some(x => ['secret', 'approval'].includes(x.id) && x.result), false);
  f.notify('item/tool/requestUserInput', q, 'ordinary2'); await until(async () => (await c.call('codex_chat_questions', { threadId: A })).questions.length === 1);
  const stale = (await c.call('codex_chat_questions', { threadId: A })).questions[0].questionRef;
  f.disconnect(); await new Promise(r => setTimeout(r, 30));
  await assert.rejects(c.call('codex_chat_answer', { ...args, requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', questionRef: stale }), { code: 'STALE_QUESTION' });
});


test('a lost send acknowledgement reconciles after restart without repeating the prompt', async t => {
  const f = await fixture(t); const options = { socketPath: f.socket, root: f.root, stateDir: f.dir + '/state', timeoutMs: 200 };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Disposable' });
  f.handle = (s, q) => {
    if (q.method !== 'turn/start') return;
    f.threads.get(A).turns.push({ id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'u', clientId: q.params.clientUserMessageId }] });
    f.threads.get(A).status = { type: 'active' }; s.terminate(); return true;
  };
  const args = { requestId: B, threadId: A, text: 'Exactly once test', deadlineSeconds: 60 };
  assert.equal((await taskSend(c, args)).phase, 'unknown');
  await c.close(); c = await Controller.open(options);
  const state = await c.call('codex_chat_status', { threadId: A });
  assert.equal(state.operations[0].phase, 'accepted'); assert.equal(state.operations[0].turnId, T);
  assert.equal((await taskSend(c, args)).turnId, T);
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
});

test('stop separates acknowledgement from verified terminal state and preserves unrelated terminals', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Disposable' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Brief test', deadlineSeconds: 60 });
  f.threads.get(A).turns[0].items.push({ type: 'commandExecution', id: 'owned-item', processId: 'owned-process', status: 'inProgress' });
  f.terminals = [{ itemId: 'owned-item', processId: 'owned-process', cwd: f.cwd }, { itemId: 'someone-elses-item', processId: 'someone-elses-process', cwd: f.cwd }];
  f.handle = (s, q) => { if (q.method === 'turn/interrupt') { s.send(JSON.stringify({ id: q.id, result: {} })); return true; } };
  const first = await c.call('codex_chat_stop', { requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', threadId: A, turnId: T });
  assert.equal(first.acknowledged, true); assert.equal(first.verifiedStopped, false); assert.equal(first.turnTerminal, false);
  assert.equal(f.terminals.length, 1); assert.equal(f.terminals[0].processId, 'someone-elses-process');
  f.threads.get(A).turns[0].status = 'interrupted'; f.threads.get(A).status = { type: 'idle' };
  const final = await c.call('codex_chat_status', { threadId: A });
  assert.equal(final.stopVerification.turnTerminal, true);
  assert.equal(final.stopVerification.unrelatedTerminals, 1);
  assert.equal(final.stopVerification.verifiedStopped, false);
  await assert.rejects(c.call('codex_chat_stop', { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', threadId: A, turnId: 'not-owned' }), { code: 'TURN_NOT_OWNED' });
});

test('send is subscription-only, bounded, idempotent and refuses an active or unowned chat', async t => {
  const f = await fixture(t); const c = await Controller.open({ socketPath: f.socket, root: f.root, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Disposable' });
  const args = { requestId: B, threadId: A, text: 'Reply briefly', deadlineSeconds: 60 };
  const accepted = await taskSend(c, args);
  assert.equal(accepted.phase, 'accepted'); assert.equal(accepted.turnId, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(await taskSend(c, args), accepted);
  assert.equal(f.calls.filter(x => x.method === 'turn/start').length, 1);
  await assert.rejects(taskSend(c, { ...args, requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), { code: 'CHAT_ACTIVE' });
  await assert.rejects(taskSend(c, { ...args, requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', threadId: B }), { code: 'CHAT_NOT_OWNED' });
  await assert.rejects(c.call('codex_chat_send', { ...args, windowId: 'invalid', deadlineSeconds: 61 }), { code: 'INVALID_INPUT' });
  assert.equal((await c.call('codex_chat_status', { threadId: A } )).historicalTestSends, 0);
});
