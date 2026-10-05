# Local candidate contract

This connector supports local development coordination under native platform
controls. It does not provide durable unloaded-child process closure proof or
an atomic native check-and-start operation. A tested local checkout is not a
deployed or client-accepted release.

## Three separate outcomes

- Deliverable completion: the developer's result and its supporting evidence
  satisfy the agreed requirements. The coordinator decides acceptance.
- Verified tracked-scope quiescence: current native observations establish that
  the recorded work's tracked process and delegated-operation obligations have closed, with
  goals and queues checked. Completed history alone is insufficient. This is
  not proof that every possible detached OS process has stopped.
- Admission eligibility: a new request passes fresh ownership, execution,
  lineage, process, goal, queue and unresolved-delivery checks. A status snapshot
  or previous successful reconciliation never authorizes a later start.

## Missing native guarantees

`admission.runtimeProof` identifies the current child observation and explicitly
reports that durable unloaded-child closure is unavailable. `authorizesStart`
is always false: the send path must perform its own checks. Unavailable or
incomplete inventory for unresolved known process handles remains unverified;
explicit native command exit is limited positive leader-exit evidence and remains
retained when a later full legacy transcript omits that exited command. Omitted
live commands and conflicting identities still block; no transcript omission
is treated as process exit. Legacy
Stage1 refusal to attach a required unloaded descendant blocks admission;
retrying identical unsupported attachment is not a recovery strategy.

`admission.startGuarantee` is `nonAtomicPreflight`. New expanded starts require
the expected last turn and explicit concurrent-start risk acknowledgment. These
inputs do not bypass any other check. Connector serialization cannot prevent a
different native client from changing work between observation and dispatch.
Use one coordinating writer per chat; concurrent other-client sends remain a
limitation. Post-dispatch origin checks can detect some races but cannot undo a
native action or make the start atomic.

An upstream scope execution inventory or durable closure receipt, with native
revision-guarded start, is needed to supply those stronger guarantees. A cached
connector receipt cannot substitute for them. Preserve blocked chats and their
history; never relabel unknown processes as stopped to regain admission.

## Verification and activation

Regression checks must cover unavailable descendant inventories, native refusal,
changed lineage/evidence, reconnect, unresolved dispatch and concurrent starts.
Fixtures establish connector behavior, not actual native cleanup or owner consent.
Private context remains optional; public defaults remain empty. Native permissions
and approval controls remain native.

Activation requires separate approval, a pinned source identity and rollback
selection, preserved private configuration/journal, service health checks and
bounded real-client acceptance. Publication and main integration require their
own authorization. Current capabilities do not guarantee disconnected-parent
wakeup or authenticated owner approval through a transport form.

## Expanded operation ownership

Expanded mode (`user-directories`) verifies exact accepted connector operations,
rather than retaining ownership of every historical descendant. The durable
ledger separates model, command process, delegation and continuation evidence.
Terminal model status closes that model only. Known live native item/process
pairs still block; unavailable inventory, null live handles, conflicting
identities and incomplete exact-turn evidence retain named unknown obligations.
Those historical results remain distinct from current readiness after an
established local boot boundary or completed native reviewer lifecycle, as described below.
Legacy Stage1 tree and attachment safeguards remain conservative.

Exact legacy turn receipts and command observations migrate without deleting
unknowns or selecting a child's latest turn. Open item evidence can be repaired
with read-only ascending `thread/items/list` for that exact owned turn. Closed
model/delegation history does not require loading historical descendants.
Native `interacted` activity is ambiguous between waking followup and non-waking
communication. It remains an unknown delegation until unambiguous ordered native
completion within its owned turn; overlapping inputs remain unknown. No such
activity grants child-stop authority. Last-known agent status, ancestry, cwd and
latest child turn never grant ownership. There is currently no native exact
receiver-turn dispatch receipt, so unresolved child work stays conservative.

