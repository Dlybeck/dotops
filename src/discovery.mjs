import path from 'node:path';
import { z } from 'zod';
import { ProjectScope, Cursors, safeText, inside, fail } from './safety.mjs';
import { AppServerClient, threadIdSchema } from './app-server.mjs';
import { messageFingerprint, messagePage } from './history-text.mjs';

const cursor = z.string().min(1).max(4096).optional();
const limit = z.number().int().min(1).max(20).default(10);
export const inputs = {
  codex_repositories_list: z.object({ cursor, limit }).strict(),
  codex_chats_list: z.object({ repository: z.string().min(1).max(512).optional(), cursor, limit, archived: z.boolean().default(false) }).strict(),
  codex_chat_history: z.object({ threadId: threadIdSchema, cursor, limit, maxChars: z.number().int().min(200).max(12000).default(6000) }).strict(),
};
const boundedId = value => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
const states = new Set(['notLoaded', 'idle', 'active', 'systemError']);
const sources = ['cli', 'vscode', 'exec', 'appServer'];
const nextPosition = value => {
  if (value == null) return null;
  if (typeof value !== 'string' || !value || value.length > 2048) fail('INVALID_BACKEND_RESPONSE');
  return value;
};
const rows = (response, max) => {
  if (!Array.isArray(response?.data) || response.data.length > max) fail('INVALID_BACKEND_RESPONSE');
  return response.data;
};

