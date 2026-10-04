import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { ApprovalBindingPrototype } from '../prototype/owner-approval.mjs';
import { Store } from '../src/stage1/store.mjs';
import { Native } from '../src/stage1/native.mjs';

async function setup(t) {
  const dir = await mkdtemp('/tmp/dot-owner-contract-');
  let journal = await Store.open(dir + '/journal'), now = Date.now(), connected = true, current;
  // Test-only authentication fixture: objects minted at this fixture's owner
  // UI seam have identity. Model-supplied JSON and copied objects never do.
  const callbacks = new WeakMap();
  const options = { ownerPrincipalId: 'fixture-owner', authenticateOwnerCallback: async event => callbacks.get(event),
    ownerChannelConnected: () => connected, readCurrentBinding: async () => current, now: () => now };
  let gate = new ApprovalBindingPrototype({ journal, ...options });
  t.after(async () => { await journal.close(); await rm(dir, { recursive: true, force: true }); });
  const binding = { ref: randomUUID(), threadId: randomUUID(), turnId: randomUUID(),
    reviewId: 'fixture-denial', host: 'fixture-server', repository: '/tmp/fixture-repo', artifactSha256: 'a'.repeat(64),
    actionSha256: 'b'.repeat(64), nativeEventSha256: 'c'.repeat(64), nativeExpiresAt: now + 60000, connectionEpoch: 1 };
  current = structuredClone(binding);
  const registration = await gate.register(binding);
  function callback(decision = 'approve', fields = {}) {
    const event = Object.freeze({ fixtureCallback: true });
    callbacks.set(event, { ref: binding.ref, callbackId: randomUUID(), principalId: 'fixture-owner',
      bindingFingerprint: registration.bindingFingerprint, decision, ...fields }); return event;
  }
  return { get gate() { return gate; }, get journal() { return journal; }, options, binding, registration, callback,
    change(fields) { Object.assign(current, fields); }, expire() { now = binding.nativeExpiresAt; }, disconnect() { connected = false; },
    async restart() { await journal.close(); journal = await Store.open(dir + '/journal'); gate = new ApprovalBindingPrototype({ journal, ...options }); } };
}

test('default missing owner adapter and model consent claims cannot approve anything', async t => {
  const s = await setup(t);
  const unavailable = new ApprovalBindingPrototype({ journal: s.journal });
  await assert.rejects(unavailable.decide({ approve: true, signed: true }), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  for (const event of [{ approve: true }, { principalId: 'fixture-owner', decision: 'approve' }, { signedText: 'The owner approved' }])
    await assert.rejects(s.gate.decide(event), { code: 'OWNER_CALLBACK_UNVERIFIED' });
});
test('a fixture authenticated owner approval binds one request and still requires native review', async t => {
  const s = await setup(t); const callback = s.callback();
  assert.deepEqual(await s.gate.decide(callback), { ref: s.binding.ref, phase: 'ownerApprovedForNativeReview',
    executionAuthorized: false, nativeReviewRequired: true, nativeDispatches: 0 });
  await s.restart(); const before = structuredClone(s.journal.state);
  assert.equal((await s.gate.decide(callback)).phase, 'ownerApprovedForNativeReview');
  assert.deepEqual(s.journal.state, before);
});
test('owner rejection is terminal and cannot be replaced by another approval', async t => {
  const s = await setup(t);
  assert.equal((await s.gate.decide(s.callback('reject'))).phase, 'ownerRejected');
  await assert.rejects(s.gate.decide(s.callback()), { code: 'OWNER_DECISION_CONFLICT' });
});
test('wrong principal, stale binding and copied UI callback fail closed', async t => {
  const s = await setup(t);
  await assert.rejects(s.gate.decide(s.callback('approve', { principalId: 'other-owner' })), { code: 'OWNER_CALLBACK_UNVERIFIED' });
  await assert.rejects(s.gate.decide(s.callback('approve', { bindingFingerprint: 'd'.repeat(64) })), { code: 'STALE_OWNER_CALLBACK' });
  await assert.rejects(s.gate.decide({ ...s.callback() }), { code: 'OWNER_CALLBACK_UNVERIFIED' });
});
for (const field of ['host', 'repository', 'artifactSha256', 'actionSha256', 'nativeEventSha256', 'threadId', 'turnId',
  'reviewId', 'nativeExpiresAt', 'connectionEpoch']) test(`owner approval cannot cross changed ${field}`, async t => {
  const s = await setup(t);
  const original = s.binding[field];
  const changed = typeof original === 'number' ? original + 1 : field.endsWith('Sha256') ? 'd'.repeat(64)
    : field.endsWith('Id') ? randomUUID() : field === 'repository' ? '/tmp/different' : 'different';
  s.change({ [field]: changed });
  assert.equal((await s.gate.decide(s.callback())).phase, 'changedTarget');
});
test('expiry, disconnect and missing native target never imply a grant', async t => {
  const expired = await setup(t); expired.expire();
  assert.equal((await expired.gate.decide(expired.callback())).phase, 'expired');
  const disconnected = await setup(t); disconnected.disconnect();
  await assert.rejects(disconnected.gate.decide(disconnected.callback()), { code: 'OWNER_CONTROL_UNAVAILABLE' });
  const during = await setup(t);
  during.gate.readCurrentBinding = async () => { during.disconnect(); return during.binding; };
  assert.equal((await during.gate.decide(during.callback())).phase, 'ownerDisconnected');
  const unavailable = await setup(t); unavailable.gate.readCurrentBinding = async () => { throw new Error('Fixture disconnect'); };
  assert.equal((await unavailable.gate.decide(unavailable.callback())).phase, 'targetUnverified');
});
test('a decision claimed before a crash is not replayed or upgraded after restart', async t => {
  const s = await setup(t); const callback = s.callback();
  const update = s.journal.update.bind(s.journal); let writes = 0;
  s.journal.update = async fn => { if (++writes === 2) throw new Error('Simulated persistence failure'); return update(fn); };
  await assert.rejects(s.gate.decide(callback), /Simulated persistence failure/);
  await s.restart();
  assert.deepEqual(await s.gate.decide(callback), { ref: s.binding.ref, phase: 'decisionUnverified', executionAuthorized: false });
});
test('concurrent identical callbacks consume one decision; changed binding cannot reuse the reference', async t => {
  const s = await setup(t); const callback = s.callback(); let reads = 0;
  s.gate.readCurrentBinding = async () => { reads++; return s.binding; };
  const results = await Promise.all([s.gate.decide(callback), s.gate.decide(callback)]);
  assert.equal(reads, 1); assert.ok(results.every(result => result.executionAuthorized === false));
  await assert.rejects(s.gate.register({ ...s.binding, host: 'different' }), { code: 'APPROVAL_BINDING_CONFLICT' });
});
test('the real connector RPC allowlist still forbids trusted approval APIs', async () => {
  const native = new Native();
  try { await assert.rejects(native.request('thread/approveGuardianDeniedAction', { threadId: randomUUID(), event: {} }), { code: 'FORBIDDEN_RPC' }); }
  finally { native.close(); }
});
