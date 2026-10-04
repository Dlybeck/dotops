import { taskSend, openTestWindow } from './task-window-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { fixture, A, R, B } from './stage1-fixture.mjs';
import { Controller } from '../src/stage1/controller.mjs';

test('expanded mode creates a chat in an accessible non-Git directory outside Projects, preserving default scope', async t => {
  const f = await fixture(t); const outside = f.dir + '/ordinary'; await mkdir(outside);
  const args = { requestId: R, repository: outside, title: 'Ordinary directory' };
  const restricted = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/restricted' }); t.after(() => restricted.close());
  await assert.rejects(restricted.call('codex_chat_create', args), { code: 'OUT_OF_SCOPE' });
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/expanded' }); t.after(() => c.close());
  const result = await c.call('codex_chat_create', args); assert.equal(result.cwd, outside); assert.equal(result.modelTurnStarted, false);
  assert.deepEqual(f.calls.find(q => q.method === 'thread/start').params, { cwd: outside, historyMode: 'legacy' });
  const alias = f.dir + '/alias'; await symlink(outside, alias);
  const status = await c.call('codex_chat_status', { threadId: A }); assert.equal(status.cwd, outside);
  await assert.rejects(c.call('codex_chat_create', { ...args, requestId: B, repository: outside + '/missing' }), { code: 'OUT_OF_SCOPE' });
});

