# Supported task fifth follow-up qualification

Selected on 2026-09-19 (America/Hermosillo), before submission to Tesota.
This is a new bounded input-validation task, not a retry of the earlier corpus
or the user-requested replay of the absent-limits fix. Those outcomes remain
separate. Selection used inspected source, not a random sample or an upstream
issue; no claim of an observed production exploit is made.

## Frozen task

Repository: `https://github.com/hraness/sysone.git`

Baseline: `862beb481157bfd5f53893bfea612610b23b29a0`

Verbatim request:

> Harden `readBoundedText` in `src/http.ts`: reject a `maxBytes` value that is
> not a non-negative safe integer with `RangeError` before accessing the body
> or acquiring its reader, including when the body is null. Keep zero valid.
> Preserve valid-budget UTF-8 decoding, byte-based overflow cancellation and
> caller-abort behavior. Do not change other files.

The baseline compares accumulated bytes directly with an unchecked number:
`NaN` and infinity do not enforce a finite ceiling. Existing callers supply
valid constants; this task hardens the helper's input contract rather than
claiming an existing caller supplies an invalid limit. The bound follows the
[ECMAScript safe-integer definition](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger).
Acquiring a reader locks a stream under the
[Streams standard](https://streams.spec.whatwg.org/#rs-get-reader), so invalid
arguments must be rejected before that effect.

## Frozen execution and oracle

Use a new independent Windows x64 clone at the baseline, leaving tracked files
unchanged. Provision the root lockfile with Tesota's Bun 1.4.2 using
`bun install --frozen-lockfile --ignore-scripts --omit optional --os=linux --cpu=x64`.
This evaluation toolchain differs from SysOne's declared Bun 1.3.14; it is not
SysOne release qualification. The repository's portable TypeScript 6.0.3 is
checked through Tesota's existing pinned Docker profile. Run a preflight before
submission, then one ordinary Tesota Shell request with unchanged model, tool,
edit, check and time budgets. No retry, prompt adaptation, reference patch,
custom model tool, repository filter or new runtime authority is admitted.

The evaluator-only [behavioral oracle](http-limit-oracle.mjs) is frozen before
submission and is not supplied to the task model. Run it against the baseline
and the exact candidate using Node 24.15.0 with `--experimental-transform-types`
for the baseline's parameter property. Plain strip-only Node cannot load that
syntax; this evaluator setup error was corrected before task submission. The
flag is an experimental evaluator dependency, not a new product runtime path.
The oracle covers invalid limits with null
and observable bodies, zero, exact byte bounds, split UTF-8, overflow
cancellation and caller abort. All cases must pass for a favorable behavioral
assessment. The baseline must fail the invalid-limit cases; unchanged valid
behavior must pass. The oracle does not replace the fixed task check, full
integration testing or a maintainer review.

Retain exact source, oracle, candidate, check and review hashes, setup and
elapsed observations, operation counts, unknown costs, intervention, human
acceptance, application and settlement. A failure remains a failure and cannot
be replaced by a different request in this protocol. Human acceptance of the
exact result is required before application. Delivery retains the later
protocol's one maintainer-coordinated PR review; no additional agent review is
requested. This case alone does not establish general coding reliability.
