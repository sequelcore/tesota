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

## Anthropic Sandbox Runtime Windows probe

The separate [SRT probe](srt-qualification.mjs) compares Anthropic Sandbox
Runtime 0.0.77 with the fixed JavaScript controls above. It does not change
Tesota's task runner or select a new backend. The upstream source was inspected
at commit `ddbeb74711c4097014ef3056791efa83f553116c`; the npm package was
installed under `Sequel/cloned/tesota-srt-qualification` with lifecycle scripts
disabled. The probe takes that package's absolute `node_modules/@anthropic-ai/sandbox-runtime`
path as its only argument and runs from a built Tesota checkout.

Windows setup is a separate machine-wide operation: the upstream
`windows-install` command prompts for elevation and creates a local sandbox
account, network filters and registry state. The probe refuses to run when
setup is absent. Run the upstream `windows-uninstall` command after the probe
if the installation was made only for qualification. The upstream uninstall
does not remove its empty `%ProgramData%/sandbox-runtime` and per-user
`%LOCALAPPDATA%/sandbox-runtime` directories.

On 2026-09-23, two consecutive runs passed the declared source write,
sibling write denial, build and scratch writes, outside read denial, synthetic
credential exclusion, network denial with a reachable host control, child
start, cancellation and late-write checks. The pinned helper's SHA-256 was
`82265bac63944be6ba8293b67da66e6e55455bc15a232d954bd90e35e59d38dc`.
The sanitized observation is [windows-srt-2026-09-23.json](evidence/windows-srt-2026-09-23.json).
The official uninstall then removed the account, group and registry credential;
the helper's unprivileged WFP enumeration still reported `cannot-read`, so
filter removal is reported from the installer's own result, not independently
enumerated. The two empty state directories remain on this machine.

This is a fixed Node probe, not qualification for real TypeScript checks,
Java/Go toolchains, arbitrary commands, hostile repository aliases, or
cross-platform support. A first attempt under the caller's private Temp failed
because the sandbox account could not traverse that profile. The fixture was
moved under the experiment's cloned package workspace. An unnecessary grant
on the machine-wide Node executable also failed with access denied and was
removed; normal Users access was sufficient for the passing probe. Those
integration constraints matter for any task-owned workspace design.

## Repository and alias follow-up

The [repository probe](srt-repository-qualification.mjs) used the same pinned
SRT package and helper on 2026-09-23. It ran a real TypeScript 7.0.2 `--noEmit`
check against a small project: valid source passed, and a deliberate type error
failed with `TS2322`. A failed check was followed by `SandboxManager.reset()`;
the fixture and compiler ACL text matched their pre-session state afterward.

The process reported its user as `srt-sandbox`. With `denyRead` on one protected
external file, that file was unreadable through both its direct path and a
junction inside the candidate. An unlisted external file remained readable.
That **matches SRT's documented read default**: reads are allowed unless a
broader `denyRead` policy or the host ACL blocks them. The original probe
incorrectly treated this read as a failure of SRT itself. New files were also
writable in that external directory despite `allowWrite: []`. The fixture's
parent tree grants `Authenticated Users` modification rights, which the
sandbox account receives. SRT's Windows source explicitly acknowledges this
exception to its separate-user confinement premise and installs write denies
on a fixed set of Windows system directories, not arbitrary third-party
trees such as this one. The original probe was valid evidence of **Tesota's
unmet strict host policy under that configuration**, not a general claim that
SRT fails on a properly private workspace.

A second session configured `denyRead` and `denyWrite` on the *same* protected
file. In this run, both direct and junction reads succeeded. The first session's
read-only deny had worked, so the combined policy cannot be treated as the
union of those restrictions in SRT 0.0.77. ACLs returned to their original text
after both sessions. The sanitized result, including the failed controls, is
[windows-srt-repository-2026-09-23.json](evidence/windows-srt-repository-2026-09-23.json).

A [private-fixture follow-up](srt-private-fixture-qualification.mjs) removed
inherited broad-group permissions from a newly created task root before making
the candidate and copied TypeScript toolchain. In two runs, the typecheck
passed, a deliberate type error failed, the admitted source write succeeded,
and reads/writes outside the candidate **within that private root** failed by
direct path and junction. Compiler writes failed and ACLs were restored. A
later control placed a separate fixture under the ordinary shared parent:
the sandbox account could read and write that fixture, directly and through a
junction. Thus sealing a task root works for that root but does not protect
other broadly accessible host paths. The sanitized observation is
[windows-srt-private-2026-09-23.json](evidence/windows-srt-private-2026-09-23.json).

The repository probe also allocated 160 MiB in a child process. This
demonstrates that it did not enforce a 128 MiB cap. Inspection of the pinned
upstream [`job.rs`](https://github.com/anthropics/sandbox-runtime/blob/ddbeb74711c4097014ef3056791efa83f553116c/vendor/srt-win-src/src/job.rs)
shows kill-on-close and UI restrictions but no configurable memory, CPU or
process-count limit. The allocation is a bounded observation, not a general
resource-exhaustion test.

Verdict: **not qualified yet** for Tesota's protected repository-task contract.
The private fixture shows a plausible integration path; it does not establish
confinement across the host. Tesota would need to identify and enforce the
read/write boundary against broadly accessible paths without changing
unrelated repositories' ACLs, normalize or resolve overlapping deny rules,
provide verified resource bounds, and test startup, crash recovery and
real-task settlement. No task runner or approval policy was changed by these
experiments. The upstream installer was removed afterward; its command
reported account and filter removal.
