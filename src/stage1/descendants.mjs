import { uuid } from './native.mjs';
import { historyFingerprint } from './fork-history.mjs';

export const descendantSourceKinds = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'subAgent',
  'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);

// Legacy attachment/verification retains its bounded tree traversal.
export async function readDescendants(c, rootId) {
  return readDescendantInventory(c, rootId, 63, 4);
}

// Current-state admission needs the complete inventory, independent of how many
// historical children legacy attachment could verify. It never resumes them.
export async function readCurrentDescendants(c, rootId) {
  return readDescendantInventory(c, rootId, Infinity, Infinity);
}

// Only the enrolled root's native tree, DB-only, with both archive partitions.
// Pagination holes, collisions and an exceeded legacy bound are not empty proof.
async function readDescendantInventory(c, rootId, maxNodes, maxPages) {
  const threads = new Map();
  for (const archived of [false, true]) {
    let cursor; const cursors = new Set(); let complete = false;
    for (let page = 0; page < maxPages; page++) {
      const result = await c.optional('thread/list', { ancestorThreadId: rootId, archived, useStateDbOnly: true,
        sourceKinds: [...descendantSourceKinds], limit: 20, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || result.data.length > 20) return null;
      for (const thread of result.data) {
        if (!uuid.safeParse(thread?.id).success || thread.id === rootId || threads.has(thread.id) ||
          !uuid.safeParse(thread.parentThreadId).success || thread.parentThreadId === thread.id || threads.size >= maxNodes) return null;
        threads.set(thread.id, { id: thread.id, parentThreadId: thread.parentThreadId, forkedFromId: thread.forkedFromId ?? null,
          sessionId: thread.sessionId ?? null, cwd: thread.cwd, status: thread.status?.type ?? 'unknown', archived });
      }
      cursor = result.nextCursor;
      if (cursor === null) { complete = true; break; }
      if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    if (!complete) return null;
  }
  const entries = [...threads.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { threads, fingerprint: historyFingerprint(entries) };
}
