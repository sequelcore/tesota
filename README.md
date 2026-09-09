# Tesota bootstrap

A private, provisional package. It provides CLI help, invalid-argument errors,
active development checks and one shared Oxlint executor with single-file input
binding, applicability and durable evidence recovery (M2.3). It does not
execute agent tasks. The separate opt-in M3.1a command connects to Codex through Pi OAuth.

Historical provenance: `4257ee9fce034cfe8e50dce3dbe3afb12f468094` from Kiln.
This is a historical source reference, **not a verified functional baseline**.
The [file inventory](docs/bootstrap-inventory.json) records every inherited
file's disposition and original Git blob. No Kiln implementation package is
ported. Root LICENSE and NOTICE remain unchanged. License information for
current dependencies remains in their installed packages. Historical Kiln
assets and tool binaries are not included in Tesota.

## Development

Use Bun 1.4.2 (see the [bounded upgrade evidence](docs/bun-1.4.2-evidence.md)) and
Node 24.15.0. Exact tool selections are owned by package.json and bun.lock:
TypeScript 7.0.2, Vitest 4.1.11, Oxlint 1.82.0, and Node types 24.10.0.
Node runs development tools; Bun runs the compiled CLI. The private scaffold
retains inherited Apache-2.0 attribution without deciding public branding or
future distribution.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun --no-env-file dist/cli.js --help
```

Individual commands: `bun run build`, `bun run typecheck`, `bun run test`,
and `bun run lint`. Tests build first and exercise the compiled CLI in bounded
child processes with a minimal environment. Typechecking includes sources and
tests. Oxlint checks without fixes and rejects warnings. Installation scripts
are disabled explicitly; dependencies are registry packages, not Kiln links.

No arguments, `help`, `--help`, or `-h` print help on stdout and exit 0.
`verify <file.ts|file.js>` runs the check below. Other argument combinations
print a diagnostic on stderr and exit 2.

## One local check (M2.2)

```sh
bun --no-env-file dist/cli.js verify src/cli.ts
```

The CLI and tests use `runOxlint` from `src/verification/oxlint.ts`. The trusted
application configuration selects the absolute runtime and installed Oxlint
1.82.0 entry, working directory and limits. CLI arguments select one existing
JavaScript or TypeScript file, never an executable, shell command or arbitrary
flags. The fixed `oxlint-basic/v1` profile checks only `no-debugger` and
`no-unused-vars`; a pass does not establish general correctness or acceptance.

The verifier runs in a private temporary directory with an explicit JSON config,
one thread, no external plugins, nested config, type-aware execution or fixes.
Inline disable directives are rejected. It reads a byte-exact snapshot of the
selected source without executing it. Input is limited to 1 MiB, captured stdout and stderr together to
256 KiB, process runtime to 10 seconds, and termination observation to another
2 seconds. The execution timeout starts at spawn, not during input preparation.

Each invocation prints one JSON result on stdout:

| Status | CLI exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Complete report, one file, two rules, no violations |
| `check_failed` | 1 | Complete report with recognized lint violations |
| `execution_failed` | 2 | Input/install/spawn failure, unsupported output, timeout or incomplete execution |

[Oxlint's pinned result contract](https://github.com/oxc-project/oxc/blob/apps_v1.82.0/apps/oxlint/src/result.rs)
uses failure status for both diagnostics and operational errors. The executor
therefore requires coherent exit status and
[JSON report fields](https://oxc.rs/docs/guide/usage/linter/output-formats.html),
including file/rule/thread counts and recognized diagnostic locations. Unknown
rules, parse errors, missing output, skipped files and inconsistent results are
execution failures, not successful checks. The projection deliberately accepts
only the fields needed from that producer-owned contract; it adds no schema
library or generic verifier abstraction.

`process` distinguishes `not_started`, `exited` and `unconfirmed`. A termination
request alone never produces `exited`. An unconfirmed process includes its PID
and retains its temporary directory for operator reconciliation. This closed
native-rule profile runs one process; it is not a sandbox or a general process-tree
executor. Arbitrary subprocesses, external plugins and untrusted installations
are not admitted.

### Input binding and applicability

Every completed result includes `binding`:

- `source`: the original absolute logical filename and SHA-256 of the captured
  bytes, including BOM and line endings. No Git revision substitutes for bytes.
- `check`: the fixed profile label, exact JSON configuration text, semantic
  argument vector and execution limits. The entry placeholder is resolved from
  `verifier.entry`; random temporary paths are not part of identity. Configuration
  contents are compared even when the profile label is unchanged. Execution
  continues to admit only the existing fixed configuration.
- `verifier`: the observed installed package version, selected runtime executable
  path and SHA-256, entry path, and an installation content digest covering Oxlint
  and its resolvable installed native binding packages. `packageVersion` is read
  from installed metadata, not asserted to be a runtime self-reported version.

The executor reads at most 1 MiB plus one overflow byte, then hashes and writes
the same captured buffer to a private temporary file. It preserves the original
basename and extension, writes the recorded configuration, and directs Oxlint
only to those snapshot inputs. Diagnostics are validated against the snapshot
and attributed to the original logical filename. This preserves the two native,
file-local rules; project configuration and import-aware analysis remain excluded.
Unconfirmed termination retains both source and configuration snapshots. Failures
include binding when preparation established it; absence never implies success.

`assessApplicability(result, currentCheck)` returns `status`, `provenance` and
`comparedAt` separately from the original execution outcome. Matching observed inputs are
`applicable`; changed source, configuration, semantic arguments, limits or
installation identity are `stale`; unreadable/missing inputs and results not
issued by this executor instance are `unavailable`. A check failure can still
be applicable. In-process comparison accepts only issued completed result
objects, not copied or deserialized JSON. Completed results are immutable.

Applicability describes the inputs observed during that comparison, not a
permanent flag or an atomic view across mutable files. Installed tools are
trusted and expected to remain stable during execution: their digest is an
observation of installation contents, not loaded-image attestation. Digests do
not authenticate an asserted pass. This is not whole-repository verification.

### Durable evidence and recovery (M2.3)

`DurableVerificationEvidenceStore` in `src/verification/evidence.ts` is the
single owner of persisted verification evidence. It writes one JSON record
containing the completed historical outcome and its exact M2.2 binding. The
record format is identified by `tesota-verification-evidence` and version `1`;
only this implemented version is read. A save accepts only an issued, completed
result, so a copied result object cannot be persisted as if it came from the
executor.

The store serializes and enforces the 512 KiB UTF-8 record bound before any
filesystem write, preserving an existing record on size rejection. It writes a
unique temporary file beside the destination and renames it into place after
the write. Callers must coordinate access to each destination; the store assumes
a single writer and supplies no locking or concurrent-operation ordering.
A process interruption before rename leaves the previous record or no record;
recovery never reads the temporary file. Failed writes or renames attempt
best-effort temporary cleanup; abrupt process termination can leave orphaned
temporary files. Replacement relies on the filesystem's rename semantics;
interruption during rename is not independently proven here. There is no fsync
protocol or power-loss durability guarantee.
Reads are size-bounded, reject malformed UTF-8 before JSON parsing, and require
the complete exact record shape. Diagnostic text is never repaired on recovery.
Missing data is `missing`; malformed, truncated, oversized or unsupported data
is `invalid`; other read failures are `unavailable`.

A valid reload returns a recovered historical result with
`structuralValidity: "valid"` and `provenance: "recovered_untrusted"`. It is
not an issued in-process result and gains no authority from its storage path.
Only the store's successful structural parse can register a recovered object;
there is no public registration function. Binding comparison ignores object-key
order while preserving exact configuration text and argument order.
`assessApplicability` can compare its binding with current source, profile and
verifier inputs, returning `applicable`, `stale` or `unavailable` while keeping
that recovered provenance visible. A recovered `passed` result remains
historically passed when current inputs make it stale. The storage API is
explicit; the current CLI output and command line remain M2.2 behavior.

Behavior tests exercise real Oxlint and the compiled CLI, including exact-byte
binding, same-filename edits, same-label configuration changes and unavailable
inputs. A deterministic process-start barrier changes the original after snapshot
creation; the real verifier must still report the captured violation. Bypassing
the snapshot was tested as a controlled defect: that test failed on an incorrect
`passed` outcome, then passed after restoring snapshot execution. Existing output,
timeout and simulated unconfirmed-settlement regression tests remain in place.

The CI workflow declares Windows and Linux checks without provider credentials.
Its presence does not mean GitHub Actions has run. See the
[M1 evidence](docs/m1-evidence.md) for actual local results and limitations.

M2.3 supplies durable evidence storage and recovery while preserving the
distinction between historical outcome, current applicability, structural
validity and recovered provenance. M2 has passed independent review and is
closed for its bounded Oxlint scope.
The formatter/import-organization decision remains open; no tooling is added.


## Synthetic Pi compatibility (M3.0)

Pi is accepted as a candidate engine following the synthetic compatibility
experiment, with the limitations below. `runPiSession` in
`src/integrations/pi.ts` uses only Pi's in-memory faux responses; it does not
connect to a provider. M3.0 synthetic compatibility is closed. M3.1a is the
bounded live Codex OAuth experiment below; M3.1b has not begun. Historical
evidence documents remain unchanged.

Cancellation request and observation are separate: `abortRequested` and the
`abort_requested` event record Tesota's request. `terminalStopReason` records
the final assistant outcome from Pi's `agent_end` event. Only an observed
`aborted` terminal reason produces session status `aborted` and `session_aborted`.
A request followed by a normal terminal outcome remains `completed`; missing,
pending or error terminal outcomes produce `failed`. Task acceptance always
remains `not_evaluated`.

The abort scenario keeps the faux response active until Pi processes its abort
signal. The regression delays `Agent.abort()`, checks that the turn is still
active, then releases the real abort and observes Pi's terminal result. A second
regression bypasses faux abort processing and requires the normal terminal
outcome to remain completed. Restoring the old local-boolean inference made
that regression fail (`aborted` instead of `completed`); disabling `Agent.abort()`
made the active-turn regression time out. Both mutations were restored.
**Active Oxlint subprocess cancellation is unsupported and unproven**: the tool
checks the signal before execution but does not forward it into `runOxlint`.

The verification tool returns exactly `content: [{ type: "text", text }]` and
`details` to Pi. The bounded mapping is:

| Outcome | Exact text | Exact details | Pi `isError` |
| --- | --- | --- | --- |
| `passed` | `Tesota verification passed; diagnostics=0` | `{ status: "passed" }` | `false` |
| `check_failed` | `Tesota verification check_failed; diagnostics=N` | `{ status: "check_failed" }` | `false` |
| `execution_failed` | `Tesota verification execution_failed` | `{ status: "execution_failed" }` | `false` |
| denied | `Tesota did not admit this verification action.` | `{}` | `true` |

`N` is the full diagnostic count. No diagnostic text, rule, location, failure
reason, binding, process metadata or canonical evidence object is exposed.
Invalid requests use the denial text `Tesota denied an invalid verification request.`
with the same empty details and error flag. Pi wraps the result in exactly
`role`, `toolCallId`, `toolName`, `content`, `details`, `usage` (undefined),
`isError` and `timestamp`. Tests inspect both the tool result and actual faux
model context with exact-shape assertions. Issued evidence stays on the Tesota
session result; a lint pass still does not establish task acceptance.

The scripted verification scenario has one tool invocation, at most one executor
call (zero when denied), and two faux model calls including continuation. The
successful-turn and abort scenarios have no tool invocation and one faux model
call. These are synthetic script bounds, not a production agent-loop budget.

The unchanged lockfile and installed metadata resolve `pi-agent-core` and
`pi-ai` to `0.85.1`; `pi-ai` pins `@google/genai` to `1.52.0`. That package's
declarations import MCP `Client` through its optional
`@modelcontextprotocol/sdk` peer (`^1.25.2`). The type-only
`src/integrations/optional-peer.d.ts` placeholder has a required `never` member,
so an ordinary value cannot inhabit it. Compile-time assertions reject a return
to an empty or optional placeholder. It emits no runtime code and installs no
MCP dependency. When Tesota actually consumes MCP functionality, remove this
placeholder and adopt the genuine supported dependency/contract.

This follow-up establishes synthetic lifecycle and projection behavior only.
The opt-in experiment below evaluates live compatibility and OAuth separately.
Production cancellation, durable Pi session recovery and a production invocation
budget remain unproven.

## Live Codex OAuth experiment (M3.1a)

The explicit opt-in `bun run live:codex` command runs the bounded experiment in
`src/integrations/pi-live.ts`. Normal `bun run check` gates remain offline and
credential-free. Run `bun run build` first; compiled `--help` is also offline.
This correction awaits independent re-review and does not claim M3.1a closed.

Each probe admits at most **one Pi model stream invocation**, guarded before
calling `Models.streamSimple`. An attempted continuation is denied with a local
error stream using Pi's public `StreamFn` contract; the probe fails. There are
no executable tools, retries, fallback routes, persistent sessions or live
verification access. Only the locked `openai-codex` / `openai-codex-responses` /
`gpt-5.3-codex-spark` route is selected, with SSE and at most 64 output tokens.

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

CLI exit 0 requires both probes to pass independently. The normal probe requires
exactly one invocation/attempt, the fixed `TESOTA_M31A_OK` response (surrounding
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

Pi 0.85.1's installed `auth/oauth/openai-codex.js` races a `manual_code` prompt
against its localhost callback. Tesota selects browser login and leaves that
prompt pending until cancellation; **manual authorization entry is disabled**.
It has no readline/stdin reader. Other text/secret prompts fail closed. On Windows
the initial Pi authorize URL opens in the default browser without being logged;
Pi receives the callback and owns parsing, exchange and its default in-memory
credential store for this invocation. No provider error text or auth notification
text is printed. Tesota does not read, copy or persist tokens, nor claim universal
credential behavior for other Pi applications. A failed/unavailable callback
fails within the login bound. Browser/account selection is not intended-account
attestation. Pi's client-observed aborted state does not prove server-side
cancellation. **Active Oxlint subprocess cancellation remains unsupported and
unproven.**

The [historical report](docs/m31a-historical-report.json) preserves only the
operator-supplied worker report for the rejected commit; it is not independent
verification. The corrected harness writes `docs/m31a-live-evidence.json` with a
versioned, allowlisted machine projection: identifiers, counts, ordered lifecycle
labels, bounds, stop reasons, statuses and dispositions. It includes no model
text/reasoning, credentials, auth responses, headers or environment values.
The file is reserved exclusively before login: existing evidence refuses another
run. A process crash or watchdog exit can leave an incomplete reserved file;
that is not valid evidence or successful settlement.

The [corrected live attempt](docs/m31a-live-evidence.json), started on
2026-09-09, exited 1 before either probe ran: zero model invocations, null normal
and abort probes, and disposition `failed`. Its generic failure projection does
not identify the specific OAuth failure. No retry was made. Corrected live
completion and abort behavior therefore remain unverified.

Before that attempt, local Windows `bun run check` passed all 68 tests, build,
typecheck and lint; `git diff --check` and compiled Bun offline normal/abort
smokes passed. Seven restored source mutations were detected: removed request
guard, ineffective abort, unconditional abort success, disabled deadline abort,
echoed prompt, expanded secret-bearing evidence, and abort recorded before the
stream update. These are offline check observations, not human acceptance or
successful live evidence.

Evidence binds the invocation to SHA-256 hashes of source files, the executed
compiled JavaScript, package/lockfile and compiler configuration captured before
login. The final commit does not exist at capture time and is not invented in
the artifact. The committed source hashes and a rebuild can be compared with
this binding; this is code identity, not installed-image attestation or human
acceptance. The evidence artifact and this implementation are retained together
for independent re-review.
