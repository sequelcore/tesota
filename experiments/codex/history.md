# Codex experiment history

This page consolidates source tracing and validation observations from the
bootstrap README, operator reports and retained runs. Test counts describe their
original increments, not fresh checks. Historical artifacts remain unchanged;
use the [live guide](README.md) for current behavior and the
[roadmap](../../docs/roadmap.md) for milestone status.

## Candidate correction

Three bounded live runs on 2026-09-10 UTC established the
[one-file correction contract](candidate.md):

- [Version 1](evidence/candidate-denied.json) denied verification requests and
  reached its invocation budget without a check or edit. Its record does not
  retain the requested input values. The next implementation made the exact
  admitted logical input explicit in the tool schema and prompt.
- [Version 2](evidence/candidate-newline.json) completed the failed-check, edit,
  recheck and model-continuation sequence. It retained both checks and a diff;
  the original evidence became stale and the corrected source's evidence was
  applicable. Its exact-source assertion nevertheless rejected an omitted final
  newline. That presentation detail was not part of preserving the exported value.
- [Version 3](evidence/candidate-passed.json) passed after the task assertion
  explicitly allowed an optional final LF. It used four model invocations, three
  tool attempts, one edit and two verifier executions. The final diff removed
  only `debugger;`, preserving `export const value = 1;`. No deadline or budget
  was exceeded; the CLI exited 0.

Each retained run's 27 captured implementation hashes matched before subsequent
source changes. Before the passing live run, `bun run check` passed build,
typecheck, 168 tests and lint on Windows. Regression coverage accepts either
final-newline form and rejects missing exports, changed values, extra source,
stale hashes, oversized edits, concurrent operations, external changes and hard
links. Evidence hashes still distinguish exact bytes regardless of the task oracle.

Both final-run check records were reloaded through the durable store: the first
remained `check_failed` and stale, the second remained `passed` and applicable.
Recovery retained `recovered_untrusted` provenance. Full check records, original
and candidate source, and the diff remain in the original ignored run directory;
only sanitized probes are copied here. No repository checkout was promoted, and
this fixed exercise is not the first real Tesota self-development task.

## Live verification tool

The [verification probe](evidence/verification-probe.json) at
2026-09-10T07:40:00.526Z reused saved authentication and completed two model
invocations. Spark requested `tesota_verify` for the fixed fixture. Tesota
admitted one execution; the real Oxlint process exited with `check_failed` for
the intended `no-debugger` violation. Pi supplied the bounded result to the
continuation, which ended with `stop` and the expected answer. No deadline or
invocation budget was exceeded; the CLI exited 0.

All 23 captured source/build/config/fixture hashes matched the executed checkout.
Before that one live attempt, `bun run check` passed build, typecheck, 155 tests
and lint on Windows. The local durable verification record was reloaded through
the store and remained applicable with `recovered_untrusted` provenance. This
does not turn recovery into issuance authority.

Only sanitized `probe.json` is retained here. Its `verification.json` reference
names the sibling saved in the original ignored run directory; that full record
contains local paths and is intentionally not copied into this evidence folder.
The [operating contract](verification.md) distinguishes model completion, detected
lint failure, saved evidence and human acceptance. No source editing or broader
agent task execution was exercised.

## Response diagnostic

The [version 8 run](evidence/response-diagnostic.json) on 2026-09-10 UTC
resolved saved authentication and completed one invocation with HTTP 200 and
terminal `stop`. Its final message contained one text block and one non-text
block. The concatenated, trimmed text matched `TESOTA_CODEX_OK`; the exclusive
text-block requirement caused the assertion failure. The diagnostic does not
identify the non-text block's type or content, and does not establish why the
earlier version 7 run failed.

