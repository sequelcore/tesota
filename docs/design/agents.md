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
route, when there is no choice. `tesota models` lists each role with its model
and price, and `tesota models <role> <route:model>` sets one from the models
the route offers, or `default` to clear it. An unreadable file is an error,
not a silent fallback. A role reads its model when it starts work, and review
measurements record the models so forecasts compare like with like.

## Model routes

A **route** is how Tesota reaches a model and whose account pays for it. Every
role can use any route. Evidence is in the
[Claude access landscape](../research/claude-access-landscape.md).

| Route | Engine | Signed in by | Paid through |
| --- | --- | --- | --- |
| `codex` | Pi | `tesota auth login`: Pi's Codex OAuth, stored by Tesota | The operator's ChatGPT plan |
| `anthropic` | Pi | `tesota auth login anthropic`: the operator's Anthropic API key, stored by Tesota, or `ANTHROPIC_API_KEY` | The API key's account |
| `claude-code` | Claude Code, through the Claude Agent SDK | The operator, in Claude Code itself (`claude`, then `/login`) | The operator's Claude plan limits, or the key Claude Code itself uses |

**Tesota never handles Claude subscription credentials.** On the
`claude-code` route, the unmodified Claude Code program bundled with the Agent
SDK signs in through Anthropic's own flow, and Tesota only starts it. The
credential store accepts nothing but an API key for `anthropic`, so Pi's own
claude.ai login, which presents itself as Claude Code, cannot be used through
Tesota.

**Roles work the same on either engine.** A role's session is started through
one interface with the role's system prompt and tools, and returns the same
results, activity and token counts. A Claude Code session runs with every
built-in tool disabled and receives Tesota's own tools, the confined file
tools, the execution environment's shell with its approvals, and each role's
submission tool, from an in-process MCP server; a call to anything else is
refused. It loads none of the operator's Claude Code settings, `CLAUDE.md`,
hooks, skills or MCP servers, so a review is the same whoever runs it. Only
the working agent's conversation is saved, by Claude Code, and resumed on the
next request; read-only roles keep none.

On `live:review`, Claude Sonnet through `claude-code` reviewed as well as
Luna, at the same speed and about 2.7 times the tokens, most of it a fixed
cost of each Claude Code session. The `anthropic` route has not been
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
