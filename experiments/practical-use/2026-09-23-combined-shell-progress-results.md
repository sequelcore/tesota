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
