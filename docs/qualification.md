# Product qualification

This document defines the evidence required to claim that a roadmap capability
works. It does not set product priority or current status; the
[roadmap](roadmap.md) owns both.

Qualification asks whether a user can complete the stated outcome while
Tesota's authority, evidence and failure invariants continue to hold. A
component test, live demonstration or reviewer opinion is useful evidence, but
none alone qualifies a user capability.

## Cross-cutting requirements

Every qualified capability must cover the relevant parts of this matrix:

| Area | Required evidence |
| --- | --- |
| User flow | The outcome can be completed through the documented product surface without reconstructing internal IDs. |
| Exact result | The result under review has a stable identity, and changed bytes invalidate affected evidence. |
| Check claims | Each check states what it observed, the bound result and conditions, and what remains unestablished. |
| Authority | Approval is explicit, scoped and non-replayable; child authority cannot exceed parent authority. |
| Confinement | The execution environment enforces its documented filesystem, network, credential and process boundary without being treated as an authority source. |
| Failure semantics | Findings, tool unavailability, fatal exit, timeout, cancellation and uncertain settlement remain distinct. |
| Review and application | Acceptance is bound to the reviewed result and does not itself apply that result. Application detects source drift and reports its effect honestly. |
| Recovery | Durable facts survive restart; expired authority is not recreated and uncertain effects are not replayed. |
| Platforms | Claims name the operating system, architecture, runtime, external tools and environmental limitations actually exercised. |

Evidence should be proportional to the consequence and novelty of the change.
Synthetic tests establish deterministic contracts. Live qualification
establishes only the exercised environment and route. Prospective task results
establish usefulness only for the selected corpus and evaluation method.

## Qualifying an increment

Select the capability and new effects under test, then apply the relevant
requirements below. These sections describe evidence obligations, not a serial
roadmap. Do not claim full recovery or broad coding support from one successful
session. Preserve the earlier numbered milestone records as historical evidence.

For a Pi dependency or session migration, first preserve the existing supported
behavior through `bun run check` and focused integration checks. Assess new
resources, tools or environments separately; package compatibility does not
qualify new effects.

## Continuous conversation and context

Exercise multiple related requests, user feedback and cancellation during work.
When compaction or transcript restoration is supported, demonstrate that useful
context survives and the visible result/check/application state is reconstructed
from canonical records. Verify that restored messages, resource declarations
and old tool closures cannot restore expired authority. Replacing a session must
not lose event subscriptions or bypass cumulative budgets, including any added
model calls used for context management.

Explicit resource selection must exclude unadmitted configuration, extensions
and tool provisioning. A session-completion event alone cannot establish that
tool effects or subprocess descendants have settled.

The implemented read-only slice has deterministic SDK and shell regression
coverage for shared context, isolation, correction, resource denial, baseline
drift, cancellation, timeout, late events and settlement. Automatic compaction,
retry, persistence and session replacement are disabled, so those mechanisms
are not qualified. The first sanitized Windows walkthrough on a preselected
public repository observed follow-up usefulness and real-provider cancellation,
but inconsistent unavailable turns left live qualification pending. Subsequent
diagnosis reproduced rejection of ordinary multiline prose and loss of the final
message when the terminal closed. These cases now have deterministic regressions.

On 2026-09-21, a local Windows PTY walkthrough of the ordinary compiled CLI with
`openai-codex/gpt-5.6-luna` and the prose/terminal fixes completed a multiline
list, a contextual correction with paragraphs and a code block, cancellation,
and a follow-up retaining the corrected subject. The source was
`sindresorhus/yoctocolors` at `a85b98a90e5731914567d8c209e7ec45ac2d24e2`.
The final message remained visible and the process exited 0. This qualifies that
local walkthrough only; it does not establish general reliability or explain
every earlier unavailable result. The run used local changes over `99209bef`;
it is separate from CI and from the earlier PR's qualification evidence.

The local `bun run check` gate also passed after these fixes: typechecking,
compilation, lint and 498 deterministic tests across 37 files. These checks do
not invoke the live provider or establish broader task support.

The later R0 task-tool connection has a deterministic SDK integration test for
discovery, checked candidate editing and a subsequent question in one transcript,
including revocation of a retained tool proxy. This is local check evidence.
One [prospective Windows/Docker live route attempt](../experiments/supported-task/continuous-session-2-2026-09-22.md)
then completed ordinary shell discovery, scoped approval, a contained
TypeScript check, candidate review and an explicit human rejection. An
independent 18-case oracle passed on the exact candidate. No promotion or
post-task conversational follow-up occurred, so this qualifies the observed
execution-to-rejection path only, not accepted application, broad reliability
or the complete continuous code-and-test outcome.

