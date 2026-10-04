import { createHash } from 'node:crypto';
import { uuid } from './native.mjs';
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value;
}
export const historyFingerprint = history => createHash('sha256').update(JSON.stringify(ordered(history))).digest('hex');
const unique = values => values.every(value => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;
function full(history) {
  return history.complete && unique(history.data.map(turn => turn.id)) && history.data.every(turn =>
    turn.itemsView === 'full' && Array.isArray(turn.items) && unique(turn.items.map(item => item.id)));
}
// A visible item is inherited only with native fork lineage and a complete,
// ordered prefix of the source's full content. IDs or timestamps alone are not
// provenance. Failed proof returns no exemptions; normal lineage checks apply.
export function inheritedTurns(frame, source) {
  const result = new Set();
  if (!source || frame.thread.parentThreadId !== source.thread.id || frame.thread.forkedFromId !== source.thread.id ||
    !uuid.safeParse(source.thread.sessionId).success || frame.thread.sessionId !== source.thread.sessionId ||
    !full(frame.history) || !full(source.history)) return result;
  const child = [...frame.history.data].reverse(), parent = [...source.history.data].reverse();
  for (let index = 0; index < child.length && index < parent.length; index++) {
    const copy = child[index], original = parent[index];
    if (copy.id !== original.id || copy.items.length > original.items.length ||
      copy.items.some((item, i) => historyFingerprint(item) !== historyFingerprint(original.items[i]))) break;
    // A partial mid-turn snapshot must carry the native interruption marker.
    if (copy.items.length < original.items.length && copy.status !== 'interrupted') break;
    result.add(copy.id);
    if (copy.items.length < original.items.length) break;
  }
  return result;
}
