import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, realpath, copyFile, chmod, mkdir, lstat, symlink, writeFile, readdir, link, rename } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MacStore } from '../../src/stage1/platform/macos-store.mjs';
import { Controller } from '../../src/stage1/controller.mjs';
import { fixture, A, R } from '../stage1-fixture.mjs';
import { randomUUID } from 'node:crypto';

const builtHelper = fileURLToPath(new URL('../../native/build/dotops-private-fs', import.meta.url));
async function isolated(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'dotops-helper-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const helper = path.join(base, 'dotops-private-fs');
  await copyFile(builtHelper, helper); await chmod(helper, 0o700);
  return { base, helper };
}
async function opened(t, dir, helper) {
  const store = await MacStore.open(dir, helper); t.after(() => store.close()); return store;
}

test('helper-backed Store creates private parents, commits and recovers version-1 state', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'Projects/app/var/stage1');
  const store = await MacStore.open(dir, helper); t.after(() => store.close());
  await store.update(state => { state.liveTurns = 7; });
  assert.equal(JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')).liveTurns, 7);
  await store.close();
  const recovered = await MacStore.open(dir, helper); t.after(() => recovered.close());
  assert.deepEqual(recovered.state, { version: 1, operations: {}, threads: {}, liveTurns: 7 });
});

test('helper creates 0700 parents and 0600 files without repairing existing permissions', async t => {
  const { base, helper } = await isolated(t), parent = path.join(base, 'parent');
  await mkdir(parent, { mode: 0o755 }); await chmod(parent, 0o755);
  const store = await opened(t, path.join(parent, 'var/state'), helper);
  await store.update(s => { s.liveTurns = 2; });
  assert.equal((await lstat(parent)).mode & 0o777, 0o755);
  for (const name of ['var', 'var/state']) assert.equal((await lstat(path.join(parent, name))).mode & 0o777, 0o700);
  for (const name of ['state.json', 'advisory.lock']) assert.equal((await lstat(path.join(store.dir, name))).mode & 0o777, 0o600);
});

for (const kind of ['ancestor', 'leaf']) for (const collision of ['symlink', 'file'])
  test(`helper rejects ${collision} ${kind} before writing through it`, async t => {
    const { base, helper } = await isolated(t), target = path.join(base, 'target'), unsafe = path.join(base, 'unsafe');
    await mkdir(target, { mode: 0o700 });
    if (collision === 'symlink') await symlink(target, unsafe); else await writeFile(unsafe, 'preserve', { mode: 0o600 });
    await assert.rejects(MacStore.open(kind === 'ancestor' ? path.join(unsafe, 'state') : unsafe, helper), { code: 'UNSAFE_STATE_DIRECTORY' });
    assert.deepEqual(await readdir(target), []);
    if (collision === 'file') assert.equal(await readFile(unsafe, 'utf8'), 'preserve');
  });

for (const mode of [0o770, 0o777]) test(`helper refuses writable ancestor ${mode.toString(8)} without repair`, async t => {
  const { base, helper } = await isolated(t), unsafe = path.join(base, 'unsafe');
  await mkdir(unsafe); await chmod(unsafe, mode);
  await assert.rejects(MacStore.open(path.join(unsafe, 'state'), helper), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.equal((await lstat(unsafe)).mode & 0o777, mode); assert.deepEqual(await readdir(unsafe), []);
});

test('helper refuses a nonprivate leaf without repairs or journal creation', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state');
  await mkdir(dir, { mode: 0o755 }); await chmod(dir, 0o755);
  await assert.rejects(MacStore.open(dir, helper), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.equal((await lstat(dir)).mode & 0o777, 0o755); assert.deepEqual(await readdir(dir), []);
});

for (const file of ['state.json', 'advisory.lock']) for (const kind of ['symlink', 'hardlink', 'directory', 'mode'])
  test(`helper rejects unsafe ${file}: ${kind}`, async t => {
    const { base, helper } = await isolated(t), dir = path.join(base, 'state'), victim = path.join(base, 'victim');
    await mkdir(dir, { mode: 0o700 }); await writeFile(victim, 'preserve', { mode: 0o600 });
    const unsafe = path.join(dir, file);
    if (kind === 'symlink') await symlink(victim, unsafe);
    else if (kind === 'hardlink') await link(victim, unsafe);
    else if (kind === 'directory') await mkdir(unsafe, { mode: 0o700 });
    else { await writeFile(unsafe, 'preserve', { mode: 0o644 }); await chmod(unsafe, 0o644); }
    await assert.rejects(MacStore.open(dir, helper), { code: file === 'state.json' ? 'UNSAFE_STATE_FILE' : 'UNSAFE_STATE_LOCK' });
    assert.equal(await readFile(victim, 'utf8'), 'preserve');
  });

test('invalid or oversized state fails with fixed errors and releases the writer lock', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state');
  await mkdir(dir, { mode: 0o700 }); const file = path.join(dir, 'state.json');
  for (const bytes of ['', 'invalid private body', '{"version":2}', Buffer.from([0xff]), 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    await writeFile(file, bytes, { mode: 0o600 });
    await assert.rejects(async () => { const store = await MacStore.open(dir, helper); await store.close(); },
      { code: bytes.length > 2 * 1024 * 1024 ? 'UNSAFE_STATE_FILE' : 'INVALID_STATE' });
  }
  await rm(file); await opened(t, dir, helper);
});

test('simultaneous helper writers have one owner and permit recovery after close', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'nested/state');
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => MacStore.open(dir, helper)));
  const owners = results.filter(x => x.status === 'fulfilled').map(x => x.value);
  owners.forEach(store => t.after(() => store.close())); assert.equal(owners.length, 1);
  for (const result of results.filter(x => x.status === 'rejected')) assert.equal(result.reason.code, 'WATCHDOG_ALREADY_RUNNING');
  await owners[0].update(s => { s.liveTurns = 9; }); await owners[0].close();
  assert.equal((await opened(t, dir, helper)).state.liveTurns, 9);
});

