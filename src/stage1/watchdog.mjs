import { once } from 'node:events';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { Controller } from './controller.mjs';
import { listen, STATE_DIR } from './ipc.mjs';

// CLI-only fixture overrides; no tool permits changing scope, native socket or state location.
const args = process.argv.slice(2); const options = { stateDir: STATE_DIR };
const flags = { '--state-dir': 'stateDir', '--projects-root': 'root', '--native-socket': 'socketPath', '--context-file': 'contextFile' };
const seen = new Set();
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (seen.has(flag)) throw new Error('Invalid watchdog argument.'); seen.add(flag);
  if (flag === '--access-mode' && ['stage1', 'user-directories'].includes(value)) options.accessMode = value;
  else if (flags[flag] && value?.startsWith('/')) options[flags[flag]] = value;
  else throw new Error('Invalid watchdog argument.');
}
if (options.accessMode === 'user-directories' && options.root) throw new Error('Conflicting scope arguments.');
process.umask(0o077);
let controller; let handle; let stopping = false; let monitor;
async function close() {
  if (stopping) return; stopping = true;
  clearInterval(monitor);
  if (handle) { for (const s of handle.sockets) s.destroy(); await new Promise(r => handle.server.close(r)); await Promise.allSettled(handle.jobs); }
  await controller?.close();
}
try {
  controller = await Controller.open(options); const socketPath = options.stateDir + '/control.sock';
  const old = await lstat(socketPath).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (old) { if (!old.isSocket() || old.uid !== process.getuid()) throw new Error(); await unlink(socketPath); }
  handle = listen(controller, socketPath); handle.server.listen(socketPath); await once(handle.server, 'listening'); await chmod(socketPath, 0o600);
  process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; })); process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; }));
  console.log('Stage 1 watchdog ready.');
  monitor = setInterval(() => { if (controller.failed) { process.exitCode = 1; close().catch(() => {}); } }, 250);
} catch { console.error('Stage 1 watchdog startup failed.'); process.exitCode = 1; await close(); }
