import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, rm, mkdir, chmod, symlink, readdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/stage1/store.mjs';

async function isolatedDirectory(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'dotops-state-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

test('fresh nested journal creates private parents and preserves state on repeat startup', async t => {
  const base = await isolatedDirectory(t);
  const dir = path.join(base, 'Projects/codex-dot-connector/var/stage1');
  const store = await Store.open(dir); t.after(() => store.close());
  await store.update(state => { state.liveTurns = 7; });
  for (const relative of ['Projects', 'Projects/codex-dot-connector', 'Projects/codex-dot-connector/var', 'Projects/codex-dot-connector/var/stage1']) {
    const stat = await lstat(path.join(base, relative));
    assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o700);
  }
  await store.close();
  const reopened = await Store.open(dir); t.after(() => reopened.close());
  assert.equal(reopened.state.liveTurns, 7);
});

test('existing safe readable parent permissions remain unchanged during journal initialization', async t => {
  const base = await isolatedDirectory(t), parent = path.join(base, 'existing');
  await mkdir(parent, { mode: 0o755 }); await chmod(parent, 0o755);
  const store = await Store.open(path.join(parent, 'var/stage1')); t.after(() => store.close());
  assert.equal((await lstat(parent)).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(parent, 'var'))).mode & 0o777, 0o700);
});

for (const mode of [0o770, 0o777]) test(`writable ancestor is rejected without creation or permission repair: ${mode.toString(8)}`, async t => {
  const base = await isolatedDirectory(t), parent = path.join(base, 'unsafe');
  await mkdir(parent); await chmod(parent, mode);
  await assert.rejects(async () => {
    const store = await Store.open(path.join(parent, 'stage1')); await store.close();
  }, { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.deepEqual(await readdir(parent), []);
  assert.equal((await lstat(parent)).mode & 0o777, mode);
});

for (const kind of ['ancestor', 'leaf']) test(`symlink ${kind} is rejected before writing through its target`, async t => {
  const base = await isolatedDirectory(t), target = path.join(base, 'target'), alias = path.join(base, 'alias');
  await mkdir(target, { mode: 0o700 }); await symlink(target, alias);
  await assert.rejects(Store.open(kind === 'ancestor' ? path.join(alias, 'stage1') : alias), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.deepEqual(await readdir(target), []);
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});

for (const kind of ['ancestor', 'leaf']) test(`file ${kind} collision is rejected and preserved`, async t => {
  const base = await isolatedDirectory(t), collision = path.join(base, 'existing');
  await writeFile(collision, 'Preserved collision fixture', { mode: 0o600 });
  await assert.rejects(Store.open(kind === 'ancestor' ? path.join(collision, 'var/stage1') : collision), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.equal(await readFile(collision, 'utf8'), 'Preserved collision fixture');
});

test('nonprivate existing leaf is rejected without permission repair or journal writes', async t => {
  const base = await isolatedDirectory(t), dir = path.join(base, 'stage1');
  await mkdir(dir, { mode: 0o755 }); await chmod(dir, 0o755);
  await assert.rejects(Store.open(dir), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await lstat(dir)).mode & 0o777, 0o755);
});

test('concurrent fresh initialization retains exactly one journal writer and recovers on repeat startup', async t => {
  const base = await isolatedDirectory(t), dir = path.join(base, 'Projects/app/var/stage1');
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => Store.open(dir)));
  const owners = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  for (const store of owners) t.after(() => store.close());
  assert.equal(owners.length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'WATCHDOG_ALREADY_RUNNING');
  await owners[0].update(state => { state.liveTurns = 9; }); await owners[0].close();
  const recovered = await Store.open(dir); t.after(() => recovered.close());
  assert.equal(recovered.state.liveTurns, 9);
});

test('watchdog first and repeat startup work with missing parents and no native daemon', async t => {
  const base = await isolatedDirectory(t), dir = path.join(base, 'Projects/app/var/stage1');
  for (let attempt = 0; attempt < 2; attempt++) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)),
      '--state-dir', dir, '--native-socket', path.join(base, 'absent-native.sock'), '--access-mode', 'user-directories'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } });
    const ready = await Promise.race([once(child.stdout, 'data').then(([bytes]) => bytes.toString()), exited.then(() => 'exited before ready')]);
    assert.equal(ready, 'Stage 1 watchdog ready.\n');
    assert.equal((await lstat(path.join(dir, 'control.sock'))).mode & 0o777, 0o600);
    assert.equal((await lstat(path.join(dir, 'state.json'))).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).version, 1);
    child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0);
  }
});
