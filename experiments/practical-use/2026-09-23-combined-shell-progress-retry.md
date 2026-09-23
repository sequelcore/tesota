# Combined-check shell-progress retry: frozen protocol

Selection date: 2026-09-23. This is a fresh ordinary-shell attempt after the
[first failed attempt](2026-09-23-combined-shell-progress-results.md); retain
either outcome. It is still an internal diagnostic, not a replacement for an
unchanged external repository task.

## Baseline and request

- Clean source clone at `575b58e81aa639cdb2b2343fe00b253bd4673d43`.
  Relative to the first attempt, only the committed Node test fixture import
  changed. Its baseline Node test passed. A separate untouched candidate
  passed the actual contained TypeScript check with the revised bounded
  policy before this retry.
- Request: show `Waiting for correction approval` for
  `{ phase: "awaiting_approval", operation: "semantic_correction" }`.
  Preserve `Waiting for scope approval` for `proposal_scope` and every other
  existing stage label.
- Write scope: only `src/shell-progress.ts` and
  `tests/shell-progress-node.test.ts`. Select both the targeted Node test and
  contained TypeScript no-emit before approval. No other edits or commands.

## Oracle and decision

Add a correction-specific regression to the existing test. With those exact
test bytes, the committed source must fail the requested assertion and the
candidate source must pass it. Preserve existing assertions. Require both
selected checks to pass on the same final candidate and confirm their
settlement before review. Independent review checks the result, test intent,
scope and other labels. Accept and apply through Tesota only if the candidate
is correct and the reviewed evidence is current; otherwise reject or retain
the failed outcome. Do not manually adopt a failed or unsettled candidate.

Record setup, elapsed time, operator and review effort where observable,
model/tool usage, check outcomes, decision, application and residual defects.
The fixed five-minute model budget may be insufficient for the dependency
snapshot; retain that failure if it occurs rather than raising the limit
solely for this attempt.
