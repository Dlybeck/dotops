import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fail } from '../safety.mjs';

async function openDirectory(entry) {
  try { return await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
  catch (error) {
    if (['ENOTDIR', 'ELOOP', 'EACCES'].includes(error.code)) fail('UNSAFE_STATE_DIRECTORY');
    throw error;
  }
}

async function initializeStateDirectory(dir) {
  const uid = process.getuid();
  let directory = await openDirectory('/');
  try {
    for (const component of dir.split('/').filter(Boolean)) {
      const parent = await directory.stat();
      // Root-owned sticky system directories (such as /tmp) may be traversed,
      // but missing directories are created only under a safe user-owned parent.
      const writable = parent.mode & 0o022;
      if (![0, uid].includes(parent.uid) || writable && !(parent.uid === 0 && parent.mode & 0o1000))
        fail('UNSAFE_STATE_DIRECTORY');
      // Linux descriptor-relative traversal avoids following a swapped ancestor
      // or a symlink while initializing a missing path. No chmod or repair.
      const entry = `/proc/self/fd/${directory.fd}/${component}`;
      let next;
      try { next = await openDirectory(entry); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (parent.uid !== uid || writable) fail('UNSAFE_STATE_DIRECTORY');
        await mkdir(entry, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        next = await openDirectory(entry);
      }
      await directory.close(); directory = next;
    }
    const leaf = await directory.stat(), current = await lstat(dir);
    if (!leaf.isDirectory() || leaf.uid !== uid || (leaf.mode & 0o777) !== 0o700 ||
        current.dev !== leaf.dev || current.ino !== leaf.ino || await realpath(dir) !== dir ||
        await realpath(`/proc/self/fd/${directory.fd}`) !== dir) fail('UNSAFE_STATE_DIRECTORY');
  } finally { await directory.close(); }
}

export class Store {
  static async open(dir) {
    if (process.platform === 'darwin') {
      const { MacStore } = await import('./platform/macos-store.mjs');
      return MacStore.open(dir);
    }
    const s = new Store(); s.dir = path.resolve(dir); s.tail = Promise.resolve();
    await initializeStateDirectory(s.dir);
    const d = await lstat(s.dir);
    if (!d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o777) !== 0o700 || await realpath(s.dir) !== s.dir) fail('UNSAFE_STATE_DIRECTORY');
    // Kernel advisory locking makes simultaneous stale-owner recovery atomic. The fixed
    // helper only holds a lock until stdin EOF; parent crashes release its pipe and lock.
    const guardPath = s.dir + '/advisory.lock';
    const guardFile = await open(guardPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try { const st = await guardFile.stat(); if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) fail('UNSAFE_STATE_LOCK'); } finally { await guardFile.close(); }
    s.guard = spawn('/usr/bin/flock', ['--nonblock', guardPath, process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"], { stdio: ['pipe', 'pipe', 'ignore'] });
    s.guard.stdin.on('error', () => {});
    s.guard.on('exit', () => { if (!s.closed) { s.lockLost = true; s.onLost?.(); } });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error()), 3000);
        s.guard.once('error', () => { clearTimeout(timer); reject(new Error()); });
        s.guard.once('exit', () => { clearTimeout(timer); reject(new Error()); });
        s.guard.stdout.once('data', b => { clearTimeout(timer); b.toString() === 'locked\n' ? resolve() : reject(new Error()); });
      });
    } catch { await s.close(); fail('WATCHDOG_ALREADY_RUNNING'); }
    s.file = s.dir + '/state.json';
    try {
      const f = await open(s.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = await f.stat(); if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 2 * 1024 * 1024) fail('UNSAFE_STATE_FILE'); s.state = JSON.parse(await f.readFile('utf8')); }
      finally { await f.close(); }
      if (s.state.version !== 1 || !s.state.operations || !s.state.threads || !Number.isInteger(s.state.liveTurns)) fail('INVALID_STATE');
    } catch (error) { if (error.code !== 'ENOENT') { await s.close(); throw error; } s.state = { version: 1, operations: {}, threads: {}, liveTurns: 0 }; }
    return s;
  }
  async update(fn) {
    const job = this.tail.then(async () => {
      if (this.lockLost || this.closed) fail('STATE_LOCK_LOST');
      const state = structuredClone(this.state); fn(state);
      const bytes = JSON.stringify(state); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) fail('STATE_FULL');
      const tmp = this.file + '.' + randomUUID();
      const f = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      await rename(tmp, this.file); const dir = await open(this.dir, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
      this.state = state;
    });
    this.tail = job.catch(() => {}); return job;
  }
  async close() {
    await this.tail; this.closed = true;
    if (this.guard?.pid && this.guard.exitCode === null && this.guard.signalCode === null) {
      await new Promise(resolve => { const timer = setTimeout(() => this.guard.kill('SIGTERM'), 2000); this.guard.once('exit', () => { clearTimeout(timer); resolve(); }); this.guard.stdin.end(); });
    }
  }
}
