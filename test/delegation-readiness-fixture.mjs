import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

export const C = '55555555-5555-4555-8555-555555555555';
export const D = '66666666-6666-4666-8666-666666666666';
export const E = 'b4039b32-1661-4c35-9e0c-e09f7e621407';
export const F = '81de0edf-2c48-4da7-b610-ae7d0d8891be';
export const start = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'started', agentThreadId });
export const interaction = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'interacted', agentThreadId });
export const completion = (id, agentThreadId) => ({ type: 'subAgentActivity', id, kind: 'completed', agentThreadId });

export async function setup(t, { startedLifecycle = false, activities, receivers = [C, D], descendantCount = receivers.length } = {}) {
  const f = await fixture(t), options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Lifecycle fixture' });
  await c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Execute task', expectedLastTurnId: null, acknowledgeConcurrentStartRisk: true });
  const root = f.threads.get(A), turn = root.turns[0];
  root.status = { type: 'idle' }; turn.status = 'completed'; turn.itemsView = 'full';
  turn.items.push(interaction('c1', C), interaction('d1', D), interaction('c2', C), interaction('d2', D),
    completion('c-done', C), interaction('d3', D), completion('d-done', D));
  if (startedLifecycle) turn.items.splice(1, turn.items.length - 1,
    start('c1', C),
    interaction('c2', C), completion('c-done', C));
  if (activities) turn.items.splice(1, turn.items.length - 1, ...activities);
  for (const id of receivers) { const child = f.thread(id); child.parentThreadId = A; child.status = { type: 'notLoaded' }; f.threads.set(id, child); }
  for (let i = receivers.length; i < descendantCount; i++) {
    const child = f.thread(`77777777-7777-4777-8777-${String(i).padStart(12, '0')}`);
    child.parentThreadId = A; child.status = { type: i % 2 ? 'idle' : 'notLoaded' }; f.threads.set(child.id, child);
  }
  return { f, root, turn, get c() { return c; }, async restart() { await c.close(); c = await Controller.open(options); } };
}

export function assertUnknownOutcomes(s, value, open = 5) {
  assert.equal(value.ownedDelegations.open, open);
  assert.ok(value.ownedDelegations.items.every(x => x.state === 'unknown' && !x.childStopAuthorized));
  assert.equal(Object.keys(s.c.store.state.threads[A].ownedObligations.turns[T].delegationClosures ?? {}).length, 0);
}
