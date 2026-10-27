# Proved rules

To prove one rule again from the repository root, run:

```sh
lsc check --backend=dafny src/verification/gate-rule.ts
```

These are the rule files selected by `formal:check` in
[package.json](../../package.json). Each contains pure TypeScript decisions
with LemmaScript contracts checked by Dafny. These proofs use
[LemmaScript's model of TypeScript](../concepts/verification.md#what-a-proof-covers),
whose numeric and other semantics can differ from JavaScript at runtime.
A proof covers those contracts;
it does not establish that callers supply the right facts or that the
contracts express every requirement. See [Development](../development.md)
for dependencies and proof regeneration.

Run `bun run formal:check` to check the full list.

| File | What it decides | Re-prove |
| --- | --- | --- |
| [`src/verification/mark-bloom-rule.ts`](../../src/verification/mark-bloom-rule.ts) | Whether the visual mark blooms for the receipt standing | `lsc check --backend=dafny src/verification/mark-bloom-rule.ts` |
| [`src/verification/check-origin-rule.ts`](../../src/verification/check-origin-rule.ts) | Whether reports show a test failure introduced by the change | `lsc check --backend=dafny src/verification/check-origin-rule.ts` |
| [`src/verification/comment-line-rule.ts`](../../src/verification/comment-line-rule.ts) | Whether a parsed line contains only a comment | `lsc check --backend=dafny src/verification/comment-line-rule.ts` |
| [`src/verification/proof-cover-rule.ts`](../../src/verification/proof-cover-rule.ts) | Whether a changed line lies within a proved, unnarrowed contract | `lsc check --backend=dafny src/verification/proof-cover-rule.ts` |
| [`src/verification/range-rule.ts`](../../src/verification/range-rule.ts) | How sorted line numbers form consecutive ranges | `lsc check --backend=dafny src/verification/range-rule.ts` |
| [`src/verification/selection-rule.ts`](../../src/verification/selection-rule.ts) | Which functions LemmaScript includes in a proof | `lsc check --backend=dafny src/verification/selection-rule.ts` |
| [`src/verification/proof-outcome-rule.ts`](../../src/verification/proof-outcome-rule.ts) | Whether a proof passed, failed, verified nothing or could not finish | `lsc check --backend=dafny src/verification/proof-outcome-rule.ts` |
| [`src/verification/gate-rule.ts`](../../src/verification/gate-rule.ts) | Which calls may change files and which check results return to the agent | `lsc check --backend=dafny src/verification/gate-rule.ts` |
| [`src/verification/fingerprint-rule.ts`](../../src/verification/fingerprint-rule.ts) | Which repositories and paths changed and whether history permits attribution | `lsc check --backend=dafny src/verification/fingerprint-rule.ts` |
| [`src/verification/weakening-rule.ts`](../../src/verification/weakening-rule.ts) | Whether annotation or check-script changes may weaken evidence | `lsc check --backend=dafny src/verification/weakening-rule.ts` |
| [`src/verification/project-rule.ts`](../../src/verification/project-rule.ts) | Which projects and check scripts are selected and which project owns a path | `lsc check --backend=dafny src/verification/project-rule.ts` |
| [`src/verification/mutation-rule.ts`](../../src/verification/mutation-rule.ts) | Whether a mutation is rejected, survives or is proved equivalent | `lsc check --backend=dafny src/verification/mutation-rule.ts` |
| [`src/verification/footer-rule.ts`](../../src/verification/footer-rule.ts) | What verification is available and how elapsed time and footer layout are shown | `lsc check --backend=dafny src/verification/footer-rule.ts` |
| [`src/verification/test-weakening-rule.ts`](../../src/verification/test-weakening-rule.ts) | Whether test edits remove checks, loosen assertions or only extend safe lists | `lsc check --backend=dafny src/verification/test-weakening-rule.ts` |
| [`src/verification/verdict-rule.ts`](../../src/verification/verdict-rule.ts) | How findings, path coverage and evidence determine receipt standing and color | `lsc check --backend=dafny src/verification/verdict-rule.ts` |
| [`src/verification/change-category-rule.ts`](../../src/verification/change-category-rule.ts) | Whether changed lines count as implementation, tests or other | `lsc check --backend=dafny src/verification/change-category-rule.ts` |
| [`src/verification/model-rule.ts`](../../src/verification/model-rule.ts) | How design model runs, planted faults, reuse and staleness are classified | `lsc check --backend=dafny src/verification/model-rule.ts` |
| [`src/verification/group-count-rule.ts`](../../src/verification/group-count-rule.ts) | Whether model graph grouping preserves state, violation and edge totals | `lsc check --backend=dafny src/verification/group-count-rule.ts` |
| [`packages/core/src/budget-rule.ts`](../../packages/core/src/budget-rule.ts) | Whether a measurement stays within its limit in either of two attempts | `lsc check --backend=dafny packages/core/src/budget-rule.ts` |
| [`packages/core/src/truncate-rule.ts`](../../packages/core/src/truncate-rule.ts) | How many output lines fit within line and byte limits | `lsc check --backend=dafny packages/core/src/truncate-rule.ts` |
| [`packages/core/src/edit-rule.ts`](../../packages/core/src/edit-rule.ts) | Whether exact-text edits can apply together without overlap | `lsc check --backend=dafny packages/core/src/edit-rule.ts` |
| [`packages/core/src/reconcile-rule.ts`](../../packages/core/src/reconcile-rule.ts) | What recovery records for unfinished calls without replaying them | `lsc check --backend=dafny packages/core/src/reconcile-rule.ts` |
| [`packages/core/src/settle-rule.ts`](../../packages/core/src/settle-rule.ts) | Whether a run continues, reaches verification or ends | `lsc check --backend=dafny packages/core/src/settle-rule.ts` |
| [`packages/core/src/permission-rule.ts`](../../packages/core/src/permission-rule.ts) | Whether the permission floor, mode and matching rules allow a call | `lsc check --backend=dafny packages/core/src/permission-rule.ts` |
| [`packages/core/src/subpath-rule.ts`](../../packages/core/src/subpath-rule.ts) | How guarded subpaths climb and how Windows dot/space segments normalize conservatively | `lsc check --backend=dafny packages/core/src/subpath-rule.ts` |
| [`packages/core/src/compact-rule.ts`](../../packages/core/src/compact-rule.ts) | When to summarize conversation and where its verbatim tail starts | `lsc check --backend=dafny packages/core/src/compact-rule.ts` |
| [`packages/core/src/catalog-rule.ts`](../../packages/core/src/catalog-rule.ts) | How much context instruction files and the skill catalog may use | `lsc check --backend=dafny packages/core/src/catalog-rule.ts` |
| [`packages/core/src/invocation-rule.ts`](../../packages/core/src/invocation-rule.ts) | Whether you or the model may start a skill | `lsc check --backend=dafny packages/core/src/invocation-rule.ts` |
| [`packages/core/src/questions-rule.ts`](../../packages/core/src/questions-rule.ts) | Whether questions, attempts and answers fit the interaction bounds | `lsc check --backend=dafny packages/core/src/questions-rule.ts` |
| [`packages/core/src/agent-rule.ts`](../../packages/core/src/agent-rule.ts) | Whether a subagent may start and which permissions and branch guard it receives | `lsc check --backend=dafny packages/core/src/agent-rule.ts` |
| [`packages/core/src/handback-rule.ts`](../../packages/core/src/handback-rule.ts) | Whether a Claude Code query can continue with the recorded tool results | `lsc check --backend=dafny packages/core/src/handback-rule.ts` |
| [`packages/core/src/account-rule.ts`](../../packages/core/src/account-rule.ts) | Which settings and agent types still name an account before removal | `lsc check --backend=dafny packages/core/src/account-rule.ts` |
| [`packages/core/src/resume-model-rule.ts`](../../packages/core/src/resume-model-rule.ts) | Which model an explicit, resumed or default print request uses | `lsc check --backend=dafny packages/core/src/resume-model-rule.ts` |
| [`src/verification/request-context-rule.ts`](../../src/verification/request-context-rule.ts) | Which earlier requests since the last verification are judged, and whether a complete judge prompt fits its model's context | `lsc check --backend=dafny src/verification/request-context-rule.ts` |
| [`packages/core/src/usage-rule.ts`](../../packages/core/src/usage-rule.ts) | How account usage is rounded, drawn, colored and deduplicated | `lsc check --backend=dafny packages/core/src/usage-rule.ts` |
| [`packages/core/src/doctor-rule.ts`](../../packages/core/src/doctor-rule.ts) | Whether a found tool passed its smoke test, and any-failure-over-core-unavailable exit precedence | `lsc check --backend=dafny packages/core/src/doctor-rule.ts` |
| [`packages/core/src/provider-retry-rule.ts`](../../packages/core/src/provider-retry-rule.ts) | Whether normalized provider classification, retry count and elapsed time permit a model-call retry, including its full wait | `lsc check --backend=dafny packages/core/src/provider-retry-rule.ts` |