test('explicit adoption pins an existing idle root chat and is durable without resume, renaming or a model turn', async t => {
  const f = await fixture(t); const outside = f.dir + '/notes'; await mkdir(outside);
  f.threads.set(A, { ...f.thread(), cwd: outside, name: 'Keep my title' });
  const options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  const args = { requestId: R, threadId: A, expectedCwd: outside };
  const adopted = await c.call('codex_chat_adopt', args);
  assert.equal(adopted.phase, 'accepted'); assert.equal(adopted.modelTurnStarted, false);
  assert.equal((await c.call('codex_chat_status', { threadId: A })).title, 'Keep my title');
  await c.close(); c = await Controller.open(options);
  assert.deepEqual(await c.call('codex_chat_adopt', args), adopted);
  await assert.rejects(c.call('codex_chat_adopt', { ...args, expectedCwd: f.cwd }), { code: 'REQUEST_ID_CONFLICT' });
  assert.ok(f.calls.every(q => ['initialize', 'initialized', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/backgroundTerminals/list', 'thread/goal/get', 'thread/queue/list'].includes(q.method)));
  assert.equal((await c.call('codex_chat_status', { threadId: A })).historicalTestSends, 0);
});

const sendArgs = { requestId: B, threadId: A, text: 'Fixture text only', deadlineSeconds: 60, expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true };
test('expanded sends require an explicit idle snapshot and cannot acquire stop authority over unrelated existing turns', async t => {
  const f = await fixture(t); f.threads.set(A, f.thread());
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_adopt', { requestId: R, threadId: A, expectedCwd: f.cwd });
  await assert.rejects(taskSend(c, { requestId: B, threadId: A, text: 'Missing snapshot', deadlineSeconds: 60 }), { code: 'EXPLICIT_START_REQUIRED' });
  f.threads.get(A).turns.push({ id: 'old-ui-turn', status: 'completed', items: [] });
  await assert.rejects(taskSend(c, sendArgs), { code: 'CHAT_CHANGED' });
  const args = { ...sendArgs, expectedLastTurnId: 'old-ui-turn' };
  f.handle = (s, q) => { if (q.method === 'turn/start') { f.threads.get(A).turns[0].items.push({ type: 'userMessage', clientId: B }); s.send(JSON.stringify({ id: q.id, result: { turn: { id: 'old-ui-turn' } } })); return true; } };
  const result = await taskSend(c, args); assert.equal(result.phase, 'unknown'); assert.equal(result.code, 'UNEXPECTED_NATIVE_TURN');
  assert.equal((await c.call('codex_chat_status', { threadId: A })).operations[0].turnId, null);
  await assert.rejects(c.call('codex_chat_stop', { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', threadId: A, turnId: 'old-ui-turn' }), { code: 'TURN_NOT_OWNED' });
  assert.equal(f.calls.some(q => q.method === 'turn/interrupt'), false);
});

test('expanded discovery finds and reads non-Git chats outside Projects with bounded history and filter cursors', async t => {
  const { Discovery } = await import('../src/discovery.mjs');
  const { UserDirectoryScope } = await import('../src/safety.mjs');
  const { AppServerClient } = await import('../src/app-server.mjs');
  const f = await fixture(t); const outside = f.dir + '/notes'; await mkdir(outside);
  f.threads.set(A, { ...f.thread(), cwd: outside });
  f.handle = (s, q) => {
    if (q.method === 'thread/list') { s.send(JSON.stringify({ id: q.id, result: { data: [...f.threads.values()], nextCursor: null } })); return true; }
    if (q.method === 'thread/items/list') { s.send(JSON.stringify({ id: q.id, result: { data: [{ turnId: 'old', item: { id: 'message', type: 'agentMessage', text: 'Authorized text' } }], nextCursor: null } })); return true; }
  };
  const d = new Discovery({ scope: new UserDirectoryScope(), backend: new AppServerClient({ socketPath: f.socket }) }); t.after(() => d.close());
  const chats = await d.call('codex_chats_list', { limit: 10 }); assert.equal(chats.chats[0].cwd, outside); assert.equal(chats.chats[0].repository, outside);
  assert.equal((await d.call('codex_chats_list', { repository: outside, limit: 10 })).chats.length, 1);
  const history = await d.call('codex_chat_history', { threadId: A, limit: 1, maxChars: 200 }); assert.equal(history.entries[0].text, 'Authorized text');
  assert.ok(f.calls.filter(q => q.method === 'thread/read').every(q => q.params.includeTurns === false));
  assert.equal(f.calls.some(q => ['thread/resume', 'turn/start'].includes(q.method)), false);
});

test('adoption rejects active, mismatched, child and unmanaged or unknown targets without native mutations', async t => {
  const f = await fixture(t); f.threads.set(A, f.thread());
  const args = { requestId: R, threadId: A, expectedCwd: f.cwd };
  const restricted = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/restricted' }); t.after(() => restricted.close());
  await assert.rejects(restricted.call('codex_chat_adopt', args), { code: 'EXPANDED_ACCESS_DISABLED' });
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await assert.rejects(c.call('codex_chat_adopt', { ...args, expectedCwd: f.root }), { code: 'EXPECTED_CWD_MISMATCH' });
  f.threads.get(A).status = { type: 'active' }; await assert.rejects(c.call('codex_chat_adopt', args), { code: 'CHAT_ACTIVE' });
  f.threads.get(A).status = { type: 'idle' }; f.threads.get(A).parentThreadId = B; await assert.rejects(c.call('codex_chat_adopt', args), { code: 'INVALID_CHAT_TARGET' });
  f.threads.get(A).parentThreadId = null;
  f.goal = null; f.queue = [{}]; await assert.rejects(c.call('codex_chat_adopt', args), { code: 'UNMANAGED_QUEUE' });
  f.queue = []; f.handle = (s, q) => { if (q.method === 'thread/queue/list') { s.send(JSON.stringify({ id: q.id, error: { code: -32601 } })); return true; } };
  await assert.rejects(c.call('codex_chat_adopt', args), { code: 'WORK_STATE_UNVERIFIED' });
  f.handle = null;
  let reads = 0;
  f.handle = (s, q) => { if (q.method === 'thread/read' && ++reads === 2) { f.threads.get(A).status = { type: 'active' }; s.send(JSON.stringify({ id: q.id, result: { thread: f.threads.get(A) } })); return true; } };
  await assert.rejects(c.call('codex_chat_adopt', args), { code: 'CHAT_ACTIVE' });
  await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'CHAT_NOT_OWNED' });
  assert.equal(f.calls.some(q => ['thread/resume', 'turn/start', 'turn/interrupt', 'thread/name/set'].includes(q.method)), false);
});


test('expanded access preserves consumed stage-1 reservations without a development count gate', async t => {
  const { randomUUID } = await import('node:crypto');
  const f = await fixture(t); const stateDir = f.dir + '/state';
  let c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Legacy budget' });
  await c.store.update(state => { state.liveTurns = 6; });
  f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: randomUUID(), status: 'inProgress', itemsView: 'full', items: [{ type: 'userMessage', id: randomUUID(), clientId: q.params.clientUserMessageId, content: q.params.input }] };
    f.threads.get(A).turns.push(turn); f.threads.get(A).status = { type: 'active' };
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  for (let i = 0; i < 6; i++) {
    await taskSend(c, { requestId: randomUUID(), threadId: A, text: 'Fixture only', deadlineSeconds: 60 });
    f.threads.get(A).turns.at(-1).status = 'completed'; f.threads.get(A).turns.at(-1).itemsView = 'full'; f.threads.get(A).status = { type: 'idle' };
  }
  await c.close(); c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir });
  const status = await c.call('codex_chat_status', { threadId: A }); assert.equal(status.historicalTestSends, 6);
  await taskSend(c, { ...sendArgs, expectedLastTurnId: status.latestTurnId });
  assert.equal((await c.call('codex_chat_status', { threadId: A } )).historicalTestSends, 6);
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 7);
});

