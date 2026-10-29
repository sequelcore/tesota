# Models

```text
/login
/model
```

`/login` signs you in to a provider and `/model` picks the model. Tesota
reaches models through [pi-ai](https://github.com/earendil-works/pi):
OpenAI, Google, OpenRouter, Mistral, xAI, Amazon Bedrock, Azure and more.

## Sign in

Pick a provider in `/login`: some sign in through your browser (`c` copies
the link), others take an API key you paste unseen. Sign-ins live in
`~/.tesota/auth.json`, readable only by you and by no tool call. A key in
the environment, such as `OPENAI_API_KEY`, works without `/login`.
`/logout` forgets one.

### Claude through Claude Code

On a Claude plan, Tesota runs Claude through your own Claude Code and never
reads its credentials. [Install Claude Code](https://code.claude.com/docs/en/setup),
run `claude` and `/login`; `/model` then lists `claude-code/<id>`, such as
`claude-code/claude-sonnet-5-5`. Claude Code only answers: Tesota's tools,
permissions, hooks and verification do the rest, and your Claude Code
settings, skills and MCP servers don't load. Usage draws on your plan.

**Known issue:** headless Claude Code sessions, such as Tesota's, are
reported to use more of the 5-hour window, about 1.8 times in the first
controlled comparison ([anthropics/claude-code#97074](https://github.com/anthropics/claude-code/issues/97074)).
Tesota doesn't disguise its sessions. For long runs, plan for that or use
another provider.

An Anthropic API key is a separate route, the `anthropic` provider:
`ANTHROPIC_API_KEY` or `/login`.

## Choose a model

`/model` lists every model you can use and saves your choice for new
sessions; `tesota -p "…" --model openai/gpt-6-sol` picks one for a run.
Signed in with ChatGPT, it lists only the models your plan serves.
`/settings` → Thinking sets how hard a reasoning model thinks, from `off`
to `max`. Verification's opinion models are in
[Verification](verification.md#choose-the-opinion-models).

## When a provider fails

Tesota retries rate limits, overload, 5xx and transport errors, at most
three times within two minutes, doubling from one second, honoring
`Retry-After` where pi-ai exposes it (Google's adapters don't). It retries
only the model call, on the same model and account. The shell counts down
(Esc stops it); print mode writes to standard error. Quotas, spending
limits, credits and sign-in failures end the run, with the provider's
reason, redacted; the request waits for your next message.

## Several accounts of one provider

```sh
tesota accounts add claude-code personal
tesota accounts add openai-codex work
```

Or `/login` → Add an account. A Claude account gets its own Claude Code
folder, `~/.tesota/accounts/claude-code/<name>`; a ChatGPT one its own
`openai-codex@<name>` sign-in. Then name it wherever you name a model:

```sh
tesota -p "Review the change" --model claude-code@personal/claude-opus-5-5
```

`tesota accounts` lists each one, and flags two that are the same account:

```text
claude-code (default)  owner@example.com
claude-code@personal  owner@example.com · same account as claude-code  /home/you/.tesota/accounts/claude-code/personal
openai-codex (default)  not signed in
openai-codex@work  <ChatGPT account ID>
```

`tesota accounts login <provider>@<name>` signs one in again;
`tesota accounts remove …` removes it, unless a setting still names it.
Tesota never switches accounts at a limit: the run ends and you choose.

### Usage

`/usage` and `/accounts` open the usage panel. Usage shows a meter per
limit window with what's left and when it resets; Accounts signs them in
again, removes or adds (`a`). `r` reads the limits again. Only
`claude-code` and `openai-codex` (OpenAI Codex (legacy) in `/login`) report
them; readings are kept in `~/.tesota/usage.json`, without credentials.

### Declaring accounts by hand

Accounts are the `accounts` list in `~/.tesota/settings.json`, for example
to reuse a Claude Code folder you have:

```json
{
  "accounts": [
    { "name": "personal", "provider": "claude-code", "folder": "/absolute/path/to/claude-personal" },
    { "name": "work", "provider": "openai-codex" }
  ],
  "model": "claude-code@personal/claude-opus-5-5"
}
```

Use an absolute folder, restart Tesota, then sign it in.

## Related

[Configuration](../reference/configuration.md) · [Commands and keys](../reference/commands.md)