test('helper death signals lost ownership and cannot commit again; another writer can recover', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state'), store = await opened(t, dir, helper);
  await store.update(s => { s.liveTurns = 4; });
  const lost = new Promise(resolve => { store.onLost = resolve; });
  store.journal.child.kill('SIGKILL'); await lost;
  await assert.rejects(store.update(s => { s.liveTurns = 5; }), { code: 'STATE_LOCK_LOST' });
  assert.equal((await opened(t, dir, helper)).state.liveTurns, 4);
});

for (const changed of ['leaf', 'ancestor', 'lock']) test(`pinned helper refuses replaced ${changed} identity`, async t => {
  const { base, helper } = await isolated(t), parent = path.join(base, 'parent'), dir = path.join(parent, 'state');
  const store = await opened(t, dir, helper); await store.update(s => { s.liveTurns = 8; });
  let oldFile;
  if (changed === 'lock') {
    await rename(path.join(dir, 'advisory.lock'), path.join(dir, 'old.lock'));
    await writeFile(path.join(dir, 'advisory.lock'), '', { mode: 0o600 }); oldFile = path.join(dir, 'state.json');
  } else {
    const old = path.join(base, 'old'); await rename(changed === 'leaf' ? dir : parent, old);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    oldFile = path.join(old, changed === 'leaf' ? 'state.json' : 'state/state.json');
  }
  await assert.rejects(store.update(s => { s.liveTurns = 10; }), { code: 'STATE_LOCK_LOST' });
  assert.equal(JSON.parse(await readFile(oldFile, 'utf8')).liveTurns, 8);
});

test('post-open directory permission change blocks commit and leaves existing state intact', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state'), store = await opened(t, dir, helper);
  await store.update(s => { s.liveTurns = 6; }); await chmod(dir, 0o777);
  await assert.rejects(store.update(s => { s.liveTurns = 10; }), { code: 'UNSAFE_STATE_DIRECTORY' });
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).liveTurns, 6);
});

test('serialized updates retain both changes and rejected callbacks or oversize writes preserve disk', async t => {
  const { base, helper } = await isolated(t), store = await opened(t, path.join(base, 'state'), helper);
  await Promise.all([store.update(s => { s.liveTurns++; }), store.update(s => { s.liveTurns++; })]);
  assert.equal(store.state.liveTurns, 2);
  const before = await readFile(store.file);
  await assert.rejects(store.update(() => { throw new Error('callback rejected'); }));
  await assert.rejects(store.update(s => { s.padding = 'x'.repeat(2 * 1024 * 1024); }), { code: 'STATE_FULL' });
  assert.deepEqual(await readFile(store.file), before);
});

test('unbuilt, writable or symlink executable is rejected before state initialization', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state'), alias = path.join(base, 'alias');
  await assert.rejects(MacStore.open(dir, path.join(base, 'missing')), { code: 'STATE_HELPER_NOT_BUILT' });
  await symlink(helper, alias); await assert.rejects(MacStore.open(dir, alias), { code: 'UNSAFE_STATE_HELPER' });
  await chmod(helper, 0o777); await assert.rejects(MacStore.open(dir, helper), { code: 'UNSAFE_STATE_HELPER' });
  await assert.rejects(lstat(dir), { code: 'ENOENT' });
});

