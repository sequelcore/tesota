# Sessions

## The shell

Running `tesota` in a repository starts **Tesota Shell**, a terminal
conversation built on pi-tui components rather than Pi's own chat components,
so Tesota's themes apply to everything on screen. A shell holds any number of
**sessions**, each with its own work, in the project or in a workspace, execution environment and working
agent; at most two work at once, and the rest wait. Tesota's sidebar puts the
repository and branch above a newest-created-first session list. Selection and
background activity never reorder it. Each row distinguishes preparation,
work, command approval, checks, review, decision, application, unread work,
ended sessions and unresolved effects; only executing phases move. On a wide
terminal the sidebar is inline, while an explicit open on a narrow terminal is
a non-capturing pi-tui overlay, so the editor keeps focus and `Esc` keeps its
stop-work meaning. The sidebar and the terminal's title name the selected
session; no heading sits over the conversation.

Surfaces are layered by role, with hue kept for meaning. The conversation, the
main content, stays on the terminal's own background. The inline sidebar and
the result panel beside the conversation sit on one side surface, a neutral
step from that background toward the text color, mixed in sRGB from the
background the terminal reports, so it is even on any terminal; a `│` rule
in a stronger step stands in the gap between each and the conversation, and
the sidebar over a narrow conversation carries both too. Tesota's TUI lays
them after the layout is drawn, beneath any background the content sets
itself, as a selected row or a diff tint. The input sits on the operator's own
background, as their sent messages do; without colors, as the terminal theme,
only the rules show, and the input keeps a rule above and below. Each theme's
contrast tests cover the side surface: its text colors at 4.5:1, a selected
row and the rule visible on it, and it apart from the canvas. In the result
panel, each record section and each file of the diff is a block under a rule.
Under the input, as Claude Code and Codex order it, the selected
model comes first with the repository and branch, and the mode and execution
location have a line of their own in its color, followed by the keys that
cycle the mode and show the shortcuts ([using Tesota](../guide/using-tesota.md)
lists the keys).

A fresh session opens with an ephemeral palo fierro welcome that fills the
empty conversation: a small lit scene centered above the name and package
version, working directory and a short statement of how changes are decided.
The palo fierro is a nurse tree, so a saguaro seedling grows in its shade;
grown saguaros stand further off, one of them behind the tree, smaller, higher
toward the horizon and faded, so depth reads in what hides what. The camera
stays still, looking slightly down. For nine seconds, only while the
terminal has focus, a wind rises and falls in the crown (its tips move most,
the trunk not at all); each crown lobe stands at its own depth and sways on its
own phase. When the terminal loses focus it pauses and fades, at rest too, and
returns to full strength with focus; while the prompt holds a draft it pauses
and drops its color, and colors again once the draft is gone. A plain left click on the
resting scene plays it again, and from then on the same wind blows a
tumbleweed through: a tangle of dry stems that rolls and bounces from the right
edge to the left, behind the trunk and in front of the distant saguaros. It is
left out of the opening itself, which plays in every new session and should
stay calm.
The scene rests in the pose it began in. The first entry
that becomes part of the session removes it and leaves the header, the name in
bold with its version muted as `Tesota (v0.0.0)`, as the conversation's first
entry, spaced as the entries after it; replies to shell commands show beneath it, and it gives up their
rows. Where it would not fit, only the header shows. `TESOTA_REDUCED_MOTION=1`
shows the resting pose without motion. The welcome is presentation only: it is
not a conversation entry or saved session state, and restored sessions do not
show it again. The scene takes its colors from the active theme: leaves and
the saguaros in its success color, the distant ones faded toward the
background, bark between its warning and muted colors and the tumbleweed's
straw from it, edges lit in its accent, and gloss in its
foreground, so `/themes` recolors it; the `terminal` theme draws it in the
terminal's own colors. `welcome-mark.ts` owns the scene's geometry, motion,
lighting and Braille rasterization, adapted from the Codex welcome's method;
`tesota-shell-welcome.ts` owns its timing, focus, layout and click. Surface
points are computed once, with each crown point's place in the wind, and only
the nearest point at each Braille dot is lit, so a frame costs about what the
single turning tree it replaced did. Focus comes from the terminal's focus
reports, which pi-tui turns on but keeps to itself, so `FocusReportingTerminal`
in `tesota-shell-tui.ts` reads them on their way in.

