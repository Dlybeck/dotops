import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createStageServer } from '../src/stage1/server.mjs';
import { createExpandedServer } from '../src/expanded/server.mjs';
import { WatchdogClient } from '../src/stage1/ipc.mjs';
const handle = serveStdio(() => (process.argv[3] === '--expanded' ? createExpandedServer : createStageServer)(new WatchdogClient(process.argv[2])), { transport: new StdioServerTransport(process.stdin, process.stdout), onerror: () => {} });
process.once('SIGTERM', () => handle.close());
