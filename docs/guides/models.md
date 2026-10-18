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

## Choose a model

```text
/model
```

lists the models of every provider you can use. Your choice is saved, and
each new session starts with it. `tesota -p "…" --model openai/gpt-6-sol`
picks one for a single run. Tesota never picks a model for you: until you
choose one, the shell's status says so, and `-p` stops and says how.

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
