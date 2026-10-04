import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { Discovery, inputs } from './discovery.mjs';
import { SafeError } from './safety.mjs';

const identity = 'codex-dot-probe-v1';
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const descriptions = {
  codex_repositories_list: 'Discover immediate Git repository directories under canonical the configured projects directory. Marker metadata only; no repository content reads. Cursors expire on restart.',
  codex_chats_list: 'List local root chats whose existing canonical cwd is under the configured projects directory, optionally within repository. Bounded pages; no chat is resumed or subscribed.',
  codex_chat_history: 'Read a bounded newest-first history page for a scoped chat. Only user/assistant text, with best-effort credential redaction and explicit truncation. No reasoning, commands, files or tool output. Each page rechecks cwd; no resume. limit bounds native items; legacy fallback returns one turn with newest messages first. maxChars bounds text characters. Follow nextCursor to continue a truncated message before advancing the native page; HISTORY_CHANGED requires a fresh read. Assistant phase identifies final/progress text.',
};

export function createServer(discovery = new Discovery(), descriptionOverrides = {}) {
  // Keep the original server identity and probe contract compatible with the existing connection.
  const server = new McpServer({ name: 'codex-dot-probe', version: '0.1.0' });
  server.registerTool('connectivity_probe', {
    description: 'Echo a fresh random nonce and a fixed test identity. No machine access.',
    inputSchema: z.object({ nonce: nonceSchema }).strict(),
    outputSchema: z.object({ nonce: nonceSchema, identity: z.literal(identity) }).strict(), annotations,
  }, async ({ nonce }) => result({ nonce, identity }));
  for (const [name, schema] of Object.entries(inputs)) {
    server.registerTool(name, { description: descriptionOverrides[name] ?? descriptions[name], inputSchema: schema, annotations }, async args => {
      try { return result(await discovery.call(name, args)); }
      catch (error) {
        const code = error instanceof SafeError ? error.code : 'READ_FAILED';
        return { isError: true, content: [{ type: 'text', text: `Read-only request failed: ${code}.` }] };
      }
    });
  }
  const closeMcp = server.close.bind(server);
  server.close = async () => { discovery.close(); await closeMcp(); };
  return server;
}
function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createServer(), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }),
    onerror: () => console.error('MCP transport error.'),
  });
  async function stop() {
    try { await handle.close(); }
    catch { console.error('MCP shutdown failed.'); process.exitCode = 1; }
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
