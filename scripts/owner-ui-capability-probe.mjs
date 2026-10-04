import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { McpServer, inputRequired, inputResponse, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// Standalone diagnostic only. No native client, journal, policy or approval API.
// MCP input is not owner authentication. This probe never grants execution.
export function createOwnerUiProbe({ now = Date.now } = {}) {
  const server = new McpServer({ name: 'dot-owner-ui-capability-probe', version: '1.0.0' });
  const pending = new Map();
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const base = { host: hostname(), probeOnly: true, authenticatedOwner: false, executionAuthorized: false, nativeDispatches: 0 };
  server.registerTool('dot_owner_ui_probe', {
    description: 'No-side-effect UI delivery diagnostic. Requests an MCP form only if the client advertises support. A response is NOT authenticated owner consent and never changes native permissions or executes an action.',
    inputSchema: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ nonce }, ctx) => {
    const state = ctx.mcpReq.requestState();
    if (state !== undefined) {
      const record = pending.get(state);
      const response = inputResponse(ctx.mcpReq.inputResponses, 'ownerUi');
      if (!record || record.nonce !== nonce || now() >= record.expiresAt || response.kind !== 'elicit') {
        return result({ ...base, state: 'invalidOrStale', probeInputObserved: false });
      }
      pending.delete(state);
      const accepted = response.action === 'accept' && response.content?.seen === 'seen' && Object.keys(response.content).length === 1;
      return result({ ...base, nonce, state: accepted ? 'inputObservedUnverified' : response.action === 'decline' ? 'declined' : 'cancelledOrInvalid',
        probeInputObserved: accepted, ownerVerification: 'No owner provenance contract; an MCP response alone is untrusted.' });
    }
    const caps = ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities() ?? {};
    const elicitation = caps.elicitation;
    const form = elicitation && (elicitation.form !== undefined || elicitation.url === undefined);
    if (!form) return result({ ...base, nonce, state: 'formCapabilityNotAdvertised', probeInputObserved: false });
    for (const [id, record] of pending) if (now() >= record.expiresAt) pending.delete(id);
    if (pending.size >= 16) return result({ ...base, state: 'busy', probeInputObserved: false });
    const id = randomUUID(); pending.set(id, { nonce, expiresAt: now() + 90000 });
    return inputRequired({ requestState: id, inputRequests: { ownerUi: inputRequired.elicit({ mode: 'form',
      message: `Dot UI delivery diagnostic on ${hostname()}. Nonce ${nonce}. This is not an approval: no native action, permissions, deployment or execution. Select Seen only to confirm that this form appeared; decline/cancel is equally safe.`,
      requestedSchema: { type: 'object', properties: { seen: { type: 'string', enum: ['seen'], title: 'I saw this diagnostic form' } }, required: ['seen'] },
    }) } });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createOwnerUiProbe(), { transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }),
    onerror: () => console.error('Owner UI probe transport error.') });
  const close = () => handle.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
