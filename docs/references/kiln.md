# Kiln reference

Kiln is Tesota's historical source and a reference for selected implementations
and tests. Its roadmap and architecture do not define Tesota's requirements.
Reuse is evaluated for a concrete need, with provenance recorded when code is
adapted or copied. See the [reconstruction decision](../decisions/001-start-tesota.md).

## Repository and fixed source

Repository: [sequelcore/kiln](https://github.com/sequelcore/kiln).
Tesota currently develops on `tesota/bootstrap` within that Git history; this
does not imply a separate published Tesota repository or a completed rebranding.

The bootstrap source is
[`4257ee9fce034cfe8e50dce3dbe3afb12f468094`](https://github.com/sequelcore/kiln/tree/4257ee9fce034cfe8e50dce3dbe3afb12f468094).
It is historical provenance, not a verified functional baseline. The immutable
[bootstrap inventory](../history/bootstrap-inventory.json) records original blob identities
and dispositions. A coexisting Kiln checkout may have advanced beyond this source.

## Selected reference areas

These source paths were inspected in local Git history at the fixed commit above.
Repository links may require access. No current remote branch state is asserted.

| Area | Fixed source | Current disposition |
| --- | --- | --- |
| Browser/device OAuth | [codex-oauth-auth.ts](https://github.com/sequelcore/kiln/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/src/agents/credential-acquisition/codex-oauth-auth.ts) | Studied for existing behavior and extraction dependencies; Tesota uses Pi authentication |
| Codex transport | [codex-oauth.ts](https://github.com/sequelcore/kiln/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/src/agents/provider-adapters/codex-oauth.ts) | Studied for adapter dependencies; not ported |
| Authentication regressions | [codex-oauth-auth.test.ts](https://github.com/sequelcore/kiln/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/tests/agents/credential-acquisition/codex-oauth-auth.test.ts) | Located as a future comparison source; not rerun or adopted |
| Static analysis profile | `packages/runtime/src/verification/oxlint/oxlint-analyzer.ts` on the local `dev` branch | Studied as a candidate source for an explicit Tesota rule profile; not copied |
| Quality-gate loop | `packages/core/src/quality-gates/gate-runner.ts` and `verification-loop.ts` on the local `dev` branch | Studied as a bounded orchestration pattern; not adopted as a general runtime |

## How to use the reference

Start with a specific behavior or regression question. Identify the relevant
source owner and record the exact commit inspected. Use local `git show` for
fixed historical content; do not mistake a reference checkout's current branch
for the version Tesota consumes.

When a question requires current upstream behavior, establish remote freshness
and record the resolved commit without moving an unrelated working tree. A
historical comparison does not require a broad update of every reference clone.

For reused code or tests, record the source commit/path, Tesota destination,
adaptations, attribution and verification in the owning decision or change.
Distinguish studied, adapted and copied material. Retain licenses and relevant
notices. A passing Kiln test does not verify its Tesota adaptation.

Kiln's static-analysis profile is not an anti-slop guarantee. Its explicit
Oxlint rules catch structural defects and risky patterns such as unused code,
unnecessary complexity, oversized functions and unsafe TypeScript constructs.
Quality gates can sequence those checks and offer a bounded correction loop,
but they do not establish semantic intent, formal correctness or acceptance.
Tesota may recover individual rules or the bounded pattern only after checking
their current value, false-positive cost, pinned tool identity and evidence
contract. It will not copy Kiln's complete profile or quality-gate runtime by
default.

Keep machine-specific checkout paths in local working context. Neither a sibling
checkout nor Kiln's private namespace is a Tesota runtime dependency or state store.