The process exited 1 and did not start the abort probe. All twelve captured
implementation hashes matched the executed checkout. Before this single live
attempt, `bun run check` passed build, typecheck, 142 tests and lint on Windows.
Acceptance criteria were unchanged in that run. The next step was to establish which
non-text content Pi produces and define the normal-response contract accordingly;
the observation alone does not justify accepting arbitrary non-text blocks.

## Response contract correction and passing probe

The locked Pi 0.85.1 Codex adapter uses `processResponsesStream` in
`openai-responses-shared.js`. That parser creates a `thinking` block for each
provider reasoning item, including items without a visible summary. Reasoning
is separate from the answer text, so requiring exclusively text blocks rejected
an otherwise valid answer. Version 9 permits text and thinking blocks only;
joined, trimmed text must still match the token. Tool calls and unknown block
types remain rejected. Thinking cannot satisfy the text assertion.

The [passing saved-login run](evidence/stored-probe-passed.json) on
2026-09-10 UTC confirmed one text block matching the token and one thinking
block. The normal probe passed. The second probe observed a content update,
requested abort and observed Pi's `aborted` terminal. Both returned HTTP 200,
with one invocation each, no tool executions and no exceeded limits. The CLI
exited 0; all twelve captured source/build/config hashes matched the checkout.

`bun run check` passed build, typecheck, 146 tests and lint on Windows. The
focused response tests and typecheck were repeated after strengthening the
tool-call fixture. Coverage includes empty reasoning with an opaque signature,
incorrect or absent answer text, unknown blocks and tool-call rejection.
No response text or reasoning signatures entered retained evidence. This proves
the bounded local probe contract, not server-side cancellation, live refresh,
agent task execution or human acceptance.

## Saved-login probe

On 2026-09-10 UTC, an operator-authorized run on `3a6eff6e` reused saved login
without another browser interaction. The [record](evidence/stored-probe.json)
resolved authentication successfully and admitted one model invocation. It
observed HTTP 200, a content update, terminal `stop`, and normalized `completed`.
No tool execution, timeout or invocation-budget violation occurred.

The exact-response assertion failed, so the abort probe was not started and
the process exited 1. All twelve captured implementation hashes matched before
any changes. This verifies stored credential use and a completed live model turn,
not successful completion of the full experiment or a token refresh.

The record does not retain response text or content-block types. The comparator
requires every content block to be text and the joined text to equal the expected
token. This result therefore cannot distinguish unexpected text from an additional
non-text block. No retry was performed and acceptance criteria were not changed.

## Reference source

Pi 0.85.1 was inspected at `d981de1229ef899957bbe968bc8dcda02a21f477`.
The relevant files are `packages/ai/src/models.ts`, `auth/helpers.ts`,
`providers/openai-codex.ts`, `auth/oauth/openai-codex.ts` and
`api/openai-codex-responses.ts`. Installed JavaScript confirmed the consumed path.
Public `Models.login` performs authentication and stores the result without
requiring inference. The same authenticated Models instance reaches streaming.

Codex source was separately inspected at
`885113aa1d68ccbc567b83698feac3cd42163088`. Its
`codex-rs/cli/src/login.rs` waits for login completion;
`codex-rs/login/src/server.rs` distinguishes callback settlement from cancellation.
Its credential persistence and callback metadata differ from Pi's public boundary.
Codex was a reference, not an installed Tesota dependency.

These are fixed historical observations. Reference-clone branch positions and
fetch troubleshooting are not prerequisites for reproducing a fixed-source review.

## Browser experiments

The [corrected browser full probe](evidence/browser-probe.json) failed before either
model probe ran: zero invocations, null probes and disposition `failed`. The
operator reported exit 1. The v1 record lacks a specific OAuth failure category;
no retained evidence establishes its root cause.

Before that attempt, local Windows checks reportedly passed 68 tests, build,
typecheck, lint and compiled offline smokes. Seven restored mutations exercised
request limits, ineffective abort, false abort success, deadline handling,
prompt leakage, excessive evidence fields and abort/content ordering.

