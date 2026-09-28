# Choosing models

Tesota runs a model in each of eight roles, and you choose each one. This page
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
| `triage` | Decides whether an answer with no file changes needs the full check | One short session per such turn, or one Jev decision; `off` checks every answer in full |
| `namer` | Writes a short title for each new session | One short session per new session, at low reasoning by default; `off` keeps the first request as the name |

A choice is written `route:model`, optionally with a reasoning level:
`codex:gpt-6-astra@high`. Levels are `low`, `medium`, `high`, `xhigh` and
`max`, where the model accepts them; without one, Pi's models reason at
medium and Claude Code's at their default. Higher levels spend more of your
plan's limits. The route decides who pays:

| Route | Paid through |
| --- | --- |
| `codex` | Your ChatGPT plan, against its limits |
| `claude-code` | Whatever your Claude Code is signed in with, usually your Claude plan's limits |
| `anthropic` | Your Anthropic API key, per token |
| `openrouter` | Your OpenRouter credits, per token; `:free` models cost nothing |
| `opencode` | Your OpenCode Zen balance, per token |
| `opencode-go` | Your OpenCode Go subscription, against its limits |

## Setups

**Only a ChatGPT plan.** Keep the defaults: every role on `codex:gpt-6-luna`,
the cheapest model, which as reviewer found as many planted defects as larger
models in Tesota's evaluations. For harder work give the agent
`codex:gpt-6-sol`, and the refuter `codex:gpt-6-sol` too.

**A ChatGPT plan and a Claude plan.** Put the agent on Claude and review on
Codex, so the model that reviews is not the one that wrote:

```
tesota roles agent claude-code:opus
tesota roles reviewer codex:gpt-6-astra
tesota roles refuter codex:gpt-6-sol
tesota roles validator codex:gpt-6-luna
```

In Tesota's evaluations this reviewer and refuter found every planted
defect with no false positive, in about two minutes and 120k tokens per run
of eight cases. This spends your Claude plan only on the agent. Opus writes more tokens than
the other models, so watch your Claude usage the first days; if it runs low,
`tesota roles agent codex:gpt-6-sol` keeps you working and leaves review as
it is.

**The same, lighter on the Claude plan.** Keep the agent on Codex and review
with Claude, which also keeps the reviewer from another family:

```
tesota roles agent codex:gpt-6-sol
tesota roles reviewer claude-code:sonnet
tesota roles refuter codex:gpt-6-sol
```

**An Anthropic API key.** The same setups work with `anthropic:` models, such
as `anthropic:claude-opus-5-5`, billed per token to the key.

**No plan and no money: OpenRouter's free models.** They are the only way to
use Tesota at no cost. Sign in with `tesota auth login openrouter`, then move
every role off the default, which needs a ChatGPT plan, and keep the judges
in another lab than the agent:

```
tesota roles agent openrouter:poolside/laguna-s-2.1:free
tesota roles reviewer openrouter:nvidia/nemotron-3-super-120b-a12b:free
tesota roles refuter openrouter:nvidia/nemotron-3-super-120b-a12b:free
tesota roles validator openrouter:nvidia/nemotron-3-super-120b-a12b:free
tesota roles triage openrouter:nvidia/nemotron-3-super-120b-a12b:free
tesota roles namer openrouter:nvidia/nemotron-3-super-120b-a12b:free
```

On Tesota's review evaluation, Nemotron as reviewer and refuter found every
planted defect with no false positive and refuted every planted false
claim, as the paid models do; as validator it left two of five findings open
after a real fix, where the paid models resolved every real fix. That is
one run. Laguna S read a file and answered correctly through Tesota's tools,
but has not been measured as the agent; `openrouter:cohere/north-mini-code:free`
also answered, if Laguna is unavailable.

Free models come and go. A free model can be refused for a while when its
shared provider is busy ("temporarily rate-limited upstream"), as Qwen and
Gemma were, a purchase does not change that, and some are offered only to
coding agents listed in OpenRouter's app directory, which Tesota is not. If
one keeps failing, choose another from `tesota models openrouter`. A free
model's provider may keep your code and train on it, so use them for code
you would share. OpenRouter allows 50 free requests a day until you buy $10
of credit, then 1,000, counted per account across all its keys; the
evaluation above and the trials around it used 120. The $10 also pays for OpenRouter's
paid models.

**OpenRouter credits or OpenCode.** Both reach many labs' models, so the agent
and its judges can come from different labs on one account.
`tesota models openrouter`, `tesota models opencode` and
`tesota models opencode-go` list the models and prices; OpenRouter writes a
model `vendor/model`, as in `openrouter:anthropic/claude-opus-5.5`. OpenCode
Zen bills your Zen balance, and OpenCode Go, at $10 a month, needs an active
subscription; Zen's free models work only in OpenCode's own app. Tesota has
not yet measured these routes' models as its roles, so check a choice
(below) before relying on it.

**A TypeSafe key: Jev for the first pass.** The `triage` role can use Jev,
TypeSafe's typed decision model, which decides in about a tenth of a second
where a model session takes about two, and costs about 340 tokens a
decision. It made no wrong decision on Tesota's 20 registered cases. Save
your key from [console.typesafe.ai](https://console.typesafe.ai) and choose
it:

```
tesota auth login typesafe
tesota roles triage typesafe:jev-1.13.0
```

TypeSafe receives the requests and the agent's reply of each turn that
changed no files; it says it does not train on them, and states no retention
period. Without a key, or when TypeSafe does not answer, every such answer
gets the full check. Only the `triage` role can use Jev.

`tesota roles` shows each role's model, who pays for it and the model's list
price; `tesota roles <role> default` restores that role's built-in choice. In a session, `/roles`
does the same: choose a role, then its model. The reviewer, refuter,
validator and first pass use a new choice from their next check; the agent's
applies to new sessions, and `/model` switches the current session's.

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
- **Raise a reasoning level only where it shows.** OpenAI recommends high
  effort for agentic coding and extra-high for code review; Anthropic asks
  for a sweep on your own work. On Tesota's review cases Astra found the same
  defects at high as at medium, so the defaults stand until harder cases or
  real sessions show a gain.
- **Keep judges off their author's model.** `tesota roles` warns when a
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
