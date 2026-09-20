# Supported task third follow-up qualification

This protocol freezes one new prospective task selected on 2026-09-19 before
submission to Tesota. It does not retry either prior follow-up: the first ended
at discovery, and the second retained unconfirmed task settlement after its
cumulative deadline expired during a real dependency snapshot.

## Frozen task

Repository: `https://github.com/hraness/sysone.git`

Baseline: `862beb481157bfd5f53893bfea612610b23b29a0`

Verbatim request:

> Ensure score responses contain exactly one probability for every zero-based
> criterion index and no extra probability keys. Preserve the existing legend,
> probability-sum, and weighted-score validation.

This is a bounded response-validation bug fix expected to write only
`src/response.ts`. Its required behavior is explicit and independently
reviewable; no reference patch is supplied to the task agent.

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