The later [browser AUTH-ONLY record](evidence/browser-auth.json) reports
unconfirmed authentication at the local OAuth deadline, with no inference.
A timeout establishes missing observed settlement by that deadline; it does not
establish whether the browser navigated, the callback arrived or exchange began.

AUTH-ONLY offline checks reportedly passed 95 tests. They exercised denied Models
and provider inference entry points, timeout/launcher observation ordering,
source identity rejection and compiled process exit. Restored mutations to the
early return, stream guard and identity check were detected. These observations
did not establish live authentication.

## Device-code authentication

The device-code increment reused Pi's public interaction: select `device_code`,
then display only the validated website and temporary user code. Pi retained
ownership of polling, exchange and the in-memory credential store.

Offline checks reportedly passed 114 tests, including synthetic public login,
terminal refusal, timeout/cancellation, late notification rejection and exclusive
output reservation. Restored mutations detected admitted inference and user-code
leakage. A simulated terminal was not treated as live provider evidence.

The subsequent [device-code AUTH-ONLY record](evidence/device-auth.json)
reports successful login with zero invocations and null probes. Its reported
independent artifact validation matched all ten source/build hashes before
rebuilding. Implementation: `8ed3d49bc0570062f604728a8ff963307fe27fdf`;
evidence-only commit: `54a90810392b45f3bdcbe8e3ba0d9eeafd490f64`.
This establishes the recorded authentication outcome, not model availability
or task acceptance.

## Failed device-code full probe

The [v4 full-probe artifact](evidence/device-probe.json) records
successful authentication and one admitted Models invocation ending in `error`.
There were no content updates, tool starts, deadline/budget violations or abort
probe. The operator separately reported exit 1; the JSON does not contain the
process exit code.

Before rebuilding, all ten recorded hashes reportedly matched the files on disk;
tracked inputs matched `9539f61c1395a0a2f1c9ed0f5f064e0290433006`.
The artifact matched the serializer's exact shape and sanitization contract.
Evidence-only commit: `52c7d390`.

The historical HTTP status, account entitlement, model availability and cause
remain unknown. Source/build matching binds observed file contents; it does not
independently attest the provider exchange.

## Diagnostic correction

Correction `1ae392f8` added numeric HTTP status and fixed observation categories
through Pi's public `onResponse` boundary. Headers, bodies and raw error strings
remain excluded. See the [diagnostic contract](README.md#evidence-and-diagnostics).

Tracing confirmed that the authenticated Models instance reaches SSE and that
AUTH-ONLY inference guards are installed only in that mode. The historical
`inferenceAttempted` field is the forbidden AUTH-ONLY inference latch, not the
ordinary invocation counter; its false value does not negate the recorded call.

A separate documentation defect was identified: Pi's `buildBaseOptions` carries
`maxTokens`, but the locked Codex request builder omits it. The unsupported
64-token ceiling claim was removed. This does not explain the historical failure.

Offline checks reportedly passed 131 tests, build, typecheck, lint and compiled
smokes. Regressions exercised HTTP rejection, errors after HTTP 200, missing
response observation, secret exclusion, normal completion, observed abort and
suppression of the second probe after failure. They used synthetic public login
and per-request transport boundaries, not a live service. No successful second
full-probe record is retained in this repository.

## Read-only shell walkthrough, 2026-09-21

A local Windows PTY walkthrough of the compiled CLI used
`openai-codex/gpt-5.6-luna` against `sindresorhus/yoctocolors` at
`a85b98a90e5731914567d8c209e7ec45ac2d24e2`. It completed a multiline
list, a contextual correction with paragraphs and a code block, cancellation,
and a follow-up retaining the corrected subject. The final message remained
visible; the process exited 0. The run used local changes over `99209bef`.
The accompanying local gate passed typecheck, compilation, lint and 498 tests
across 37 files. This observed walkthrough does not establish general
reliability, explain earlier unavailable turns or qualify repository task work.
