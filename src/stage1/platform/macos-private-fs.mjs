import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeError, fail } from '../../safety.mjs';
import { checkDarwinExecutableAcls } from './macos-acl.mjs';

export const STATE_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_HELPER = fileURLToPath(new URL('../../../native/build/dotops-private-fs', import.meta.url));
const helperErrors = new Set(['UNSAFE_STATE_DIRECTORY', 'UNSAFE_STATE_LOCK', 'UNSAFE_STATE_FILE',
  'WATCHDOG_ALREADY_RUNNING', 'STATE_LOCK_LOST', 'STATE_IO_ERROR', 'INVALID_HELPER_REQUEST', 'INVALID_STATE', 'NORMAL_USER_REQUIRED']);

export async function verifyHelperExecutable(filename, inspectAcls = process.platform === 'darwin' ? checkDarwinExecutableAcls : null) {
  try {
    if (!path.isAbsolute(filename) || await realpath(filename) !== filename) fail('UNSAFE_STATE_HELPER');
    const entries = [];
    for (let entry = filename; ; entry = path.dirname(entry)) {
      const st = await lstat(entry);
      if (![0, process.getuid()].includes(st.uid) || st.mode & 0o022 || st.isSymbolicLink()) {
        // Only root-owned sticky ancestors are traversable, never the executable.
        if (entry === filename || st.uid !== 0 || !st.isDirectory() || !(st.mode & 0o1000)) fail('UNSAFE_STATE_HELPER');
      }
      if (entry === filename && (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o7000 || !(st.mode & 0o100))) fail('UNSAFE_STATE_HELPER');
      entries.push({ path: entry, st });
      if (entry === path.dirname(entry)) break;
    }
    if (inspectAcls) await inspectAcls(entries.map(entry => entry.path));
    for (const entry of entries) {
      const current = await lstat(entry.path);
      // Directory ctime also changes for unrelated sibling creation (notably
      // root-owned sticky temp roots). It is not an ACL-change receipt.
      const keys = ['dev', 'ino', 'uid', 'gid', 'mode', ...(entry.path === filename ? ['ctimeMs'] : [])];
      if (keys.some(key => entry.st[key] !== current[key])) fail('UNSAFE_STATE_HELPER');
    }
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const pinned = await file.stat(), current = await lstat(filename);
      if (pinned.dev !== current.dev || pinned.ino !== current.ino) fail('UNSAFE_STATE_HELPER');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    fail(error.code === 'ENOENT' ? 'STATE_HELPER_NOT_BUILT' : 'UNSAFE_STATE_HELPER');
  }
}

// One in-flight frame, a fixed 2 MiB bound, and fixed response/error vocabulary.
// The executable path is an internal fixture seam; no tool or CLI accepts it.
export class PrivateJournal {
  static async open(directory, executable = DEFAULT_HELPER) {
    await verifyHelperExecutable(executable);
    const journal = new PrivateJournal();
    journal.buffer = Buffer.alloc(0);
    const ready = journal.expect('R');
    journal.child = spawn(executable, [directory], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
    journal.child.stdin.on('error', () => journal.lost());
    journal.child.stdout.on('data', bytes => journal.receive(bytes));
    journal.child.once('error', () => journal.lost('STATE_HELPER_UNAVAILABLE'));
    // Drain a fixed error frame before interpreting process exit as lock loss.
    journal.child.once('close', () => journal.lost());
    try { journal.initial = await ready; return journal; }
    catch (error) { await journal.close(); throw error; }
  }
  expect(type) {
    return new Promise((resolve, reject) => {
      this.pending = { type, resolve, reject,
        timer: setTimeout(() => this.lost('STATE_HELPER_TIMEOUT'), 3000) };
    });
  }
  receive(bytes) {
    if (this.failed || this.closed) return;
    if (this.buffer.length + bytes.length > STATE_LIMIT + 5) return this.lost('INVALID_HELPER_RESPONSE');
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length < 5) return;
    const size = this.buffer.readUInt32BE(1), type = String.fromCharCode(this.buffer[0]);
    if (size > STATE_LIMIT || (type === 'E' && size > 64)) return this.lost('INVALID_HELPER_RESPONSE');
    if (this.buffer.length < size + 5) return;
    if (this.buffer.length !== size + 5 || !this.pending ||
        (type !== 'E' && type !== this.pending.type) || (type === 'A' && size !== 0)) return this.lost('INVALID_HELPER_RESPONSE');
    const payload = this.buffer.subarray(5); this.buffer = Buffer.alloc(0);
    if (type === 'E') {
      if (payload.some(byte => byte < 65 || byte > 90 && byte !== 95)) return this.lost('INVALID_HELPER_RESPONSE');
      const code = payload.toString('ascii');
      return this.lost(helperErrors.has(code) ? code : 'INVALID_HELPER_RESPONSE');
    }
    const pending = this.pending; this.pending = null;
    clearTimeout(pending.timer); pending.resolve(payload);
  }
  lost(code = 'STATE_LOCK_LOST') {
    if (this.closed || this.failed) return;
    this.failed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new SafeError(code)); this.pending = null; }
    this.onLost?.();
    this.child?.kill('SIGTERM');
  }
  async commit(bytes) {
    if (this.failed || this.closed) fail('STATE_LOCK_LOST');
    const payload = Buffer.from(bytes);
    if (!payload.length || payload.length > STATE_LIMIT) fail('STATE_FULL');
    const header = Buffer.alloc(5); header[0] = 87; header.writeUInt32BE(payload.length, 1);
    const result = this.expect('A');
    this.child.stdin.write(Buffer.concat([header, payload]));
    await result;
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = new Promise(resolve => {
      if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return resolve();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      this.child.stdin.end();
    });
    return this.closing;
  }
}
