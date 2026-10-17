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
a tool call that may have run is marked as such and never runs again.

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
itself is never summarized: verification always checks the change against
what you actually asked. `/compact` does the same on demand.

## Related

- [Permissions](permissions.md)
- [Commands and keys](../reference/commands.md)
- [Architecture: sessions](../concepts/architecture.md#sessions)
