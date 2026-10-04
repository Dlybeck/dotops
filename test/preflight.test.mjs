import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readOnlyPreflight, targetJournalFingerprint } from '../scripts/reliability-preflight.mjs';
import { fixture, A, B, R } from './stage1-fixture.mjs';
import { Controller } from '../src/stage1/controller.mjs';
import { taskSend } from './task-window-fixture.mjs';

test('actual-history preflight reads isolated native state without changing any journal or replaying sends', async t => {
  const f = await fixture(t);
  const c = await Controller.open({ root: f.root, socketPath: f.socket, stateDir: f.dir + '/state' }); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Preflight fixture' });
  await taskSend(c, { requestId: B, threadId: A, text: 'Fixture only' });
  f.threads.get(A).turns[0].status = 'completed'; f.threads.get(A).turns[0].itemsView = 'full'; f.threads.get(A).status = { type: 'idle' };
  const before = structuredClone(c.store.state), callCount = f.calls.length;
  const result = await readOnlyPreflight({ state: c.store.state, backend: c.native, threadId: A,
    expectedCwd: f.cwd, expectedHost: hostname(), stopAt: Date.now() + 10000 });
  assert.equal(result.readyForDeploymentReview, true); assert.equal(result.nativeMutations, 0);
  assert.deepEqual(c.store.state, before);
  assert.ok(f.calls.slice(callCount).every(q => /^(thread\/(read|list|items\/list|turns\/list|backgroundTerminals\/list|goal\/get|queue\/list))$/.test(q.method)));
  assert.ok(!JSON.stringify(result).includes('Fixture only'));
});
test('preflight refuses an ambiguous host, repository or expired diagnostic budget before native reads', async t => {
  const f = await fixture(t); let reads = 0;
  const args = { state: { threads: { [A]: { cwd: f.cwd } } }, backend: { request() { reads++; } },
    threadId: A, expectedCwd: f.cwd, expectedHost: 'wrong-host', stopAt: Date.now() + 10000 };
  await assert.rejects(readOnlyPreflight(args), { code: 'HOST_MISMATCH' });
  await assert.rejects(readOnlyPreflight({ ...args, expectedHost: hostname(), expectedCwd: '/tmp/other' }), { code: 'TARGET_MISMATCH' });
  assert.equal(reads, 0);
});
test('target freshness ignores unrelated clock/window writes while retaining every target ownership and deadline change', () => {
  const state = { version: 1, liveTurns: 18, clockFloor: 100, threads: { [A]: { cwd: '/tmp/repo' }, [B]: { cwd: '/tmp/other' } },
    operations: { first: { threadId: A, phase: 'accepted' }, other: { threadId: B, phase: 'accepted' } },
    taskWindows: { target: { threadId: A, deadlineAt: 1000 }, other: { threadId: B, deadlineAt: 2000 } } };
  const fingerprint = targetJournalFingerprint(state, A), unrelated = structuredClone(state);
  unrelated.clockFloor++; unrelated.taskWindows.other.deadlineAt++; unrelated.operations.other.phase = 'unknown';
  assert.equal(targetJournalFingerprint(unrelated, A), fingerprint);
  for (const mutate of [s => { s.threads[A].cwd = '/tmp/different'; }, s => { s.operations.first.phase = 'unknown'; },
    s => { s.taskWindows.target.deadlineAt++; }, s => { s.operations.new = { threadId: A, phase: 'dispatching' }; },
    s => { s.liveTurns++; }]) {
    const changed = structuredClone(state); mutate(changed); assert.notEqual(targetJournalFingerprint(changed, A), fingerprint);
  }
});
