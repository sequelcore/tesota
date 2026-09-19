# Supported task fourth follow-up qualification

This protocol freezes one new prospective task selected on 2026-09-19 before
submission to Tesota. It does not retry the three prior follow-ups: the first
ended at discovery, the second did not settle inside its cumulative deadline,
and the third failed its independent current check.

## Frozen task

Repository: `https://github.com/hraness/sysone.git`

Baseline: `862beb481157bfd5f53893bfea612610b23b29a0`

Verbatim request:

> Treat a valid `/v1/limits` response that contains neither supported limit as
> unpublished: `extractBackendCapabilities` should return `null` instead of an
> empty capability object. Preserve existing positive limit parsing.

This is a bounded capability-parsing bug fix expected to write only
`src/backends.ts`. Its required behavior follows the existing advisory limits
contract and is independently reviewable; no reference patch is supplied to
the task agent.

## Frozen setup and route

Use a fresh independent clone at the exact baseline on Windows x64 with the
current Tesota pull-request head and fixed Codex/Pi route. Provision the ignored
portable TypeScript 6.0.3 closure from the root `bun.lock`:

```powershell
bun install --frozen-lockfile --ignore-scripts --omit optional --os=linux --cpu=x64
```

Confirm a clean source and passing final fixed profile before submission. Start
one fresh Tesota Shell and enter the request once. Do not adapt, retry or replace
it after observing the result. Retain proposal, approval, exact candidate,
checks, settlement, remaining unknowns, elapsed time, intervention, unavailable
cost fields, explicit human decision and guarded application outcome.

The candidate requires the normal human accept-or-reject decision after its
exact diff and evidence are shown. The one maintainer-coordinated delivery review
remains separate and is arranged by the operator.
