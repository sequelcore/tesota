# Execution repair: ordinary shell timing

Date: 2026-09-23 local / 2026-09-24 UTC. These are internal diagnostics
through the ordinary Tesota shell on Windows, using the uncommitted execution
repair over `817d0d23`. The first used Docker; a later one used trusted
host-local checks with Docker absent from `PATH`. They qualify those fixtures,
not representative usefulness.

The clean temporary Git repository declared TypeScript 5.9.3, contained one
source file and an independently copied local TypeScript installation. The
request was to change `discountedPrice` from addition to subtraction while
preserving its signature and changing only `src/price.ts`. The shell proposed
that one-file scope. The operator approved it, inspected the resulting diff,
accepted it and let Tesota apply it. Tesota recorded the final outcome as
`promoted`; the exact source diff changed only `+` to `-`.

The outcome journal records:

| Stage | UTC start/end | Elapsed |
| --- | --- | ---: |
| Approval recorded to execution result | 06:43:14.504–06:43:41.317 | 26.8 s |
| Execution result to review ready | 06:43:41.317–06:43:45.289 | 4.0 s |
| Decision recorded to promotion finished | 06:45:08.037–06:45:16.641 | 8.6 s |
| Scope approval prompt to final outcome, including operator waits | 06:42:47.763–06:45:16.641 | 148.9 s |

The model used five invocations, four tool calls, one edit and two task
checks. The first check failed because no file had changed; the second passed
after the edit. Review, decision and promotion recorded **zero host verifier
calls**. The check journal has two completed start/finish pairs. The operator
waited about 27 seconds before approving scope and about 83 seconds between
review ready and deciding, so total elapsed time does not describe machine
latency alone.

After application, `git diff --check`, a direct TypeScript no-emit check and an
independent `discountedPrice(100, 15) === 85` execution passed. Typechecking
alone would not have detected the original arithmetic bug; the direct
behavioral observation and reviewed diff support this specific correction.
No general test suite, other repository, platform or protection posture was
examined. The task was deliberately small; its 4-second review preparation
and 8.6-second decision-to-application interval cannot predict a large
dependency repository. Preparation, command, settlement and cleanup were not
instrumented separately inside this run.

## Docker-free attempt

On 2026-09-24, a fresh copy of the fixture was launched through the ordinary
shell with Docker removed from that process's `PATH`; `where.exe docker.exe`
found no client. The shell selected the new trusted host-local route. Model
discovery timed out at its 120-second limit before a proposal, approval or
candidate existed. Nothing was applied. This attempt does not qualify the
host-local task path, nor does it show that a local verifier failed.

Separate direct Windows probes ran the fixed TypeScript no-emit check and the
selected Node test using the host-local runner. Both passed with an exited
process and no container. They exercise verifier integration, not the full
proposal-to-application workflow.

## Completed Docker-free task

On 2026-09-24, another fresh fixture copy ran through the compiled shell with
`--execution host-local` and Docker removed from that process's `PATH`.
`where.exe docker.exe` found no client. Proposal
`cf327258-eda4-44c7-891f-34095dca1177` was approved with the host-access
and untracked-child-process warning. Candidate
`0e26e507-7d98-4f74-9ea3-1e767d573ab5` changed only `src/price.ts`, from
`price + discount` to `price - discount`. The first check recorded no admitted
change; the second check passed the fixed TypeScript no-emit profile using
`C:\Program Files\nodejs\node.exe`. Evidence records `host-local`, direct
process `exited`, and container `absent`. The exact diff was inspected, accepted
and promoted. A separate execution of `discountedPrice(100, 15) === 85` and
`git diff --check` passed after application.

The outcome journal records approval-to-execution-result 18.8 seconds,
execution-result-to-review 1.7 seconds, decision-to-promotion 4.3 seconds,
and approval prompt to final outcome 88.9 seconds including operator waits.
There were five model invocations, four tool calls, one edit and two task
checks. Review, decision and promotion recorded zero verifier calls.

The first clone of this fixture was blocked before approval: global Git
`core.autocrlf=true` produced CRLF working bytes that differed from the
committed LF blob, even though Git initially showed a clean status. Restoring
the exact committed bytes and refreshing the index in this temporary fixture
removed the conflict. This is a remaining Windows usability issue for
repositories with checkout conversion, not a failure of the host-local check.
The completed task qualifies only this small trusted-host Windows case. It
does not demonstrate containment, descendant settlement, external-input
closure, cross-platform behavior or representative usefulness.
