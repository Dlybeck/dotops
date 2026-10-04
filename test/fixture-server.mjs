// Test-only entrypoint: no production config/environment override exists.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/server.mjs';
import { Discovery } from '../src/discovery.mjs';
import { ProjectScope } from '../src/safety.mjs';
import { AppServerClient } from '../src/app-server.mjs';
const service = new Discovery({ scope: new ProjectScope(process.argv[2]), backend: new AppServerClient({ socketPath: process.argv[3], timeoutMs: 1000 }) });
const handle = serveStdio(() => createServer(service), { onerror: () => console.error('Fixture transport error.') });
process.once('SIGINT', () => handle.close());
process.once('SIGTERM', () => handle.close());
