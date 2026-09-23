# Roadmap

This document owns Tesota's current product status and priorities. Progress is
measured by useful work a person can complete, the effort it requires and the
evidence attached to the result.

Tesota aims to become a broadly useful coding agent while keeping authority,
checks, unknowns, human acceptance and application understandable. Software
development is the first proving ground, not the permanent product boundary.

## What works today

The pre-release supports continuous bounded repository questions and a small TypeScript
source task through Tesota Shell: proposal, approval, independent checkout,
editing, scope-integrity and contained typechecking, exact diff review and
guarded application. The write set is one or two existing non-test TypeScript
files below src/. Known-settled outcomes return to a useful prompt; uncertain
execution or application settlement ends the session.

One explicitly approved semantic correction is implemented with cumulative
budgets and renewed evidence. Its prospective usefulness remains unqualified.
General test editing, file creation/deletion, unrestricted commands and
interrupted-task resume are not supported. A separate source-and-regression-test
variant is now implemented for one existing TypeScript source and one existing
`tests/**/*.test.ts` file, using a fixed contained Node test rather than the
repository script. Its deterministic and Docker development checks do not yet
establish useful completion through the ordinary live conversation or a fresh
external evaluation. The targeted Vitest profile remains a separate mechanism,
not a check silently selected for this variant. [Using Tesota](using-tesota.md)
owns current usage and limitations.

In the subsequent Gentle Pi follow-up, ordinary discovery reached the right
source and test files but repeatedly proposed both TypeScript no-emit and the
targeted Node test. That three-check combination is not admitted. The Shell now
marks such a proposal as blocked before approval; practical source-and-test
completion remains unqualified. The earlier 120-second discovery timeout was
not reproduced in the follow-ups, so its cause is still unknown.

