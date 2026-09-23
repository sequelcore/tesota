# Synthetic Pi compatibility

This is a retained record of a retired fixture-based adapter. Current Pi
integration is described in the [architecture](../../docs/architecture.md).

Pi was accepted as a candidate engine following the synthetic compatibility
experiment, with the limitations below. `runPiSession` in
`src/integrations/pi.ts` uses Pi's in-memory faux responses for these synthetic
scenarios. The same adapter later accepted a live stream for the separate
[verification experiment](../codex/verification.md). See the
[roadmap](../../docs/roadmap.md) for status.

## Cancellation

Cancellation request and observation are separate: `abortRequested` and the
`abort_requested` event record Tesota's request. `terminalStopReason` records
the final assistant outcome from Pi's `agent_end` event. Only an observed
`aborted` terminal reason produces session status `aborted` and `session_aborted`.
A request followed by a normal terminal outcome remains `completed`; missing,
pending or error terminal outcomes produce `failed`. Task acceptance always
remains `not_evaluated`. The shared session deadline now bounds missing settlement
as `unsettled`; an exceeded deadline cannot produce a successful probe.

The abort scenario keeps the faux response active until Pi processes its abort
signal. The regression delays `Agent.abort()`, checks that the turn is still
active, then releases the real abort and observes Pi's terminal result. A second
regression bypasses faux abort processing and requires the normal terminal
outcome to remain completed. Restoring the old local-boolean inference made
that regression fail (`aborted` instead of `completed`); disabling `Agent.abort()`
made the active-turn regression time out. Both mutations were restored.
**Active Oxlint subprocess cancellation is unsupported and unproven**: the tool
checks the signal before execution but does not forward it into `runOxlint`.

## Verification projection

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
call. The adapter also enforces at most two model invocations and one verifier
execution for both synthetic and live verification sessions. These bounded
experiments do not implement a general production agent loop.

## Optional dependency boundary

The lockfile and installed metadata resolve `pi-agent-core` and
`pi-ai` to `0.85.1`; `pi-ai` pins `@google/genai` to `1.52.0`. That package's
declarations import MCP `Client` through its optional
`@modelcontextprotocol/sdk` peer (`^1.25.2`). The type-only
`src/integrations/optional-peer.d.ts` placeholder has a required `never` member,
so an ordinary value cannot inhabit it. Compile-time assertions reject a return
to an empty or optional placeholder. It emits no runtime code and installs no
MCP dependency. When Tesota actually consumes MCP functionality, remove this
placeholder and adopt the genuine supported dependency/contract.

This adapter establishes synthetic lifecycle and projection behavior only.
The [live experiment](../codex/README.md) evaluates live compatibility and OAuth separately.
Production cancellation, durable Pi session recovery and a production invocation
budget remain unproven.