export class Discovery {
  constructor({ scope = new ProjectScope(), backend = new AppServerClient(), cursors = new Cursors() } = {}) {
    this.scope = scope; this.backend = backend; this.cursors = cursors;
  }
  async call(name, args) {
    const parsed = inputs[name]?.safeParse(args);
    if (!parsed?.success) fail('INVALID_INPUT');
    let result;
    if (name === 'codex_repositories_list') result = await this.repositories(parsed.data);
    if (name === 'codex_chats_list') result = await this.chats(parsed.data);
    if (name === 'codex_chat_history') result = await this.history(parsed.data);
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) fail('OUTPUT_LIMIT');
    return result;
  }
  async repositories({ cursor, limit }) {
    const binding = JSON.stringify(['repositories', limit]);
    const offset = this.cursors.decode(cursor, binding) ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000) fail('INVALID_CURSOR');
    const all = await this.scope.repositories();
    return { scope: this.scope.root, repositories: all.slice(offset, offset + limit),
      nextCursor: offset + limit < all.length ? this.cursors.encode(binding, offset + limit) : null };
  }
  async chats({ repository, cursor, limit, archived }) {
    const root = repository ? await this.scope.directory(repository) : this.scope.root;
    await this.scope.directory(root);
    const binding = JSON.stringify(['chats', root, limit, archived]);
    let position = this.cursors.decode(cursor, binding);
    const chats = [];
    for (let pages = 0; pages < 5; pages++) {
      const response = await this.backend.request('thread/list', {
        limit, cursor: position, archived, useStateDbOnly: true, sourceKinds: sources,
      });
      for (const thread of rows(response, limit)) {
        if (!thread || !threadIdSchema.safeParse(thread.id).success || !sources.includes(thread.source) || thread.parentThreadId) continue;
        let cwd;
        try { cwd = await this.scope.cwd(thread.cwd); } catch { continue; }
        if (!inside(root, cwd)) continue;
        const title = safeText(thread.name, 240);
        chats.push({ originalCwd: thread.cwd, threadId: thread.id, title: title.text, cwd, repository: this.scope.root === '/' ? cwd : path.relative(this.scope.root, cwd) || '.',
          source: thread.source, status: states.has(thread.status?.type) ? thread.status.type : 'unknown',
          titleRedacted: title.redacted, titleTruncated: title.truncated });
      }
      const next = nextPosition(response.nextCursor);
      if (next && next === position) fail('INVALID_BACKEND_RESPONSE');
      position = next;
      if (chats.length || !position) break;
    }
    await this.scope.directory(root);
    // Repeat checks after asynchronous inventory work; never publish a now-escaped cwd.
    const checked = [];
    for (const chat of chats) {
      if (await this.scope.cwd(chat.originalCwd).catch(() => null) === chat.cwd) {
        const { originalCwd, ...published } = chat;
        checked.push(published);
      }
    }
    return { scope: this.scope.root, chats: checked,
      nextCursor: position ? this.cursors.encode(binding, position) : null };
  }
  async metadata(threadId) {
    const response = await this.backend.request('thread/read', { threadId, includeTurns: false });
    if (!response.thread || response.thread.id !== threadId) fail('INVALID_BACKEND_RESPONSE');
    const cwd = await this.scope.cwd(response.thread.cwd);
    return { cwd, status: states.has(response.thread.status?.type) ? response.thread.status.type : 'unknown' };
  }
  async history({ threadId, cursor, limit, maxChars }) {
    const binding = JSON.stringify(['history', threadId, limit, maxChars]);
    const position = this.cursors.decode(cursor, binding) ?? { mode: 'items', cursor: null };
    if (!position || !['items', 'turns'].includes(position.mode)) fail('INVALID_CURSOR');
    const before = await this.metadata(threadId); // No content request until cwd is canonical and scoped.
    let response, mode = position.mode;
    if (mode === 'items') {
      try {
        response = await this.backend.request('thread/items/list', { threadId, cursor: position.cursor, limit, sortDirection: 'desc' });
      } catch (error) {
        if (error.code !== 'HISTORY_UNAVAILABLE' || position.cursor) throw error;
        mode = 'turns'; // Official bounded-turn pagination for older stored histories; no full-thread hydration.
      }
    }
    if (mode === 'turns') response = await this.backend.request('thread/turns/list', {
      threadId, cursor: position.cursor, limit: 1, itemsView: 'full', sortDirection: 'desc',
    });
    const data = rows(response, mode === 'items' ? limit : 1);
    const after = await this.metadata(threadId);
    if (before.cwd !== after.cwd) fail('OUT_OF_SCOPE');
    const messages = []; const seen = new Set();
    let omittedNonMessageItems = 0;
    function add(item, turnId) {
      if (!item || !['userMessage', 'agentMessage'].includes(item.type)) { omittedNonMessageItems++; return; }
      if (!boundedId(item.id) || !boundedId(turnId)) fail('INVALID_BACKEND_RESPONSE');
      const key = JSON.stringify([turnId, item.id]);
      if (seen.has(key)) fail('INVALID_BACKEND_RESPONSE'); seen.add(key);
      messages.push({ item, turnId });
    }
    for (const entry of data) {
      if (mode === 'items') add(entry.item, entry.turnId);
      else {
        if (!Array.isArray(entry.items)) fail('INVALID_BACKEND_RESPONSE');
        // Native turns are bounded by the transport payload cap; never expose non-message items.
        for (const item of [...entry.items].reverse()) add(item, entry.id);
      }
    }
    const next = nextPosition(response.nextCursor);
    if (next && next === position.cursor) fail('INVALID_BACKEND_RESPONSE');
    const fingerprint = messageFingerprint(messages, next);
    if (position.fingerprint !== undefined && position.fingerprint !== fingerprint) fail('HISTORY_CHANGED');
    const page = messagePage(messages, { index: position.index ?? 0, offset: position.offset ?? 0, maxChars });
    const continuation = page.continuation ? { mode, cursor: position.cursor ?? null, fingerprint, ...page.continuation } : next ? { mode, cursor: next } : null;
    return { scope: this.scope.root, threadId, cwd: after.cwd, status: after.status, entries: page.entries,
      paginationUnit: mode === 'items' ? 'items' : 'turns', order: 'newestFirst', omittedNonMessageItems, omittedMessages: 0,
      textContinuation: !!page.continuation, nextCursor: continuation ? this.cursors.encode(binding, continuation) : null };
  }
  close() { this.backend.close(); }
}
