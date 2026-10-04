# Security and limitations

DotOps is a local same-OS-user coordination bridge. It trusts the selected native
Codex daemon and uses private Unix IPC permissions and an exclusive journal
writer lock. It is not a multi-user service, remote authentication layer, sandbox
or permission approval mechanism. Do not expose its IPC socket or native control
socket over a public network.

The journal records exact request/turn/item/process evidence, not prompt bodies or
command output. Status and native transcripts can contain private source, text,
paths and results. Keep journals, transcripts, context files and trial artifacts
private. Empty context defaults require no persona or skill package. Native
authentication and permissions remain native.

Native approval and secret-input requests cannot be approved through ordinary
model tools. The optional owner-binding prototype and UI probe are fixtures only;
they do not authenticate a real owner or dispatch native approvals.

Native check-and-start is not atomic. Use one coordinating writer per chat and
inspect unexpected concurrent activity. Exact observed owned processes remain
blocking until attributable closure. Null handles, identity conflicts, unresolved
delivery and ambiguous delegation remain named unknowns. No ancestry, cwd or
latest-child-turn inference grants child-stop authority. A retained native command
exit proves its leader exit, not the absence of detached descendants.

Experimental native APIs can omit history items or reject item-history repair.
Retained positive command exit evidence survives transcript omission; missing
live or ambiguous delegation evidence stays blocking. Platform changes require
bounded compatibility acceptance before replacing an existing live source.

For a vulnerability, contact the repository owner privately through an available
private channel. Do not post credentials, private native transcripts or exploit
details in a public issue. No public security inbox or supported-version policy
has been established for this preparation candidate.
