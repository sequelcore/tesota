# The chatgpt route replaces the codex route

Status: Accepted on 2026-09-29; built on 2026-10-08, pending a live sign-in
on real accounts. [Issue #191](https://github.com/sequelcore/tesota/issues/191).

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

Three things rest on the legacy route's evidence until a live sign-in confirms
them: that `wham/usage` accepts the new token for the usage windows, that the
plan serves the same models through the OpenAI API, and that a free plan
refuses the same three. Measurements recorded before 2026-10-08 name the
`codex` route; they ran on the legacy sign-in.
