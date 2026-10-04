# Explicit native skill invocation

Skills are optional. Empty/default requests keep the existing text-only behavior.
No package, persona, skill name or workflow is built into the public defaults.

Desktop selection and literal text are different. Enabled skills appear in the
[desktop slash-command list](https://learn.chatgpt.com/docs/reference/slash-commands).
Selecting one there supplies a native skill selection. Sending `/build` as plain
connector text does not perform that selection. A `$skill-name` text marker can
ask the model to resolve a skill, but is not evidence of a structured input item.

The [native App Server skill API](https://learn.chatgpt.com/docs/app-server#skills)
accepts a `skill` item alongside request text. DotOps exposes this directly:

1. Create/enroll the intended local root chat normally.
2. Call `codex_chat_skills` with its `threadId`. Follow `nextCursor` for remaining
   entries. Each entry contains the exact native `name`, absolute `path`, enabled
   state and bounded description. `forceReload:true` refreshes the native catalog;
   it does not enable a skill or start/load a chat. Catalog errors are counted.
3. Pass selected `{name,path}` pairs in `codex_chat_send.skills`, with the usual
   request identity and turn/start correlation fields. For example, after finding
   this exact pair in the native catalog:

```json
{
  "text": "$example:build Implement the approved task.",
  "skills": [{"name":"example:build","path":"/home/user/.agents/skills/build/SKILL.md"}]
}
```

The native delivery input contains one text item followed by the explicit skill
items. Text is not rewritten to expand slash commands, add markers, paraphrase
skill instructions or infer selections from configured persona wording. Exact
names can be namespaced; never guess a shorter alias. Native permissions remain
native. Skill instructions are user context, not permission grants.

Selection is rechecked against the current native catalog before delivery. Missing,
disabled, ambiguous, duplicate or unavailable selections fail before dispatch;
they never silently degrade into prose. No skill is enabled or installed by this
path. Catalog continuations are signed and detect changed snapshots. Transport
byte limits yield a clear error rather than an ambiguous oversized IPC write.
Selections whose acceptance receipt would exceed IPC/MCP response bounds return
`SKILL_RECEIPT_TOO_LARGE` before dispatch; a prepared request remains available
for a smaller selection with a new request ID.
The native API supplies no atomic catalog/file-content snapshot across delivery;
concurrent skill installation/editing remains a native limitation.

Configured TPM preparation still sends no model input or skill invocation. Its
follow-up may send unchanged text and the selected skill items, once. Developer
context remains appended to the end of the first observed-empty request's text
in the same delivery; its existing native concurrent-start limitation remains.
Stop/status/goal control do not require preparation or a skill. Repeated send IDs
preserve the original selection fingerprint and cannot dispatch again.

An accepted send receipt's `nativeSkillInputs` records the routed name/path pairs.
It is native delivery acknowledgement, not proof that all skill steps finished.
Unknown origin/delivery still requires reconciliation and never authorizes blind
replay. Read actual native results and goal/reviewer state separately.

New tool/schema publication requires a separately authorized runtime cutover and
client tool-catalog refresh. Local SDK/socket fixtures prove routing and client
continuity only; actual client acceptance must be recorded separately.
