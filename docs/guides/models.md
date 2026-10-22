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
