# Approved tasks

Tesota has one task lifecycle. A model may propose work, but only proposal
admission and explicit operator approval can issue an execution grant.

```text
request -> read-only proposal -> admission -> operator approval
        -> isolated candidate -> scope check -> human review
        -> decision -> guarded promotion
```

There is no application task registry and no special task for modifying Tesota.
The current implementation accepts one deliberately narrow task kind:
`documentation-change`.

## Current contract

An admitted documentation change:

- writes one or two existing Markdown files below `docs/`;
- reads at most eight admitted repository files;
- permits at most two whole-file replacements and three checks;
- limits every exposed or replacement file to 64 KiB of valid UTF-8;
- runs no repository command and gives the model no shell or network tool;
- requires an initial check before the first replacement; and
- remains subject to human review before promotion.

The persisted plan binds the approved proposal, committed baseline, read-input
hashes, write set, limits and task definition. Reloading that plan can recheck a
candidate, but cannot recreate editing authority.

## What the automatic check proves

`scope-integrity` establishes that at least one admitted file changed and that
the candidate contains no unsupported path or change type. It does not establish
that prose is accurate, useful or complete. The emitted diagnostic says so, and
the task outcome is always `human_review_required`.

This distinction is intentional:

- model completion is not check evidence;
- check evidence is not human acceptance; and
- acceptance is not promotion.

## Review and promotion

`task start <proposal-id>` presents the admitted scope before execution. If the
operator approves it, Tesota creates a fresh candidate and runs the bounded Pi
task. A passing scope check exposes the exact diff for an accept or reject
decision. Promotion applies only the accepted write set when the source `HEAD`,
target bytes and review identity still match.

The lower-level `task review`, `task decide` and `task promote` commands expose
the same boundaries for diagnosis. They do not bypass proposal admission.

## Outcome accounting

Every attempt to start an admitted proposal creates one `start.jsonl` outcome journal
before asking for scope approval. Declining or cancelling is therefore retained
alongside successful, failed, rejected and promoted paths. The exact proposal
cannot be replayed after any such attempt.

The journal owns the task-level chronology and references the candidate and
review fingerprint. Candidate checks, the operator decision and promotion
receipt keep their existing owners. Recovery rejects malformed records,
impossible transitions, regressing timestamps and mismatched review
fingerprints.

The current execution producer reports elapsed milliseconds, first-check
status, correction attempts, model invocations, tool calls and edits. It does
not yet observe token usage or monetary cost, so both remain explicitly
unavailable instead of being estimated. `tesota task outcome <proposal-id>`
reloads the durable summary; Tesota Shell prints the same summary when a task
reaches a recorded terminal outcome.

`tesota task outcomes` derives a newest-first cohort view from those same
journals. It omits proposals that were never attempted and keeps an invalid or
unreadable started journal visible as `unavailable`. The projection contains no
request text or source path and owns no state of its own.

Outcome records have `authority: none`. They describe what was observed and
never authorize execution, acceptance or promotion.

## Prospective pilot

The first outcome pilot uses 8–12 consecutively selected, ordinary requests
that fit the supported documentation contract. Select each request before
seeing its result; do not replace an inconvenient request with an easier one.
Refusal, scope decline, cancellation, execution failure, rejection, promotion
and unavailable recovery all remain in the cohort.

For each request, use the normal proposal and start flow. Inspect the aggregate
with `tesota task outcomes` and the bound detail with
`tesota task outcome <proposal-id>`. At closeout, report counts and concrete
failure causes, including operator intervention and unavailable consumption.
This small pilot is product-learning evidence, not a benchmark or a reliability
percentage. Raw local journals remain operator state; do not copy task
transcripts into the repository merely to manufacture durable evidence.

## Deliberate omissions

Tesota does not currently admit source-code edits, create/delete/rename effects,
arbitrary task manifests, repository scripts, dependency changes or automatic
acceptance. Those capabilities require qualified check profiles and explicit
effect contracts. The [roadmap](roadmap.md) owns that expansion.
