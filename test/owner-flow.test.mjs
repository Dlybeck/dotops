import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, A, T } from './stage1-fixture.mjs';

test('coordinating MCP flow prepares, sends combined first context, retrieves output, answers and stops through private IPC', async t => {
  const f = await fixture(t);
  await writeFile(f.dir + '/context.json', JSON.stringify({ developer: 'Configured developer instructions', tpm: 'Configured caller context' }), { mode: 0o600 });
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)),
    '--state-dir', f.dir + '/state', '--projects-root', f.root, '--native-socket', f.socket, '--context-file', f.dir + '/context.json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await once(worker, 'exit'); } });
  await Promise.race([once(worker.stdout, 'data'), once(worker, 'exit').then(() => assert.fail('Control process failed'))]);
  const client = new Client({ name: 'owner-flow-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./stage1-fixture-server.mjs', import.meta.url)), f.dir + '/state/control.sock'], stderr: 'pipe' });
  t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent;
  };
  const tools = await client.listTools(); assert.equal(tools.tools.some(x => x.name === 'codex_task_window_open'), false);
  await call('codex_chat_create', { requestId: randomUUID(), repository: f.cwd, title: 'Coordinated fixture' });
  const args = { requestId: randomUUID(), threadId: A, text: 'Build request' };
  const prep = await call('codex_chat_send', args); assert.equal(prep.phase, 'prepared'); assert.equal(prep.delivery, 'notAttempted');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
  const sendArgs = { ...args, requestId: randomUUID(), preparationId: prep.preparationId };
  const sent = await call('codex_chat_send', sendArgs); assert.equal(sent.phase, 'accepted');
  assert.deepEqual(await call('codex_chat_send', sendArgs), sent);
  const start = f.calls.find(q => q.method === 'turn/start');
  assert.equal(start.params.input[0].text, 'Build request\n\nConfigured developer instructions');
  assert.deepEqual(Object.keys(start.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  const turn = f.threads.get(A).turns[0]; turn.items.push({ type: 'agentMessage', id: 'latest-result', phase: 'commentary', text: 'Material progress 🍀' });
  assert.equal((await call('codex_chat_status', { threadId: A })).turn.assistantText, 'Material progress 🍀');
  f.notify('item/tool/requestUserInput', { threadId: A, turnId: T,
    questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'Bounded', description: 'Use agreed scope' }] }] }, 'question');
  const listed = await call('codex_chat_questions', { threadId: A }); assert.equal(listed.questions.length, 1);
  assert.equal((await call('codex_chat_answer', { requestId: randomUUID(), threadId: A,
    questionRef: listed.questions[0].questionRef, answers: { scope: ['Bounded'] } })).phase, 'answeredUnconfirmed');
  f.goal = { objective: 'Keep unfinished scope', status: 'active' };
  const status = await call('codex_chat_status', { threadId: A });
  assert.equal((await call('codex_chat_goal', { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action: 'pause' })).observedDesiredState, true);
  const stop = await call('codex_chat_stop', { requestId: randomUUID(), threadId: A, turnId: T });
  assert.equal(stop.verifiedStopped, true); assert.equal(stop.goalsClear, false);
  assert.equal(f.calls.filter(q => q.method === 'turn/start').length, 1);
  assert.equal(f.calls.some(q => /approveGuardian|requestApproval|permissions/.test(q.method)), false);
});

test('explicit skill preparation survives coordinating-client refresh without a duplicate request', async t => {
  const f = await fixture(t);
  const selection = { name: 'example:build', path: f.cwd + '/.agents/skills/build/SKILL.md' };
  const largeSelections = Array.from({ length: 9 }, (_, i) => ({ name: 'example:large' + i, path: '/' + i + 'x'.repeat(4094) }));
  f.handle = async (socket, q) => {
    if (q.method !== 'skills/list') return false;
    socket.send(JSON.stringify({ id: q.id, result: { data: [{ cwd: f.cwd,
      skills: [{ ...selection, enabled: true, description: 'Fixture build skill' }, ...largeSelections.map(skill => ({ ...skill, enabled: true }))], errors: [] }] } }));
    return true;
  };
  await writeFile(f.dir + '/context.json', JSON.stringify({ developer: 'Private configured instructions', tpm: 'Review this request' }), { mode: 0o600 });
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../src/stage1/watchdog.mjs', import.meta.url)),
    '--state-dir', f.dir + '/state', '--projects-root', f.root, '--native-socket', f.socket, '--context-file', f.dir + '/context.json'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGTERM'); await once(worker, 'exit'); } });
  await Promise.race([once(worker.stdout, 'data'), once(worker, 'exit').then(() => assert.fail('Control process failed'))]);
  const connect = async () => {
    const client = new Client({ name: 'skill-refresh-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./stage1-fixture-server.mjs', import.meta.url)), f.dir + '/state/control.sock'], stderr: 'pipe' });
    t.after(async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); });
    await client.connect(transport);
    return client;
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent;
  };
  const first = await connect();
  await call(first, 'codex_chat_create', { requestId: randomUUID(), repository: f.cwd, title: 'Skill refresh fixture' });
  const catalog = await call(first, 'codex_chat_skills', { threadId: A });
  assert.equal(catalog.skills[0].name, selection.name);
  const args = { threadId: A, requestId: randomUUID(), text: '$example:build Build request', skills: [selection] };
  const prep = await call(first, 'codex_chat_send', args);
  assert.equal(prep.delivery, 'notAttempted');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
  await first.close();
  const refreshed = await connect();
  assert.ok((await refreshed.listTools()).tools.find(tool => tool.name === 'codex_chat_skills'));
  const oversized = await call(refreshed, 'codex_chat_send', { ...args, requestId: randomUUID(),
    preparationId: prep.preparationId, skills: largeSelections });
  assert.equal(oversized.phase, 'notDispatched');
  assert.equal(oversized.code, 'SKILL_RECEIPT_TOO_LARGE');
  assert.equal(f.calls.some(q => q.method === 'turn/start'), false);
  const sendArgs = { ...args, requestId: randomUUID(), preparationId: prep.preparationId };
  const sent = await call(refreshed, 'codex_chat_send', sendArgs);
  assert.equal(sent.phase, 'accepted');
  assert.deepEqual(await call(refreshed, 'codex_chat_send', sendArgs), sent);
  assert.deepEqual(sent.nativeSkillInputs, [selection]);
  const starts = f.calls.filter(q => q.method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].params.input, [{ type: 'text', text: args.text + '\n\nPrivate configured instructions' }, { type: 'skill', ...selection }]);
  assert.equal(f.calls.some(q => /permissions|approveGuardian|requestApproval/.test(q.method)), false);
});
