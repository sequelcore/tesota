# Continuous SDK task-tool live follow-up — frozen protocol

Frozen on 2026-09-22 before the first live provider inference for this case.
This is one prospective feasibility attempt, not a representative success rate.
The user authorized live provider and Docker testing and delegated task choice.

## Inputs and limits

- Tesota HEAD: `4026ed96d5913eb8d50fe5417a03597e56f8a21b`;
  pre-protocol worktree diff hash: `3f4493084f61ebe0e51e3c524483af22256daf85`.
  The task-tool connection is in that uncommitted diff. Preserve unrelated state.
- Public source: `https://github.com/brmorillo/utils.git` at
  `1ff342b98e1af3f6959af465c3e06afd90f26229`, independently cloned,
  clean before dependency installation. No source commit or reference patch is
  supplied to the task agent.
- Exact task request: “Make `StringUtils.reverse` preserve UTF-16 surrogate
  pairs when reversing, so a string containing emoji reverses by Unicode code
  point; preserve ASCII and empty-string behavior; change only
  `src/services/string.service.ts`.”
- One shell task attempt through the compiled ordinary CLI, with the saved
  Codex login and the fixed `typescript-no-emit/v1` Docker profile. Use the
  existing per-task and session budgets; do not revise the prompt, retry the
  task, switch provider, widen file scope or repair the source baseline after
  observing a result.
- Operator setup may install the committed frozen Bun dependency closure with
  lifecycle scripts disabled. It may not change tracked source files. Record
  exact versions, image identity, source status and profile availability.
- The evaluator-only oracle is [continuous-session-oracle.mjs](continuous-session-oracle.mjs).
  Run it on the baseline before the task (emoji case should fail) and on the
  exact candidate after execution. Do not reveal it to the task agent. A
  passing typecheck is not behavioral acceptance.
- Stop at result review. No assistant decision counts as human acceptance;
  do not apply a candidate without the user's exact-result acceptance.

## Record after attempt

Retain refusal/failure as observed, including proposal scope, approval,
candidate identity and changed files, exact-result-bound checks, oracle result,
remaining unknowns, elapsed time, setup/review burden, available cost data,
and whether acceptance or promotion occurred. Report Windows/Docker-only
scope, not cross-platform or general task support. Sanitize credentials,
provider payloads and local machine paths.

## Setup outcome

The baseline oracle failed the emoji case as expected, with ASCII and empty
behavior still to be checked independently. The repository was clean at the
recorded baseline. Preflight then found that `package.json` declares
`type-check: tsc --noEmit`, while the fixed product profile requires the
literal `typecheck: tsc --noEmit -p tsconfig.json`. This case is ineligible
without an unauthorized tracked configuration edit. No dependency installation,
Docker typecheck, provider inference, proposal, candidate, approval, human
acceptance or application occurred. The separate eligible case is frozen in
[the second protocol](continuous-session-2-2026-09-22.md); it does not replace
this setup refusal.
