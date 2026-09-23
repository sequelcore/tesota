# Combined-check shell-progress third attempt: frozen protocol

Selection date: 2026-09-23. The first attempt failed operationally and the
[second attempt](2026-09-23-combined-shell-progress-results.md) ended with
unconfirmed settlement. Retain both. This is still an internal diagnostic,
not an unchanged external-repository usefulness trial.

Use the clean committed source clone at
`575b58e81aa639cdb2b2343fe00b253bd4673d43` and a fresh Tesota session.
The request is to show `Waiting for correction approval` for
`{ phase: "awaiting_approval", operation: "semantic_correction" }`, while
preserving `Waiting for scope approval` for `proposal_scope` and all other
existing stage labels. Allow writes only to `src/shell-progress.ts` and
`tests/shell-progress-node.test.ts`. Select the targeted Node test and the
contained TypeScript no-emit check before approval.

The candidate test must fail on the committed source and pass on the candidate
source without removing existing assertions. Both approved checks must pass on
the same final candidate with observed settlement. Independently review the
intent, changed paths, test and labels before any local acceptance. Use Tesota's
decision and guarded application only if the evidence and review are current.
An operational failure, timeout or unconfirmed effect ends without application.

Record elapsed time, setup and operator work, model/tool use, both check
outcomes, review, decision and application. The ten-minute agent-session limit
is provisional; report a further failure as observed rather than inferring
general readiness.

Before this attempt, a retained-evidence test found that JSON schema parsing
could reorder fields in a failed check and invalidate its diagnostic-repair
hash during review. The executor now hashes a canonical representation of that
check. The third attempt must exercise the actual saved attempt and review;
direct verifier success alone is insufficient.
