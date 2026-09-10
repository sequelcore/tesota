# Codex experiment

This Windows-only diagnostic checks one normal model turn and one observed
cancellation through Pi. It runs no executable tools and grants no task acceptance.
See [history](history.md) for earlier results and the [roadmap](../../docs/roadmap.md)
for project status.

## Normal use

Build, log in once, then run the experiment:

```sh
bun run build
bun start auth login
bun run live:codex
```

Login uses the intended account's device-code authorization. Subsequent experiments
reuse Tesota's saved login and Pi's automatic token refresh. They can run in a
captured terminal without printing authentication codes. See
[authentication](../../docs/authentication.md) for status, logout and storage limits.

`live:codex` selects `--full-probe --stored`. A missing or unusable credential
fails without automatically starting login or changing provider/model. Successful
credential resolution does not establish model entitlement or server-side cancellation.

Each run creates a unique timestamp/UUID JSON file under
`experiments/codex/runs/`, relative to the working directory. The CLI creates the
directory and prints the output path. Files are exclusively reserved before
inference; existing evidence is never overwritten. No manual directory setup is
needed. The runs directory is ignored by Git; retain selected sanitized records
with their interpretation when an experiment warrants durable evidence. An ignore
rule does not make files private. A crashed process can leave an incomplete record.

## Explicit authentication diagnostics

The separate `bun run live:codex:device-code` command forces a fresh, in-memory
device login followed by the same probes. It does not replace saved credentials.
For login-only diagnostics, use the compiled entry with `--auth-only --device-code`.
Both require an interactive unrecorded terminal. Normal login belongs to
`tesota auth login`; these modes exist to test the isolated interaction.

`--full-probe --browser` retains the legacy browser-callback diagnostic. It does
not persist credentials or accept manual callback input. Browser launch is not
proof that navigation or callback completion occurred.

All modes support offline `--help`. Normal `bun run check` uses synthetic provider
boundaries and never authenticates against the live service.

## Bounds and outcomes

The fixed route is `openai-codex`, `openai-codex-responses`, and
`gpt-5.3-codex-spark` over SSE. There is no provider, model, account or API-key
fallback. The installed Pi request builder omits `maxTokens`; Tesota has no
established 64-token output ceiling.

Each probe admits one Models stream invocation. A continuation attempt fails;
there are no retries or executable tools. The experiment admits at most two
model invocations total, not an independently measured HTTP-request count.

Authentication/resolution has a 180-second application deadline. Each turn has a
30-second whole-turn deadline and a two-second abort settlement window. The full
process watchdog is 249 seconds; login-only diagnostics use 185 seconds. These
timers assume a responsive event loop. Process exit does not prove remote cancellation.

The normal probe's concatenated, trimmed text must equal `TESOTA_CODEX_OK`.
Pi `thinking` blocks are allowed alongside that text; tool calls and all other
block types are rejected. It also requires an observed `stop` terminal,
no abort, one admitted invocation/attempt and no exceeded limits. The abort probe
must observe content, request cancellation, then observe an `aborted` terminal.
An abort request alone is insufficient. Missing settlement remains unconfirmed;
late events cannot upgrade returned evidence. A failed normal probe prevents the
abort probe from running. Exit 0 requires both probes to pass independently.

## Evidence and diagnostics

New records use `tesota-codex-evidence` version 9. It adds `thinkingBlockCount`
and allows Pi reasoning alongside the exact answer text. Version 8 added response
diagnostics without changing probe acceptance. Version 7 added `stored` authentication
and source/build identity for the credential adapter. For that method,
`authenticationOutcome: succeeded` means Pi resolved request authentication,
including any required refresh; it does not mean a new browser login occurred.
Historical records retain their original bytes, formats and captured identities.

The serializer captures twelve fixed source/build/config hashes and accepts only
identities captured by its own implementation. Hashes identify observed files;
they do not attest the machine or authenticate a producer. No model text, tokens,
credential contents, headers, raw exceptions or provider bodies enter evidence.

| Diagnostic | Meaning |
| --- | --- |
| `httpStatus` | Integer 100–599 observed through Pi's public `onResponse`, otherwise null |
| `failureStage` | `response_not_observed`, `http_rejection`, `after_response`, or null |
| `providerErrorCode` | Null; no validated structured code is available through this boundary |

`responseDiagnostic` records whether a final assistant message was observed,
the counts of text, non-text and thinking blocks, and whether concatenated, trimmed text
matches the fixed token. This distinguishes text mismatch from extra non-text
content without retaining either. Thinking blocks are included in the non-text
count. Pi's locked Responses adapter maps provider reasoning items to `thinking`,
including empty summaries with opaque signatures. These are separate from answer
text. The comparator permits only text and thinking; reasoning cannot substitute
for a missing or incorrect answer, and no reasoning content or signature is saved.

An HTTP 403 does not prove missing entitlement; 429 does not identify a quota;
null does not prove no request; 200 does not prove successful stream completion.
Diagnostics do not participate in authorization or probe acceptance.
`inferenceAttempted` is the forbidden AUTH-ONLY inference latch. Ordinary admitted
calls use `modelInvocationCount`; all task acceptance remains `not_evaluated`.
