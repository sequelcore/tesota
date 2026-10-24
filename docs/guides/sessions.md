# Sessions

A session is one conversation with the agent, in one folder, with its own
history, permissions and receipts. Tesota's shell runs several at once.

## Start, stop and resume

| | |
| --- | --- |
| `tesota` | Opens the shell with a new session in the current folder |
| Esc | Stops the agent's run |
| `/new` | Starts another session beside the open ones |
| `/resume` | Opens a session this folder ran before, by its first request |
| `/compact` | Summarizes the older conversation to free context |
| `/quit`, or Ctrl+C twice | Ends the shell |

Every session is saved as it runs, in `~/.tesota/sessions`. A session that
was cut off, by a crash or a closed terminal, resumes where its file ends:
a call that only reads says it changed nothing. Other calls that started
say their outcome is unknown; calls that never started say "not run".
No call runs again automatically. An interrupted shell call also shows the
end of what it printed, when saved, and the path to its full output. A run
that may have changed files gets a receipt that verified nothing and says
what changed is unknown; send a new request to verify the current content
([verification](../concepts/verification.md)). A session never opened again
gets none.
A [subagent](subagents.md) the session was running ends "outcome unknown",
and its own session ends interrupted. Session files use format version 6, which records withdrawals of pending messages;
other versions are refused without changing their files.

Long shell output stays beside the session file: `name.jsonl` keeps its
output in `name.output/`. The folder is created on first use and kept when
the session closes, so a "Full output" path still works after resuming.

## Answer the agent

The agent can ask up to three questions with two to four choices each,
and attempt at most three question batches in one request, including malformed
or unavailable calls. A fourth attempt ends the run incomplete with the unresolved
decision, rather than choosing for you. Select one or several choices as the question allows, add your own text,
then submit the answers. A recommendation is a suggestion; nothing is
selected or submitted for you. Questions wait until you answer, dismiss
them or stop the run. An admitted question keeps the same run open: no
verification or receipt is published just for asking. Work resumes after your
answer and verifies at its real end.

A direct blocking question in the last prose paragraph gets one request to use
`ask_user`, only when someone can answer and a batch remains. The repair may
only ask the question or clarify that no decision is needed. A second blocking
prose question or a failed repair ends incomplete. Malformed and unavailable
question calls share this one repair allowance. Both bounds survive amendments,
compaction and verification continuations.

Recognition is a small English/Spanish heuristic, not a semantic guarantee.
It covers direct forms such as “Should I…?”, “Which…?”, “Let me know which…”
and “¿Quieres…?”, “¿Qué…?”, “Dime cuál…”. Code, quotes and headings are excluded;
a question mark alone does not trigger it. Implicit questions, uncovered forms
and other languages can be missed. Without a responder, as in print mode and
subagents, a recognized unresolved question settles incomplete and stays visible.

Ctrl+T opens the dashboard while a question is shown. Switching sessions
keeps its unfinished answers; showing it again restores them. Esc dismisses
the questions without an answer. Ctrl+C stops the run while its question
form is open.

Submitted answers are saved before the agent receives them. They stay with
your request through compaction and resume, and qualify what verification
checks. An answer does not grant execution permission or accept a change.

## Several sessions at once

The first session in a folder works in the folder itself. Each one started
while another holds it works in a **Git worktree** of its own: a copy of
the repository on branch `tesota/<id>`, from the current commit, in
`~/.tesota/worktrees`. Its tools, permissions, checks and receipt are its
own, so two sessions never edit each other's files.

When a session closes, its worktree goes if nothing in it changed.
Otherwise it stays, and Tesota says where:

```text
The session's work is in ~/.tesota/worktrees/shop-1a2b3c/k7…, on branch tesota/k7….
```

Merging that branch is yours. Outside a Git repository only one session
runs at a time, since nothing could bring a second one's work back.

## The dashboard

`/agents`, or Ctrl+T, opens the dashboard: every session with its request,
its state (idle, working, verifying, waiting for you, ended), its verification,
its workspace and how long it has run.

| Key | |
| --- | --- |
| ↑ ↓ | Select a session |
| Enter | Show it |
| Space | Peek at its last lines |
| `n` | Start a new session |
| `x` | Close it; a running one asks to confirm with `y` |
| Esc | Back |

A session in the background that needs an answer waits until you show it,
and the footer says how many are waiting.

## Long conversations

When the conversation nears the model's context window, Tesota summarizes
the older part and keeps the recent part word for word. Your request
and submitted answers are never summarized: verification checks the change against
what you actually asked. `/compact` does the same on demand.

## Related

- [Permissions](permissions.md)
- [Commands and keys](../reference/commands.md)
- [Architecture: sessions](../concepts/architecture.md#sessions)
