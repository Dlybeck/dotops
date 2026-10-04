import { pathToFileURL } from 'node:url';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../server.mjs';
import { inputs } from './controller.mjs';
import { WatchdogClient } from './ipc.mjs';
import { SafeError } from '../safety.mjs';
import { controlDiagnostic } from './execution.mjs';

const descriptions = {
  codex_chat_skills: 'Discover native installed skills for an enrolled local chat, with bounded catalog pages. Pass exact enabled name/path pairs through codex_chat_send.skills for structured native invocation. Literal slash text is not desktop slash selection. No model turn, persona/default change, skill enablement, permission change or chat resume.',
  codex_chat_adopt: 'Explicitly enroll one existing idle root chat by threadId and exact canonical expectedCwd. Records no existing turns and starts no model turn; no resume or configuration changes. Rejects active chats, pending queues or unknown native work state and unknown work state. Requires expanded watchdog access.',
  codex_chat_reconcile: 'Explicitly reconcile one enrolled idle/unloaded root and its completed native descendants. Reattach eligible stored sessions without settings overrides, then require fresh complete process/history/goal/queue/lineage verification. Starts no model turn, changes no goals or permissions, grants no old-turn or child-work ownership. Active or unknown work remains blocked. Reuse requestId after uncertainty; prior receipts are not current proof. Read-only status never loads sessions.',
  codex_chat_create: 'Create and name an idle chat inside canonical the configured control directory. No model turn starts. Native blank chats may not be resumable until the first message. Preserve native permissions. Reuse requestId; ambiguous creation is never retried automatically.',
  codex_chat_send: 'Send text and optional explicit installed skill selections to a recorded connector-owned root chat; resume without overrides. Pass exact enabled name/path pairs from codex_chat_skills in skills for native structured input; literal slash text does not select a skill. No connector time window or message-count limit. Optional configured TPM context requires preparation followed by send; preparation sends nothing. Steering requires an exact already-owned turn ID. Native start has a concurrent-UI race. Reuse requestId; never blindly resend.',
  codex_chat_goal: 'Explicitly set, pause, resume or clear a native goal on an enrolled chat. Obtain expectedGoalHash from status. The journal retains goal metadata and private keyed fingerprints; objective previews are transient. No automatic goal repair or permission grant. Native goal changes may affect native continuation. Reuse requestId after unknown delivery; no atomic native comparison is available.',
  codex_chat_status: 'Fresh bounded status for a connector-owned chat, send reconciliation, delivery and stop verification. Acceptance differs from running and terminal state. No global process-stop guarantee.',
  codex_chat_stop: 'Interrupt one exact connector-owned turn and terminate its native tracked terminals. Returns acknowledgement separately from terminal/goal/queue/child verification. Unknown state is reported; no daemon, OS PID, unrelated chat or goal control.',
  codex_chat_questions: 'Poll current ordinary question requests for a connector-owned active turn. Credentials and permission approvals remain with the local human. Question references expire on disconnect, or completion.',
  codex_chat_answer: 'Answer one current ordinary question request using all of its question IDs. Reuse requestId. Stale requests fail; reply delivery is unconfirmed. Never answers native permission approval or secret-input requests.',
};
export function createStageServer(adapter = new WatchdogClient(), discovery, { expanded = false } = {}) {
  const server = createServer(discovery, expanded ? {
    codex_repositories_list: 'List immediate Git repositories under the configured projects directory as a convenience. Chat discovery and targeting also support ordinary accessible non-Git directories; no filesystem-wide crawl.',
    codex_chats_list: 'List existing/future local root chats across normal-user-accessible canonical directories on this native daemon, optionally filtered by absolute directory. Bounded pages; no resume, adoption or model turn.',
    codex_chat_history: 'Read bounded user/assistant history in any normal-user-accessible canonical directory. Credential redaction and cwd rechecks; no resume, commands, reasoning or permission changes.',
  } : {});
  const expandedDescriptions = {
    codex_chat_create: 'Create/name an idle root chat in any normal-user-accessible absolute directory, including non-Git folders. No model turn or permission overrides. Reuse requestId after ambiguity; blank-chat resume may fail before first message.',
    codex_chat_reconcile: 'Explicitly reconcile an enrolled idle/unloaded root and its exact accepted owned operations. Rejoin the root without settings overrides, repair open exact-turn evidence, and require fresh tracked process and continuation proof. Retired historical descendants are not reopened by ancestry. No model start, goal change, permission grant or child-stop authority. Missing evidence stays named and blocked; prior receipts are snapshots.',
    codex_chat_send: 'Send to an explicitly created/adopted root chat, preserving native settings, account and permissions. Optional skills supplies exact enabled name/path pairs from codex_chat_skills as structured native input beside text. Literal slash text is not desktop skill selection; no default skill is injected. New sends verify exact accepted owned operations and fresh native work state; retired historical descendants are not reopened by ancestry. No connector time window or message-count limit. Optional TPM context returns not-sent preparation; follow up with new requestId and preparationId, same or revised text. New start requires expectedLastTurnId and acknowledgeConcurrentStartRisk:true; observed active/unrelated turns reject, unexpected replies remain unowned. Steering requires exact already-owned expectedTurnId. Reuse requestId; never blindly resend.',
  };
  for (const [name, inputSchema] of Object.entries(inputs)) {
    if (name === 'codex_chat_adopt' && !expanded) continue;
    server.registerTool(name, { description: expanded && expandedDescriptions[name] || descriptions[name], inputSchema, annotations: { readOnlyHint: ['codex_chat_status', 'codex_chat_questions', 'codex_chat_skills'].includes(name), destructiveHint: name === 'codex_chat_stop', idempotentHint: true, openWorldHint: false } }, async args => {
    try { const value = await adapter.call(name, args); return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }; }
    catch (e) {
      const diagnostic = controlDiagnostic.safeParse(e.diagnostic);
      return { isError: true, ...(e instanceof SafeError && diagnostic.success ? { structuredContent: diagnostic.data } : {}),
        content: [{ type: 'text', text: `Control request failed: ${e instanceof SafeError ? e.code : 'CONTROL_FAILED'}.` }] };
    }
    });
  }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = serveStdio(() => createStageServer(), { transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }), onerror: () => console.error('MCP transport error.') });
  const close = () => handle.close().catch(() => { process.exitCode = 1; }); process.once('SIGTERM', close); process.once('SIGINT', close);
}
