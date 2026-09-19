# Roadmap

This document is the sole owner of Tesota's current product status and
priorities. The roadmap advances user capabilities; internal mechanisms and
qualification work are subordinate to those outcomes.

Tesota's next proof is ordinary usefulness: a person opens the agent, describes
worthwhile work and reaches an inspectable result without learning the internal
lifecycle. Software development is the first proving ground, not the permanent
product boundary.

Broad, real coding capability is an intended product destination;
verification-first behavior remains the identity and constraint. The roadmap
does not treat breadth as parity with another product, a feature-count target or
permission for unrestricted execution. It must be earned through representative
task evidence while preserving explicit authority, exact-result evidence,
visible unknowns and guarded application.

The engineering question for each increment is:

> **What is the smallest change that lets a real user complete one more
> worthwhile task without weakening an essential invariant?**

## Implemented baseline

The pre-release currently supports:

- a natural-language terminal session for bounded repository questions, one
  clarification and one narrow class of TypeScript source changes;
- an understandable proposed scope and explicit approval before write authority
  exists;
- isolated work on one or two existing non-test, non-declaration
  `src/**/*.ts` files;
- bounded source reads, replacements and checks under a cumulative task budget;
- scope-integrity and contained TypeScript checks tied to the exact result;
- an exact diff, human acceptance or rejection and conflict-safe application;
- durable outcome facts for supported work that starts or is declined; and
- lower-level inspection, recovery and qualification commands for contributors.

The current supported change flow returns to a useful prompt after scope
decline, failed execution, candidate rejection or confirmed application. It
still ends on cancellation, lifecycle failure or unconfirmed application
settlement, and it cannot accept a semantic revision such as “change this
part” or resume an interrupted task. Its Docker-backed TypeScript route has
synthetic coverage but has not completed a prospective live qualification on
representative external tasks. These gaps define the active milestone.

Historical experiments demonstrate mechanisms, not active product routes. See
[experiments](../experiments/README.md) and [project history](history/README.md).

## Milestone 1 — Complete a small repository change from one conversation

**Status: active.**

A user can:

- open Tesota and describe a small change;
- understand the work Tesota proposes and the access it needs;
- authorize the supported effects without coordinating internal IDs;
- let Tesota work within that boundary;
- inspect the exact result and the checks that apply to it;
- see what those checks do not establish;
- decide whether to apply the result; and
- return to a useful prompt afterward.

The implementation may remain limited to the current small TypeScript subset.
Breadth is not part of this milestone.

Already present are conversational discovery, approval, isolated work, bounded
diagnostic-driven edits, exact-result checks, diff review and guarded
application. Remaining work is to complete the conversational loop for every
known-settlement path, remove recovery IDs from the ordinary path and qualify
the whole experience on representative work.

Completion evidence is defined in [qualification](qualification.md). Passing
component checks alone does not complete the milestone.

## Milestone 2 — Correct the work without restarting

A user can continue the same task when a check finds a problem or when the user
says, for example, “change this part.” Tesota preserves useful task context,
produces a new exact result and renews every affected check.

The product and its evidence must distinguish:

- **initial implementation** — producing the first inspectable result;
- **diagnostic-driven repair** — responding to a concrete failed check or
  diagnostic; and
- **user-requested semantic revision** — changing an otherwise reviewable
  result because the user wants a different outcome.

An edit is not automatically a correction. Current counters that describe tool
operations remain observable implementation data; they must not be presented as
these user-level outcomes until the runtime can distinguish them.

Completion requires evidence that correction improves accepted-task completion
or reduces user effort without increasing independently assessed residual
defects. Unsuccessful attempts, new failures, elapsed time and intervention stay
visible.

## Milestone 3 — Understand and recover the state of work

After an interruption, a user can learn in ordinary language:

- which exact result exists;
- which checks apply to it and what remains unknown;
- whether work is still active, ended or has uncertain settlement;
- whether a result was accepted or applied;
- what must be repeated; and
- which authority has expired and cannot be reconstructed.

