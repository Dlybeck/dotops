// Isolated contract prototype. No native client, server, MCP tool or execution
// capability is connected here. A platform-owned authenticated UI adapter is
// still required; a caller's text, signature claim or boolean is not consent.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from '../src/safety.mjs';

const token = z.string().min(1).max(200);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const approvalBinding = z.object({
  ref: z.string().uuid(), threadId: z.string().uuid(), turnId: token,
  reviewId: token, host: token, repository: z.string().startsWith('/').max(512),
  artifactSha256: sha, actionSha256: sha, nativeEventSha256: sha,
  nativeExpiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null), connectionEpoch: z.number().int().nonnegative(),
}).strict();
const ownerDecision = z.object({
  ref: z.string().uuid(), callbackId: z.string().uuid(), principalId: token,
  bindingFingerprint: sha, decision: z.enum(['approve', 'reject']),
}).strict();
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ApprovalBindingPrototype {
  constructor({ journal, ownerPrincipalId, authenticateOwnerCallback, ownerChannelConnected, readCurrentBinding, now = Date.now }) {
    this.journal = journal; this.ownerPrincipalId = ownerPrincipalId;
    this.authenticate = authenticateOwnerCallback; this.connected = ownerChannelConnected;
    this.readCurrentBinding = readCurrentBinding; this.now = now;
  }
  async register(raw) {
    const binding = approvalBinding.parse(raw), bindingFingerprint = fingerprint(binding);
    await this.journal.update(state => {
      state.approvalPrototype ??= {};
      const prior = state.approvalPrototype[binding.ref];
      if (prior && prior.bindingFingerprint !== bindingFingerprint) fail('APPROVAL_BINDING_CONFLICT');
      if (!prior) state.approvalPrototype[binding.ref] = { binding, bindingFingerprint, phase: 'pendingOwner' };
    });
    return { ref: binding.ref, bindingFingerprint, executionAuthorized: false };
  }
  async decide(callbackEvent) {
    if (!this.authenticate || !this.connected?.()) fail('OWNER_CONTROL_UNAVAILABLE');
    const parsed = ownerDecision.safeParse(await this.authenticate(callbackEvent));
    if (!parsed.success || parsed.data.principalId !== this.ownerPrincipalId) fail('OWNER_CALLBACK_UNVERIFIED');
    const decision = parsed.data, decisionFingerprint = fingerprint(decision);
    let claimed = false;
    await this.journal.update(state => {
      const record = state.approvalPrototype?.[decision.ref];
      if (!record || record.bindingFingerprint !== decision.bindingFingerprint) fail('STALE_OWNER_CALLBACK');
      if (record.decisionFingerprint && record.decisionFingerprint !== decisionFingerprint) fail('OWNER_DECISION_CONFLICT');
      if (record.phase !== 'pendingOwner') return;
      Object.assign(record, { phase: 'checking', decisionFingerprint, callbackId: decision.callbackId }); claimed = true;
    });
    const record = this.journal.state.approvalPrototype[decision.ref];
    // An exact replay returns only a receipt. Restart never retries a native
    // action; a crash after claiming remains unverified rather than a grant.
    if (!claimed) return record.result ?? { ref: decision.ref, phase: 'decisionUnverified', executionAuthorized: false };
    let phase;
    if (decision.decision === 'reject') phase = 'ownerRejected';
    else if (record.binding.nativeExpiresAt !== null && this.now() >= record.binding.nativeExpiresAt) phase = 'expired';
    else {
      try {
        const current = approvalBinding.parse(await this.readCurrentBinding(decision.ref));
        phase = fingerprint(current) === record.bindingFingerprint ? 'ownerApprovedForNativeReview' : 'changedTarget';
      } catch { phase = 'targetUnverified'; }
      if (!this.connected()) phase = 'ownerDisconnected';
      else if (record.binding.nativeExpiresAt !== null && this.now() >= record.binding.nativeExpiresAt) phase = 'expired';
    }
    const result = { ref: decision.ref, phase, executionAuthorized: false,
      nativeReviewRequired: phase === 'ownerApprovedForNativeReview', nativeDispatches: 0 };
    await this.journal.update(state => {
      const current = state.approvalPrototype[decision.ref];
      if (current.phase !== 'checking' || current.decisionFingerprint !== decisionFingerprint) fail('OWNER_DECISION_CONFLICT');
      Object.assign(current, { phase, result });
    });
    return result;
  }
}
