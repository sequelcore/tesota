# Continuous SDK task-tool live follow-up — eligible case

Frozen on 2026-09-22 before live provider inference, after the separate
[ineligible setup observation](continuous-session-2026-09-22.md). This is a
route feasibility attempt, not a new general coding-success estimate. The
user authorized live provider and Docker testing and delegated task choice.

- Tesota HEAD: `4026ed96d5913eb8d50fe5417a03597e56f8a21b`, with the
  continuous task-tool changes in the existing uncommitted worktree.
- Public source: `https://github.com/hraness/sysone.git` at
  `862beb481157bfd5f53893bfea612610b23b29a0`, in a new independent clean
  Windows checkout. The existing [fifth follow-up](follow-up-5.md) previously
  froze this same source task for a different product increment; this attempt
  tests the new continuous-session route and must not be merged into its result.
- Exact request: “Harden `readBoundedText` in `src/http.ts`: reject a `maxBytes`
  value that is not a non-negative safe integer with `RangeError` before
  accessing the body or acquiring its reader, including when the body is null.
  Keep zero valid. Preserve valid-budget UTF-8 decoding, byte-based overflow
  cancellation and caller-abort behavior. Do not change other files.”
- Install from committed lockfile with
  `bun install --frozen-lockfile --ignore-scripts --omit optional --os=linux --cpu=x64`.
  Preserve tracked files. Use only the saved Codex login, ordinary compiled
  Tesota Shell and fixed `typescript-no-emit/v1` Docker profile. One task
  attempt; no prompt adaptation, provider fallback, budget increase or retry.
- The existing evaluator-only [oracle](http-limit-oracle.mjs) is frozen and
  withheld from the task agent. Run against baseline and exact candidate with
  Node 24.15.0 `--experimental-transform-types`. Passing typecheck does not
  establish behavior.
- Stop at exact-result review. Neither operator/model check evidence nor an
  assistant decision is human acceptance. Do not apply without the user's
  acceptance of the exact candidate.

Retain exact source/candidate/check identities, all failures, scope and
approval events, elapsed and setup time, intervention, unknown costs and
remaining limitations. This run can qualify only the observed Windows/Docker
route, not cross-platform or general task support.

## Observed run

- Environment: Windows x64, Bun 1.4.2, Node 24.15.0, Docker daemon 29.8.0;
  pinned image `node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`.
  Frozen, script-disabled dependency installation completed without tracked
  changes; installed TypeScript 6.0.3. Saved Codex login was available.
- The ordinary compiled shell received the exact request once. Discovery
  proposed only `src/http.ts` with scope-integrity and
  `typescript-no-emit/v1`; the operator approved isolated execution under the
  user's live-testing authorization. No clarification or prompt revision.
- Candidate `c34a802c-cd86-49c2-a88c-69f65c770959` changed only
  `src/http.ts`, adding `Number.isSafeInteger(maxBytes)` and a non-negative
  guard before `signal?.throwIfAborted()` and any body access. Its bound
  content SHA-256 is
  `d70645c1c06b90b33989d345bea6a9291aeb698709901db98595a31b3d1bc0fc`;
  exact review SHA-256 is
  `28f8806b8844460df0d5b91eac59fcd30d6dbc03e1edf2a44e45f3abbff6c82d`.
- Scope integrity and the fixed Docker typecheck both passed for that result.
  The compiler process exited and its container was absent at settlement.
  Review reported no drift since checking. The initial check was
  `check_failed` on the unedited candidate; the final check passed after one
  edit. Execution recorded 5 model invocations, 4 tool calls, 1 edit, 3 host
  checks, and 182291 ms to review-ready. No diagnostic repair or semantic
  revision occurred. Token usage and monetary cost are unavailable.
- The frozen evaluator-only oracle showed all 12 invalid-input cases failing
  on the baseline, with 6 valid-behavior cases passing. On the exact candidate,
  all 18 cases passed. This is behavioral evidence for those cases, not full
  integration-suite or universal correctness evidence.
- The user explicitly rejected the exact candidate. The ordinary shell
  recorded `decision: reject`, `outcome: rejected`, and `Application: Not
  applied`; the source checkout remains clean at the baseline. The retained
  isolated candidate is evidence, not an accepted or applied change. The
  final durable outcome reported 7 host checks and 747358 ms, including the
  wait for human decision and further review inspection. Delivery PR review
  was not performed in this route test.
- The shell returned to its prompt after rejection. An attempted textual
  `exit` was treated as an unavailable repository request and the process
  exited 1; no source change or new authority resulted. This terminal exit
  observation is separate from the settled rejected task outcome.
- Tesota's local `bun run check` passed after the live run: typecheck, compiled
  CLI behavior, 499 tests across 37 files, and Oxlint. This check evidence is
  separate from the live provider/Docker observation.
