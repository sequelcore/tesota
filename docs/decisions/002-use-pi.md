# 002: Use Pi behind a bounded integration

Status: adopted for the current experiments. Synthetic compatibility is reported
accepted; successful live model-turn and verification-tool integration remain open.

## Decision and rationale

Use the public APIs of pinned Pi packages for agent mechanics, authentication and
provider transport. Keep Tesota's verification, admission, evidence and acceptance
responsibilities in Tesota. Avoid duplicating an engine loop or introducing a
second OAuth protocol implementation. Tesota supplies the app-owned storage
adapter required by Pi's public credential contract.

The bootstrap selected `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` at 0.85.1. The current selections are owned by
[package.json](../../package.json) and [bun.lock](../../bun.lock). The full Pi
coding-agent application is not installed. The [architecture](../architecture.md)
identifies the implemented boundary.

## Alternative: extract Kiln's implementation

Kiln already implements browser/device authentication and a Codex provider adapter.
Extraction is technically possible. Its historical authentication module also
owns token persistence and depends on Kiln error handling, home-directory
resolution and credential-file policy. Its provider adapter uses Kiln agent and
execution contracts. Adopting it would require separating those dependencies and
maintaining the extracted protocol implementation.

Pi already supplies the authentication operation needed by the current experiment.
Tesota calls `Models.login`, selects the public interaction and adds presentation,
deadlines and evidence. The custom experiment harness is integration code, not a
new implementation of authorization polling or token exchange. The subsequent
[persistent login](../authentication.md) uses Pi's `CredentialStore` seam so
normal runs can reuse authentication and Pi can refresh tokens under a storage lock.

This rationale is not proof that Pi minimizes total implementation effort.
Kiln's regression cases remain useful reference material. Revisit extraction or
another engine if a concrete unsupported behavior blocks the product; do not add
a silent fallback or maintain two authentication owners preemptively.

## Evidence and limitations

See [synthetic compatibility](../../experiments/pi/README.md), [live experiments](../../experiments/codex/README.md)
and [retained evidence](../../experiments/README.md). Authentication succeeded independently of
inference; that does not close the live integration milestone. Active verifier
subprocess cancellation through the adapter is unsupported.

Keeping Pi types in adapters contains replacement work. It does not promise
cost-free substitution or migration of future active sessions. Tesota retains
its own product identity and does not become a Pi extension by this decision.
