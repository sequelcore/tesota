# Live Codex experiment

This Windows-only diagnostic checks login, a normal model turn, and observed
cancellation through Pi. It does not execute agent tasks or verification tools.
See [project status](../../docs/roadmap.md) and [retained evidence](../README.md) for what
has been demonstrated.

## Commands and effects

Run `bun run build` from the repository root first. Normal `bun run check`
does not authenticate or call a live provider. This help command is offline:

```sh
bun --no-env-file dist/live-codex.js --help
```

| Script | Compiled arguments | Effects | Evidence filename under `experiments/codex/evidence/` |
| --- | --- | --- | --- |
| `bun run auth:codex` | `--auth-only --device-code` | Login; zero inference | `device-auth.json` |
| `bun run live:codex:device-code` | `--full-probe --device-code` | Login; up to two model invocations | `device-probe.json` |
| `bun run live:codex` | `--full-probe` | Legacy browser login; up to two model invocations | `browser-probe.json` |

Each script invokes `bun --no-env-file dist/live-codex.js`. All support
`--help`. These opt-in network experiments are separate from development checks.

Device-code runs require an interactive Windows terminal with all three streams
reporting TTY. Use an unrecorded terminal; a TTY check cannot detect recording.
Open the displayed official website yourself and enter the temporary code only
there. The selected browser account authorizes this process. Tesota does not
read authorization input or reuse a previous run's credentials. Account sign-in
does not establish availability of the fixed experimental model.

## Evidence destinations

The CLI exclusively creates its output before authentication. The default
repository destinations listed above already contain historical evidence, so
running these scripts there fails before login. Preserve those files.

There is no output-path flag. Output is relative to the working directory;
source and build identities are relative to the compiled module. For a planned
additional experiment, use a fresh attempt directory containing an `experiments/codex/evidence/`
subdirectory and invoke the existing compiled entry by absolute path with the
supported arguments. Keep the account, model, implementation and limits explicit
for each attempt. Record the process exit code and retain the sanitized artifact.
A crash or watchdog exit can leave an incomplete reservation; it is not valid
evidence and must not be interpreted as successful settlement.

## Authentication and probe contract

AUTH-ONLY disables the invocation's Pi Models and provider inference entry points
before login, then returns immediately after the bounded public `Models.login`
operation. Any attempted inference is denied before dispatch and latches a failed
diagnostic, even if the caller catches the denial. No Agent, probe, executable tool
or verifier is entered. Successful login proves OAuth/login only: no model route,
intended-account attestation, task acceptance, repository or verification proof.
It is a diagnostic prerequisite, not proof of model-turn behavior. Pi retains credentials only
in its default in-memory store for this invocation; Tesota adds no credential store.
The 180,000 ms login bound and 185,000 ms AUTH-ONLY watchdog assume a responsive
event loop. Explicit process exit bounds retained handles; it does not prove
server-side cancellation. A watchdog/crash may leave an incomplete reservation.

Each probe admits at most **one Pi model stream invocation**, guarded before
calling `Models.streamSimple`. An attempted continuation is denied with a local
error stream using Pi's public `StreamFn` contract; the probe fails. There are
no executable tools, retries, fallback routes, persistent sessions or live
verification access. Only the locked `openai-codex` / `openai-codex-responses` /
`gpt-5.3-codex-spark` route is selected, with SSE. Tesota passes `maxTokens: 64`,
but locked Pi's Codex request builder does not transmit that option. There is no
established 64-token output ceiling; the invocation and time bounds below apply.

Each turn has a **30,000 ms whole-turn deadline** covering the streamed body.
Any abort request starts a **2,000 ms settlement window**, including the abort
probe's first-content-delta request. Expiry requests Pi abort; the request is
not settlement. Only Pi's observed `agent_end` assistant stop reason establishes
a terminal outcome. Missing terminal observation returns `unsettled` with
`settlement: "unconfirmed"`; late events cannot upgrade returned evidence.
An observed aborted outcome may normalize to `aborted` after a deadline, but
deadline expiry still fails the probe. The caller does not await a stuck stream.
The CLI exits explicitly so retained network handles cannot keep it alive.
OAuth has a separate 180,000 ms bound; the CLI has a 249,000 ms watchdog across
login and both probes. These timers assume a responsive runtime event loop.

Full-probe exit 0 requires both probes to pass independently. The normal probe requires
exactly one invocation/attempt, the fixed `TESOTA_CODEX_OK` response (surrounding
whitespace ignored), an observed `stop` terminal outcome, normalized `completed`,
no abort request, zero tool execution starts, respected bounds and
`taskAcceptance: "not_evaluated"`. The abort probe requires the ordered sequence
of exactly one invocation, forwarded content delta, abort request, observed
terminal `aborted`, and normalized `aborted`; it also requires zero tool execution
starts, respected bounds and no task acceptance. Any absent or wrongly ordered
observation fails. A failing normal probe stops without running the abort probe;
an abort-probe failure cannot be hidden by normal-probe success. No retry is made.

`modelInvocationCount` counts admitted calls to Pi `Models.streamSimple`, **not
independently observed HTTP requests**. `invocationAttempts` includes blocked
continuations. `toolExecutionStartCount` counts Pi `tool_execution_start` events,
including rejected/nonexistent attempts, not successful executable tool calls.
Executable tool implementations remain zero. `turnBoundRespected` means the
turn deadline did not expire; an expired turn still returns within the separate
settlement window, without asserting successful or aborted settlement.

