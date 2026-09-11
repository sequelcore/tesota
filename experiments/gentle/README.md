# Gentle AI review qualification

This experiment evaluates Gentle AI as an optional review provider behind a
Tesota-owned boundary. It does not install Gentle as a Tesota runtime
dependency, grant review results acceptance authority, or replace Oxlint,
LemmaScript/Dafny or integration tests.

## Question

Can Tesota consume a bounded Gentle review result while preserving the exact
candidate identity, evidence ownership, recovery behavior and acceptance
boundary already defined by Tesota?

## Fixed scope

- Gentle package: `gentle-pi@2.5.0` with its declared Gentle AI `2.7.0` bundle.
- Contract: negotiated `gentle-ai.review-integration/v2`.
- Subject: one isolated Tesota candidate with a deliberately reviewable,
  one-file change.
- Execution: one review, at most one bounded correction, then read-only
  validation.
- Delivery: no commit, merge, push, release or source promotion.

## Acceptance evidence

The experiment passes only if the retained record demonstrates all of the
following:

1. The provider executable and contract version are resolved exactly.
2. The review binds to the candidate's immutable base, candidate tree and
   changed-path manifest.
3. Provider findings remain evidence and do not authorize promotion.
4. A correction is limited, attributable and followed by a fresh validation.
5. An interruption or uncertain provider result settles as unknown and has a
   documented recovery path.
6. Tesota retains the canonical candidate and evidence record without relying
   on Gentle private state.

## Non-goals

This experiment does not judge Gentle Shell's visual design, persistent memory,
model quality or general developer productivity. Those are separate product
evaluations after the review contract is qualified.

## Result

### Phase 1: package and contract inspection

**Passed on 2026-09-11.** The published `gentle-pi@2.5.0` package was retrieved
without adding it to Tesota and inspected from its package contents. Its
manifest declares the `gentle-ai.review-integration/v2` contract, includes the
v2 schemas and fixtures, and runs a provider-contract check as part of its own
test lifecycle. The package tarball SHA-256 was recorded as
`sha256:e03bab34f40cd8ea9673f12e752c5d35376f5f52536bdfb5d747829ff106e803`.
Its native `check:provider-contract` also passed for provider contract mirror
`1.2.0` with nine bundle entries and two generated baselines.

This phase establishes package provenance and contract availability only. It
does not establish runtime compatibility, review correctness or acceptance
authority. The next phase must run the contract's capabilities and bounded
review flow against one isolated Tesota candidate.

### Phase 2: capabilities and candidate bootstrap

**Partially passed on 2026-09-11.** The package-local Gentle AI `v2.7.0`
executable was installed in the temporary qualification directory. Its
capabilities command returned contract `gentle-ai.review-integration/v2`,
protocol `2.5`, all seven mandatory features and all seventeen advertised
optional features as supported. The executable reported its own digest and the
package reported the pinned build identity.

An isolated Tesota clone with one modified documentation file was then
identified through `review status --workspace-overlay --base-ref HEAD`. The
provider returned a current target identity, immutable base and candidate tree,
the changed-path manifest, and a provider-issued `review.start` transition.
Executing that exact transition closed the low-risk review as `approved` with
zero selected lenses and a correction budget of one. A follow-up status bound
the approved authority to the same target and revision and required the
provider-issued acknowledgement token.

This validates capabilities negotiation, candidate identity and the
provider-issued transition model. It does not yet qualify a model-backed
review, correction or interruption recovery; those remain pending.

Until that phase passes, Gentle remains a documented reference and proposed
provider rather than a Tesota dependency.
