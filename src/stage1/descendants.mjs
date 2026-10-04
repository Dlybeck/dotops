import { uuid } from './native.mjs';
import { historyFingerprint } from './fork-history.mjs';

export const descendantSourceKinds = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'subAgent',
  'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);

// Only the enrolled root's native tree, DB-only, with both archive partitions.
// Pagination holes, collisions and an exceeded bound are not empty evidence.
export async function readDescendants(c, rootId) {
  const threads = new Map();
  for (const archived of [false, true]) {
    let cursor; const cursors = new Set(); let complete = false;
    for (let page = 0; page < 4; page++) {
      const result = await c.optional('thread/list', { ancestorThreadId: rootId, archived, useStateDbOnly: true,
        sourceKinds: [...descendantSourceKinds], limit: 20, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data) || result.data.length > 20) return null;
      for (const thread of result.data) {
        if (!uuid.safeParse(thread?.id).success || thread.id === rootId || threads.has(thread.id) ||
          !uuid.safeParse(thread.parentThreadId).success || thread.parentThreadId === thread.id || threads.size >= 63) return null;
        threads.set(thread.id, { id: thread.id, parentThreadId: thread.parentThreadId, forkedFromId: thread.forkedFromId ?? null,
          sessionId: thread.sessionId ?? null, cwd: thread.cwd, status: thread.status?.type ?? 'unknown', archived });
      }
      cursor = result.nextCursor;
      if (!cursor) { complete = true; break; }
      if (typeof cursor !== 'string' || cursor.length > 2048 || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
    if (!complete) return null;
  }
  const entries = [...threads.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { threads, fingerprint: historyFingerprint(entries) };
}
