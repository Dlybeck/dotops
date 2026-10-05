import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, realpath, rm, writeFile, chmod, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from '../stage1-fixture.mjs';
import { checkDarwinExecutableAcls, ACL_SCRIPT } from '../../src/stage1/platform/macos-acl.mjs';
import { verifyHelperExecutable } from '../../src/stage1/platform/macos-private-fs.mjs';
import { runInNewContext } from 'node:vm';

test('helper trust refuses a failed system ACL probe without exposing diagnostics', async () => {
  await assert.rejects(checkDarwinExecutableAcls(['/private/helper'], async () => {
    throw new Error('private diagnostic');
  }), error => error.code === 'UNSAFE_STATE_HELPER' && !error.message.includes('private diagnostic'));
});

test('system ACL probe is fixed, bounded, shell-free and passes paths as data', async () => {
  const paths = ['/private/a;$(do-not-execute)', '/private'];
  await checkDarwinExecutableAcls(paths, async (command, args, options) => {
    assert.equal(command, '/usr/bin/osascript');
    assert.deepEqual(args, ['-l', 'JavaScript', '-e', ACL_SCRIPT, ...paths]);
    assert.deepEqual(options.env, { LC_ALL: 'C' });
    assert.equal(options.timeout, 3000); assert.equal(options.maxBuffer, 1024);
    assert.equal(options.killSignal, 'SIGKILL'); assert.equal(options.shell, undefined);
    return { stdout: 'DOTOPS_ACL_SAFE\n', stderr: '' };
  });
});

for (const result of [{ stdout: '', stderr: '' }, { stdout: 'DOTOPS_ACL_SAFE\nextra', stderr: '' },
  { stdout: 'DOTOPS_ACL_SAFE\n', stderr: 'warning' }])
  test('system ACL probe rejects incomplete, extra or diagnostic output', async () => {
    await assert.rejects(checkDarwinExecutableAcls(['/private/helper'], async () => result), { code: 'UNSAFE_STATE_HELPER' });
  });

function aclFixture(acls, fault) {
  let position = 0, errno = [0]; const freed = [];
  const api = {
    acl_get_link_np: name => { position = 0; return acls[name]; },
    acl_valid: acl => !acl || fault === 'valid' ? -1 : 0,
    __error: () => errno,
    acl_get_entry: (acl, selector, ref) => {
      if (fault === 'iterate') { errno[0] = 5; return -1; }
      if (position >= acl.length) { errno[0] = 22; return -1; }
      ref[0] = acl[position++]; return 0;
    },
    acl_get_tag_type: (entry, ref) => { ref[0] = entry; return fault === 'tag' ? -1 : 0; },
    acl_free: acl => { freed.push(acl); return fault === 'free' ? -1 : 0; },
  };
  const context = { $: api, ObjC: { import() {}, bindFunction() {} }, Ref: () => [] };
  runInNewContext(ACL_SCRIPT, context, { timeout: 1000 });
  return { run: paths => context.run(paths), freed };
}

test('Darwin API boundary permits empty and deny-only ACLs and releases each receipt', () => {
  const f = aclFixture({ '/private/helper': [], '/private': [2, 2] });
  assert.equal(f.run(['/private/helper', '/private']), 'DOTOPS_ACL_SAFE');
  assert.equal(f.freed.length, 2);
});
for (const acl of [[1], [2, 1], [99], Array(129).fill(2)])
  test('Darwin API boundary rejects grant, unknown or excessive ACL entries', () => {
    const f = aclFixture({ '/private/helper': acl });
    assert.throws(() => f.run(['/private/helper']), /UNSAFE/);
    assert.equal(f.freed.length, 1);
  });
for (const fault of ['valid', 'iterate', 'tag', 'free'])
  test(`Darwin API boundary fails closed on ${fault} failure`, () => {
    assert.throws(() => aclFixture({ '/private/helper': [2] }, fault).run(['/private/helper']), /UNSAFE/);
  });
test('Darwin API boundary rejects unreadable/missing ACL instead of inventing an empty receipt', () => {
  assert.throws(() => aclFixture({}).run(['/private/helper']), /UNSAFE/);
});

test('helper trust checks executable and every ancestor ACL and rejects identity changes during the probe', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'dotops-trust-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const helper = path.join(base, 'helper'); await writeFile(helper, 'fixture', { mode: 0o700 });
  await verifyHelperExecutable(helper, async entries => {
    assert.equal(entries[0], helper); assert.equal(entries[1], base); assert.equal(entries.at(-1), '/');
  });
  await assert.rejects(verifyHelperExecutable(helper, async () => {
    await chmod(helper, 0o777);
  }), { code: 'UNSAFE_STATE_HELPER' });
  await chmod(helper, 0o700);
  await assert.rejects(verifyHelperExecutable(helper, async () => {
    await rename(helper, helper + '.old'); await writeFile(helper, 'replacement', { mode: 0o700 });
  }), { code: 'UNSAFE_STATE_HELPER' });
  await assert.rejects(verifyHelperExecutable(helper, async () => {
    await checkDarwinExecutableAcls([helper], async () => ({ stdout: 'UNSAFE\n', stderr: '' }));
  }), { code: 'UNSAFE_STATE_HELPER' });
});

test('native fixture canonicalizes an aliased temporary root before binding its socket', async t => {
  // A private short root avoids Darwin's 103-byte sockaddr_un pathname limit,
  // even when TMPDIR points into a long /private/var/folders/... hierarchy.
  const base = await realpath(await mkdtemp(path.join(await realpath('/tmp'), 'dotops-temp-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const target = path.join(base, 'target'), alias = path.join(base, 'alias');
  await mkdir(target); await symlink(target, alias);
  const f = await fixture(t, { temporaryRoot: alias });
  assert.equal(f.dir.startsWith(target + path.sep), true);
  assert.equal(await realpath(f.dir), f.dir);
  assert.equal(f.socket, path.join(f.dir, 'native.sock'));
  assert.equal(Buffer.byteLength(f.socket) <= 103, true);
  assert.equal((await lstat(f.socket)).isSocket(), true);
});
