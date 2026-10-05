import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { APP_SERVER_SOCKET } from '../app-server.mjs';
import { SafeError, fail } from '../safety.mjs';
import { skillSelection } from './skills.mjs';

export const uuid = z.string().uuid();
const token = z.string().min(1).max(200);
const thread = { threadId: uuid };
const page = { limit: z.number().int().min(1).max(20), cursor: z.string().max(2048).nullable().optional() };
const historyMethods = new Set(['thread/turns/list', 'thread/items/list']);
const input = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(16000) }).strict(),
  skillSelection.extend({ type: z.literal('skill') }),
])).min(1).max(17).refine(items => items[0].type === 'text' && items.slice(1).every(item => item.type === 'skill'));
const methods = {
  'skills/list': z.object({ cwds: z.array(z.string().min(1).max(512)).length(1), forceReload: z.boolean() }).strict(),
  'account/read': z.object({ refreshToken: z.literal(false) }).strict(),
  'thread/start': z.object({ cwd: z.string().min(1).max(512), historyMode: z.literal('legacy').optional() }).strict(),
  'thread/name/set': z.object({ ...thread, name: z.string().min(1).max(160) }).strict(),
  'thread/read': z.object({ ...thread, includeTurns: z.literal(false) }).strict(),
  'thread/list': z.object({ ancestorThreadId: uuid, archived: z.boolean(), useStateDbOnly: z.literal(true),
    sourceKinds: z.tuple([z.literal('cli'), z.literal('vscode'), z.literal('exec'), z.literal('appServer'),
      z.literal('subAgent'), z.literal('subAgentReview'), z.literal('subAgentCompact'), z.literal('subAgentThreadSpawn'),
      z.literal('subAgentOther'), z.literal('unknown')]), ...page }).strict(),
  'thread/resume': z.object({ ...thread, excludeTurns: z.literal(true) }).strict(),
  'thread/loaded/list': z.object(page).strict(),
  'thread/turns/list': z.object({ ...thread, ...page, itemsView: z.literal('full'), sortDirection: z.literal('desc') }).strict(),
  'thread/items/list': z.object({ ...thread, turnId: token, ...page, sortDirection: z.literal('asc') }).strict(),
  'thread/backgroundTerminals/list': z.object({ ...thread, ...page }).strict(),
  'thread/backgroundTerminals/terminate': z.object({ ...thread, processId: token }).strict(),
  'thread/goal/clear': z.object(thread).strict(),
  'thread/goal/set': z.object({ ...thread, objective: z.string().min(1).max(16000).optional(),
    status: z.enum(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']).optional(),
    tokenBudget: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict(),
  'thread/goal/get': z.object(thread).strict(),
  'thread/queue/list': z.object({ ...thread, ...page }).strict(),
  'turn/start': z.object({ ...thread, input, clientUserMessageId: uuid, effort: z.literal('low').optional() }).strict(),
  'turn/steer': z.object({ ...thread, input, clientUserMessageId: uuid, expectedTurnId: token }).strict(),
  'turn/interrupt': z.object({ ...thread, turnId: token }).strict(),
};

// One socket, no mutation replay. Replies to ordinary Q&A are separate from native permissions.
export class Native extends EventEmitter {
  constructor({ socketPath = APP_SERVER_SOCKET, timeoutMs = 4000 } = {}) {
    super(); this.now = () => Date.now(); this.socketPath = socketPath; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.outstanding = new Set(); this.counter = 0; this.epoch = 0; this.closed = false;
    this.historyLimits = new Map();
  }
  async request(method, params, { deadlineAt } = {}) {
    if (!methods[method]?.safeParse(params).success) fail('FORBIDDEN_RPC');
    if (deadlineAt !== undefined && (!Number.isSafeInteger(deadlineAt) || this.now() >= deadlineAt)) fail('DEADLINE_EXPIRED');
    let limit = historyMethods.has(method) ? Math.min(params.limit, this.historyLimits.get(method) ?? 20) : null;
    for (;;) {
      if (deadlineAt !== undefined && this.now() >= deadlineAt) fail('DEADLINE_EXPIRED');
      const connection = this.connect();
      if (limit !== null && deadlineAt !== undefined) {
        let timer;
        try {
          await Promise.race([connection, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new SafeError('HISTORY_READ_BUDGET_EXHAUSTED')), Math.max(1, deadlineAt - this.now()));
          })]);
        } finally { clearTimeout(timer); }
      } else await connection;
      // Connection setup may consume the remaining watchdog deadline. No wire
      // mutation has happened yet, so expiration here is known not-dispatched.
      if (deadlineAt !== undefined && this.now() >= deadlineAt) fail('DEADLINE_EXPIRED');
      try {
        const result = await this.dispatch(method, limit === null ? params : { ...params, limit }, limit === null ? undefined : deadlineAt);
        if (limit !== null && deadlineAt !== undefined && this.now() >= deadlineAt) fail('HISTORY_READ_BUDGET_EXHAUSTED');
        if (limit !== null && Array.isArray(result.data) && result.data.length > limit) fail('INVALID_BACKEND_RESPONSE');
        return result;
      }
      catch (e) {
        // Retry only bounded history reads, at the same cursor. Never replay a
        // mutation or an ordinary disconnect. A single oversized record cannot
        // be read safely through this API and remains explicitly unsupported.
        if (limit === null || e.code !== 'NATIVE_RESPONSE_TOO_LARGE' || limit === 1) throw e;
        limit = Math.max(1, Math.floor(limit / 2));
        this.historyLimits.set(method, limit);
      }
    }
  }
  async connect() {
    if (this.closed) fail('DAEMON_UNAVAILABLE');
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connecting = this.open();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  async open() {
    const socket = new WebSocket(`ws+unix:${this.socketPath}:/`, { handshakeTimeout: this.timeoutMs, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    this.socket = socket; const epoch = ++this.epoch;
    socket.on('error', e => this.drop(socket, e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'NATIVE_RESPONSE_TOO_LARGE' : 'DAEMON_UNAVAILABLE'));
    socket.on('close', () => this.drop(socket));
    socket.on('message', (bytes, binary) => {
      if (this.socket !== socket) return;
      let m; try { if (binary) throw new Error(); m = JSON.parse(bytes.toString()); if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(); }
      catch { this.drop(socket); return; }
      if (m.method) { this.emit('event', { ...m, epoch }); return; }
      this.outstanding.delete(m.id);
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.error) {
        const error = new SafeError(m.error.code === -32601 ? 'UNSUPPORTED_RPC' : 'BACKEND_REJECTED');
        // Keep only a numeric code and a fixed reason, never backend text/data.
        error.nativeRejection = { rpcCode: Number.isSafeInteger(m.error.code) ? m.error.code : null,
          reason: p.method === 'turn/steer' && m.error.code === -32600 && m.error.message === 'no active turn to steer'
            ? 'noActiveTurn'
            : p.method === 'thread/resume' && m.error.code === -32600 && m.error.message ===
              'cannot resume an unloaded multi-agent v2 sub-agent through its parent; resume the parent first, or use thread/read to inspect it'
              ? 'unloadedMultiAgentV2Subagent' : 'unclassified' };
        p.reject(error);
      }
      else if (m.result && typeof m.result === 'object') p.resolve(m.result);
      else p.reject(new SafeError('INVALID_BACKEND_RESPONSE'));
    });
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(new SafeError('DAEMON_UNAVAILABLE'))); });
      await this.dispatch('initialize', { clientInfo: { name: 'codex_dot_stage1', version: '0.3.0' }, capabilities: { experimentalApi: true } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    } catch { this.drop(socket); fail('DAEMON_UNAVAILABLE'); }
  }
  dispatch(method, params, historyDeadlineAt) {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new SafeError('DAEMON_UNAVAILABLE'));
    if (this.outstanding.size >= 16) return Promise.reject(new SafeError('BUSY'));
    const socket = this.socket; const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const remaining = historyDeadlineAt === undefined ? this.timeoutMs : historyDeadlineAt - this.now();
      const budgetLimited = historyDeadlineAt !== undefined && remaining <= this.timeoutMs;
      const timer = setTimeout(() => {
        if (!budgetLimited) { this.drop(socket); return; }
        // Expiring one read must not expire concurrent callers. Its wire request
        // remains outstanding until a late response or disconnect, preserving
        // size-error attribution and the sixteen-request capacity bound.
        this.pending.delete(id);
        reject(new SafeError('HISTORY_READ_BUDGET_EXHAUSTED'));
      }, Math.max(1, Math.min(this.timeoutMs, remaining)));
      this.pending.set(id, { resolve, reject, timer, method });
      this.outstanding.add(id);
      socket.send(JSON.stringify({ id, method, params }), error => { if (error) this.drop(socket); });
    });
  }
  ordinaryAnswer(epoch, id, answers) {
    if (epoch !== this.epoch || this.socket?.readyState !== WebSocket.OPEN) fail('STALE_QUESTION');
    this.socket.send(JSON.stringify({ id, result: { answers } }));
  }
  drop(socket, code = 'DAEMON_UNAVAILABLE') {
    if (this.socket !== socket) return;
    this.socket = null; socket.terminate();
    const attributable = this.outstanding.size === 1 && this.pending.size === 1;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      // Oversized frames cannot expose their response ID. With concurrent RPCs,
      // retain transport uncertainty instead of naming an unrelated record.
      p.reject(new SafeError(attributable && historyMethods.has(p.method) ? code : 'DAEMON_UNAVAILABLE'));
    }
    this.pending.clear(); this.outstanding.clear(); this.emit('disconnect', this.epoch);
  }
  close() { this.closed = true; if (this.socket) this.drop(this.socket); }
}
