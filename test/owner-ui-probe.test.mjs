import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
const serverPath = fileURLToPath(new URL('../scripts/owner-ui-capability-probe.mjs', import.meta.url));
const nonce = 'A'.repeat(32);

for (const mode of ['legacy', { pin: '2026-07-28' }]) {
  for (const action of ['accept', 'decline', 'cancel', 'unsupported']) test(`UI probe ${JSON.stringify(mode)} ${action}: no owner grant`, async t => {
    const client = new Client({ name: 'automated-fixture-not-owner', version: '1' }, {
      versionNegotiation: { mode }, capabilities: action === 'unsupported' ? {} : { elicitation: { form: {} } },
    });
    let forms = 0;
    if (action !== 'unsupported') client.setRequestHandler('elicitation/create', async request => {
      forms++; assert.match(request.params.message, /not an approval/);
      return { action, ...(action === 'accept' ? { content: { seen: 'seen' } } : typeof mode === 'string' ? { content: null } : {}) };
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], stderr: 'pipe' });
    t.after(async () => { await client.close(); await transport.close(); });
    await client.connect(transport, { timeout: 2000 });
    const value = (await client.callTool({ name: 'dot_owner_ui_probe', arguments: { nonce } })).structuredContent;
    assert.equal(value.authenticatedOwner, false); assert.equal(value.executionAuthorized, false); assert.equal(value.nativeDispatches, 0);
    assert.equal(value.probeInputObserved, action === 'accept'); assert.equal(forms, action === 'unsupported' ? 0 : 1);
  });
}