Tesota Shell now uses one in-memory Pi Coding Agent SDK session for related
read-only turns and the initial approved source-task execution. Tesota-owned
tools, explicit resources, cumulative conversation limits and bounded
cancellation settlement remain in force. The task runner retains its existing
candidate, budget, check and review owners; optional R1 semantic correction
still uses a fresh Pi agent-core execution. See
[architecture](architecture.md#pi-session-integration) for the current boundary.

## Next outcome: practical bounded work on external repositories

First determine whether the current narrow source-task flow is useful enough to
complete worthwhile work in real external repositories, and what most obstructs
it. A checked candidate alone is not that outcome. Preselect a small finite set
of tasks, including work the current contract may refuse, before observing
results. Use each repository's actual configuration; do not reshape it to fit a
demonstration. Retain failures and refusals as results.

The subsequent goal remains one conversation that can explore a repository,
fix a bug, change its regression test, run relevant checks, accept a
user-requested correction and present the current diff and evidence for review
and application. The bounded source-and-test implementation now exists, but its
useful live conversation, correction and application remain unqualified. A fresh
external evaluation of the complete flow is its final gate,
not a substitute for early external feedback or checks during implementation.

## Implementation order

### 1. Integrate the continuous Pi session

The compatibility increment updated all four pinned Pi packages from 0.85.1 to
0.86.1 without adding tools or permissions. On 2026-09-20, `bun run check` passed
on Windows: typechecking, compilation, 475 tests across 36 files and lint. A fresh
temporary installation with `--frozen-lockfile --ignore-scripts` and public API
import checks under the pinned Node and Bun runtimes also passed. This is local
compatibility evidence; live provider and Docker qualification were not rerun.
The upstream
[0.86.0 migration](https://github.com/earendil-works/pi/blob/v0.86.1/packages/coding-agent/CHANGELOG.md)
changes streaming context, JSON value contracts and shell hook behavior. Provider
test doubles now read tool declarations through the public transcript helper.
The dependency compatibility record remains separate from the read-only session
implementation and its qualification.

The continuous read-only slice now uses the full Coding Agent SDK for in-memory
conversation history and follow-up context while retaining the current shell.
It selects resources and tools explicitly, checks repository identity between
turns, propagates cancellation and keeps per-turn and conversation limits.
Automatic compaction, persistence and retries remain disabled. The initial
task-tool connection has deterministic local coverage. One prospective
Windows/Docker live attempt reached a checked candidate and explicit human
rejection through the ordinary shell; accepted application, post-task follow-up
and broader live qualification remain outstanding. See
[qualification](qualification.md#continuous-conversation-and-context).

On 2026-09-22 the four Pi packages were advanced together to 0.87.1 and the
ordinary task route selected `gpt-6-luna`; Gentle's separate reviewer route
remains fixed at `gpt-5.6-luna`. The complete local gate passed and a bounded
live turn plus observed cancellation passed, but that smoke does not qualify a
repository task on the new model. The [practical-use pilot](../experiments/practical-use/2026-09-22-results.md)
retains one useful read-only answer and the failed/degraded task attempts;
coding usefulness remains unestablished by that pilot.

Deterministic integration tests cover three related turns, an isolated second
conversation, user correction, resource and tool denial, source drift,
cancellation during inference and reading, timeout, late completion and
subscription cleanup. The first live Windows walkthrough on a public external
repository observed useful follow-up context, correction and settled
cancellation, but also inconsistent unavailable turns and did not exercise the
TUI. A subsequent local walkthrough after the prose and terminal fixes completed
the full read-only TUI sequence with Luna; [qualification](qualification.md#continuous-conversation-and-context)
records its scope and limits. Broader reliability remains unqualified.
When compaction or restoration is supported, reconstruct current task
facts without restoring expired tool authority. Full interrupted-task recovery
is qualified separately; it does not block proving a continuous settled session.

### 2. Establish a practical-use baseline with the current flow

Run the finite preselected external-task set through the ordinary shell within
the current source-only boundary. Include worthwhile eligible work and tasks
that may be refused; do not filter out an inconvenient repository after seeing
its result. Record support and refusal causes, accepted and applied results,
residual defects, clarification, correction, setup, machine work, active user
effort, human waiting, review burden and observed or unavailable cost. Keep
check evidence distinct from usefulness and human acceptance. Live provider or
paid execution still needs explicit authorization for the selected protocol.

Stop after the declared attempts and identify the largest evidenced barrier to
a useful completion. The result may justify a narrow usability fix, the
source-and-test expansion itself, or a smaller supported claim. Do not turn
"practical" into an open-ended polishing prerequisite or infer broad
reliability from one successful task.

### 3. Remove the largest observed obstacles

Make bounded changes where the baseline shows they matter: setup and admission
friction, diagnostics, review effort, or recovery from known-settled work are
candidates, not a mandatory feature list. Recheck the affected external
workflow against a task-specific improvement target fixed before the follow-up
run. Keep authority, exact-result evidence, user changes and uncertain-effect
handling intact; do not replay an uncertain effect or reconstruct expired
authority. Full interrupted-task resume is not a prerequisite to useful work.

If the dominant obstacle is that a real fix requires a regression test, proceed
to the next slice rather than polishing the narrow source-only flow indefinitely.

### 4. Complete a source-and-regression-test change

Support uncommitted working-tree input where the selected real task needs it.
Conversation should then be able to inspect local changes without requiring a
commit first. Preserve existing user changes, identify the exact content
observed, invalidate affected evidence when it changes and detect conflicts
before application. This support remains planned, not part of the current
read-only session.

Reuse Pi's reading and editing mechanisms selectively, through the current
candidate and permission owners. Inspect every operation that can read, write,
launch processes or provision tools; a working directory or replaceable I/O
interface alone does not establish control of all effects.

Use the repository's actual test runner for the selected task: Gentle Pi uses
Node's built-in test runner, so a concrete targeted Node profile is required;
the existing Vitest profile cannot verify this repository. Admit test edits
through proposal, scope, check inputs, exact diff, review and promotion together.
Add a file-lifecycle operation only if the selected task needs it and its effects
are implemented across those owners. Keep check selection and configuration
separate from permission to edit test code. Use the existing Docker route and
admitted verifier version initially.

Development evidence must show a regression test detecting the original defect,
passing after repair and remaining meaningful after a user-requested correction.
Fresh checks must describe the final bytes. Empty, skipped or incomplete test
execution cannot substitute for the required behavior. Relevant negative cases
and exact-byte application belong to the same increment. These development
cases are not the final external evaluation corpus.

### 5. Qualify the complete flow on fresh external tasks

After the integrated implementation settles, preselect fresh external
repository/task identities and practical success criteria before observing
results. Exercise the ordinary conversation through exploration, source and
test changes, correction where applicable, current checks, review, a human
decision, application when accepted and a useful next prompt. Retain failed,
refused, rejected and unsettled attempts. Measure setup, machine time, active
user effort, waiting, intervention, cost, residual defects and review burden.

An explicit rejection, like the first live task-tool walkthrough, is valid
decision evidence but cannot establish accepted application. A successful
example qualifies only that example; representative usefulness needs a
preselected spread of tasks and honest unsuccessful outcomes.

## Conditional capabilities for demonstrated needs

External research provides candidates for experiments, not installed capability,
compatibility evidence or an automatic sequence of integrations.

| Observed need | First candidate to evaluate | Decision boundary |
| --- | --- | --- |
| Repository checks are too costly to prepare or run | A concrete local sandbox compared with Docker | Qualify the same effects and physical settlement on the target platform; retain Docker until a replacement qualifies. |
| Tasks originate in issues or require CI context | A few read-only GitHub CLI operations | Explicit repository and credential scope; CI observations bound to the correct revision. |
| Library APIs cannot be resolved from repository context | Versioned documentation through a narrow tool or skill | Bounded network access and source attribution; no general MCP bridge prerequisite. |
| A UI defect requires observing the running application | One browser automation route | Reproducible build, temporary browser state and observed cleanup. |
| Existing checks leave an important property unresolved | A specific verifier or independent reviewer | Define the claim, original requirement, result binding and limits; demonstrate useful findings. |

Neither a local sandbox replacement nor GitHub integration is a prerequisite for
source-and-test work. Memory, semantic indexing and subagents wait for a concrete
problem that sessions, repository context and a single working agent cannot
adequately solve. Research may test a bounded strategic bet under
[decision 011](decisions/011-evidence-gated-capabilities.md); it does not require
building a framework first.

## Reuse and complexity limits

Before adding a component, identify the task it enables, the existing Pi or
external mechanism considered, the Tesota invariant that requires adaptation,
and the maintenance burden. Prefer a concrete adapter with a present consumer.

Keep one owner for conversation history and one owner for operational facts.
Retire a superseded path when adopting its replacement; do not keep two permanent
session loops, policy systems or equivalent integrations. A temporary migration
path needs a specific removal condition. Extend modules only for implemented
consumers, and keep losing experiments cheap to remove.

Recover Kiln's useful invariants and adverse cases through the
[extraction reference](references/kiln-extraction.md). Its package topology is not
a backlog. No current priority requires a native agent engine, universal verifier
framework, provider registry, account pool, silent fallback, marketplace,
cross-harness configuration platform or autonomous work graph.

Tesota's progress does not depend on another product's availability. Public
integrations must justify their own utility and preserve a usable path without
them.

## Qualification and historical evidence

[Product qualification](qualification.md) defines evidence for each capability.
Checks, live observations, independent review, human acceptance and application
remain separate claims. Capability requirements are not a serial requirement to
finish every recovery case before implementing useful coding breadth; each
increment qualifies the behavior and effects it introduces.

The earlier numbered milestones remain historical references:

- **Milestone 1:** the bounded Windows/Docker request-to-application flow was
  qualified and delivered through PR #135, merged into dev. The
  [qualification record](../experiments/supported-task/results.md) retains the
  failed attempts, reader and CRLF repairs, final prospective task, behavioral
  oracle, exact-byte application and limits of the operator-attested review.
  Those observations do not qualify later source changes or other platforms.
- **Milestone 2 / M2a:** one bounded semantic correction was implemented through
  PR #138. Prospective correction usefulness remains outstanding.
- **Milestone 3:** understandable interruption recovery remains a capability to
  establish for the supported flow.
- **Milestone 4:** coding breadth now grows alongside the correction and recovery
  needed by each task, rather than waiting for the entire narrow lifecycle first.

Historical experiments and prior decisions retain their original scope and
provenance. See [experiments](../experiments/README.md) and
[project history](history/README.md) for the records.

## Beyond coding

Research, planning, creation and other consequential work remain a long-term
direction. Before a new domain becomes a commitment, define its user need, exact
result, applicable evidence, allowed effects and review/adoption boundary.
Coding qualification does not automatically establish those properties elsewhere.
