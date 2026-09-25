# 017: Host sessions in a local service that terminals attach to

Status: adopted 2026-09-25 as a design; building it waits for roadmap
section 1 (daily use of the local flow). Details the remote-access direction of
[decision 014](014-execution-and-autonomy.md) section 6. Evidence is in the
[remote access landscape](../references/agent-remote-landscape.md).

## Context

The operator works away from the Windows PC and runs several sessions at
once. Today a session lives inside the terminal process that opened it:
closing the terminal, or losing the remote desktop connection, ends the
work's host, and only one terminal can open a repository's sessions. The
operator reaches the PC through Chrome Remote Desktop.

Current agents separate the session host from its interface: Codex's
app-server daemon, opencode's server, t3code's server and herdr's headless
server all outlive the client. None exposes a public port; Claude Code queues
permission prompts until a client reconnects. On Windows, two facts decide
the mechanics: Tailscale SSH has no Windows server, so the PC is reached with
Windows' own OpenSSH Server over the tailnet; and a process started inside a
Windows SSH session is killed when the session closes.

## Decision

### 1. One session service per operator account

A long-lived Tesota service owns every session of the operator's account: the
session records, workspaces, execution environments, agent and reviewer
sessions, verification and review, and the assurance journal. It holds each
repository's session lock, so any number of clients can attach. A terminal
running `tesota` is a client. The service runs as the operator, with the
operator's credentials, and never elevated.

### 2. Clients speak JSON-RPC over local IPC only

The service listens on a named pipe on Windows and a Unix domain socket
elsewhere, and on no network port. A client must first present a secret the
service writes to a file only the operator's account can read: a Unix socket
file can carry that permission itself, but a Windows named pipe's default
access also lets other accounts read, and Node cannot set its access list.
Messages are JSON-RPC 2.0, as in Codex's app-server and the Agent Client
Protocol. The protocol is Tesota's own, because ACP assumes an editor that
starts the agent and holds its only session, and Tesota's sessions outlive
every client. An ACP adapter for editors may come later on top of it.

The protocol mirrors the operator's actions: list, open and close sessions;
send a request; answer a question; stop the current work; read a session's
transcript, reviews and state. The service sends notifications for agent
activity, progress, new transcript entries, reviews and questions.

### 3. Questions are session state

A question to the operator, such as a command approval, a network decision,
the check choice, or apply and reject, is stored with its session until
answered. Any attached client shows it and may answer it; the first answer
wins and the others see it resolved. A session whose question has no client
simply waits, as its work would with the operator away from a terminal.
Clients rebuild their view from the service's state on attach, so nothing
depends on a client having been connected when an event happened.

### 4. The service starts outside any terminal or SSH session

On Windows the service runs from a per-user Scheduled Task, started at
logon and on demand, so the Task Scheduler launches it outside any SSH job
and it survives disconnection. `tesota` attaches to a running service and
starts it through the task when none runs; on other systems it starts a
detached process. `tesota service start`, `stop` and `status` print one JSON
object each. Stopping waits a grace period for running work to reach a safe
point, and work that cannot is stopped the same way as `Ctrl+C`. The service
keeps the environment it started with; the operator's terminal environment
does not reach it. Docker Sandboxes' own daemon is started by the service, so
it too survives SSH.

### 5. Remote access is SSH into the PC over a tailnet

The operator reaches the PC through Tailscale and Windows OpenSSH Server,
with key authentication only and the SSH firewall rule limited to the
tailnet's addresses, then runs `tesota`, which attaches to the service as any
local terminal does. Nothing new listens on the network. `tesota setup` lists
and guides these steps as it does sandbox setup, each confirmed and elevated
where Windows requires it.

### 6. Later, not now

A web or mobile client served only inside the tailnet, paired with one-time
tokens as t3code does, and an outbound relay like Claude Code Remote Control,
wait until SSH access is in daily use.

## Delivery

1. Split today's shell into the session service and a terminal client that
   talks to it through an in-process transport, with no change in behavior,
   and make questions session state. Coordinate with the terminal work in
   progress, which touches the same files.
2. The JSON-RPC protocol over the named pipe and Unix socket, the service
   process, and `tesota` attaching to it.
3. The Windows lifecycle: the Scheduled Task, on-demand start from SSH, and
   graceful stop.
4. Remote setup in `tesota setup`: OpenSSH Server, key-only authentication,
   the firewall rule limited to the tailnet, and Tailscale.

**Done when:** from another device on the tailnet, the operator connects over
SSH, runs `tesota`, sees the sessions that kept running, answers a pending
question, disconnects mid-work, and finds the work finished on reconnecting.

## Consequences

- One process holds every session; a fault in it affects them all, so it must
  recover sessions from their records, as the shell already does after a
  crash.
- The service keeps working while no one watches; supervised sessions still
  stop at their next question.
- A service upgrade restarts it; running work is stopped at a safe point
  first.

## Rejected alternatives

- **A network listener with pairing now.** It adds an authentication surface
  before SSH access is in use; t3code's pairing waits for a web client.
- **ACP as the service protocol.** It assumes one editor that starts the agent;
  sessions here outlive every client.
- **Starting the service from the terminal that needs it.** On Windows it
  would die with an SSH session.
- **Tailscale SSH on the PC.** Its server does not run on Windows.
- **An outbound relay first.** It routes work through a third party before
  the private-network path is exhausted.
