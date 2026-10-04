import { createHmac } from 'node:crypto';

// Objectives and response previews stay in memory. The journal retains only
// bounded native metadata and private fingerprints for replay/attribution.
export function goalMetadata(goal) {
  if (!goal) return null;
  const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { status: ['active', 'paused', 'complete', 'blocked'].includes(goal.status) ? goal.status : 'unknown',
    tokenBudget: number(goal.tokenBudget), tokensUsed: number(goal.tokensUsed) };
}

export function goalRequestFingerprint(key, digest) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update('goal-request\0' + digest).digest('hex');
}

export function validGoalFingerprint(hash) {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash);
}

export function goalOperationClosed(op) {
  return validGoalFingerprint(op.ownedGoalHash) &&
    op.ownedGoalClosure?.version === 1 && op.ownedGoalClosure.ownedGoalHash === op.ownedGoalHash;
}

export function retainGoalClosure(op, observedAt, evidence) {
  if (op.phase !== 'accepted' || !['set', 'resume'].includes(op.action) ||
      !validGoalFingerprint(op.ownedGoalHash) || goalOperationClosed(op)) return;
  op.ownedGoalClosure = { version: 1, ownedGoalHash: op.ownedGoalHash, observedAt, evidence };
}

export function migrateGoalRecords(state) {
  for (const op of Object.values(state.operations)) if (op.kind === 'goal') {
    // Wrap the legacy request digest rather than recovering objective text.
    // Existing request IDs still replay, but no unkeyed objective digest stays.
    if (op.goalFingerprintVersion === undefined && typeof op.fingerprint === 'string') {
      op.fingerprint = goalRequestFingerprint(state.ownedContinuationKey, op.fingerprint);
      op.goalFingerprintVersion = 1;
    }
    if (op.priorGoal !== undefined) op.priorGoal = goalMetadata(op.priorGoal);
    if (op.result?.goal !== undefined) op.result.goal = goalMetadata(op.result.goal);
  }
  // Legacy stop summaries did not bind the observed native goal identity.
  // Even a named closed item cannot create an exact-operation closure marker.
}
