# The claude-code route under Anthropic's terms

Status: Accepted on 2026-10-08. The route is built; this record changes no
behavior. Closes [issue #322](https://github.com/sequelcore/tesota/issues/322).

## Context

The `claude-code` route runs Claude Code through
`@anthropic-ai/claude-agent-sdk`, signed in with the operator's own Claude
plan. Anthropic's position on plan sign-in outside its own applications
changed several times in 2026, and Tesota must not be published on a route
whose terms it has not read. This is not a legal determination.

What Anthropic published, read on 2026-10-08:

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):
  developers may not "offer Claude.ai login into their own applications, or
  … route requests through Free, Pro, or Max plan credentials on behalf of
  their users", nor "collect, store, or intermediate Claude.ai credentials or
  session tokens". It does not "prevent an end user from signing in to the
  unmodified Claude Code binary with their own Claude subscription". Plan
  limits "assume ordinary, individual usage of Claude Code and the Agent
  SDK". A product may say in plain text that it runs Claude Code.
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):
  on 2026-06-15 Anthropic paused the separate Agent SDK credit announced in
  May, and "Agent SDK, `claude -p`, and third-party app usage" still draw on
  the plan's limits. On 2026-10-07 Max and Team plans gained monthly API
  credits; use signed in with the plan still draws on the plan.
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products,
  including agents built on the Claude Agent SDK", and an integration must
  not call its agent "Claude Code".
- The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
  section 3.7, forbid automated access except by API key "or where we
  otherwise explicitly permit it".

The February 2026 wording, which named the Agent SDK as a product where plan
sign-in "is not permitted", is no longer on the legal page.

What Tesota does:

- It runs the Claude Code binary bundled with the SDK for the platform,
  unmodified (`claudeCodeExecutable` in `src/auth.ts`), and names itself to
  it with `CLAUDE_AGENT_SDK_CLIENT_APP=tesota`.
- Sign-in completes in Claude Code's own flow. Tesota never reads, copies or
  stores the login, never signs it out, and refuses a plan credential on the
  `anthropic` route.
- Usage draws on the operator's own plan. Tesota pays for and resells
  nothing.

Other local harnesses do the same: t3code's Claude provider drives the Agent
SDK on the user's own Claude Code sign-in, and Anthropic's own announcement
named third-party apps built on the SDK among what a plan covers.

## Decision

Keep the `claude-code` route as built. The operator signs in to the
unmodified Claude Code with their own plan, which the legal page permits;
Tesota offers no login of its own and never holds the credential. The
`anthropic` route, with an API key, stays the route for hosted or shared use.

Keep the route's name. It says in plain text which program the route runs,
as the legal page allows; Tesota's agent is never called Claude Code.

## Consequences

The SDK overview's sentence on "rate limits for their products" remains
open to a reading under which Tesota needs Anthropic's approval. Tesota does
not ask now. Revisit if Anthropic changes these pages, contacts Tesota, or
blocks Agent SDK sign-in with a plan; the `anthropic` route then remains.

Tesota runs several roles on one route, and plan limits assume ordinary
individual use. The guide tells the operator that heavy or unattended use
belongs on an API key.
