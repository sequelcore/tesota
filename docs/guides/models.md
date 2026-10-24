# Models

Tesota reaches models through [pi-ai](https://github.com/earendil-works/pi)'s
providers: OpenAI, Google, OpenRouter, Mistral, xAI, Amazon Bedrock, Azure
and about thirty more.

## Sign in

```text
/login
```

Pick a provider. Some sign in with your account in the browser; others
take an API key, which you paste without it showing. When a provider
offers both, Tesota asks which. Sign-ins are kept in `~/.tesota/auth.json`,
readable only by you, and no tool call may touch that file.

An API key in the environment works without `/login`, such as
`OPENAI_API_KEY` or `OPENROUTER_API_KEY`.

`/logout` forgets a provider's sign-in.

### Claude through Claude Code

On a Claude plan, Tesota runs Claude through your own Claude Code,
unmodified. A release binary runs the `claude` on your `PATH`, so
[install Claude Code](https://code.claude.com/docs/en/setup) first; from
source, Tesota runs the program the Claude Agent SDK installs with it, and
`claude` on your `PATH` only when that one is missing. Sign in there, not in
Tesota: run `claude`, then `/login`. Tesota never sees your Claude
sign-in. Once you are signed in, `/model` lists Anthropic's models as
`claude-code/<id>`, such as `claude-code/claude-sonnet-5-5`. Until then it
says how to sign in.

Claude Code only answers. Tesota's tools, permissions, hooks, compaction and
verification run as on any model, and none of your Claude Code settings,
`CLAUDE.md`, skills or MCP servers load. Claude Code runs in the session's
folder, including its worktree. Tesota removes the Claude Code transcripts
it creates when the query ends, and their project folder only if it is empty.
Usage draws on your plan's limits,
which assume ordinary individual use; shared or heavy use belongs on an
`anthropic` API key. Why this route fits Anthropic's terms is in
[the decision record](../decisions/claude-code-route-terms.md).

## Choose a model

```text
/model
```

lists the models of every provider you can use. Your choice is saved, and
each new session starts with it. `tesota -p "…" --model openai/gpt-6-sol`
picks one for a single run. Tesota never picks a model for you: until you
choose one, the shell's status says so, and `-p` stops and says how.

Signed in with ChatGPT, OpenAI serves only some of its models to your plan.
`/model` lists only those, and a saved or `--model` choice outside them is
refused before any request, naming the ones you can use. When that list
can't be fetched, such as offline, your choice is kept and Tesota says it
wasn't checked; OpenAI still refuses a model it doesn't serve.

## Several accounts of one provider

Declare each account in your `~/.tesota/settings.json`, not a project's file:

```json
{
  "accounts": [
    { "name": "personal", "provider": "claude-code", "folder": "/absolute/path/to/claude-personal" },
    { "name": "work", "provider": "openai-codex" }
  ],
  "model": "claude-code@personal/claude-opus-5-5"
}
```

Use an absolute folder for Claude Code (`C:/accounts/claude-personal` on
Windows, for example). Names contain letters, digits, `_` or `-`, and are
unique within a provider. Restart Tesota after changing the list.

For Claude, sign in with Claude Code itself, using that folder:

```sh
CLAUDE_CONFIG_DIR=/absolute/path/to/claude-personal claude
# Then /login in Claude Code
```

In PowerShell, set `$env:CLAUDE_CONFIG_DIR = 'C:/accounts/claude-personal'`
before running `claude`. Tesota sets `CLAUDE_CONFIG_DIR` for that instance's
Claude Code only. Named instances ignore ambient `ANTHROPIC_*` and
`CLAUDE_*` overrides so a shell token or API key cannot replace the folder's
sign-in. Tesota never changes `HOME`, and never reads, copies or stores
Claude Code's credentials. It asks `claude auth status` in that folder for
sign-in status and the account label.

For ChatGPT, run `/login` in Tesota and pick `openai-codex@work`. Each
instance has its own credential slot in `~/.tesota/auth.json`; logging out
of one does not sign another out. The plain provider ID remains the default
account, separate from the named instances.

Choose an account exactly as you choose a model: `/model`, `--model`, the
saved `model`, an agent type's `model`, or the `agent` tool's `model`:

```sh
tesota -p "Review the change" --model claude-code@personal/claude-opus-5-5
```

For example, a type can name `openai-codex@work/gpt-6.1-sol`. Run receipts
keep the account-qualified model. The model and login lists label instances
with Claude's email or ChatGPT's account ID and flag `same account as …`
when two instances identify the same account, including the default. Print
mode also reports the account labels. If the provider cannot report an
identity, Tesota says it is unavailable rather than guessing.

**Tesota never switches accounts automatically.** A limit ends that run
with the provider's message; only you can explicitly choose another account.
Use only your own accounts, never a shared account.

## Thinking

For a model that reasons, `/settings` → **Thinking** sets how hard it
thinks: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The
footer shows it beside the model when it isn't off. A model that doesn't
reason ignores it.

## Models Tesota itself asks

Verification may ask two models for their opinion, labeled as such and
never counted as evidence:

- **The contract comparison** uses the session's model, or the one
  `--claimcheck-model` names.
- **The open cases** your request leaves are listed by GPT-6 Sol, or the
  model `--open-cases-model` names; `off` turns the list off.

[Verification](verification.md#the-models-opinions) covers both.

## Related

- [Configuration](../reference/configuration.md)
