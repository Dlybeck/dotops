import { fail } from '../safety.mjs';
import { evaluateOwnedObligations, migrateOwnedObligations, validOwnershipId } from './owned-obligations.mjs';

export function ownedTurnIds(state, threadId) {
  return [...new Set(Object.values(state.operations).filter(op => op.kind === 'send' &&
    op.threadId === threadId && op.phase === 'accepted' && validOwnershipId(op.turnId)).map(op => op.turnId))];
}

export function scopeRevision(state, threadId, ignoreRequestId) {
  const record = state.threads[threadId];
  return JSON.stringify([ownedTurnIds(state, threadId), record.ownedObligations,
    record.commandItems, record.childTurns, record.childItems, record.terminalTurns,
    Object.entries(state.operations).filter(([id, op]) => op.threadId === threadId &&
      (op.kind === 'goal' || op.kind === 'send' && ['unknown', 'dispatching'].includes(op.phase) && id !== ignoreRequestId))]);
}

function continuations(c, threadId, goal, queue) {
  const result = [];
  if (!goal) result.push({ kind: 'goal', state: 'unknown', reason: 'GOAL_STATE_UNAVAILABLE' });
  else {
    const operations = Object.entries(c.store.state.operations).filter(([, op]) => op.threadId === threadId && op.kind === 'goal');
    for (const [requestId, op] of operations) if (['dispatching', 'unknown'].includes(op.phase))
      result.push({ kind: 'goal', requestId, state: 'unknown', reason: 'GOAL_CONTROL_UNRESOLVED' });
    for (let index = 0; index < operations.length; index++) {
      const [requestId, op] = operations[index];
      if (op.phase !== 'accepted' || !['set', 'resume'].includes(op.action)) continue;
      const laterClosure = op.ownedGoalHash && operations.slice(index + 1).some(([, later]) =>
        later.phase === 'accepted' && later.result?.observedDesiredState &&
        ['pause', 'clear', 'set'].includes(later.action) && later.priorOwnedGoalHash === op.ownedGoalHash);
      const stopped = laterClosure || goal.goal === null || ['paused', 'complete'].includes(goal.goal.status);
      const attributable = op.ownedGoalHash && op.ownedGoalHash === c.goalOwnershipHash(goal.goal);
      result.push({ kind: 'goal', requestId, state: stopped ? 'closed' : 'unknown',
        reason: stopped ? 'NATIVE_GOAL_CONTINUATION_STOPPED' : attributable ? 'OWNED_GOAL_CONTINUATION_OPEN' : 'GOAL_OWNERSHIP_AMBIGUOUS' });
    }
  }
  if (!Array.isArray(queue?.data) || queue.nextCursor) result.push({ kind: 'queue', state: 'unknown', reason: 'QUEUE_STATE_UNAVAILABLE' });
  if (Array.isArray(queue?.data)) for (const item of queue.data) {
    const requestId = item.clientUserMessageId;
    const op = c.store.state.operations[requestId];
    if (op?.kind === 'send' && op.threadId === threadId && op.phase === 'accepted')
      result.push({ kind: 'queue', requestId, state: 'unknown', reason: 'OWNED_QUEUED_CONTINUATION' });
  }
  return result;
}

function bounded(items) {
  return { count: items.length, open: items.filter(item => item.state !== 'closed').length,
    items: items.slice(0, 10), truncated: items.length > 10 };
}

export function scopeSummary(proof) {
  const unknown = [...proof.models, ...proof.processes, ...proof.delegations, ...proof.continuations]
    .filter(item => item.state !== 'closed').concat(proof.evidence);
  return { ownedModel: bounded(proof.models), ownedProcesses: bounded(proof.processes),
    ownedDelegations: bounded(proof.delegations), ownedContinuations: bounded(proof.continuations),
    unknownOwnedObligations: bounded(unknown), targetBusy: proof.targetBusy };
}

// Read/repair only exact root turns that the connector accepted. Native metadata
// exposes no receiver-turn receipt, so unresolved delegation never grants control.
export async function ownedScopeProof(c, threadId, { ignoreRequestId } = {}) {
  await c.recoverPersistence(threadId);
  const initial = await c.owned(threadId), epoch = c.native.epoch;
  const ids = ownedTurnIds(c.store.state, threadId);
  await c.store.update(s => migrateOwnedObligations(s.threads[threadId], ids));
  if (ids.length) await c.turns(threadId);
  for (const turnId of ids) {
    const owned = c.store.state.threads[threadId].ownedObligations?.turns?.[turnId];
    if (!owned?.fullItemsObserved) await c.repairOwnedTurn(threadId, turnId);
  }
  await c.store.tail;
  const revision = scopeRevision(c.store.state, threadId, ignoreRequestId);
  const inventory = await c.terminals(threadId);
  const goal = await c.optional('thread/goal/get', { threadId });
  const queue = await c.optional('thread/queue/list', { threadId, limit: 20 });
  const final = await c.owned(threadId);
  await c.store.tail;
  const proof = evaluateOwnedObligations(c.store.state.threads[threadId], ids, inventory, threadId);
  for (const [requestId, op] of Object.entries(c.store.state.operations)) if (requestId !== ignoreRequestId &&
      op.threadId === threadId && op.kind === 'send' && ['unknown', 'dispatching'].includes(op.phase))
    proof.evidence.push({ requestId, reason: 'SEND_OWNERSHIP_UNRESOLVED' });
  proof.continuations = continuations(c, threadId, goal, queue);
  proof.targetBusy = !['idle', 'notLoaded'].includes(final.status?.type);
  proof.evidence.push(...(epoch !== c.native.epoch || !c.native.socket ? [{ reason: 'NATIVE_CONNECTION_CHANGED' }] : []),
    ...(revision !== scopeRevision(c.store.state, threadId, ignoreRequestId) || c.persistenceRetries.has(threadId) ? [{ reason: 'OWNED_SCOPE_CHANGED' }] : []));
  proof.verifiedStopped &&= proof.evidence.length === 0 && proof.continuations.every(item => item.state === 'closed');
  return { ...proof, revision, epoch, ignoreRequestId, inventory, goal, queue,
    children: proof.delegations.some(item => item.state !== 'closed') ? 'unverified' : proof.delegations.length ? 'verifiedCompleted' : 'noneObserved',
    initialTargetBusy: !['idle', 'notLoaded'].includes(initial.status?.type) };
}

export function requireScopeCurrent(c, threadId, proof) {
  if (!proof.verifiedStopped || proof.revision !== scopeRevision(c.store.state, threadId, proof.ignoreRequestId) ||
      proof.epoch !== c.native.epoch || !c.native.socket || c.persistenceRetries.has(threadId)) fail('PREVIOUS_WORK_UNVERIFIED');
}

export async function recheckOwnedScope(c, threadId, proof) {
  const fresh = await ownedScopeProof(c, threadId, { ignoreRequestId: proof.ignoreRequestId });
  requireScopeCurrent(c, threadId, fresh);
  if (fresh.revision !== proof.revision || fresh.epoch !== proof.epoch) fail('PREVIOUS_WORK_UNVERIFIED');
}