test('normal-user directory checks canonicalize aliases and reject unreadable traversal, files and vanished targets', async t => {
  const { UserDirectoryScope } = await import('../src/safety.mjs');
  const { chmod, writeFile, unlink } = await import('node:fs/promises');
  const f = await fixture(t); const scope = new UserDirectoryScope();
  const outside = f.dir + '/notes'; await mkdir(outside);
  await symlink(outside, f.dir + '/alias'); assert.equal(await scope.directory(f.dir + '/alias'), outside);
  await writeFile(f.dir + '/file', 'fixture');
  await mkdir(f.dir + '/denied'); await chmod(f.dir + '/denied', 0); t.after(() => chmod(f.dir + '/denied', 0o700).catch(() => {}));
  for (const target of [f.dir + '/file', f.dir + '/missing', f.dir + '/denied', 'relative', '/tmp/\ninvalid']) await assert.rejects(scope.directory(target), { code: 'OUT_OF_SCOPE' });
  await chmod(f.dir + '/denied', 0o700);
  f.threads.set(A, { ...f.thread(), cwd: f.dir + '/alias' });
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_adopt', { requestId: R, threadId: A, expectedCwd: outside });
  await unlink(f.dir + '/alias'); await symlink(f.cwd, f.dir + '/alias');
  await assert.rejects(c.call('codex_chat_status', { threadId: A }), { code: 'OUT_OF_SCOPE' });
});

test('the expanded bridge and watchdog expose adoption over private IPC without exposing it in stage 1', async t => {
  const { spawn } = await import('node:child_process'); const { once } = await import('node:events');
  const { fileURLToPath } = await import('node:url'); const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const f = await fixture(t); f.threads.set(A, f.thread());
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)), '--state-dir', f.dir + '/state', '--native-socket', f.socket, '--access-mode', 'user-directories'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await once(worker, 'exit'); } });
  await Promise.race([once(worker.stdout, 'data'), once(worker, 'exit').then(() => assert.fail('watchdog failed'))]);
  const client = new Client({ name: 'expanded-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./stage1-fixture-server.mjs', import.meta.url)), f.dir + '/state/control.sock', '--expanded'], stderr: 'pipe' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport); const tools = await client.listTools(); assert.equal(tools.tools.length, 14);
  assert.equal(tools.tools.find(x => x.name === 'codex_chat_skills').annotations.readOnlyHint, true);
  assert.ok(tools.tools.some(x => x.name === 'codex_chat_adopt'));
  assert.equal(tools.tools.find(x => x.name === 'codex_chat_reconcile').annotations.readOnlyHint, false);
  const args = { requestId: R, threadId: A, expectedCwd: f.cwd };
  const adopted = await client.callTool({ name: 'codex_chat_adopt', arguments: args }); assert.equal(adopted.structuredContent.phase, 'accepted');
  assert.deepEqual((await client.callTool({ name: 'codex_chat_adopt', arguments: args })).structuredContent, adopted.structuredContent);
  const denied = await client.callTool({ name: 'codex_chat_adopt', arguments: { ...args, requestId: B, expectedCwd: f.root } }); assert.equal(denied.isError, true);
  const status = await client.callTool({ name: 'codex_chat_status', arguments: { threadId: A } }); assert.equal(status.structuredContent.historicalTestSends, 0);
  assert.equal(f.calls.some(q => ['turn/start', 'thread/resume'].includes(q.method)), false);
});