An unknown `interacted` outcome can coexist with current readiness when complete,
conflict-free terminal owned-turn history contains a matching receiver lifecycle
completion after that interaction, and the exact receiver passes fresh current
descendant activity checks. `currentReadiness.delegationReadiness` reports this
snapshot separately. Several interactions can precede one lifecycle completion;
this does not claim that each interaction succeeded or create an operation closure.
The delegation remains unknown, own-stop remains unverified, and child-control
authority is unchanged. A later interaction requires a later completion.
Unresolved started/typed waking operations, missing receivers, incomplete history,
active work and unavailable required current-state evidence still block.

Current receiver checks require complete descendant pagination, matching native
metadata, known non-active goal and empty queue. An idle receiver also requires
complete empty native process inventory. A `notLoaded` receiver uses the existing
inactive native-session rule without resume or inventory reconstruction; this is
not a process-exit receipt or universal detached-process proof. Every send reruns
these checks; no lifecycle readiness is retained as a durable closure.

Status exposes `ownedModel`, `ownedProcesses`, `ownedDelegations`,
`ownedContinuations`, `unknownOwnedObligations` and `targetBusy`. Own-stop proof
is separate from target admission: a later manual root turn or unrelated queue
can block a new send without invalidating proof that earlier owned work stopped.
Native goal operations retain durable private keyed fingerprints; unresolved or
open owned continuations block proof. Acknowledgment without observed closure
does not retire earlier obligations. Confirmed closure receipts do not acquire
later manual reactivation. Unresolved sends remain named ownership uncertainty. External goals are not adopted by a send.

Native pause/completion observations retire only the matching owned goal operation;
confirmed absence retires recorded goals with durable identity. Closure is retained
across reconnect, while a later connector resume creates a new owned operation.
Legacy stop summaries lack observed goal identity, so even a named closed item
cannot grant durable closure. Missing or malformed fingerprints remain unknown.
Goal journal migration removes objective bodies/previews and privately keys legacy
request digests while preserving exact request replay. It does not purge backups.

Expanded stop verification and historical status retain scoped proof. Preflight,
reconciliation and both send rechecks use its separate current-readiness result. Each send rechecks fresh process and continuation
state, the durable scope revision, connection epoch, target status, executor,
expected last turn, queue and unresolved dispatch safeguards. Reconnect retains
the ledger and requires fresh evidence for unresolved obligations. Native atomic
start and universal detached-process closure remain unavailable. These local
regressions justify the replacement scope; they do not establish live activation
or platform cleanup behavior.

## Current readiness and the local boot boundary

Expanded admission uses `currentReadiness`, separately from historical
`unknownOwnedObligations` and `verifiedStopped`. A dispatch binding records the
connector's host boot ID. For the configured single-host local native route, a
valid different boot ID on the same host establishes that local execution
lifetime ended. Its model/command/delegation results remain as originally known
or unknown; no exit code or successful result is fabricated. External side
effects are not covered by a host reboot. Same-boot reconnect or app-server
restart does not end the lifetime. Missing/invalid boot IDs and foreign host
bindings cannot establish this boundary.

Admission still requires fresh root inventory, current owned obligations,
current child activity/inventory where loaded, active goals, queue state and
current unresolved dispatch protection. Inactive historical children are checked
for present metadata and continuations, without resuming them or reconstructing
old turn history. Active goals block because they can resume work; an external
blocked/paused goal is reported without adoption or mutation. Rechecks follow
root resume and precede dispatch. Exact stop authority and non-atomic native
start limitations are unchanged.

An old uncertain request is never replayed. Reusing its request ID returns its
existing receipt. A genuinely new request may proceed after an established
pre-boot local lifetime and fresh current readiness; this does not claim the old
request succeeded or failed.

Legacy dispatches have no boot ID. No runtime migration guesses one. Incident
activation must separately establish their actual prior local boot from verified
reboot/deployment evidence and record that lifecycle field on the relevant
existing dispatch bindings, preserving all other journal data. This is a bounded
operator reconciliation, not a tool-provided force-clear. An unstamped legacy
binding remains conservative. No live annotation or activation is performed by
this source candidate.

Linux reads the boot ID from `/proc/sys/kernel/random/boot_id`. If unavailable,
boot identity is null and the lifetime rule cannot apply. The field describes
the configured local lifecycle, not universal execution-host attestation.
