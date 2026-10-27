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

`/resume` continues on the model and account of the session's last reply,
not the shell's current model. To continue on another model, run `/model`
after resuming. A session with no reply yet keeps the current model.
Resuming doesn't change your saved model preference for the next shell.

If the session's model can no longer run, for example after signing out or
removing its account, Tesota names it, explains why it cannot run, and opens
the session on the shell's current model with a warning. Use `/model` to
choose another. If there is no current model either, Tesota doesn't resume
the session; choose a model with `/model` first.

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

Each session also gets a scratch folder for temporary files, such as a
commit message, a probe script or a fixture: `name.scratch/`, beside its
file. The agent's instructions name it, and its file tools may write there
as well as in the session's folder. It's outside the project, so it's
never staged or part of the change the receipt lists, and it's removed
when the session closes, then made again when it's resumed. A
[subagent](subagents.md) is a session of its own, so it gets its own. When
the sessions folder lies inside the project's repository and Git doesn't
ignore it, the session gets no scratch folder.

## Answer the agent

When the agent needs a decision from you, it shows up to three questions,
each with two to four choices. Pick one or several, as the question allows,
add your own text if you like, and submit. A choice marked as recommended
is only a suggestion: nothing is picked for you.

The run waits for your answer and then carries on; asking doesn't end it
or produce a receipt. The agent gets three tries at asking in one request.
When it needs more, the run ends incomplete with the open decision
rather than choosing for you.

If the agent ends with a question in plain text, such as “Should I…?” or
“¿Qué…?”, Tesota tells it once to ask through the question form
instead. When it does it again, or when no one can answer, as in
[print mode](print-mode.md) and in subagents, the run ends incomplete with
the question shown. Tesota spots direct questions in English and Spanish
in the last sentence; it can miss one asked another way.

Esc dismisses the questions without an answer, and Ctrl+C stops the run.
Ctrl+T opens the dashboard; your unfinished answers are kept until you come
back.

Your answers are saved before the agent reads them, and stay with your
request, so verification checks the change against them too. An answer
doesn't allow any tool call or accept the change.

## Several sessions at once

The first session in a folder works in the folder itself. Each one started
while another holds it works in a Git worktree of its own: a copy of
the repository on branch `tesota/<id>`, from the current commit, under
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
its state (idle, working, verifying, waiting for you, ended), its verification
(its last receipt's [standing](../receipt-v2.md#standing), `unverified`
before it has one), its workspace and how long it has run.

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
