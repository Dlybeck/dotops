# Optional context delivery

The optional `developer` field supplies project context to the first
observed-empty request. The `tpm` field supplies context for the coordinating
caller to review before sending. The shipped template contains blank fields,
with no personal prompts or personas.

No configuration file is loaded by default. Both instruction bodies default to
empty strings. Copy context.example.json to an absolute private file, keep it
owned by the runtime OS user with mode 0600, and select it explicitly with the
control process's --context-file /absolute/private/context.json option.
Keep private configuration outside the publishable source tree or in ignored
.dotops/. Configuration is validated and fixed for that process lifetime.
Unknown keys, symlinks, unsafe file ownership/mode and oversized files are rejected.
Changing a live runtime's startup options is a deployment action.

Developer context is appended to the end of request text when complete history
checks observe an empty chat, separated by two newlines. Both arrive in one native
delivery before the model can respond to that delivery. The checks cannot guarantee
that another client did not send first; see the native concurrency limit below.
This is user-message context, not a forged native
developer-role message or a permission override. Existing chat history and
subsequent requests receive no extra developer context. Incomplete empty history
cannot establish a first request. A concurrent native UI start remains a native
non-atomic race.

When TPM context is nonempty, every initial codex_chat_send attempt returns
prepared, delivery:notAttempted, the configured context and a review notice.
It sends no model input and does not resume the chat. A follow-up supplies a new
requestId, the returned preparationId, and the same or revised text.
Rewriting is optional.

Preparation is bound to the chat and configuration digest, persists across process
restart, has no invented time limit, and can authorize at most one delivery attempt.
It is consumed transactionally with dispatch intent. A follow-up retry reuses its
request ID and returns its original delivery result; it does not repeat the
reminder. Unknown delivery stays unknown and cannot be replayed with a new ID.
A different request requires its own preparation. Changed configuration invalidates
old preparation receipts. Preparation itself grants no native permissions.

Instruction bodies are not persisted in the connector journal. Developer context
becomes part of the native chat transcript when sent; TPM context is returned to
the coordinating caller and is not appended to developer messages. Keep both
surfaces private according to user intent. Empty defaults send ordinary requests
directly. Stop, status, questions, answers and explicit goal control bypass
preparation. Native approval decisions never use preparation receipts.

Text and IPC byte bounds protect transport integrity; they are not message-count
or engineering-time policies. Requests whose combined context exceeds transport
bounds fail before model dispatch with a clear error.

## Native concurrency limit

The installed native turn-start contract has no atomic empty-chat condition or
exclusive first-start lock. The connector performs empty-history checks and
post-delivery/reconciliation origin checks. A detected competing first request
leaves delivery unknown with CONTEXT_FIRST_REQUEST_UNVERIFIED and grants no turn
ownership. It does not automatically replay or pretend the context was first.

This detects a violated first-request condition but cannot prevent the original
delivery from racing another native UI client. A strict guarantee requires native
atomic first-start support or platform-enforced exclusive creation/delivery.
Default empty configuration avoids that feature entirely; an enabled installation
must account for this limitation. Fixture tests reproduce the race, not its absence.