## Complete change and application

This retains the outcome requirements used for the historical Milestone 1.

To qualify one complete small repository change from one conversation:

- exercise positive, failed-check, unsupported, declined, cancelled,
  unavailable-tool, fatal-exit, timeout and source-drift paths;
- confirm that approval, result review and application are available through
  the normal conversational surface without manual ID coordination;
- confirm that the user can distinguish changed files, applicable checks,
  remaining unknowns and application state;
- return to a useful prompt after answer, refusal, failure, rejection and
  successful or failed application where settlement is known;
- retain uncertainty where cancellation or cleanup cannot be confirmed; and
- complete the prospective usefulness evaluation below.

The current fixed TypeScript profile additionally needs real positive, failing,
missing-tool, fatal-exit, timeout, cancellation, surviving-descendant and
source-drift cases on every supported platform and execution environment. Each
record must include setup friction, unsupported controls and whether the
evidence producer remained protected from the workload it observed.

## Source and regression tests

Choose the task and expected behavior before execution. For a supported bug fix,
show that the regression test detects the original defect and passes against the
corrected result. Review that the test expresses the requested behavior and that
existing required assertions have not been removed or weakened to obtain a pass.
This behavioral oracle is separate from the agent's claim of completion.

Test edits and any admitted file creation must be covered through proposal,
scope, candidate changes, check inputs, review and application. Bind the exact
tests, configuration, relevant dependencies and execution conditions. Editing a
test must not silently change the authorized check selection or configuration.
Missing tests, skipped required cases, incomplete reports and fatal exits cannot
become success. Recheck after correction and reject stale acceptance or source
drift at application.

Use the actual external repository configuration; an unsupported setup is a
recorded refusal or a separately implemented profile expansion. Extending Vitest
does not qualify arbitrary test frameworks or repository commands.

## Correction

This retains the outcome requirements of the historical Milestone 2.

Correction qualification must separately exercise:

- first-result production;
- repair driven by a concrete diagnostic; and
- semantic revision requested by the user.

Each new result must receive a new identity and fresh applicable evidence. Task
budgets remain cumulative, and neither the agent nor a diagnostic can alter the
grant or authoritative check definition. Evaluation compares accepted outcomes,
residual defects, intervention, elapsed time and unsuccessful correction cost
with the no-correction baseline.

## Interruption recovery

This retains the outcome requirements of the historical Milestone 3.

Recovery qualification restarts the product at every durable boundary. It
includes work interrupted before and after a result, check persistence, wrong-
result review, stale acceptance, lost application acknowledgement, cancellation
with a surviving descendant and uncertain settlement.

The reconstructed view must explain what exists, what evidence applies, what
remains uncertain, whether application occurred and what must be repeated. It
must not manufacture execution, review, acceptance or application authority.

## Prospective usefulness evaluation

Choose a small set of external repository tasks before observing results. Do
not modify repositories to fit Tesota. Include small bugs, small features and
bounded refactorings, plus refusals and failures.

For each task, retain:

- original task statement and selection date;
- repository and committed baseline;
- support, refusal or failure classification and cause;
- accepted and applied outcome;
- independent residual-defect assessment;
- user intervention and clarification;
- diagnostic repair and semantic revision;
- elapsed time;
- observed inference and tool cost, or an explicit unavailable value;
- setup burden; and
- review burden.

A small manual record is preferred until repeated use demonstrates that a
platform would reduce real burden or ambiguity. Report counts and causes, not a
reliability percentage unsupported by the sample.

## Technical evidence owners

The qualification claim should link to, rather than duplicate, the relevant
contract:

- [architecture](architecture.md) for lifecycle ownership and authority;
- [verification](verification.md) for evidence and check behavior;
- [task proposals](proposals.md) and [scoped tasks](tasks.md) for the current
  source-task boundary;
- [candidate checkouts](candidates.md) for exact-result isolation;
- [verifier strategy](verifier-strategy.md) for selecting a check when an
  observed task need justifies one; and
- [execution-environment decision](decisions/007-execution-environments.md) for
  confinement and platform claims.

Historical experiment records remain valid evidence for the mechanism they
actually exercised. They do not by themselves establish current product status
or roadmap priority.
