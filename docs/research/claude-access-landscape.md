# Claude access landscape (September 2026)

How an agent harness can use Anthropic's Claude models, through an Anthropic
API key or through a person's Claude subscription, what Anthropic permits, and
how other harnesses do it. Researched on 2026-09-25 from Anthropic's
documentation, press coverage, the Claude Agent SDK's published types, and the
source of cloned harnesses. It informs decision 021. Anthropic changed these
rules three times in 2026; recheck before relying on any claim.

## What Anthropic permits

From Claude Code's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance),
read 2026-09-25:

- OAuth sign-in "is intended exclusively for purchasers of Claude Free, Pro,
  Max, Team, and Enterprise subscription plans and is designed to support
  ordinary use of Claude Code and other native Anthropic applications."
- "Anthropic does not permit third-party developers to offer Claude.ai login
  into their own applications, or to route requests through Free, Pro, or Max
  plan credentials on behalf of their users. Moreover, developers may not
  collect, store, or intermediate Claude.ai credentials or session tokens —
  sign-in to a Claude account must complete through Anthropic's own flow."
- It does not "prevent an end user from signing in to the unmodified Claude
  Code binary with their own Claude subscription, including where a platform
  hosts Claude Code." The binary "must be installed and run as published by
  Anthropic", without removing its sign-in methods.
- Developers building products, including with the Agent SDK, "should use API
  key authentication"; configuring one's own API key is not restricted.
- "Advertised usage limits for Pro and Max plans assume ordinary, individual
  usage of Claude Code and the Agent SDK."

Timeline: in January 2026 Anthropic blocked subscription tokens outside its
apps and reversed it; in February it [prohibited third-party harness use in
its terms](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/);
on April 4 it [cut off subscription use by third-party agents such as
OpenClaw](https://venturebeat.com/technology/anthropic-cuts-off-the-ability-to-use-claude-subscriptions-with-openclaw-and);
on May 13 it [reinstated third-party agents through the Agent SDK](https://venturebeat.com/technology/anthropic-reinstates-openclaw-and-third-party-agent-usage-on-claude-subscriptions-with-a-catch),
with a planned separate monthly credit ($20 for Pro); and on June 15 it
[paused that credit](https://thenewstack.io/anthropic-pauses-claude-agent-sdk-subscription-change/).
Anthropic's [help article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
now says: "Claude Agent SDK, `claude -p`, and third-party app usage still draw
from your subscription's usage limits."

## How harnesses do it

| Harness | Route | Consistent with the terms |
| --- | --- | --- |
| Pi (`packages/ai/src/auth/oauth/anthropic.ts`, commit `96724621`) | Its own claude.ai OAuth flow with Claude Code's client id, storing the tokens | No: a third party obtains and stores subscription tokens |
| Hermes Agent (`agent/anthropic_adapter.py`, commit `2a0d0bc6`) | Setup tokens or Claude Code's credential files, sent with Claude Code's identity headers and version | No: reuses Claude Code's credentials and identity |
| OpenClaw | Subscription tokens until April 2026, then the Agent SDK | Only the Agent SDK route |
| Gentle AI (commit `8b52c465`) | Configures the operator's installed Claude Code (skills, hooks, sub-agents); Claude Code signs in itself | Yes |
| Zed ([blog](https://zed.dev/blog/anthropic-subscription-changes), 2026-05-14, updated 2026-06-16) | Runs Anthropic's `claude` program, directly or through the Agent Client Protocol; its own agent uses an API key | Yes |
| Kiln (Sequel `infra/docs/strategy/adr-multi-agent-dev-workflow.md`) | Claude Code itself was the orchestrator | Yes |

## The Claude Agent SDK

Read from `@anthropic-ai/claude-agent-sdk` 0.3.283 (published 2026-09-25),
`sdk.d.ts`:

- `query({ prompt, options })` runs the Claude Code program it bundles for the
  platform (about 234 MB on Windows) and streams messages; the final result
  carries `modelUsage`, per-model token totals, and `total_cost_usd`, "an
  estimate, not a billing statement".
- `tools: []` disables every built-in tool. Custom tools come from an
  in-process MCP server (`createSdkMcpServer`, `tool()` with zod 4 shapes);
  `canUseTool` approves or denies each call; `permissionMode` sets the default.
- `settingSources: []` loads no user, project or local settings, which also
  skips `CLAUDE.md` and hooks; `strictMcpConfig: true` ignores every MCP
  server not passed in; `skills: []` enables none; `persistSession: false`
  keeps no transcript on disk; `systemPrompt` accepts a custom string;
  `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `abortController`, `resume`
  and `cwd` are options.
- Authentication is whatever the Claude Code program uses: the operator's
  subscription after they sign in through Anthropic's own flow, or
  `ANTHROPIC_API_KEY`.
- License: "© Anthropic PBC. All rights reserved. Use is subject to the Legal
  Agreements" above. It is a dependency, not redistributed with Tesota.

## The API route

Pi's `anthropic` provider calls the Messages API with a stored API key
(`ApiKeyCredential`) or `ANTHROPIC_API_KEY`. Its catalogue, read 2026-09-25,
prices Claude Opus 5.5 at $4 in and $20 out per million tokens, Claude Sonnet 5
at $2 and $10, Claude Fable 5.1 at $10 and $50 and Claude Haiku 4.5 at $1 and
$5. The same provider also offers the claude.ai OAuth flow above, which a
harness must not use.

## Patterns

1. **A harness never holds subscription credentials.** Everything consistent
   with the terms either runs Anthropic's own program, which signs in itself,
   or uses an API key.
2. **Identity spoofing is the line.** Pi's and Hermes' subscription routes
   work by presenting themselves as Claude Code.
3. **Both routes draw from the person's own account**: the subscription's
   limits, or the API key's billing.
