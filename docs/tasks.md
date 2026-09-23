# Approved tasks

This is the technical contract for the current task runtime. In normal use,
Tesota Shell composes these stages without asking the user to operate proposal
or candidate IDs. See [using Tesota](using-tesota.md) for the product workflow.

Tesota has one task lifecycle. A model may propose work, but only proposal
admission and explicit operator approval can issue an execution grant.

```text
request -> read-only proposal -> admission -> operator approval
        -> isolated candidate -> scope + admitted contained check -> human review
        -> accept/reject, or one approved semantic correction
        -> fresh checks + fresh review -> final decision -> guarded promotion
```

There is no application task registry and no special task for modifying Tesota.
The implementation accepts the original `typescript-change` kind and a separate
`typescript-source-test-change` kind. The latter is an integrated development
increment, not yet qualified as a representative external workflow.

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

The source-and-test variant approves exactly one existing non-test `.ts` source
file and one existing `tests/**/*.test.ts` file. Its exact paths are in the
immutable grant; the source file need not live below `src/`. Scripts, check
configuration, dependencies, file creation and arbitrary commands remain
denied. It permits up to 12 reads, six replacements and six checks across R0
and R1, with the same 64 KiB file bound and five-minute cumulative active-time
limit. Source-only plans use version 2; source-and-test plans use version 3.

For this variant, the model first checks the unchanged candidate, changes the
regression test and checks that it fails on the original source, then repairs
the source and checks the final candidate. The fixed `node-test-targeted/v1`
invocation runs the approved test under Node's test runner inside the pinned,
read-only, network-disabled Docker container. It does not execute the
repository's test script, typecheck the project or prove full-suite behavior.
Empty, skipped, TODO and incoherent test reports cannot pass. The exact final
source and test bytes are checked again at review and conflict-checked before
promotion. A later semantic correction uses only the remaining cumulative
budget and requires fresh evidence.

The complete model-and-check session has a five-minute cumulative deadline.
Individual container checks retain their separate 60-second TypeScript or
30-second Node-test execution limits;
dependency binding and snapshot preparation occur inside the cumulative task
window.
Those limits are task-wide across the initial R0 execution and the optional R1
semantic revision. The optional R1 uses a fresh Pi agent with only the remaining model, tool,
read, edit, check and active-time budget; attempted consequential work is not
refunded after cancellation or uncertain settlement.

The persisted plan binds the approved proposal, committed baseline,
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

## What the automatic checks prove

`scope-integrity` establishes that admitted content changed and that the
candidate contains no unsupported path or change type. The source-and-test
variant requires both approved files to differ by its final passing check.
For the source-only variant, once content changes,
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
operator approves it, Tesota creates a fresh candidate and runs the bounded R0
task through the same in-memory Pi SDK conversation as discovery in Tesota Shell.
The lower-level task command retains its one-shot agent. Passing current scope
and selected check evidence exposes the exact diff for an
accept, reject or request-one-correction choice. A correction requires bounded
user refinement and separate approval, keeps the same candidate, repository,
baseline, paths, tools and profiles, and uses a fresh disposable Pi agent. It
does not create `decision.json`; only the final R1 accept/reject choice does.
The live correction authority revalidates the exact R0 review, retained attempt
and diff, current candidate/task/source/check inputs, and absence of a final
decision immediately before it creates R1 authority and dispatches provider work.
The review fingerprint binds the complete check
evidence as well as the candidate bytes, so changed verifier inputs make a prior
decision stale. R1 extends that identity with its effective semantic criteria,
exact R0 parent and revision identity, so even unchanged bytes require a fresh
review and decision. Before the decision, the shell lists the exact changed files,
states the separate scope-integrity and applicable verifier claims, names the behavioral
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
`attempt-r1.jsonl` and `candidate-r1.diff`. The revision binds the digest of
the complete retained R0 attempt, and review accepts an R1 pass only when both
attempt files are bounded regular single-link files with complete, ordered,
internally consistent records for that exact R0-to-R1 lineage. Review compares
R1 cumulative model invocations, tool calls and active time with the parsed,
digest-bound R0 session. R1 must account for at least the invocation requesting
its checks and a later invocation receiving their results, and one tool call
per retained edit/check. Multiple tools may share a model response; no fixed
transcript or preceding read is required. Active time may stay equal because
the producer rounds phase milliseconds and caps cumulative time. Phase-local
edits and checks must together fit the existing task-wide ceilings. The attempt
format does not retain read counts or tool ordering, so these checks establish
lower bounds, not complete reconstruction of resource use.
A generation-bound in-memory
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

Tesota does not admit general test edits, create/delete/rename effects,
arbitrary task manifests, repository scripts, dependency changes or automatic
acceptance. The new Node test route is limited to one approved existing test;
broader source work requires qualified check profiles and explicit effect
contracts. The [roadmap](roadmap.md) owns that expansion.