The user does not reconstruct that story from proposal, candidate or review IDs.
Those identities remain available for precise diagnosis and technical
interfaces.

Completion requires restart tests at each durable boundary, including
wrong-result review, stale acceptance, lost application acknowledgement,
cancellation with surviving descendants and uncertain effects. Recovery must
never replay an uncertain effect as though it did not happen or recreate old
authority.

## Milestone 4 — Broaden toward representative coding work

Milestones 1–3 establish a complete, correctable and recoverable lifecycle for
the narrow task. Milestone 4 deliberately expands that lifecycle toward broad,
real coding work. Tesota expands a restriction only when prospective tasks show
that it blocks worthwhile work and the expansion preserves the essential
invariants.

Possible responses include existing tests, a slightly larger write set, one
file-lifecycle operation, another check profile or a lower-friction execution
environment. These are examples, not commitments. The observed task corpus and
residual-defect review determine which one, if any, is next.

Each expansion must identify its user need, new effects, authority boundary,
applicable evidence, failure behavior and maintenance cost. A new verifier or
execution provider is justified by useful findings or reduced burden, not by
integration count.

Broad coding usefulness is demonstrated when a preselected, representative task
corpus shows that ordinary bugs, features and refactorings can usually reach an
inspectable outcome, while refusals become bounded, explainable exceptions.
Support coverage alone is insufficient: residual defects, correction and
intervention burden, elapsed time, cost, review burden and failure causes remain
part of the claim. No single new tool, language, file operation or repository-
understanding mechanism completes this milestone by itself.

## Prospective usefulness evaluation

Milestone decisions use a small prospective evaluation before any evaluation
platform is built.

Select tasks before seeing Tesota's results. Use external repositories without
altering them to fit the product. Include small bugs, small features and bounded
refactorings, along with refusals and failures. A manual record is sufficient
until its burden or ambiguity demonstrates the need for tooling.

For every selected task, record:

- support coverage and refusal or failure cause;
- whether the outcome was accepted and applied;
- independently assessed residual defects;
- user intervention and clarification;
- diagnostic repair and user-requested revision;
- elapsed time;
- inference and tool cost when the runtime can observe them honestly;
- setup burden; and
- review burden.

Report counts and causes for a small corpus rather than manufacturing a
reliability percentage. Preselecting tasks and retaining negative outcomes are
requirements, not optional reporting polish.

## Long-term direction

Tesota first aims to make its verification-first lifecycle useful across broad,
real coding work. That is a coding-capability direction, not a change to the
canonical **verification-first agent** category or a claim that broad capability
exists today.

Beyond coding, Tesota may grow into research, planning, creation, broader tool
use and other consequential work. This further direction is not a checklist for
a “general agent.”

Before a new domain becomes a product commitment, it must demonstrate:

- a real user need;
- what constitutes the exact result;
- which evidence is applicable and what it cannot establish;
- which effects require authority and confinement; and
- how review and adoption work in that domain.

The coding lifecycle is not automatically universal. Its invariants may endure
while its candidate form, checks, effects and adoption boundary change.

## Deferred until justified

No current milestone includes a universal model gateway, account pool,
cross-harness configuration projection, universal verifier framework,
autonomous teams, orchestration graphs, GUI parity, marketplace or plugin
platform, generic execution-provider abstraction, automatic model router,
silent provider failover or native Tesota engine.

Preserve the right to change models and engines; do not make changing engines
the product. Reconsider infrastructure only when a current consumer and a
measured problem justify its ownership cost.

The [Kiln extraction reference](references/kiln-extraction.md) preserves the
failure knowledge behind this restraint. The lesson is not that Kiln was wrong;
it is that infrastructure and scope expanded faster than demonstrated everyday
usefulness. Recover that failure knowledge aggressively. Recover infrastructure
only when present evidence justifies it.
