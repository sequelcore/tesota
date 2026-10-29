# Configuration

Tesota keeps its state in `~/.tesota`, and reads a project's own settings
from its `.tesota` folder at the repository's root. Configuration files
are optional; Tesota creates state files as needed.

## Your files: `~/.tesota`

| Path | Holds |
| --- | --- |
| `accounts/claude-code/<name>/` | Claude Code configuration for a named account; see [Models](../guides/models.md) |
| `bin/` | The `tesota` binary the [install scripts](../get-started/install.md) put there |
| `settings.json` | Your settings, below, and your [hooks](../guides/hooks.md) |
| `permissions.json` | Your [permission rules](../guides/permissions.md#rules): `allow`, `ask`, `deny` |
| `mcp.json` | Your [MCP servers](../guides/mcp.md) |
| `AGENTS.md` | Your [instructions](../guides/instructions-and-skills.md) for every project |
| `skills/` | Your [skills](../guides/instructions-and-skills.md#skills), beside `~/.agents/skills` |
| `agents/` | Your [agent types](../guides/subagents.md#agent-types), beside `~/.agents/agents` |
| `auth.json` | Model sign-ins |
| `mcp-auth.json` | MCP servers' sign-ins |
| `usage.json` | The usage panel's last readings of each account's limits, with their time and a one-way fingerprint of whom they were read for; no token, credential, email or account ID ([Usage of your accounts](../guides/models.md#usage)) |
| `trust.json` | Approvals tied to project roots and hashes of hooks or MCP configuration; changed configuration needs trust again |
| `sessions/` | Every session, one JSON Lines file each, by project |
| `worktrees/` | The Git worktrees of [sessions](../guides/sessions.md) that run beside another |
| `snapshots/` | Tesota's snapshots of folders in no repository |
| `workspaces/` | Operating-system locks reserving checkouts for sessions |
| `tools/tla2tools.jar` | TLC for [design model checks](../guides/model-checking.md); you put it there |

No tool call may read or change `auth.json` or `mcp-auth.json`.

### `settings.json`

```json
{
  "thinkingLevel": "medium",
  "permissionMode": "ask",
  "tuiMode": "fullscreen",
  "hooks": {}
}
```

| Setting | Values | Set by |
| --- | --- | --- |
| `model` | `<provider>/<id>`, including `<provider>@<account>/<id>` | `/model` |
| `openCasesModel` | `<provider>/<id>` or `off`; the session's model by default. `--open-cases-model` overrides it for one run | You |
| `claimcheckModel` | `<provider>/<id>` for ClaimCheck's restating pass; the session's model by default. `--claimcheck-model` overrides it for one run | You |
| `accounts` | Array of named sign-ins; user settings only. See [Models](../guides/models.md) for fields and management | Account commands or you |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | `/settings` |
| `permissionMode` | `read`, `ask` (default), `full` | Shift+Tab |
| `tuiMode` | `fullscreen` (default), `inline`; takes effect on next start. Windows over SSH uses inline | `/settings` |
| `agentLimit` | How many [subagents](../guides/subagents.md) run at once across a session and its subagents: 1 to 16, 4 by default | You |
| `subagentBranchGuard` | Whether Git keeps a [subagent that writes](../guides/subagents.md) off every branch but its own: `require` (default), `warn`, `off` | You |
| `hooks` | See [Hooks](../guides/hooks.md); read separately from the settings above | You |
| `deviceId` | Installation UUID used by some sign-in flows | Generated when needed |

Invalid values of known settings are left out and named at startup.
Unknown keys are silently ignored. Saving a changed setting preserves
other keys under a lock, so two shells keep each other's changes.

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
| `CLAUDE_CODE_EXECUTABLE` | Explicit Claude Code executable path, before the SDK's bundled program or `claude` on `PATH`; used by the isolated test runner to select its fake |
| `TESOTA_PROJECT_DIR` | Set for [hooks](../guides/hooks.md): the session's folder |
