# Hooks

A hook is a command of yours that runs before or after each of the agent's
tool calls. It can refuse a call, or leave a note. Tesota reads hooks in
Claude Code's format, which Codex follows too, so a guard written for them
works here.

## Configure

Under `hooks` in a settings file:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "shell", "hooks": [{ "type": "command", "command": "python3 ~/.agents/hooks/guard.py", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "write|edit", "hooks": [{ "type": "command", "command": "bunx prettier --check ." }] }
    ]
  }
}
```

| File | |
| --- | --- |
| `~/.tesota/settings.json` | Yours, for every project |
| `<repository root>/.tesota/settings.json` | The project's, which run only once you trust them |

- **Events:** `PreToolUse`, before a call runs, and `PostToolUse`, after.
- **`matcher`:** the tool names the group runs for: a name, names joined
  by `|`, or a pattern of the whole name. Empty, `*` or absent matches every
  tool. Tools are `read`, `write`, `edit`, `prove`, `check_model`, the platform's shell
  (`powershell` on Windows, `bash` elsewhere) and `mcp__<server>__<tool>`.
- **`timeout`:** seconds before the hook is stopped, with every process it
  started; 600 when not given.

## What a hook receives

The call as JSON on its standard input:

```json
{
  "session_id": "2026-10-17T19-04-22-736Z-d132bfba",
  "cwd": "/home/you/shop",
  "hook_event_name": "PreToolUse",
  "tool_name": "bash",
  "tool_input": { "command": "git push --force origin main" }
}
```

After a call, `tool_response` holds its `output` and `isError`. The
environment variable `TESOTA_PROJECT_DIR` is the session's folder.

## What a hook decides

| The hook | Effect |
| --- | --- |
| Exits `2` | Refuses the call, with its error output as the reason |
| Exits `0` and prints `{"decision": "block", "reason": "…"}` | Refuses the call |
| Exits `0` and prints `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}` | Refuses the call |
| Prints `{"systemMessage": "…"}` | Shows you a note |
| Fails, times out, writes broken JSON or can't start | The call goes on, with a note saying so |

Hooks run after the [permission](permissions.md) check, so they can only
refuse more. A call's hooks run at the same time, and any one that refuses
wins. A refusal before a call keeps it from running, and the agent reads
`Not run: A hook refused it: …`. A refusal after a call adds `A hook says:
…` to its result.

## Trusting a project's hooks

A project's hooks run its own commands on your computer, so when you open
it, Tesota lists them and asks: **Trust them**, kept until their commands
change, or **Not now**. [Print mode](print-mode.md) never asks, and runs a
project's hooks only once you've trusted them in the shell.

## Related

- [Permissions](permissions.md)
- [Configuration](../reference/configuration.md)
