# Models

```text
/login
/model
```

`/login` signs you in to a provider, and `/model` picks the model the
session runs on. Tesota reaches models through
[pi-ai](https://github.com/earendil-works/pi)'s providers, such as OpenAI,
Google, OpenRouter, Mistral, xAI, Amazon Bedrock and Azure.

## Sign in

Pick a provider in `/login`. Some sign in with your account in the
browser; others take an API key, which you paste without it showing. When
a provider offers both, Tesota asks which. A browser sign-in opens your
browser and prints the link as well, in case it doesn't; `c` copies it. Sign-ins are kept
in `~/.tesota/auth.json`, readable only by you, and no tool call may touch
that file.

An API key in the environment, such as `OPENAI_API_KEY` or
`OPENROUTER_API_KEY`, works without `/login`. `/logout` forgets a
provider's sign-in.

### Claude through Claude Code

- On a Claude plan, Tesota runs Claude through your own Claude Code.
- It never reads Claude Code's credentials.
- A named account sets only `CLAUDE_CONFIG_DIR`, to the account's folder.

A release binary runs the `claude` on your `PATH`, so
[install Claude Code](https://code.claude.com/docs/en/setup) first; run
from source, Tesota runs the Claude Code the Claude Agent SDK installs,
and the one on your `PATH` only when that's missing. Sign in there: run
`claude`, then `/login`. `/model` then lists Anthropic's
models as `claude-code/<id>`, such as `claude-code/claude-sonnet-5-5`.
Claude Code only answers: Tesota's own tools, permissions, hooks and
verification do the rest, and your Claude Code settings, skills and MCP
servers don't load. Usage draws on your plan's limits.

An Anthropic API key is a separate route, through the `anthropic`
provider, with no Claude Code: set `ANTHROPIC_API_KEY`, or enter the key
in `/login`. It takes an API key only, not a Claude plan's sign-in. Heavy
or shared use belongs there.

## Choose a model

`/model` lists the models of every provider you can use. Your choice is
saved, and each new session starts with it. `tesota -p "…" --model
openai/gpt-6-sol` picks one for a single run. Until you choose one, the
shell's status says so, and `-p` stops and says how.

Signed in with ChatGPT, OpenAI serves only some of its models to your
plan. `/model` lists only those, and a choice outside them is refused
before any request, naming the ones you can use.

For a model that reasons, `/settings` → Thinking sets how hard it
thinks: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. The
footer shows it beside the model when it isn't off.

Verification can ask a model for its opinion too;
[Verification](verification.md#the-models-opinions) covers which.

## Several accounts of one provider

Add each account with its provider and a name of yours:

```sh
tesota accounts add claude-code personal
tesota accounts add openai-codex work
```

In the shell, `/login` → Add an account does the same. Names contain
letters, digits, `_` or `-`, and are unique within a provider.

- **Claude:** Tesota makes the account's folder,
  `~/.tesota/accounts/claude-code/<name>`, and starts your Claude Code's
  sign-in there. It records the account once Claude Code says it's signed
  in.
- **ChatGPT:** Tesota signs the account in to its own slot,
  `openai-codex@<name>`, then records it.

The account is then a provider like any other. Name it wherever you name a
model: `/model`, `--model`, the saved `model`, an agent type's `model`, or
the `agent` tool's `model`.

```sh
tesota -p "Review the change" --model claude-code@personal/claude-opus-5-5
```

`tesota accounts` lists each account with the account it's signed in to,
and flags `same account as …` when two are one:

```text
claude-code (default)  owner@example.com
claude-code@personal  owner@example.com · same account as claude-code  /home/you/.tesota/accounts/claude-code/personal
openai-codex (default)  not signed in
openai-codex@work  <ChatGPT account ID>
```

| To | Command line | Shell |
| --- | --- | --- |
| Sign one in again | `tesota accounts login claude-code@personal` | `/accounts`, choose it, Enter, Sign in again |
| Remove one | `tesota accounts remove openai-codex@work` | `/accounts`, choose it, Enter, Remove |

Removing an account that your `model` setting or an agent type still names
is refused, naming which. Removing a Claude account deletes the folder
Tesota made for it; a folder you declared yourself stays.

Tesota doesn't switch accounts when one reaches its limit: the run ends
with the provider's message, and you choose another.

### Usage of your accounts

`/usage` opens the usage panel on its Usage tab, and `/accounts` on its
Accounts tab. Tab or ←/→ switch tabs, and Esc closes it; the session keeps
running beneath.

- **Usage:** for each account, a meter per limit window, such as the 5-hour
  and the weekly one, with the share left and when it resets (`resets in
  3h 12m`). It turns to the warning color at a quarter left.
- **Accounts:** each account, whether it's signed in, and its email when
  the provider gives one. Enter offers Sign in again or Remove, and
  `a` adds an account. A provider's default sign-in is listed, marked
  `default`, but isn't managed here.

`this session` marks the account the session draws on. `r` reads the
limits again. Only two providers report them:

| Provider | Where the reading comes from |
| --- | --- |
| `claude-code` | Claude Code's own usage report, which may change between its releases |
| `openai-codex` | Codex's usage endpoint, with the account's own sign-in |

The newer OpenAI sign-in, `openai` with ChatGPT, doesn't report its
limits; the Codex sign-in, OpenAI Codex (legacy) in `/login`, does.
When you use the first and have no Codex sign-in, the Usage tab says so. The last readings are
kept in `~/.tesota/usage.json`, with no token, credential, email or
account ID.

### Declaring accounts by hand

The accounts are the `accounts` list in your `~/.tesota/settings.json`,
which you can write yourself, for example to use a Claude Code folder you
already have:

```json
{
  "accounts": [
    { "name": "personal", "provider": "claude-code", "folder": "/absolute/path/to/claude-personal" },
    { "name": "work", "provider": "openai-codex" }
  ],
  "model": "claude-code@personal/claude-opus-5-5"
}
```

Use an absolute folder. Restart Tesota after editing the list, then sign
the account in with `tesota accounts login <provider>@<name>`.

## Related

- [Configuration](../reference/configuration.md)
- [Commands and keys](../reference/commands.md)
