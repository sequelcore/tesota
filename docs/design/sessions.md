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

A fresh session opens with an ephemeral palo fierro welcome in the conversation:
name and package version, working directory, a short statement of the apply
boundary, then the ASCII tree. The tree grows through five fixed-size frames
when the terminal is large enough. Smaller terminals use a compact tree or
symbol; `TESOTA_REDUCED_MOTION=1` shows the final frame immediately. The
welcome is presentation only: it is not a conversation entry or saved session
state, and restored sessions do not show it again. `tesota-shell-welcome.ts`
owns the artwork, tones and responsive rendering.

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

A session is **named** after its work, as Codex, Claude Code
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
needed, and keeps them until it ends. Preparation starts when
the session opens and runs in the background. Closing the session, switching
its sandbox and quitting all end what it holds the same way: a preparation
still under way is stopped, the agent ends, and the environment is released,
so a ten-minute dependency install does not outlive the session that asked
for it. What failed to be acquired is forgotten, so the next request tries
again, but only while nothing newer has taken its place: an environment
prepared after a sandbox switch stays the session's even when the earlier
preparation fails later. Closing also removes the session's workspace, unless
the session holds unresolved effects, which keep it as evidence. Quitting
waits for the releases up to five seconds; a WSL sandbox process whose
input closes stops its commands and its proxy itself
([execution](execution.md#wsl-sandbox)).

At most two sessions work at once, and a turn runs at most three explorers;
both limits are one semaphore (`src/semaphore.ts`), which grants places in
the order they were asked for and drops a waiter whose work was stopped.

This is built on the platform's own promises, abort signals and
`AsyncDisposableStack`. A stop an engine did not confirm stays unconfirmed.
The [roadmap](../roadmap.md) records the comparison required before a session
service is built.

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
