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

## Deliberate omissions

Tesota does not currently admit source-code edits, create/delete/rename effects,
arbitrary task manifests, repository scripts, dependency changes or automatic
acceptance. Those capabilities require qualified check profiles and explicit
effect contracts. The [roadmap](roadmap.md) owns that expansion.
