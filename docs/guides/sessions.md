# Sessions

A session is one conversation with the agent in one folder, with its own
history, permissions and receipts. The shell runs several at once.

## Start, stop and resume

| | |
| --- | --- |
| `tesota` | Opens the shell with a new session in the current folder |
| Esc | Stops the agent's run |
| `/new` | Starts another session beside the open ones |
| `/resume` | Opens a session this folder ran before, by its first request |
| `/compact` | Summarizes the older conversation to free context |
| `/quit`, or Ctrl+C twice | Ends the shell |

`/resume` continues on the model and account of the session's last reply;
`/model` changes it. If that model can no longer run, Tesota says why and
opens the session on the current model; with none, choose one first.

Sessions are saved as they run, in `~/.tesota/sessions` (format version 7;
other versions are refused untouched). A session cut off by a crash or a
closed terminal resumes where its file ends, and nothing runs again on its
own: reads say they changed nothing, other started calls say their outcome
is unknown, and a run that may have changed files gets a receipt that
verified nothing. Send a new request to verify the current content.

Beside each session file, `name.output/` keeps long shell output, and
`name.scratch/` is the agent's scratch folder for temporary files, outside
the project and never part of the change. Scratch is removed when the
session closes; there is none when the sessions folder sits unignored
inside the repository.

## Answer the agent

When the agent needs a decision, it asks up to three questions with two to
four choices each. Pick one or several, add your own words if you like,
and submit; a recommended choice is never picked for you. The run waits,
then carries on.

The agent gets three tries at asking per request. Past that, or when it
ends with a plain-text question twice, or when no one can answer (print
mode, subagents), the run ends incomplete with the question shown; your
next message answers it and continues the same request. Esc dismisses the
questions, Ctrl+C stops the run, and Ctrl+T keeps your draft while you look
elsewhere.

Your answers are saved with your request, so verification checks the change
against them too. An answer never allows a tool call or accepts the change.

## Several sessions at once

The first session in a folder works in the folder. Each one started while
another holds it works in its own Git worktree, on branch `tesota/<id>`
under `~/.tesota/worktrees`, so two sessions never edit each other's
files. A worktree with no changes goes when its session closes; otherwise
Tesota says where it is:

```text
The session's work is in ~/.tesota/worktrees/shop-1a2b3c/k7…, on branch tesota/k7….
```

Merging that branch is yours. Outside Git, one session runs at a time.

## The dashboard

`/agents`, or Ctrl+T, lists every session: its request, its state (idle,
working, verifying, waiting for you, ended), its last receipt's
[standing](../receipt-v2.md#standing), its workspace and how long it has
run. The footer counts the sessions waiting for you.

Its keys are in [Commands and keys](../reference/commands.md#dashboard).

## Long conversations

Near the model's context window, Tesota summarizes the older part and keeps
the recent part word for word. Your requests and answers are never
summarized, so verification checks what you actually asked.

## Related

[Permissions](permissions.md) · [Commands and keys](../reference/commands.md) ·
[Architecture](../concepts/architecture.md#sessions)
