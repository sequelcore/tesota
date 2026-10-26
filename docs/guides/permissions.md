# Permissions

Every tool call passes one boundary before it runs: built-in tools, `prove`,
`check_model`, `agent` and tools from [MCP servers](mcp.md) alike. It's
decided in this order: a floor no setting crosses; read only, which refuses
anything that isn't a read; your rules; and, when no rule matches, the
session's mode.

## Modes

Shift+Tab switches the mode, and the footer shows it. Your choice is saved.

| Mode | Reads | Writes and edits | Commands, `prove`, `check_model`, MCP tools |
| --- | --- | --- | --- |
| read only | Allowed | Refused | Refused |
| ask (default) | Allowed | Asks you | Asks you |
| full access | Allowed | Allowed | Allowed |

When Tesota asks, you answer Yes, this once, Yes, for this
session, or No. A session in the background waits for you to show it.
With no one to ask, as in [print mode](print-mode.md), a call that would ask
is refused.

An MCP server may say a tool only reads; Tesota doesn't take its word, and
treats every MCP tool as running something.

## The floor

No mode or rule allows these:

- **Writing outside the session's folder and its
  [scratch folder](sessions.md).** The refusal names the scratch folder,
  so the agent knows where temporary files go; for the rest of that
  request, writing there is asked like any other change.
- **Touching a secret:** `.env` files, SSH's keys in `~/.ssh`, and Tesota's
  own sign-ins (`~/.tesota/auth.json`, `~/.tesota/mcp-auth.json`), by path or
  named in a command.
- **Destroying a disk, the root or a home folder:** `rm -rf /`,
  `Remove-Item -Recurse C:\`, `format`, `mkfs`, `dd` onto a disk, a fork
  bomb.

A home subfolder is not home itself: for example,
`Remove-Item (Join-Path $env:USERPROFILE 'sub\folder') -Recurse` is not
refused as a whole-home deletion. A literal subpath that ends back at home
(`.`, `x/..`) or climbs above it (`../x`) is still refused. The patterns
recognize flat, parent-first `Join-Path` pairs with literal children,
optionally with `-Path` and `-ChildPath`. Dynamic children and wildcards do
not exempt a home argument. Nested or unrecognized `Join-Path` forms keep
the original guarded arguments visible to the net. If a `Join-Path` remains
unrecognized, no guarded subpath in that command receives an exemption,
even alongside another flat pair. Guarded subpaths use
conservative Windows dot/space normalization: trailing dots and spaces do
not establish a child folder, and ambiguous leading `..` dot/space-only
segments count as parent steps. The patterns do not bind arbitrary parameters,
evaluate expressions, expand variables or wildcards, or resolve symbolic links.

The floor is a net of patterns, not a sandbox: a command can do harm it
doesn't recognize. Tesota has no sandbox of its own. It judges what a call
names, so it can't see that a later call reaches what it refused another
way: a script written and then run, an interpreter's one-liner, another
tool, or a subagent. So after it refuses:

- **The model is told the refusal covers the effect, not the command:** no
  one can allow it, you included, and it's not to reach it another way. If
  the work needs it, it says so in its final reply, or asks you what you
  want instead. Your answer can change the task; it never allows what the
  floor refused.
- **The rest of the request asks first.** Every command and file change
  the mode or a rule would allow is asked instead, even in full access.
  With no one to ask, it's refused. Reading isn't asked. The next request
  starts as before.
- **The request's end lists what it refused,** whatever else happened,
  with or without a receipt: each call, what it named, and why, and how
  many calls its subagents had refused. The receipt lists them too, without
  what they named, which may be a secret's path. A refusal shows that one
  call didn't run, not what ran instead, and it doesn't change the run's
  [standing](../receipt-v2.md#standing).

A determined agent can still reach a refused effect where you allow it to
continue: these make each attempt visible and put it to you, they don't
contain it.

## Rules

Rules are JSON, as `tool(pattern)` or a tool's name alone:

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
| `<project>/.tesota/permissions.json` | The project's: only `ask` and `deny`, so a repository can tighten what you allow but never grant itself more |

- **Tools:** `read`, `ls`, `find`, `grep`, `write`, `edit`, `shell`
  (whichever shell the platform runs: PowerShell on Windows, bash
  elsewhere), `ask_user`, `agent`, `prove`, `check_model`, and MCP tools by
  their name, `mcp__<server>__<tool>`. A rule names one tool exactly: a
  name with `*` in it isn't a rule, and stops the file from loading.
- **Reads:** `read`, `ls`, `find`, `grep`, `ask_user`, `agent` and the MCP
  resource tools count as reads, so every mode allows them unless a rule
  says otherwise. A subagent's own calls pass the boundary again
  ([Subagents](subagents.md#reading-and-writing)).
- **Questions:** an answer to `ask_user` never allows a later tool call;
  that call passes the same boundary as every other one.
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
