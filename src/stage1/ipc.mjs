import { homedir } from 'node:os';
import net from 'node:net';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SafeError, fail } from '../safety.mjs';
import { inputs } from './controller.mjs';
import { controlDiagnostic } from './execution.mjs';

export const STATE_DIR = path.join(homedir(), 'Projects/codex-dot-connector/var/stage1');
const envelope = z.object({ id: z.string().uuid(), tool: z.enum(Object.keys(inputs)), args: z.unknown() }).strict();
export function listen(controller, socketPath) {
  const sockets = new Set(); const jobs = new Set();
  const server = net.createServer(socket => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); let buffer = ''; let used = false; let receivedBytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('data', bytes => {
      if (used) { socket.destroy(); return; }
      receivedBytes += bytes.length; if (receivedBytes > 65536) { socket.destroy(); return; }
      try { buffer += decoder.decode(bytes, { stream: true }); } catch { socket.destroy(); return; }
      const pos = buffer.indexOf('\n'); if (pos < 0) return;
      used = true; let parsed;
      try { if (buffer.slice(pos + 1).trim()) throw new Error(); parsed = envelope.parse(JSON.parse(buffer.slice(0, pos))); } catch { socket.destroy(); return; }
      const job = (async () => {
        let reply;
        try { reply = { id: parsed.id, result: await controller.call(parsed.tool, parsed.args) }; }
        catch (e) {
          const diagnostic = controlDiagnostic.safeParse(e.diagnostic);
          reply = { id: parsed.id, error: e instanceof SafeError ? e.code : 'CONTROL_FAILED',
            ...(e instanceof SafeError && diagnostic.success ? { diagnostic: diagnostic.data } : {}) };
        }
        let body = JSON.stringify(reply); if (Buffer.byteLength(body) > 32768) body = JSON.stringify({ id: parsed.id, error: 'RESULT_TOO_LARGE' });
        if (!socket.destroyed) socket.end(body + '\n');
      })(); jobs.add(job); job.finally(() => jobs.delete(job));
    });
  });
  return { server, sockets, jobs, socketPath };
}
export class WatchdogClient {
  constructor(socketPath = STATE_DIR + '/control.sock') { this.socketPath = socketPath; }
  async call(tool, args) {
    if (!inputs[tool]?.safeParse(args).success) fail('INVALID_INPUT');
    const dir = path.dirname(this.socketPath);
    const [d, s] = await Promise.all([lstat(dir), lstat(this.socketPath)]).catch(() => fail('WATCHDOG_UNAVAILABLE'));
    if (!d.isDirectory() || d.uid !== process.getuid() || (d.mode & 0o777) !== 0o700 || await realpath(dir) !== dir || !s.isSocket() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600) fail('UNSAFE_CONTROL_SOCKET');
    const id = randomUUID();
    const request = JSON.stringify({ id, tool, args }) + '\n';
    if (Buffer.byteLength(request) > 65536) fail('REQUEST_TOO_LARGE');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath); let buffer = ''; let done = false; let receivedBytes = 0; const decoder = new TextDecoder('utf-8', { fatal: true });
      const end = (error, value, diagnostic) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(new SafeError(error, diagnostic)) : resolve(value); };
      const timer = setTimeout(() => end('WATCHDOG_REPLY_UNKNOWN'), 14000);
      socket.once('connect', () => socket.write(request));
      socket.on('error', () => end('WATCHDOG_UNAVAILABLE'));
      socket.on('close', () => { if (!done) end('WATCHDOG_REPLY_UNKNOWN'); });
      socket.on('data', bytes => {
        receivedBytes += bytes.length; if (receivedBytes > 32768) { end('INVALID_WATCHDOG_RESPONSE'); return; }
        try { buffer += decoder.decode(bytes, { stream: true }); } catch { end('INVALID_WATCHDOG_RESPONSE'); return; }
        const pos = buffer.indexOf('\n'); if (pos < 0) return;
        try { const reply = JSON.parse(buffer.slice(0, pos)); if (reply.id !== id) throw new Error(); if (reply.error) {
          const diagnostic = controlDiagnostic.safeParse(reply.diagnostic);
          end(/^[A-Z_]{1,80}$/.test(reply.error) ? reply.error : 'CONTROL_FAILED', null, diagnostic.success ? diagnostic.data : undefined);
        } else if (reply.result && typeof reply.result === 'object') end(null, reply.result); else throw new Error(); }
        catch { end('INVALID_WATCHDOG_RESPONSE'); }
      });
    });
  }
  close() { /* Each bounded call owns and closes its own IPC connection. */ }
}
