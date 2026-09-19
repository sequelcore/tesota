# Supported task follow-up qualification

This protocol freezes one prospective follow-up task selected on 2026-09-19
before it was submitted to Tesota. It exists to answer the remaining Milestone
1 question: whether the corrected fixed route can complete one useful external
repository change through the ordinary product flow.

The original three-task corpus remains the breadth and negative-outcome record.
Those tasks are not retried. This follow-up does not produce a reliability rate
or replace their failures; it adds one independent positive opportunity after
the provider and verifier blockers they exposed were corrected.

## Frozen task

Repository: `https://github.com/hraness/sysone.git`

Baseline: `3960a9be66ec531748b05b4e5ffb60e2d98c4a12`

Evaluator-only reference after Tesota produces a result:
`c0ab9a0c902df5b0c0673be0d9b8bbfdfb3a9a02`

Verbatim request:

> Normalize native CPU readiness so node-llama-cpp's `false` GPU value is
> reported as `cpu` in both the selected backend and supported backend list.
> Preserve the existing Metal, CUDA and Vulkan values and native-resource
> cleanup.

This is a bounded bug fix expected to write only existing TypeScript source
below `src/`. The reference patch is withheld from the task agent. Selection
used public history to make independent residual-defect assessment possible;
it is a feasibility case, not a random sample.

## Frozen setup and route

Use a fresh independent clone at the exact baseline on Windows x64 with the
current Tesota pull-request head and fixed Codex/Pi route. The baseline has a
root `bun.lock`, exact TypeScript 6.0.3 development dependency, literal
`tsc --noEmit -p tsconfig.json` script, compatible root `tsconfig.json`, and no
tracked symbolic links or submodules.

Provision ignored dependencies without changing tracked files:

```powershell
bun install --frozen-lockfile --ignore-scripts --omit optional --os=linux --cpu=x64
```

The optional native inference packages are not compiler inputs. TypeScript
6.0.3 is the portable JavaScript compiler and declares no platform package.
Before submission, record the clean source revision, tool identities,
dependency-installation digest and successful fixed-profile preparation.

Start one fresh Tesota Shell and enter the request exactly once. Do not adapt
the request after observing the result and do not substitute another task.
Retain support or failure classification, proposal scope, approval, candidate
identity, changed files, exact-result checks, remaining unknowns, elapsed time,
intervention, unavailable cost fields, human decision and guarded application
outcome. Typecheck evidence must remain distinct from semantic acceptance.

The task's exact diff receives the normal explicit human accept-or-reject
decision before any application. Delivery of the Tesota change uses the one
maintainer-coordinated pull-request review selected by the operator; no local or
remote second review is requested by Tesota.

Milestone 1 remains active if the ordinary shell cannot reach a settled
accepted-and-applied result, if the source or evidence drifts, or if any effect
or remaining unknown is reported more strongly than the retained evidence.
