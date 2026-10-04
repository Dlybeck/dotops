# Installation and configuration

## Prerequisites and clean verification

Use Linux with Node 22, `/usr/bin/flock` and accessible `/proc/self/fd`.
`.node-version` pins 22.23.3;
`package.json` requires Node >=22 and <23. Set up that version with your usual
Node version manager, then clone https://github.com/Dlybeck/dotops and run:

```sh
node --version
test -x /usr/bin/flock
npm ci --ignore-scripts
npm test
```

Pinned dependencies use the public npm registry. Scripts are disabled by default
in `.npmrc`. Fixture tests create and remove their own temporary resources and
need no credentials, running daemon, private context or model use.

## Native server prerequisite

Live control requires a running, authenticated local native Codex App Server
whose experimental protocol supports this connector. The initial bounded native
trial used threads reporting build 0.159.2. Version numbers alone do not prove
compatibility; future builds may change or omit required evidence. Configure and
authenticate Codex through its supported native client, outside DotOps. DotOps
neither creates credentials nor changes sandbox, account or approval settings.

The connector speaks WebSocket over a private Unix socket, defaulting to
`$HOME/.codex/app-server-control/app-server-control.sock`. A stdio-only native
server is insufficient. This repository does not include a verified universal
command to create/authenticate that socket service on a clean machine. Provision
it through your native installation's supported setup before attempting live
control; if that transport or the required experimental APIs are unavailable,
fixture verification still works but live setup is blocked. The watchdog's ready
message confirms its local IPC listener, not native connectivity or compatibility.

## Default local installation

From the source checkout, start the control process in a dedicated terminal:

```sh
node src/stage1/watchdog.mjs --access-mode user-directories
```

Expected stdout: `Stage 1 watchdog ready.` The process remains running.
Its default state directory is `$HOME/Projects/codex-dot-connector/var/stage1`,
with private mode0700 and socket mode0600. Legacy directory names preserve
compatibility. Missing parent directories are initialized with mode0700, starting
under an existing safe directory owned by the runtime user. Existing ancestors
must be canonical directories owned by that user or root, without group/other
write access; root-owned sticky system directories may be traversed. Symlinks,
file collisions and unsafe permissions are rejected, never repaired with chmod.
The leaf journal still requires user ownership and mode0700. Initialization uses
Linux descriptor-relative traversal through `/proc/self/fd`.
Only one writer may own a journal. If another installation uses
that location, review its configuration and separately plan a replacement; do
not delete its lock/state or change live services as an installation shortcut.

The default native socket must already exist at
`$HOME/.codex/app-server-control/app-server-control.sock`. The control process
connects to it without restarting the daemon.

## MCP client configuration

Clients differ in configuration format. For a client accepting `mcpServers` JSON,
use this template; replace the placeholder with the absolute source path:

```json
{
  "mcpServers": {
    "dotops": {
      "command": "node",
      "args": ["/absolute/path/to/dotops/src/expanded/server.mjs"]
    }
  }
}
```

For a Codex client using `config.toml`, the equivalent server entry follows the
[official OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli):

```toml
[mcp_servers.dotops]
command = "node"
args = ["/absolute/path/to/dotops/src/expanded/server.mjs"]
```

Use a Node22 executable available to the client, or replace `node` with its
absolute executable path. The client launches the stdio bridge; run the watchdog
separately. Refresh the client's tool catalog after changing server configuration.
The connector does not configure remote access or hosted execution.

`connectivity_probe` with a fresh 32-character hex `nonce` validates the MCP
transport and returns the nonce with fixed identity. It starts no native work.
Then use `codex_chat_create`, `codex_chat_status` and `codex_chat_send` as described
in [the README](../README.md#first-request). Native permission requests stay in
the native owner UI.

For discovery/history only, replace the argument with
`/absolute/path/to/dotops/src/server.mjs`; no watchdog is needed. For restricted
legacy control, use `src/stage1/server.mjs` and a Stage1 watchdog with an absolute
`--projects-root`. Do not pair an expanded client with a differently scoped
watchdog and assume broader access.

## Explicit runtime options

The watchdog accepts absolute paths for `--state-dir`, `--native-socket`,
`--projects-root` (Stage1 only), and `--context-file`, plus
`--access-mode stage1` or `--access-mode user-directories`. Do not combine expanded
mode with `--projects-root`. It loads no context file by default. Private optional
context must be user-owned mode0600 and is fixed for that process lifetime.
See [context delivery](CONTEXT-DELIVERY.md).

The stdio control entrypoints currently use the default IPC socket. A custom
state directory needs a matching adapter rather than an undocumented environment
variable. For an isolated integration, create the server with
`createExpandedServer(new WatchdogClient('/absolute/private/state/control.sock'))`
using the exports in `src/expanded/server.mjs` and `src/stage1/ipc.mjs`, and attach
it to your MCP transport. `--native-socket` configures the watchdog only; discovery
uses its own default native socket unless its backend is supplied programmatically.

Keep trial journals and context outside the source checkout. Never point a test
controller at an existing production journal. Reconnecting to a preserved journal
requires fresh evidence; prior status or acknowledgement is not start authority.

## Remote and background operation

The included MCP entrypoints use local stdio. A remote coordinating client needs
a separately configured, authenticated transport supported by that client, or an
existing secure tunnel to the runtime host. DotOps does not install a tunnel,
HTTP endpoint, authentication service or public socket listener. Do not expose
native or control sockets directly over a public network.

The watchdog command above runs in a dedicated terminal until stopped. It does
not install a systemd unit, arrange boot startup or replace an existing service.
Service supervision, remote transport and any replacement of an active source
are separate deployment/configuration decisions. Preserve the single-writer
journal and review those steps for your installation before changing live state.
