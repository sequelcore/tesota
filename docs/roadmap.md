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
interrupted-task resume are not supported. The existing targeted Vitest profile
is a mechanism to extend, not an ordinary source-and-test task already available
to users. [Using Tesota](using-tesota.md) owns current usage and limitations.

Tesota Shell now uses one in-memory Pi Coding Agent SDK session for related
read-only turns with Tesota-owned tools, explicit resources, cumulative
conversation limits and bounded cancellation settlement. The admitted task
runtime remains on its existing Pi agent-core integration. See
[architecture](architecture.md#pi-session-integration) for the current boundary.

## Next outcome: a continuous code-and-test task

The next user outcome is one conversation that can explore a repository, fix a
bug, change its regression test, run relevant checks, accept a user-requested
correction and present the current diff and evidence for review and application.
This is planned work, not a newly supported capability.

Choose a real external task before observing results. Use its actual repository
configuration; do not reshape the repository to fit a demonstration. Record what
was accepted and applied, residual defects, intervention, setup and elapsed time,
including unsuccessful attempts. A successful example establishes that example,
not general coding reliability.

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
Automatic compaction, persistence and retries remain disabled. Connecting the
existing admitted task tools is the next part of this outcome.

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

### 2. Complete a source-and-regression-test change

Remove the committed-baseline-only reading restriction as a scoped part of this
work. Conversation should be able to inspect uncommitted local changes without
requiring a commit first. Preserve existing user changes, identify the exact
content observed, invalidate affected evidence when it changes and detect
conflicts before application. This working-tree support is planned, not part of
the current read-only session.

Reuse Pi's reading and editing mechanisms selectively, through the current
candidate and permission owners. Inspect every operation that can read, write,
launch processes or provision tools; a working directory or replaceable I/O
interface alone does not establish control of all effects.

Extend the concrete Vitest profile for the selected repository. Admit test edits
through proposal, scope, check inputs, exact diff, review and promotion together.
Add a file-lifecycle operation only if the selected task needs it and its effects
are implemented across those owners. Keep check selection and configuration
separate from permission to edit test code. Use the existing Docker route and
admitted verifier version initially.

Completion evidence is a regression test that detects the original defect,
passes after repair, and remains meaningful after a user-requested correction.
Fresh checks must describe the final bytes. Empty, skipped or incomplete test
execution cannot substitute for the required behavior. Relevant negative cases
and exact-byte application belong to the same increment.

### 3. Make the flow practical to use repeatedly

Improve setup, diagnostics and recovery from the observed burden of the first
tasks. Preserve useful conversation context while explaining what exists, what
was checked, whether work settled, whether it was applied and what requires a
new decision. Do not replay an uncertain effect or reconstruct expired authority.

Then evaluate a small preselected corpus across external repositories with bugs,
features and refactorings. Expand the operation or check that prevents worthwhile
work; retain refusal causes, residual defects, correction effort and review burden.
Broad usefulness requires representative outcomes, not a feature count.

### 4. Add capabilities for demonstrated needs

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
