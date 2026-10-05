import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const R = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const T = '33333333-3333-4333-8333-333333333333';
export async function fixture(t, { temporaryRoot = tmpdir() } = {}) {
  const dir = await realpath(await mkdtemp(path.join(temporaryRoot, 'dot-stage1-')));
  const root = dir + '/Projects'; await mkdir(root); await mkdir(root + '/repo');
  const server = http.createServer(); const wss = new WebSocketServer({ server });
  const connections = new Set(); const threads = new Map(); const calls = [];
  const f = { dir, root, cwd: root + '/repo', socket: dir + '/native.sock', threads, calls, connections };
  f.thread = (id = A) => ({ id, sessionId: A, cwd: f.cwd, environments: [{ environmentId: 'local', cwd: f.cwd, runtimeWorkspaceRoots: [f.cwd] }], name: 'test', status: { type: 'idle' }, source: 'appServer', modelProvider: 'openai', parentThreadId: null, turns: [] });
  f.notify = (method, params, requestId) => { for (const s of connections) s.send(JSON.stringify({ method, params, ...(requestId === undefined ? {} : { id: requestId }) })); };
  f.disconnect = () => { for (const s of connections) s.terminate(); };
  wss.on('connection', s => {
    connections.add(s); s.on('close', () => connections.delete(s));
    s.on('message', async b => {
      const q = JSON.parse(b.toString()); calls.push(q);
      if (!q.method || !('id' in q)) return;
      let result;
      if (f.handle && await f.handle(s, q)) return;
      const p = q.params;
      if (q.method === 'initialize') result = {};
      else if (q.method === 'account/read') result = { account: { type: 'chatgpt' } };
      else if (q.method === 'thread/start') { const thread = f.thread(); thread.cwd = p.cwd; thread.environments[0].cwd = p.cwd; thread.environments[0].runtimeWorkspaceRoots = [p.cwd]; threads.set(A, thread); result = { thread }; }
      else if (q.method === 'thread/name/set') { threads.get(p.threadId).name = p.name; result = {}; }
      else if (q.method === 'thread/read' || q.method === 'thread/resume') result = { thread: threads.get(p.threadId) };
      else if (q.method === 'thread/loaded/list') result = { data: [...threads.keys()], nextCursor: null };
      else if (q.method === 'thread/list') {
        const descendants = [...threads.values()].filter(thread => {
          if (Boolean(f.archived?.has(thread.id)) !== p.archived) return false;
          let parent = thread.parentThreadId; const seen = new Set();
          while (parent && !seen.has(parent)) {
            if (parent === p.ancestorThreadId) return true;
            seen.add(parent); parent = threads.get(parent)?.parentThreadId;
          }
          return false;
        });
        const offset = Number(p.cursor ?? 0);
        result = { data: descendants.slice(offset, offset + p.limit),
          nextCursor: offset + p.limit < descendants.length ? String(offset + p.limit) : null };
      }
      else if (q.method === 'thread/turns/list') result = { data: [...(threads.get(p.threadId)?.turns ?? [])].reverse(), nextCursor: null };
      else if (q.method === 'thread/backgroundTerminals/list') result = { data: f.terminals ?? [], nextCursor: null };
      else if (q.method === 'thread/backgroundTerminals/terminate') { f.terminals = (f.terminals ?? []).filter(x => x.processId !== p.processId); result = {}; }
      else if (q.method === 'thread/goal/clear') { f.goal = null; result = {}; }
      else if (q.method === 'thread/goal/set') { f.goal = { ...(f.goal ?? {}), ...(p.objective ? { objective: p.objective } : {}), ...(p.status ? { status: p.status } : {}), ...(p.tokenBudget !== undefined ? { tokenBudget: p.tokenBudget } : {}) }; result = { goal: f.goal }; }
      else if (q.method === 'thread/goal/get') result = { goal: f.goal ?? null };
      else if (q.method === 'thread/queue/list') result = { data: f.queue ?? [], nextCursor: null };
      else if (q.method === 'turn/start') { const thread = threads.get(p.threadId); const turn = { id: T, status: 'inProgress', items: [{ type: 'userMessage', id: 'u', clientId: p.clientUserMessageId, content: p.input }] }; thread.turns.push(turn); thread.status = { type: 'active' }; result = { turn }; }
      else if (q.method === 'turn/steer') result = { turnId: p.expectedTurnId };
      else if (q.method === 'turn/interrupt') { const thread = threads.get(p.threadId); const turn = thread.turns.find(x => x.id === p.turnId); if (turn) turn.status = 'interrupted'; thread.status = { type: 'idle' }; result = {}; }
      else { s.send(JSON.stringify({ id: q.id, error: { code: -32601, message: 'unsupported' } })); return; }
      s.send(JSON.stringify({ id: q.id, result }));
    });
  });
  server.listen(f.socket); await once(server, 'listening');
  t.after(async () => { f.disconnect(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return f;
}
