import { uuid } from './native.mjs';
import { inheritedTurns, historyFingerprint } from './fork-history.mjs';
import { readDescendants } from './descendants.mjs';
const terminal = turn => ['completed', 'interrupted', 'failed'].includes(turn?.status);
export function childItems(items = []) {
  return items.filter(item => item.type === 'subAgentActivity' ||
    item.type === 'collabAgentToolCall' && (item.receiverThreadIds?.length ?? 0) > 0)
    .map(item => ({ type: item.type, id: item.id, kind: item.kind, agentThreadId: item.agentThreadId,
      receiverThreadIds: item.receiverThreadIds }));
}
export function mergeChildItems(...groups) {
  const result = new Map();
  for (const item of groups.flatMap(group => group ?? [])) {
    // Missing identities remain evidence, never get silently discarded.
    const key = item.id ?? JSON.stringify(item);
    const previous = result.get(key);
    result.set(key, { ...previous, ...item,
      kind: item.kind ?? previous?.kind,
      kinds: [...new Set([...(previous?.kinds ?? []), ...(item.kinds ?? []),
        ...(previous ? [previous.kind ?? null] : []), item.kind ?? null])],
      agentThreadId: item.agentThreadId ?? previous?.agentThreadId,
      agentThreadIds: [...new Set([...(previous?.agentThreadIds ?? []), ...(item.agentThreadIds ?? []),
        ...[previous?.agentThreadId, item.agentThreadId].filter(id => id !== undefined)])],
      receiverThreadIds: [...new Set([...(previous?.receiverThreadIds ?? []), ...(item.receiverThreadIds ?? [])])] });
  }
  return [...result.values()];
}
function identities(items, parentId = null) {
  const ids = [];
  for (const item of items) {
    const targets = item.type === 'subAgentActivity' ? (item.agentThreadIds?.length ? item.agentThreadIds : [item.agentThreadId]) : item.receiverThreadIds;
    if (!Array.isArray(targets) || !targets.length || targets.some(id => !uuid.safeParse(id).success)) return null;
    const kinds = item.kinds?.length ? item.kinds : [item.kind];
    // Native interacted activity can reference the sender's parent. Only this
    // proven immediate-parent relation is communication rather than descendant
    // work. Started, unknown, missing and conflicting kinds retain all checks.
    const parentInteraction = item.type === 'subAgentActivity' && parentId &&
      kinds.every(kind => kind === 'interacted');
    ids.push(...targets.filter(id => !parentInteraction || id !== parentId));
  }
  return [...new Set(ids)];
}
// Verification grants no child control: only existing read-only native methods.
// Every renewal rechecks current state; historical observations are retained.
export const childEvidence = record => JSON.stringify([record.childTurns, record.childItems, record.terminalTurns]);
export async function verifyChildren(c, rootId, turnIds, proof = {}) {
  try {
    const history = await c.turns(rootId);
    const record = c.store.state.threads[rootId];
    const evidence = () => childEvidence(c.store.state.threads[rootId]);
    const initialEvidence = evidence();
    const inventory = await readDescendants(c, rootId);
    if (!inventory) return 'unverified';
    const roots = new Set(); let observed = false;
    for (const turnId of new Set(turnIds.filter(Boolean))) {
      const receipt = record.terminalTurns?.[turnId];
      const turn = history.data.find(t => t.id === turnId);
      const items = mergeChildItems(receipt?.childItems, record.childItems?.[turnId], childItems(turn?.items));
      const seen = items.length > 0 || receipt?.childActivityObserved || record.childTurns?.includes(turnId);
      if (!seen) continue;
      observed = true;
      const ids = identities(items);
      if (!ids?.length) return 'unverified';
      for (const id of ids) roots.add(id);
    }
    for (const node of inventory.threads.values()) if (node.parentThreadId === rootId) roots.add(node.id);
    observed ||= inventory.threads.size > 0;
    if (observed) {
      const rootThread = await c.owned(rootId);
      if (!uuid.safeParse(rootThread.sessionId).success) return 'unverified';
      const frames = new Map([[rootId, { thread: rootThread, history, origins: new Map(), fingerprint: historyFingerprint(history) }]]);
      const owners = new Map([[rootId, null]]), pending = [];
      const identity = thread => historyFingerprint({ id: thread.id, parentThreadId: thread.parentThreadId,
        forkedFromId: thread.forkedFromId, sessionId: thread.sessionId, cwd: thread.cwd });
      function target(id, owner) {
        if (inventory.threads.get(id)?.parentThreadId !== owner) return false;
        if (owners.has(id)) return owners.get(id) === owner;
        owners.set(id, owner); pending.push(id); return owners.size <= 64;
      }
      async function clear(frame) {
        const id = frame.thread.id;
        const terminals = await c.terminals(id);
        const goal = await c.optional('thread/goal/get', { threadId: id });
        const queue = await c.optional('thread/queue/list', { threadId: id, limit: 1 });
        // Expanded root goals are explicit native state, not admission policy.
        // Stop verification separately checks root goal continuation. Descendant
        // goals and legacy Stage1 roots still require stopped continuation.
        const goalClear = c.expanded && id === rootId ? !!goal
          : goal?.goal === null || ['paused', 'complete'].includes(goal?.goal?.status);
        return terminals.available && terminals.complete && terminals.data.length === 0 && goalClear &&
          Array.isArray(queue?.data) && queue.data.length === 0 && !queue.nextCursor;
      }
      for (const id of roots) if (!target(id, rootId)) return 'unverified';
      while (pending.length) {
        const id = pending.shift(), parentId = owners.get(id);
        const thread = (await c.optional('thread/read', { threadId: id, includeTurns: false }))?.thread;
        if (thread?.id !== id || thread.parentThreadId !== parentId || thread.status?.type !== 'idle' ||
          !uuid.safeParse(thread.sessionId).success || await c.scope.cwd(thread.cwd) !== record.cwd) return 'unverified';
        // Ordinary native spawns have their own session. Shared-session proof
        // belongs only to inheritedTurns' fork-history exemptions.
        const turns = await c.turns(id);
        if (!turns.complete || !turns.data.length || new Set(turns.data.map(t => t.id)).size !== turns.data.length ||
          turns.data.some(turn => !terminal(turn) || !Array.isArray(turn.items) || ['summary', 'notLoaded'].includes(turn.itemsView))) return 'unverified';
        const frame = { thread, history: turns, origins: new Map(), fingerprint: historyFingerprint(turns) };
        const source = frames.get(parentId);
        for (const turnId of inheritedTurns(frame, source)) frame.origins.set(turnId, source.origins.get(turnId) ?? parentId);
        frames.set(id, frame);
        for (const node of inventory.threads.values()) if (node.parentThreadId === id && !target(node.id, id)) return 'unverified';
        for (const turn of turns.data) {
          const originId = frame.origins.get(turn.id) ?? id, origin = frames.get(originId);
          const nested = identities(childItems(turn.items), origin.thread.parentThreadId);
          if (!nested) return 'unverified';
          // Preserve and check every target. Copied launches retain their proven
          // original owner, rather than creating fictitious sibling descendants.
          for (const child of nested) if (!target(child, originId)) return 'unverified';
        }
        if (!await clear(frame)) return 'unverified';
      }
      if (owners.size !== inventory.threads.size + 1) return 'unverified';
      // Recheck full history and native state, including every fork source. A
      // changed copied prefix or newly observed child cannot reuse stale proof.
      for (const frame of frames.values()) {
        const fresh = await c.turns(frame.thread.id);
        if (historyFingerprint(fresh) !== frame.fingerprint || !await clear(frame)) return 'unverified';
        const again = (await c.optional('thread/read', { threadId: frame.thread.id, includeTurns: false }))?.thread;
        const idle = frame.thread.id === rootId ? ['idle', 'notLoaded'].includes(again?.status?.type) : again?.status?.type === 'idle';
        if (!again || identity(again) !== identity(frame.thread) || !idle) return 'unverified';
      }
    }
    const finalInventory = await readDescendants(c, rootId);
    if (!finalInventory || finalInventory.fingerprint !== inventory.fingerprint) return 'unverified';
    if (evidence() !== initialEvidence) return 'unverified';
    proof.evidence = initialEvidence;
    proof.descendants = { count: inventory.threads.size, fingerprint: inventory.fingerprint };
    return observed ? 'verifiedCompleted' : 'noneObserved';
  } catch { return 'unverified'; }
}
