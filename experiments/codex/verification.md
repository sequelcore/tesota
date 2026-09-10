# Live verification tool

This Windows experiment connects the saved Codex login to the existing bounded
Oxlint verifier through Pi. It edits no source and does not execute agent tasks.
The next [candidate exercise](candidate.md) adds a bounded replacement and recheck.

```sh
bun run build
bun run live:verification
```

Authorize once with `bun start auth login` if needed. The command uses the same
isolated OAuth route and fixed model as the [turn probes](README.md). It never
starts login automatically. `bun --no-env-file dist/live-verification.js --help`
is offline. Extra arguments are rejected before authentication.

## Contract

The only admitted input is [fixtures/verification.ts](fixtures/verification.ts),
containing exactly `debugger;` followed by LF. The entry point checks those bytes
before authentication. The model receives its relative path, one tool schema,
and a prompt requesting verification. It receives no source contents, credential
material, executable selection or verifier flags.

Tesota validates exact arguments and admission at the tool execution boundary,
as well as Pi's pre-call hook. At most one verification executes. The shared
verifier captures and checks the selected bytes using its existing
[profile and limits](../../docs/verification.md). This fixture deliberately fails
`no-debugger`: a detected violation is the expected verification outcome.

The tool returns only status and diagnostic count to Pi. A second model invocation
may consume that result and return `TESOTA_VERIFICATION_OK`. The adapter records
whether the actual bounded tool result was present in that invocation's context;
this is not proof of model comprehension. No third invocation is admitted.
Retries are disabled. Unknown tools, repeated requests or mismatched inputs
prevent experiment success.

The session has a 60-second deadline and a two-second abort settlement window;
credential resolution has the existing 180-second limit. A 249-second process
watchdog covers the whole command. These bounds assume a responsive event loop.
Pi abort does not cancel an active Oxlint process; the verifier retains its own
10-second process timeout and two-second termination observation. Missing session
settlement is `unsettled`, and late completion cannot upgrade returned evidence.
Process exit does not prove remote or subprocess cancellation.

Exit 0 requires two model invocations, one tool attempt and execution, the issued
`check_failed` result bound to the exact fixture path and bytes, a bounded result
supplied to the continuation, a final `stop` with the expected text, no denial or
exceeded limits, and a successful evidence save. Pi thinking blocks may accompany
the answer. This is a probe result; task acceptance remains `not_evaluated`.

## Evidence

Each run reserves a new directory under ignored `experiments/codex/runs/` before
authentication. `probe.json` uses `tesota-verification-probe` version 2 and records
fixed implementation hashes, bounds, counts and event names. It excludes model
text, requested argument values, raw errors and provider bodies. `verification.json`
is written by the existing durable verification store when an issued completed
result exists. It includes local input and installation paths; retain it locally,
not as a shareable sanitized report. Failed/incomplete runs remain failures.

The verifier's byte binding detects a changed fixture; the checkout itself is
trusted and expected to remain stable during this experiment. Version 2 fixes the
admitted input as a schema literal as well as checking it at execution. This is
not a filesystem sandbox or an arbitrary-file permission model. Neither implementation
hashes nor recovered JSON authenticate the producer. See the
[history](history.md) for retained observations and [roadmap](../../docs/roadmap.md)
for the next increment.
