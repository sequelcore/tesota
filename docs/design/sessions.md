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

`tesota-shell-theme.ts` owns the terminal palettes, and
`tesota-shell-theme-picker.ts` uses pi-tui's `SelectList` for `/themes`.
Switching mutates a shell-local palette shared by its components and rebuilds
cached styled content without replacing sessions or streaming tool calls.
The accepted theme names are specified and proved in
`verification/shell-theme-rule.ts`. These are terminal adaptations, not the
GUI's surface system: the terminal still owns the canvas and ordinary text.

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
(`src/integrations/session-namer.ts`). That session runs on the `namer`
role's model, `codex:gpt-6-luna@low` by default, as Codex names its threads
with Luna at low effort; a role of its own, since naming is no other role's
responsibility, and `off` keeps the shortened request as the name.
`/rename <name>` names the session, and `/rename` alone asks
for a title from its latest requests. Which name may replace which is a
proved rule (`src/verification/session-title-rule.ts`): the operator's name
always wins, a model's title replaces only what showed at once, and the
shortened request only the counter, so a late title never undoes a rename.
A title that does not come within 30 seconds, or at all, leaves the name the
session has. Names are one printable line, at most 60 characters.

**A frame costs what the screen shows, not what the session holds.** The
shell redraws while a session works, up to eight times a second for its
spinner, so each frame must not grow with the conversation, as Codex keeps
finished history in the terminal's scrollback and Claude Code renders
finished messages once. Two rules follow from pi-tui's layout. No horizontal
stack holds another inside a column: pi-tui sizes an `HStack`'s columns by
rendering each whole on every frame, so the result and comparison panels are
columns of the root beside the session's own, as Pi keeps its transcript in
no `HStack`. And every entry keeps its rendered lines per width until what it
shows changes, as pi-tui's own guidance asks: the agent's replies through
pi-tui's Markdown, tool calls, notices and the diff view through their own
caches; adding an entry clears none of them, since `Container.invalidate()`
clears every child's. A test fails if a frame renders any `HStack` whole.
With 800 entries a frame takes about 2 ms, against 472 ms before (findings,
2026-09-27).

The loop itself, request, checks, review, correction and decision, is
independent of the terminal (`tesota-shell.ts`); the terminal only renders it
and asks the operator's questions.

## What a session holds

A session acquires its workspace, then its execution environment, then its
working agent with its explorers and advisor, each the first time it is
needed, and keeps them until it ends (decision 038). Preparation starts when
the session opens and runs in the background. Closing the session, switching
its sandbox and quitting all end what it holds the same way: a preparation
still under way is stopped, the agent ends, and the environment is released,
so a ten-minute dependency install does not outlive the session that asked
for it. What failed to be acquired is forgotten, so the next request tries
again, but only while nothing newer has taken its place: an environment
prepared after a sandbox switch stays the session's even when the earlier
preparation fails later. Closing also removes the session's workspace, unless
the session holds unresolved effects, which keep it as evidence. Quitting
waits for the releases up to five seconds; the native sandbox's drive leases
cover one that does not finish ([execution](execution.md#native-sandbox)).

At most two sessions work at once, and a turn runs at most three explorers;
both limits are one semaphore (`src/semaphore.ts`), which grants places in
the order they were asked for and drops a waiter whose work was stopped.

This is built on the platform's own promises, abort signals and
`AsyncDisposableStack`. Effect v4's scopes and structured concurrency were
evaluated for it and not adopted for now: they would replace this plumbing
but not the outcomes Tesota keeps distinct, such as a stop an engine did not
confirm, and v4 was still a release candidate. The choice is taken again, by
a matched comparison, before the session service below is built
([Effect runtime landscape](../research/effect-runtime-landscape.md)).

## What is saved

Each repository has one saved store under `~/.tesota/shell-sessions/`, and a
lock file keeps a second shell from opening the same repository at once; a
lock left by a process that is no longer running is replaced. The store holds,
per session, its name and where the name came from, the transcript, the review inspections, the workspace location,
the agent's model and conversation id, the ids of conversations it left at a
handoff, and whether the session was interrupted or blocked; and, per repository, the approved check commands with the JUnit XML reports each names, the network
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
