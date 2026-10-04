# Initial release validation

Version0.1.0 is an initial Linux source release. Publication does not activate an
existing connector installation or certify every native Codex build.

The full source suite passes **387 tests**, including bounded MCP stdio/SDK
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
suite passes 387 tests. The real-native trial above predates these goal corrections;
no new real-native, phone/parent-client or production acceptance is claimed for them.

This evidence does not prove an authenticated coordinating-UI approval bridge,
atomic native start, universal detached-process shutdown, phone/parent-client
acceptance or production activation. See [the release contract](RELEASE-CONTRACT.md).