Pi 0.85.1's tagged `packages/ai/src/auth/oauth/openai-codex.ts` races a `manual_code` prompt
against its localhost callback. The legacy `--full-probe` browser path selects browser login and leaves that
prompt pending until cancellation; **manual authorization entry is disabled**.
It has no readline/stdin reader. Other text/secret prompts fail closed. On Windows
Tesota attempts to open the initial Pi authorize URL without logging it;
Pi receives the callback and owns parsing, exchange and its default in-memory
credential store for this invocation. No provider error text or auth notification
text is printed. Tesota does not read, copy or persist tokens, nor claim universal
credential behavior for other Pi applications. A failed/unavailable callback
fails within the login bound. Browser/account selection is not intended-account
attestation. Pi's client-observed aborted state does not prove server-side
cancellation. **Active Oxlint subprocess cancellation remains unsupported and
unproven.**

## Evidence contract

The serializer stores fixed identifiers, counts, lifecycle labels, limits and
outcomes. It excludes model text, credentials, headers, raw provider errors and
environment values.

The current serializer emits `tesota-codex-evidence` version 6. Version 6 replaces
the milestone-based format name and expected probe token; historical records keep
their original names and versions internally. `oauthFailureCategory` is `oauth_timeout` when
Tesota's 180,000 ms login deadline fires, `browser_launch_failed` when the local
launcher throws or emits an error, and `unknown` for every other pre-probe failure.
The record includes `mode`, `authenticationOutcome` (`succeeded`, `failed`, or
`unconfirmed` for the local timeout), and `inferenceAttempted` separately.
`authenticationMethod` (`device_code` or `browser`) is separate from execution
`mode`. Historical schema versions remain unchanged.
AUTH-ONLY success has null OAuth failure category, zero invocations, null probes
and disposition `succeeded`; full-probe success retains disposition `passed`.
An attempted inference always fails AUTH-ONLY even if login succeeded. Neither
auth result grants task acceptance or verification meaning. Historical v1/v2
artifacts are not rewritten or upgraded. No evidence reader/compatibility layer
exists. The category is null after successful login. Launcher success does
not prove that a browser opened or a callback arrived. Invalid authorize routes
remain `unknown`; route validation precedes the launcher observation.
Classification recognizes only Tesota's local failure type, never error text,
stacks, provider response bodies or auth material. It is diagnostic evidence only;
an OAuth-stage failure still has zero model invocations, null probes and failed
disposition, with no task acceptance or verification meaning.
The first authoritative local observation wins: browser-launch cancellation is
observed synchronously; the deadline records timeout before requesting cancellation;
login success/rejection is observed by its promise handler. Later observations
cannot replace the result. Callback cleanup alone still means `unknown`.

The inspected Pi 0.85.1 public `Models.login` forwards login rejection and abort
reasons. Its `AuthInteraction` offers prompts and notifications but no typed
callback-observed, login-rejected or internal-failure outcome. The installed
`auth/oauth/openai-codex.js` keeps callback parsing and token exchange internal;
its exceptions can contain response bodies. Prompt cancellation also occurs during
callback cleanup, so it cannot prove callback absence. These cases stay `unknown`.

The evidence module alone captures immutable SHA-256 identities from ten fixed,
module-relative implementation/build/config paths. Its serializer accepts only
those in-process captures, rejecting copied or caller-created records, even with
valid-looking digests. Missing/unreadable source files prevent capture before login.
Environment strings, token/URL-like input, malformed hashes, and missing/extra
identity entries cannot enter this field. These hashes bind local contents;
they do not cryptographically authenticate the machine or operator.

Evidence binds the invocation to SHA-256 hashes of source files, the executed
compiled JavaScript, package/lockfile and compiler configuration captured before
login. The artifact records file hashes rather than inventing a future evidence
commit identity. The committed source hashes and a rebuild can be compared with
this binding; this is code identity, not installed-image attestation or human
acceptance. Historical records remain bound to their captured implementation,
not to later edits.

## Provider diagnostics

The current schema includes `providerDiagnostic` on each non-null probe:

| Field | Observation source and meaning |
| --- | --- |
| `httpStatus` | Integer 100–599 from Pi's public `onResponse.status`, otherwise null |
| `failureStage` | For normalized failed turns: `response_not_observed`, `http_rejection` (status ≥300), or `after_response`; otherwise null |
| `providerErrorCode` | Always null: no validated structured code survives this supported boundary |

`onResponse` survives Models auth application, provider/lazy dispatch and
`streamSimple`'s `buildBaseOptions`. SSE invokes it after fetch and before the
HTTP-success check/body consumption. Pi converts HTTP and stream errors into
assistant error text; Tesota intentionally discards that text. The callback
reads only numeric status, ignores late observations and never retains headers,
bodies, exceptions, stacks or arbitrary provider strings. The stage describes
observations, not causation: 403 does not prove missing Spark entitlement, 429 does
not identify a quota, null does not prove no request, and 200 does not prove stream
completion. Diagnostics do not participate in authorization or probe acceptance.

`inferenceAttempted` is the AUTH-ONLY forbidden-inference guard latch. Full probing sets it
false; ordinary admitted invocations use `modelInvocationCount`. Its historical
false value does not contradict the recorded invocation and is not rewritten.

See [experiment history](history.md) for source tracing and regression evidence.
