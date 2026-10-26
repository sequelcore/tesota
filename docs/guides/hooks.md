# Hooks

A hook is a command of yours that runs before or after each of the agent's
tool calls. It can refuse a call, or leave you a note. Tesota reads hooks in
Claude Code's format, which Codex follows too.

## Refuse a force-push

Save this guard as `~/.tesota/hooks/no-force-push.mjs`:

```js
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const command = JSON.parse(input).tool_input?.command ?? "";
  if (/\bgit\s+push\b.*\s(--force|-f)\b/.test(command)) {
    console.error("Force-pushing is not allowed here.");
    process.exit(2);
  }
});
```

Then add it under `hooks` in `~/.tesota/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash|powershell", "hooks": [{ "type": "command", "command": "node ~/.tesota/hooks/no-force-push.mjs", "timeout": 30 }] }
    ],
    "PostToolUse": [
      { "matcher": "write|edit", "hooks": [{ "type": "command", "command": "bunx prettier --check ." }] }
    ]
  }
}
```

When the agent runs `git push --force origin main`, the call doesn't run,
and the agent reads `Not run: A hook refused it: Force-pushing is not
allowed here.` A plain `git push` goes through.

On Windows a hook's command runs in `cmd.exe`, which doesn't expand `~`:
write the guard's full path there. Elsewhere it runs in `sh`.

## Where hooks go

| File | |
| --- | --- |
| `~/.tesota/settings.json` | Yours, for every project |
| `<repository root>/.tesota/settings.json` | The project's, which run only once you trust them |

- **Events:** `PreToolUse`, before a call runs, and `PostToolUse`, after.
- **`matcher`:** a regular expression that must match the whole tool name,
  so `bash|powershell` matches either shell and `mcp__github__.*` matches
  every tool of one server. Empty, `*` or absent matches every tool.
- **`timeout`:** seconds before the hook is stopped, with every process it
  started; 600 when not given.

The tool names are `read`, `write`, `edit`, `ls`, `find`, `grep`, the shell
(`powershell` on Windows, `bash` elsewhere), `ask_user`, `agent`, `prove`,
`check_model`, and each MCP server's tools as `mcp__<server>__<tool>`, with
`list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`
when a server offers resources.

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
environment variable `TESOTA_PROJECT_DIR` is the session's folder, which is
also where the hook runs.

## What a hook decides

| The hook | Effect |
| --- | --- |
| Exits `2` | Refuses the call, with its error output as the reason |
| Exits `0` and prints `{"decision": "block", "reason": "…"}` | Refuses the call |
| Exits `0` and prints `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "…"}}` | Refuses the call |
| Prints `{"systemMessage": "…"}` | Shows you a note |
| Fails, times out, writes broken JSON or can't start | The call goes on, with a note saying so |

Hooks run after the [permission](permissions.md) check, so they can only
refuse more. The hooks that match a call run at the same time, and any one
that refuses wins. A refusal before a call keeps it from running, and the
agent reads `Not run: A hook refused it: …`. A refusal after a call adds
`A hook says: …` to its result.

## Trusting a project's hooks

A project's hooks run its own commands on your computer, so when you open
it, Tesota lists them and asks: Trust them, kept until their commands
change, or Not now. [Print mode](print-mode.md) never asks, and runs a
project's hooks only once you've trusted them in the shell.

## Related

- [Permissions](permissions.md)
- [Configuration](../reference/configuration.md)
