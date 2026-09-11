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

### Phase 3: high-risk review transition

**Bounded failure recorded on 2026-09-11.** A candidate touching
`src/auth.ts` caused the provider to require consent and select all four
review lenses (`review-risk`, `review-resilience`, `review-readability` and
`review-reliability`). With explicit consent, `review.start` created a high-risk
lineage, froze the candidate and emitted four identity-bound artifact subjects.
The next provider-issued `review.status` transition exceeded its aggregate
time budget and returned `operation_timeout` with `mutation_outcome:
not_started`, `authority_applicability: not_evaluated` and
`next_action: stop`. No candidate file was changed and no Tesota acceptance or
promotion occurred.

This is useful failure evidence: the provider selects deeper review and fails
closed before mutation when its operation cannot settle. Tesota must treat the
timeout as unavailable evidence and use a manual recovery path rather than
retrying implicitly. A completed model-backed review and an explicit recovery
exercise remain pending.

### Phase 4: recovery attempt

**Recovery limitation recorded on 2026-09-11.** Re-reading the stopped
lineage reproduced the same bounded `operation_timeout`. An explicit
`review recover` attempt was rejected with `recovery scope has not changed`,
and no successor authority was created. The candidate remained unchanged.
This means the current pre-native timeout path does not provide a usable
automatic successor; Tesota must surface this as an unresolved provider state
and require operator-directed cleanup or a new candidate rather than retrying
the same lineage.

### Phase 5: provider parity battery

**Deterministic lane passed on 2026-09-11.** Gentle's published
`test:cross-lane` completed with `cross-lane last-event closure parity passed`.
The native dev-binary journey was also invoked, but all ten tests were skipped
by its Windows guard and missing compatible dev-binary registration; no pass is
claimed for that lane. This verifies one contract-parity lane only and does not
replace a Tesota-hosted review or a model-backed result.

### Phase 6: stale target binding

**Passed on 2026-09-11.** A review start was deliberately sent with a
`target_identity` that did not match the freshly built workspace snapshot.
Gentle rejected it during `preflight` with `stale_target_identity`, reported
`mutation_outcome: not_started` and `authority_applicability: not_evaluated`,
and returned `retry_safe: true` with `next_action: review.status`. No lineage
or candidate mutation was created. This is the expected fail-closed behavior
for a stale or forged binding.

### Phase 7: Tesota-hosted bounded cycle

**Passed for the low-risk path on 2026-09-11.** Tesota's new
`pi-coding-agent` host reused the existing Codex credential store, ran Pi Coding
Agent with only `read` and `edit`, and completed the scoped Pi status task in
an isolated candidate. The host recorded six messages and both allowed tool
names; Tesota's current task check passed and retained a one-file diff.

The same candidate was then presented to Gentle AI `v2.7.0`. Gentle bound the
review to the candidate identity and trees and closed the non-executable-only
change as low-risk `approved` with no selected lenses. Tesota's own review
produced a current fingerprint, but no operator decision or promotion was
recorded. This completes the low-risk construction and review path while
keeping human acceptance separate.

Until the remaining model-backed and recovery phases pass, Gentle remains a
documented reference and proposed provider rather than a Tesota dependency.

### Phase 8: high-risk rerun and recovery preflight

**Provider transition reproduced on 2026-09-11; model-backed review remains
unavailable.** The retained Windows risk candidate was reviewed again with
explicit per-candidate consent. Gentle created lineage `review-29a43e93cd67ce4e`,
bound it to target `sha256:030d61cd916c53176e1c4e78128e12da2c7ee675f86b057fdd8594b0c27e703c`,
selected all four high-risk lenses and required four reviewer artifacts. The
next status is `reviewer_results_required`; no reviewer result was available to
capture, so no model-backed finding or correction is claimed.

The provider's `review repair --preflight` reported `status: unsupported` with
two compact lineages and zero eligible repair candidates. No candidate bytes,
Tesota source, acceptance decision or promotion were changed. This confirms
the existing recovery limitation and leaves operator-directed cleanup or a new
candidate as the safe path.

### Phase 9: Codex-backed artifact capture

**First provider capture passed on 2026-09-11.** Tesota created candidate
`c472bbc9-4392-44e6-ab72-99d7474a607d` with one controlled `src/auth.ts` change.
Gentle emitted four identity-bound high-risk subjects under lineage
`review-17bb8d3881a94fa0`. Tesota's Codex-backed host completed the
`review-risk` lens in read-only mode and Gentle admitted the result with
`admission_decision: completed` for subject
`sha256:1dfcdd823de47553f7cd89c302acc4188a26d865d1ac5a58c1053e337973184a`.

