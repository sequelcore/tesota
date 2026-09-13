# Command isolation qualification

This experiment compares two Windows-capable isolation backends with the same
fixed JavaScript command. It selects a runner for one future bounded code task;
it does not execute a task or grant general shell authority.

## Protocol

Build Tesota, ensure the pinned image is already present, then run:

```powershell
bun run build
bun --no-env-file dist/cli.js isolation qualify
```

The command creates independent temporary fixtures. The fixed probe must write
one admitted source file, a separate build directory and separate verifier
scratch directory. It must fail to change a sibling source file, fail to read an
outside sentinel, observe no synthetic credential and fail to connect to a
reachable ephemeral network control. The canary credential exists in the launcher
environment, and an unconfined control reaches the same listener before the
isolated attempt. The probe then starts a child that writes a ready marker before
it would write a late marker. Tesota requests cancellation, waits for settlement
and rejects the backend if readiness was absent or that child later writes the
marker. SIGINT enters the same abort path and returns 130 after owned cleanup.

The container uses the exact image digest printed in the result and never pulls
during qualification. Normal repository checks test policy construction and
assessment without invoking either live backend.

## Retained observation

The bounded Windows run on 2026-09-13 selected `docker-container`. Docker
29.7.2 with the pinned Node image passed every declared control. Codex CLI
0.154.0 failed `outsideReadDenied` and `networkDenied`; the probe could read the
synthetic sentinel outside its declared candidate and reach the local control.
No sentinel contents or machine paths were printed or retained. Live AbortSignal
checks before readiness and during execution left no qualification containers or
networks; SIGINT-to-abort mapping has focused process-level coverage.

The sanitized machine-readable result is
[windows-2026-09-13.json](evidence/windows-2026-09-13.json). A passing row is
evidence only for this fixed command, policy and environment. It is not proof
against container-runtime or kernel vulnerabilities.

## Interpretation

Verdict: **internal-decision-ready** for choosing the pinned container runner in
the next bounded Windows increment. The same command, controls and pass rule were
used for both backends; all failed controls remain in the denominator. The
comparison measures enforcement behavior, not performance. It has one run per
backend and no independent reproduction, so it is not suitable for a public
comparative security claim.

The adopted boundary and its rationale live in
[decision 004](../../docs/decisions/004-command-isolation.md). Re-run this command
after changing the image, mounts, resource limits, cancellation or cleanup code.
