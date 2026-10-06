import { localLifetimeEnded } from './execution.mjs';
import { readCurrentDescendants } from './descendants.mjs';
import { fail } from '../safety.mjs';
import { evaluateOwnedObligations, migrateOwnedObligations, validOwnershipId } from './owned-obligations.mjs';
import { goalOperationClosed, retainGoalClosure, validGoalFingerprint } from './goal-records.mjs';

export function ownedTurnIds(state, threadId) {
  return [...new Set(Object.values(state.operations).filter(op => op.kind === 'send' &&
    op.threadId === threadId && op.phase === 'accepted' && validOwnershipId(op.turnId)).map(op => op.turnId))];
}

export function localTurnLifetimeEnded(state, threadId, turnId, execution) {
  const dispatches = Object.values(state.operations).filter(op => op.kind === 'send' && op.threadId === threadId &&
    op.turnId === turnId && ['accepted', 'unknown', 'dispatching'].includes(op.phase));
  return dispatches.length > 0 && dispatches.every(op => localLifetimeEnded(op, execution));
}

export function scopeRevision(state, threadId, ignoreRequestId) {
  const record = state.threads[threadId];
  return JSON.stringify([Object.values(state.operations).filter(op => op.kind === 'send' && op.threadId === threadId && op.phase === 'accepted')
    .map(op => [op.turnId, op.dispatchBinding]), record.ownedObligations,
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
      const identified = validGoalFingerprint(op.ownedGoalHash);
      const laterClosure = identified && operations.slice(index + 1).some(([, later]) =>
        later.phase === 'accepted' && later.result?.observedDesiredState &&
        ['pause', 'clear', 'set'].includes(later.action) && later.priorOwnedGoalHash === op.ownedGoalHash);
      const attributable = identified && op.ownedGoalHash === c.goalOwnershipHash(goal.goal);
      const stopped = goalOperationClosed(op) || laterClosure || identified &&
        (goal.goal === null || attributable && ['paused', 'complete'].includes(goal.goal.status));
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

function goalStateKnown(response) {
  return response?.goal === null || ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(response?.goal?.status);
}

async function currentChildEvidence(c, threadId) {
  const inventory = await readCurrentDescendants(c, threadId), evidence = [], quiescent = new Set();
  if (!inventory) return { evidence: [{ reason: 'CURRENT_CHILD_STATE_UNAVAILABLE' }], quiescent };
  for (const node of inventory.threads.values()) {
    const before = evidence.length;
    const thread = (await c.optional('thread/read', { threadId: node.id, includeTurns: false }))?.thread;
    if (!thread || thread.id !== node.id || thread.parentThreadId !== node.parentThreadId || thread.cwd !== node.cwd ||
        !['idle', 'notLoaded'].includes(thread.status?.type)) {
      evidence.push({ threadId: node.id, reason: thread && !['idle', 'notLoaded'].includes(thread.status?.type)
        ? 'CURRENT_CHILD_ACTIVE' : 'CURRENT_CHILD_STATE_UNAVAILABLE' });
      continue;
    }
    const goal = await c.optional('thread/goal/get', { threadId: node.id });
    const queue = await c.optional('thread/queue/list', { threadId: node.id, limit: 20 });
    if (!goalStateKnown(goal) || !Array.isArray(queue?.data) || queue.nextCursor !== null)
      evidence.push({ threadId: node.id, reason: 'CURRENT_CHILD_STATE_UNAVAILABLE' });
    else if (goal.goal?.status === 'active' || queue.data.length)
      evidence.push({ threadId: node.id, reason: 'CURRENT_CHILD_CONTINUATION' });
    // Unloaded historical delegated agents are not resumed to reconstruct their past.
    if (thread.status.type === 'idle') {
      const terminals = await c.terminals(node.id);
      if (!terminals.available || !terminals.complete || terminals.data.length)
        evidence.push({ threadId: node.id, reason: 'CURRENT_CHILD_PROCESSES_UNVERIFIED' });
    }
    if (evidence.length === before) quiescent.add(node.id);
  }
  return { evidence, quiescent };
}

// Native delegated-agent lifecycle completion can establish readiness without
// establishing each request outcome. Keep exact closure and control separate.
function delegationReadiness(record, delegations, quiescent, freshFullTurns) {
  const lifecycles = new Map();
  for (const turnId of new Set(delegations.filter(item => item.state !== 'closed').map(item => item.turnId))) {
    const owned = record.ownedObligations?.turns?.[turnId], following = new Map(), completed = new Map();
    const starts = new Map(), startCounts = new Map(), interactions = new Set();
    if (freshFullTurns.has(turnId) && owned?.fullItemsObserved && !owned.historyConflict && !owned.malformedEvidence && !owned.modelConflict &&
        ['completed', 'failed', 'interrupted'].includes(owned.modelStatus)) {
      const claimed = new Set(Object.values(owned.delegationClosures ?? {}).map(receipt => receipt?.completionId));
      for (const id of [...(owned.historyOrder ?? [])].reverse()) {
        const item = owned.items[id];
        if (item?.type !== 'subAgentActivity' || item.identityConflict || !item.agentThreadId) continue;
        if (item.kind === 'completed') following.set(item.agentThreadId, item.id);
        const completionId = following.get(item.agentThreadId);
        if (item.kind === 'interacted' && completionId && !claimed.has(completionId)) {
          completed.set(item.id, completionId); interactions.add(completionId);
        }
        if (item.kind === 'started' && completionId) {
          startCounts.set(completionId, (startCounts.get(completionId) ?? 0) + 1);
          if (interactions.has(completionId)) starts.set(item.id, completionId);
        }
      }
      // Only the observed single-start -> interaction -> completion lifecycle.
      // Multiple starts or a completion already claimed by exact closure cannot
      // establish readiness for another activity; their outcomes remain unknown.
      for (const [startId, completionId] of starts) if (startCounts.get(completionId) === 1 && !claimed.has(completionId))
        completed.set(startId, completionId);
    }
    lifecycles.set(turnId, completed);
  }
  const items = delegations.filter(item => item.state !== 'closed').map(item => {
    const completion = !item.identityConflict &&
      quiescent.has(item.agentThreadId) ? lifecycles.get(item.turnId)?.get(item.itemId) : null;
    return { turnId: item.turnId, itemId: item.itemId, agentThreadId: item.agentThreadId,
      ready: Boolean(completion), reason: completion ? 'NATIVE_DELEGATE_LIFECYCLE_QUIESCENT' : 'DELEGATION_READINESS_UNVERIFIED',
      ...(completion ? { lifecycleCompletionItemId: completion } : {}), outcome: 'unknown', childStopAuthorized: false };
  });
  return { count: items.length, unready: items.filter(item => !item.ready).length,
    items: items.slice(0, 10), truncated: items.length > 10 };
}

// Read/repair only exact root turns that the connector accepted. Native metadata
// exposes no receiver-turn receipt, so unresolved delegation never grants control.
export async function ownedScopeProof(c, threadId, { ignoreRequestId } = {}) {
  await c.recoverPersistence(threadId);
  const initial = await c.owned(threadId), epoch = c.native.epoch;
  const ids = ownedTurnIds(c.store.state, threadId);
  const currentIds = ids.filter(id => !localTurnLifetimeEnded(c.store.state, threadId, id, c.execution));
  const endedDispatches = Object.values(c.store.state.operations).filter(op => op.kind === 'send' &&
    op.threadId === threadId && ['accepted', 'unknown', 'dispatching'].includes(op.phase) && localLifetimeEnded(op, c.execution));
  await c.store.update(s => migrateOwnedObligations(s.threads[threadId], ids));
  const history = ids.length ? await c.turns(threadId) : { data: [] };
  // Readiness is a fresh observation, unlike retained exact operation closure.
  // A summary/unavailable response cannot recycle a previous lifecycle snapshot.
  const freshTerminalTurns = new Set((history.complete ? history.data : []).filter(turn =>
    ['completed', 'failed', 'interrupted'].includes(turn.status)).map(turn => turn.id));
  const freshFullTurns = new Set(history.data.filter(turn => freshTerminalTurns.has(turn.id) &&
    turn.itemsView === 'full' && Array.isArray(turn.items)).map(turn => turn.id));
  for (const turnId of currentIds) {
    const owned = c.store.state.threads[threadId].ownedObligations?.turns?.[turnId];
    const freshSummary = freshTerminalTurns.has(turnId) && !freshFullTurns.has(turnId);
    if ((!owned?.fullItemsObserved || freshSummary) && (await c.repairOwnedTurn(threadId, turnId)).complete && freshTerminalTurns.has(turnId))
      freshFullTurns.add(turnId);
  }
  await c.store.tail;
  let revision = scopeRevision(c.store.state, threadId, ignoreRequestId);
  const inventory = await c.terminals(threadId);
  const goal = await c.optional('thread/goal/get', { threadId });
  const queue = await c.optional('thread/queue/list', { threadId, limit: 20 });
  const children = await currentChildEvidence(c, threadId);
  const final = await c.owned(threadId);
  await c.store.tail;
  const observedContinuations = continuations(c, threadId, goal, queue);
  const closures = observedContinuations.filter(item => item.kind === 'goal' && item.state === 'closed' &&
    item.requestId && !goalOperationClosed(c.store.state.operations[item.requestId]));
  if (closures.length && epoch === c.native.epoch && c.native.socket) await c.store.update(s => {
    // The observation is bound to the exact accepted operations in this
    // revision. Never mask a concurrent goal/send change with our own write.
    if (revision !== scopeRevision(s, threadId, ignoreRequestId) || epoch !== c.native.epoch || !c.native.socket) return;
    for (const item of closures) retainGoalClosure(s.operations[item.requestId], c.now(), 'scopedObservation');
    revision = scopeRevision(s, threadId, ignoreRequestId);
  });
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
  const current = evaluateOwnedObligations(c.store.state.threads[threadId], currentIds, inventory, threadId);
  const structuralEvidence = proof.evidence.filter(item => !item.turnId &&
    !(item.requestId && localLifetimeEnded(c.store.state.operations[item.requestId], c.execution)));
  current.evidence.push(...structuralEvidence, ...children.evidence);
  if (!inventory.available || !inventory.complete) current.evidence.push({ reason: 'CURRENT_PROCESS_INVENTORY_UNAVAILABLE' });
  if (endedDispatches.length && inventory.available && inventory.data.length)
    current.evidence.push({ reason: 'CURRENT_PROCESS_OBSERVED' });
  if (!goalStateKnown(goal) || !Array.isArray(queue?.data) || queue.nextCursor !== null)
    current.evidence.push({ reason: 'CURRENT_CONTINUATION_STATE_UNAVAILABLE' });
  if (goal && goal.goal?.status === 'active')
    current.evidence.push({ reason: 'CURRENT_GOAL_CONTINUATION' });
  current.continuations = proof.continuations;
  current.targetBusy = proof.targetBusy;
  const delegateReadiness = delegationReadiness(c.store.state.threads[threadId], current.delegations, children.quiescent, freshFullTurns);
  const ready = [...current.models, ...current.processes].every(item => item.state === 'closed') &&
    delegateReadiness.unready === 0 && current.evidence.length === 0 && !proof.targetBusy && ['idle', 'notLoaded'].includes(initial.status?.type) &&
    current.continuations.every(item => item.state === 'closed');
  proof.currentReadiness = { ready, endedLocalTurns: ids.filter(id => !currentIds.includes(id)).length,
    ...scopeSummary(current), delegationReadiness: delegateReadiness };
  return { ...proof, revision, epoch, ignoreRequestId, inventory, goal, queue,
    children: proof.delegations.some(item => item.state !== 'closed') ? 'unverified' : proof.delegations.length ? 'verifiedCompleted' : 'noneObserved',
    initialTargetBusy: !['idle', 'notLoaded'].includes(initial.status?.type) };
}

export function requireScopeCurrent(c, threadId, proof) {
  if (!proof.currentReadiness?.ready || proof.revision !== scopeRevision(c.store.state, threadId, proof.ignoreRequestId) ||
      proof.epoch !== c.native.epoch || !c.native.socket || c.persistenceRetries.has(threadId)) fail('PREVIOUS_WORK_UNVERIFIED');
}

export async function recheckOwnedScope(c, threadId, proof) {
  const fresh = await ownedScopeProof(c, threadId, { ignoreRequestId: proof.ignoreRequestId });
  requireScopeCurrent(c, threadId, fresh);
  if (fresh.revision !== proof.revision || fresh.epoch !== proof.epoch) fail('PREVIOUS_WORK_UNVERIFIED');
}