test('a previously unobserved UI turn racing native start does not become owned merely because it contains our message', async t => {
  const f = await fixture(t); f.threads.set(A, f.thread());
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_adopt', { requestId: R, threadId: A, expectedCwd: f.cwd });
  f.handle = (s, q) => {
    if (q.method !== 'turn/start') return;
    const turn = { id: 'racing-ui-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: 'native-ui-message' }, { type: 'userMessage', clientId: B }] };
    f.threads.get(A).turns.push(turn); f.threads.get(A).status = { type: 'active' };
    s.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  const args = { ...sendArgs, deadlineSeconds: 1 }; const sent = await taskSend(c, args);
  assert.equal(sent.phase, 'unknown'); assert.equal(sent.code, 'TURN_ORIGIN_UNVERIFIED');
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await c.call('codex_chat_status', { threadId: A })).operations[0].turnId, null);
  assert.equal((await taskSend(c, args)).phase, 'unknown');
  await assert.rejects(c.call('codex_chat_stop', { requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', threadId: A, turnId: 'racing-ui-turn' }), { code: 'TURN_NOT_OWNED' });
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1); assert.equal(f.calls.some(q => q.method === 'turn/interrupt'), false);
});



test('expanded creation reports an unusable native lineage without duplicating creation or starting a turn', async t => {
  const f = await fixture(t);
  f.handle = (s, q) => { if (q.method === 'thread/turns/list') { s.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'invalid paginated history lineage: missing source rollout' } })); return true; } };
  const c = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  const args = { requestId: R, repository: f.cwd, title: 'Disposable fixture' };
  const result = await c.call('codex_chat_create', args);
  assert.equal(result.phase, 'unknown'); assert.equal(result.threadId, A); assert.equal(result.code, 'TURN_STATE_UNVERIFIED');
  assert.deepEqual(await c.call('codex_chat_create', args), result);
  assert.equal(f.calls.filter(q => q.method === 'thread/start').length, 1);
  const status = await c.call('codex_chat_status', { threadId: A });
  assert.equal(status.latestTurnStateKnown, false); assert.equal(status.historicalTestSends, 0);
  await assert.rejects(taskSend(c, sendArgs), { code: 'TURN_STATE_UNVERIFIED' });
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
});

test('a legacy blank chat retains verified empty history across restart and supports its first correlated fixture turn', async t => {
  const f = await fixture(t);
  f.handle = (s, q) => {
    if (q.method === 'thread/start') {
      const thread = { ...f.thread(), cwd: q.params.cwd, historyMode: q.params.historyMode ?? 'paginated' };
      f.threads.set(A, thread); s.send(JSON.stringify({ id: q.id, result: { thread } })); return true;
    }
    if (q.method === 'thread/turns/list' && f.threads.get(A).historyMode !== 'legacy') {
      s.send(JSON.stringify({ id: q.id, error: { code: -32600, message: 'invalid paginated history lineage: missing source rollout' } })); return true;
    }
  };
  const options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  const args = { requestId: R, repository: f.cwd, title: 'Legacy native fixture' };
  const created = await c.call('codex_chat_create', args); assert.equal(created.phase, 'accepted');
  let status = await c.call('codex_chat_status', { threadId: A });
  assert.equal(status.latestTurnStateKnown, true); assert.equal(status.latestTurnId, null); assert.equal(status.historicalTestSends, 0);
  await c.close(); c = await Controller.open(options);
  assert.deepEqual(await c.call('codex_chat_create', args), created);
  const sent = await taskSend(c, sendArgs); assert.equal(sent.phase, 'accepted');
  status = await c.call('codex_chat_status', { threadId: A }); assert.equal(status.historicalTestSends, 0);
  assert.deepEqual(f.calls.find(q => q.method === 'thread/resume').params, { threadId: A, excludeTurns: true });
  assert.equal(f.calls.filter(q => q.method === 'thread/start').length, 1);
});
