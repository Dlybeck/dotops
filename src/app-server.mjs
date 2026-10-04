import path from 'node:path';
import { homedir } from 'node:os';
import WebSocket from 'ws';
import { z } from 'zod';
import { SafeError, fail } from './safety.mjs';

export const APP_SERVER_SOCKET = path.join(homedir(), '.codex/app-server-control/app-server-control.sock');
const id = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const cursor = z.string().max(2048).nullable().optional();
const readParams = {
  'thread/list': z.object({ limit: z.number().int().min(1).max(20), cursor,
    archived: z.boolean(), useStateDbOnly: z.literal(true),
    sourceKinds: z.tuple([z.literal('cli'), z.literal('vscode'), z.literal('exec'), z.literal('appServer')]),
  }).strict(),
  'thread/read': z.object({ threadId: id, includeTurns: z.literal(false) }).strict(),
  'thread/items/list': z.object({ threadId: id, cursor, limit: z.number().int().min(1).max(20), sortDirection: z.literal('desc') }).strict(),
  'thread/turns/list': z.object({ threadId: id, cursor, limit: z.literal(1), itemsView: z.literal('full'), sortDirection: z.literal('desc') }).strict(),
  'thread/loaded/list': z.object({ limit: z.number().int().min(1).max(20), cursor }).strict(),
};
export const READ_METHODS = Object.freeze(Object.keys(readParams));
export const threadIdSchema = id;

export class AppServerClient {
  #socket;
  #connecting;
  #closed = false;
  #pending = new Map();
  #nextId = 0;
  constructor({ socketPath = APP_SERVER_SOCKET, timeoutMs = 4000, WebSocketClass = WebSocket } = {}) {
    if (!socketPath.startsWith('/') || socketPath.includes(':')) fail('INVALID_SOCKET');
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.WebSocketClass = WebSocketClass;
  }
  async request(method, params) {
    const schema = readParams[method];
    if (!schema || !schema.safeParse(params).success) fail('FORBIDDEN_RPC');
    const socket = await this.#connect();
    // Read requests are not replayed automatically after ambiguous disconnects.
    return this.#dispatch(socket, method, params);
  }
  async #connect() {
    if (this.#closed) fail('DAEMON_UNAVAILABLE');
    if (this.#connecting) return this.#connecting;
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    const connection = this.#open();
    this.#connecting = connection;
    try { return await connection; }
    finally { if (this.#connecting === connection) this.#connecting = undefined; }
  }
  async #open() {
    let socket;
    try {
      socket = new this.WebSocketClass(`ws+unix:${this.socketPath}:/`, {
        handshakeTimeout: this.timeoutMs, maxPayload: 2 * 1024 * 1024,
        perMessageDeflate: false, followRedirects: false,
      });
      this.#socket = socket;
      socket.on('message', (bytes, isBinary) => this.#message(socket, bytes, isBinary));
      socket.on('error', () => this.#drop(socket, 'DAEMON_UNAVAILABLE'));
      socket.on('close', () => this.#drop(socket, 'DAEMON_UNAVAILABLE'));
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new SafeError('DAEMON_UNAVAILABLE')); }, this.timeoutMs);
        const opened = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new SafeError('DAEMON_UNAVAILABLE')); };
        const cleanup = () => { clearTimeout(timer); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); };
        socket.once('open', opened); socket.once('error', failed); socket.once('close', failed);
      });
      if (this.#closed) fail('DAEMON_UNAVAILABLE');
      await this.#dispatch(socket, 'initialize', {
        clientInfo: { name: 'codex_dot_readonly', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      return socket;
    } catch {
      if (socket) { this.#drop(socket, 'DAEMON_UNAVAILABLE'); socket.terminate(); }
      fail('DAEMON_UNAVAILABLE');
    }
  }
  #dispatch(socket, method, params) {
    if (this.#closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new SafeError('DAEMON_UNAVAILABLE'));
    if (this.#pending.size >= 32) return Promise.reject(new SafeError('BUSY'));
    const requestId = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#drop(socket, 'DAEMON_TIMEOUT');
        socket.terminate();
      }, this.timeoutMs);
      this.#pending.set(requestId, { socket, resolve, reject, timer });
      socket.send(JSON.stringify({ id: requestId, method, params }), error => {
        if (error) { this.#drop(socket, 'DAEMON_UNAVAILABLE'); socket.terminate(); }
      });
    });
  }
  #message(socket, bytes, isBinary) {
    let message;
    try {
      if (isBinary) fail('INVALID_BACKEND_RESPONSE');
      message = JSON.parse(bytes.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail('INVALID_BACKEND_RESPONSE');
    } catch { this.#drop(socket, 'INVALID_BACKEND_RESPONSE'); socket.terminate(); return; }
    // Notifications and server-initiated approval/input requests are never answered.
    if (message.method) return;
    const pending = this.#pending.get(message.id);
    if (!pending || pending.socket !== socket) return;
    clearTimeout(pending.timer); this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new SafeError(message.error.code === -32601 ? 'HISTORY_UNAVAILABLE' : 'BACKEND_REQUEST_FAILED'));
    } else if ('result' in message && message.result && typeof message.result === 'object') {
      pending.resolve(message.result);
    } else pending.reject(new SafeError('INVALID_BACKEND_RESPONSE'));
  }
  #drop(socket, code) {
    if (this.#socket === socket) this.#socket = undefined;
    for (const [id, pending] of this.#pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer); this.#pending.delete(id); pending.reject(new SafeError(code));
    }
  }
  close() {
    this.#closed = true;
    const socket = this.#socket;
    if (socket) { this.#drop(socket, 'DAEMON_UNAVAILABLE'); socket.terminate(); }
  }
}
