import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

test('default native fixture advertises a usable canonical socket with a long valid TMPDIR', async t => {
  const base = await realpath(await mkdtemp(path.join(await realpath('/tmp'), 'dot-fixture-env-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const temporaryRoot = path.join(base, 'x'.repeat(86 - Buffer.byteLength(base) - 1));
  await mkdir(temporaryRoot, { mode: 0o700 });
  const fixtureUrl = new URL('./stage1-fixture.mjs', import.meta.url).href;
  const nativeUrl = new URL('../src/stage1/native.mjs', import.meta.url).href;
  const controllerUrl = new URL('../src/stage1/controller.mjs', import.meta.url).href;
  // A separate process exercises the default without changing concurrent tests'
  // environment. All RPCs target the temporary fixture, never a live server.
  const source = `
    import assert from 'node:assert/strict';
    import { lstat, realpath } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { fixture, A, R } from ${JSON.stringify(fixtureUrl)};
    import { Native } from ${JSON.stringify(nativeUrl)};
    import { Controller } from ${JSON.stringify(controllerUrl)};
    const cleanups = []; let client;
    try {
      assert.equal(Buffer.byteLength(tmpdir()), 86);
      const f = await fixture({ after: fn => cleanups.push(fn) });
      assert.equal(await realpath(f.dir), f.dir);
      assert.equal((await lstat(f.socket)).isSocket(), true);
      assert.equal(Buffer.byteLength(f.socket) <= 103, true);
      client = new Native({ socketPath: f.socket });
      assert.equal((await client.request('account/read', { refreshToken: false })).account.type, 'chatgpt');
      client.close(); client = null;
      if (process.platform === 'linux') {
        client = await Controller.open({ accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' });
        const result = await client.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Socket fixture' });
        assert.equal(result.threadId, A);
        assert.equal(f.calls.some(call => call.method === 'thread/start'), true);
      }
      console.log('DEFAULT_SOCKET_OK');
    } finally {
      await client?.close();
      for (const cleanup of cleanups) await cleanup();
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source],
    { env: { ...process.env, TMPDIR: temporaryRoot }, timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 65536 });
  assert.equal(stdout, 'DEFAULT_SOCKET_OK\n'); assert.equal(stderr, '');
});
