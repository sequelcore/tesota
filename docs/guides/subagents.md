# Subagents

The agent can hand a task to a **subagent**: another agent with its own
context, such as one that explores a large codebase or fixes one bug while
the main agent goes on. A subagent's work comes back with evidence: one
that changes files ends with its own receipt.

## How the agent starts one

The `agent` tool takes:

| Argument | Meaning |
| --- | --- |
| `prompt` | The brief. The subagent sees nothing of the conversation, only this |
| `description` | A few words the shell shows |
| `type` | An [agent type](#agent-types); a general agent when not given |
| `model` | `provider/id` of a model Tesota is signed in to; the type's, then the session's, when not given |
| `writes` | `true` to let it change files, in a worktree of its own; it only reads when not given |
| `wait` | `true` to wait for its report; it runs in the background when not given |

A background subagent's report comes to the agent as a message when it
ends, in the order they end. Several started in one reply run at once. A
run doesn't end while one of its subagents runs: when the agent stops, the
run waits for the next report and goes on with it.

## Reading and writing

| | Works in | Tools | Permissions |
| --- | --- | --- | --- |
| A subagent that reads | The session's folder | `read`, `ls`, `find`, `grep`, and the session's MCP servers | Read only, whatever the session's mode |
| A subagent that writes | A Git worktree of its own, on branch `tesota/<id>` | The session's tools, without its MCP servers | The session's mode, never a wider one |

Neither asks you questions. Their calls pass your
[permission rules](permissions.md) and [hooks](hooks.md); one that would ask
you, asks. A read-only session starts no subagent that writes, and a
subagent that writes needs a Git repository with a commit.

A subagent that writes is told to commit its work on its branch. Its run
ends in a receipt about that branch, like any run. The agent gets its report,
its receipt and its branch, and what it changed counts toward your request
only once the agent brings it into its own workspace, with `git merge` or
`git cherry-pick`. There your verification checks it like any change of the
agent's own. The report alone is never evidence.

The receipt lists each subagent the run started, with how it ended and
where its own receipt stands. See [Receipt v2](../receipt-v2.md#child).

## Limits

| Limit | Value |
| --- | --- |
| Depth | A subagent can start its own; one two below your session starts none |
| At once | 4 across a session and its subagents; `agentLimit` in [settings](../reference/configuration.md#settingsjson) sets it |
| Replies | 100 per subagent, then it's stopped and says so |
| Time | 60 minutes per subagent, then it's stopped and says so |

Stopping the run, with Esc, stops its subagents, and closing the session
does too. If Tesota ends while a subagent runs, the session says its outcome
is unknown when it's opened again, its own session ends interrupted, and
nothing runs again by itself.

## Seeing them

The shell shows each subagent under the call that started it, with its
type, model, depth and state, and one line when a background one ends;
Ctrl+O shows its report. Each subagent is a session of its own, in the same
sessions folder, with the session that started it in its header. Once it
ends, `/resume` opens it like any other.

## Agent types

An agent type is a Markdown file with frontmatter, in Claude Code's format,
so a definition copies across unchanged:

```markdown
---
name: reviewer
description: Reviews a change for defects. Use after a fix, before opening a PR.
model: openai/gpt-6-sol
writes: false
---

You review a change. Read the diff, then report each defect with its file and line.
```

| Field | Meaning |
| --- | --- |
| `name` | Its name, for `type`; the file's name when not given |
| `description` | When to use it. A file without one is left out |
| `model` | `provider/id`. A Claude Code alias such as `sonnet` or `inherit` is left out, so the call or the session decides |
| `writes` | `true` for a subagent that writes |
| `background` | `false` to wait for it; pstack's `is_background` says the same |

Other fields are ignored. The body is added to the subagent's instructions.
Tesota reads `~/.agents/agents`, then `~/.tesota/agents`, then each
project folder's `.agents/agents` from the repository's root down; the
nearer wins by name, as with [skills](instructions-and-skills.md#skills).
The `agent` tool lists the types within the same budget as the skill
catalog.
