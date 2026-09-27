# Sessions

## The shell

Running `tesota` in a repository starts **Tesota Shell**, a terminal
conversation built on pi-tui components rather than Pi's own chat components,
so Tesota's themes apply to everything on screen. A shell holds any number of
**sessions**, each with its own workspace, execution environment and working
agent; at most two work at once, and the rest wait. Tesota's sidebar puts the
repository and branch above a newest-created-first session list. Selection and
background activity never reorder it. Each row distinguishes preparation,
work, command approval, checks, review, decision, application, unread work,
ended sessions and unresolved effects; only executing phases move. On a wide
terminal the sidebar is inline, while an explicit open on a narrow terminal is
a non-capturing pi-tui overlay, so the editor keeps focus and `Esc` keeps its
stop-work meaning. The selected session heads the conversation; repository
identity joins that heading when the sidebar is absent. Execution location and
the selected model stay beside the prompt ([using Tesota](../guide/using-tesota.md)
lists the keys).

The sidebar's responsive mode, state precedence, moving states and
newest-first index are pure rules in `verification/sidebar-rule.ts`, with
LemmaScript specifications proved by Dafny. Rendering belongs to
`tesota-shell-sidebar.ts`; terminal composition and input remain in
`tesota-shell-terminal.ts`.

A session is **named** after its work (decision 036), as Codex, Claude Code
and OpenCode name theirs. It starts as "Session N"; the operator's first
request, shortened to its first line, names it at once; and in the
background one short session writes a title of three to seven words from
that request, in its language, with a `title` tool and nothing else
(`src/integrations/session-namer.ts`). That session runs on the `triage`
role's model, a cheap one by design, at low reasoning when the model
accepts it, or on the validator's when triage is off or uses a decision
model, which cannot write; so the request goes to a route the operator
already uses. `/rename <name>` names the session, and `/rename` alone asks
for a title from its latest requests. Which name may replace which is a
proved rule (`src/verification/session-title-rule.ts`): the operator's name
always wins, a model's title replaces only what showed at once, and the
shortened request only the counter, so a late title never undoes a rename.
A title that does not come within 30 seconds, or at all, leaves the name the
session has. Names are one printable line, at most 60 characters.

The loop itself, request, checks, review, correction and decision, is
independent of the terminal (`tesota-shell.ts`); the terminal only renders it
and asks the operator's questions.

## What is saved

Each repository has one saved store under `~/.tesota/shell-sessions/`, and a
lock file keeps a second shell from opening the same repository at once; a
lock left by a process that is no longer running is replaced. The store holds,
per session, its name and where the name came from, the transcript, the review inspections, the workspace location,
the agent's model and conversation id, the ids of conversations it left at a
handoff, and whether the session was interrupted or blocked; and, per repository, the approved check commands, the network
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
