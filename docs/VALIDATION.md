# Initial release validation

Version0.1.0 is an initial Linux source release. Publication does not activate an
existing connector installation or certify every native Codex build.

The full source suite passes **398 tests**, including bounded MCP stdio/SDK
routing, private IPC, request identity/recovery, context/skill routing, history,
scoped ownership, stop verification and conservative counterexamples. Tests use
isolated fixture daemons and temporary journals. Clean `npm ci --ignore-scripts`
installation and fixture tests are part of release verification and CI.

A separately authorized bounded real-native trial used two fresh roots, a
separate private journal/socket, a temporary directory, self-expiring sleep
commands and exact recorded turn/process controls. Its threads reported native
build0.159.2; the local CLI was0.159.3. Eight cumulative root starts, two steering
operations and one bounded child spawn exercised these core scenarios:

| Scenario | Evidence |
| --- | --- |
| Start, steer, completion and request replay | Native passed; replay kept the same turn without duplicate dispatch. |
| Owned command stop and reconnect | Native passed; fresh status verified earlier owned work stopped after reopening the test journal. |
| Attributable delegation completion, reconnect and subsequent start | Native passed; closed delegation granted no child-stop authority. |
| Later unowned manual-equivalent turn | Native passed; target busy blocked new work while earlier owned-stop stayed verified. |
| Actual child unload after completion | **Not observed live.** The child reported idle even after the parent became notLoaded. Unloaded-child admission remains fixture-backed. |

Native acknowledgement preceded origin persistence; status resolved it without
resending. Native full legacy history omitted a completed command item and the
item-history repair RPC was unsupported. A regression fix retains nonconflicting
positive command leader-exit evidence; live pairs, missing exit evidence, identity
conflicts and unresolved delegation remain blocking.

Independent Standards and Spec reviews accepted the source candidate. Dependency
notices match locked packages; the preparation audit reported zero advisories.
Known private native identities and original fixture payload fingerprints were
excluded, with synthetic replacements preserving required topology/equality.
Raw trial metadata, prompts, journals and private contexts are not distributed.

Post-review goal corrections have eleven new isolated regressions: all eleven fail on
the reviewed restoration baseline and pass on the corrected candidate. They cover
journal/replay privacy, legacy objective/digest migration, uncertain native clear,
durable exact goal-operation closure, later owned resumptions, changed/missing/malformed
identity, live owned processes and unbound legacy stop evidence. The full corrected
suite passes 398 tests. The real-native trial above predates these goal corrections;
no new real-native, phone/parent-client or production acceptance is claimed for them.

Fresh journal initialization has eleven isolated regression cases, including an
actual watchdog CLI's first/repeat startup with missing parents and no native
daemon. Missing directories receive mode0700; existing safe permissions and state
remain unchanged. Writable ancestors, symlinks, file collisions and a nonprivate
leaf fail closed. Concurrent first startup retains one writer. The fresh-path
case fails with ENOENT on the reviewed baseline. No production directories,
permissions, services or journals were modified by these checks.

This evidence does not prove an authenticated coordinating-UI approval bridge,
atomic native start, universal detached-process shutdown, phone/parent-client
acceptance or production activation. See [the release contract](RELEASE-CONTRACT.md).

## macOS journal backend development checkpoint

The first portability slice adds a helper-backed Store with the existing
`open/update/close` behavior and version-1 JSON state. Linux keeps its current
implementation. The controller, ownership evaluator, goal model, tool schemas,
private context and blank shipped context template are unchanged.

`npm run test:macos-store` exercises private first/repeat initialization, unsafe
paths/files/ACLs, hard links, identity replacement, writer contention, helper and
parent death, bounded request/response framing, and controller goal privacy and
closure across helper-backed commits/recovery. Linux-only syscall faults cover
file sync, rename, directory sync and a crash before rename. A directory-sync
failure may leave the new state committed without an acknowledgement; a crash
may leave a private temporary file. Neither condition grants success or triggers
automatic replay/cleanup. The helper receives state bytes over a private pipe
and writes no payload diagnostics; model-layer privacy rules remain responsible
for excluding prompt bodies from state.

Linux POSIX fixture execution and cross-compilation against Darwin headers are
separate from actual macOS execution. The next platform gate is an authorized
Apple SDK/compiler build and real macOS filesystem tests, including extended ACLs,
private file ownership, canonical temporary paths, path replacement and locking.
Linux-only ACL and syscall-interposition tests are explicitly platform-specific.

Executable trust is checked before helper launch, including ACLs on all ancestors
and identity/metadata changes during the probe. A fixed system `osascript` bridge
calls the Darwin ACL API; it does not trust the helper to validate itself. Linux
fixtures exercise this script against a simulated C API and fixed-output process
boundary, including unreadable ACLs, malformed tags, grants and iteration errors.
They do not establish JXA pointer interoperability on a Mac. The shared native
fixture canonicalizes its temporary root before socket binding; an aliased-root
regression models macOS's `/tmp` versus `/private/tmp` distinction. Controller
privacy/goal-closure integration is explicitly Linux-only until the other host
seams are implemented.

On a separately authorized Mac, the next gate is:

1. Use an existing Node 22 installation, locked dependencies and Apple command-line
   C compiler in a canonical protected checkout; build the helper from source.
2. Run `npm run test:macos-store` as an ordinary user. Confirm both first/repeat
   initialization and contention/crash recovery on real APFS temporary paths.
3. Verify executable and ancestor grant ACLs are rejected before helper execution,
   deny-only ACLs work, and unreadable ACLs fail closed. Confirm the fixed system
   API bridge needs no application-automation grant on that macOS version.
4. Record the OS/architecture/compiler, exact source commit, tests and any skipped
   Linux-only cases. Stop on failures; do not strip existing ACLs to force a pass.

These checks need no Codex login, live journal or service. Authenticated native
acceptance belongs to the later complete foreground-host milestone.

This checkpoint does not validate the complete macOS watchdog. Private context
and control-socket ACL integration remain later slices, followed by separately
approved authenticated start/steer/stop/reconnect acceptance using fresh test chats.
No macOS foreground support, CI pass or personal-host setup is claimed yet.
