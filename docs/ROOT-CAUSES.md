# Delivery and recovery

The connector retains durable request fingerprints, native message correlation,
unique first-message origin, conservative process identity observations and bounded exact-operation
verification in expanded mode; legacy Stage1 retains descendant/fork verification. An acknowledged send is not proof of
successful execution. Missing history or acknowledgement is not proof of failure.
Status exposes latest assistant progress/final text with truncation and continuation.

New sends preserve canonical cwd and local native execution selection. Steering
requires the exact recorded turn; stopping never acquires ownership of unrelated
native UI work or processes. Tracked terminal termination requires agreement with
all retained item/process observations. Fork copies and parent interactions are
not mistaken for locally executed descendants. Incomplete or changing evidence
remains visible and cannot grant ownership.

Historical task windows/counters remain in private journals for compatibility and
audit, but are not enforced. There is no window-opening tool or automatic deadline
interrupt. A scoped deadline chosen for an engineering session belongs to that
session, not the connector product. Old source versions still enforce their own
behavior until an authorized cutover.

Unloaded roots are resumed without settings overrides during an authorized send,
before terminal inventory is required. Read-only status never resumes them and
reports unavailable inventory honestly. Explicit enrollment does not adopt old
turns. A native goal is reported rather than treated as a connector policy gate.
Use explicit native goal actions to pause/resume/set/clear it. The journal retains
metadata and private keyed fingerprints; objective previews remain transient.
Native comparison and mutation are not atomic.

A former 100-command tracking cap caused a global volatile persistence latch.
Command identities are now retained without that cap. Failed event transactions
retain per-chat replayable observations; a later status/preflight retries them
transactionally and clears only successfully persisted observations. Contradictory
identities remain contradictory. A writer-lock loss still ends control, and
persistent disk/full-journal errors require storage repair. The journal has a
bounded byte size; this is a storage limitation, not a workflow message limit.

Stop acknowledgement is separate from owned model/process/delegation verification.
Expanded mode separates earlier owned-stop proof from target admission: later manual
work and unrelated queues can block a new start without reopening retired ownership.
Owned continuation closure is observed explicitly; goal actions preserve prior state.
Legacy Stage1 retains conservative descendant goal and queue checks.
No connector can prove absence of detached, unrecorded OS descendants from native
tracked-process inventory alone.

The original release effort, historical chats, source candidates and recovery
receipts remain separate from a local candidate. Tests, reviewed source, deployed
source and actual parent acceptance are distinct delivery states.

## Recent review repairs

A steering acknowledgement naming another turn now remains unknown and grants no
ownership. Failed controller startup releases its journal lock. IPC decodes UTF-8
incrementally with byte bounds, preserving multi-byte characters across stream
chunks and rejecting invalid encoding.

Status returns newest operation receipts first with signed snapshot continuations.
Ordinary questions have bounded lists and detail continuations; a large question
cannot prevent all oversight with an oversized IPC reply. Follow detailsCursor
using codex_chat_questions, concatenate the returned text slices and parse the
sanitized questions JSON. Changed/resolved questions invalidate stale continuations.

Questions arriving before the native start acknowledgement are retained on their
connection and exposed only after positive send ownership proof. Request identity
includes connection, thread and native request ID. Disconnect/completion/resolution
clears stale requests. Neither early buffering nor ordinary answers grant native
permissions. Known pre-dispatch failures release TPM preparation; unknown delivery
retains consumption and never replays automatically.

Native acknowledgement can precede persisted first-message origin evidence. A
completion notification now triggers a serialized fresh history check for an
unresolved send. The notification alone never establishes ownership. An event
arriving during that check retains a pending signal for a successor check; absent
another event there is no retry loop. Stale-connection events are ignored. Missing,
ambiguous or unavailable history keeps delivery unknown and recoverable through
fresh status without resending. Shutdown waits for an in-flight check and preserves
the resulting journal state.

## Legacy Stage1 unloaded delegated-agent lifecycle

This section describes the conservative Stage1 tree path. Expanded mode uses the
[owned-operation flow](COORDINATING-FLOW.md#owned-operations-after-reconnect):
closed historical descendants need no reattachment; unresolved exact-owned process
or delegation evidence remains blocking. No child control authority is inferred.

Completed delegated-agent sessions naturally unload when their observation subscribers
leave. Native background terminal inventory then rejects the read rather than
returning an empty list. The former admission path resumed only the root, so a
later new send remained blocked despite completed delegated-agent history.

Explicit reconciliation and ordinary new sends now reattach only eligible
completed native descendants before taking fresh process/history/goal/queue and
lineage proof. Read-only status and stop verification retain unknown state.
Subscriptions add no model turn, settings override, goal/process action, permission
approval or descendant work ownership. The watchdog owns the observation lifecycle;
a new connection rechecks it. Natural unload/reconnect and the actual native
delegation tree are separate acceptance checks from synthetic fixture tests.

DB-only native descendant listings can omit fork provenance that detailed thread
reads retain. Reattachment checks the listed ID, parent and cwd, and requires any
positive listed fork value to agree. The detailed fork identity is then pinned
across fresh reads, resume and post-resume verification. Missing list metadata
does not grant a fork exemption: complete inherited-history/session proof remains
required. Conflicting or changing detailed lineage still blocks delivery.

Some unloaded native multi-agent v2 descendants reject `thread/resume` even after
their parent has been reattached. Background terminal inventory is available only
for loaded threads. Completed history and empty goals/queues do not substitute
for that process evidence. The connector now classifies this exact native refusal
as `NATIVE_SUBAGENT_RESUME_UNAVAILABLE`; explicit reconciliation identifies the
blocked descendant and returns an unverified capability-blocked receipt. Other
native failures stay unclassified. No model work, goal action, process action or
history-only verification fallback is attempted. A native recovery/capability
change is needed before retrying the same blocked tree; this diagnostic does not
resolve the native attachment restriction.
