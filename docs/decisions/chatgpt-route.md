# The chatgpt route replaces the codex route

Status: Accepted on 2026-09-29; built and exercised live on 2026-10-08.
[Issue #191](https://github.com/sequelcore/tesota/issues/191).

## Context

The `codex` route signed in through Pi's `openai-codex` provider, which Pi
0.99 renamed "OpenAI Codex (legacy)" and superseded with Sign in with ChatGPT
on its `openai` provider. Tesota is pre-release, so the operator chose to move
to the new sign-in and drop the legacy one, with no compatibility layer.

The two differ in more than the sign-in. The legacy token reached
`chatgpt.com/backend-api` through Codex's own fixed client; the new one is
issued for `api.openai.com/v1`, to a client OpenAI registers for each
sign-in, with the scope `chatgpt.tokens.use.direct`. Pi 1.1.0 lets an
application name itself on OpenAI's consent screen (`LoginOptions.agentName`)
and asks it for a stable installation id. Pi's `openai` provider also accepts
an `OPENAI_API_KEY` from the environment and lists the whole OpenAI API
catalogue.

## Decision

- The route kind is `chatgpt`: `tesota auth login chatgpt`,
  `chatgpt:gpt-6-luna`, `--as chatgpt-work`. It names the account, and leaves
  `openai` free for an API-key route.
- Sign-in is Pi's browser flow, which names Tesota; Tesota creates and keeps
  the installation id beside its credentials (`~/.tesota/auth/device-id`).
- Tesota registers its own provider in place of Pi's `openai`
  (`src/integrations/chatgpt-provider.ts`): Sign in with ChatGPT is its only
  sign-in, so an environment API key is never billed for a plan's route, and
  it offers only the models a plan served through Codex.
- Logins saved for the legacy route are not read, and `codex` route choices in
  `~/.tesota/routes.json` and `models.json` are invalid: the operator signs
  each account in again and renames the kind in those files.

## Consequences

Each account signs in again once, in a browser. The legacy route's device-code
sign-in, which needed no browser on this computer, is gone; a browser on
another computer still works by pasting the address it ended on.

Exercised live on 2026-10-08:

- A Plus account signed in, OpenAI's screen named Tesota, and requests
  passed the live model-session contract.
- A free account signed in in the browser, and OpenAI then refused to
  exchange the sign-in for a token. OpenAI's help centre says using a plan in
  other apps needs Go, Plus or Pro. The legacy route had served free accounts
  through Codex; this one cannot. Tesota names the refusal, and the free-plan
  model filter the legacy route needed (#296) is removed. The operator kept
  only paid accounts on the route.
- `wham/usage` refuses the new token, and OpenAI documents no usage source
  for it, only a refused request at a plan's limit, so `tesota usage` points
  to ChatGPT's settings.
- The token names no email and no plan; status shows the account by its id.
- OpenAI documents `GET /v1/models` on the account's token for the models it
  serves; the route still offers a fixed list, and the roadmap holds the
  change.
- Pi registers a new client at every sign-in, where OpenAI asks applications
  to keep the issued one for the account, so each sign-in adds a connected
  app in ChatGPT's settings.

Measurements recorded before 2026-10-08 name the `codex` route; they ran on
the legacy sign-in.
