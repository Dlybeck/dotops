import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Controller, inputs } from '../src/stage1/controller.mjs';
import { fixture, A, R, T } from './stage1-fixture.mjs';

async function setup(t, context) {
  const f = await fixture(t);
  const contextFile = context ? f.dir + '/context.json' : undefined;
  if (contextFile) await writeFile(contextFile, JSON.stringify(context), { mode: 0o600 });
  const options = { root: f.root, socketPath: f.socket, stateDir: f.dir + '/state', contextFile };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Context fixture' });
  return { f, get c() { return c; }, contextFile, async reopen() { await c.close(); c = await Controller.open(options); },
    send(extra = {}) { return c.call('codex_chat_send', { requestId: randomUUID(), threadId: A, text: 'Request', ...extra }); } };
}
const complete = f => { f.threads.get(A).turns.at(-1).status = 'completed'; f.threads.get(A).status.type = 'idle'; };

test('empty default sends immediately without window or reminder and preserves native input', async t => {
  const s = await setup(t); assert.equal(inputs.codex_task_window_open, undefined);
  assert.equal((await s.send()).phase, 'accepted');
  assert.equal(s.f.calls.find(q => q.method === 'turn/start').params.input[0].text, 'Request');
});
test('developer context is appended in the same first delivery and never on later requests', async t => {
  const s = await setup(t, { developer: 'Generic configured instructions' });
  assert.equal((await s.send()).developerContext, true);
  assert.equal(s.f.calls.find(q => q.method === 'turn/start').params.input[0].text, 'Request\n\nGeneric configured instructions');
  complete(s.f); await s.reopen(); assert.equal((await s.send()).developerContext, false);
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').at(-1).params.input[0].text, 'Request');
});
test('TPM preparation sends nothing; same text follow-up survives restart and is consumed once', async t => {
  const s = await setup(t, { developer: 'Developer context', tpm: 'Caller context' });
  const requestId = randomUUID(); const args = { requestId, threadId: A, text: 'Request' };
  const prep = await s.c.call('codex_chat_send', args);
  assert.equal(prep.phase, 'prepared'); assert.equal(prep.delivery, 'notAttempted'); assert.equal(prep.tpmContext, 'Caller context');
  assert.equal(s.f.calls.some(q => q.method === 'turn/start' || q.method === 'turn/steer'), false);
  assert.equal((await s.c.call('codex_chat_send', args)).preparationId, prep.preparationId);
  await s.reopen();
  const sendArgs = { ...args, requestId: randomUUID(), preparationId: prep.preparationId };
  const sent = await s.c.call('codex_chat_send', sendArgs); assert.equal(sent.phase, 'accepted');
  assert.deepEqual(await s.c.call('codex_chat_send', sendArgs), sent);
  complete(s.f);
  await assert.rejects(s.send({ preparationId: prep.preparationId }), { code: 'PREPARATION_UNAVAILABLE' });
  assert.equal((await s.send()).phase, 'prepared');
  const journal = await readFile(s.f.dir + '/state/state.json', 'utf8');
  assert.equal(journal.includes('Caller context'), false); assert.equal(journal.includes('Developer context'), false);
});
test('revision is allowed and stop never enters TPM preparation', async t => {
  const s = await setup(t, { tpm: 'Review intent' }); const prep = await s.send();
  const sent = await s.send({ preparationId: prep.preparationId, text: 'Revised request' });
  assert.equal(sent.phase, 'accepted'); assert.equal(s.f.calls.find(q => q.method === 'turn/start').params.input[0].text, 'Revised request');
  const stopped = await s.c.call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stopped.phase, 'stopped'); assert.equal(s.f.calls.some(q => q.method === 'turn/interrupt'), true);
});
test('changed configuration invalidates preparation; unsafe config cannot start controller', async t => {
  const s = await setup(t, { tpm: 'Before' }); const prep = await s.send();
  await writeFile(s.contextFile, JSON.stringify({ tpm: 'After' })); await s.reopen();
  await assert.rejects(s.send({ preparationId: prep.preparationId }), { code: 'PREPARATION_UNAVAILABLE' });
  await chmod(s.contextFile, 0o644);
  await assert.rejects(Controller.open({ stateDir: s.f.dir + '/other', root: s.f.root, socketPath: s.f.socket, contextFile: s.contextFile }), { code: 'UNSAFE_CONTEXT_FILE' });
});
test('existing UI history does not receive developer context and incomplete empty history fails closed', async t => {
  const s = await setup(t, { developer: 'Only on first' });
  s.f.threads.get(A).turns.push({ id: 'old', status: 'completed', items: [] });
  assert.equal((await s.send()).developerContext, false);
});
test('known pre-dispatch failure releases preparation for same or revised follow-up', async t => {
  const s = await setup(t, { tpm: 'Review request' }); const prepared = await s.send();
  s.f.handle = (socket, q) => {
    if (q.method === 'thread/read' && s.c.store.state.operations[prepared.preparationId].consumedBy)
      s.f.threads.get(A).status.type = 'active';
  };
  const failed = await s.send({ preparationId: prepared.preparationId });
  assert.equal(failed.phase, 'notDispatched');
  assert.equal(s.f.calls.some(q => q.method === 'turn/start'), false);
  assert.equal(s.c.store.state.operations[prepared.preparationId].consumedBy, undefined);
  s.f.handle = null; s.f.threads.get(A).status.type = 'idle';
  assert.equal((await s.send({ preparationId: prepared.preparationId, text: 'Revised request' })).phase, 'accepted');
});
test('competing native first request prevents a false accepted developer-context claim', async t => {
  const s = await setup(t, { developer: 'First-request instructions' });
  s.f.handle = (socket, q) => {
    if (q.method !== 'turn/start') return;
    const thread = s.f.threads.get(A);
    thread.turns.push({ id: 'competing-first', status: 'completed', items: [{ type: 'userMessage', id: 'ui-first', clientId: 'native-ui' }] });
    const turn = { id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'our-user', clientId: q.params.clientUserMessageId, content: q.params.input }] };
    thread.turns.push(turn); thread.status.type = 'active';
    socket.send(JSON.stringify({ id: q.id, result: { turn } })); return true;
  };
  const result = await s.send();
  assert.equal(result.phase, 'unknown'); assert.equal(result.code, 'CONTEXT_FIRST_REQUEST_UNVERIFIED');
  assert.equal(s.f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal((await s.c.call('codex_chat_status', { threadId: A })).operations[0].phase, 'unknown');
});
