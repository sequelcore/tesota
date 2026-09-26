# 020: Choose a model for each role

Status: adopted 2026-09-25. Serves [decision 019](019-read-only-explorers.md)
and the review of [decisions 016](016-review-precision.md) and
[018](018-verified-origin-and-review-forecast.md). Evidence is in the
[agent delegation landscape](../references/agent-delegation-landscape.md).

## Context

Tesota used one model, GPT-6 Luna, for everything: the working agent, the
reviewers, the refuter and the fix validator. The roles differ in what they
need. The agent writes and decides; explorers only read and summarize, and the
most repeated request in the sub-agent issue trackers of Claude Code, Codex,
opencode and Pi is to give them a cheaper model; reviewers judge, and a
refuter on a different model is less likely to share the reviewer's blind
spots, as Refute-or-Promote argues. The Codex route offers eight models whose
catalogue prices run from $0.10 to $10 per million input tokens. Public
comparisons of these models are anecdotes, often judged by other models in a
different harness, so a choice for Tesota has to be measured in Tesota.

## Decision

- Tesota has five roles: the working **agent**; **explorers**; the
  **reviewer**, which also covers focused lenses and ClaimCheck; the
  **refuter**; and the fix **validator**.
- Each role uses the model the operator chose in `~/.tesota/models.json`, and
  GPT-6 Luna when there is no choice, so nothing changes until the operator
  chooses. The file lives in Tesota's own directory, never in a repository.
- `tesota models` lists each role's model with its catalogue price, and
  `tesota models <role> <model>` chooses one from the models the Codex route
  offers, or `default` to clear it. An unreadable file is an error, not a
  silent fallback.
- A role reads its model when it starts work, so a new choice applies from
  the next turn or review.
- Review measurements record the reviewer, refuter and validator models, and
  forecasts compare only reviews made with the same models; measurements
  from before this decision count as the default model.
- `bun run live:review` takes `--model-reviewer=`, `--model-refuter=` and
  `--model-validator=` and records the models it ran, so a model is compared
  on the evaluation set before the operator adopts it for a role.

## Consequences

- A stronger model for a role costs more of the subscription's limits;
  forecasts and review summaries show that cost.
- Findings from different reviewer models are not comparable in the forecast
  history, which starts again for each combination.

## Rejected alternatives

- **A model per repository.** The choice concerns the operator's
  subscription and trust in a model, not a repository.
- **Letting the agent choose an explorer's model.** The operator bears the cost,
  so the operator chooses.
- **Choosing from public rankings.** They measure other tasks, often with
  model judges, in other harnesses.
