import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createStageServer } from '../stage1/server.mjs';
import { Discovery } from '../discovery.mjs';
import { UserDirectoryScope } from '../safety.mjs';

// Separate opt-in entrypoint: the installed stage-1 bridge retains its original scope.
export function createExpandedServer(adapter, discovery = new Discovery({ scope: new UserDirectoryScope() })) {
  return createStageServer(adapter, discovery, { expanded: true });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createExpandedServer(), { transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }), onerror: () => console.error('MCP transport error.') });
  const close = () => handle.close().catch(() => { process.exitCode = 1; }); process.once('SIGTERM', close); process.once('SIGINT', close);
}
