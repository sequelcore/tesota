# The claude-code route under Anthropic's terms

Status: Accepted on 2026-10-08, re-read on 2026-10-22 for
[issue #546](https://github.com/sequelcore/tesota/issues/546). This is not a
legal determination.

## Context

The `claude-code` provider runs Claude Code through
`@anthropic-ai/claude-agent-sdk`, signed in with the operator's own Claude
plan (`packages/core/src/providers/claude-code.ts`). Tesota must not be
published on a route whose terms it has not read.

What Anthropic published, read on 2026-10-22:

- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  "Authentication and credential use": developers building on the Agent SDK
  "should use API key authentication". "Anthropic does not permit
  third-party developers to offer Claude.ai login into their own
  applications, or to route requests through Free, Pro, or Max plan
  credentials on behalf of their users. Moreover, developers may not
  collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow."
  This does not "prevent an end user from signing in to the unmodified
  Claude Code binary with their own Claude subscription". Plan limits
  "assume ordinary, individual usage of Claude Code and the Agent SDK".
- The same page, "Can customers offer Claude Code in their products?", new
  since 2026-10-08: "preinstalling or running Claude Code in your products
  or services … requires agreeing to our Commercial Terms of Service" and:
  - "The Claude Code binary must not be modified. … customers may not
    remove, disable, or restrict any authentication method built into it."
  - "Customers may not pay for, resell, or intermediate Claude usage on
    their end users' behalf. Each end user must authenticate with their own
    Anthropic API key, Claude subscription plan credentials, or 3P inference
    provider credential."
  - A product "can accurately say, in plain text, that [it] … runs Claude
    Code", but may not use the name "as part of your own product, feature,
    or company name".
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
  2026-10-07: "You can still use the Claude Agent SDK, `claude -p`, and
  third-party apps with your subscription limits."
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  "Unless previously approved, Anthropic does not allow third party
  developers to offer claude.ai login or rate limits for their products".

What Tesota does:

- It runs Claude Code unmodified: from source, the program the SDK
  installs for the platform; from a release binary, which bundles no
  Claude Code, the operator's own installed `claude`
  ([#570](https://github.com/sequelcore/tesota/issues/570)). It names
  itself to it with `CLAUDE_AGENT_SDK_CLIENT_APP=tesota`.
  It turns off Claude Code's built-in tools, settings, auto-compaction and
  nonessential traffic, and no authentication method.
- Sign-in completes in Claude Code's own flow (`claude`, then `/login`).
  Tesota offers no Claude login: its `anthropic` provider takes an
  Anthropic API key alone, without pi-ai's Claude Pro/Max sign-in, and
  refuses a Claude plan's token from `ANTHROPIC_OAUTH_TOKEN` or entered as
  a key. It never reads, copies or stores the Claude Code credential: it
  asks `claude auth status` only whether Claude Code is
  signed in.
- Each operator signs in with their own plan, and usage draws on it.
  Tesota pays for, resells and intermediates nothing.
- The provider is named for the program it runs, in plain text; Tesota's
  agent is never called Claude Code.

## Decision

Keep the `claude-code` route: the operator signs in to the unmodified Claude
Code with their own plan, which the legal page permits. The `anthropic`
route, with an API key, stays the route for shared or heavy use.

## Consequences

- The section on running Claude Code in a product requires the Commercial
  Terms. Sequel accepted them through its Anthropic Console account
  (confirmed 2026-10-22).
- The legal page says developers building on the Agent SDK "should use API
  key authentication", and the SDK overview's sentence on "rate limits for
  their products" remains open to a reading under which Tesota needs
  Anthropic's approval. Tesota does not ask now.
- Revisit when Anthropic changes these pages, contacts Tesota, or blocks
  plan sign-in through the SDK: the provider is then removed, and the
  `anthropic` route remains.
