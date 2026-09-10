# Scoped candidate task

The first repository task is `pi-decision-status`: correct the outdated status
paragraph in `docs/decisions/002-use-pi.md`. Its existing text says the live
integrations remain open, while retained evidence records successful bounded
experiments. The correction must preserve the rest of the decision and must not
claim a complete repository task cycle.

This increment implements preparation, operation admission and a deterministic
documentation check. It does not yet connect a live model to the task or promote
the result.

## Prepare and inspect

Create an [independent candidate](candidates.md), then use its returned directory:

```sh
bun start task prepare <candidate-directory>
bun start task check <candidate-directory>
```

Preparation requires an unchanged candidate and an applicable baseline document.
It returns the objective, permitted files, required replacement paragraph and
limits, and exclusively saves `task.json` beside the checkout. An existing plan
is never overwritten. The initial check should fail because the stale paragraph
has not been corrected yet.

`task check` exits 0 for the exact correction and 1 for an unmet task assertion.
Invalid arguments, unavailable state or scope violations exit 2. The check
reports its observed source SHA-256 and baseline. Saved plans are strictly parsed
and compared with the baseline files; their provenance remains
`recorded_untrusted`. Editing JSON cannot expand the application's allowed scope.

## Enforced scope

The application-owned contract in `src/candidate-task.ts` permits:

- Reading the Pi decision, roadmap and Codex experiment history.
- Replacing only `docs/decisions/002-use-pi.md` after an initial check, with the
  current content's SHA-256 supplied by the caller.
- Running the task's fixed documentation check.

There are at most eight reads, two replacements and three checks per active
handle. Each file and replacement is bounded to 64 KiB of valid UTF-8. Unknown
fields, unlisted paths, stale hashes, NUL and invalid Unicode are rejected.
The handle closes on an operation failure; concurrent use is rejected. A model
cannot select executable commands, create files, delete files, change permissions
or edit task metadata through this API.

Before operations, the adapter checks the checkout baseline and detects changes
outside the writable file, including untracked and ignored paths. The read-only
context files must retain their baseline hashes. Writable-file changes must
match the handle's last known content. Redirected paths and hard-linked files
are rejected. Replacement is written to an exclusive temporary file outside the
checkout, rechecked against current state, then renamed into the fixed target.

The deterministic check requires the specified status paragraph and preserves
every other document byte. It accepts neither an unrelated rewrite nor a claim
of general agent-task readiness. This documentation task requires no code
execution or test/build command inside the candidate. Broader tasks will need
their own appropriate checks; an Oxlint pass would not verify these prose claims.

## Authority and limits

`PiDecisionTask.prepare` creates an in-memory editing handle selected by trusted
application code. The preparation CLI closes that handle after printing the
plan. Loading `task.json` supports read-only checking; it does not recreate the
handle or reset an execution budget. A future live-task entry point must make
its authorization and attempt lifecycle explicit.

These are task-tool boundaries in a trusted single-writer workspace. They do not
sandbox a hostile same-user process, authenticate stored metadata, or guarantee
atomic observation of the entire filesystem. Failed writes may leave local
temporary state; there is no automatic rollback, task resume or promotion.
An earlier check describes its observed bytes, not later edits. Human acceptance
always remains `not_evaluated`.
