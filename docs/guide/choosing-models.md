# Choosing models

Tesota uses a model for each role. You can keep the defaults or assign a model
from an account you have signed in to. See [authentication](authentication.md)
for sign-in and [agents](../design/agents.md#model-routes) for the route contract.

## Roles

| Role | Work | When used |
| --- | --- | --- |
| `agent` | Changes the session's workspace | Every request and correction |
| `explorer` | Answers a repository question with read-only tools | Off by default |
| `advisor` | Reads the agent's conversation and gives advice without tools | Off by default |
| `reviewer` | Reviews the result | After the agent finishes |
| `refuter` | Tests the reviewer's findings | During review |
| `validator` | Checks whether a correction resolved a finding | After correction |
| `triage` | Decides whether a turn with no file changes needs a full check | On those turns; `off` always runs the full check |
| `namer` | Writes a short session title | At session start; `off` keeps the request as the title |

The built-in model choice is `codex:gpt-6-luna`. `tesota roles` lists the
current choice for every role, its account and who pays. An unreadable role
configuration is an error; Tesota does not silently choose another model.

## Routes and choices

A choice is `route:model`, optionally followed by a reasoning level such as
`@high`. `tesota models <route>` lists what that route offers; use it before
choosing a model. Available models, prices and limits can change. The route
identifies the account that pays or supplies plan usage.

| Route | Account |
| --- | --- |
| `codex` | Your ChatGPT plan |
| `claude-code` | Your Claude Code sign-in |
| `anthropic` | Your Anthropic API key |
| `openrouter` | Your OpenRouter account |
| `opencode`, `opencode-go` | Your OpenCode account |
| `typesafe` | Your TypeSafe key, for `triage` only |

Sign in to a route, inspect its models, then set a role:

```text
tesota auth login codex
tesota models codex
tesota roles
tesota roles reviewer codex:gpt-6-luna
```

`tesota roles <role> default` restores that role's built-in choice. In the
shell, `/roles` changes a role's model. A role uses the new choice when it
next starts work. The working agent keeps its session's model; `/model`
switches that session, with a handoff when the engine changes.

If you use more than one ChatGPT or Claude account, add a route for each one
and assign it to the roles that should use it:

```text
tesota auth login codex --as codex-work
tesota roles validator codex-work:gpt-6-luna
tesota auth status
```

`tesota auth status` names the account each route is signed in to, with its
email masked (`r3…@outlook.es`); `tesota auth status --show-accounts` shows it
whole, and so does `s` on the Sign-ins tab of the shell's Accounts panel.
When two routes are signed in to the same account, it says so under the table:
their limits are one plan's, so a route added for another account must be
signed in to that one. `tesota usage` reads that account once and shows the
second route as `same account as claude-code`. When roles on such routes
draw on one plan, `tesota roles`, the panel's Roles tab and the choice that
makes it so say which:

```text
Roles on claude-code (agent, reviewer) and claude-2 (advisor) share one plan's limits: both routes are signed in to the same account.
```

To move a route to another account, sign it in again: `tesota auth login
codex-work` keeps the route and the roles on it, and the earlier login stays
until the new one completes. `tesota auth logout codex-work` signs it out and
keeps it too. `tesota auth remove codex-work` deletes an added route, and
refuses while a role uses it.

`tesota usage` shows available provider usage data when you request it; some
routes cannot report it. [Using Tesota](using-tesota.md) explains the shell
controls.

## How to choose

- Give the working agent a model that can complete your tasks within your
  account's limits. It handles every request and correction.
- Where you have the choice, use a reviewer from a different model family
  than the agent. Tesota warns when a judging role shares a model or lab with
  the output it judges; the warning does not block a choice.
- Choose a refuter that can scrutinize the reviewer's findings. Review and
  refutation are advice; the checks and your decision remain separate.
- Keep explorers and the advisor off until a task benefits from them. Add
  them through `tesota roles` and compare the result on your own work.
- Raise a reasoning level only when a model accepts it and a measured run
  shows the extra time or usage helps. Without an explicit level, Pi uses
  medium and Claude Code uses its model's default.

To compare reviewer choices on Tesota's fixed cases, use `bun run
live:review` with the `--model-reviewer=` and `--model-refuter=` options.
The command uses your signed-in accounts and writes its record under the
ignored `live-runs/` directory. [Development](../development.md#evaluations)
explains the evaluation's limits. A good score on those cases does not prove
that a model will catch defects in your project.