Three concurrent reviewer launches for the remaining lenses returned no
structured JSON and were recorded as failed host attempts; they were not sent
to Gentle. The lineage therefore remains open at `reviewer_results_required`.
This proves shared Codex authentication and one real capture, but not
multi-lens settlement, correction or recovery.

The host retried each missing lens sequentially with an explicit JSON-only
follow-up prompt. `review-resilience`, `review-readability` and
`review-reliability` still returned no structured result, so Gentle received no
unbound or synthetic substitutes. The lineage remains open and requires a
reviewer transport that reliably emits the negotiated result schema.

### Phase 11: typed reviewer submission

The host now uses Pi's typed custom-tool contract. The reviewer must call
`tesota_submit_review` once; Tesota validates the schema and accepts the result
directly, while final response text is only a compatibility fallback. Build,
typecheck and lint pass. A new live capture is pending because the authorized
Codex store currently reports its usage limit; the open Gentle lineage is not
claimed as settled.

### Phase 12: Luna multi-lens rerun

After switching the authorized store to the Plus-compatible `gpt-5.6-luna`
model, Tesota completed all four lenses for the same candidate identity:
`risk`, `resilience`, `readability`, and `reliability`. Each result was saved
beside the candidate. These runs demonstrate model output, not Gentle review
completion: the host also accepts a text fallback, and the saved records do
not distinguish which submission path produced them. The later Gentle status
reported the same candidate tree as the original snapshot.

### Phase 13: immutable transport boundary

A new START attempted from the actual candidate `repo` directory, with the
original base tree, workspace overlay, target and explicit Pi runtime, was
rejected with `immutable_review_transport_unsupported`. Gentle reported
`mutation_outcome: not_started` and `next_action: stop`. No new review was
established by this attempt. Earlier calls from the containing candidate
directory resolved to a different enclosing Git repository; their timeouts
and missing-lineage responses do not establish a defect in candidate recovery.

Bound status in the correct repository still identified the original lineage
as `reviewing`, with `action: stop` and `manual_action_required`. Failure of
the historical `review-resume` command does not establish that this compact
lineage is invalid or absent. Its settlement remains unresolved.

The installed provider contract requires the gentle-pi facade and opaque
reviewer relay: inspect, use the offered START route, obtain provider-bound
immutable context, run the reviewer, and submit through the offered binding.
Tesota's current host instead supplies a generic lens prompt and a live
checkout. Its candidate identity hashes Git revisions and path/status metadata,
not the uncommitted file contents. Existing Luna records therefore cannot be
rebound to fresh Gentle subjects as completed immutable reviews.

The temporary conversion attempted during capture also supplied line 1 when a
finding lacked a line and supplied generic proof references. Those converted
files are invalid evidence and must not be submitted. No successful admission
of those conversions was observed. Retained findings are review suggestions,
not verified defects or evidence of candidate causality.

The next increment must connect Tesota-owned Codex authentication and model
execution to the provider's opaque relay contract, preserve provider prompts
and bindings, reject missing evidence, and test repository-root resolution and
stale candidate rejection. Only then can a fresh immutable multi-lens run
qualify capture and settlement. Setting the relay handshake variable alone
does not implement that contract.

### Phase 14: immutable Codex relay and settlement

**The retained high-risk lineage settled on 2026-09-11 UTC.** Tesota implemented a
small adapter around Gentle's public executable protocol rather than importing
the package's internal TypeScript modules. It queries bound status, accepts
only the provider's Pi materialization and submission descriptors, checks the
lineage, target and artifact subject, passes the materialized prompt unchanged
to a tool-free Luna invocation, and rechecks the binding before submission.
Reviewer output is staged in a private temporary directory and removed after
the provider call.

The first live attempt exposed a transport bug: provider reasoning events were
incorrectly treated as final non-text output. Focused regression coverage now
allows reasoning metadata while accepting only text in the submitted result
and still rejects tool calls, empty output, invalid UTF-8, provider failures,
oversized data, cancellation and timeout.

Gentle admitted `review-resilience`, `review-readability`, and
`review-reliability` for lineage `review-17bb8d3881a94fa0`. Together with the
previously admitted `review-risk`, the last event closed the review as
`approved`. The exact provider-issued acknowledgement then returned
`gentle-ai.review-acknowledged/v1` and burned the authority. No candidate bytes,
Tesota source, local acceptance decision or promotion changed during this
review. This qualifies one immutable four-lens settlement. Correction and
recovery behavior remain separate open qualifications.
