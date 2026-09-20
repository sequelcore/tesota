# Approved tasks

This is the technical contract for the current task runtime. In normal use,
Tesota Shell composes these stages without asking the user to operate proposal
or candidate IDs. See [using Tesota](using-tesota.md) for the product workflow.

Tesota has one task lifecycle. A model may propose work, but only proposal
admission and explicit operator approval can issue an execution grant.

```text
request -> read-only proposal -> admission -> operator approval
        -> isolated candidate -> scope + contained typecheck -> human review
        -> accept/reject, or one approved semantic correction
        -> fresh checks + fresh review -> final decision -> guarded promotion
```

There is no application task registry and no special task for modifying Tesota.
The current implementation accepts one deliberately narrow task kind:
`typescript-change`.

## Current contract

An admitted TypeScript change:

- writes one or two existing non-test, non-declaration `.ts` files below `src/`;
- reads at most eight admitted repository files;
- permits at most two whole-file replacements and three checks;
- limits every exposed or replacement file to 64 KiB of valid UTF-8;
- gives the model no shell or network tool and never accepts its choice of command;
- runs only the fixed `typescript-no-emit/v1` profile in the pinned, read-only,
  network-disabled container after an admitted file changes;
- denies repository check configuration, dependency declaration, test and file-lifecycle changes;
- rejects `@ts-ignore`, `@ts-nocheck` and `@ts-expect-error` in changed files so source-level suppression cannot manufacture a pass;
- requires an initial check before the first replacement; and
- remains subject to human review before promotion.

The complete model-and-check session has a five-minute cumulative deadline.
Individual container checks retain their separate 60-second execution limit;
dependency binding and snapshot preparation occur inside the cumulative task
window.
Those limits are task-wide across the initial R0 execution and the optional R1
semantic revision. A fresh Pi agent receives only the remaining model, tool,
read, edit, check and active-time budget; attempted consequential work is not
refunded after cancellation or uncertain settlement.

The version-2 persisted plan binds the approved proposal, committed baseline,
initial candidate read-input hashes, exact source-target hashes and modes,
write set, limits and task definition. Reloading that plan can recheck a
candidate, but cannot recreate editing authority.

Git's [text and end-of-line attributes](https://git-scm.com/docs/gitattributes)
can give a worktree different bytes from its committed blob. Before editing,
Tesota admits either the exact blob bytes or the uniform CRLF representation
of an LF-only UTF-8 text blob. This bounded rule also applies to the initial
candidate inputs, including checkouts affected by `eol=crlf`. Mixed or other
transformed representations are not inferred. No Git filters are executed.

The original source bytes remain a distinct observation: after capture, even
an LF/CRLF-only change is source drift. Their hashes and modes participate in
the task definition and check evidence, so rebinding them invalidates the
review fingerprint. Candidate replacements are applied exactly as reviewed;
promotion does not convert their line endings.

Version-1 plans remain inspectable and checkable, but their missing source
observations are never reconstructed from the present worktree. They cannot
receive a new acceptance or be promoted. A fresh approved task is required.

## What the automatic checks prove

`scope-integrity` establishes that at least one admitted file changed and that
the candidate contains no unsupported path or change type. Once content changes,
`typescript-no-emit/v1` establishes that the exact bound candidate passed the
repository's fixed no-emit TypeScript compilation under the recorded toolchain
and isolation inputs. Compiler findings remain check failures; timeout,
cancellation, unavailability and uncertain settlement close the task as
operational failures instead of appearing as findings or success.

Neither check establishes that requirements were understood or that behavior is
correct. The task outcome is always `human_review_required`.

This distinction is intentional:

- model completion is not check evidence;
- check evidence is not human acceptance; and
- acceptance is not promotion.

## Review and promotion

`task start <proposal-id>` presents the admitted scope before execution. If the
operator approves it, Tesota creates a fresh candidate and runs the bounded Pi
task. Passing current scope and typecheck evidence exposes the exact diff for an
accept, reject or request-one-correction choice. A correction requires bounded
user refinement and separate approval, keeps the same candidate, repository,
baseline, paths, tools and profiles, and uses a fresh disposable Pi agent. It
does not create `decision.json`; only the final R1 accept/reject choice does.
The review fingerprint binds the complete check
evidence as well as the candidate bytes, so changed verifier inputs make a prior
decision stale. R1 extends that identity with its effective semantic criteria,
exact R0 parent and revision identity, so even unchanged bytes require a fresh
review and decision. Before the decision, the shell lists the exact changed files,
states the separate scope-integrity and TypeScript claims, names the behavioral
and integration unknowns, and reports that application has not occurred.
Promotion applies only the accepted write set when the source revision checks,
captured target bytes and modes, and review identity still match. The terminal outcome reports application
as applied, not applied or unconfirmed without changing the durable outcome
schema.

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

`semantic-revision.json` is the bounded, single-use, authority-free R1 fact.
The original `attempt.jsonl` and `candidate.diff` remain immutable; R1 uses
`attempt-r1.jsonl` and `candidate-r1.diff`. A generation-bound in-memory
capability is the only execution authority. Persisted plans, attempts, revision
facts and reviews cannot recreate it, and any unconfirmed callback settlement
permanently blocks R1.

The current execution producer reports elapsed milliseconds, first-check
status, explicit execution causes, model invocations, tool calls, repository
reads, edits, model-loop checks, active execution time and host-side final,
review, decision and promotion checks. Host checks are observable accounting,
not a new product ceiling. It does not yet observe token usage or monetary
cost, so both remain explicitly unavailable instead of being estimated. `tesota task outcome <proposal-id>`
reloads the durable summary; Tesota Shell prints the same summary when a task
reaches a recorded terminal outcome.

Outcome records have `authority: none`. They describe what was observed and
never authorize execution, acceptance or promotion.

## Deliberate omissions

Tesota does not currently admit test edits, create/delete/rename effects,
arbitrary task manifests, repository scripts, dependency changes or automatic
acceptance. Broader source work requires qualified check profiles and explicit
effect contracts. The [roadmap](roadmap.md) owns that expansion.
