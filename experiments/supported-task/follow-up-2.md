# Supported task second follow-up qualification

This protocol freezes one new prospective task selected on 2026-09-19 before
it was submitted to Tesota. It follows, but does not retry, the first follow-up
whose discovery rejected a safe trailing-slash directory prefix before any
repository operation or authority creation.

The original corpus and first follow-up remain the negative record. This second
case asks only whether the corrected ordinary flow can complete one useful
external change; it does not erase earlier failures or support a reliability
rate.

## Frozen task

Repository: `https://github.com/hraness/sysone.git`

Baseline: `862beb481157bfd5f53893bfea612610b23b29a0`

Verbatim request:

> Deduplicate model IDs returned by backend discovery while preserving their
> first-seen order, ignoring empty IDs, and applying the 512-item limit to
> unique IDs rather than raw response entries.

This is a bounded bug fix expected to write only `src/backends.ts`. The behavior
is independently reviewable from the request and baseline; no later reference
patch is supplied to the task agent.

## Frozen setup and route

Use a fresh independent clone at the exact baseline on Windows x64 with the
current Tesota pull-request head and fixed Codex/Pi route. The baseline has a
root `bun.lock`, exact TypeScript 6.0.3 development dependency, literal
`tsc --noEmit -p tsconfig.json` script, compatible root `tsconfig.json`, and no
tracked symbolic links or submodules.

Provision ignored compiler dependencies without changing tracked files:

```powershell
bun install --frozen-lockfile --ignore-scripts --omit optional --os=linux --cpu=x64
```

Before submission, record the clean source revision and successful final fixed
profile. Start one fresh Tesota Shell and enter the request exactly once. Do not
adapt or retry it after observing the result. Retain proposal, approval,
candidate, checks, remaining unknowns, elapsed time, intervention, unavailable
cost fields, explicit human decision and guarded application outcome.

The exact candidate diff requires the normal human accept-or-reject decision;
check evidence is not acceptance. Delivery uses the one
maintainer-coordinated pull-request review selected by the operator, and Tesota
does not request another review.
