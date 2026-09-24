# Combined-check shell-progress diagnostic: observed results

This record follows the [first frozen protocol](2026-09-23-combined-shell-progress-protocol.md).
The selected defect is real, but the target is a Tesota clone with a committed
Node-native test fixture. It is an internal diagnostic, not external-repository
usefulness evidence. Retain both the failed first attempt and any later result.

## First ordinary-shell attempt

Baseline `8deaad1adf27f52385415a8e33a9df5c44119282` contained a test
fixture that Node could run but the repository typecheck could not compile:
its static `.ts` import produced TS5097. Tesota showed both profiles eligible,
selected the Node test and TypeScript typecheck before approval, and admitted
only `src/shell-progress.ts` and `tests/shell-progress-node.test.ts` for writes.
The candidate added the requested assertion and a narrow operation-specific
label branch. Independently, the final test failed against the original source
with the old scope-approval label and passed against the candidate (1/1).
Existing assertions stayed in place.

The retained Tesota attempt had an observed red Node check, a green Node check
on the repaired candidate, and an **operationally failed** TypeScript check.
It reported `output_limit` with process exited and container absent. The task
ended `execution_failed` after eight model invocations, eight tool calls and
two edits. It never reached review or a human decision; no application
occurred. The candidate's behavioral fix cannot be accepted through this
failed attempt.

Read-only Docker diagnosis found that TypeScript 7.0.2's Go compiler exhausted
the fixed 32-process container limit at its 33rd thread and emitted a large
runtime stack trace. A bounded 128-process, two-CPU, 1024 MiB typecheck
invocation reached the ordinary TS5097 diagnostic in about 22 seconds. A
64-process variant hit its 65th thread; a 128-process, 512 MiB variant timed
out in a 70-second diagnostic probe. These observations justify the scoped
policy adjustment but do not establish minimum general limits. The 60-second
compiler limit, output cap, read-only mounts, no network, dropped privileges
and cleanup behavior were retained. The changed policy has a new identity and
requires fresh approval.

The baseline fixture was then corrected in a **new committed baseline** using
a dynamic URL import with a `.js` type query. The corrected baseline passed its
Node test and, using the adjusted policy, the actual contained TypeScript
adapter passed with observed process exit and container absence. That preflight
took several minutes including dependency snapshot preparation; it did not
retroactively validate the first attempt.

## Second ordinary-shell attempt

The [retry protocol](2026-09-23-combined-shell-progress-retry.md) used the
corrected committed baseline `575b58e81aa639cdb2b2343fe00b253bd4673d43`.
Both checks were selected and approved in a fresh session. The agent recorded
the unchanged initial check, added the regression, observed its Node failure
(0 passed, 1 failed), and made the narrow source repair. An independent copy
of the committed source with the candidate's new test also failed on the
correction-specific assertion, preserving the red oracle.

The third check did not return. Dependency snapshot preparation for the
TypeScript check was still in progress when the five-minute cumulative agent
window expired. The two-second settlement wait ended with the tool effect
unconfirmed. The retained attempt in candidate
`f124b3cc-7091-4668-aa58-6cd3c2becf8e` reports `unsettled`, eight model
invocations, eight tool calls, two edits and 300000 ms active time; its final
check and current review check are absent. No review decision or application
occurred. This remains a failure even though the candidate diff resembles the
desired repair. A fresh session and candidate are required for another attempt.

The contained TypeScript preflight had passed on this baseline, so the next
change gives only the preapproved Node-plus-TypeScript task a bounded ten-minute
cumulative agent-session window. The individual contained check limits,
settlement allowance and other task budgets remain fixed. This is a provisional
limit for another qualification, not evidence that the combined flow succeeds.

## Third ordinary-shell attempt

The [third protocol](2026-09-23-combined-shell-progress-third-protocol.md)
used the same clean committed baseline, a fresh session and both selected
checks. The agent observed the unchanged initial candidate, an intentionally
red Node regression (0 passed, 1 failed), then a green Node test and TypeScript
typecheck on its final two-file candidate. Its session completed with observed
settlement, nine model invocations, eight tool calls, two edits and 497359 ms
active time. Astra's independent diff review found the intended operation
branch and regression assertion with other labels preserved.

The host's fresh final check ran on the same candidate and selected verifier
inputs, but TypeScript failed operationally with `output_limit`; Node passed.
The attempt ended `execution_failed` after 1027223 ms wall time, with one host
check and no human decision or application. The candidate remains retained at
`31583ae8-3f6c-439a-8627-420dc6ad3a6d` and cannot be accepted through
this attempt. The second dependency snapshot dominated the time outside the
agent-session budget.

A separate read-only Docker reproduction against that retained candidate
mounted the source installation directly rather than using Tesota's dependency
snapshot. With the same 128-process, two-CPU, 1024 MiB restrictions, it exited
with a 1.28 MB Go runtime trace: it failed to create OS thread 129 (`errno=11`).
This reproduced a failure mechanism consistent with the host's output cap
failure; that host run's discarded output prevents definitive attribution.
Adding `GOMAXPROCS=2` to an otherwise identical diagnostic container
made the TypeScript check exit zero with empty output. This is a policy
qualification input, not a retroactive pass or proof of repeatability.

The actual snapshot-backed adapter preflight with `GOMAXPROCS=2` still failed
with `output_limit` after 325841 ms; process exit and container absence were
observed. No fourth model attempt followed. A manual run against an
independently copied snapshot passed once, so that single pass did not explain
the intermittent failure. Five serial direct-mount trials with the 128-process
limit and `GOMAXPROCS=2` then produced four failures at thread 129 and one
pass. The same candidate passed five of five trials with a 256-process limit,
both with and without `GOMAXPROCS=2`. This supports a new bounded 256-process
policy without the ineffective environment override. It still needs an actual
snapshot-backed adapter pass and a fresh approval before another model trial.

Two consecutive actual adapter checks then ran against the retained candidate,
each with a separate dependency snapshot and the 256-process policy identity
`1b123c771bcc2444d52bf653c74fd7368e4ca336a5c9ae60695bebf3ffeab974`.
Both passed with empty diagnostics, observed process exit and container
absence, in 295586 ms and 296398 ms respectively. This qualifies the profile
for another bounded attempt on this machine; it does not accept the retained
candidate or prove repeatability on other repositories or platforms.
