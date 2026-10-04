import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const freshNonce = () => randomBytes(32).toString('hex');
const isStopped = pid => {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
};

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  const label = typeof mode === 'string' ? mode : mode.pin;
  test(`SDK protocol: ${label}`, async t => {
    const client = new Client({ name: 'probe-local-test', version: '0.1.0' }, {
      versionNegotiation: { mode },
    });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [serverPath], stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk; });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport, { timeout: 5000 });
    const pid = transport.pid;
    assert.equal(typeof pid, 'number');
    assert.deepEqual(client.getServerVersion(), { name: 'codex-dot-probe', version: '0.1.0' });
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities.tools);
    for (const forbidden of ['resources', 'prompts', 'logging', 'tasks']) {
      assert.equal(capabilities[forbidden], undefined);
    }
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['connectivity_probe', 'codex_repositories_list', 'codex_chats_list', 'codex_chat_history']);
    for (const tool of tools) assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tools[0].inputSchema.required, ['nonce']);
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.deepEqual(tools[0].annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });

    await t.test('random nonce echo contains only nonce and fixed identity', async () => {
      for (const nonce of [freshNonce(), freshNonce(), 'A'.repeat(32), '_'.repeat(128)]) {
        const result = await client.callTool({ name: 'connectivity_probe', arguments: { nonce } });
        assert.equal(result.isError, undefined);
        const expected = { nonce, identity: 'codex-dot-probe-v1' };
        assert.deepEqual(result.structuredContent, expected);
        assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(expected) }]);
      }
    });

    for (const [name, args] of [
      ['missing', {}], ['number', { nonce: 42 }], ['null', { nonce: null }],
      ['empty', { nonce: '' }], ['short', { nonce: 'a'.repeat(31) }],
      ['long', { nonce: 'a'.repeat(129) }], ['whitespace', { nonce: ' '.repeat(32) }],
      ['extra field', { nonce: freshNonce(), command: 'ignored' }],
    ]) {
      await t.test(`rejects ${name} input`, async () => {
        const result = await client.callTool({ name: 'connectivity_probe', arguments: args });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
      });
    }
    await t.test('unknown tool is rejected', async () => {
      await assert.rejects(client.callTool({ name: 'unregistered_tool', arguments: {} }));
    });
    await t.test('client close reaps its server', async () => {
      await client.close();
      isStopped(pid);
      assert.equal(stderr, '');
    });
  });
}

function rawServer(t) {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  });
  // Wait for close so all stdout/stderr data is drained before assertions.
  const exited = once(child, 'close');
  return { child, exited };
}

// Deliberately raw input checks the SDK wire parser and the process lifecycle.
const initialize = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } },
};

test('malformed JSON is contained; valid MCP initialization still works', async t => {
  const { child, exited } = rawServer(t);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const response = once(lines, 'line');
  child.stdin.write(`not-json\n{}\n${JSON.stringify(initialize)}\n`);
  const [line] = await response;
  const message = JSON.parse(line);
  assert.equal(message.id, 1);
  assert.equal(message.result.serverInfo.name, 'codex-dot-probe');
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stderr, 'MCP transport error.\n');
  isStopped(child.pid);
});

test('EOF before initialization exits cleanly', async t => {
  const { child, exited } = rawServer(t);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
  isStopped(child.pid);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} after initialization exits cleanly`, async t => {
    const { child, exited } = rawServer(t);
    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    const response = once(lines, 'line');
    child.stdin.write(`${JSON.stringify(initialize)}\n`);
    const [line] = await response;
    assert.equal(JSON.parse(line).id, 1);
    child.kill(signal);
    assert.deepEqual(await exited, [0, null]);
    isStopped(child.pid);
  });
}
