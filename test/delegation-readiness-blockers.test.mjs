import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { A } from './stage1-fixture.mjs';
import { C, D, interaction, completion, setup } from './delegation-readiness-fixture.mjs';

for (const startedLifecycle of [false, true]) for (const variant of ['missing child', 'wrong parent', 'changed cwd', 'active child', 'unknown child status',
  'active goal', 'queued input', 'missing queue cursor', 'unknown goal', 'live child process', 'missing process cursor',
  'missing lifecycle completion', 'wrong completion receiver', 'late interaction', 'later started operation', 'typed waking operation',
  'multiple starts', 'unknown kind', 'duplicate completion', 'null completion receiver', 'identity conflict', 'incomplete history', 'running root']) test(`${startedLifecycle ? 'started/interacted' : 'interacted'} lifecycle readiness retains real blockers: ${variant}`, async t => {
  const s = await setup(t, { startedLifecycle }), child = s.f.threads.get(C);
  if (variant === 'missing child') s.f.threads.delete(C);
  if (variant === 'wrong parent') child.parentThreadId = null;
  if (variant === 'changed cwd') {
    const read = s.c.native.request.bind(s.c.native);
    s.c.native.request = async (method, params, options) => {
      const response = await read(method, params, options);
      return method === 'thread/read' && params.threadId === C ? { thread: { ...response.thread, cwd: '/different' } } : response;
    };
  }
  if (variant === 'active child' || variant === 'unknown child status') child.status = { type: variant === 'active child' ? 'active' : 'mystery' };
  if (variant === 'live child process' || variant === 'missing process cursor') child.status = { type: 'idle' };
  if (variant === 'missing lifecycle completion') s.turn.items = s.turn.items.filter(x => x.id !== 'c-done');
  if (variant === 'wrong completion receiver') s.turn.items.find(x => x.id === 'c-done').agentThreadId = D;
  if (variant === 'late interaction') s.turn.items.push(interaction('late', C));
  if (variant === 'later started operation') s.turn.items.push({ ...interaction('late-start', C), kind: 'started' });
  if (variant === 'multiple starts') s.turn.items.splice(1, 1,
    { ...interaction('first-start', C), kind: 'started' }, { ...interaction('second-start', C), kind: 'started' });
  if (variant === 'typed waking operation') s.turn.items[1] = { type: 'collabAgentToolCall', id: 'typed', tool: 'followupTask', status: 'completed', senderThreadId: A, receiverThreadIds: [D] };
  if (variant === 'unknown kind') s.turn.items[1].kind = 'mystery';
  if (variant === 'duplicate completion') s.turn.items.push(completion('c-done', C));
  if (variant === 'null completion receiver') s.turn.items.find(x => x.id === 'c-done').agentThreadId = null;
  if (variant === 'identity conflict') {
    await s.c.call('codex_chat_status', { threadId: A });
    s.turn.items.find(x => x.id === 'c1').agentThreadId = D;
  }
  if (variant === 'incomplete history') s.turn.itemsView = 'summary';
  if (variant === 'running root') { s.turn.status = 'inProgress'; s.root.status = { type: 'active' }; }
  s.f.handle = (socket, q) => {
    if (q.params?.threadId !== C) return;
    let result;
    if (variant === 'active goal' && q.method === 'thread/goal/get') result = { goal: { status: 'active' } };
    if (variant === 'unknown goal' && q.method === 'thread/goal/get') result = {};
    if (variant === 'queued input' && q.method === 'thread/queue/list') result = { data: [{ id: 'queued' }], nextCursor: null };
    if (variant === 'missing queue cursor' && q.method === 'thread/queue/list') result = { data: [] };
    if (variant === 'live child process' && q.method === 'thread/backgroundTerminals/list') result = { data: [{ itemId: 'live', processId: '42', cwd: s.f.cwd }], nextCursor: null };
    if (variant === 'missing process cursor' && q.method === 'thread/backgroundTerminals/list') result = { data: [] };
    if (result) { socket.send(JSON.stringify({ id: q.id, result })); return true; }
  };
  const status = await s.c.call('codex_chat_status', { threadId: A });
  assert.equal(status.admission.currentReadiness.ready, false);
  if (variant === 'running root') await assert.rejects(s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A }), { code: 'CHAT_ACTIVE' });
  else {
    const result = await s.c.call('codex_chat_reconcile', { requestId: randomUUID(), threadId: A });
    assert.equal(result.phase, 'unverified');
  }
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
});
