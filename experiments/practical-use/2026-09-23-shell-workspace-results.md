# Shell workspace live walkthrough: observed results

This was a diagnostic walkthrough of the ordinary compiled Tesota shell on
Windows x64 with Bun 1.4.2, Node 24.15.0, saved Codex authentication and the
locally available pinned Docker image. Tesota source was at
`591ea17a4be0068f7359fa06340cf1b3f61292fb`. The first self-task used a
compiled CLI built before the final small source changes in that revision; the
CLI was rebuilt before recovery inspection and the external task. That first
run is diagnostic, not an exact-build qualification. Clones were under
`Sequel/cloned`; task candidates and local session records stayed in Tesota's
own operator state. No original reference clone was modified.

## Observed attempts

| Task | Workspace behavior | Outcome and independent assessment |
| --- | --- | --- |
| Public [`thinking-orbs` issue 16](https://github.com/Jakubantalik/thinking-orbs/issues/16), baseline `de85557ca220332586d070d8788c0e1d6e877a0d` | The first request stopped and sought missing preset criteria. A clarified request produced a proposal, but the fixed TypeScript profile found no eligible check: the repository used `package-lock.json`, had no `bun.lock`, and did not expose the exact required script. | No approval, candidate or application; the clone stayed clean. The inspector and shell prematurely said “Proposal ready” before eligibility refusal. This is a supported refusal observation, not a successful issue fix. |
| Local Tesota self-task, baseline `591ea17a`, proposal `510287df-f1f2-4194-9ef4-ff96408bb145` | Session 1 waited for scope approval while another session answered a read-only question; returning to session 1 preserved its approval target. A separate failed query exposed stale “Inspecting” progress and session restart on selection. After approval, the candidate changed two shell source files. | Execution failed after an initial no-change check and later model timeout. No review or application occurred; source clone stayed clean. Astra found that the candidate left an existing shell test expecting the old wording. A separate checkout with the candidate files confirmed 16 passing and one failing shell test. The candidate is retained but should not be applied. Normal restart reconstructed the failure and session history. |
| Public [`gentle-shell` issue 1355](https://github.com/Gentleman-Programming/gentle-shell/issues/1355), clean local `gentle-pi-shell-live` clone at `5df9590e55b68717ea0cf8760eb9771c1dc9ed2b` | Session 1 proposed `lib/openspec-deltas.ts` and `tests/openspec-deltas.test.ts`. While its approval was pending, session 2 answered a read-only source question. Returning to session 1 preserved the approval target. The candidate removed the multiline flag from the trailing-divider replacement and added a regression for an internal `---` plus a trailing separator. | Final contained `node-test-targeted/v1` passed. A separate baseline clone with only the candidate test failed that new regression (8 pass, 1 fail); the candidate and applied clone passed 9/9. Astra independently reviewed the exact diff against the issue and repository guidance and found no issue within this scope. The operator accepted; Tesota reported `promoted`, `Decision: accept`, `Application: Applied`. Only the two admitted files changed, their source SHA-256 values matched the reviewed candidate (`bb66ea81ef4a06a53220c0f68de03fcd87d2f7dff19ac972ff0bc5e6f42381e2`, `533f0f43db3daf9fe6e375872c16086f7980d8fdf51a17c1eaa109f787b1895d`), and `git diff --check` passed. Normal restart reconstructed the promoted outcome. |

The accepted Gentle candidate took 295,610 ms through promotion and reported
13 model invocations, 12 tool calls, 3 edits and 11 host checks. Approval and
review waits are included. Active operator time and monetary cost were not
independently captured. The public issue linked an existing proposed fix;
the task is answer-exposed and cannot serve as a held-out usefulness benchmark.
The independent review covered the bounded two-file change and regression,
not the repository's full CI or broader behavior.

## Shell findings and limits

The narrow 80-column terminal and two-session approval binding were exercised
with real tasks. A normal restart restored both settled and failed outcomes
without reviving a pending grant. The stale progress and session-restart defect
found in the failed query is fixed in the following source change and covered
by focused tests; this live run predates that fix. Wide split view, interrupted
restart, cross-session cancellation, overlapping applications and source-drift
conflict were not exercised live. Automated coverage and this walkthrough do
not yet satisfy the full [shell qualification criteria](../../docs/qualification.md#continuous-conversation-and-context).
