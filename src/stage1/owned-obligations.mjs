// Native ownership evidence only: no prompts, commands, output or agent messages.
// Capture does not itself authorize admission or grant child-turn control.
const terminalModels = new Set(['completed', 'interrupted', 'failed']);
const modelStates = new Set(['inProgress', ...terminalModels]);
const commandStates = new Set(['inProgress', 'completed', 'failed', 'declined']);
const agentStates = new Set(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound']);
const tools = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents']);
const kinds = new Set(['started', 'interacted', 'interrupted', 'completed']);
export const validOwnershipId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(value);

function itemEvidence(item) {
  if (!validOwnershipId(item?.id)) return null;
  if (item.type === 'commandExecution') return { type: item.type, id: item.id,
    processId: validOwnershipId(item.processId) ? item.processId : null,
    status: commandStates.has(item.status) ? item.status : 'unknown',
    exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null };
  if (item.type === 'subAgentActivity') return { type: item.type, id: item.id,
    kind: kinds.has(item.kind) ? item.kind : 'unknown',
    agentThreadId: validOwnershipId(item.agentThreadId) ? item.agentThreadId : null };
  if (item.type === 'collabAgentToolCall') {
    const receiverThreadIds = Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length <= 64 && item.receiverThreadIds.every(validOwnershipId)
      ? [...new Set(item.receiverThreadIds)] : null;
    const agentStatuses = {};
    for (const id of receiverThreadIds ?? []) if (agentStates.has(item.agentsStates?.[id]?.status)) agentStatuses[id] = item.agentsStates[id].status;
    return { type: item.type, id: item.id, tool: tools.has(item.tool) ? item.tool : 'unknown',
      status: ['inProgress', 'completed', 'failed', 'interrupted'].includes(item.status) ? item.status : 'unknown',
      senderThreadId: validOwnershipId(item.senderThreadId) ? item.senderThreadId : null, receiverThreadIds, agentStatuses };
  }
  return null;
}

function mergeItem(previous, next) {
  if (!previous) return next;
  const identityConflict = previous.identityConflict || previous.type !== next.type ||
    next.type === 'commandExecution' && previous.processId !== null && next.processId !== null && previous.processId !== next.processId ||
    next.type === 'subAgentActivity' && (previous.agentThreadId !== null && next.agentThreadId !== null && previous.agentThreadId !== next.agentThreadId ||
      previous.kind !== 'unknown' && next.kind !== 'unknown' && previous.kind !== next.kind) ||
    next.type === 'collabAgentToolCall' && (previous.senderThreadId !== null && next.senderThreadId !== null && previous.senderThreadId !== next.senderThreadId ||
      previous.tool !== 'unknown' && next.tool !== 'unknown' && previous.tool !== next.tool);
  const result = { ...previous, ...next, observedTypes: [...new Set([...(previous.observedTypes ?? [previous.type]), next.type])],
    ...(identityConflict ? { identityConflict: true } : {}) };
  if (next.type === 'commandExecution') {
    result.processId = next.processId ?? previous.processId;
    result.exitCode = next.exitCode ?? previous.exitCode;
    result.processIds = [...new Set([...(previous.processIds ?? []), previous.processId, next.processId].filter(Boolean))];
  }
  if (next.type === 'collabAgentToolCall') {
    result.receiverThreadIds = previous.receiverThreadIds === null || next.receiverThreadIds === null ? null
      : [...new Set([...(previous.receiverThreadIds ?? []), ...next.receiverThreadIds])];
    result.agentStatuses = { ...previous.agentStatuses, ...next.agentStatuses };
  }
  return result;
}

function delegationIdentity(item) {
  if (item?.type === 'subAgentActivity' && ['started', 'interacted'].includes(item.kind))
    return { type: item.type, kind: item.kind, agentThreadId: item.agentThreadId };
  if (item?.type === 'collabAgentToolCall' && ['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask'].includes(item.tool) &&
      ['inProgress', 'completed'].includes(item.status) && item.receiverThreadIds?.length === 1)
    return { type: item.type, tool: item.tool, senderThreadId: item.senderThreadId, agentThreadId: item.receiverThreadIds[0] };
  return null;
}

function retainedDelegationIndex(owned) {
  const receipts = Object.entries(owned.delegationClosures ?? {}), completionClaims = new Map();
  const byLaunch = new Map(), items = new Set();
  // Count every claim, even malformed receipts: a duplicate cannot be laundered
  // into a unique valid completion by discarding its conflicting claimant.
  for (const [, receipt] of receipts) {
    const id = receipt?.completionId;
    completionClaims.set(id, (completionClaims.get(id) ?? 0) + 1);
  }
  for (const [launchId, receipt] of receipts) {
    if (!receipt || receipt.source !== 'orderedNativeCompletion' || receipt.launchId !== launchId ||
        !validOwnershipId(receipt.completionId) || receipt.completionId === launchId ||
        completionClaims.get(receipt.completionId) !== 1) continue;
    const launch = owned.items[launchId], completion = owned.items[receipt.completionId], identity = delegationIdentity(launch);
    if (identity && JSON.stringify(identity) === JSON.stringify(receipt.identity) &&
        completion?.type === 'subAgentActivity' && completion.kind === 'completed' &&
        validOwnershipId(identity.agentThreadId) && completion.agentThreadId === identity.agentThreadId &&
        !launch.identityConflict && !completion.identityConflict) {
      byLaunch.set(launchId, receipt);
      items.add(launchId); items.add(receipt.completionId);
    }
  }
  return { byLaunch, items };
}

export function captureOwnedTurn(record, turn, { eventItem = false } = {}) {
  if (!validOwnershipId(turn?.id)) return;
  record.ownedObligations ??= { version: 1, turns: {} };
  const ledger = record.ownedObligations;
  ledger.turns[turn.id] ??= { modelStatus: 'unknown', items: {}, observedOrder: [], fullItemsObserved: false };
  const owned = ledger.turns[turn.id];
  if (modelStates.has(turn.status)) {
    if (terminalModels.has(turn.status) && !terminalModels.has(owned.modelStatus)) owned.fullItemsObserved = false;
    if (terminalModels.has(owned.modelStatus) && turn.status === 'inProgress') owned.modelConflict = true;
    else owned.modelStatus = turn.status;
  }
  if (!Array.isArray(turn.items)) return;
  const order = [], currentIds = new Set(), observedIds = new Set(owned.observedOrder);
  for (const item of turn.items) {
    const evidence = itemEvidence(item);
    if (!evidence) {
      if (['commandExecution', 'subAgentActivity', 'collabAgentToolCall'].includes(item?.type)) owned.malformedEvidence = true;
      continue;
    }
    if (currentIds.has(item.id)) owned.malformedEvidence = true;
    order.push(item.id); currentIds.add(item.id);
    const previous = owned.items[item.id], merged = mergeItem(previous, evidence);
    if ((eventItem || turn.itemsView !== 'full') && JSON.stringify(previous) !== JSON.stringify(merged)) owned.fullItemsObserved = false;
    owned.items[item.id] = merged;
    if (!observedIds.has(item.id)) { owned.observedOrder.push(item.id); observedIds.add(item.id); }
  }
  if (!eventItem && turn.itemsView === 'full') {
    const retained = retainedDelegationIndex(owned);
    // Legacy native full history may omit command items delivered on the event
    // stream. Preserve positive leader-exit evidence; an omitted unresolved or
    // conflicting item still makes the history incomplete for owned proof.
    owned.historyConflict = Object.entries(owned.items).some(([id, item]) =>
      !currentIds.has(id) && !retained.items.has(id) &&
      !(item.type === 'commandExecution' && !item.identityConflict &&
        ['completed', 'failed'].includes(item.status) && Number.isSafeInteger(item.exitCode)));
    owned.fullItemsObserved = !owned.historyConflict;
    owned.historyOrder = order;
    if (order.some(id => ['subAgentActivity', 'collabAgentToolCall'].includes(owned.items[id].type))) owned.legacyDelegationUnknown = false;
    // Retain only closure already proved by a complete ordered native snapshot.
    // This is operation closure, never a receiver-turn or child-control grant.
    if (terminalModels.has(owned.modelStatus) && !owned.modelConflict && owned.fullItemsObserved && !owned.malformedEvidence) {
      for (const closure of delegationObligations(owned, undefined, retained)) if (closure.state === 'closed' && closure.completionItemId) {
        const launch = owned.items[closure.itemId];
        owned.delegationClosures ??= {};
        owned.delegationClosures[closure.itemId] = { source: 'orderedNativeCompletion', launchId: closure.itemId,
          completionId: closure.completionItemId, identity: delegationIdentity(launch) };
      }
    }
  }
}

// Legacy records lack item completeness/order. Import only exact accepted turn
// receipts and observations, then require native repair; never infer a child turn.
export function migrateOwnedObligations(record, turnIds) {
  for (const turnId of new Set(turnIds.filter(validOwnershipId))) {
    if (record.ownedObligations?.turns?.[turnId]?.legacyMigrated) continue;
    const receipt = record.terminalTurns?.[turnId];
    captureOwnedTurn(record, { id: turnId, ...(!record.ownedObligations?.turns?.[turnId] ? { status: receipt?.status } : {}) });
    const owned = record.ownedObligations.turns[turnId];
    for (const item of receipt?.items ?? []) {
      const previous = owned.items[item.id];
      if (!previous || item.type !== previous.type || validOwnershipId(item.processId) && item.processId !== previous.processId)
        captureOwnedTurn(record, { id: turnId, items: [item] }, { eventItem: true });
    }
    for (const [id, command] of Object.entries(record.commandItems ?? {})) {
      const observations = command.observations?.length ? command.observations : [command];
      for (const observation of observations.filter(value => value.turnId === turnId)) {
        const previous = owned.items[id];
        if (!previous || observation.processId !== previous.processId) captureOwnedTurn(record, { id: turnId,
          items: [{ type: 'commandExecution', id, processId: observation.processId, status: command.status }] }, { eventItem: true });
        if (command.identityConflict && owned.items[id]) owned.items[id].identityConflict = true;
      }
    }
    const children = [...(receipt?.childItems ?? []), ...(record.childItems?.[turnId] ?? [])];
    for (const item of children) {
      if (!owned.items[item.id]) captureOwnedTurn(record, { id: turnId, items: [item] }, { eventItem: true });
      if (owned.items[item.id] && (item.kinds?.length > 1 || item.agentThreadIds?.length > 1)) owned.items[item.id].identityConflict = true;
    }
    if ((receipt?.childActivityObserved || record.childTurns?.includes(turnId)) &&
        !Object.values(owned.items).some(item => ['subAgentActivity', 'collabAgentToolCall'].includes(item.type))) owned.legacyDelegationUnknown = true;
    owned.legacyMigrated = true;
  }
}

export function commandObligations(owned, inventory) {
  return Object.values(owned?.items ?? {}).filter(item => item.type === 'commandExecution' || item.observedTypes?.includes('commandExecution')).map(item => {
    const result = { itemId: item.id, processId: item.processId };
    const related = (inventory?.data ?? []).filter(terminal => terminal.itemId === item.id ||
      item.processId !== null && terminal.processId === item.processId);
    const exited = ['completed', 'failed'].includes(item.status) && Number.isSafeInteger(item.exitCode);
    const exact = related.filter(terminal => terminal.itemId === item.id && terminal.processId === item.processId);
    if (item.identityConflict)
      return { ...result, state: 'unknown', reason: 'PROCESS_IDENTITY_CONFLICT' };
    if (related.some(terminal => terminal.itemId === item.id && terminal.processId !== item.processId))
      return { ...result, state: 'unknown', reason: 'PROCESS_IDENTITY_CONFLICT' };
    // An exit closes this command leader. A different later item reusing its
    // handle is not a new obligation; an exact live pair still contradicts exit.
    if (exited && !exact.length)
      return { ...result, state: 'closed', reason: 'NATIVE_COMMAND_EXIT' };
    if (related.length !== exact.length)
      return { ...result, state: 'unknown', reason: 'PROCESS_IDENTITY_CONFLICT' };
    if (exact.length) return { ...result, state: 'live', reason: 'NATIVE_PROCESS_OBSERVED' };
    if (item.status === 'declined' && item.processId === null)
      return { ...result, state: 'closed', reason: 'COMMAND_DECLINED' };
    if (item.processId !== null && inventory?.available && inventory.complete &&
        terminalModels.has(owned.modelStatus) && !owned.modelConflict && !owned.malformedEvidence && owned.fullItemsObserved)
      return { ...result, state: 'closed', reason: 'NATIVE_TRACKED_PROCESS_ABSENT' };
    return { ...result, state: 'unknown', reason: item.processId === null ? 'PROCESS_HANDLE_UNAVAILABLE' : 'OWNED_PROCESS_UNVERIFIED' };
  });
}

function delegationObligations(owned, threadId, retained = retainedDelegationIndex(owned)) {
  const result = [], pending = new Map(), pairable = new WeakSet();
  const ordered = [...new Set([...(owned.historyOrder ?? owned.observedOrder), ...owned.observedOrder])].map(id => owned.items[id]);
  const complete = owned.fullItemsObserved && !owned.historyConflict && !owned.malformedEvidence;
  for (const item of ordered) {
    if (item.type === 'subAgentActivity' && item.kind === 'completed') {
      // A retained completion belongs to its original exact operation. It must
      // not be reused to close a newly observed launch to the same receiver.
      if (retained.items.has(item.id)) continue;
      const open = pending.get(item.agentThreadId) ?? [];
      if (complete && item.agentThreadId && !item.identityConflict && open.length === 1 && !open[0].identityConflict && pairable.has(open[0])) {
        open[0].state = 'closed'; open[0].reason = 'ORDERED_NATIVE_COMPLETION'; open[0].completionItemId = item.id;
      }
      pending.delete(item.agentThreadId);
      continue;
    }
    if (item.type === 'subAgentActivity' && ['completed', 'interrupted'].includes(item.kind)) continue;
    if (!['subAgentActivity', 'collabAgentToolCall'].includes(item.type)) continue;
    const senderVerified = item.type !== 'collabAgentToolCall' || item.senderThreadId !== null &&
      (threadId === undefined || item.senderThreadId === threadId);
    const informational = item.type === 'collabAgentToolCall' &&
      ['wait', 'listAgents', 'sendMessage', 'interruptAgent', 'closeAgent'].includes(item.tool) &&
      item.status === 'completed' && !item.identityConflict && senderVerified && item.receiverThreadIds !== null;
    const obligation = { itemId: item.id, agentThreadId: item.agentThreadId ?? null,
      state: informational ? 'closed' : 'unknown',
      reason: informational ? 'NATIVE_NON_WAKING_OPERATION_COMPLETED'
        : !senderVerified ? 'DELEGATION_SENDER_UNVERIFIED'
        : item.kind === 'interacted' ? 'AMBIGUOUS_INTERACTED_DELEGATION' : 'DELEGATION_CAUSALITY_UNVERIFIED',
      childStopAuthorized: false, ...(item.identityConflict ? { identityConflict: true } : {}) };
    result.push(obligation);
    const receipt = retained.byLaunch.get(item.id);
    if (receipt && senderVerified) {
      obligation.state = 'closed'; obligation.reason = 'DURABLE_NATIVE_COMPLETION';
      obligation.completionItemId = receipt.completionId;
      continue;
    }
    if (informational) continue;
    if (item.type === 'subAgentActivity' && ['started', 'interacted'].includes(item.kind) ||
        item.type === 'collabAgentToolCall' && ['spawnAgent', 'sendInput', 'resumeAgent', 'followupTask'].includes(item.tool) &&
        senderVerified && ['inProgress', 'completed'].includes(item.status)) pairable.add(obligation);
    const targets = item.type === 'subAgentActivity' ? [item.agentThreadId] : item.receiverThreadIds ?? [null];
    for (const id of targets) {
      const open = pending.get(id) ?? [];
      open.push(obligation); pending.set(id, open);
    }
    // Multi-receiver legacy tool calls have no per-receiver dispatch receipt.
    // A single receiver completion must never retire the whole operation.
    if (targets.length !== 1) obligation.identityConflict = true;
  }
  return result;
}

// Evaluate only explicitly accepted turns. Historical ancestry and a child's
// latest turn are intentionally not inputs. This supplies no control authority.
export function evaluateOwnedObligations(record, turnIds, inventory, threadId) {
  const models = [], processes = [], delegations = [], evidence = [];
  for (const turnId of new Set(turnIds)) {
    const owned = record?.ownedObligations?.turns?.[turnId];
    models.push({ turnId, state: owned && terminalModels.has(owned.modelStatus) && !owned.modelConflict ? 'closed' : 'unknown',
      reason: owned?.modelConflict ? 'MODEL_STATUS_CONFLICT' : owned?.modelStatus === 'inProgress' ? 'OWNED_MODEL_RUNNING'
        : owned && terminalModels.has(owned.modelStatus) ? 'NATIVE_MODEL_TERMINAL' : 'MODEL_STATUS_UNAVAILABLE' });
    if (!owned) { evidence.push({ turnId, reason: 'OWNED_TURN_EVIDENCE_UNAVAILABLE' }); continue; }
    if (!owned.fullItemsObserved || owned.malformedEvidence || owned.historyConflict)
      evidence.push({ turnId, reason: 'OWNED_ITEMS_UNVERIFIED' });
    if (owned.legacyDelegationUnknown) evidence.push({ turnId, reason: 'LEGACY_DELEGATION_EVIDENCE_UNAVAILABLE' });
    for (const item of Object.values(owned.items)) if (item.identityConflict)
      evidence.push({ turnId, itemId: item.id, reason: 'OWNED_ITEM_IDENTITY_CONFLICT' });
    processes.push(...commandObligations(owned, inventory).map(item => ({ turnId, ...item })));
    delegations.push(...delegationObligations(owned, threadId).map(item => ({ turnId, ...item })));
  }
  return { models, processes, delegations, evidence,
    verifiedStopped: evidence.length === 0 && [...models, ...processes, ...delegations].every(item => item.state === 'closed') };
}
