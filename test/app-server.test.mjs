import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { AppServerClient, READ_METHODS } from '../src/app-server.mjs';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function fixture(t, handler) {
  const dir = await mkdtemp('/tmp/codex-dot-ws-');
  const server = http.createServer();
  const sockets = new Set(); const seen = [];
  const wss = new WebSocketServer({ server });
  wss.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', bytes => {
      const req = JSON.parse(bytes); seen.push(req);
      if (!('id' in req)) return;
      if (req.method === 'initialize') socket.send(JSON.stringify({ id: req.id, result: { userAgent: 'fixture' } }));
      else handler(socket, req, seen);
    });
  });
  const socketPath = dir + '/backend.sock';
  server.listen(socketPath); await once(server, 'listening');
  const client = new AppServerClient({ socketPath, timeoutMs: 150 });
  t.after(async () => { client.close(); for (const socket of sockets) socket.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { client, seen, sockets, socketPath };
}

test('one initialization; concurrent requests correlate reversed responses and ignore unrelated events', async t => {
  const f = await fixture(t, (socket, req) => {
    socket.send(JSON.stringify({ id: 987654, result: { secret: 'ignore' } }));
    socket.send(JSON.stringify({ method: 'approval/request', id: 'approval', params: { secret: true } }));
    setTimeout(() => socket.send(JSON.stringify({ id: req.id, result: { thread: { id: req.params.threadId } } })), req.params.threadId === A ? 40 : 5);
  });
  const result = await Promise.all([A, B].map(threadId => f.client.request('thread/read', { threadId, includeTurns: false })));
  assert.deepEqual(result.map(r => r.thread.id), [A, B]);
  assert.equal(f.seen.filter(r => r.method === 'initialize').length, 1);
  assert.ok(f.seen.every(r => ['initialize', 'initialized', ...READ_METHODS].includes(r.method)));
  assert.equal(new Set(f.seen.filter(r => 'id' in r).map(r => r.id)).size, 3);
});

test('allowlist rejects mutations and dangerous read parameters before connection', async t => {
  const f = await fixture(t, () => assert.fail('unexpected dispatch'));
  for (const [m, p] of [['turn/start', {}], ['thread/resume', { threadId: A }], ['account/read', {}], ['thread/read', { threadId: A, includeTurns: true }], ['thread/turns/list', { threadId: A, limit: 1000, itemsView: 'full' }]]) {
    await assert.rejects(f.client.request(m, p), { code: 'FORBIDDEN_RPC' });
  }
  assert.equal(f.seen.length, 0);
});

test('disconnect rejects in-flight reads without replay; next call reconnects', async t => {
  let attempts = 0;
  const f = await fixture(t, (socket, req) => {
    if (++attempts === 1) socket.terminate();
    else socket.send(JSON.stringify({ id: req.id, result: { data: [] } }));
  });
  await assert.rejects(f.client.request('thread/loaded/list', { limit: 1 }), { code: 'DAEMON_UNAVAILABLE' });
  assert.equal(attempts, 1);
  assert.deepEqual(await f.client.request('thread/loaded/list', { limit: 1 }), { data: [] });
  assert.equal(f.seen.filter(r => r.method === 'initialize').length, 2);
});

test('bounded timeout, sanitized backend errors and malformed wire data', async t => {
  for (const behavior of ['timeout', 'error', 'malformed']) {
    const f = await fixture(t, (socket, req) => {
      if (behavior === 'error') socket.send(JSON.stringify({ id: req.id, error: { code: -32600, message: 'sk-secret-path-/credentials' } }));
      if (behavior === 'malformed') socket.send('not-json');
    });
    await assert.rejects(f.client.request('thread/loaded/list', { limit: 1 }), e => {
      assert.ok(!e.message.includes('secret'));
      return e.code === ({ timeout: 'DAEMON_TIMEOUT', error: 'BACKEND_REQUEST_FAILED', malformed: 'INVALID_BACKEND_RESPONSE' })[behavior];
    });
    f.client.close();
  }
});

test('unavailable socket errors are fixed; explicit close rejects new work', async () => {
  const c = new AppServerClient({ socketPath: '/tmp/codex-dot-does-not-exist.sock', timeoutMs: 100 });
  await assert.rejects(c.request('thread/loaded/list', { limit: 1 }), { code: 'DAEMON_UNAVAILABLE' });
  c.close(); await assert.rejects(c.request('thread/loaded/list', { limit: 1 }), { code: 'DAEMON_UNAVAILABLE' });
});

test('MCP scoped tools through real stdio + WebSocket; sanitized errors and close reap child/socket', async t => {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const { mkdir } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const f = await fixture(t, (socket, req) => {
    let result;
    if (req.method === 'thread/list') result = { data: [{ id: A, cwd: f.root, source: 'cli', name: 'Scoped fixture', status: { type: 'idle' } }] };
    if (req.method === 'thread/read') result = { thread: { id: req.params.threadId, cwd: f.root } };
    if (req.method === 'thread/items/list') {
      if (req.params.threadId === B) return socket.send(JSON.stringify({ id: req.id, error: { code: -32600, message: 'VERY_SECRET_INTERNAL_PATH' } }));
      result = { data: [{ turnId: 'turn1', item: { id: 'message1', type: 'agentMessage', text: 'fixture answer' } }] };
    }
    socket.send(JSON.stringify({ id: req.id, result }));
  });
  f.root = f.socketPath.replace('/backend.sock', '/Projects'); await mkdir(f.root); await mkdir(f.root + '/.git');
  const client = new Client({ name: 'read-only-mcp-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./fixture-server.mjs', import.meta.url)), f.root, f.socketPath], stderr: 'pipe' });
  let stderr = ''; transport.stderr.on('data', c => { stderr += c; });
  t.after(async () => { await client.close(); await transport.close(); });
  await client.connect(transport, { timeout: 3000 });
  const pid = transport.pid;
  const list = await client.callTool({ name: 'codex_chats_list', arguments: {} });
  assert.equal(list.structuredContent.chats[0].threadId, A);
  const history = await client.callTool({ name: 'codex_chat_history', arguments: { threadId: A } });
  assert.equal(history.structuredContent.entries[0].text, 'fixture answer');
  const invalid = await client.callTool({ name: 'codex_chats_list', arguments: { repository: '../outside' } });
  assert.equal(invalid.isError, true);
  const denied = await client.callTool({ name: 'codex_chat_history', arguments: { threadId: B } });
  assert.equal(denied.isError, true); assert.ok(!JSON.stringify(denied).includes('VERY_SECRET'));
  assert.ok(f.seen.every(r => ['initialize', 'initialized', ...READ_METHODS].includes(r.method)));
  await client.close(); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.sockets.size, 0); assert.equal(stderr, '');
});

test('oversized backend frames fail closed without exposing payload', async t => {
  const f = await fixture(t, socket => socket.send('x'.repeat(2 * 1024 * 1024 + 1)));
  await assert.rejects(f.client.request('thread/loaded/list', { limit: 1 }), { code: 'DAEMON_UNAVAILABLE' });
});
