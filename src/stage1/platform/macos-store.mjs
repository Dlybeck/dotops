import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fail } from '../../safety.mjs';
import { PrivateJournal, STATE_LIMIT } from './macos-private-fs.mjs';

// The helper owns filesystem identity, locking and commit; JS retains the same
// version-1 state and update semantics as Linux. It receives no model prompts.
export class MacStore {
  static async open(dir, executable) {
    if (typeof dir !== 'string' || dir.includes('\0')) fail('UNSAFE_STATE_DIRECTORY');
    const store = new MacStore();
    store.dir = path.resolve(dir); store.file = path.join(store.dir, 'state.json');
    store.tail = Promise.resolve();
    store.journal = await PrivateJournal.open(store.dir, executable);
    store.journal.onLost = () => { store.lockLost = true; store.onLost?.(); };
    try {
      try {
        store.state = store.journal.initial.length
          ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(store.journal.initial))
          : { version: 1, operations: {}, threads: {}, liveTurns: 0 };
      } catch { fail('INVALID_STATE'); }
      if (store.state?.version !== 1 || !store.state.operations || !store.state.threads || !Number.isInteger(store.state.liveTurns)) fail('INVALID_STATE');
      if (store.journal.failed) fail('STATE_LOCK_LOST');
      return store;
    } catch (error) { await store.close(); throw error; }
  }
  async update(fn) {
    const job = this.tail.then(async () => {
      if (this.lockLost || this.closed) fail('STATE_LOCK_LOST');
      const state = structuredClone(this.state); fn(state);
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > STATE_LIMIT) fail('STATE_FULL');
      await this.journal.commit(bytes);
      this.state = state;
    });
    this.tail = job.catch(() => {}); return job;
  }
  async close() {
    await this.tail; this.closed = true;
    await this.journal?.close();
  }
}
