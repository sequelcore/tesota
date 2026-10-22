# Permissions

Every tool call passes one boundary before it runs: built-in tools, `prove`,
`check_model` and tools from [MCP servers](mcp.md) alike. Three things
decide it, in order: a floor no setting crosses, the session's mode, and
your rules.

## Modes

Shift+Tab switches the mode, and the footer shows it. Your choice is saved.

| Mode | Reads | Writes and edits | Commands, `prove`, `check_model`, MCP tools |
| --- | --- | --- | --- |
| **read only** | Allowed | Refused | Refused |
| **ask** (default) | Allowed | Asks you | Asks you |
| **full access** | Allowed | Allowed | Allowed |

When Tesota asks, you answer **Yes, this once**, **Yes, for this
session**, or **No**. A session in the background waits for you to show it.
With no one to ask, as in [print mode](print-mode.md), a call that would ask
is refused.

An MCP server may say a tool only reads; Tesota doesn't take its word, and
treats every MCP tool as running something.

## The floor

No mode or rule allows these:

- **Writing outside the session's folder.**
- **Touching a secret:** `.env` files, SSH's keys in `~/.ssh`, and Tesota's
  own sign-ins (`~/.tesota/auth.json`, `~/.tesota/mcp-auth.json`), by path or
  named in a command.
- **Destroying a disk, the root or a home folder:** `rm -rf /`,
  `Remove-Item -Recurse C:\`, `format`, `mkfs`, `dd` onto a disk, a fork
  bomb.

The floor is a net of patterns, not a sandbox: a command can do harm it
doesn't recognize. Tesota has no sandbox of its own.

## Rules

Rules are JSON, as `tool(pattern)` or a tool's name alone:

```json
{
  "allow": ["shell(bun test*)", "shell(git status)", "write(src/**)"],
  "ask": ["shell(git push*)"],
  "deny": ["write(**/*.lock)", "mcp__github__delete_*"]
}
```

| File | |
| --- | --- |
| `~/.tesota/permissions.json` | Yours: `allow`, `ask` and `deny` |
| `<project>/.tesota/permissions.json` | The project's: only `ask` and `deny`, so a repository can tighten what you allow but never grant itself more |

- **Tools:** `read`, `ls`, `find`, `grep`, `write`, `edit`, `prove`, `check_model`, `shell` (whichever shell the
  platform runs: PowerShell on Windows, bash elsewhere), and MCP tools by
  their name, `mcp__<server>__<tool>`.
- **Questions:** `ask_user` has read access in every mode, subject to your
  rules and hooks. Its answer never allows a later tool call; that call
  passes the same permission boundary as every other one.
- **Patterns** match a path, relative to the session's folder, or a shell
  command. `*` matches anything but `/` in a path and anything in a
  command; `**` matches across folders.
- **The strongest rule wins:** deny over ask over allow. With no rule, the
  mode decides.
- **Commands are read in parts.** `git status && rm -rf x` is two commands:
  an allow rule allows it only when every part is allowed, and a command
  that runs another inside it (`$(…)`, backticks) is never allowed by a
  rule. A deny or ask rule that names any part counts.

A rule file Tesota can't read stops it with an error naming the file, since
a rule left out could be a deny.

## Related

- [Hooks](hooks.md), to refuse calls with your own commands
- [Configuration](../reference/configuration.md)
