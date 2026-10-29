# Subagents

The agent can hand part of your request to a subagent: another agent with
its own context, say one that explores a large codebase or fixes one bug
while the main agent goes on. One that changes files ends with its own
receipt.

## How the agent starts one

The `agent` tool takes:

| Argument | Meaning |
| --- | --- |
| `prompt` | The brief; the subagent sees nothing else of the conversation |
| `description` | A few words the shell shows |
| `type` | An [agent type](#agent-types); a general agent when not given |
| `model` | `provider/id` its sign-in serves; else the type's, then the session's |
| `writes` | `true` to let it change files, in a worktree of its own |
| `wait` | `true` to wait for its report; else it runs in the background |

A background subagent's report arrives as a message when it ends. Several
can run at once, and a run doesn't end while one still runs.

## Reading and writing

| | Works in | Tools | Permissions |
| --- | --- | --- | --- |
| Reads | The session's folder | `read`, `ls`, `find`, `grep`, the session's MCP servers | Read only |
| Writes | Its own Git worktree, on branch `tesota/<id>` | The session's tools, without MCP | The session's mode, never wider |

Neither asks you questions; their calls pass your [rules](permissions.md)
and [hooks](hooks.md). A read-only session starts no writer, and a writer
needs a repository with a commit.

A writer commits on its branch and ends with a receipt about it. Its work
counts toward your request only once the agent merges or cherry-picks it
into its own workspace, where your verification checks it. The report
alone is never evidence. Your receipt lists each subagent and where its
receipt stands ([Receipt v2](../receipt-v2.md#child)).

### Its branch, and no other

Every process a writer starts runs with a Git `reference-transaction`
hook, set through the environment, that aborts any move of another branch
or a tag in its repository. Your repository's own hooks stay untouched. It
needs Git 2.54 or later; `subagentBranchGuard` in
[settings](../reference/configuration.md#settingsjson) decides without it:

| Value | Git 2.54+ | Older Git |
| --- | --- | --- |
| `require` (default) | Guarded | No writer starts |
| `warn` | Guarded | Starts unguarded, and the receipt says so |
| `off` | Unguarded | Unguarded |

It guards branches, not workspaces: a command that turns it off, `git -C`
aimed at another worktree, what an aborted command already did to its own
files, direct edits to `.git`, and the shared stash, configuration, hooks
and remotes are outside it.

## Limits

| Limit | Value |
| --- | --- |
| Depth | A subagent can start its own; one two below your session can't |
| At once | 4 across a session and its subagents; `agentLimit` sets it |
| Replies | 100 per subagent |
| Time | 60 minutes per subagent |

Esc or closing the session stops its subagents. If Tesota ends while one
runs, reopening says its outcome is unknown; nothing runs again by itself.

## Seeing them

The shell shows each subagent under the call that started it, with its
type, model, depth and state; Ctrl+O shows its report. `/agents` lists
them under the sessions. Each is a session of its own that `/resume` opens
once it ends.

## Agent types

A Markdown file with frontmatter, in Claude Code's format:

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
| `name` | For `type`; the file's name when not given |
| `description` | When to use it; a file without one is left out |
| `model` | `provider/id`; anything else, such as `sonnet` or `inherit`, leaves it to the call or session |
| `writes` | `true` for a writer |
| `background` | `false` to wait for it (`is_background` too) |

The body joins the subagent's instructions; other fields are ignored. A
type whose `model` isn't `provider/id` still loads, and the shell says once
which model it runs on instead. Tesota reads `~/.agents/agents`, then
`~/.tesota/agents`, then each project's `.agents/agents` from the root
down; the nearer wins by name, as with [skills](instructions-and-skills.md#skills).
