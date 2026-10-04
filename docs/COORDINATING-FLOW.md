# Coordinating flow

1. Discover or explicitly create/enroll a local root chat in the selected directory.
   Enrollment records no old turn ownership; creation starts no model turn.
2. Read status to obtain the latest native turn ID, execution selection, native goal
   preview/fingerprint and any delivery uncertainty. Unloaded chats report
   resumeThenPreflightRequired; an authorized send resumes and verifies them.
3. Send a request with a stable requestId. Expanded control supplies the status
   expectedLastTurnId (null for an empty chat) and acknowledges the documented native
   concurrent-start race. These are target/correlation checks, not work approval.
4. With configured TPM context, the initial call is preparation only. Review the
   returned context, then send with a new requestId and preparationId. Same text is
   valid. For unknown delivery, inspect status and reuse the original send ID.
5. Retrieve latest progress/final text through status or newest-first chat history.
   Follow explicit continuation cursors. Read ordinary questions, obtain any detail
   pages, and answer every ID belonging to the selected questionRef.
6. For an explicitly requested goal change, use codex_chat_goal with the
   status-derived expectedGoalHash and set/pause/resume/clear action. Native usage
   counters do not invalidate the selected goal's semantic fingerprint. A clear
   preserves the prior goal in the private journal. Native compare/set is not atomic.
7. Stop an exact recorded turn with codex_chat_stop. No message preparation or work
   window is required. Pause an active goal explicitly when continued native work
   must stop; verify turn/process/descendant/queue and goal-continuation state
   separately. Never claim universal OS process termination.

The coordinating conversation can carry all ordinary requests/questions/results.
Native permission/denied-action approval still requires the actual sanctioned
owner UI integration described in APPROVAL-INTEGRATION.md. Direct developer chat
is optional for ordinary coordination but remains an available native control
surface while the parent owner approval contract is unresolved.

Local socket/SDK integration tests validate routing against a native fixture.
They do not establish real model completion, live deployment or owner consent.

## Owned operations after reconnect

Expanded user-directory mode tracks exact accepted connector operations rather
than every historical descendant. Native terminal model status retires that
model obligation only. Known live command item/process pairs still block;
missing handles, conflicting identities and incomplete evidence retain named
unknown obligations. Later manual turns are unowned. They can make the target
busy and block a new start without invalidating proof that earlier owned work
stopped.

A closed attributable delegation does not require reopening an unloaded
historical child. Native interacted activity cannot distinguish non-waking
messages from waking followups: it stays ambiguous until attributable completion
resolves it. No such observation grants child-stop authority or ownership of a
child's newest turn. Missing receiver-turn causal receipts and overlapping inputs
remain conservative.

`codex_chat_reconcile` rejoins the enrolled root without settings overrides and
checks scoped obligations without starting a model turn, changing goals or
adopting old work. Exact open owned-turn evidence can be repaired through native
item history. Status does not resume sessions. Reconnect preserves the journal;
subsequent reconciliation/send requires fresh process and continuation evidence.
A prior receipt is a snapshot, never current admission authority. Each new send
checks fresh scope twice, together with target/executor/expected-turn/queue and
unresolved-delivery guards. Native start remains non-atomic.

Legacy Stage1 mode retains conservative native descendant-tree and attachment
checks. Its unloaded-child restrictions do not describe expanded mode's retired
owned operations. Neither mode guarantees every detached OS process has stopped.

After a tool-catalog update, rediscover connector tools. Current `windowId` is
optional and unused for gating; no task-window-opening tool exists. Refreshing a
cached schema does not itself reconcile native work. Public context defaults
remain empty; a private persona setup is a separately authorized developer task.
