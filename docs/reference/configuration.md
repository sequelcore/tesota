# Configuration

Tesota keeps its state in `~/.tesota`, and reads a project's own settings
from its `.tesota` folder at the repository's root. Every file is
optional.

## Your files: `~/.tesota`

| Path | Holds |
| --- | --- |
| `bin/` | The `tesota` binary the [install scripts](../get-started/install.md) put there |
| `settings.json` | Your settings, below, and your [hooks](../guides/hooks.md) |
| `permissions.json` | Your [permission rules](../guides/permissions.md#rules): `allow`, `ask`, `deny` |
| `mcp.json` | Your [MCP servers](../guides/mcp.md) |
| `AGENTS.md` | Your [instructions](../guides/instructions-and-skills.md) for every project |
| `skills/` | Your [skills](../guides/instructions-and-skills.md#skills), beside `~/.agents/skills` |
| `agents/` | Your [agent types](../guides/subagents.md#agent-types), beside `~/.agents/agents` |
| `auth.json` | Model sign-ins, readable only by you |
| `mcp-auth.json` | MCP servers' sign-ins, readable only by you |
| `trust.json` | The projects whose hooks and MCP servers you trusted, as they were then |
| `sessions/` | Every session, one JSON Lines file each, by project |
| `worktrees/` | The Git worktrees of [sessions](../guides/sessions.md) that run beside another |
| `snapshots/` | Tesota's snapshots of folders in no repository |
| `workspaces/` | Which session holds which checkout |
| `tools/tla2tools.jar` | TLC, which [model checks](../guides/verification.md#model-check-it-tla-and-quint) run; you put it there |

No tool call may read or change `auth.json` or `mcp-auth.json`.

### `settings.json`

```json
{
  "model": "openai/gpt-6-sol",
  "thinkingLevel": "medium",
  "permissionMode": "ask",
  "tuiMode": "fullscreen",
  "hooks": {}
}
```

| Setting | Values | Set by |
| --- | --- | --- |
| `model` | `<provider>/<id>` | `/model` |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `/settings` |
| `permissionMode` | `read`, `ask` (default), `full` | Shift+Tab |
| `tuiMode` | `fullscreen` (default), `inline` | `/settings` |
| `agentLimit` | How many [subagents](../guides/subagents.md) run at once across a session and its subagents: 1 to 16, 4 by default | You |
| `subagentBranchGuard` | Whether Git keeps a [subagent that writes](../guides/subagents.md#its-branch-and-no-other-619) off every branch but its own: `require` (default), `warn`, `off` | You |
| `hooks` | See [Hooks](../guides/hooks.md) | You |

A value Tesota doesn't recognize is left out, and Tesota names it when it
starts. Tesota writes only the setting that changed, so two shells keep
each other's.

## A project's files

| Path | Holds |
| --- | --- |
| `.tesota/settings.json` | The project's [hooks](../guides/hooks.md), which run once you trust them |
| `.tesota/mcp.json` | The project's [MCP servers](../guides/mcp.md), which start once you trust them |
| `.tesota/permissions.json` | The project's `ask` and `deny` [rules](../guides/permissions.md#rules) |
| `AGENTS.md`, or `CLAUDE.md` | [Instructions](../guides/instructions-and-skills.md), in any folder from the root down |
| `.agents/skills/` | The project's [skills](../guides/instructions-and-skills.md#skills) |
| `.agents/agents/` | The project's [agent types](../guides/subagents.md#agent-types) |
| `package.json`, `build.gradle`, `pom.xml`, `Cargo.toml`, `go.mod` | The commands Tesota [checks the change with](../guides/verification.md#test-it-your-commands) |
| `lemmascript.json` | Where LemmaScript keeps each file's proof (`proof-dir`) |

## Environment

| Variable | |
| --- | --- |
| A provider's API key, such as `OPENAI_API_KEY` | Uses that provider without `/login` |
| `TESOTA_PROJECT_DIR` | Set for [hooks](../guides/hooks.md): the session's folder |
