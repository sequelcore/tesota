# Codex experiment history

This record consolidates useful source tracing and validation observations from
the bootstrap README and operator reports. Test counts describe their original
increments, not fresh checks. Historical artifacts remain unchanged; use the
[live guide](README.md) for current behavior and the [roadmap](../../docs/roadmap.md)
for milestone status.

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
remain excluded. See the [diagnostic contract](README.md#provider-diagnostics).

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