`tesota-shell-theme.ts` owns the terminal palettes, and
`tesota-shell-theme-picker.ts` uses pi-tui's `SelectList` for `/themes`.
Switching mutates a shell-local palette shared by its components and rebuilds
cached styled content without replacing sessions or streaming tool calls.
The accepted theme names are specified and proved in
`verification/shell-theme-rule.ts`. These are terminal adaptations, not the
GUI's surface system: the terminal still owns the canvas and ordinary text.

The sidebar's responsive mode, state precedence, moving states and
newest-first index, waiting-first grouping and the footer's count of waiting
sessions (shown only while the sidebar is hidden, as "1 needs you") are pure
rules in `verification/sidebar-rule.ts`, with
LemmaScript specifications proved by Dafny. Rendering belongs to
`tesota-shell-sidebar.ts`; terminal composition and input remain in
`tesota-shell-terminal.ts`.

Command, network, site and reviewed-result questions replace the editor with
a themed pi-tui `SelectList` in `tesota-shell-question.ts`. Arrows select,
Enter confirms and the offered single-key shortcuts answer immediately;
permission questions begin on No, and result questions on Keep working.
The question scrolls independently when it is long, keeping the choices
visible. A waiting question belongs to its session and preserves the draft
and queued requests. Command and network answers are saved as notices that
name what was allowed or declined, never as user messages or editor history.
Requests, check commands and hidden-file paths still use the editor.
`verification/question-rule.ts` proves that a shortcut can select only an
offered option; a missing shortcut or multiple characters leave it waiting.

A session is **named** after its work, as Codex, Claude Code
and OpenCode name theirs. It starts as "Session N"; the operator's first
request, shortened to its first line, names it at once; and in the
background one short session writes a title of three to seven words from
that request, in its language, with a `title` tool and nothing else
(`src/integrations/session-namer.ts`). That session runs on the `namer`
role's model, `chatgpt:gpt-6-luna@low` by default, as Codex names its threads
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

Tesota speaks in a session to two audiences, and the agent is a third. A
**record** (`writeTo`) is something that happened to the session's work: where
its commands run, its workspace and preparation, a model switch, a turn kept,
reverted or redone, a review's forecast, a failure. It is saved with the
session, restored with it, and ends the opening. A **reply** (`replyTo`)
answers the operator: help, listings such as `/checks` or `/sandbox` alone, a
usage hint, "nothing to keep", a presentation setting such as `/themes`, or a
command refused before it changed anything. It shows like a notice but is not
saved and is not part of the session. Neither reaches the agent: the agent
reads no notice. What changes its world, such as a revert, a redo, a rejected
result, commands moved to another sandbox, hidden files or the operator's own
edits, reaches it as Tesota context with its next request, marked as not
written by the user; everything else stays out of its context and its tokens.

The loop itself, request, checks, review, correction and decision, is
independent of the terminal (`tesota-shell.ts`), and so is each session's
work (`session-engine.ts`). Every point where a session waits for someone is
a typed decision (`session-decisions.ts`): the terminal asks the operator
each one and renders the session's output, and a run without a terminal
can answer them by a stated policy.

## What a session holds

A session acquires its work, in the project or in a workspace, then its execution environment, then its
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
the session holds unresolved effects, which keep it as evidence; a session in
the project releases the trees it pinned and leaves its changes in the files. Quitting
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
per session, its name and where the name came from, the transcript, the review inspections, where its work is recorded,
the agent's model and conversation id, the ids of conversations it left at a
handoff, and whether the session was interrupted or blocked; and, per repository, the approved check commands with the JUnit XML reports each names, the hidden files they may read, the network
destinations allowed for every session, and the measured costs of recent
reviews. After a restart, sessions and their work and conversations are
restored; a session interrupted mid-request is marked so. Command approvals
belong to one session's run; their decision notices stay in the transcript
but grant no authority to future commands. Check results are never saved.
