import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Controller } from '../src/stage1/controller.mjs';
import { fixture, A, R } from './stage1-fixture.mjs';

async function setup(t) {
  const f = await fixture(t), stateFile = f.dir + '/state/state.json';
  const options = { accessMode: 'user-directories', socketPath: f.socket, stateDir: f.dir + '/state' };
  let c = await Controller.open(options); t.after(() => c.close());
  await c.call('codex_chat_create', { requestId: R, repository: f.cwd, title: 'Goal journal privacy' });
  return { f, stateFile, get c() { return c; },
    async restart(transform) {
      await c.close();
      if (transform) {
        const state = JSON.parse(await readFile(stateFile, 'utf8')); transform(state);
        await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
      }
      c = await Controller.open(options);
    },
    async goal(action, extra = {}) {
      const status = await c.call('codex_chat_status', { threadId: A });
      const args = { requestId: randomUUID(), threadId: A, expectedGoalHash: status.admission.nativeGoalHash, action, ...extra };
      return { args, result: await c.call('codex_chat_goal', args) };
    }
  };
}

test('goal previews are transient and clearing leaves no objective in journal or replay receipts', async t => {
  const s = await setup(t), objective = 'Private objective for isolated journal regression';
  const set = await s.goal('set', { objective });
  assert.equal(set.result.goal.objective.text, objective);
  const pause = await s.goal('pause');
  assert.equal(pause.result.goal.objective.text, objective);
  await s.goal('clear'); assert.equal(s.f.goal, null);
  const disk = await readFile(s.stateFile, 'utf8');
  assert.equal(disk.includes(objective), false, 'cleared objective must not survive on disk');
  assert.equal(JSON.stringify(s.c.store.state).includes(objective), false);
  const stored = JSON.parse(disk).operations[set.args.requestId];
  assert.notEqual(stored.fingerprint, createHash('sha256').update(JSON.stringify(['codex_chat_goal', set.args])).digest('hex'));
  await s.restart();
  const replay = await s.c.call('codex_chat_goal', set.args);
  assert.equal(replay.nativeAcknowledged, true);
  assert.equal(replay.goal.objective, undefined);
  assert.equal(s.f.calls.filter(q => q.method === 'thread/goal/set').length, 2);
  await assert.rejects(s.c.call('codex_chat_goal', { ...set.args, objective: 'Different objective' }), { code: 'REQUEST_ID_CONFLICT' });
});

test('startup scrubs legacy goal bodies and previews while preserving exact request replay', async t => {
  const s = await setup(t), objective = 'Legacy private objective for migration regression';
  const set = await s.goal('set', { objective });
  const legacyFingerprint = createHash('sha256').update(JSON.stringify(['codex_chat_goal', set.args])).digest('hex');
  await s.restart(state => {
    const op = state.operations[set.args.requestId];
    op.fingerprint = legacyFingerprint; delete op.goalFingerprintVersion;
    op.priorGoal = { status: 'paused', objective, tokenBudget: 17 };
    op.result.goal = { status: 'active', objective: { text: objective, truncated: false }, tokenBudget: 17 };
  });
  const disk = await readFile(s.stateFile, 'utf8');
  assert.equal(disk.includes(objective), false);
  assert.equal(disk.includes(legacyFingerprint), false);
  assert.equal(JSON.stringify(s.c.store.state).includes(objective), false);
  assert.equal((await s.c.call('codex_chat_goal', set.args)).nativeAcknowledged, true);
  assert.equal(s.f.calls.filter(q => q.method === 'thread/goal/set').length, 1);
  await assert.rejects(s.c.call('codex_chat_goal', { ...set.args, objective: 'Another goal' }), { code: 'REQUEST_ID_CONFLICT' });
  await s.restart();
  assert.equal((await s.c.call('codex_chat_goal', set.args)).goal.objective, undefined);
});

test('uncertain native clearing never journals the prior objective or redispatches after restart', async t => {
  const s = await setup(t), objective = 'Private prior objective during uncertain clearing';
  s.f.goal = { objective, status: 'active', tokenBudget: 31 };
  s.f.handle = (socket, q) => {
    if (q.method !== 'thread/goal/clear') return;
    s.f.goal = null; socket.terminate(); return true;
  };
  const clear = await s.goal('clear');
  assert.equal(clear.result.phase, 'unknown');
  assert.equal((await readFile(s.stateFile, 'utf8')).includes(objective), false);
  await s.restart();
  assert.equal((await s.c.call('codex_chat_goal', clear.args)).phase, 'unknown');
  assert.equal(s.f.calls.filter(q => q.method === 'thread/goal/clear').length, 1);
});
