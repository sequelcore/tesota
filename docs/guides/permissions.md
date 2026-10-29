# Permissions

Every tool call passes one boundary before it runs, built-in, `prove`,
`check_model`, `agent` and [MCP](mcp.md) tools alike, decided in this
order: a floor no setting crosses; read only; your rules; and the mode.

## Modes

Shift+Tab switches the mode; the footer shows it and your choice is saved.

| Mode | Reads | Writes and edits | Commands, `prove`, `check_model`, MCP tools |
| --- | --- | --- | --- |
| read only | Allowed | Refused | Refused |
| ask (default) | Allowed | Asks you | Asks you |
| full access | Allowed | Allowed | Allowed |

You answer Yes, this once, Yes, for this session, or No. A background
session waits for you to show it. With no one to ask, as in
[print mode](print-mode.md), the call is refused. Every MCP tool counts as
running something, whatever its server says.

## The floor

No mode or rule allows:

- writing outside the session's folder and its [scratch folder](sessions.md);
- touching a secret: `.env` files, `~/.ssh` keys, Tesota's sign-ins;
- destroying a disk, the root or a home folder.

It's a net of patterns, not a sandbox. After a refusal, the rest of the
request asks before every change, even in full access, and its end lists
what was refused. [The floor](../reference/floor.md) has every pattern and
how it reads PowerShell.

## Rules

Rules are JSON, `tool(pattern)` or a tool's name alone:

```json
{
  "allow": ["shell(bun test*)", "shell(git status)", "write(src/**)"],
  "ask": ["shell(git push*)"],
  "deny": ["write(**/*.lock)", "mcp__github__delete_file"]
}
```

| File | |
| --- | --- |
| `~/.tesota/permissions.json` | Yours: `allow`, `ask` and `deny` |
| `<project>/.tesota/permissions.json` | The project's: only `ask` and `deny`, so a repository can tighten but never grant |

- **Tools:** `read`, `ls`, `find`, `grep`, `write`, `edit`, `shell`
  (PowerShell on Windows, bash elsewhere), `ask_user`, `agent`, `prove`,
  `check_model`, and `mcp__<server>__<tool>`. A name with `*` isn't a
  rule, and stops the file from loading.
- **Reads:** `read`, `ls`, `find`, `grep`, `ask_user`, `agent` and MCP
  resource tools, allowed in every mode unless a rule says otherwise. A
  subagent's calls pass the boundary again; an `ask_user` answer never
  allows a later call.
- **Patterns** match a path from the session's folder, or a command. `*`
  matches anything but `/` in a path and anything in a command; `**`
  crosses folders.
- **The strongest rule wins:** deny, then ask, then allow; with none, the
  mode.
- **Commands are read in parts.** `git status && rm -rf x` is allowed only
  if every part is; `$(…)` and backticks are never allowed by a rule. A
  deny or ask naming any part counts.

A rule file Tesota can't read stops it, since a missing rule could be a
deny.

## Related

[Hooks](hooks.md) · [The floor](../reference/floor.md) · [Configuration](../reference/configuration.md)
