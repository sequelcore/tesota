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

No result has been recorded. Until this experiment passes, Gentle remains a
documented reference and proposed provider rather than a Tesota dependency.