test('Linux ACL fixture rejects access and default ACLs without creating child directories', { skip: process.platform !== 'linux' }, async t => {
  const { base, helper } = await isolated(t), run = promisify(execFile);
  for (const flags of [['-m', 'u:65534:rwx'], ['-m', 'd:u:65534:rwx']]) {
    const parent = path.join(base, flags[1].startsWith('d:') ? 'default-acl' : 'access-acl');
    await mkdir(parent, { mode: 0o700 }); await run('setfacl', [...flags, parent]);
    await assert.rejects(MacStore.open(path.join(parent, 'state'), helper), { code: 'UNSAFE_STATE_DIRECTORY' });
    assert.deepEqual(await readdir(parent), []);
  }
});

function wireFrame(type, bytes = Buffer.alloc(0)) {
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
async function rawHelper(t, dir, helper, env = {}) {
  const child = spawn(helper, [dir], { stdio: ['pipe', 'pipe', 'pipe'], env });
  const stdout = [], stderr = [];
  child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
  const done = once(child, 'close'); child.stdin.on('error', () => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await done; } });
  await once(child.stdout, 'data');
  return { child, done, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr) };
}

for (const invalid of ['unknown-command', 'oversized', 'truncated-header', 'truncated-payload'])
  test(`helper rejects ${invalid} without changing the journal or emitting payload diagnostics`, async t => {
    const { base, helper } = await isolated(t), dir = path.join(base, 'state');
    const store = await MacStore.open(dir, helper); await store.update(s => { s.liveTurns = 3; }); await store.close();
    const before = await readFile(path.join(dir, 'state.json'));
    const process = await rawHelper(t, dir, helper);
    if (invalid === 'unknown-command') process.child.stdin.end(wireFrame('X'));
    if (invalid === 'oversized') { const b = wireFrame('W'); b.writeUInt32BE(2 * 1024 * 1024 + 1, 1); process.child.stdin.end(b); }
    if (invalid === 'truncated-header') process.child.stdin.end(Buffer.from('W'));
    if (invalid === 'truncated-payload') { const b = wireFrame('W', Buffer.from('fixture')); process.child.stdin.end(b.subarray(0, 6)); }
    const [code] = await process.done; assert.equal(code, 1);
    const out = process.stdout(), initialLength = out.readUInt32BE(1) + 5;
    assert.equal(out.subarray(initialLength).toString().slice(5), 'INVALID_HELPER_REQUEST');
    assert.equal(process.stderr().length, 0); assert.deepEqual(await readFile(path.join(dir, 'state.json')), before);
    assert.equal((await opened(t, dir, helper)).state.liveTurns, 3);
  });

test('EOF closes the helper and parent crash releases its kernel lock without replay', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state');
  const process = await rawHelper(t, dir, helper); process.child.stdin.end(); assert.equal((await process.done)[0], 0);
  const module = new URL('../../src/stage1/platform/macos-store.mjs', import.meta.url).href;
  const code = `import {MacStore} from ${JSON.stringify(module)}; const store=await MacStore.open(${JSON.stringify(dir)},${JSON.stringify(helper)}); await store.update(s=>{s.liveTurns=12;}); console.log('ready'); setInterval(()=>{},1000);`;
  const parent = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(parent, 'close');
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await done; } });
  assert.equal((await once(parent.stdout, 'data'))[0].toString(), 'ready\n');
  parent.kill('SIGKILL'); await done;
  assert.equal((await opened(t, dir, helper)).state.liveTurns, 12);
});

test('a crash while receiving a replacement leaves the last acknowledged state intact', async t => {
  const { base, helper } = await isolated(t), dir = path.join(base, 'state');
  const store = await MacStore.open(dir, helper); await store.update(s => { s.liveTurns = 8; }); await store.close();
  const process = await rawHelper(t, dir, helper);
  const partial = wireFrame('W', Buffer.alloc(1000));
  process.child.stdin.write(partial.subarray(0, 20)); process.child.kill('SIGKILL'); await process.done;
  assert.equal((await opened(t, dir, helper)).state.liveTurns, 8);
});

