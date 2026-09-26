# Remote access to agent sessions (September 2026)

How current agents keep sessions running apart from the terminal that started
them, and how people reach those sessions from another device. Researched on
2026-09-25 from the source and documentation of cloned projects, vendor
documentation, and local probes on Windows 11. It informs
[decision 017](../decisions.md) and
refines the direction of [decision 014](../decisions.md).
Product behavior changes quickly; recheck a claim before relying on it.

## What each system does

| System | Where sessions live | Client connection | Reaching it remotely | Disconnection |
| --- | --- | --- | --- | --- |
| Codex app-server daemon (`codex-rs/app-server-daemon/README.md`, commit `c98e263f`; experimental) | A pidfile-backed detached `codex app-server` process per machine | JSON-RPC over a Unix domain socket, also on Windows, where the path must fit AF_UNIX's 108 bytes; the TUI attaches automatically or starts an embedded server | Launched over SSH for remote clients, with optional outbound remote control | Lifecycle commands print one JSON object; managed shutdowns wait up to 60 s by default for a running turn; "per-client environment isolation is not provided" |
| opencode (`packages/web/src/content/docs/server.mdx`, commit `3016830e`) | `opencode` starts a TUI and a server; "the TUI is the client that talks to the server" | HTTP with an OpenAPI 3.1 endpoint | `opencode serve` on a chosen host, protected by HTTP basic auth | Not described |
| t3code (`docs/user/remote-access.md`, `background-service.md`, commit `9c7622da`) | A server process; a systemd user service on Linux only | HTTP and WebSocket | Three routes: network access on the LAN or tailnet, `t3 serve --tailscale-serve` over Tailscale HTTPS, or a desktop-managed SSH launch with a port forward. One-time pairing tokens become device sessions | The server keeps running after the client leaves |
| Claude Code Remote Control ([docs](https://code.claude.com/docs/en/remote-control)) | The local `claude` process | Outbound HTTPS polling through Anthropic's API; "never opens inbound ports" | Web and mobile clients through Anthropic's service | After sleep or a network drop it reconnects and "queues messages, permission prompts, and status updates… and delivers them once the connection recovers"; if the local process stops, the session goes offline |
| herdr ([configuration](https://herdr.dev/docs/configuration/)) | A persistent headless server with a TUI client that attaches | Local | Saved SSH machines with a combined agent list | Panes and agents survive the client detaching |
| Agent Client Protocol ([architecture](https://agentclientprotocol.com/overview/architecture)) | An agent subprocess the editor starts | JSON-RPC over stdin and stdout, several sessions per connection, permission requests from agent to editor | Not designed for it: it assumes a trusted local editor | The session ends with the editor's process |

## Windows facts that constrain the design

- **Tailscale SSH has no Windows server.** Its server component runs only on
  Linux and macOS ([Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh));
  a Windows PC is reached with Windows' own OpenSSH Server over the tailnet.
- **Windows OpenSSH Server** is an in-box capability installed with
  `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`, started as
  the `sshd` service, and opens a firewall rule for port 22 on every network
  ([Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)).
- **Processes started in a Windows SSH session die with it.** Win32-OpenSSH
  runs the session in a job object with kill-on-close and no breakaway, so a
  background process launched from SSH ends when the connection closes
  (PowerShell/Win32-OpenSSH issues
  [#1032](https://github.com/PowerShell/Win32-OpenSSH/issues/1032),
  [#1418](https://github.com/PowerShell/Win32-OpenSSH/issues/1418),
  [#1642](https://github.com/PowerShell/Win32-OpenSSH/issues/1642)). Codex
  likewise requires a host that permits detached processes on Windows.
- **Local IPC on Windows is a named pipe.** Node's `net` module uses
  `\\.\pipe\...` paths on Windows, removed when the owning process exits
  ([Node.js net](https://nodejs.org/api/net.html)). A probe on 2026-09-25
  exchanged a JSON-RPC message over a named pipe under both Bun 1.4.2 and
  Node 24.15.0.

## Patterns

1. **The terminal becomes a client of a long-lived process.** Codex, opencode,
   t3code and herdr all separate the session host from the interface.
2. **Nothing listens on a public port.** Codex and Claude Code use local
   sockets or outbound connections; t3code recommends a tailnet and pairing.
3. **Pending questions outlive the connection.** Claude Code queues
   permission prompts until a client is back.
4. **On Windows, a service must start outside SSH.** Otherwise it dies with
   the connection.
