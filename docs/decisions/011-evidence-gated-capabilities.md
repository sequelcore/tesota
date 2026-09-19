# 011: Admit verification capabilities through bounded evidence-backed increments

Status: proposed on the review branch; adopted by merge into `dev`.

## Context

A developer needs useful repository context, checks connected to the exact
result, and an understandable review and application boundary. More providers
or a generic governance platform do not establish that outcome. Conversely,
requiring mature production demand before any experiment would prevent a small
product bet on an intrinsic information need.

[Issue #122](https://github.com/sequelcore/tesota/issues/122) separates those
choices. This decision owns the durable admission rationale, as required by
[development](../development.md#documentation-ownership); it is not a second
roadmap or an implementation plan.

## Admission rule

Tesota may explore a strategic product bet before observed production demand
only when it addresses a **core product problem**, uses a **bounded mechanism**,
has a **simple comparison baseline**, measures an **observable user-relevant
benefit**, and permits **cheap deletion** if it loses. The problem may be
strategic; the mechanism must remain falsifiable and disposable.

Each accepted increment must name its user and outcome, canonical owner,
read/effect boundary, dependencies, comparison and qualification evidence, and
removal/fallback contract. Prefer an existing owner. A research decision is not
runtime adoption, proof of usefulness, a priority change or permission to make
external calls. [Verifier qualification](../verifier-strategy.md#qualification-standard)
and [product qualification](../qualification.md) still govern their respective
claims. An implementation needs its own focused, evidence-backed decision.

## Conceptual and authority boundaries

**Repository Understanding** produces bounded, inspectable repository context
from exact observations. **Evidence Planning** is only a provisional term for
choosing which already-admitted information-gathering or correction action may
be useful next. **Assurance** evaluates what applicable evidence establishes
about an exact candidate under adopted completion conditions. These are
separate questions, not instructions to build three subsystems.

Check evidence retains its producer's claim and limits. Review evidence is
inferential assessment; a model recommendation is neither a check nor a proof.
Assurance is not human acceptance, and acceptance is not application. Relevant
context does not establish a completion condition. Model-proposed criteria do
not silently revise the user's adopted requirements; missing or contradictory
evidence remains visible.

Tesota retains policy, applicability, budgets, authority and application.
Pi, models, reviewers and verifiers remain components. No observation, telemetry,
recommendation or review creates authority or suppresses a mandatory check.
Identity binds to actual relevant content; changed results require renewed
applicable evidence. Recovery reconstructs facts, not expired authority.
Authority and confinement remain distinct. Unknown, unavailable, incomplete and
unconfirmed outcomes cannot become success by omission. Existing
[architecture owners](../architecture.md#canonical-owners) remain unchanged.

## Planning dispositions

These are the admission decisions for #122, not current product status or a
priority queue. Focused issues retain research state and their own close gates.

| Candidate | Disposition and activation boundary |
| --- | --- |
| Current check/review documentation | Accepted and completed through [#123](https://github.com/sequelcore/tesota/issues/123) and [#126](https://github.com/sequelcore/tesota/pull/126). Existing verification, development and verifier-strategy guides own usage, limits and qualification; no runtime increment. |
| Deterministic Repository Understanding | Accepted as a bounded research/product bet, not an implemented feature or delivery commitment. [#125](https://github.com/sequelcore/tesota/issues/125) owns research; the contract below governs a possible increment. Broader symbol/dependency analysis needs a separate consumer and qualification. |
| Semantic context selection | Runtime/default adoption deferred. #125 owns the finite excerpt-relevance question and any separately authorized later study. Its recorded Phase-A termination is not a published positive or negative provider verdict. No continuation or integration follows from the stop. |
| Requirement-level Assurance | Deferred until a supported task needs explicit completion-condition-to-evidence evaluation that the existing proposal, candidate, check and review owners cannot adequately express. Start with a small review summary and adopted mappings, not a generic Assurance subsystem. |
| Adaptive verification / review economics | [#124](https://github.com/sequelcore/tesota/issues/124) remains deferred and limited to genuinely discretionary additional independent review. Activate only for a supported workflow with observed review frequency, cost and predictable triage value, the strongest simple-policy comparison, independent labels and all of that issue's authorization gates. Context selection does not activate it. |
| Evidence Planning | Retain the conceptual distinction only; reject a generic framework in this increment. Reconsider a specific policy only for a named already-admitted decision with a baseline, bounded effects and measurable benefit; #124 and #125 keep their separate consumers. |
| Additional executable checks | Deferred beyond existing contracts until a named task exposes a distinct useful oracle or correction burden and the tool-specific verifier qualification criteria are met. No universal verifier interface. |
| Optional execution, governance or review providers | Deferred until a real consumer, public or otherwise authorized integration contract, defined effects and evidence provenance, cancellation/settlement semantics, provider-free removal/fallback and bounded qualification exist. No anticipatory provider registry. |
| Non-code domains | Deferred until a concrete domain defines its user, exact result, applicable evidence and limits, allowed/consequential effects, acceptance/adoption boundary and qualification method. Coding guarantees do not transfer automatically. |

## Bounded Repository Understanding contract

The intended user is a developer locating the implementation relevant to a
supported TypeScript change. Extend
[`src/repository-discovery.ts`](../../src/repository-discovery.ts), the owner of
the bounded committed-source view; do not create a second snapshot service.
A first comparison may expose exact declaration/signature ranges, direct
relative-import/dependent relationships, conservatively established uses and
related-test candidates, with bounded ordering, identities and explicit omissions.
Related tests are candidates, not behavioral-coverage evidence.

Depend on the existing committed Git view, path/exposure limits and proposal
contracts. Assess the existing TypeScript dependency for any bounded parsing;
no new dependency is approved here. Do not execute repository code, broaden
read/write authority, read dirty source bytes, or build a persistent semantic
index, vector database, universal LSP platform or exhaustive impact graph.
Unreliable relationships remain unknown or unsupported.

Before proposing implementation, #125 must retain a provider-free deterministic
comparison against current literal list/search/read discovery on preselected
supported tasks. Measure useful-context misses, unnecessary reads/context,
construction cost and downstream task/correction/intervention burden. Keep
failures, refusals and unsupported cases. Regression evidence must cover exact
source/range identity, deterministic bounds and omissions, restricted paths,
baseline drift and instruction-like source content without new authority.
Qualification claims must identify the exercised environment and their limits.

If semantic selection is reconsidered, #125's separate permission, data, oracle,
interface and staged-evidence gates still apply. Compare deterministic selection,
the existing Pi/model selector and the proposed selector on the same bounded
candidate state and budget; isolate deterministic-state gains and measure
end-to-end usefulness before native adoption. An unpublished provider result
cannot satisfy those gates.

Deletion restores current list/search/read discovery without migrating candidate,
evidence, authority, acceptance or application state. Removing a semantic arm
must preserve deterministic context and its ordinary provider-free path; it
must not silently substitute another provider. No semantic experiment is a
prerequisite for independently useful deterministic research.

## Kiln provenance and consequences

Follow [decision 005](005-recover-kiln-selectively.md): study regression oracles
and adverse fixtures first, then adapted invariants; select small implementation
fragments only after a concrete matched comparison justifies them.

For this decision, `kiln-legacy-2026-09` was resolved to
`9b604b105fbf3644328e187b862233660280b604`. The historical
[ProjectCapture](https://github.com/sequelcore/tesota/blob/9b604b105fbf3644328e187b862233660280b604/scripts/repository-analysis/project-capture.ts)
and [bounded-work Assurance](https://github.com/sequelcore/tesota/blob/9b604b105fbf3644328e187b862233660280b604/packages/core/src/work-governance/bounded-work-assurance.ts)
were **studied only**. ProjectCapture's filesystem/compiler view is not a reason
to duplicate committed-source discovery. Assurance reports candidate-bound
evaluation facts; it neither accepts a candidate nor decides terminal closeout.
No Kiln code, test or contract is copied or adapted by this change. Any future
reuse must record exact source and destination, adaptations, attribution/license
obligations and Tesota-side regression evidence; historical passing results do
not qualify Tesota.

[The roadmap](../roadmap.md) remains the sole owner of product status and
priority. This decision accepts no priority change and does not edit the roadmap.
It authorizes no live provider experiment, data disclosure, spend, dependency,
new effect or runtime integration. Research success permits only consideration
of the next separately authorized increment. Public documentation continues to
lead with the user experience under [decision 010](010-center-public-docs-on-user-experience.md).