for (const response of ['unexpected-ack', 'duplicate-ready', 'oversized-frame', 'unknown-error', 'invalid-ascii-error'])
  test(`Store refuses malformed helper response: ${response}`, async t => {
    const { base } = await isolated(t), fake = path.join(base, 'fake-helper');
    let bytes = response === 'unexpected-ack' ? wireFrame('A') : response === 'duplicate-ready' ? Buffer.concat([wireFrame('R'), wireFrame('R')])
      : response === 'unknown-error' ? wireFrame('E', Buffer.from('PRIVATE_PAYLOAD')) : response === 'invalid-ascii-error' ? wireFrame('E', Buffer.from([0xff])) : wireFrame('R');
    if (response === 'oversized-frame') bytes.writeUInt32BE(2 * 1024 * 1024 + 1, 1);
    await writeFile(fake, `#!${process.execPath}\nprocess.stdout.write(Buffer.from('${bytes.toString('hex')}','hex'));process.stdin.resume();\n`, { mode: 0o700 });
    await assert.rejects(MacStore.open(path.join(base, 'state'), fake), { code: 'INVALID_HELPER_RESPONSE' });
  });

// Controller execution identity/context/socket guards are still Linux-only;
// this checks the controller's unchanged state contract through the new store.
test('Linux controller keeps goal previews transient and exact-operation closure across helper-backed restart', { skip: process.platform !== 'linux' }, async t => {
  const { helper } = await isolated(t), f = await fixture(t);
  const options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  const swapStore = async () => {
    await c.store.close(); c.store = await MacStore.open(options.stateDir, helper);
    c.store.onLost = () => { c.failed = true; c.native.close(); };
  };
  await swapStore(); await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Helper privacy fixture' });
  const objective = 'Private objective fixture that must remain transient';
  const status = await c.call('codex_chat_status', { threadId: A });
  const args = { requestId: randomUUID(), threadId: A, action: 'set', objective, expectedGoalHash: status.admission.nativeGoalHash };
  const result = await c.call('codex_chat_goal', args); assert.equal(result.goal.objective.text, objective);
  f.goal.status = 'paused';
  const closed = await c.call('codex_chat_status', { threadId: A });
  assert.equal(closed.admission.ownedContinuations.open, 0);
  const operation = c.store.state.operations[args.requestId]; assert.equal(operation.ownedGoalClosure.version, 1);
  f.goal.status = 'active'; await c.close(); c = await Controller.open(options); await swapStore();
  assert.equal((await c.call('codex_chat_status', { threadId: A })).admission.ownedContinuations.open, 0);
  const replay = await c.call('codex_chat_goal', args); assert.equal(replay.goal.objective, undefined);
  const observed = await c.call('codex_chat_status', { threadId: A });
  await c.call('codex_chat_goal', { requestId: randomUUID(), threadId: A, action: 'clear', expectedGoalHash: observed.admission.nativeGoalHash });
  assert.equal(f.goal, null);
  assert.equal((await readFile(c.store.file, 'utf8')).includes(objective), false);
  assert.equal(JSON.stringify(c.store.state).includes(objective), false);
});

for (const fault of ['file-sync', 'rename', 'directory-sync', 'crash-before-rename'])
  test(`Linux syscall fixture preserves commit uncertainty and recoverability: ${fault}`, { skip: process.platform !== 'linux' }, async t => {
    const { base, helper } = await isolated(t), dir = path.join(base, 'state');
    const store = await MacStore.open(dir, helper); await store.update(s => { s.liveTurns = 8; }); await store.close();
    const library = path.join(base, 'fs-faults.so');
    await copyFile(fileURLToPath(new URL('../../native/build/fs-faults.so', import.meta.url)), library);
    const child = await rawHelper(t, dir, helper, { LD_PRELOAD: library, DOTOPS_FIXTURE_FAULT: fault });
    const replacement = Buffer.from(JSON.stringify({ version: 1, operations: {}, threads: {}, liveTurns: 9 }));
    child.child.stdin.write(wireFrame('W', replacement)); const [code] = await child.done;
    assert.equal(code, fault === 'crash-before-rename' ? 77 : 1);
    assert.equal(child.stderr().length, 0);
    const output = child.stdout(), afterReady = output.subarray(output.readUInt32BE(1) + 5);
    if (fault === 'crash-before-rename') assert.equal(afterReady.length, 0);
    else { assert.equal(afterReady[0], 'E'.charCodeAt(0)); assert.equal(afterReady.subarray(5).toString(), 'STATE_IO_ERROR'); }
    const recovered = await opened(t, dir, helper);
    assert.equal(recovered.state.liveTurns, fault === 'directory-sync' ? 9 : 8);
    for (const name of await readdir(dir)) assert.equal((await lstat(path.join(dir, name))).mode & 0o777, 0o600);
    if (fault !== 'crash-before-rename') assert.deepEqual((await readdir(dir)).sort(), ['advisory.lock', 'state.json']);
  });
