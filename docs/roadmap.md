# Roadmap

This page owns product status and priority.
[Decision 013](decisions/013-general-agent-loop-first.md) sets the current
direction: build a usable general coding loop first, then put verification
around its result.

## Status

Tesota is pre-release. The terminal shell answers questions about a committed
repository and runs two fixed TypeScript change shapes in an independent
checkout (see [architecture](architecture.md#current-runtime-flow)). It shows
the exact diff and bound checks, then asks for a decision before a guarded
application. Sessions persist locally, up to two operations run at once, and
checks run either in Docker or as trusted host-local processes.

It has finished real tasks only on small, well-shaped repositories, and one
combined-check run took 64 minutes. It cannot create or delete files, run
arbitrary commands, work on uncommitted changes or handle other languages.
[Findings](findings.md) summarizes what has been exercised.

## Next

### 1. General coding loop

- Run a Pi coding agent in an independent checkout with read, write, create,
  delete and command tools. Commands need operator approval.
- When the agent finishes, show the final diff, run the selected repository
  checks on that exact result, and ask to accept or reject. Keep guarded
  application.
- Remove the fixed task shapes, proposal admission and per-shape check
  selection in the same change.
- **Done when:** Tesota is used for its own day-to-day changes, including
  new files, on Windows.

### 2. Everyday usability

Fix what daily use surfaces first. Known gaps: CRLF conversion in candidate
checkouts, a trusted repository's own check commands, working on uncommitted
changes, and one non-TypeScript repository.

### 3. Verification and review as options

Let users pick checks and reviewers per repository, starting with the
existing TypeScript, Node test, Oxlint and Gentle integrations. A missing or
failed check never reads as a pass.

### Later

Non-code tasks, a native OS sandbox on Windows (see
[decision 007](decisions/007-execution-environments.md)), other platforms, and
user-supplied verification methods, chosen by observed need.

## Rules

- Keep the user's request visible; an agent cannot quietly weaken it to make a
  check pass.
- Missing checks, timeouts and unconfirmed effects are never reported as
  success.
- Keep permission, check evidence, review, acceptance and application
  separate.
- Keep one owner per behavior and add abstractions only for real consumers.
- There are no external consumers. Remove obsolete code instead of keeping
  compatibility layers.
