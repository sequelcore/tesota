# Agents

Tesota runs several model sessions for one request, each in a fixed role.
Evidence for the choices below is in the
[delegation landscape](../research/agent-delegation-landscape.md).

## The working agent

The working agent is one Pi session per shell session, started with exactly
Tesota's tools and system prompt: no Pi extensions, skills, prompt templates
or context files are loaded. Its tools are read, grep, find and ls, edit and
write, all confined to the workspace checkout, and bash, which runs in the
session's execution environment ([execution](execution.md)); explorers add
`explore`. Its conversation is saved, so it survives a restart and keeps its
context across requests and correction rounds. It is closed only when its
session closes.

The agent is told not to commit, push or change Git history, and to end each
turn with what it changed and what the operator should verify. It is the only
agent that writes.

## Explorers

With `explore`, the working agent asks a read-only **explorer** one question.
An explorer is a fresh Pi session with only the read-only file tools, confined
to the workspace: no shell, no network, no editing and no `explore` of its
own, so it never asks the operator anything and cannot start further
explorers. It sees the question, never the agent's conversation, and answers
with the files and lines it relied on and what it did not find. The agent is
told to treat the answer as a lead to check, not as fact.

| | Explorer | Reviewer |
| --- | --- | --- |
| Started by | The working agent, during its turn | Tesota, after the work |
| Sees | The agent's question and the checkout | The requests, the evidence and the checkout |
| Output | Advice to the agent | Findings that decide correction and inform the operator |

Explorers are bounded: at most three run at once and eight per request, each
has a five-minute limit and stops with its turn on `Ctrl+C`, and its answer is
cut at a fixed length. An unfinished or empty reply is never presented as an
answer, and the per-request allowance is a proved rule
(`src/verification/explorer-answer.ts`). Each call shows in the conversation
with the explorer's reads as they happen and its time and tokens with its
answer. On Pi's routes each explorer's conversation is saved in the
workspace's `explorers` directory, where the agent cannot reach it; Claude
Code keeps no conversation for a read-only role.

**Explorers are off by default.** On six questions about this repository,
asked twice with and without explorers, both stated all 52 expected facts;
explorers used 2.4 times the tokens and 2.7 times the time. That set does not
measure long sessions whose context fills, which is where explorers are meant
to help. `bun run live:delegation` repeats the comparison.

## Models by role

| Role | Sessions |
| --- | --- |
| `agent` | The working agent |
| `explorer` | Explorers; `off` until a model is chosen, which turns them on for sessions opened afterwards |
| `reviewer` | The reviewer, its lenses and ClaimCheck |
| `refuter` | The refuter |
| `validator` | The fix validator |

Each role uses the model the operator chose in `~/.tesota/models.json`,
written as `route:model`, and `codex:gpt-6-luna`, the cheapest on the Codex
route, when there is no choice. `tesota models` lists each role with its
model, who pays for it and the model's list price, and
`tesota models <role> <route:model>` sets one from the models
the route offers, or `default` to clear it. An unreadable file is an error,
not a silent fallback. A role reads its model when it starts work, and review
measurements record the models so forecasts compare like with like. What the
labs, benchmarks and practitioners say about choosing them is in the
[models by role landscape](../research/model-roles-landscape.md).

## Model routes

A **route** is how Tesota reaches a model and whose account pays for it. Every
role can use any route. Evidence is in the
[Claude access landscape](../research/claude-access-landscape.md).

| Route | Engine | Signed in by | Paid through |
| --- | --- | --- | --- |
| `codex` | Pi | `tesota auth login`: Pi's Codex OAuth, stored by Tesota | The operator's ChatGPT plan, against its limits |
| `anthropic` | Pi | `tesota auth login anthropic`: the operator's Anthropic API key, stored by Tesota, or `ANTHROPIC_API_KEY` | The API key, per token |
| `claude-code` | Claude Code, through the Claude Agent SDK | The operator, in Claude Code itself (`claude`, then `/login`) | Whatever Claude Code is signed in with, usually a Claude plan |

Who pays is the route's (`ROUTE_BILLING`); a model's list price is the
catalogue's. A list price is what an API key is billed, and on a plan only a
way to compare models, so `tesota models` shows both separately.

**Tesota never handles Claude subscription credentials.** On the
`claude-code` route, the unmodified Claude Code program bundled with the Agent
SDK signs in through Anthropic's own flow, and Tesota only starts it. The
credential store accepts nothing but an API key for `anthropic`, so Pi's own
claude.ai login, which presents itself as Claude Code, cannot be used through
Tesota.

### The engine contract

