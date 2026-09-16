# Kiln reference

Kiln is Tesota's historical source and a reference for selected implementations
and tests. Its roadmap and architecture do not define Tesota's requirements.
Reuse is evaluated for a concrete need, with provenance recorded when code is
adapted or copied. See the [reconstruction decision](../decisions/001-start-tesota.md).
The later [selective recovery decision](../decisions/005-recover-kiln-selectively.md)
and [extraction reference](kiln-extraction.md) record the reconciled policy from
a pinned review of the frozen Kiln `dev` branch.

## Repository and fixed source

Repository history: [sequelcore/tesota](https://github.com/sequelcore/tesota).
Tesota integrates work on `dev` and promotes stable increments to `main`. The
protected [`kiln-legacy-2026-09`](https://github.com/sequelcore/tesota/tree/kiln-legacy-2026-09)
tag at `9b604b105fbf3644328e187b862233660280b604` is the canonical final Kiln
development reference; no active branch denotes historical Kiln state.

The bootstrap source is
[`4257ee9fce034cfe8e50dce3dbe3afb12f468094`](https://github.com/sequelcore/tesota/tree/4257ee9fce034cfe8e50dce3dbe3afb12f468094).
It is historical provenance, not a verified functional baseline. The immutable
[bootstrap inventory](../history/bootstrap-inventory.json) records original blob identities
and dispositions. A coexisting Kiln checkout may have advanced beyond this source.

## Selected reference areas

These source paths were inspected in local Git history at the fixed commit above.
Repository links may require access. No current remote branch state is asserted.

| Area | Fixed source | Current disposition |
| --- | --- | --- |
| Browser/device OAuth | [codex-oauth-auth.ts](https://github.com/sequelcore/tesota/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/src/agents/credential-acquisition/codex-oauth-auth.ts) | Studied for existing behavior and extraction dependencies; Tesota uses Pi authentication |
| Codex transport | [codex-oauth.ts](https://github.com/sequelcore/tesota/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/src/agents/provider-adapters/codex-oauth.ts) | Studied for adapter dependencies; not ported |
| Authentication regressions | [codex-oauth-auth.test.ts](https://github.com/sequelcore/tesota/blob/4257ee9fce034cfe8e50dce3dbe3afb12f468094/packages/runtime/tests/agents/credential-acquisition/codex-oauth-auth.test.ts) | Located as a future comparison source; not rerun or adopted |
| Static analysis profile | `packages/runtime/src/verification/oxlint/oxlint-analyzer.ts` at `9b604b105fbf3644328e187b862233660280b604` | Five rules adapted into Tesota's owned `oxlint-static/v2` configuration; no implementation code copied |
| Quality-gate loop | `packages/core/src/quality-gates/gate-runner.ts` and `verification-loop.ts` at `kiln-legacy-2026-09` | Studied as a bounded orchestration pattern; not adopted as a general runtime |

## How to use the reference

Start with a specific behavior or regression question. Identify the relevant
source owner and record the exact commit inspected. Use `git show
kiln-legacy-2026-09:<path>` or the exact commit for fixed historical content;
do not mistake a reference checkout's current branch for the version Tesota
consumes.

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
Tesota recovered five individual rules after checking concrete defect fixtures,
controls, current-repository noise, pinned tool identity and evidence binding.
The complete profile and quality-gate runtime were not copied. Future additions
require the same evidence and a new profile identity.

Keep machine-specific checkout paths in local working context. Neither a sibling
checkout nor Kiln's private namespace is a Tesota runtime dependency or state store.
