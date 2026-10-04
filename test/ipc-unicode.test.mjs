import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { listen, WatchdogClient } from '../src/stage1/ipc.mjs';
import { A } from './stage1-fixture.mjs';

async function location(t) {
  const dir = await mkdtemp('/tmp/dot-ipc-unicode-'); await mkdir(dir + '/state', { mode: 0o700 });
  t.after(() => rm(dir, { recursive: true, force: true })); return dir + '/state/control.sock';
}
async function fragments(socket, body) {
  const bytes = Buffer.from(body);
  for (let i = 0; i < bytes.length; i++) {
    socket.write(bytes.subarray(i, i + 1)); await new Promise(resolve => setTimeout(resolve, 1));
  }
}
test('private IPC request preserves Unicode split across byte-sized stream chunks', async t => {
  const file = await location(t); let received;
  const handle = listen({ async call(tool, args) { received = args.text; return { text: args.text }; } }, file);
  handle.server.listen(file); await once(handle.server, 'listening'); await chmod(file, 0o600);
  t.after(async () => { for (const s of handle.sockets) s.destroy(); await new Promise(r => handle.server.close(r)); });
  const socket = net.createConnection(file); t.after(() => socket.destroy()); await once(socket, 'connect');
  const output = []; socket.on('data', bytes => output.push(bytes));
  const done = once(socket, 'end'); const text = 'Request 🍀 界 é';
  await fragments(socket, JSON.stringify({ id: randomUUID(), tool: 'codex_chat_send',
    args: { requestId: randomUUID(), threadId: A, text } }) + '\n');
  await done; assert.equal(received, text); assert.equal(JSON.parse(Buffer.concat(output)).result.text, text);
});
test('private IPC response preserves split Unicode instead of replacing bytes', async t => {
  const file = await location(t); const text = 'Result 🍀 界 é';
  const server = net.createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (!bytes.includes(10)) return;
      const { id } = JSON.parse(bytes);
      fragments(socket, JSON.stringify({ id, result: { text } }) + '\n').then(() => socket.end());
    });
  });
  server.listen(file); await once(server, 'listening'); await chmod(file, 0o600);
  t.after(() => new Promise(r => server.close(r)));
  const response = await new WatchdogClient(file).call('codex_chat_status', { threadId: A });
  assert.equal(response.text, text);
});
test('invalid UTF-8 request cannot become replacement-character model input', async t => {
  const file = await location(t); let calls = 0;
  const handle = listen({ async call() { calls++; return {}; } }, file);
  handle.server.listen(file); await once(handle.server, 'listening'); await chmod(file, 0o600);
  t.after(async () => { for (const s of handle.sockets) s.destroy(); await new Promise(r => handle.server.close(r)); });
  const socket = net.createConnection(file); socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect'); const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(Buffer.concat([Buffer.from('{"text":"'), Buffer.from([255]), Buffer.from('"}\n')]));
  await closed; assert.equal(calls, 0);
});

test('oversized explicit skill request is rejected before IPC delivery instead of becoming unknown',async t=>{
 const file=await location(t);let connections=0;
 const server=net.createServer(socket=>{connections++;socket.destroy();});server.listen(file);await once(server,'listening');await chmod(file,0o600);t.after(()=>new Promise(r=>server.close(r)));
 const args={threadId:A,requestId:randomUUID(),text:'x'.repeat(8000),skills:Array.from({length:16},(_,i)=>({name:'example:'+i,path:'/'+'x'.repeat(4095)}))};
 await assert.rejects(new WatchdogClient(file).call('codex_chat_send',args),{code:'REQUEST_TOO_LARGE'});assert.equal(connections,0);
});
