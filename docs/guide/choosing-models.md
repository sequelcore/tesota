# Choosing models

Tesota runs a model in each of six roles, and you choose each one. This page
shows the setups that fit the accounts you have, the principles behind them,
and how to check a choice. Signing in to each route is in
[authentication](authentication.md).

## Roles and routes

| Role | What it does | How much it uses |
| --- | --- | --- |
| `agent` | Changes the workspace for your requests | Most: every request, every correction round |
| `explorer` | Answers the agent's questions about the repository, read-only | Off by default |
| `advisor` | Reads the agent's conversation and advises it at hard decisions; no tools | Off by default; at most three short consults a request |
| `reviewer` | Reviews each result, with focused lenses on deep reviews and ClaimCheck on proved contracts | One to four sessions per result |
| `refuter` | Tries to disprove every finding before it counts | One session per review |
| `validator` | Checks whether a correction resolved what was sent back | One session per correction round |

A choice is written `route:model`. The route decides who pays:

| Route | Paid through |
| --- | --- |
| `codex` | Your ChatGPT plan, against its limits |
| `claude-code` | Whatever your Claude Code is signed in with, usually your Claude plan's limits |
| `anthropic` | Your Anthropic API key, per token |

## Setups

**Only a ChatGPT plan.** Keep the defaults: every role on `codex:gpt-6-luna`,
the cheapest model, which as reviewer found as many planted defects as larger
models in Tesota's evaluations. For harder work give the agent
`codex:gpt-6-sol`, and the refuter `codex:gpt-6-sol` too.

**A ChatGPT plan and a Claude plan.** Put the agent on Claude and review on
Codex, so the model that reviews is not the one that wrote:

```
tesota models agent claude-code:opus
tesota models reviewer codex:gpt-6-astra
tesota models refuter codex:gpt-6-sol
tesota models validator codex:gpt-6-luna
```

In Tesota's evaluations this reviewer and refuter found every planted
defect with no false positive, in about two minutes and 120k tokens per run
of eight cases. This spends your Claude plan only on the agent. Opus writes more tokens than
the other models, so watch your Claude usage the first days; if it runs low,
`tesota models agent codex:gpt-6-sol` keeps you working and leaves review as
it is.

**The same, lighter on the Claude plan.** Keep the agent on Codex and review
with Claude, which also keeps the reviewer from another family:

```
tesota models agent codex:gpt-6-sol
tesota models reviewer claude-code:sonnet
tesota models refuter codex:gpt-6-sol
```

**An Anthropic API key.** The same setups work with `anthropic:` models, such
as `anthropic:claude-opus-5-5`, billed per token to the key.

`tesota models` shows each role's model, who pays for it and the model's list
price; `tesota models <role> default` restores Luna, and a new choice applies
to sessions opened afterwards.

## Why these setups

- **The agent is where the budget goes.** It works on every request and
  correction, so give it the model you trust most with the plan that has the
  most room. Opus 5.5 broke fewer working tests than GPT-6 Sol in a
  practitioner's comparison on real changes, at more tokens; Tesota's checks,
  review and correction catch much of what a cheaper agent gets wrong.
- **Review with a different model family than the agent.** Anthropic's own
  guidance separates the writer from the reviewer, and models tend to favor
  their own output when they judge it. Tesota's reviewer only reports
  findings and the refuter tests them, so a reviewer from another family
  cannot rewrite the agent's work.
- **Keep judges off their author's model.** `tesota models` warns when a
  role judges output from its own model, and notes when it is from the same
  lab. With two labs some pair shares one; prefer the refuter in the
  reviewer's lab rather than the agent's, so a bias keeps findings for you to
  see instead of dismissing real defects.
- **Give the refuter a stronger model than the cheapest.** In Tesota's
  evaluations Luna as refuter once dismissed a real defect; Sol and Astra did
  not.
- **Keep explorers off** unless long sessions on a large repository show the
  agent losing track; on shorter questions they only added cost.
- **An advisor pays off when it is stronger than the agent.** Anthropic
  measured a cheaper agent with an Opus advisor coming close to the stronger
  model at lower cost, and the benefit shrinking as the agent approaches the
  advisor. With Opus 5.5 as agent, try GPT-6 Astra or Claude Fable as advisor,
  a different lab as Amp pairs them; with a cheap agent, Opus 5.5. Stronger
  agents consult less on their own, so ask for it in a request ("consult the
  advisor before you edit") when you want a second opinion.

Tesota's evaluation cases are small, and every reviewer model found all of
their planted defects; outside benchmarks favor GPT-6 Astra on harder,
cross-file bugs. The sources and their limits are in the
[models by role research](../research/model-roles-landscape.md), and Tesota's
own measurements in [findings](../findings.md).

## Checking a choice

Each review shows the time and tokens it took, and the forecast before a deep
review uses reviews with the same models. To compare models on Tesota's
evaluation cases before adopting them:

```
bun run live:review --skip-corrections --model-reviewer=codex:gpt-6-astra --model-refuter=codex:gpt-6-sol
```

It uses your sign-ins and some of your plans' usage, and writes one record
under `live-runs/`.
