import { uuid } from './native.mjs';
import { SafeError, fail } from '../safety.mjs';
import { childEvidence } from './children.mjs';
import { historyFingerprint } from './fork-history.mjs';
import { readDescendants } from './descendants.mjs';

const terminal = turn => ['completed', 'interrupted', 'failed'].includes(turn?.status);
const lineage = thread => ({ id: thread.id, parentThreadId: thread.parentThreadId,
  forkedFromId: thread.forkedFromId ?? null, cwd: thread.cwd });
const listedLineageMatches = (thread, node) => thread.id === node.id &&
  thread.parentThreadId === node.parentThreadId && thread.cwd === node.cwd &&
  (node.forkedFromId === null || thread.forkedFromId === node.forkedFromId);
const treeIdentity = inventory => historyFingerprint([...inventory.threads.values()]
  .map(node => ({ ...lineage(node), archived: node.archived })).sort((a, b) => a.id.localeCompare(b.id)));

// Called only during an explicit root reconciliation or new send. Reattaching
// completed native descendants grants no turn, goal, terminal or approval control.
// Read-only status/stop proof never loads threads and never treats missing
// process inventory as empty. Full verification must follow these subscriptions.
export async function loadCompletedDescendants(c, rootId) {
  const root = await c.owned(rootId), record = c.store.state.threads[rootId];
  if (root.status?.type !== 'idle') fail('CHAT_ACTIVE');
  const inventory = await readDescendants(c, rootId);
  if (!inventory) fail('PREVIOUS_WORK_UNVERIFIED');
  const epoch = c.native.epoch;
  const sameConnection = () => {
    if (c.native.epoch !== epoch || !c.native.socket || c.subscribed.get(rootId) !== epoch) fail('PREVIOUS_WORK_UNVERIFIED');
  };
  sameConnection();
  if (!inventory.threads.size) return { resumed: [], epoch };
  c.descendantSubscriptions ??= new Map();
  const initialTree = treeIdentity(inventory), initialEvidence = childEvidence(record);
  // Prove a connected bounded tree before any attachment. Listing an arbitrary
  // thread, a disconnected lineage or a cycle never authorizes loading it.
  const ordered = [], known = new Set([rootId]);
  while (ordered.length < inventory.threads.size) {
    const next = [...inventory.threads.values()].filter(node => !known.has(node.id) && known.has(node.parentThreadId));
    if (!next.length) fail('PREVIOUS_WORK_UNVERIFIED');
    for (const node of next) { known.add(node.id); ordered.push(node); }
  }
  async function inspect(node) {
    const thread = (await c.optional('thread/read', { threadId: node.id, includeTurns: false }))?.thread;
    // DB-only lists can omit fork provenance. Detailed native reads establish
    // it; a positive list value must agree, and the read value is pinned below.
    if (!thread || !listedLineageMatches(thread, node) ||
        (thread.forkedFromId != null && !uuid.safeParse(thread.forkedFromId).success) ||
        !uuid.safeParse(thread.sessionId).success || !['idle', 'notLoaded'].includes(thread.status?.type) ||
        await c.scope.cwd(thread.cwd) !== record.cwd) fail('PREVIOUS_WORK_UNVERIFIED');
    const history = await c.turns(node.id);
    if (!history.complete || !history.data.length || new Set(history.data.map(t => t.id)).size !== history.data.length ||
        history.data.some(turn => !terminal(turn) || turn.itemsView !== 'full' || !Array.isArray(turn.items))) fail('PREVIOUS_WORK_UNVERIFIED');
    const goal = await c.optional('thread/goal/get', { threadId: node.id });
    const queue = await c.optional('thread/queue/list', { threadId: node.id, limit: 1 });
    if (!(goal?.goal === null || ['paused', 'complete'].includes(goal?.goal?.status)) ||
        !Array.isArray(queue?.data) || queue.data.length || queue.nextCursor) fail('PREVIOUS_WORK_UNVERIFIED');
    if (thread.status.type === 'idle') {
      const terminals = await c.terminals(node.id);
      if (!terminals.available || !terminals.complete || terminals.data.length) fail('PREVIOUS_WORK_UNVERIFIED');
    }
    return { thread, history: historyFingerprint(history), goal: historyFingerprint(goal) };
  }
  const snapshots = new Map();
  // Check every sibling first: active work or missing history/state elsewhere
  // in the tree blocks before we load even a completed reviewer.
  for (const node of ordered) snapshots.set(node.id, await inspect(node));
  sameConnection();
  const resumed = [];
  for (const node of ordered) {
    if ((await c.owned(rootId)).status?.type !== 'idle') fail('CHAT_ACTIVE');
    const current = await readDescendants(c, rootId);
    if (!current || treeIdentity(current) !== initialTree || childEvidence(c.store.state.threads[rootId]) !== initialEvidence) fail('PREVIOUS_WORK_UNVERIFIED');
    const fresh = await inspect(node), previous = snapshots.get(node.id);
    sameConnection();
    if (historyFingerprint(lineage(fresh.thread)) !== historyFingerprint(lineage(previous.thread)) ||
        fresh.history !== previous.history || fresh.goal !== previous.goal) fail('PREVIOUS_WORK_UNVERIFIED');
    if (fresh.thread.status.type === 'notLoaded' || c.descendantSubscriptions.get(node.id) !== c.native.epoch) {
      let loaded;
      try { loaded = await c.native.request('thread/resume', { threadId: node.id, excludeTurns: true }); }
      catch (error) {
        if (error instanceof SafeError && error.code === 'BACKEND_REJECTED' &&
            error.nativeRejection?.rpcCode === -32600 && error.nativeRejection.reason === 'unloadedMultiAgentV2Subagent') {
          const unavailable = new SafeError('NATIVE_SUBAGENT_RESUME_UNAVAILABLE');
          unavailable.blockedDescendantId = node.id;
          throw unavailable;
        }
        throw error;
      }
      if (c.native.epoch !== epoch || loaded.thread?.status?.type !== 'idle' ||
          historyFingerprint(lineage(loaded.thread)) !== historyFingerprint(lineage(previous.thread))) fail('PREVIOUS_WORK_UNVERIFIED');
      c.descendantSubscriptions.set(node.id, epoch);
      resumed.push(node.id);
    }
    const after = await inspect(node);
    sameConnection();
    if (after.thread.status.type !== 'idle' ||
        historyFingerprint(lineage(after.thread)) !== historyFingerprint(lineage(previous.thread)) ||
        after.history !== previous.history || after.goal !== previous.goal) fail('PREVIOUS_WORK_UNVERIFIED');
  }
  const final = await readDescendants(c, rootId);
  sameConnection();
  if (!final || treeIdentity(final) !== initialTree || childEvidence(c.store.state.threads[rootId]) !== initialEvidence) fail('PREVIOUS_WORK_UNVERIFIED');
  return { resumed, epoch };
}