**Every engine holds a role to one contract** (decision 022), owned by
`src/integrations/model-session-contract.ts`. Each clause is checked against
both engines by `tests/model-session-contract.test.ts`, Pi on its scripted
faux model and Claude Code through a double of its SDK, and against the real
engines by the opt-in live suite.

| Clause | Pi | Claude Code |
| --- | --- | --- |
| A session has exactly the tools it was given | Its tool list | Built-in tools disabled, Tesota's tools from an in-process MCP server, and anything else refused |
| A batch in which every tool asks to end the turn ends it, with no further model call | `terminate` on a tool result | A `PostToolBatch` hook answering `continue: false` |
| A request ends `completed`, `failed` with the engine's own message, `cancelled`, or `unsettled` when the engine cannot be stopped | Pi's session events | The SDK's result message |
| Tool activity and replies are reported as they happen | Pi's events | Tesota's tool wrappers and the SDK's messages |
| Tokens are reported as OpenTelemetry's GenAI conventions count them: `input` includes cached input, with cache reads and cache creation as parts of it | Pi's usage, cache added back into input | Claude Code's per-model usage, likewise |

The failure message stays the engine's own, such as Pi's "You have hit your
ChatGPT usage limit": Pi classifies failures only by matching text, so a
Tesota-wide failure kind would copy those patterns, and nothing yet acts on
one.

A Claude Code session also loads none of the operator's Claude Code settings,
`CLAUDE.md`, hooks, skills or MCP servers, so a review is the same whoever
runs it, and runs with Claude Code's nonessential traffic off, which also
removes a background model call. Only the working agent's conversation is
saved, by Claude Code, and resumed on the next request; read-only roles keep
none.

**Time limits sit above each engine's own guards.** A review role's request
stops after ten minutes and an explorer's after five; a request the limit
stopped ends `timed_out`, never `failed` or `cancelled`, and a completed,
failed or unsettled request keeps its outcome. That rule is
`limitedTurnStatus` in `src/verification/turn-time-limit.ts`, proved by
`bun run formal:check`. Within the limit each engine guards its connections
and retries: Pi gives up on a connection that does not open in 15 seconds or
a stream quiet for five minutes and retries three times; Claude Code waits up
to 180 seconds for the first byte and five minutes for a quiet stream, and
retries ten times. Retried stalls can therefore last far longer than one
timer, which is what the limit bounds. The working agent has no limit: the
operator is present, and `Ctrl+C` stops it.

Forecasts and summaries compare token totals, and `live:review` records the
kinds, since a cache read costs a fraction of fresh input.

On `live:review`, Claude Sonnet through `claude-code` reviews as well as
Luna, in about 40 s of review against Luna's 64 to 72 s, and about 1.4 times
Luna's tokens, most of them cache reads. The `anthropic` route has not been
exercised live.

## Why

- **One writer.** Parallel writers fail in every report reviewed: each agent
  makes decisions the others do not know about. Cognition, which argued
  against multi-agent systems in 2025, still keeps writes single-threaded in
  2026 while using separate agents to review and advise.
- **Explorers for context, not more hands.** A fresh context helps
  token-heavy reading; Anthropic measured multi-agent research at about 15
  times the tokens of chat and notes that coding splits into parallel work
  less than research does.
- **Visible and bounded explorers.** Pi's author left sub-agents out of Pi
  because they are invisible and pass context poorly; users of the tools that
  have them ask mostly for visible cost, permissions that never hang, limits
  on depth and fan-out, and timeouts.
- **No shell for explorers.** A command would need the operator's approval
  from inside another agent's turn, which other harnesses found deadlocks or
  hangs.
- **A model per role, chosen by the operator.** Roles need different
  strengths, a refuter on a different model is less likely to share the
  reviewer's blind spots, and the operator bears the cost. Public model
  rankings measure other tasks in other harnesses, so a model is compared with
  `bun run live:review` before it is adopted for a role.
- **Claude through Claude Code, not through its credentials.** Anthropic
  permits a person's subscription in the unmodified Claude Code, including
  when another program runs it, and forbids third parties from collecting or
  relaying subscription tokens. Pi's and Hermes' subscription routes do the
  latter by presenting themselves as Claude Code; Gentle AI and Zed run Claude
  Code instead. The API route is permitted without conditions.
- **Tesota's tools inside Claude Code.** Giving a Claude Code session
  Tesota's tools rather than its own keeps one set of confinement, execution
  and approval rules for every engine, and keeps the operator's personal
  Claude Code setup out of Tesota's reviews.

## Planned

- An advisor, a stronger model the agent consults at hard decisions, once
  real use shows the agent stalling on decisions.
