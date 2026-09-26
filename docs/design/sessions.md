# Sessions

## The shell

Running `tesota` in a repository starts **Tesota Shell**, a terminal
conversation built on pi-tui components rather than Pi's own chat components,
so Tesota's themes apply to everything on screen. A shell holds any number of
**sessions**, each with its own workspace, execution environment and working
agent; at most two work at once, and the rest wait. Tesota's sidebar shows
each session's state, such as `needs you`, `working` or `idle`, and the
operator moves between sessions, closes them, and opens results beside the
conversation ([using Tesota](../guide/using-tesota.md) lists the keys).

The loop itself, request, checks, review, correction and decision, is
independent of the terminal (`tesota-shell.ts`); the terminal only renders it
and asks the operator's questions.

## What is saved

Each repository has one saved store under `~/.tesota/shell-sessions/`, and a
lock file keeps a second shell from opening the same repository at once; a
lock left by a process that is no longer running is replaced. The store holds,
per session, the transcript, the review inspections, the workspace location,
the agent's conversation id, and whether the session was interrupted or
blocked; and, per repository, the approved check commands, the network
destinations allowed for every session, and the measured costs of recent
reviews. After a restart, sessions and their workspaces and conversations are
restored; a session interrupted mid-request is marked so. Command approvals
and check results are never saved: they belong to one session's run.

## Planned: a session service

Today a session lives inside the terminal process that opened it: closing the
terminal, or losing a remote desktop connection, ends the work's host. The
adopted design, not yet built, separates the two. Evidence is in the
[remote access landscape](../research/agent-remote-landscape.md).

- **One long-lived service per operator account** owns every session: records,
  workspaces, environments, agent and reviewer sessions, and the journal. It
  holds each repository's lock, so any number of terminals can attach, and it
  runs as the operator, never elevated.
- **Clients speak JSON-RPC 2.0 over local IPC only:** a named pipe on Windows,
  a Unix domain socket elsewhere, and no network port. A client first presents
  a secret the service writes to a file only the operator's account can read,
  because a Windows named pipe's default access also lets other accounts
  connect. The protocol mirrors the operator's actions, and the service
  notifies clients of activity, reviews and questions.
- **Questions are session state.** A command approval, a network decision,
  the check choice or apply and reject is stored with its session until
  answered; any attached client may answer, the first answer wins, and a
  session with no client waits. Clients rebuild their view from the service on
  attach.
- **The service starts outside any terminal or SSH session.** On Windows a
  per-user Scheduled Task starts it at logon and on demand, because a process
  started inside a Windows SSH session is killed when the session closes.
  `tesota service start`, `stop` and `status` print one JSON object each;
  stopping waits for running work to reach a safe point.
- **Remote access is SSH into the PC over a tailnet:** Windows' own OpenSSH
  Server with key authentication only, its firewall rule limited to the
  tailnet, then `tesota`, which attaches like any local terminal. Tailscale's
  own SSH server does not run on Windows. Nothing new listens on the network;
  `tesota setup` would guide these steps.

It is done when, from another device on the tailnet, the operator connects
over SSH, sees the sessions that kept running, answers a pending question,
disconnects mid-work, and finds the work finished on reconnecting.

### Why this shape

- **The terminal becomes a client of a long-lived process**, as in Codex's
  app-server daemon, opencode, t3code and herdr.
- **Nothing listens on a public port:** Codex and Claude Code use local
  sockets or outbound connections, and a network listener with pairing adds an
  authentication surface before SSH access is even in use.
- **Pending questions outlive the connection**, as Claude Code queues
  permission prompts until a client is back.
- **Tesota's own protocol rather than ACP:** the Agent Client Protocol assumes
  one editor that starts the agent and holds its only session; Tesota's
  sessions outlive every client. An ACP adapter for editors may sit on top.

Later, not now: a web or mobile client served only inside the tailnet with
one-time pairing tokens, as t3code does, and an outbound relay like Claude
Code Remote Control.
