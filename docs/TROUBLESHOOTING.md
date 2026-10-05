# Troubleshooting

Treat unknown delivery as uncertainty, not failure. Keep the original request ID,
inspect fresh status and reconcile without creating a duplicate native delivery.
Never erase a journal or clear a native goal just to make admission pass.

| Symptom or code | Meaning and next step |
| --- | --- |
| `WATCHDOG_UNAVAILABLE` | The bridge cannot reach its default private control socket. Confirm the intended watchdog is running and client/socket paths match. |
| `WATCHDOG_ALREADY_RUNNING` | Another writer owns that journal. Preserve it and inspect the intended installation; do not remove the lock or start a second writer. |
| `UNSAFE_STATE_DIRECTORY` / `UNSAFE_CONTROL_SOCKET` | Owner, mode, canonical directory or socket checks failed. Verify your intended private directory is owned by the runtime user with mode0700 and socket0600; do not broaden permissions. |
| `DAEMON_UNAVAILABLE` | Native transport is unavailable. Check the native client and configured socket; DotOps does not start or reconfigure it. |
| `NATIVE_HISTORY_FRAME_UNVERIFIED` | The native channel still exceeds its bounded transport after history paging reaches one record. A rejected frame exposes no response identity and may be a response or unsolicited event, so its source and individual record size remain unverified. History is unsupported through this channel; no complete-history or closure proof is granted. Preserve the request and journal; do not blindly resend. |
| `HISTORY_READ_BUDGET_EXHAUSTED` | Paged history could not finish within the shared five-second control-request budget. No complete-history proof is granted. Inspect the native history latency and retain the original request; do not blindly resend. |
| Unknown with `TURN_ORIGIN_UNVERIFIED` | Acknowledgement may precede attributable user-message history. Read status after new evidence arrives, then reuse the original request ID. Never blindly send a new ID. |
| `CHAT_ACTIVE` / targetBusy | Current native work blocks a new start. Earlier owned-stop proof can still hold when the current work is manual and unowned. Use native controls for work DotOps does not own. |
| `CHAT_CHANGED` | The expected last native turn is stale. Inspect the new activity and obtain a fresh status before deciding whether to send. |
| `TURN_NOT_OWNED` | Stop/steer cannot acquire another client's turn. Use an exact accepted connector turn or the actual native owner UI. |
| `SEND_UNRESOLVED` / `PREVIOUS_WORK_UNVERIFIED` | Inspect `currentReadiness`, its separate `delegationReadiness`, and unknown outcomes. Completed reviewer lifecycles plus fresh receiver inactivity may permit readiness while exact interaction outcomes stay unknown. Current activity or missing readiness evidence blocks. An established pre-boot local lifetime can end while its results remain unknown. Missing boot identity stays conservative. Reconcile an idle enrolled root when appropriate; never replay an uncertain old request. |
| `NATIVE_SUBAGENT_RESUME_UNAVAILABLE` | Legacy Stage1 native descendant attachment is unsupported. Preserve the blocked state; repeated identical attachment cannot supply process evidence. Expanded ownership retires closed operations without historical-child loading, but unresolved evidence still blocks. |
| Native approval or secret prompt | Answer through the supported native owner UI. `codex_chat_answer` handles ordinary questions only; it never grants permissions or supplies secrets. |
| Prepared instead of sent | Private TPM context is configured. Review the preparation and supply its `preparationId` with a new send ID; preparation itself starts no model. |
| Changed catalog/history cursor | Fetch a fresh first page. Signed continuations describe a bounded snapshot, not later changed content. |

A native full legacy transcript can omit command event items; retained exact
positive exit evidence remains available. Missing live items or unavailable repair
remain conservative. Terminal model history is not command/delegation closure,
and a tracked command's leader exit does not cover all detached processes.

History reads retain the 2 MiB native response limit. A rejected oversized frame
during an isolated history read prompts retries at the same cursor with smaller limits; only those
read-only methods are retried, never sends or ordinary disconnects. The reduced
limit is retained for later reads on that client. Native reconnects still change
the observation epoch and invalidate any proof bound to the previous connection.
The existing 60-turn and 400-item evidence budgets are retained across smaller
pages. Only an explicit end cursor establishes complete history; malformed,
repeated or exhausted pagination remains incomplete or rejected. Those budgets
do not guarantee that all native history or every record can be read.
All history traversals, item repairs and their verification reads in one control
request share a five-second deadline, including page-size retries and reconnects. A read exceeding this time
budget fails explicitly before the IPC reply window; partial reads cannot settle
verification. Native events receive a fresh budget rather than a stale caller's
deadline. Mutation requests retain their existing timeout behavior.
Each caller's wait for shared connection setup is bounded independently; expiration
does not cancel another caller's setup or dispatch more history for the expired
caller. Rejected frames expose no response identity and may be unsolicited events.
Multiple outstanding RPCs retain transport uncertainty. An isolated history read
that still encounters oversized frames at limit one reports explicit unsupported
history without identifying an offending record or granting complete evidence.

For a new bug, report version/commit, mode, redacted error code and a minimal
synthetic reproduction through https://github.com/Dlybeck/dotops/issues. Omit
private paths, credentials, journals and real native transcripts. Security issues
should follow [SECURITY.md](../SECURITY.md) rather than a public report.
