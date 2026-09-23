# Roadmap

This page owns current product status and priority. Progress means useful work
completed with understandable authority, applicable evidence and acceptable
user effort. [Qualification](qualification.md) defines what evidence supports a
capability claim; [experiments](../experiments/README.md) retain dated results.

## Current status

The pre-release shell supports related bounded read-only questions over a
committed repository and an approved TypeScript task in an independent checkout.
The source-only task can change one or two existing non-test files under `src/`,
run a fixed contained typecheck, present the exact diff and apply accepted bytes
after conflict checks. Known-settled outcomes return to a new prompt. Unconfirmed
execution or application settlement ends the session.

One bounded semantic correction is implemented with renewed evidence and a
fresh decision, but its usefulness still needs prospective evaluation. The
source-and-test task admits one existing TypeScript source file and one existing
regression test with a fixed targeted Node check. Development checks have
covered that contract. One [ordinary live diagnostic](../experiments/practical-use/2026-09-22-check-selection-results.md)
reached checked exact review and ended in an explicit test-only rejection. Two
[later ordinary walkthroughs](../experiments/practical-use/2026-09-23-results.md)
reached accepted application, one on the repeated task and one on a fresh
preselected external task. They establish those cases, not representative
source-and-test usefulness across repositories. The
earlier [practical-use pilot](../experiments/practical-use/2026-09-22-results.md)
retains failed and degraded attempts rather than a coding-success claim.
A later [three-repository sample](../experiments/practical-use/2026-09-23-cross-repository-results.md)
retained one satisfactory read-only answer, one accepted source-only application
and one source-task execution failure before review. It does not establish
representative usefulness.

The shell uses one in-memory Pi SDK session for related read-only turns and an
initial approved task turn. Optional semantic correction still uses a fresh Pi
execution. Conversations are not persisted or resumed. General test edits, file
creation and deletion, unrestricted commands, uncommitted input and
interrupted-task resume are outside the current contract. See
[Using Tesota](using-tesota.md) for the exact workflow.

## Next outcome

Establish whether the bounded workflow completes worthwhile tasks in external
repositories, and measure what prevents it when it does not. Freeze a small
task set and success criteria before running it. Keep refused, failed and
rejected attempts; measure setup, elapsed time, active user effort, review
burden, residual defects and observed or unavailable cost. A checked candidate
alone is not a useful completion. Separate check evidence from human acceptance
and applied results.

Use those observations to select a bounded improvement. The source-and-test
path now has ordinary live conversations that found the right files, presented
the application-selected check, changed the regression test and source,
repaired failed initial checks and reached accepted application. The
[Gentle Pi follow-up](../experiments/practical-use/2026-09-22-results.md) found proposals
that requested both TypeScript no-emit and the targeted Node test; that
combination was blocked before approval. Tesota now selects the fixed check
pair from the proposed file scope rather than asking the model to choose it.
The earlier diagnostic reached review but was rejected for live-testing
purposes. The later accepted cases answer that narrow gap. Broader usefulness
still needs a fresh spread of external repositories and task classes, with
independently assessed residual defects and separately timed operator effort.
The selected next improvement was to identify an ineligible fixed repository
check before asking for scope approval. `task start` now previews the selected
check's declarations, installed verifier or selected test, and Docker client.
It explains missing prerequisites and stops before approval and candidate work.
The preview is not check evidence: admission and execution still recheck actual
inputs, and runtime availability is established only by execution. The
cross-repository sample that motivated this change remains a failed attempt;
the new behavior has not yet been qualified in a fresh live task.

## Expansion criteria

Uncommitted working-tree input, additional file operations and broader checks
should enter through the same proposal, grant, candidate, evidence, review and
application owners. Add only the operation needed by a selected task. Preserve
user changes, identify the content observed, invalidate stale evidence and
detect conflicts before application. Qualify the actual execution environment
for new process effects; never silently downgrade when it is unavailable.

After the integrated source-and-test path settles, evaluate it on fresh
preselected external tasks. A single accepted case demonstrates only that case;
representative usefulness needs a spread of tasks with refusals and failures
retained. Full interrupted-task recovery is a separate capability and need not
block settled useful work.

Possible later integrations include a qualified local sandbox, narrow GitHub
or versioned-documentation access, browser observation and additional verifiers.
Each needs a concrete task, explicit authority and evidence for its particular
effects. Pi already provides conversation and agent-loop mechanics; Tesota
should adapt them through current owners rather than build parallel engines or
generic registries without consumers. [Decision 011](decisions/011-evidence-gated-capabilities.md)
records the capability admission rule.

Research, planning and creation remain a longer-term direction. A new domain
needs its own user need, result, evidence, allowed effects and adoption boundary
before it becomes a product claim.
