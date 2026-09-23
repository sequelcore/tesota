# Source-and-test check-selection walkthrough: observed result

This record follows the [frozen protocol](2026-09-22-check-selection-walkthrough.md),
whose pre-attempt SHA-256 was
`c3e286ce86b89741bb41c7489226668f5b9e92c9f44caa0837231314fd8d0c16`.
The task was previously used in the pilot. This is one diagnostic of the
ordinary shell after application-owned check selection, not a fresh
qualification task or a claim of representative usefulness. No retry was made.

## Preconditions

Tesota source was `2308a13f8a0a9f09ad3a3de9e118f44d578f95b0` plus the
uncommitted check-selection change under evaluation. `bun run check` passed
in one Windows run: 360 main tests, 16 candidate-checkout tests, 55
candidate-task tests, TypeScript typecheck, build and lint. Docker Desktop's
Linux engine was started before the attempt, and the pinned Node image was
already present. Saved Codex authentication was available. The Gentle Pi
original clone was clean at the predeclared baseline.

## Observations

- The ordinary shell produced a `ready` proposal after about 92 seconds. It
  selected only `lib/openspec-deltas.ts` and
  `tests/openspec-deltas.test.ts`, with exactly `scope-integrity` and
  `node-test-targeted/v1`. The earlier incompatible three-check proposal did
  not recur. Discovery used 9 model invocations, 8 tool calls, 8 repository
  operations and 41,821 exposed bytes.
- After scope approval, Tesota used an independent candidate and reached
  exact-result review. Task execution used 10 model invocations, 9 tool calls
  and 2 edits in 146,781 ms of recorded task elapsed time. Its first check
  failed; the final contained targeted Node check passed with observed
  settlement. The outcome reported one diagnostic repair. Token usage and
  monetary cost were unavailable, not zero.
- The candidate changed only the approved source and test. Its retained diff
  SHA-256 was
  `990ddef88efe86602320b0be052af38a539e5161e276700aba918f438c1beaac`.
  The review identity was
  `42f118d5db314a8c8c9632ea8774353bb24b472e6a5a80235f64c30f99228a78`.
  Tesota reported scope integrity and the selected Node test as passed;
  repository typechecking and the full Gentle Pi suite were not run by this
  profile.
- The candidate's focused Node test passed 9/9 in a separate local run.
  An independent direct invocation of the same regression input against the
  original source failed both predeclared properties: preserving the internal
  divider and removing the trailing one. Against the candidate source, both
  properties passed. This supports the regression's sensitivity for this input;
  it does not establish all requirement-body cases.
- The operator explicitly rejected the candidate because this was a live test,
  regardless of its apparent correctness. Tesota recorded `Decision: reject`,
  `Outcome: rejected` and `Application: Not applied`, then returned to the
  prompt and exited normally. The final outcome reported 7 host checks and
  1,987,665 ms elapsed, including the time waiting for the human decision.
  The original Gentle Pi clone remained clean at the same committed baseline.

## Assessment

This one attempt demonstrates that application-owned check selection removed
the observed proposal-shape barrier for the selected task and that the
ordinary flow can reach a checked exact review and retain an explicit
rejection on Windows/Docker. The rejection was a live-test decision, not an
assessment that the code was defective. This does not establish accepted
application, fresh external-task usefulness or cross-platform qualification.
Setup required starting Docker Desktop; active operator work and review
burden were not timed separately.
